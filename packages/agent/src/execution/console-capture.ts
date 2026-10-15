import { AsyncLocalStorage } from 'node:async_hooks';
import { format } from 'node:util';

/** Sink for captured console lines; the agent wires it to a per-job LogStreamer (log.chunk). */
export interface CaptureSink {
  addLine(line: string): void;
}

/**
 * The active sink; with none, the patched console.* falls through to the originals.
 * A nested runCaptured() shadows the outer sink until its scope exits.
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
 * Patch console.* (idempotent). Never process.stdout/stderr.write: Winston's Console
 * transport writes there, so patching them would leak agent logger output into user
 * step streams whenever Winston fires on an async stack descended from a user function.
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
 * Route console.* from `fn` and its async descendants to `sink` until the promise
 * resolves. Without `installConsoleCapture()`, the sink is tracked but nothing is intercepted.
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
