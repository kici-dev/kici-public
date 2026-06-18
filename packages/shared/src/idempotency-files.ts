/**
 * File-drift preview primitive for idempotent steps that copy or rsync
 * files to a remote target. Companion to `idempotency.ts`: a `check()`
 * that ships files can call into the helper layer (e.g. `previewRsync*`
 * in `packages/ci/src/deploy-prod/remote.ts`) to get a typed list of
 * per-file changes, then surface those entries inside the step's drift
 * value so the confirm prompt shows the operator exactly which files
 * would change and how.
 *
 * The source of truth for the categorisation is rsync's own
 * `--itemize-changes` (`-i`) output, captured under `--dry-run` (`-n`).
 * Running rsync with the same flags the apply path uses guarantees the
 * preview and the actual transfer agree.
 *
 * The itemize code rsync prints is 11 characters: `YXcstpoguax`.
 *   Y = update type (`<` sent, `>` received, `.` no transfer, `*` message, `c`/`h`)
 *   X = file type (`f` file, `d` directory, `L` symlink, …)
 *   c = checksum mismatch (or `+` block when newly created)
 *   s = size mismatch
 *   t = mtime mismatch
 *   p = perms mismatch
 *   o = owner mismatch
 *   g = group mismatch
 *   u = (sub-second) mtime mismatch
 *   a = ACL mismatch
 *   x = xattr mismatch
 * Newly-created files render as `<f+++++++++` (or `cf+++++++++` for local
 * creates). See `rsync(1)` § "ITEMIZED OUTPUT".
 */

import { createTwoFilesPatch } from 'diff';
import { diffEnvFiles, renderEnvDiff } from './idempotency-env-diff.js';

// Hardcoded ANSI escapes (not picocolors) so `color: true` deterministically
// emits escapes regardless of the host terminal's isColorSupported probe.
// The tee in release-prod writes raw bytes to both stdout and the log file;
// the operator opens the log with `less -R` to render the colors.
const ANSI_RED = '\x1b[31m';
const ANSI_GREEN = '\x1b[32m';
const ANSI_CYAN = '\x1b[36m';
const ANSI_BOLD = '\x1b[1m';
const ANSI_RESET = '\x1b[0m';

export type FileChangeCategory = 'new' | 'content' | 'mode' | 'time-only';

export type ContentSkipReason = 'binary' | 'too-large' | 'read-failed' | 'sensitive';

/**
 * Renderer hint for the diff body. The default `'unified-text'` produces
 * a `createTwoFilesPatch`-style block (the v1 shape). `'env-semantic'`
 * routes through the env-file diff renderer (keys + classification, with
 * value masking by default). `'yaml-semantic'` routes through the yaml
 * deep-diff renderer (dotted-path leaf entries, with masking on sensitive
 * paths). `'suppressed'` hides the body and prints a skip-reason marker —
 * used for genuinely-opaque content the caller refuses to capture.
 */
export type FileDiffMode = 'unified-text' | 'env-semantic' | 'yaml-semantic' | 'suppressed';

/**
 * Per-file drift entry as carried inside a phase's Drift value.
 * `localPath` and `remotePath` are filled in by the caller that owns the
 * rsync invocation (the parser only sees the relative path rsync prints).
 *
 * `localContent` / `remoteContent` are populated by the caller when the
 * payload is small UTF-8 text — they drive the inline unified-diff block
 * in the confirm prompt. `contentSkipped` flags the cases where content
 * was intentionally not captured (binary, too large, read failure) so
 * the renderer can show an explicit "no diff available" row instead of
 * silently dropping the entry.
 */
export interface FileDriftEntry {
  localPath: string;
  remotePath: string;
  category: FileChangeCategory;
  /** Raw 11-char rsync itemize code, kept for `--debug`-style operator output. */
  itemizeCode: string;
  /** Local file bytes (UTF-8). Set for category `new` / `content` when content was successfully captured. */
  localContent?: string;
  /** Remote file bytes (UTF-8). Set for category `content` when content was successfully captured. Undefined for `new`. */
  remoteContent?: string;
  /** Set when content capture was intentionally skipped — used by the renderer to explain the gap. */
  contentSkipped?: ContentSkipReason;
  /**
   * Renderer hint. When omitted, the renderer auto-detects from
   * `remotePath`: `.env` → `'env-semantic'`, `.yaml` / `.yml` →
   * `'yaml-semantic'`, otherwise → `'unified-text'`. Explicit values
   * override the auto-detect. Set to `'suppressed'` to opt out of any
   * inline body and rely on `contentSkipped` for the explanation row.
   */
  diffMode?: FileDiffMode;
}

