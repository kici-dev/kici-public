/**
 * Agent-process interception of the bootstrap bring-up API methods.
 *
 * `ctx.kici.bootstrap.ensureInitRunner` / `preBootSend` are relayed from the
 * workflow sandbox as `agent.api.request` IPC. The agent process intercepts
 * those two methods HERE (rather than relaying them straight to the
 * orchestrator) so the SSH transport — and the bring-up key / bootstrap token
 * the orchestrator hands back — stay in the agent process, never reaching user
 * workflow code. Every other method falls through to the orchestrator relay
 * unchanged.
 */
import {
  ensureInitRunner,
  type ApiTransport,
  type EnsureInitRunnerDeps,
} from './ensure-init-runner.js';
import { preBootSend, type PreBootSendOpts } from './pre-boot-send.js';

const ENSURE_INIT_RUNNER = 'kici.ensureInitRunner';
const PRE_BOOT_SEND = 'kici.preBootSend';

/**
 * Wrap the orchestrator API transport so the two bootstrap methods are handled
 * in-process (SSH transport here; privileged resolve relayed to the
 * orchestrator). `relay` is the raw orchestrator transport (the WS
 * `sendApiRequest`).
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
    return relay(method, params);
  };
}
