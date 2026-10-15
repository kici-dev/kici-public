/**
 * YAML semantic diff for the idempotent-step preview: one `YamlDiffEntry` per
 * differing leaf (string, number, boolean or null). Arrays compare by index;
 * paths use JS-property notation (`Database.postgres.User.Password`,
 * `clients[2].name`).
 *
 * The renderer masks entries whose path has a sensitive segment
 * (`/password|passwd|secret|api[_-]?key|token|credentials?/i`) unless
 * `--reveal-env-values` sets `reveal: true`; other values print inline.
 */

import { parse as yamlParse } from 'yaml';
import {
  setYamlDiffRenderer,
  type FileDriftEntry,
  type RenderDriftOpts,
} from './idempotency-files.js';

// Hardcoded ANSI escapes: rationale in `idempotency-files.ts`.
const ANSI_RED = '\x1b[31m';
const ANSI_GREEN = '\x1b[32m';
const ANSI_CYAN = '\x1b[36m';
const ANSI_RESET = '\x1b[0m';

export type YamlDiffKind = 'added' | 'removed' | 'changed';

export interface YamlDiffEntry {
  /** Dotted path to the leaf, e.g. "Database.postgres.User.Password" or "auth.clients[0].secret". */
  path: string;
  kind: YamlDiffKind;
  /** Set for `changed` / `removed`. */
  oldValue?: unknown;
  /** Set for `added` / `changed`. */
  newValue?: unknown;
  /** True when any segment in `path` matches the sensitive-keyword heuristic. */
  sensitive: boolean;
}

const SENSITIVE_SEGMENT_RE = /^(password|passwd|secret|secrets|api[_-]?key|token|credentials?)$/i;

/** Numeric indices are stripped first, so `clients[3].token` matches on `token`. */
export function isPathSensitive(dottedPath: string): boolean {
  const segments = dottedPath
    .split(/[.[\]]+/)
    .filter((s) => s !== '')
    .filter((s) => !/^\d+$/.test(s));
  return segments.some((s) => SENSITIVE_SEGMENT_RE.test(s));
}

/**
 * Returns `[]` for structurally equal documents. Throws on a parse failure;
 * the renderer dispatch then falls back to a unified-text diff, so a stray
 * template tag in a yaml-by-suffix file does not lose the operator's diff.
 */
export function diffYamlContent(local: string, remote: string): YamlDiffEntry[] {
  // `yaml` parses '' as `null`; treat it as missing instead, so a
  // whole-document add or remove is one `<root>` entry, not `changed` from null.
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
 * Only local defined → `added`; only remote → `removed`; both objects or both
 * arrays → recurse; otherwise (scalar or shape mismatch) → `changed`.
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

/** A whole added or removed subtree collapses into one entry carrying the subtree. */
function emitLeafOrTree(
  path: string,
  value: unknown,
  kind: 'added' | 'removed',
  out: YamlDiffEntry[],
): void {
  // An empty path means the whole document was added or removed.
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
 * Cheap equality for the scalar / shape-mismatch branch. JSON comparison is
 * safe: `yaml` emits only plain values for the scalar, sequence and mapping
 * tags in use, never Dates or class instances.
 */
function deepEqual(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  return JSON.stringify(a) === JSON.stringify(b);
}

export interface YamlDiffRenderOpts {
  /** When true, sensitive paths show their values inline; otherwise masked. */
  reveal?: boolean;
  /** ANSI-color the kind label and values. */
  color?: boolean;
}

/**
 * Render the diff body with no outer indent (the caller nests it), or an
 * empty-state line when nothing drifted. Layout:
 *
 *   Database.postgres.User.Password: changed (masked — pass --reveal-env-values to show)
 *   server.listen: changed
 *     - old=80
 *     + new=8080
 *   features.beta: added
 *     + new=true
 *
 * `--reveal-env-values` governs both env and yaml reveals; it is named for the
 * common case (sops-derived env files).
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
  // One-line JSON, truncated so a massive subtree cannot flood the terminal.
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
 * Registered via `setYamlDiffRenderer` at load, so `idempotency-files.ts` has
 * no hard `yaml` dependency. On a parse failure it returns one explanatory
 * line and the caller falls through to the unified-text body.
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
