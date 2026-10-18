/**
 * Proves a CLI's `--help` never prints a secret read from the environment.
 *
 * A Commander option declared as `.option(flags, desc, process.env.X)` takes the
 * env value as its default, and `--help` prints the default verbatim. The
 * helpers here plant a sentinel in every secret-shaped env var a package's
 * source reads, then search the help of every command in the tree for one.
 *
 * The env var list is read from the source, not written by hand, so an option
 * added later with a new env-backed default is covered without editing a test.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { vi } from 'vitest';

/** The structural slice of a Commander `Command` the walk needs. */
export interface HelpNode {
  name(): string;
  helpInformation(): string;
  readonly commands: readonly HelpNode[];
}

/** Names that carry a credential, or a URL that may embed one. */
const SECRET_SHAPED =
  /TOKEN|SECRET|PASSWORD|PASSWD|PASSPHRASE|_KEY|KEY_|_URL|_URLS|DSN|CREDENTIAL|PRIVATE|AUTH|JWT|PEM|CERT|(^|_)PAT($|_)/;

/**
 * `process.env.NAME`, `process.env['NAME']`, and any quoted SCREAMING_SNAKE literal, so a
 * name handed to Commander's `.env()` through a helper counts too. Over-matching only
 * plants a sentinel nothing reads.
 */
const ENV_READ =
  /process\.env(?:\.([A-Za-z_][A-Za-z0-9_]*)|\[['"]([A-Za-z_][A-Za-z0-9_]*)['"]\])|['"]([A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+)['"]/g;

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) {
      if (entry !== 'node_modules' && entry !== '__fixtures__') out.push(...sourceFiles(path));
    } else if (/\.tsx?$/.test(entry) && !/\.test\.tsx?$/.test(entry) && !entry.endsWith('.d.ts')) {
      out.push(path);
    }
  }
  return out;
}

/** Every secret-shaped env var name the source under `srcDir` reads. */
export function secretEnvVarsReadIn(srcDir: string): string[] {
  const names = new Set<string>();
  for (const file of sourceFiles(srcDir)) {
    for (const match of readFileSync(file, 'utf8').matchAll(ENV_READ)) {
      const name = match[1] ?? match[2] ?? match[3]!;
      if (SECRET_SHAPED.test(name)) names.add(name);
    }
  }
  return [...names].sort();
}

/** A value that cannot occur in help text by accident. */
export function sentinelFor(name: string): string {
  return `sentinel-${name.toLowerCase()}-0f3e`;
}

/** The help text of `root` and every command beneath it, keyed by command path. */
export function collectHelp(root: HelpNode): Map<string, string> {
  const out = new Map<string, string>();
  const walk = (cmd: HelpNode, path: string): void => {
    out.set(path, cmd.helpInformation());
    for (const sub of cmd.commands) walk(sub, `${path} ${sub.name()}`);
  };
  walk(root, root.name());
  return out;
}

/** `<command path>: <env var>` for each help text that contains a planted sentinel. */
export function findSentinelLeaks(root: HelpNode, envVars: readonly string[]): string[] {
  const leaks: string[] = [];
  for (const [path, text] of collectHelp(root)) {
    for (const name of envVars) {
      if (text.includes(sentinelFor(name))) leaks.push(`${path}: ${name}`);
    }
  }
  return leaks;
}

/**
 * Stub every name in `envVars` with its sentinel, then build the CLI with
 * `load` (after the stub, so a module-scope env read sees it) and return the
 * leaks. The caller restores the env with `vi.unstubAllEnvs()`.
 */
export async function sentinelLeaksAfterLoad<T extends HelpNode>(
  envVars: readonly string[],
  load: () => Promise<T>,
): Promise<{ program: T; leaks: string[] }> {
  for (const name of envVars) vi.stubEnv(name, sentinelFor(name));
  const program = await load();
  return { program, leaks: findSentinelLeaks(program, envVars) };
}

/** Help text with every whitespace run collapsed, so a wrapped hint still matches. */
export function flatHelp(cmd: HelpNode): string {
  return cmd.helpInformation().replace(/\s+/g, ' ');
}
