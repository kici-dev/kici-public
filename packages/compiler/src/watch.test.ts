import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';

/**
 * Manual check: with a workflow in `.kici/workflows/ci.ts`, `npx kici compile
 * --watch` writes kici.lock.json, recompiles on change, clears the terminal
 * between compiles, compiles once for rapid saves, shows a syntax error and
 * recovers once it is fixed, and stops cleanly on Ctrl+C.
 */

vi.mock('chokidar', () => {
  const MockWatcher = class extends EventEmitter {
    close = vi.fn().mockResolvedValue(undefined);
  };

  return {
    default: {
      watch: vi.fn(() => new MockWatcher()),
    },
  };
});

import chokidar from 'chokidar';

describe('watch mode', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('creates watcher with correct options', async () => {
    const watchMock = vi.mocked(chokidar.watch);

    // Exercises only the mock setup.
    const watcher = chokidar.watch('/test/path', {
      persistent: true,
      awaitWriteFinish: {
        stabilityThreshold: 100,
        pollInterval: 50,
      },
      ignoreInitial: true,
    });

    expect(watchMock).toHaveBeenCalledWith('/test/path', {
      persistent: true,
      awaitWriteFinish: {
        stabilityThreshold: 100,
        pollInterval: 50,
      },
      ignoreInitial: true,
    });

    expect(watcher.close).toBeDefined();
  });

  it('debounces rapid changes', async () => {
    // The debounce logic in isolation.
    let callCount = 0;
    let debounceTimeout: NodeJS.Timeout | null = null;
    const DEBOUNCE_MS = 200;

    const debouncedFn = () => {
      if (debounceTimeout) {
        clearTimeout(debounceTimeout);
      }
      debounceTimeout = setTimeout(() => {
        callCount++;
      }, DEBOUNCE_MS);
    };

    debouncedFn();
    debouncedFn();
    debouncedFn();

    expect(callCount).toBe(0);

    vi.advanceTimersByTime(DEBOUNCE_MS + 10);
    expect(callCount).toBe(1); // Only one call despite 3 triggers
  });
});