/**
 * Auto-detect the diff mode for a given entry. Explicit `entry.diffMode`
 * always wins. Otherwise the suffix of `remotePath` is the only signal —
 * we deliberately do NOT sniff `localContent` bytes because the goal of
 * the helper is to produce a deterministic, callsite-readable hint that
 * matches the caller's intent.
 */
export function resolveDiffMode(entry: FileDriftEntry): FileDiffMode {
  if (entry.diffMode) return entry.diffMode;
  const remote = entry.remotePath.toLowerCase();
  if (remote.endsWith('.env')) return 'env-semantic';
  if (remote.endsWith('.yaml') || remote.endsWith('.yml')) return 'yaml-semantic';
  return 'unified-text';
}

/** Low-level parse output: category + the relative path rsync printed. */
export interface ItemizeRecord {
  itemizeCode: string;
  relativePath: string;
  category: FileChangeCategory;
}

/**
 * Parse one line of `rsync --itemize-changes` output. Returns null for
 * lines that are not actionable file drift entries:
 *   - "sending incremental file list" header line
 *   - blank / whitespace-only lines
 *   - summary lines ("sent N bytes received M bytes …", "total size is X")
 *   - directory metadata entries (e.g. `.d..t...... ./`) — directories
 *     are created by rsync as a side-effect of file entries, no separate
 *     reporting needed
 *   - in-sync entries (rsync emits these only at -vv; we run at -v, so
 *     they normally don't appear — but we filter defensively)
 */
export function parseItemizeLine(line: string): ItemizeRecord | null {
  if (line.length < 13) return null;
  const code = line.slice(0, 11);
  const rest = line.slice(11);
  if (!rest.startsWith(' ')) return null;
  const relativePath = rest.slice(1).trimEnd();
  if (relativePath.length === 0) return null;

  if (!/^[<>.ch*]$/.test(code[0]!)) return null;
  if (!/^[fdLDS]$/.test(code[1]!)) return null;
  if (code[1] === 'd') return null;
  if (code[0] === '*') return null;

  if (code.slice(2, 11) === '+++++++++') {
    return { itemizeCode: code, relativePath, category: 'new' };
  }
  const c = code[2]!;
  const s = code[3]!;
  const t = code[4]!;
  const p = code[5]!;
  const o = code[6]!;
  const g = code[7]!;
  const u = code[8]!;
  const a = code[9]!;
  const x = code[10]!;

  if (c !== '.' || s !== '.') {
    return { itemizeCode: code, relativePath, category: 'content' };
  }
  if (p !== '.' || o !== '.' || g !== '.' || u !== '.' || a !== '.' || x !== '.') {
    return { itemizeCode: code, relativePath, category: 'mode' };
  }
  if (t !== '.') {
    return { itemizeCode: code, relativePath, category: 'time-only' };
  }
  return null;
}

const CATEGORY_DISPLAY: Record<FileChangeCategory, string> = {
  new: 'NEW',
  content: 'CONTENT',
  mode: 'MODE',
  'time-only': 'TIME',
};

const CATEGORY_ORDER: FileChangeCategory[] = ['new', 'content', 'mode', 'time-only'];

const SKIP_REASON_DISPLAY: Record<ContentSkipReason, string> = {
  binary: '(binary file changed — no inline diff)',
  'too-large': '(file too large for inline diff)',
  'read-failed': '(content read failed — no inline diff)',
  sensitive: '(sensitive content — diff suppressed)',
};

export interface RenderDriftOpts {
  /** When true, append a unified-diff block under each `new`/`content` entry. */
  withContent?: boolean;
  /** When true, color the diff with ANSI red/green via picocolors. */
  color?: boolean;
  /** Cap on diff body lines per entry (excluding header). Default 200. */
  maxLines?: number;
  /**
   * When true, env-semantic and yaml-semantic renderers will print the
   * actual values instead of masking them. Off by default so the confirm
   * prompt and the tee'd log file never carry plaintext credentials
   * without an explicit operator opt-in.
   */
  revealEnvValues?: boolean;
  /**
   * Restrict which categories get a diff body rendered. Entries whose
   * category is NOT in this set show only the per-file row, no diff.
   * Default: `['new', 'content']` (every visible drift body). Useful for
   * `--diff-only=content` operator workflows that want to suppress the
   * potentially-huge full-file body of newly-introduced files.
   */
  diffOnlyCategories?: FileChangeCategory[];
}

