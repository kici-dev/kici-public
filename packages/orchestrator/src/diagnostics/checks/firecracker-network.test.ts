import { describe, it, expect } from 'vitest';
import { checkFirecrackerNetwork } from './firecracker-network.js';
import type { DiagnosticDeps } from '../types.js';
import type { BridgeHealth, FirecrackerBridgeConfig } from '../../firecracker/host-network.js';

function depsWith(
  backends: Array<{ name: string; type: string; bridge?: FirecrackerBridgeConfig }>,
): DiagnosticDeps {
  return {
    config: {},
    scalerManager: {
      getStatus: () => ({ backends: backends.map((b) => ({ name: b.name, type: b.type })) }),
      getBackend: (name: string) => {
        const b = backends.find((x) => x.name === name);
        return b?.bridge ? { getBridgeConfig: () => b.bridge } : undefined;
      },
    },
  } as unknown as DiagnosticDeps;
}

describe('checkFirecrackerNetwork', () => {
  it('passes with a note when there are no firecracker backends', async () => {
    const res = await checkFirecrackerNetwork(depsWith([{ name: 'c', type: 'container' }]));
    expect(res[0].status).toBe('pass');
    expect(res[0].message).toMatch(/No firecracker/);
  });

  it('emits a pass row when the bridge is healthy', async () => {
    const healthy: BridgeHealth = {
      bridgeName: 'kici-br0',
      bridgeExists: true,
      bridgeUp: true,
      addrPresent: true,
      tablePresent: true,
      healthy: true,
      detail: 'healthy',
    };
    const res = await checkFirecrackerNetwork(
      depsWith([
        {
          name: 'stg-firecracker',
          type: 'firecracker',
          bridge: { bridgeName: 'kici-br0', bridgeCidr: '10.0.0.1/24', table: 'kici' },
        },
      ]),
      { verify: async () => healthy },
    );
    expect(res[0].name).toBe('firecracker:kici-br0');
    expect(res[0].status).toBe('pass');
  });

  it('emits a fail row when a bridge is unhealthy', async () => {
    const res = await checkFirecrackerNetwork(
      depsWith([
        {
          name: 'stg-firecracker',
          type: 'firecracker',
          bridge: { bridgeName: 'kici-br0', bridgeCidr: '10.0.0.1/24', table: 'kici' },
        },
      ]),
      {
        verify: async () => ({
          bridgeName: 'kici-br0',
          bridgeExists: false,
          bridgeUp: false,
          addrPresent: false,
          tablePresent: false,
          healthy: false,
          detail: 'kici-br0 does not exist',
        }),
      },
    );
    expect(res[0].name).toBe('firecracker:kici-br0');
    expect(res[0].status).toBe('fail');
    expect(res[0].message).toMatch(/does not exist/);
  });

  it('warns when a firecracker backend exposes no bridge config', async () => {
    const res = await checkFirecrackerNetwork(
      depsWith([{ name: 'stg-firecracker', type: 'firecracker' }]),
    );
    expect(res[0].status).toBe('warn');
    expect(res[0].message).toMatch(/unavailable/);
  });
});
