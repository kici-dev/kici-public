/**
 * Env-file semantic diff for the idempotent-step preview path: two raw env
 * files (local generated, remote) in, one sorted entry per key out.
 *
 * The renderer masks every value by default: in deploy-prod an env file is
 * sops-derived credential material, and the confirm prompt is tee'd to
 * `release-prod.log.<ts>`. `--reveal-env-values` (→ `KICI_REVEAL_ENV_VALUES=1`
 * → `reveal: true`) shows the values.
 */

// Hardcoded ANSI escapes, as in `idempotency-files.ts`: output stays stable
// whatever the terminal's color probe says; strip with
// `sed 's/\x1b\[[0-9;]*m//g'`.
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
 * Parse an env-file body the way Docker / systemd `EnvironmentFile=` /
 * Keycloak's env loader do:
 *
 *   - Blank lines and `#` comments are skipped.
 *   - The first `=` splits key and value.
 *   - Balanced surrounding single or double quotes are stripped.
 *   - Duplicate keys: last write wins (POSIX shell semantics).
 *   - Only the key is trimmed, so a trailing space in a credential is drift.
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
 * Diff two env-file bodies: one entry per key in either, ordered `added`,
 * `changed`, `removed`, `unchanged`, alphabetical within each group.
 *
 * `local` is the new side (what the deploy ships), `remote` the old side (on
 * the box), as in `previewRsyncFileToBox`.
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
 * Render the env diff body lines, unindented: the caller (e.g.
 * `renderFileDrifts`) nests them.
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
 * With no drift the body is never empty: one unchanged-count line confirms
 * the env is in sync.
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