/**
 * Render the unified-diff block for a single FileDriftEntry. Returns an
 * array of pre-indented lines (no surrounding indent applied by this
 * function — the caller decides nesting). The first line is the diff
 * header (`--- a/path` / `+++ b/path`), followed by hunk bodies.
 *
 * `mode` and `time-only` entries return an empty array — no diff to show.
 * Entries with `contentSkipped` set return a single line explaining the
 * skip reason. Entries with no content captured (older callers that
 * didn't fill the fields) also return empty — the caller falls back to
 * the label-only row.
 *
 * This function ALWAYS renders the unified-text shape regardless of the
 * entry's `diffMode` — it's the v1 path. The renderer dispatch in
 * `renderFileDrifts` decides which shape to invoke per entry; this
 * helper stays the unified-text branch for callers that want to render
 * a single entry in unified shape.
 */
export function renderFileDriftWithDiff(
  entry: FileDriftEntry,
  opts: Pick<RenderDriftOpts, 'color' | 'maxLines'> = {},
): string[] {
  if (entry.category === 'mode' || entry.category === 'time-only') return [];
  if (entry.contentSkipped) {
    return [SKIP_REASON_DISPLAY[entry.contentSkipped]];
  }
  const color = opts.color ?? false;
  const maxLines = opts.maxLines ?? 200;

  const before = entry.category === 'new' ? '' : (entry.remoteContent ?? '');
  const after = entry.localContent ?? '';
  if (before === '' && after === '' && entry.category !== 'new') return [];

  const patch = createTwoFilesPatch(
    `a/${entry.localPath}`,
    `b/${entry.localPath}`,
    before,
    after,
    undefined,
    undefined,
    { context: 3 },
  );
  // createTwoFilesPatch always emits a leading "Index:" / "===" preamble
  // we don't want, plus a header line we DO want. Drop everything up to
  // and including the first `--- ` line, then re-emit our own header.
  const rawLines = patch.split('\n');
  const headerIdx = rawLines.findIndex((l) => l.startsWith('--- '));
  const body = headerIdx >= 0 ? rawLines.slice(headerIdx) : rawLines;

  const truncated = body.length > maxLines;
  const display = truncated ? body.slice(0, maxLines) : body;
  const lines = display.map((line) => colorize(line, color));
  if (truncated) {
    lines.push(`… (${body.length - maxLines} more lines truncated; raw patch in log file)`);
  }
  return lines;
}

/**
 * Dispatch helper: given a single entry and the render opts, pick the
 * right renderer based on `resolveDiffMode(entry)`. Returns the diff body
 * lines (no surrounding indent applied) — same shape as
 * `renderFileDriftWithDiff` so the caller can nest each line identically
 * regardless of which renderer fired.
 *
 * The placeholder `yaml-semantic` branch deliberately falls back to the
 * unified-text rendering when this entry hasn't been routed through a
 * yaml-aware caller. The dedicated `renderYamlDiff` lives in
 * `idempotency-yaml-diff.ts`; the dispatch wire-up happens here once it's
 * imported.
 */
export function renderFileDriftBody(entry: FileDriftEntry, opts: RenderDriftOpts = {}): string[] {
  if (entry.category === 'mode' || entry.category === 'time-only') return [];
  const mode = resolveDiffMode(entry);
  if (mode === 'suppressed') {
    return [SKIP_REASON_DISPLAY[entry.contentSkipped ?? 'sensitive']];
  }
  if (entry.contentSkipped) {
    return [SKIP_REASON_DISPLAY[entry.contentSkipped]];
  }
  if (mode === 'env-semantic') {
    return renderEnvDiffBody(entry, opts);
  }
  if (mode === 'yaml-semantic') {
    // Late import to keep `idempotency-files.ts` free of a hard dep
    // on the `yaml` package at module-load time. The dispatch lives
    // here so callers don't have to import the yaml module directly.
    // The wiring is done dynamically via `require` semantics in ESM
    // would force async; instead we expose the renderer via a
    // setter (`setYamlDiffRenderer` below) that the yaml module
    // calls at its own load time.
    if (yamlDiffRenderer) {
      return yamlDiffRenderer(entry, opts);
    }
    // Falls through to unified-text when no yaml renderer is wired
    // (e.g. a downstream consumer of `@kici-dev/shared/idempotency-files`
    // that hasn't imported the yaml module). The unified-text body still
    // gives the operator a usable diff.
  }
  return renderFileDriftWithDiff(entry, { color: opts.color, maxLines: opts.maxLines });
}

