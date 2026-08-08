import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { describe, it, expect } from 'vitest';
import {
  readDeploymentIdentity,
  resolveAdminInvocation,
  resolveWindowsAdminPath,
} from './deployment-identity.js';

/** Treat every candidate path as present — these cases assert the derivation, not the stat. */
const anyPathExists = () => true;

/** A version-manager node install, where the shim sits beside the binary. */
const NODE = '/home/u/.local/share/mise/installs/node/24.15.0/bin/node';

describe('readDeploymentIdentity', () => {
  it('reads a compose deployment with container name + runtime', () => {
    const id = readDeploymentIdentity({
      KICI_DEPLOY_MODE: 'compose',
      KICI_DEPLOY_CONTAINER: 'kici-orchestrator',
      KICI_DEPLOY_CONTAINER_RUNTIME: 'podman',
    });
    expect(id).toEqual({
      mode: 'compose',
      containerName: 'kici-orchestrator',
      containerRuntime: 'podman',
    });
  });

  it('reads a systemd deployment and drops container fields even if present', () => {
    const id = readDeploymentIdentity(
      {
        KICI_DEPLOY_MODE: 'systemd',
        KICI_DEPLOY_CONTAINER: 'stray',
      },
      '/opt/node/bin/node',
      undefined,
      anyPathExists,
    );
    expect(id).toEqual({
      mode: 'systemd',
      adminInvocation: '/opt/node/bin/node /opt/node/bin/kici-admin',
    });
  });

  it('returns unknown when KICI_DEPLOY_MODE is unset', () => {
    expect(readDeploymentIdentity({})).toEqual({ mode: 'unknown' });
  });

  it('returns unknown for an unrecognised mode', () => {
    expect(readDeploymentIdentity({ KICI_DEPLOY_MODE: 'k8s' })).toEqual({ mode: 'unknown' });
  });

  it('defaults compose runtime to undefined when unset', () => {
    const id = readDeploymentIdentity({
      KICI_DEPLOY_MODE: 'compose',
      KICI_DEPLOY_CONTAINER: 'c1',
    });
    expect(id).toEqual({ mode: 'compose', containerName: 'c1' });
  });

  it('reads a mode surrounded by whitespace', () => {
    // A hand-edited env file, or one written by a tool that does not strip the
    // trailing byte, hands the value over with the whitespace attached. The
    // shape is known, so reporting `unknown` (and dropping the pinned
    // invocation with it) would throw away an answer we have.
    expect(
      readDeploymentIdentity({ KICI_DEPLOY_MODE: 'systemd ' }, NODE, undefined, anyPathExists),
    ).toEqual({
      mode: 'systemd',
      adminInvocation: `${NODE} /home/u/.local/share/mise/installs/node/24.15.0/bin/kici-admin`,
    });
  });

  it('reads a mode carrying a trailing newline', () => {
    expect(
      readDeploymentIdentity({ KICI_DEPLOY_MODE: 'compose\n', KICI_DEPLOY_CONTAINER: 'c1' }),
    ).toEqual({ mode: 'compose', containerName: 'c1' });
  });

  it('reads a container name surrounded by whitespace', () => {
    expect(
      readDeploymentIdentity({ KICI_DEPLOY_MODE: 'compose', KICI_DEPLOY_CONTAINER: ' c1 ' }),
    ).toEqual({ mode: 'compose', containerName: 'c1' });
  });

  it('reads a compose runtime surrounded by whitespace', () => {
    const id = readDeploymentIdentity({
      KICI_DEPLOY_MODE: 'compose',
      KICI_DEPLOY_CONTAINER: 'c1',
      KICI_DEPLOY_CONTAINER_RUNTIME: ' docker ',
    });
    expect(id).toEqual({ mode: 'compose', containerName: 'c1', containerRuntime: 'docker' });
  });

  it('still reports unknown for a blank or unrecognised mode after trimming', () => {
    // Trimming widens what is accepted; it must not turn a value that is not a
    // mode into one. A whitespace-only value trims to the empty string, which
    // is not a member of the enum.
    expect(readDeploymentIdentity({ KICI_DEPLOY_MODE: '   ' })).toEqual({ mode: 'unknown' });
    expect(readDeploymentIdentity({ KICI_DEPLOY_MODE: ' k8s ' })).toEqual({ mode: 'unknown' });
  });

  it('still omits a compose runtime that is blank or unrecognised after trimming', () => {
    expect(
      readDeploymentIdentity({
        KICI_DEPLOY_MODE: 'compose',
        KICI_DEPLOY_CONTAINER: 'c1',
        KICI_DEPLOY_CONTAINER_RUNTIME: '   ',
      }),
    ).toEqual({ mode: 'compose', containerName: 'c1' });
    expect(
      readDeploymentIdentity({
        KICI_DEPLOY_MODE: 'compose',
        KICI_DEPLOY_CONTAINER: 'c1',
        KICI_DEPLOY_CONTAINER_RUNTIME: ' containerd ',
      }),
    ).toEqual({ mode: 'compose', containerName: 'c1' });
  });

  it('reports a pinned admin invocation for systemd bare-metal', () => {
    expect(
      readDeploymentIdentity({ KICI_DEPLOY_MODE: 'systemd' }, NODE, undefined, anyPathExists),
    ).toEqual({
      mode: 'systemd',
      adminInvocation: `${NODE} /home/u/.local/share/mise/installs/node/24.15.0/bin/kici-admin`,
    });
  });

  it('reports a pinned admin invocation for launchd bare-metal', () => {
    expect(
      readDeploymentIdentity({ KICI_DEPLOY_MODE: 'launchd' }, NODE, undefined, anyPathExists)
        .adminInvocation,
    ).toBe(`${NODE} /home/u/.local/share/mise/installs/node/24.15.0/bin/kici-admin`);
  });

  it('omits adminInvocation for compose and unknown', () => {
    expect(
      readDeploymentIdentity({ KICI_DEPLOY_MODE: 'compose' }, NODE).adminInvocation,
    ).toBeUndefined();
    expect(readDeploymentIdentity({}, NODE).adminInvocation).toBeUndefined();
  });
});

