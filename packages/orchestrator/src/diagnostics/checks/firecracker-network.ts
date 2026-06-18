/**
 * Firecracker host-bridge diagnostic. Emits one row per configured Firecracker
 * scaler backend: the bridge interface + its gateway addr + its nft table must
 * all be present, else the scaler cannot spawn microVMs.
 */
import type { DiagnosticDeps, DiagnosticResult } from '../types.js';
import {
  verifyBridge,
  type BridgeHealth,
  type FirecrackerBridgeConfig,
} from '../../firecracker/host-network.js';

interface CheckOpts {
  verify?: (cfg: FirecrackerBridgeConfig) => Promise<BridgeHealth>;
}

/** Backend instances that expose host-bridge config (the Firecracker backend). */
interface BridgeConfigProvider {
  getBridgeConfig?: () => FirecrackerBridgeConfig;
}

export async function checkFirecrackerNetwork(
  deps: DiagnosticDeps,
  opts: CheckOpts = {},
): Promise<DiagnosticResult[]> {
  const start = Date.now();
  const mgr = deps.scalerManager;
  const backends = (mgr?.getStatus().backends ?? []).filter((b) => b.type === 'firecracker');

  if (backends.length === 0) {
    return [
      {
        name: 'firecracker',
        status: 'pass',
        message: 'No firecracker backends configured',
        durationMs: Date.now() - start,
      },
    ];
  }

  const verify = opts.verify ?? ((cfg) => verifyBridge(cfg, { requireSudo: true }));
  const rows: DiagnosticResult[] = [];
  for (const b of backends) {
    const backend = mgr?.getBackend?.(b.name) as BridgeConfigProvider | undefined;
    const cfg = backend?.getBridgeConfig?.();
    if (!cfg) {
      rows.push({
        name: `firecracker:${b.name}`,
        status: 'warn',
        message: 'bridge config unavailable',
        durationMs: Date.now() - start,
      });
      continue;
    }
    const h = await verify(cfg);
    rows.push({
      name: `firecracker:${cfg.bridgeName}`,
      status: h.healthy ? 'pass' : 'fail',
      message: h.healthy ? `bridge healthy (${cfg.bridgeCidr}, table ${cfg.table})` : h.detail,
      details: { bridgeCidr: cfg.bridgeCidr, table: cfg.table, ...h },
      durationMs: Date.now() - start,
    });
  }
  return rows;
}
