import { AsyncLocalStorage } from 'node:async_hooks';
import { format } from 'node:util';

/**
 * Sink for captured console lines.
 *
 * The agent wires this to a per-job LogStreamer so captured lines become
 * log.chunk messages to the orchestrator and dashboard.
 */
export interface CaptureSink {
  addLine(line: string): void;
}

/**
 * AsyncLocalStorage holding the active CaptureSink.
 *
 * When a sink is active, the patched console.* methods route formatted lines
 * to the sink. When no sink is active, the patched methods fall through to
 * the original console methods.
 *
 * Nested runCaptured() shadows the outer sink for the duration of the inner
 * scope; ALS restores the outer sink when the inner scope exits.
 */
const consoleCapture = new AsyncLocalStorage<CaptureSink>();

const METHODS = ['log', 'error', 'warn', 'info', 'debug'] as const;
type ConsoleMethod = (typeof METHODS)[number];

const originals: Record<ConsoleMethod, (...args: unknown[]) => void> = {
  log: console.log.bind(console),
  error: console.error.bind(console),
  warn: console.warn.bind(console),
  info: console.info.bind(console),
  debug: console.debug.bind(console),
};

let installed = false;

/**
 * Install monkey-patches on console.log / error / warn / info / debug.
 *
 * Idempotent: subsequent calls are no-ops.
 *
 * Does NOT patch process.stdout.write or process.stderr.write. Winston's
 * Console transport writes through those streams directly, so patching them
 * at the agent level would leak agent-internal logger output into user step
 * streams whenever Winston fires on an async stack descended from a user
 * function. Winston bypasses console.*, so patching only console.* is
 * collision-free.
 */
export function installConsoleCapture(): void {
  if (installed) return;
  installed = true;
  for (const m of METHODS) {
    console[m] = (...args: unknown[]) => {
      const sink = consoleCapture.getStore();
      if (!sink) {
        originals[m](...args);
        return;
      }
      const formatted = format(...args);
      const lines = formatted.split('\n');
      for (const line of lines) {
        if (line) sink.addLine(line);
      }
    };
  }
}

/**
 * Run `fn` with the given sink active. console.* calls inside `fn` and any
 * async descendants route to the sink until the returned promise resolves.
 *
 * If `installConsoleCapture()` has not been called, the sink is still tracked
 * in ALS but console.* calls are not intercepted.
 */
export function runCaptured<T>(sink: CaptureSink, fn: () => T | Promise<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    consoleCapture.run(sink, () => {
      try {
        Promise.resolve(fn()).then(resolve, reject);
      } catch (err) {
        reject(err);
      }
    });
  });
}

/** Test helper: uninstall the console.* patches and restore originals. */
export function _uninstallConsoleCaptureForTests(): void {
  if (!installed) return;
  for (const m of METHODS) {
    console[m] = originals[m];
  }
  installed = false;
}

/** Test helper: read the currently active sink, if any. */
export function _getActiveSinkForTests(): CaptureSink | undefined {
  return consoleCapture.getStore();
}