describe('resolveAdminInvocation', () => {
  const NODE_BIN = '/usr/bin/node';
  const GLOBAL_ENTRY =
    '/home/u/.npm-global/lib/node_modules/@kici-dev/orchestrator/dist/deployment/deployment-identity.js';
  const GLOBAL_SHIM = '/home/u/.npm-global/bin/kici-admin';
  const SIBLING_SHIM = '/usr/bin/kici-admin';

  it('prefers the npm global bin derived from the entry path', () => {
    // The split-prefix case: npm prefix is ~/.npm-global, node is /usr/bin/node.
    // Only the global-bin candidate exists, and it is the correct one.
    expect(resolveAdminInvocation(NODE_BIN, GLOBAL_ENTRY, (p) => p === GLOBAL_SHIM)).toBe(
      `${NODE_BIN} ${GLOBAL_SHIM}`,
    );
  });

  it('prefers the global bin over the execPath sibling when both exist', () => {
    // A stale /usr/bin/kici-admin must not win over the shim belonging to the
    // install this process is actually running from.
    expect(resolveAdminInvocation(NODE_BIN, GLOBAL_ENTRY, () => true)).toBe(
      `${NODE_BIN} ${GLOBAL_SHIM}`,
    );
  });

  it('derives the global bin through kici-admin nested node_modules', () => {
    // The nested install shape. Splitting on the FIRST node_modules segment
    // must still yield <prefix>/bin, not <prefix>/lib/node_modules/kici-admin/bin.
    const nested =
      '/home/u/.npm-global/lib/node_modules/kici-admin/node_modules/@kici-dev/orchestrator/dist/deployment/deployment-identity.js';
    expect(resolveAdminInvocation(NODE_BIN, nested, (p) => p === GLOBAL_SHIM)).toBe(
      `${NODE_BIN} ${GLOBAL_SHIM}`,
    );
  });

  it('falls back to the execPath sibling when the global candidate is absent', () => {
    expect(resolveAdminInvocation(NODE_BIN, GLOBAL_ENTRY, (p) => p === SIBLING_SHIM)).toBe(
      `${NODE_BIN} ${SIBLING_SHIM}`,
    );
  });

  it('ignores a node_modules tree that is not a posix global install', () => {
    // A local install under /srv/kici, a pnpm global store, or a container
    // image root: the segment before node_modules is not `lib`, so no bin
    // directory is derived and a same-named binary there cannot be pinned.
    const local = '/srv/kici/node_modules/@kici-dev/orchestrator/dist/server.js';
    expect(resolveAdminInvocation(NODE_BIN, local, (p) => p === '/srv/bin/kici-admin')).toBe(
      undefined,
    );
    expect(resolveAdminInvocation(NODE_BIN, local, () => true)).toBe(`${NODE_BIN} ${SIBLING_SHIM}`);
  });

  it('falls back to the execPath sibling when the entry path is not derivable', () => {
    // A dev checkout or a bundled standalone: no node_modules segment.
    expect(resolveAdminInvocation(NODE_BIN, '/srv/build/server.js', () => true)).toBe(
      `${NODE_BIN} ${SIBLING_SHIM}`,
    );
  });

  it('handles an undefined entry path', () => {
    expect(resolveAdminInvocation(NODE_BIN, undefined, () => true)).toBe(
      `${NODE_BIN} ${SIBLING_SHIM}`,
    );
  });

  it('returns undefined when no candidate exists', () => {
    expect(resolveAdminInvocation(NODE_BIN, GLOBAL_ENTRY, () => false)).toBeUndefined();
  });

  it('leaves an ordinary install path unquoted', () => {
    // Quoting is conditional so the common case reads (and parses) exactly as
    // before — the field is consumed as a display string by the dashboard and
    // parsed by the diagnostics E2E.
    expect(resolveAdminInvocation(NODE_BIN, GLOBAL_ENTRY, (p) => p === GLOBAL_SHIM)).toBe(
      `${NODE_BIN} ${GLOBAL_SHIM}`,
    );
  });

  it('quotes a node path holding whitespace', () => {
    // Without quoting the pasted command splits into `/opt/my`, `node/bin/node`
    // and never reaches the shim.
    expect(resolveAdminInvocation('/opt/my node/bin/node', undefined, () => true)).toBe(
      `'/opt/my node/bin/node' '/opt/my node/bin/kici-admin'`,
    );
  });

  it('quotes a shim path holding whitespace', () => {
    const shim = '/home/jane doe/.npm-global/bin/kici-admin';
    const entry =
      '/home/jane doe/.npm-global/lib/node_modules/@kici-dev/orchestrator/dist/deployment/deployment-identity.js';
    expect(resolveAdminInvocation(NODE_BIN, entry, (p) => p === shim)).toBe(
      `${NODE_BIN} '${shim}'`,
    );
  });

  it('escapes an embedded single quote rather than terminating the quote', () => {
    const shim = "/home/o'brien/.npm-global/bin/kici-admin";
    const entry =
      "/home/o'brien/.npm-global/lib/node_modules/@kici-dev/orchestrator/dist/deployment/deployment-identity.js";
    // `'` closes the quote, `\'` supplies a literal one, `'` reopens it — the
    // POSIX idiom this repo uses everywhere it renders a pasteable command.
    expect(resolveAdminInvocation(NODE_BIN, entry, (p) => p === shim)).toBe(
      `${NODE_BIN} '/home/o'\\''brien/.npm-global/bin/kici-admin'`,
    );
  });
});

