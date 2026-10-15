/**
 * Agent-side driver for the eval child: forks `eval-runner.js` with a sanitized
 * env, sends one `eval` request, streams log lines onto the job's synthetic
 * step-0 log, and resolves with the serialized result.
 *
 * Only `ready`, `log.line`, `eval.api.request`, `eval.result` and `eval.error`
 * are accepted, so a customer module with code execution in the child cannot
 * reach the step runner's privileged relays by naming their message types.
 */

import { fork, type ChildProcess } from 'node:child_process';
import { createLogger, toErrorMessage } from '@kici-dev/shared';
import type { LogStream } from '@kici-dev/engine';
import type { AgentToEvalMessage, EvalRequest, EvalToAgentMessage } from './ipc-protocol.js';
import { buildSanitizedEnv } from './env-sanitizer.js';

const logger = createLogger({ prefix: 'eval-fork-runner' });

/** Ceiling on the whole child lifetime, independent of the evaluation's own timeouts. */
const EVAL_CHILD_HARD_TIMEOUT_MS = 30 * 60 * 1000;

/**
 * Stderr kept for the die-without-reporting message: fits a module-resolution
 * failure, and stops a chatty child bloating a job's error field.
 */
const EVAL_CHILD_STDERR_TAIL_BYTES = 4096;

export interface RunEvalChildOptions {
  /** Absolute path to the compiled `eval-runner.js`. */
  evalRunnerPath: string;
  request: EvalRequest;
  onLogLine: (line: string, stream?: LogStream) => void;
  /** Relays a `ctx.kici` call; when omitted, every call rejects. */
  onApiRequest?: (method: string, params: Record<string, unknown>) => Promise<unknown>;
  /** Operator-set; lets a trusted fleet agent's declared passthrough env reach an evaluation. */
  trustedEnv?: boolean;
  /** Kills the child and rejects. */
  signal?: AbortSignal;
}

/**
 * Run one evaluation in a fresh child. On `eval.error`, rejects with the
 * evaluation's own error text.
 */
export function runEvalChild<T>(options: RunEvalChildOptions): Promise<T> {
  // `{}`, never `process.env`: buildSanitizedEnv merges its first argument
  // wholesale, which would re-add every excluded variable, the agent's own included.
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
        // Channel closed; the exit handler settles.
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

    // Drain stdout/stderr so a full pipe cannot block the child. Neither is
    // re-emitted: console output arrives as `log.line`, and an echo would put an
    // unfiltered copy in the agent's journal.
    //
    // A bounded stderr tail is used ONLY when the child dies without reporting,
    // where it is the sole record (e.g. `ERR_MODULE_NOT_FOUND` for a missing
    // `eval-runner.js`). Without it, a Firecracker rootfs lacking the eval runner
    // showed only "exited without a result (code=1)".
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
          // Not in the eval union: drop, so code in the child cannot reach a handler by naming one.
          logger.warn('Ignoring unexpected message from eval child', {
            type: (msg as { type?: string }).type,
          });
      }
    });

    child.on('error', (err) => {
      finish(() => reject(new Error(`Evaluation child failed to start: ${err.message}`)));
    });

    child.on('exit', (code, signalName) => {
      // Every normal path already settled; the child died without reporting.
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
