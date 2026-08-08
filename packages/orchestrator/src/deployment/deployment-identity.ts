import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  DeploymentModeSchema,
  DeploymentContainerRuntimeSchema,
  type DeploymentIdentity,
} from '@kici-dev/engine';

/**
 * The npm global bin directory implied by a path inside a global install, or
 * `undefined` when the path is not inside one.
 *
 * npm lays a posix global install out as `<prefix>/lib/node_modules/<pkg>/…`, so
 * the bin directory is `<prefix>/bin`. The split is on the FIRST `node_modules`
 * segment, matching `resolveNpmInstallTarget`'s convention, because the
 * orchestrator has two install shapes: standalone, and loaded through
 * kici-admin's own nested `node_modules`. Splitting on the first segment yields
 * `<prefix>/lib` for both; splitting on the last would yield
 * `<prefix>/lib/node_modules/kici-admin` for the nested shape and derive a bin
 * directory that does not exist.
 *
 * The preceding segment must be `lib`, which is what distinguishes a global
 * install from a local `node_modules` tree, a pnpm global store, or a container
 * image root. Without that check a local install under `/srv/kici` would derive
 * `/srv/bin` and a same-named binary sitting there would be pinned wrongly —
 * the very class of wrong-path answer this resolver exists to prevent. Only
 * `systemd` / `launchd` reach this code, so the posix layout is the only one
 * that has to hold.
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
 * boot over — an unresolvable location simply drops the first shim candidate.
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
 * The invocation this module builds exists to be pasted into a shell, so a node
 * or shim path holding whitespace (a home directory with a space, a macOS
 * runtime under a spaced folder) otherwise splits into the wrong arguments and
 * the pasted command fails. Quoting is applied only when the path needs it:
 * every ordinary posix install path is a safe word, so the emitted string stays
 * byte-identical for them.
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
 *  1. `<npm global bin>/kici-admin`, derived from where this module itself
 *     lives. This is the correct answer when npm's global prefix differs from
 *     the node install prefix — e.g. an operator who set
 *     `npm config set prefix ~/.npm-global` while running a system node.
 *  2. `<dirname(execPath)>/kici-admin`, correct for version-manager layouts
 *     (mise / nvm / fnm) where the two prefixes coincide.
 *
 * Candidate 1 wins a tie because it is the shim belonging to the install this
 * process is actually running from; a stale shim elsewhere on the system must
 * not be pinned in preference to it.
 *
 * Global installs only, matching `resolveNpmInstallTarget`'s scope: an
 * orchestrator installed locally into a project's own `node_modules` keeps its
 * shim in `node_modules/.bin`, which is never a candidate, so it resolves to
 * `undefined` and gets the bare form.
 *
 * Returning `undefined` is deliberate: the dashboard falls back to a
 * PATH-resolved bare `kici-admin`, which beats naming a path that is not there.
 *
 * Both halves are rendered as POSIX shell words, so the pair survives a path
 * that holds whitespace when the operator pastes it.
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
 * install out as `<prefix>\node_modules\<pkg>` with no `lib` folder, and links
 * the shims directly into `<prefix>` rather than `<prefix>\bin`. The posix
 * helper requires a `lib` segment, so it returns `undefined` for every real
 * Windows install — reusing it would ship a resolver that can never fire.
 *
 * Three candidate directories are tried in order:
 *
 *  1. The npm global prefix implied by this module's own location, split on the
 *     FIRST `node_modules` segment (matching the posix helper's convention, so
 *     the nested-under-kici-admin install shape resolves too). A prefix holding
 *     a `package.json` is REJECTED: that is a local project install, whose shim
 *     lives in `node_modules\.bin`, and a same-named launcher sitting in the
 *     project root must not be pinned. npm's own global prefix carries no
 *     `package.json`, which is what distinguishes the two.
 *  2. The light-package deploy directory, which lays out
 *     `<deployDir>\lib\<target>.cjs` beside `<deployDir>\kici-admin.cmd`. Gated
 *     on the entry's parent directory actually being named `lib` so an
 *     unrelated bundle layout cannot derive a directory and pin whatever
 *     happens to sit there.
 *  3. `dirname(execPath)`, for the case where node and the launcher are
 *     co-located.
 *
 * Every path is built with `path.win32`, so the derivation is deterministic
 * when this runs on a posix test host rather than depending on the ambient
 * separator.
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
 * Surrounding whitespace is stripped from all three before they are read: the
 * values reach the process through an env file, where a hand edit or a writer
 * that leaves the trailing byte on can attach a space or a newline. The shape
 * is known in that case, so degrading the whole identity to `unknown` — and
 * dropping the pinned invocation with it — would discard an answer we have.
 * Container fields are kept only for the `compose` mode. For posix bare-metal
 * (`systemd` / `launchd`) the identity carries a pinned `<node> <kici-admin>`
 * `adminInvocation` when the shim can be located on disk; for `windows` it
 * instead carries a raw, unquoted `adminPath` naming the `kici-admin.cmd`
 * launcher. Each is omitted when its target cannot be located, so the reader
 * falls back to a PATH-resolved `kici-admin`. The two never coexist: they are
 * different kinds of value (a shell command vs a bare path) because the Windows
 * shells cannot share one quoting.
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
