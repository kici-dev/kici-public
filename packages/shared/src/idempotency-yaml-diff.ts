/**
 * YAML-file semantic diff for the idempotent-step preview path. Parses
 * both sides with the `yaml` npm package, deep-walks the resulting JS
 * trees, and emits one `YamlDiffEntry` per leaf-level path that differs.
 *
 * "Leaf" means the smallest scalar inside the tree: a string, number,
 * boolean, or null. Arrays compare element-by-element by index; objects
 * recurse into their fields. The dotted path follows the JS-property
 * convention (`Database.postgres.User.Password`, `clients[2].name`).
 *
 * The renderer masks every entry whose path contains a sensitive
 * segment (`/password|passwd|secret|api[_-]?key|token|credentials?/i`)
 * unless the operator passes `reveal: true` via the
 * `--reveal-env-values` CLI flag. Non-sensitive entries print their
 * values inline so the operator can see config drift at a glance.
 */

import { parse as yamlParse } from 'yaml';
import {
  setYamlDiffRenderer,
  type FileDriftEntry,
  type RenderDriftOpts,
} from './idempotency-files.js';

// Hardcoded ANSI escapes, same convention as the other idempotency-*
// modules — see the rationale in `idempotency-files.ts`.
const ANSI_RED = '\x1b[31m';
const ANSI_GREEN = '\x1b[32m';
const ANSI_CYAN = '\x1b[36m';
const ANSI_RESET = '\x1b[0m';

export type YamlDiffKind = 'added' | 'removed' | 'changed';

export interface YamlDiffEntry {
  /** Dotted path to the leaf, e.g. "Database.postgres.User.Password" or "auth.clients[0].secret". */
  path: string;
  kind: YamlDiffKind;
  /** Populated for `changed` / `removed`. Scalar leaf value. */
  oldValue?: unknown;
  /** Populated for `added` / `changed`. Scalar leaf value. */
  newValue?: unknown;
  /** True when any segment in `path` matches the sensitive-keyword heuristic. */
  sensitive: boolean;
}

const SENSITIVE_SEGMENT_RE = /^(password|passwd|secret|secrets|api[_-]?key|token|credentials?)$/i;

/**
 * Returns true when any segment of the dotted path matches the
 * sensitive-keyword heuristic. Numeric array indices (`[0]`) are
 * stripped before the match so a path like `clients[3].token` still
 * matches via the `token` segment.
 */
export function isPathSensitive(dottedPath: string): boolean {
  const segments = dottedPath
    .split(/[.[\]]+/)
    .filter((s) => s !== '')
    .filter((s) => !/^\d+$/.test(s));
  return segments.some((s) => SENSITIVE_SEGMENT_RE.test(s));
}

/**
 * Deep-diff two YAML bodies. Both sides are parsed with the `yaml`
 * package, then a recursive walk emits one entry per leaf that differs.
 * Returns an empty array when the documents are structurally equivalent.
 *
 * Throws when either side fails to parse — the caller (the renderer
 * dispatch) catches and falls back to unified-text rendering on a parse
 * failure so a stray template tag in a yaml-by-suffix file doesn't lose
 * the operator's diff.
 */
export function diffYamlContent(local: string, remote: string): YamlDiffEntry[] {
  // Empty body → treat as "no document" (undefined). The `yaml` package
  // parses an empty string as `null`, which is structurally distinct from
  // "missing" — we want the missing semantics so a whole-document add or
  // remove collapses into a single `<root>` entry rather than a
  // `<root>: changed` from null to something.
  const localTree: unknown = local === '' ? undefined : yamlParse(local);
  const remoteTree: unknown = remote === '' ? undefined : yamlParse(remote);
  const entries: YamlDiffEntry[] = [];
  walkDiff('', localTree, remoteTree, entries);
  entries.sort((a, b) => {
    if (a.kind !== b.kind) {
      const ORDER: Record<YamlDiffKind, number> = { added: 0, changed: 1, removed: 2 };
      return ORDER[a.kind] - ORDER[b.kind];
    }
    return a.path.localeCompare(b.path);
  });
  return entries;
}

