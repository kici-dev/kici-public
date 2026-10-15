/**
 * The agent process intercepts the bootstrap bring-up methods
 * (`ensureInitRunner`, `preBootSend`, `restageAgent`), which arrive from the
 * sandbox as `agent.api.request` IPC, so the SSH transport and the bring-up
 * key / bootstrap token the orchestrator returns never reach workflow code.
 * Every other method passes through to the orchestrator relay unchanged.
 */
import {
  ensureInitRunner,
  type ApiTransport,
  type EnsureInitRunnerDeps,
} from './ensure-init-runner.js';
import { preBootSend, type PreBootSendOpts } from './pre-boot-send.js';
import { runRestage } from './run-restage.js';

const ENSURE_INIT_RUNNER = 'kici.ensureInitRunner';
const PRE_BOOT_SEND = 'kici.preBootSend';
const RESTAGE_AGENT = 'kici.restageAgent';

/**
 * Handle the bootstrap methods in-process (SSH here; the privileged resolve
 * still goes to the orchestrator). `relay` is the raw WS `sendApiRequest`.
 */
export function withBootstrapInterception(
  relay: ApiTransport,
  deps: EnsureInitRunnerDeps = {},
): (method: string, params?: Record<string, unknown>) => Promise<unknown> {
  return async (method, params = {}) => {
    if (method === ENSURE_INIT_RUNNER) {
      const targetAgentId = String(params.targetAgentId ?? '');
      return ensureInitRunner(relay, targetAgentId, deps);
    }
    if (method === PRE_BOOT_SEND) {
      const targetAgentId = String(params.targetAgentId ?? '');
      const opts: PreBootSendOpts = {
        inputSecret: String(params.inputSecret ?? ''),
        ...(typeof params.port === 'number' ? { port: params.port } : {}),
        ...(typeof params.command === 'string' ? { command: params.command } : {}),
      };
      await preBootSend(relay, targetAgentId, opts, deps);
      return undefined;
    }
    if (method === RESTAGE_AGENT) {
      const targetAgentId = String(params.targetAgentId ?? '');
      return runRestage(relay, targetAgentId, deps);
    }
    return relay(method, params);
  };
}
