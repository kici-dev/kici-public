import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ScalerBackendType } from '@kici-dev/engine';
import {
  agentBinaryFromEntry,
  agentBinaryFromLaunch,
  bareMetalAgentBinaryHint,
  bareMetalVersionManagerErrors,
  versionManagerExecutable,
} from './agent-binary-location.js';
import type { ScalerEntry } from './types.js';

describe('agentBinaryFromEntry', () => {
  it('maps a POSIX global kici-admin install to <prefix>/bin/kici-agent', () => {
    // fails-when: the bin is derived from the node binary's folder instead of
    // the npm prefix — a system node in /usr/bin with prefix /usr/local would
    // name /usr/bin/kici-agent, which npm never writes.
    expect(
      agentBinaryFromEntry(
        '/usr/local/lib/node_modules/kici-admin/node_modules/@kici-dev/orchestrator/dist/server.js',
        false,
      ),
    ).toBe('/usr/local/bin/kici-agent');
    expect(
      agentBinaryFromEntry(
        '/home/u/.local/share/mise/installs/node/24.15.0/lib/node_modules/kici-admin/node_modules/@kici-dev/orchestrator/dist/server.js',
        false,
      ),
    ).toBe('/home/u/.local/share/mise/installs/node/24.15.0/bin/kici-agent');
  });

  it('maps a Windows global install to <prefix>\\kici-agent.cmd', () => {
    expect(
      agentBinaryFromEntry(
        'C:\\Users\\u\\AppData\\Roaming\\npm\\node_modules\\kici-admin\\node_modules\\@kici-dev\\orchestrator\\dist\\server.js',
        true,
      ),
    ).toBe('C:\\Users\\u\\AppData\\Roaming\\npm\\kici-agent.cmd');
  });

  it('maps a POSIX local install to node_modules/.bin', () => {
    expect(agentBinaryFromEntry('/opt/k/node_modules/kici-admin/dist/x.js', false)).toBe(
      '/opt/k/node_modules/.bin/kici-agent',
    );
  });

  it('returns null outside a kici-admin install', () => {
    // breaks-if-wrong: a standalone @kici-dev/orchestrator install ships no
    // kici-agent bin, so naming one would send the operator to a missing file.
    expect(
      agentBinaryFromEntry('/usr/lib/node_modules/@kici-dev/orchestrator/dist/server.js', false),
    ).toBeNull();
    expect(
      agentBinaryFromEntry('/opt/kici/orchestrator/kici-orchestrator-standalone', false),
    ).toBeNull();
  });

  it('reads the entry script among the launch tokens', () => {
    expect(
      agentBinaryFromLaunch(
        {
          execPath: '/n/24.15.0/bin/node',
          args: [
            '/n/24.15.0/lib/node_modules/kici-admin/node_modules/@kici-dev/orchestrator/dist/server.js',
          ],
        },
        false,
      ),
    ).toBe('/n/24.15.0/bin/kici-agent');
  });
});

describe('bareMetalAgentBinaryHint', () => {
  let tmp: string;
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kici-agent-hint-'));
  });
  afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

  /** A runtime prefix with node and an installed kici-admin, as npm lays it out. */
  function runtime(name: string): { node: string; entry: string; agent: string } {
    const prefix = path.join(tmp, name);
    const pkg = path.join(prefix, 'lib', 'node_modules', 'kici-admin');
    fs.mkdirSync(path.join(pkg, 'bin'), { recursive: true });
    fs.mkdirSync(path.join(prefix, 'bin'), { recursive: true });
    fs.writeFileSync(path.join(pkg, 'bin', 'kici-agent.js'), '#!/usr/bin/env node\n', {
      mode: 0o755,
    });
    const agent = path.join(prefix, 'bin', 'kici-agent');
    fs.symlinkSync(path.join(pkg, 'bin', 'kici-agent.js'), agent);
    fs.writeFileSync(path.join(prefix, 'bin', 'node'), '', { mode: 0o755 });
    return {
      node: path.join(prefix, 'bin', 'node'),
      entry: path.join(pkg, 'node_modules', '@kici-dev', 'orchestrator', 'dist', 'server.js'),
      agent,
    };
  }

  function bareMetal(binaryPath: string): ScalerEntry[] {
    return [
      {
        name: 'bm',
        type: ScalerBackendType.enum['bare-metal'],
        labelSets: [{ labels: ['linux'], binaryPath }],
      } as unknown as ScalerEntry,
    ];
  }

  it('names the agent installed with the running runtime when binaryPath is missing', () => {
    const rt = runtime('24.15.0');
    // fails-when: the hint is not built, or names the missing path itself.
    expect(
      bareMetalAgentBinaryHint(bareMetal(path.join(tmp, '24', 'bin', 'kici-agent')), {
        entryPath: rt.entry,
        execPath: rt.node,
        windows: false,
      }),
    ).toBe(
      `Hint: the kici-agent installed with this orchestrator's runtime is ${rt.agent}. ` +
        'Set the bare-metal binaryPath to that path in the scaler config, then restart the orchestrator.',
    );
  });

  it('falls back to kici-agent beside the node binary', () => {
    const rt = runtime('24.15.0');
    expect(
      bareMetalAgentBinaryHint(bareMetal('/nowhere/kici-agent'), {
        entryPath: undefined,
        execPath: rt.node,
        windows: false,
      }),
    ).toContain(rt.agent);
  });

  it('stays silent when every binaryPath is executable', () => {
    const rt = runtime('24.15.0');
    // breaks-if-wrong: a healthy config must not grow a hint.
    expect(
      bareMetalAgentBinaryHint(bareMetal(rt.agent), {
        entryPath: rt.entry,
        execPath: rt.node,
        windows: false,
      }),
    ).toBeNull();
  });

  it('names the installed agent when binaryPath is a version-manager shim', () => {
    const rt = runtime('24.15.0');
    // mise's layout: every shim in its shims folder links to the mise executable.
    const miseDir = path.join(tmp, 'mise');
    fs.mkdirSync(path.join(miseDir, 'shims'), { recursive: true });
    fs.writeFileSync(path.join(miseDir, 'mise'), '#!/bin/sh\n', { mode: 0o755 });
    const shim = path.join(miseDir, 'shims', 'kici-agent');
    fs.symlinkSync(path.join(miseDir, 'mise'), shim);
    // fails-when: the hint only looks at the executable bit, which the shim passes.
    expect(
      bareMetalAgentBinaryHint(bareMetal(shim), {
        entryPath: rt.entry,
        execPath: rt.node,
        windows: false,
      }),
    ).toContain(rt.agent);
  });

  it('stays silent when no agent is installed with the runtime', () => {
    expect(
      bareMetalAgentBinaryHint(bareMetal('/nowhere/kici-agent'), {
        entryPath: '/nowhere/lib/node_modules/kici-admin/dist/server.js',
        execPath: '/nowhere/bin/node',
        windows: false,
      }),
    ).toBeNull();
  });
});