describe('resolveWindowsAdminPath', () => {
  const NODE = 'C:\\Program Files\\nodejs\\node.exe';
  // npm's Windows global layout: `<prefix>\node_modules\<pkg>` with NO `lib`
  // segment, and the shims linked directly into `<prefix>` (not `<prefix>\bin`).
  const NPM_ENTRY =
    'C:\\Users\\jane\\AppData\\Roaming\\npm\\node_modules\\@kici-dev\\orchestrator\\dist\\deployment\\deployment-identity.js';
  const NPM_LAUNCHER = 'C:\\Users\\jane\\AppData\\Roaming\\npm\\kici-admin.cmd';
  // The light-package deploy shape: `<deployDir>\lib\<target>.cjs` beside
  // `<deployDir>\kici-admin.cmd`.
  const LIGHT_ENTRY = 'C:\\Temp\\kici-deploy\\lib\\kici-orchestrator-standalone.cjs';
  const LIGHT_LAUNCHER = 'C:\\Temp\\kici-deploy\\kici-admin.cmd';
  const SIBLING_LAUNCHER = 'C:\\Program Files\\nodejs\\kici-admin.cmd';

  it('derives the npm global prefix launcher from the entry path', () => {
    expect(resolveWindowsAdminPath(NODE, NPM_ENTRY, (p) => p === NPM_LAUNCHER)).toBe(NPM_LAUNCHER);
  });

  it('derives the light-package deploy dir from a lib parent segment', () => {
    expect(resolveWindowsAdminPath(NODE, LIGHT_ENTRY, (p) => p === LIGHT_LAUNCHER)).toBe(
      LIGHT_LAUNCHER,
    );
  });

  it('falls back to the execPath sibling when no derived candidate exists', () => {
    expect(resolveWindowsAdminPath(NODE, LIGHT_ENTRY, (p) => p === SIBLING_LAUNCHER)).toBe(
      SIBLING_LAUNCHER,
    );
  });

  it('rejects a local install, identified by a package.json beside node_modules', () => {
    // `C:\srv\kici\node_modules\@kici-dev\orchestrator\…` is a LOCAL install:
    // its shim lives in `node_modules\.bin`, never in `C:\srv\kici`, and a
    // same-named launcher sitting there must not be pinned. npm's own global
    // prefix carries no `package.json`, which is what tells the two apart.
    const local = 'C:\\srv\\kici\\node_modules\\@kici-dev\\orchestrator\\dist\\server.js';
    const projectLauncher = 'C:\\srv\\kici\\kici-admin.cmd';
    expect(
      resolveWindowsAdminPath(
        NODE,
        local,
        (p) => p === projectLauncher || p === 'C:\\srv\\kici\\package.json',
      ),
    ).toBeUndefined();
  });

  it('rejects a non-lib parent segment for the light-package candidate', () => {
    // Only `<deployDir>\lib\<entry>` is the light-package shape. A bundle under
    // `<dir>\build\` would otherwise derive `<dir>` and pin whatever sits there.
    const notLib = 'C:\\Temp\\kici-deploy\\build\\kici-orchestrator-standalone.cjs';
    expect(resolveWindowsAdminPath(NODE, notLib, (p) => p === LIGHT_LAUNCHER)).toBeUndefined();
  });

  it('rejects a drive-relative candidate directory', () => {
    // `path.win32.dirname('C:node.exe')` is the drive-relative `'C:'` — "the
    // current directory of drive C:", which is not knowable from here. Joining
    // it does NOT preserve that: `path.win32.join('C:', 'kici-admin.cmd')`
    // yields the ABSOLUTE `'C:\kici-admin.cmd'` (node v24), a different
    // location. So the resolver has to reject the DIRECTORY; a check on the
    // joined path would pass and pin the root of C:.
    expect(resolveWindowsAdminPath('C:node.exe', undefined, () => true)).toBeUndefined();
    // The premise, asserted so a future node changing `join` fails here loudly
    // rather than silently re-opening the hole.
    expect(path.win32.isAbsolute('C:')).toBe(false);
    expect(path.win32.join('C:', 'kici-admin.cmd')).toBe('C:\\kici-admin.cmd');
  });

  it('returns undefined when no launcher is on disk', () => {
    expect(resolveWindowsAdminPath(NODE, NPM_ENTRY, () => false)).toBeUndefined();
  });

  it('handles an undefined entry path', () => {
    expect(resolveWindowsAdminPath(NODE, undefined, () => true)).toBe(SIBLING_LAUNCHER);
  });

  it('returns a raw, unquoted path even when it holds whitespace', () => {
    // The producer must never quote: cmd.exe and PowerShell need the same path
    // written two different ways, so only the renderer can choose.
    const result = resolveWindowsAdminPath(NODE, undefined, () => true);
    expect(result).toBe('C:\\Program Files\\nodejs\\kici-admin.cmd');
    expect(result).not.toContain('"');
    expect(result).not.toContain("'");
  });
});

