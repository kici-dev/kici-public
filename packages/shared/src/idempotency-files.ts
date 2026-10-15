/**
 * File-drift preview for idempotent steps that copy or rsync files to a remote
 * target (companion to `idempotency.ts`): a `check()` surfaces typed per-file
 * changes in its drift value, so the confirm prompt shows which files would
 * change and how.
 *
 * The categorisation comes from rsync's own `--itemize-changes` (`-i`) output
 * under `--dry-run` (`-n`), run with the apply path's flags so preview and
 * transfer agree.
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

// Hardcoded ANSI escapes (not picocolors) so `color: true` emits escapes
// regardless of the terminal's isColorSupported probe: the release-prod tee
// writes raw bytes to the log file, read with `less -R`.
const ANSI_RED = '\x1b[31m';
const ANSI_GREEN = '\x1b[32m';
const ANSI_CYAN = '\x1b[36m';
const ANSI_BOLD = '\x1b[1m';
const ANSI_RESET = '\x1b[0m';

export type FileChangeCategory = 'new' | 'content' | 'mode' | 'time-only';

export type ContentSkipReason = 'binary' | 'too-large' | 'read-failed' | 'sensitive';

/**
 * Renderer hint for the diff body: `'unified-text'` (default) is a
 * `createTwoFilesPatch`-style block; `'env-semantic'` diffs env keys with
 * values masked by default; `'yaml-semantic'` diffs dotted-path leaves with
 * sensitive paths masked; `'suppressed'` prints only a skip-reason marker,
 * for opaque content the caller refuses to capture.
 */
export type FileDiffMode = 'unified-text' | 'env-semantic' | 'yaml-semantic' | 'suppressed';

/**
 * Per-file drift entry inside a phase's Drift value. The caller that owns the
 * rsync invocation fills `localPath` / `remotePath` (the parser sees only the
 * relative path rsync prints), and fills the content fields only for small
 * UTF-8 text. `contentSkipped` makes the renderer show an explicit
 * "no diff available" row instead of silently dropping the entry.
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
  /** Set when content capture was intentionally skipped. */
  contentSkipped?: ContentSkipReason;
  /**
   * SHA-256 hex of the remote file bytes. Set for category `content` whenever
   * the box could hash the file, even when the bytes were not captured, so a
   * suppressed, over-size or binary payload stays comparable across previews.
   */
  remoteDigest?: string;
  /**
   * Fleet machine the remote side lives on, stamped by the preview helpers.
   * Fleet-wide aggregation needs it: `remotePath` is identical on every box.
   */
  box?: string;
  /**
   * Renderer hint; overrides auto-detection from `remotePath` (see
   * {@link resolveDiffMode}). `'suppressed'` drops the inline body and relies
   * on `contentSkipped` for the explanation row.
   */
  diffMode?: FileDiffMode;
}

/**
 * Explicit `entry.diffMode` wins; otherwise the `remotePath` suffix decides
 * (`.env` → env, `.yaml`/`.yml` → yaml, else unified-text). Content bytes are
 * deliberately not sniffed, so the hint stays deterministic and callsite-readable.
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
 * Parse one line of `rsync --itemize-changes` output. Returns null for lines
 * that are not actionable file drift: headers, blank and summary lines,
 * directory entries (rsync creates directories as a side-effect of file
 * entries), and in-sync entries (emitted only at -vv; filtered defensively).
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
  /** When true, color the diff with ANSI red/green. */
  color?: boolean;
  /** Cap on diff body lines per entry (excluding header). Default 200. */
  maxLines?: number;
  /**
   * When true, the env- and yaml-semantic renderers print values unmasked.
   * Off by default so the prompt and tee'd log never carry plaintext
   * credentials without an explicit operator opt-in.
   */
  revealEnvValues?: boolean;
  /**
   * Categories that get a diff body; others show only the per-file row.
   * Default `['new', 'content']`. `--diff-only=content` uses it to suppress
   * the potentially huge full-file body of new files.
   */
  diffOnlyCategories?: FileChangeCategory[];
}

/**
 * Render one entry as a unified diff, ignoring `diffMode`; the caller applies
 * indentation. Output starts at the `--- a/path` header. `mode` / `time-only`
 * entries and entries with no captured content return `[]` (the caller keeps
 * the label-only row); `contentSkipped` returns one skip-reason line.
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
  // Drop createTwoFilesPatch's "Index:" / "===" preamble before the `--- ` header.
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
 * Render one entry's diff body with the renderer `resolveDiffMode(entry)`
 * picks, in the same un-indented shape as `renderFileDriftWithDiff`.
 * `yaml-semantic` falls back to unified-text unless `idempotency-yaml-diff.ts`
 * has been imported (see {@link setYamlDiffRenderer}).
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
    // A setter-registered renderer keeps this module free of a load-time
    // `yaml` dependency; a dynamic import would force this path async.
    if (yamlDiffRenderer) {
      return yamlDiffRenderer(entry, opts);
    }
    // No yaml renderer wired: fall through to a still-usable unified-text body.
  }
  return renderFileDriftWithDiff(entry, { color: opts.color, maxLines: opts.maxLines });
}

/** NEW entries treat the remote side as empty, so every local key is `added`. */
function renderEnvDiffBody(entry: FileDriftEntry, opts: RenderDriftOpts): string[] {
  const local = entry.localContent ?? '';
  const remote = entry.category === 'new' ? '' : (entry.remoteContent ?? '');
  if (local === '' && remote === '' && entry.category !== 'new') return [];
  const diff = diffEnvFiles(local, remote);
  return renderEnvDiff(diff, { reveal: opts.revealEnvValues ?? false, color: opts.color ?? false });
}

/**
 * `idempotency-yaml-diff.ts` calls `setYamlDiffRenderer` at load time, so this
 * module dispatches to it without a static `yaml` dependency.
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
 * Render entries as an aligned block for a confirm-prompt summary:
 *
 *   3 file(s) drifted: 1 new, 1 content, 1 mode
 *     NEW      placeholder.html
 *     CONTENT  haproxy.cfg
 *     MODE     scripts/certbot-pre-stop.sh
 *
 * With `opts.withContent`, each row in `diffOnlyCategories` is followed by an
 * indented diff body. The caller applies the outer indentation.
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
