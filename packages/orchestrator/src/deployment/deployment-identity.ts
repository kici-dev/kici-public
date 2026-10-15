import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  DeploymentModeSchema,
  DeploymentContainerRuntimeSchema,
  type DeploymentIdentity,
  type ConfigPaths,
} from '@kici-dev/engine';

/**
 * The npm global bin directory implied by a path inside a global install, or
 * `undefined` when the path is not inside one.
 *
 * npm lays a posix global install out as `<prefix>/lib/node_modules/<pkg>/…`, so
 * the bin directory is `<prefix>/bin`. The split is on the FIRST `node_modules`
 * segment, matching `resolveNpmInstallTarget`: the orchestrator installs either
 * standalone or nested in kici-admin's own `node_modules`, and only the first
 * segment yields `<prefix>/lib` for both (the last would derive a bin directory
 * that does not exist).
 *
 * The preceding segment must be `lib`, which distinguishes a global install from
 * a local `node_modules` tree, a pnpm global store, or a container image root.
 * Without it a local install under `/srv/kici` derives `/srv/bin` and pins a
 * same-named binary there. Only `systemd` / `launchd` reach this code, so only
 * the posix layout has to hold.
 */
function globalBinDirFrom(entryPath: string | undefined): string | undefined {
  if (!entryPath) return undefined;
  const segments = entryPath.split(/[/\\]/);
  const idx = segments.indexOf('node_modules');
  if (idx < 1 || segments[idx - 1] !== 'lib') return undefined;
  const libDir = segments.slice(0, idx).join(path.sep);
  return path.join(path.dirname(libDir), 'bin');
}

/**
 * This module's own location, or `undefined` when it cannot be expressed as a
 * filesystem path. Resolved defensively because it is a default parameter of a
 * function called during startup, and no deployment shape is worth failing to
 * boot over — an unresolvable location drops the first shim candidate.
 */
function selfPath(): string | undefined {
  try {
    return fileURLToPath(import.meta.url);
  } catch {
    return undefined;
  }
}

/**
 * Characters a POSIX shell passes through unchanged inside a bare word. Every
 * ordinary install path is built from these, which is why quoting can stay
 * conditional below.
 */
const SHELL_SAFE_WORD = /^[A-Za-z0-9_@%+=:,./-]+$/;

/**
 * A path rendered so a POSIX shell parses it as a single word.
 *
 * The invocation is pasted into a shell, so a path holding whitespace (a home
 * directory with a space, a macOS runtime under a spaced folder) would otherwise
 * split into the wrong arguments. Quoting applies only when needed, so an
 * ordinary posix install path is emitted byte-identical.
 */