describe('versionManagerExecutable', () => {
  let tmp: string;
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kici-vm-exe-'));
  });
  afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

  /** An executable file at `<tmp>/<rel>`. */
  function exe(rel: string): string {
    const file = path.join(tmp, rel);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, '#!/bin/sh\n', { mode: 0o755 });
    return file;
  }

  /** A symlink at `<tmp>/<rel>` to `target`. */
  function link(rel: string, target: string): string {
    const file = path.join(tmp, rel);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.symlinkSync(target, file);
    return file;
  }

  it.each([
    ['mise', 'mise', 'mise which kici-agent'],
    ['volta-shim', 'Volta', 'volta which kici-agent'],
    ['nodenv', 'nodenv', 'nodenv which kici-agent'],
    ['fnm', 'fnm', null],
  ])('detects a shim that links to the %s executable', (name, manager, which) => {
    const shim = link('shims-dir/kici-agent', exe(`vm/${name}`));
    // fails-when: the check reads the shim's own name, which is kici-agent.
    expect(versionManagerExecutable(shim)).toEqual({
      manager,
      realpath: fs.realpathSync(path.join(tmp, 'vm', name)),
      whichCommand: which,
    });
  });

  it('detects a script shim by its shims folder', () => {
    expect(versionManagerExecutable(exe('.nodenv/shims/kici-agent'))?.manager).toBe('nodenv');
    expect(versionManagerExecutable(exe('other/shims/kici-agent'))).toEqual(
      expect.objectContaining({ manager: null, whichCommand: null }),
    );
  });

  it('accepts an agent, an alias into a Node.js install and a wrapper link', () => {
    const agent = exe('mise/installs/node/24.15.0/lib/node_modules/kici-admin/bin/kici-agent.js');
    const pinned = link('mise/installs/node/24.15.0/bin/kici-agent', agent);
    const alias = link('mise/installs/node/24', path.join(tmp, 'mise/installs/node/24.15.0'));
    const wrapper = link('opt/kici-agent', exe('opt/real-agent'));
    // breaks-if-wrong: every one of these runs a real agent and must not be refused.
    expect(versionManagerExecutable(pinned)).toBeNull();
    expect(versionManagerExecutable(path.join(alias, 'bin', 'kici-agent'))).toBeNull();
    expect(versionManagerExecutable(wrapper)).toBeNull();
    expect(versionManagerExecutable(path.join(tmp, 'absent'))).toBeNull();
  });

  it('reports each bare-metal shim as a startup error, with the fix', () => {
    const shim = link('mise/shims/kici-agent', exe('bin/mise'));
    const agent = exe('agent/kici-agent');
    const entries = [
      {
        name: 'bm',
        type: ScalerBackendType.enum['bare-metal'],
        labelSets: [
          { labels: ['a'], binaryPath: shim },
          { labels: ['b'], binaryPath: agent },
        ],
      },
      {
        name: 'docker',
        type: ScalerBackendType.enum.container,
        labelSets: [{ labels: ['c'], binaryPath: shim }],
      },
    ] as unknown as ScalerEntry[];
    // fails-when: startup lets the shim through, so the orchestrator starts and no agent ever does.
    expect(bareMetalVersionManagerErrors(entries)).toEqual([
      `agent binary for bare-metal scaler "bm": binaryPath ${shim} is a version-manager shim ` +
        `(mise): it resolves to ${fs.realpathSync(path.join(tmp, 'bin', 'mise'))}, not to a ` +
        'kici-agent, so no agent can start. Set binaryPath to the path `mise which kici-agent` prints.',
    ]);
  });
});