/**
 * Recursive walk over `local` and `remote`. For each pair of values at
 * `path`:
 *   - Both undefined → emit nothing (key missing in both).
 *   - Only local defined → recurse / emit `added`.
 *   - Only remote defined → recurse / emit `removed`.
 *   - Both defined, structurally compatible (both objects / both arrays)
 *     → recurse into children.
 *   - Both defined, scalar or shape-mismatched → emit `changed`.
 */
function walkDiff(path: string, local: unknown, remote: unknown, out: YamlDiffEntry[]): void {
  const lDefined = local !== undefined;
  const rDefined = remote !== undefined;
  if (!lDefined && !rDefined) return;
  if (lDefined && !rDefined) {
    emitLeafOrTree(path, local, 'added', out);
    return;
  }
  if (!lDefined && rDefined) {
    emitLeafOrTree(path, remote, 'removed', out);
    return;
  }
  const lObj = isPlainObject(local);
  const rObj = isPlainObject(remote);
  const lArr = Array.isArray(local);
  const rArr = Array.isArray(remote);
  if (lObj && rObj) {
    const lRec = local as Record<string, unknown>;
    const rRec = remote as Record<string, unknown>;
    const keys = new Set<string>([...Object.keys(lRec), ...Object.keys(rRec)]);
    for (const key of keys) {
      const childPath = path === '' ? key : `${path}.${key}`;
      walkDiff(childPath, lRec[key], rRec[key], out);
    }
    return;
  }
  if (lArr && rArr) {
    const lArrTyped = local as unknown[];
    const rArrTyped = remote as unknown[];
    const len = Math.max(lArrTyped.length, rArrTyped.length);
    for (let i = 0; i < len; i++) {
      const childPath = `${path}[${i}]`;
      walkDiff(childPath, lArrTyped[i], rArrTyped[i], out);
    }
    return;
  }
  if (deepEqual(local, remote)) return;
  out.push({
    path,
    kind: 'changed',
    oldValue: remote,
    newValue: local,
    sensitive: isPathSensitive(path),
  });
}

/**
 * When a whole subtree is added or removed, we collapse it into a
 * single entry rather than emitting one per descendant leaf. The
 * value is the entire subtree; the renderer prints it inline (masked
 * when the path is sensitive) or via a JSON one-liner.
 */
function emitLeafOrTree(
  path: string,
  value: unknown,
  kind: 'added' | 'removed',
  out: YamlDiffEntry[],
): void {
  // Empty path can only happen for top-level value (whole document
  // added/removed). Emit at path '<root>' so the renderer prints
  // something useful.
  const reportedPath = path === '' ? '<root>' : path;
  if (kind === 'added') {
    out.push({ path: reportedPath, kind, newValue: value, sensitive: isPathSensitive(path) });
  } else {
    out.push({ path: reportedPath, kind, oldValue: value, sensitive: isPathSensitive(path) });
  }
}

