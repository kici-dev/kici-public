/**
 * Agent-side driver for the eval child.
 *
 * Forks `eval-runner.js` with a sanitized environment, sends one `eval`
 * request, streams the child's log lines onto the job's synthetic step-0 log,
 * and resolves with the evaluation's serialized result.
 *
 * The accepted inbound set is exactly `ready`, `log.line`, `eval.api.request`,
 * `eval.result` and `eval.error` — anything else from the child is ignored, so a
 * customer module that gains code execution in the child cannot reach the step
 * runner's privileged relays by naming one of their message types.
 */

import { fork, type ChildProcess } from 'node:child_process';
import { createLogger, toErrorMessage } from '@kici-dev/shared';
import type { LogStream } from '@kici-dev/engine';
import type { AgentToEvalMessage, EvalRequest, EvalToAgentMessage } from './ipc-protocol.js';
import { buildSanitizedEnv } from './env-sanitizer.js';

const logger = createLogger({ prefix: 'eval-fork-runner' });

/** Wall-clock ceiling on the whole child lifetime, independent of the evaluation's own timeouts. */
const EVAL_CHILD_HARD_TIMEOUT_MS = 30 * 60 * 1000;

/**
 * How much of the child's stderr to keep for the die-without-reporting message.
 * A node module-resolution failure fits comfortably; the cap keeps a chatty
 * child from pushing an unbounded string into a job's error field.
 */
const EVAL_CHILD_STDERR_TAIL_BYTES = 4096;

export interface RunEvalChildOptions {
  /** Absolute path to the compiled `eval-runner.js`. */
  evalRunnerPath: string;
  /** The evaluation to perform. */
  request: EvalRequest;
  /** Stream one captured line onto the job's log. */
  onLogLine: (line: string, stream?: LogStream) => void;
  /**
   * Relay a `ctx.kici` call to the orchestrator. Omitted means no API transport
   * is wired, and every call rejects — the same fallback the in-process
   * evaluation used.
   */
  onApiRequest?: (method: string, params: Record<string, unknown>) => Promise<unknown>;
  /**
   * Operator-set agent-launch property. Threaded through so a trusted fleet
   * agent's declared passthrough env still reaches an evaluation.
   */
  trustedEnv?: boolean;
  /** Cancels the evaluation; the child is killed and the promise rejects. */
  signal?: AbortSignal;
}

/**
 * Run one evaluation in a fresh child and resolve with its result.
 *
 * Rejects with the evaluation's own error text on `eval.error`, so the calling
 * handler reports exactly the message the in-process evaluation used to throw.
 */
export function runEvalChild<T>(options: RunEvalChildOptions): Promise<T> {
  // `{}` and never `process.env`: buildSanitizedEnv merges its first argument
  // wholesale at its user-env layer, so passing process.env would re-add every
  // variable the sanitizer just excluded — including the agent's own.
  const env = buildSanitizedEnv({}, { trustedEnv: options.trustedEnv });

  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const child: ChildProcess = fork(options.evalRunnerPath, [], {
      env,
      cwd: options.request.workDir,
      stdio: ['pipe', 'pipe', 'pipe', 'ipc'],
    });

    const send = (msg: AgentToEvalMessage): void => {
      try {
        child.send(msg);
      } catch {
        // Channel closed — the child exited; the exit handler settles.
      }
    };

    const finish = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(hardTimeout);
      options.signal?.removeEventListener('abort', onAbort);
      try {
        child.kill('SIGKILL');
      } catch {
        // Already gone.
      }
      fn();
    };

    const hardTimeout = setTimeout(() => {
      finish(() =>
        reject(
          new Error(
            `Evaluation child exceeded its ${EVAL_CHILD_HARD_TIMEOUT_MS}ms ceiling and was killed`,
          ),
        ),
      );
    }, EVAL_CHILD_HARD_TIMEOUT_MS);
    hardTimeout.unref?.();

    const onAbort = (): void => {
      finish(() => reject(new Error('Evaluation cancelled')));
    };
    options.signal?.addEventListener('abort', onAbort, { once: true });

    // The child's own stdout/stderr are drained so the pipe buffer cannot fill
    // and block it. Their content is NOT re-emitted on any normal path:
    // customer console output arrives as `log.line`, and echoing the raw stream
    // would publish a second, unfiltered copy to the agent's journal.
    //
    // stderr is additionally kept as a bounded tail, used ONLY when the child
    // dies without reporting. That is the one path where the child never got as
    // far as sending a message, so its stderr is the sole record of why — a
    // missing `eval-runner.js` or an unresolvable import prints
    // `ERR_MODULE_NOT_FOUND` there and nowhere else. Discarding it turned a
    // Firecracker rootfs that shipped no eval runner into an unattributable
    // "exited without a result (code=1)".
    child.stdout?.resume();
    let stderrTail = '';
    child.stderr?.setEncoding('utf8');
    child.stderr?.on('data', (chunk: string) => {
      stderrTail = (stderrTail + chunk).slice(-EVAL_CHILD_STDERR_TAIL_BYTES);
    });

    child.on('message', (msg: EvalToAgentMessage) => {
      switch (msg.type) {
        case 'ready':
          send({ type: 'eval', request: options.request });
          return;
        case 'log.line':
          options.onLogLine(msg.line, msg.stream);
          return;
        case 'eval.api.request': {
          const relay =
            options.onApiRequest ?? (() => Promise.reject(new Error('Agent API not available')));
          void relay(msg.method, msg.params).then(
            (result) => send({ type: 'eval.api.response', id: msg.id, result }),
            (err) => send({ type: 'eval.api.response', id: msg.id, error: toErrorMessage(err) }),
          );
          return;
        }
        case 'eval.result':
          finish(() => resolve(msg.result as T));
          return;
        case 'eval.error':
          finish(() => reject(new Error(msg.error)));
          return;
        default:
          // Anything outside the eval union is not a message this child is
          // allowed to send. Log it and drop it — a customer module with code
          // execution in the child must not reach a handler by naming one.
          logger.warn('Ignoring unexpected message from eval child', {
            type: (msg as { type?: string }).type,
          });
      }
    });

    child.on('error', (err) => {
      finish(() => reject(new Error(`Evaluation child failed to start: ${err.message}`)));
    });

    child.on('exit', (code, signalName) => {
      // A result or an error already settled the promise on every normal path;
      // reaching here means the child died without reporting, so its stderr is
      // the only diagnostic that exists.
      const detail = stderrTail.trim();
      finish(() =>
        reject(
          new Error(
            `Evaluation child exited without a result (code=${code}, signal=${signalName})` +
              (detail ? `: ${detail}` : ''),
          ),
        ),
      );
    });
  });
}
