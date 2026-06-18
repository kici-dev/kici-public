/**
 * Env-file semantic diff for the idempotent-step preview path.
 *
 * Inputs are the raw byte strings of two env files (local generated +
 * remote-cat'd). Output is a sorted list of `EnvDiffEntry` records — one
 * per key that was added, removed, or changed (plus an unchanged count).
 *
 * The renderer masks every value by default: an env file is sops-derived
 * credential material in the deploy-prod context, and the confirm prompt
 * is tee'd to `release-prod.log.<ts>`. Operators who need to see the
 * actual values pass `--reveal-env-values` end-to-end (CLI flag → env var
 * `KICI_REVEAL_ENV_VALUES=1` → `reveal: true` on this renderer). Without
 * the flag the rendered output carries only the key name + classification.
 */

// Hardcoded ANSI escapes, same convention as `idempotency-files.ts`: keep
// the rendered output stable regardless of the host terminal's color probe
// and let the operator strip via `sed 's/\x1b\[[0-9;]*m//g'` if they want
// plain text.
const ANSI_RED = '\x1b[31m';
const ANSI_GREEN = '\x1b[32m';
const ANSI_CYAN = '\x1b[36m';
const ANSI_RESET = '\x1b[0m';

export type EnvDiffKind = 'added' | 'removed' | 'changed' | 'unchanged';

export interface EnvDiffEntry {
  key: string;
  kind: EnvDiffKind;
  /** Only populated for `changed` / `removed` kinds. */
  oldValue?: string;
  /** Only populated for `added` / `changed` kinds. */
  newValue?: string;
}

/**
 * Parse an env-file body into a `Map<string, string>`. The shape matches
 * what Docker / systemd `EnvironmentFile=` / Keycloak's env loader consume:
 *
 *   - Blank lines and `#`-prefixed comments are skipped.
 *   - The first `=` splits key and value; values may contain further `=`.
 *   - Surrounding single or double quotes on the value are stripped when
 *     they are balanced; otherwise the literal bytes are preserved.
 *   - Duplicate keys: last write wins (POSIX shell semantics).
 *   - Whitespace is stripped from the key only — values keep their bytes
 *     verbatim so a trailing space in a credential is detected as drift.
 */
export function parseEnvLines(content: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const rawLine of content.split('\n')) {
    const line = rawLine.replace(/\r$/, '');
    const trimmedLeft = line.replace(/^[\t ]+/, '');
    if (trimmedLeft === '') continue;
    if (trimmedLeft.startsWith('#')) continue;
    const eqIdx = trimmedLeft.indexOf('=');
    if (eqIdx < 0) continue;
    const key = trimmedLeft.slice(0, eqIdx).trim();
    if (key === '') continue;
    let value = trimmedLeft.slice(eqIdx + 1);
    if (
      value.length >= 2 &&
      ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'")))
    ) {
      value = value.slice(1, -1);
    }
    out.set(key, value);
  }
  return out;
}

/**
 * Diff two env-file bodies. Returns one entry per key in the union of
 * both inputs. Entry order: `added`, `changed`, `removed`, `unchanged`,
 * alphabetically inside each group.
 *
 * `local` is the new-side bytes (what the deploy would ship), `remote`
 * is the old-side bytes (what's currently on the box). The convention
 * matches `previewRsyncFileToBox`'s `localContent` / `remoteContent`
 * field names.
 */
export function diffEnvFiles(local: string, remote: string): EnvDiffEntry[] {
  const localMap = parseEnvLines(local);
  const remoteMap = parseEnvLines(remote);
  const entries: EnvDiffEntry[] = [];
  const keys = new Set<string>([...localMap.keys(), ...remoteMap.keys()]);
  for (const key of keys) {
    const inLocal = localMap.has(key);
    const inRemote = remoteMap.has(key);
    const localValue = localMap.get(key);
    const remoteValue = remoteMap.get(key);
    if (inLocal && !inRemote) {
      entries.push({ key, kind: 'added', newValue: localValue });
    } else if (!inLocal && inRemote) {
      entries.push({ key, kind: 'removed', oldValue: remoteValue });
    } else if (inLocal && inRemote && localValue !== remoteValue) {
      entries.push({ key, kind: 'changed', oldValue: remoteValue, newValue: localValue });
    } else {
      entries.push({ key, kind: 'unchanged' });
    }
  }
  const ORDER: Record<EnvDiffKind, number> = {
    added: 0,
    changed: 1,
    removed: 2,
    unchanged: 3,
  };
  entries.sort((a, b) => {
    if (ORDER[a.kind] !== ORDER[b.kind]) return ORDER[a.kind] - ORDER[b.kind];
    return a.key.localeCompare(b.key);
  });
  return entries;
}

export interface EnvDiffRenderOpts {
  /** When true, show old + new values inline. Default false (masked output). */
  reveal?: boolean;
  /** When true, color the kind label with ANSI red/green/cyan. */
  color?: boolean;
}

/**
 * Render the env-semantic diff body lines. The returned array carries
 * NO surrounding indentation — the caller (e.g. `renderFileDrifts`)
 * decides how to nest each line under its containing per-file row.
 *
 * Masked layout (default):
 *
 *   KEY_A: changed
 *   KEY_B: added
 *   KEY_C: removed
 *   3 other key(s) unchanged
 *
 * Revealed layout (`reveal: true`):
 *
 *   KEY_A: changed
 *     - old=hunter2
 *     + new=tr0ub4dor
 *   KEY_B: added
 *     + new=AKIA…
 *   KEY_C: removed
 *     - old=zzz
 *   3 other key(s) unchanged
 *
 * When there are no changed / added / removed entries (every key matches
 * byte-for-byte), the function returns a single "N key(s) unchanged"
 * line so the operator gets a positive "in sync at the env level"
 * confirmation rather than an empty body.
 */
export function renderEnvDiff(entries: EnvDiffEntry[], opts: EnvDiffRenderOpts = {}): string[] {
  const reveal = opts.reveal ?? false;
  const color = opts.color ?? false;
  const lines: string[] = [];
  const changedish = entries.filter((e) => e.kind !== 'unchanged');
  let unchangedCount = entries.length - changedish.length;
  for (const entry of changedish) {
    lines.push(`${entry.key}: ${colorizeKind(entry.kind, color)}`);
    if (reveal) {
      if (entry.kind === 'changed' || entry.kind === 'removed') {
        lines.push(`  ${colorize('- old=' + (entry.oldValue ?? ''), 'old', color)}`);
      }
      if (entry.kind === 'changed' || entry.kind === 'added') {
        lines.push(`  ${colorize('+ new=' + (entry.newValue ?? ''), 'new', color)}`);
      }
    }
  }
  if (unchangedCount > 0) {
    lines.push(`${unchangedCount} other key(s) unchanged`);
  } else if (lines.length === 0) {
    lines.push(`0 key(s) drifted (env content matches)`);
  }
  return lines;
}

function colorizeKind(kind: EnvDiffKind, color: boolean): string {
  if (!color) return kind;
  switch (kind) {
    case 'added':
      return `${ANSI_GREEN}${kind}${ANSI_RESET}`;
    case 'removed':
      return `${ANSI_RED}${kind}${ANSI_RESET}`;
    case 'changed':
      return `${ANSI_CYAN}${kind}${ANSI_RESET}`;
    case 'unchanged':
      return kind;
  }
}

function colorize(text: string, side: 'old' | 'new', color: boolean): string {
  if (!color) return text;
  return side === 'new' ? `${ANSI_GREEN}${text}${ANSI_RESET}` : `${ANSI_RED}${text}${ANSI_RESET}`;
}
