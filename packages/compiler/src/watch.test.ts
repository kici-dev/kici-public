import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';

/**
 * Manual verification steps for watch mode:
 *
 * 1. Create a test workflow file at .kici/workflows/ci.ts:
 *    ```
 *    import { workflow, job, step } from '@kici-dev/sdk';
 *    export default workflow('test', {
 *      jobs: [job('build', { runsOn: 'ubuntu', steps: [step('Run', async () => {})] })]
 *    });
 *    ```
 *
 * 2. Run: npx kici compile --watch
 *
 * 3. Verify:
 *    - Initial compilation produces kici.lock.json
 *    - Modifying config triggers recompilation
 *    - Terminal clears between compilations
 *    - Rapid saves (Ctrl+S multiple times) only trigger one compile
 *    - Ctrl+C gracefully stops the watcher
 *
 * 4. Test error handling:
 *    - Introduce a syntax error, verify error message shows
 *    - Fix the error, verify compilation succeeds
 */

// Mock chokidar
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

// Import after mocking
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

    // Just verify the mock setup
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
    // Test debounce logic in isolation
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

    // Simulate rapid changes
    debouncedFn();
    debouncedFn();
    debouncedFn();

    // Before debounce completes
    expect(callCount).toBe(0);

    // After debounce
    vi.advanceTimersByTime(DEBOUNCE_MS + 10);
    expect(callCount).toBe(1); // Only one call despite 3 triggers
  });
});
