import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { Command } from 'commander';
import { registerDebugBundleCommand } from './debug-bundle.js';
import type { AdminApiClient, FleetTopologyResponse } from '../api-client.js';

const topology: FleetTopologyResponse = {
  nodes: [
    { kind: 'orchestrator', id: 'coord-a', role: 'coordinator', labels: {}, parentId: null },
    { kind: 'agent', id: 'a1', labels: {}, parentId: 'coord-a' },
    { kind: 'agent', id: 'a2', labels: {}, parentId: 'coord-a' },
  ],
};

function makeClient(overrides: Partial<AdminApiClient> = {}): AdminApiClient {
  return {
    getFleetTopology: vi.fn(async () => topology),
    downloadFleetBundle: vi.fn(async (_body, outPath: string) => {
      fs.writeFileSync(outPath, Buffer.from('PKbundle'));
    }),
    ...overrides,
  } as unknown as AdminApiClient;
}

async function runDebugBundle(client: AdminApiClient, args: string[]): Promise<void> {
  const program = new Command();
  program.exitOverride();
  registerDebugBundleCommand(program, () => client);
  await program.parseAsync(['node', 'kici-admin', 'debug-bundle', ...args]);
}

describe('debug-bundle --fleet', () => {
  let logSpy: ReturnType<typeof vi.spyOn>;
  let tmpDir: string;

  beforeEach(() => {
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fleet-cli-'));
  });
  afterEach(() => {
    logSpy.mockRestore();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('--fleet --list --json prints the topology and does NOT download', async () => {
    const client = makeClient();
    await runDebugBundle(client, ['--fleet', '--list', '--json']);
    expect(client.getFleetTopology).toHaveBeenCalledTimes(1);
    expect(client.downloadFleetBundle).not.toHaveBeenCalled();
    const printed = logSpy.mock.calls.map((c) => String(c[0])).join('\n');
    expect(JSON.parse(printed)).toEqual(topology);
  });

  it('--fleet --pick a1,a2 passes the split selectors to downloadFleetBundle', async () => {
    const client = makeClient();
    const out = path.join(tmpDir, 'fleet.zip');
    await runDebugBundle(client, ['--fleet', '--pick', 'a1,a2', '-o', out]);
    expect(client.downloadFleetBundle).toHaveBeenCalledWith(
      expect.objectContaining({ selectors: ['a1', 'a2'] }),
      out,
    );
  });

  it('--fleet with no --pick collects everything (empty selectors)', async () => {
    const client = makeClient();
    const out = path.join(tmpDir, 'fleet-all.zip');
    await runDebugBundle(client, ['--fleet', '-o', out]);
    expect(client.downloadFleetBundle).toHaveBeenCalledWith(
      expect.objectContaining({ selectors: [] }),
      out,
    );
    expect(fs.existsSync(out)).toBe(true);
  });

  it('--fleet --fleet-timeout 30 forwards the timeout', async () => {
    const client = makeClient();
    const out = path.join(tmpDir, 'fleet-t.zip');
    await runDebugBundle(client, ['--fleet', '--fleet-timeout', '30', '-o', out]);
    expect(client.downloadFleetBundle).toHaveBeenCalledWith(
      expect.objectContaining({ timeoutSeconds: 30 }),
      out,
    );
  });

  it('without --fleet does not touch the fleet endpoints (local path)', async () => {
    // A minimal client that fails any fleet call — the local path must not call them.
    const client = makeClient({
      getFleetTopology: vi.fn(async () => {
        throw new Error('should not be called');
      }) as unknown as AdminApiClient['getFleetTopology'],
    });
    // The local path calls diagnose()/configExport() etc; stub them to no-op.
    Object.assign(client, {
      diagnose: vi.fn(async () => ({})),
      configExport: vi.fn(async () => ({})),
      get: vi.fn(async () => ({})),
      getText: vi.fn(async () => ''),
    });
    const out = path.join(tmpDir, 'local.zip');
    await runDebugBundle(client, ['-o', out]);
    expect(client.getFleetTopology).not.toHaveBeenCalled();
    expect(client.downloadFleetBundle).not.toHaveBeenCalled();
  });
});
