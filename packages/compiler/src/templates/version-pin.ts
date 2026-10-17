/**
 * How `kici init` writes the versions of the packages it scaffolds. The
 * repository's `.npmrc` is read the way npm's `ini` parser reads it, so the
 * scaffold agrees with the package manager that later installs from it.
 */

import { readFile } from 'node:fs/promises';
import path from 'node:path';

/** How the scaffold writes a package version. */
export enum VersionPin {
  /** The `latest` dist-tag: development mode, where builds are registry prereleases. */
  Latest = 'latest',
  /** A caret range: npm's default `save-prefix`. */
  Caret = 'caret',
  /** An exact version: the repository asks npm to save exact versions. */
  Exact = 'exact',
}

/** The value of a `key` line with no `=`, which npm reads as `true`. */
const BARE_KEY = Symbol('bare-key');
type NpmrcValue = string | typeof BARE_KEY;

const COMMENT_OR_BLANK = /^\s*(?:[;#]|$)/;
const SECTION_LINE = /^\[[^\]]*\]\s*$/;
const PAIR_LINE = /^([^=]+)(=(.*))?$/;

/**
 * Decode one side of a `.npmrc` line like npm's `ini` parser. A value wrapped
 * in quotes is unwrapped and JSON-decoded. Otherwise an unescaped `;` or `#`
 * starts a comment, `\;`, `\#` and `\\` are escapes, and the rest is trimmed.
 */
function decodeIniValue(raw: string): string {
  const val = raw.trim();
  const quoted =
    (val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"));
  if (quoted) {
    const inner = val.startsWith("'") ? val.slice(1, -1) : val;
    try {
      return String(JSON.parse(inner));
    } catch {
      return inner;
    }
  }
  let out = '';
  let escaped = false;
  for (const c of val) {
    if (escaped) {
      out += '\\;#'.includes(c) ? c : `\\${c}`;
      escaped = false;
    } else if (c === ';' || c === '#') {
      break;
    } else if (c === '\\') {
      escaped = true;
    } else {
      out += c;
    }
  }
  return (escaped ? `${out}\\` : out).trim();
}

/**
 * The top-level pairs of `.npmrc` text, last value winning. npm splits lines on
 * every run of CR and LF, and keys after a `[section]` header belong to that
 * section, so they are not top level.
 */
function topLevelPairs(text: string): Map<string, NpmrcValue> {
  const pairs = new Map<string, NpmrcValue>();
  for (const line of text.split(/[\r\n]+/)) {
    if (COMMENT_OR_BLANK.test(line)) continue;
    if (SECTION_LINE.test(line)) break;
    const match = PAIR_LINE.exec(line);
    if (!match) continue;
    pairs.set(
      decodeIniValue(match[1]),
      match[2] === undefined ? BARE_KEY : decodeIniValue(match[3]),
    );
  }
  return pairs;
}

/**
 * Whether npm saves exact versions under this `.npmrc` text: `save-exact` set
 * to anything except `false` or `null`, or an empty `save-prefix`.
 */
export function npmrcRequestsExactVersions(text: string): boolean {
  const pairs = topLevelPairs(text);
  const saveExact = pairs.get('save-exact');
  const exact = saveExact !== undefined && saveExact !== 'false' && saveExact !== 'null';
  return exact || pairs.get('save-prefix') === '';
}

/**
 * The version pin for a scaffold whose repository root is `repoRoot`: the
 * `latest` dist-tag in development mode, else exact or caret as the
 * repository's `.npmrc` asks.
 */
export async function resolveVersionPin(devMode: boolean, repoRoot: string): Promise<VersionPin> {
  if (devMode) return VersionPin.Latest;
  let text: string;
  try {
    text = await readFile(path.join(repoRoot, '.npmrc'), 'utf-8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return VersionPin.Caret;
    throw error;
  }
  return npmrcRequestsExactVersions(text) ? VersionPin.Exact : VersionPin.Caret;
}
