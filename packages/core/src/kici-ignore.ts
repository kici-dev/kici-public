/**
 * `.kici/.kiciignore` — the declared list of paths the source digest excludes.
 *
 * The digest names a workflow's identity, so *which files it covers* is part of
 * that identity's definition. Before this file that definition was three
 * hard-coded constants, and it was wrong: the agent rewrites
 * `.kici/package-lock.json` (`npm install`, deliberately not `npm ci`, so a
 * resolved URL baked into the lock file cannot point at the wrong registry) and
 * `.kici/.npmrc` (a managed auth block, applied for one install and restored
 * after) inside the very tree whose digest it must reproduce. Neither was
 * excluded, so the drift gate rejected runs whose source had not changed.
 *
 * Making the set declarative rather than hard-coded is what lets a customer
 * whose own tooling writes into `.kici/` fix the same class of problem without
 * a release.
 *
 * ## Not to be confused with the repo-root `.kiciignore`
 *
 * A repo **root** `.kiciignore` already exists and is unrelated: it selects
 * which working-tree files a `kici run --remote` overlay uploads
 * (`compiler/src/remote/uploader.ts`, glob-matched, relative to the repo root).
 * This one lives at `.kici/.kiciignore`, is matched relative to `.kici/`, and
 * affects only the digest. The two files never read each other.
 *
 * ## Semantics
 *
 * gitignore-style, and deliberately implemented here rather than delegated to a
 * glob library: a glob matcher reads `node_modules/` as a directory named
 * `node_modules` and NOT as everything beneath it, which would silently fail to
 * exclude the exact paths this file exists to exclude. The digest is a
 * compat-protected identity input, so its matching rules are spelled out and
 * tested rather than inherited.
 *
 * - Blank lines and `#` comments are dropped; `\#` escapes a leading `#`.
 * - A trailing `/` makes a pattern directory-only.
 * - A pattern containing a slash is anchored at `.kici/`; a bare name matches
 *   at any depth.
 * - `*` matches within one segment, `**` across segments, `?` one character.
 * - A leading `!` re-includes; the last matching pattern wins.
 * - A path under an ignored directory is ignored.
 *
 * One deliberate deviation from gitignore: a **symlink to a directory counts as
 * a directory**, so `node_modules/` covers a symlinked `node_modules`. `git`
 * treats a symlink as a file and would not. The purpose of the entry is
 * "exclude the dependency tree, whatever shape it takes on disk" — and treating
 * the link as a file hashed a `symlink:<target>` member into the identity that
 * the agent's own tree, where the dependency install writes a real directory,
 * structurally could not hold. The resolution happens in `collectSourcePaths`,
 * which stats a link to classify it and never follows one to read what is
 * behind it; the matcher below is unchanged and merely receives a truthful
 * `isDir`.
 */

/**
 * The exclusion set applied when `.kici/.kiciignore` is absent.
 *
 * `node_modules/` and `types/` are build outputs the tarball either omits or
 * regenerates; `.npmrc`, `package-lock.json` and `pnpm-lock.yaml` are rewritten
 * by the dependency install a run performs before it re-hashes;
 * `kici.lock.json` is the file the digest is written into.
 */
export const KICI_DIGEST_DEFAULT_EXCLUSIONS: readonly string[] = [
  'node_modules/',
  'types/',
  '.npmrc',
  'package-lock.json',
  'pnpm-lock.yaml',
  'kici.lock.json',
];

/**
 * Excluded no matter what `.kiciignore` says.
 *
 * The compiler writes the computed digest INTO `.kici/kici.lock.json`, so a
 * digest covering that file would be an input to itself and no fixed point
 * would exist. This is arithmetic, not policy — there is no configuration under
 * which hashing it could work, so honoring a `.kiciignore` that omits it would
 * only produce a gate that rejects every run.
 *
 * The lock file's own integrity comes from elsewhere: the orchestrator fetches
 * it at the commit SHA, so provenance vouches for it, never `contentHash`.
 */
export const KICI_DIGEST_FORCED_EXCLUSIONS: readonly string[] = ['kici.lock.json'];

/**
 * Paths a run rewrites inside `.kici/` before it re-hashes the tree.
 *
 * Under replace semantics a short `.kiciignore` silently re-includes these, and
 * the digest then changes on every run with nothing naming why. A compile whose
 * file omits one warns rather than failing: the customer keeps full control,
 * and the failure stops being mysterious.
 */
export const KICI_RUN_REWRITTEN_PATHS: readonly string[] = [
  'node_modules/',
  '.npmrc',
  'package-lock.json',
];

/**
 * The `.kiciignore` file's name, relative to `.kici/`. Only the copy at the
 * root of `.kici/` is consulted; a nested one is ordinary hashed source.
 */
export const KICI_IGNORE_FILENAME = '.kiciignore';

/**
 * Hashed no matter what `.kiciignore` says — including when it names itself.
 *
 * The file declares which paths define a workflow's identity, so it is part of
 * that identity: editing it must move the digest and force a recompile. Were it
 * able to exclude itself, someone could change what a lock file attests to
 * without changing the lock file, which is the one outcome the digest exists to
 * prevent. Forced inclusion beats every exclusion, the forced ones included.
 */