describe('readDeploymentIdentity windows admin path', () => {
  const NODE = 'C:\\Program Files\\nodejs\\node.exe';

  it('reports adminPath for windows and leaves adminInvocation unset', () => {
    // Everything Windows rides `adminPath`; `adminInvocation` keeps its posix
    // bare-metal meaning for every mode, unchanged.
    const id = readDeploymentIdentity({ KICI_DEPLOY_MODE: 'windows' }, NODE, undefined, () => true);
    expect(id).toEqual({
      mode: 'windows',
      adminPath: 'C:\\Program Files\\nodejs\\kici-admin.cmd',
    });
    expect(id.adminInvocation).toBeUndefined();
  });

  it('omits adminPath for windows when no launcher can be located', () => {
    const id = readDeploymentIdentity(
      { KICI_DEPLOY_MODE: 'windows' },
      NODE,
      undefined,
      () => false,
    );
    expect(id).toEqual({ mode: 'windows' });
  });

  it('omits adminPath for every non-windows mode', () => {
    for (const mode of ['systemd', 'launchd', 'compose', 'k8s']) {
      expect(
        readDeploymentIdentity({ KICI_DEPLOY_MODE: mode }, NODE, undefined, anyPathExists)
          .adminPath,
      ).toBeUndefined();
    }
  });
});

