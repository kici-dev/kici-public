/**
 * The `vi.mock('@kici-dev/shared', …)` body the package suites share. The
 * `vi.mock` call itself stays in each importing package
 * (`src/__test-helpers__/shared-mocks.ts`): vitest hoists it only in modules it
 * transforms, and this package is consumed from `dist/`.
 */
import { vi, type Mock } from 'vitest';

export interface SilentLogger {
  info: Mock;
  warn: Mock;
  error: Mock;
  debug: Mock;
}

/** A logger whose every level is a fresh `vi.fn()`. */
export function silentLogger(): SilentLogger {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
}

/**
 * Every real export, with `createLogger` returning `logger` for one prefix and
 * the real logger for every other, so a test can read the lines one module writes.
 */
export function withPrefixedLogger<T extends { createLogger: (opts?: never) => unknown }>(
  actual: T,
  prefix: string,
  logger: SilentLogger,
): T {
  return {
    ...actual,
    createLogger: (opts?: { prefix?: string }) =>
      opts?.prefix === prefix ? logger : actual.createLogger(opts as never),
  };
}

/** Every real export, a silent logger, and a deterministic `toErrorMessage`. */
export function withSilentLogger<T extends object>(
  actual: T,
): Omit<T, 'createLogger' | 'toErrorMessage'> & {
  createLogger: () => SilentLogger;
  toErrorMessage: (err: unknown) => string;
} {
  return {
    ...actual,
    createLogger: () => silentLogger(),
    toErrorMessage: (err: unknown) => (err instanceof Error ? err.message : String(err)),
  };
}