export const KICI_DIGEST_FORCED_INCLUSIONS: readonly string[] = [KICI_IGNORE_FILENAME];

/**
 * Split a `.kiciignore` file into patterns: trimmed, comment- and blank-free.
 *
 * Returns an empty array for a file that declares nothing, which under replace
 * semantics genuinely means "exclude nothing but the forced entry" — distinct
 * from an absent file, which means "use the defaults".
 */
export function parseKiciIgnore(content: string): string[] {
  const patterns: string[] = [];
  for (const rawLine of content.split('\n')) {
    const line = rawLine.trim();
    if (line.length === 0 || line.startsWith('#')) continue;
    patterns.push(line.startsWith('\\#') ? line.slice(1) : line);
  }
  return patterns;
}

interface CompiledPattern {
  readonly re: RegExp;
  readonly dirOnly: boolean;
  readonly negated: boolean;
}

/** Translate one gitignore-style pattern body into an anchored regular expression. */
function globToRegExpSource(glob: string): string {
  let out = '';
  for (let i = 0; i < glob.length; i++) {
    const ch = glob[i];
    if (ch === '*') {
      if (glob[i + 1] === '*') {
        out += '.*';
        i++;
      } else {
        out += '[^/]*';
      }
    } else if (ch === '?') {
      out += '[^/]';
    } else {
      // Everything else is a literal, metacharacters included.
      out += ch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    }
  }
  return out;
}

function compilePattern(pattern: string): CompiledPattern | null {
  let body = pattern;

  const negated = body.startsWith('!');
  if (negated) body = body.slice(1);
  if (body.startsWith('\\!')) body = body.slice(1);
  if (body.length === 0) return null;

  const dirOnly = body.endsWith('/');
  if (dirOnly) body = body.slice(0, -1);
  if (body.length === 0) return null;

  // A leading slash anchors and is not part of the path being matched. A slash
  // anywhere else also anchors, which is gitignore's rule.
  const leadingSlash = body.startsWith('/');
  if (leadingSlash) body = body.slice(1);
  if (body.length === 0) return null;
  const anchored = leadingSlash || body.includes('/');

  const source = globToRegExpSource(body);
  // Unanchored patterns match a path's tail at a segment boundary, which is how
  // a bare name matches at any depth.
  const re = new RegExp(anchored ? `^${source}$` : `(?:^|/)${source}$`);
  return { re, dirOnly, negated };
}

/**
 * Build a matcher over patterns already parsed from a `.kiciignore`.
 *
 * The returned predicate takes a POSIX path relative to `.kici/` and whether it
 * names a directory. It reports true when the path itself — or any directory
 * above it — is excluded, so a directory pattern covers its whole subtree.
 */
export function buildKiciIgnoreMatcher(
  patterns: readonly string[],
): (relPath: string, isDir: boolean) => boolean {
  const compiled: CompiledPattern[] = [];
  for (const pattern of patterns) {
    const entry = compilePattern(pattern);
    if (entry) compiled.push(entry);
  }
  if (compiled.length === 0) return () => false;

  /** Decide one concrete path, ancestors not considered. Last match wins. */
  const decideSelf = (relPath: string, isDir: boolean): boolean => {
    let ignored = false;
    for (const { re, dirOnly, negated } of compiled) {
      if (dirOnly && !isDir) continue;
      if (re.test(relPath)) ignored = !negated;
    }
    return ignored;
  };

  return (relPath: string, isDir: boolean): boolean => {
    const segments = relPath.split('/');
    // Walk ancestors shallowest-first: once a directory is excluded its whole
    // subtree is, which is what makes `node_modules/` mean the tree under it.
    for (let i = 1; i < segments.length; i++) {
      if (decideSelf(segments.slice(0, i).join('/'), true)) return true;
    }
    return decideSelf(relPath, isDir);
  };
}

/**
 * Which of the run-rewritten paths a pattern set fails to cover.
 *
 * Asks the matcher rather than comparing strings, so a broader pattern that
 * genuinely does exclude a path (`*`, `*.json`) is credited and does not warn.
 * Returned sorted, so the warning text is deterministic.
 */
export function findUncoveredRunRewrittenPaths(patterns: readonly string[]): string[] {
  const matches = buildKiciIgnoreMatcher(patterns);
  const uncovered: string[] = [];
  for (const target of KICI_RUN_REWRITTEN_PATHS) {
    const isDir = target.endsWith('/');
    const probe = isDir ? target.slice(0, -1) : target;
    if (!matches(probe, isDir)) uncovered.push(target);
  }
  return uncovered.sort();
}

/** The warning text for one run-rewritten path a `.kiciignore` omits. */
export function runRewrittenWarning(target: string): string {
  return (
    `.kici/.kiciignore does not exclude '${target}', which a run rewrites inside .kici/ ` +
    `before the agent re-hashes the tree. The workflow's contentHash will therefore ` +
    `change on every run and the drift gate will reject it. Add '${target}' to ` +
    `.kici/.kiciignore, or remove the file to fall back to the defaults.`
  );
}