function shellWord(value: string): string {
  return SHELL_SAFE_WORD.test(value) ? value : `'${value.replace(/'/g, `'\\''`)}'`;
}

/**
 * The pinned `<node> <kici-admin>` invocation for a posix bare-metal unit, or
 * `undefined` when the shim cannot be located.
 *
 * Two candidates are tried in order:
 *
 *  1. `<npm global bin>/kici-admin`, derived from this module's location: right
 *     when npm's global prefix differs from node's (e.g.
 *     `npm config set prefix ~/.npm-global` with a system node).
 *  2. `<dirname(execPath)>/kici-admin`, right for version-manager layouts
 *     (mise / nvm / fnm) where the two prefixes coincide.
 *
 * Candidate 1 wins a tie: it belongs to the install this process runs from, and
 * a stale shim elsewhere must not be pinned over it.
 *
 * Global installs only, matching `resolveNpmInstallTarget`: a local install
 * keeps its shim in `node_modules/.bin`, never a candidate, so it gets
 * `undefined`. The dashboard then falls back to a PATH-resolved bare
 * `kici-admin`, which beats naming a path that is not there.
 *
 * Both halves are rendered as POSIX shell words.
 */
export function resolveAdminInvocation(
  execPath: string,
  entryPath: string | undefined,
  fileExists: (p: string) => boolean,
): string | undefined {
  const globalBin = globalBinDirFrom(entryPath);
  const candidates = [
    ...(globalBin ? [path.join(globalBin, 'kici-admin')] : []),
    path.join(path.dirname(execPath), 'kici-admin'),
  ];
  const hit = candidates.find((c) => fileExists(c));
  return hit ? `${shellWord(execPath)} ${shellWord(hit)}` : undefined;
}

/** The Windows launcher npm's cmd-shim writes; there is never a `kici-admin.exe`. */
const WINDOWS_ADMIN_LAUNCHER = 'kici-admin.cmd';

/**
 * The absolute path of the Windows `kici-admin.cmd` launcher, or `undefined`
 * when it cannot be located.
 *
 * Deliberately NOT built on {@link globalBinDirFrom}: npm lays a Windows global
 * install out as `<prefix>\node_modules\<pkg>` with no `lib` folder and links
 * the shims into `<prefix>`, not `<prefix>\bin`, so the posix helper would
 * return `undefined` for every real Windows install.
 *
 * Three candidate directories are tried in order:
 *
 *  1. The npm global prefix implied by this module's location, split on the
 *     FIRST `node_modules` segment as the posix helper does, so the shape nested
 *     under kici-admin resolves too. A prefix holding a `package.json` is
 *     REJECTED: npm's global prefix has none, so it marks a local project
 *     install, whose shim lives in `node_modules\.bin`; a same-named launcher in
 *     the project root must not be pinned.
 *  2. The light-package deploy directory (`<deployDir>\lib\<target>.cjs` beside
 *     `<deployDir>\kici-admin.cmd`), only when the entry's parent directory is
 *     named `lib`, so an unrelated bundle layout cannot pin whatever sits there.
 *  3. `dirname(execPath)`, when node and the launcher are co-located.
 *
 * Every path is built with `path.win32`, so the derivation is deterministic on a
 * posix test host.
 *
 * A candidate directory that is not absolute is skipped. The check has to be on
 * the DIRECTORY, not on the joined result: `path.win32.dirname('C:node.exe')`
 * is the drive-relative `'C:'` (meaning "the current directory of drive C:"),
 * and `path.win32.join('C:', 'kici-admin.cmd')` silently yields the ABSOLUTE
 * `'C:\kici-admin.cmd'` — a different location. Testing the join result would
 * therefore pass, having already lost the distinction.
 *
 * The returned path is RAW — never quoted or escaped. cmd.exe runs a
 * double-quoted path in command position while PowerShell only prints it, so
 * the same path must be written two different ways and only the reader knows
 * which shell it is rendering for.
 */
export function resolveWindowsAdminPath(
  execPath: string,
  entryPath: string | undefined,
  fileExists: (p: string) => boolean,
): string | undefined {
  const dirs: string[] = [];

  if (entryPath) {
    const segments = entryPath.split(/[/\\]/);
    const idx = segments.indexOf('node_modules');
    if (idx >= 1) {
      const prefix = segments.slice(0, idx).join(path.win32.sep);
      // A `package.json` beside `node_modules` means a local project install.
      if (path.win32.isAbsolute(prefix) && !fileExists(path.win32.join(prefix, 'package.json'))) {
        dirs.push(prefix);
      }
    }

    const entryDir = path.win32.dirname(entryPath.replace(/\//g, path.win32.sep));
    if (path.win32.basename(entryDir).toLowerCase() === 'lib') {
      dirs.push(path.win32.dirname(entryDir));
    }
  }

  dirs.push(path.win32.dirname(execPath));

  for (const dir of dirs) {
    if (!path.win32.isAbsolute(dir)) continue;
    const candidate = path.win32.join(dir, WINDOWS_ADMIN_LAUNCHER);
    if (fileExists(candidate)) return candidate;
  }
  return undefined;
}

/**
 * Read the orchestrator's deployment shape from the env the installer injects
 * (`KICI_DEPLOY_MODE` / `KICI_DEPLOY_CONTAINER` / `KICI_DEPLOY_CONTAINER_RUNTIME`).
 * Hand-run / dev orchestrators carry no `KICI_DEPLOY_*` env and report `unknown`.
 *
 * All three are trimmed: they arrive through an env file, where a hand edit or a
 * writer can attach a space or a newline, and the shape is still known —
 * degrading to `unknown` would drop the pinned invocation too.
 *
 * Container fields are kept only for `compose`. Posix bare-metal (`systemd` /
 * `launchd`) carries a pinned `<node> <kici-admin>` `adminInvocation`; `windows`
 * carries a raw, unquoted `adminPath` to `kici-admin.cmd`. Each is omitted when
 * its target cannot be located, so the reader falls back to a PATH-resolved
 * `kici-admin`. They never coexist: a shell command vs a bare path, because the
 * Windows shells cannot share one quoting.
 */
export function readDeploymentIdentity(
  env: NodeJS.ProcessEnv = process.env,
  execPath: string = process.execPath,
  entryPath: string | undefined = selfPath(),
  fileExists: (p: string) => boolean = fs.existsSync,
): DeploymentIdentity {
  const modeResult = DeploymentModeSchema.safeParse(env.KICI_DEPLOY_MODE?.trim());
  const mode = modeResult.success ? modeResult.data : 'unknown';

  if (mode === 'compose') {
    const identity: DeploymentIdentity = { mode };
    const containerName = env.KICI_DEPLOY_CONTAINER?.trim();
    if (containerName) identity.containerName = containerName;

    const runtimeResult = DeploymentContainerRuntimeSchema.safeParse(
      env.KICI_DEPLOY_CONTAINER_RUNTIME?.trim(),
    );
    if (runtimeResult.success) identity.containerRuntime = runtimeResult.data;

    return identity;
  }

  const identity: DeploymentIdentity = { mode };
  // Posix bare-metal: pin the admin CLI to the unit's own node so a copied
  // command runs under the pinned runtime, not whatever `node` the operator's
  // shell resolves. Invoking the shim *through* that node bypasses the shim's
  // `env node` PATH lookup.
  if (mode === 'systemd' || mode === 'launchd') {
    const invocation = resolveAdminInvocation(execPath, entryPath, fileExists);
    if (invocation) identity.adminInvocation = invocation;
  }
  // Windows reports the launcher path instead of a command: the `.cmd` shim
  // invokes node itself, so there is no `<node> <shim>` pair to pin, and the
  // quoting a pasted path needs differs between cmd.exe and PowerShell.
  if (mode === 'windows') {
    const adminPath = resolveWindowsAdminPath(execPath, entryPath, fileExists);
    if (adminPath) identity.adminPath = adminPath;
  }
  return identity;
}

/**
 * Where this orchestrator's own configuration lives on its host.
 *
 * `envFile` and `composeFile` come from the env the installer injects
 * (`KICI_DEPLOY_CONFIG_FILE` / `KICI_DEPLOY_COMPOSE_FILE`), because a running
 * process cannot derive either: systemd's `EnvironmentFile=` delivers the
 * variables and not the filename, and a compose container never sees the host
 * path at all. `scalerConfig` needs no stamp — the orchestrator already holds
 * it in its own config — so every orchestrator reports it, including hand-run
 * ones and installs that predate the stamp.
 *
 * Values are trimmed for the reason `readDeploymentIdentity` gives: a known
 * path carrying a stray space from an env file is still a known path.
 *
 * No path is checked for existence. On bare metal such a check would pass; in
 * a compose container it would fail for every path, because these are HOST
 * paths the container cannot see — blanking the value for exactly the
 * deployment shape that needs it most.
 *
 * Standalone rather than a branch of `readDeploymentIdentity`, which returns
 * early for `compose`.
 */
export function readConfigPaths(
  env: NodeJS.ProcessEnv = process.env,
  scaler: { scalerConfigPath?: string; scalerConfigDir?: string } = {},
): ConfigPaths {
  const paths: ConfigPaths = {};

  const envFile = env.KICI_DEPLOY_CONFIG_FILE?.trim();
  if (envFile) paths.envFile = envFile;

  const scalerConfig = scaler.scalerConfigPath?.trim() || scaler.scalerConfigDir?.trim();
  if (scalerConfig) paths.scalerConfig = scalerConfig;

  const composeFile = env.KICI_DEPLOY_COMPOSE_FILE?.trim();
  if (composeFile) paths.composeFile = composeFile;

  return paths;
}