/**
 * Bridge between the env-diff module and the file-drift renderer. Reads
 * `localContent` + `remoteContent` from the entry and delegates to
 * `diffEnvFiles` + `renderEnvDiff` from `idempotency-env-diff.ts`.
 *
 * NEW entries (no `remoteContent`) treat the remote side as an empty file
 * — every local key becomes an `added` entry.
 */
function renderEnvDiffBody(entry: FileDriftEntry, opts: RenderDriftOpts): string[] {
  const local = entry.localContent ?? '';
  const remote = entry.category === 'new' ? '' : (entry.remoteContent ?? '');
  if (local === '' && remote === '' && entry.category !== 'new') return [];
  const diff = diffEnvFiles(local, remote);
  return renderEnvDiff(diff, { reveal: opts.revealEnvValues ?? false, color: opts.color ?? false });
}

/**
 * Yaml renderer registration. The yaml module (`idempotency-yaml-diff.ts`)
 * calls `setYamlDiffRenderer` at its own load time so the file-drift
 * renderer can dispatch to it without taking a static dependency on the
 * `yaml` npm package. Callers that never import the yaml module fall
 * through to unified-text rendering, which is the safe default.
 */
type YamlDiffRenderer = (entry: FileDriftEntry, opts: RenderDriftOpts) => string[];
let yamlDiffRenderer: YamlDiffRenderer | null = null;
export function setYamlDiffRenderer(renderer: YamlDiffRenderer | null): void {
  yamlDiffRenderer = renderer;
}

function colorize(line: string, color: boolean): string {
  if (!color) return line;
  if (line.startsWith('+++') || line.startsWith('---')) return `${ANSI_BOLD}${line}${ANSI_RESET}`;
  if (line.startsWith('@@')) return `${ANSI_CYAN}${line}${ANSI_RESET}`;
  if (line.startsWith('+')) return `${ANSI_GREEN}${line}${ANSI_RESET}`;
  if (line.startsWith('-')) return `${ANSI_RED}${line}${ANSI_RESET}`;
  return line;
}

/**
 * Render a FileDriftEntry[] as an aligned multi-line block suitable for
 * inclusion in a confirm-prompt summary.
 *
 *   3 file(s) drifted: 1 new, 1 content, 1 mode
 *     NEW      placeholder.html
 *     CONTENT  haproxy.cfg
 *     MODE     scripts/certbot-pre-stop.sh
 *
 * When `opts.withContent` is true, each `new`/`content` row is followed
 * by an indented unified-diff block (colored if `opts.color`).
 *
 * Returns the rendered lines (no surrounding indent applied). Caller
 * decides how to nest the block in a wider prompt.
 */
export function renderFileDrifts(entries: FileDriftEntry[], opts: RenderDriftOpts = {}): string[] {
  if (entries.length === 0) return [];

  const counts: Partial<Record<FileChangeCategory, number>> = {};
  for (const e of entries) {
    counts[e.category] = (counts[e.category] ?? 0) + 1;
  }
  const summary = CATEGORY_ORDER.filter((c) => counts[c])
    .map((c) => `${counts[c]} ${c}`)
    .join(', ');

  const widest = Math.max(...entries.map((e) => CATEGORY_DISPLAY[e.category].length));
  const sorted = [...entries].sort((a, b) => {
    const ai = CATEGORY_ORDER.indexOf(a.category);
    const bi = CATEGORY_ORDER.indexOf(b.category);
    if (ai !== bi) return ai - bi;
    return a.localPath.localeCompare(b.localPath);
  });

  const diffOnly = new Set<FileChangeCategory>(
    opts.diffOnlyCategories ?? (['new', 'content'] as FileChangeCategory[]),
  );

  const lines = [`${entries.length} file(s) drifted: ${summary}`];
  for (const e of sorted) {
    const label = CATEGORY_DISPLAY[e.category].padEnd(widest);
    lines.push(`  ${label}  ${e.localPath}`);
    if (opts.withContent && diffOnly.has(e.category)) {
      const diff = renderFileDriftBody(e, opts);
      for (const dl of diff) {
        lines.push(`      ${dl}`);
      }
    }
  }
  return lines;
}
