import { describe, it, expect, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { BundleChunkAssembler } from '@kici-dev/shared';
import type { AgentToOrchestratorMessage, FleetLogsRequest } from '@kici-dev/engine';
import { OrchestratorClient, type OrchestratorClientOptions } from './orchestrator-client.js';

function createClient(
  getFleetBundleInputs: OrchestratorClientOptions['getFleetBundleInputs'],
): OrchestratorClient {
  return new OrchestratorClient({
    url: 'ws://localhost:9999/ws/agent',
    agentId: 'fleet-agent-1',
    labels: ['linux'],
    onJobDispatch: vi.fn(),
    onJobCancel: vi.fn(),
    getFleetBundleInputs,
  });
}

const req: FleetLogsRequest = {
  type: 'fleet.logs.request',
  requestId: 'req-fleet-1',
  logWindowHours: 24,
  maxBytes: 50_000_000,
};

describe('OrchestratorClient.streamFleetBundle', () => {
  it('streams at least one chunk ending with isLast and reassembles to a ZIP', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-fleet-'));
    fs.writeFileSync(path.join(dir, 'kici-agent-y.log'), 'line\nerror x\n');

    const client = createClient(async () => ({
      config: { host: 'h', token: 'secret' },
      logDir: dir,
      metricsText: '# HELP kici_agent_up\nkici_agent_up 1\n',
    }));

    const sent: AgentToOrchestratorMessage[] = [];
    vi.spyOn(client, 'sendDirect').mockImplementation((m) => sent.push(m));

    await client.streamFleetBundle(req);

    const chunks = sent.filter((m) => m.type === 'fleet.bundle.chunk');
    expect(chunks.length).toBeGreaterThanOrEqual(1);
    expect(chunks.at(-1)).toMatchObject({ isLast: true, requestId: 'req-fleet-1' });
    expect(sent.some((m) => m.type === 'fleet.bundle.error')).toBe(false);

    const asm = new BundleChunkAssembler();
    let result: Buffer | undefined;
    for (const c of chunks) {
      if (c.type === 'fleet.bundle.chunk') {
        result = asm.accept(c.seq, c.dataB64, c.isLast) ?? result;
      }
    }
    expect(result).toBeDefined();
    expect(result!.subarray(0, 2).toString('ascii')).toBe('PK');
  });

  it('emits fleet.bundle.error when bundle assembly throws', async () => {
    const client = createClient(async () => {
      throw new Error('no inputs available');
    });

    const sent: AgentToOrchestratorMessage[] = [];
    vi.spyOn(client, 'sendDirect').mockImplementation((m) => sent.push(m));

    await client.streamFleetBundle(req);

    const errors = sent.filter((m) => m.type === 'fleet.bundle.error');
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({ requestId: 'req-fleet-1' });
    expect(sent.some((m) => m.type === 'fleet.bundle.chunk')).toBe(false);
  });
});