describe('readDeploymentIdentity admin-invocation resolution', () => {
  it('omits adminInvocation entirely when no shim can be located', () => {
    // The dashboard then falls back to a PATH-resolved bare `kici-admin`,
    // which is correct when we cannot locate the shim.
    const id = readDeploymentIdentity(
      { KICI_DEPLOY_MODE: 'systemd' },
      '/usr/bin/node',
      '/srv/build/server.js',
      () => false,
    );
    expect(id).toEqual({ mode: 'systemd' });
    expect(id.adminInvocation).toBeUndefined();
  });

  it('resolves a real split-prefix layout on disk with the default stat', () => {
    // The defect this guards, materialised on a real filesystem rather than a
    // stub: the npm global prefix holds the shim while the node install prefix
    // does not, so the sibling derivation names a file that is not there. The
    // default `fileExists` is exercised — no stub — so the wiring is covered
    // too, not just the pure resolver.
    const root = mkdtempSync(path.join(tmpdir(), 'kici-admin-shim-'));
    try {
      const prefix = path.join(root, 'npm-global');
      const entry = path.join(
        prefix,
        'lib/node_modules/@kici-dev/orchestrator/dist/deployment/deployment-identity.js',
      );
      const shim = path.join(prefix, 'bin/kici-admin');
      mkdirSync(path.dirname(entry), { recursive: true });
      mkdirSync(path.dirname(shim), { recursive: true });
      writeFileSync(entry, '');
      writeFileSync(shim, '');

      // A node install prefix that genuinely carries no kici-admin sibling.
      const nodeBin = path.join(root, 'node/bin/node');
      mkdirSync(path.dirname(nodeBin), { recursive: true });
      writeFileSync(nodeBin, '');
      expect(existsSync(path.join(root, 'node/bin/kici-admin'))).toBe(false);

      const id = readDeploymentIdentity({ KICI_DEPLOY_MODE: 'systemd' }, nodeBin, entry);
      expect(id.adminInvocation).toBe(`${nodeBin} ${shim}`);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