function isPlainObject(value: unknown): boolean {
  if (value === null || typeof value !== 'object') return false;
  if (Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/**
 * Cheap structural equality check. Only used as a tie-breaker for the
 * "neither object nor array" branch — scalar leaves go through
 * `===` after a JSON-stringify-equiv comparison. Functions / Dates /
 * other class instances fall back to `Object.is`, which is fine
 * because the `yaml` package only emits plain values for the tag set
 * we use (scalar, sequence, mapping).
 */
function deepEqual(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  return JSON.stringify(a) === JSON.stringify(b);
}

export interface YamlDiffRenderOpts {
  /** When true, sensitive paths show their values inline; otherwise masked. */
  reveal?: boolean;
  /** When true, color the kind label + values via ANSI escapes. */
  color?: boolean;
}

/**
 * Render the yaml-semantic diff body. Returns one entry's worth of
 * lines per `YamlDiffEntry`, plus an empty-state fallback line when
 * there's nothing to show. No surrounding indent applied — the caller
 * decides nesting.
 *
 * Layout:
 *
 *   Database.postgres.User.Password: changed (masked — pass --reveal-env-values to show)
 *   server.listen: changed
 *     - old=80
 *     + new=8080
 *   features.beta: added
 *     + new=true
 *
 * The CLI flag is named `--reveal-env-values` because the same flag
 * governs env-semantic + yaml-semantic value reveals; calling the flag
 * "env-values" reflects the most common case (sops-derived env files)
 * but it activates yaml-side reveal too.
 */
export function renderYamlDiff(entries: YamlDiffEntry[], opts: YamlDiffRenderOpts = {}): string[] {
  const reveal = opts.reveal ?? false;
  const color = opts.color ?? false;
  if (entries.length === 0) return ['0 yaml leaf(s) drifted (structure matches)'];
  const lines: string[] = [];
  for (const entry of entries) {
    const mask = entry.sensitive && !reveal;
    const headTail = mask ? ' (masked — pass --reveal-env-values to show)' : '';
    lines.push(`${entry.path}: ${colorizeKind(entry.kind, color)}${headTail}`);
    if (mask) continue;
    if (entry.kind === 'changed' || entry.kind === 'removed') {
      lines.push(`  ${colorize('- old=' + formatValue(entry.oldValue), 'old', color)}`);
    }
    if (entry.kind === 'changed' || entry.kind === 'added') {
      lines.push(`  ${colorize('+ new=' + formatValue(entry.newValue), 'new', color)}`);
    }
  }
  return lines;
}

function formatValue(value: unknown): string {
  if (value === null) return 'null';
  if (value === undefined) return 'undefined';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  // Objects / arrays: one-line JSON for the operator's eye. Truncated
  // at a reasonable cap so a massive subtree doesn't blow the terminal.
  try {
    const json = JSON.stringify(value);
    if (json.length <= 240) return json;
    return json.slice(0, 240) + `… (${json.length - 240} more bytes)`;
  } catch {
    return String(value);
  }
}

function colorizeKind(kind: YamlDiffKind, color: boolean): string {
  if (!color) return kind;
  switch (kind) {
    case 'added':
      return `${ANSI_GREEN}${kind}${ANSI_RESET}`;
    case 'removed':
      return `${ANSI_RED}${kind}${ANSI_RESET}`;
    case 'changed':
      return `${ANSI_CYAN}${kind}${ANSI_RESET}`;
  }
}

function colorize(text: string, side: 'old' | 'new', color: boolean): string {
  if (!color) return text;
  return side === 'new' ? `${ANSI_GREEN}${text}${ANSI_RESET}` : `${ANSI_RED}${text}${ANSI_RESET}`;
}

/**
 * Bridge between the FileDriftEntry / RenderDriftOpts API surface and
 * the yaml diff renderer. Registered at module load time via
 * `setYamlDiffRenderer` so `renderFileDriftBody` can dispatch yaml
 * entries without a hard dependency on the `yaml` package in
 * `idempotency-files.ts`.
 *
 * On a yaml-parse failure, the renderer returns a single explanatory
 * line and the dispatch falls through (caller-side) to the unified-text
 * body so the operator still sees something useful.
 */
function renderYamlDiffEntry(entry: FileDriftEntry, opts: RenderDriftOpts): string[] {
  const local = entry.localContent ?? '';
  const remote = entry.category === 'new' ? '' : (entry.remoteContent ?? '');
  if (local === '' && remote === '' && entry.category !== 'new') return [];
  let diffs: YamlDiffEntry[];
  try {
    diffs = diffYamlContent(local, remote);
  } catch (err) {
    return [`(yaml parse failed — ${(err as Error).message})`];
  }
  return renderYamlDiff(diffs, {
    reveal: opts.revealEnvValues ?? false,
    color: opts.color ?? false,
  });
}

setYamlDiffRenderer(renderYamlDiffEntry);
