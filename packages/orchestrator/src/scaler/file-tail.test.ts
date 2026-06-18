import { describe, it, expect, afterEach } from 'vitest';
import { writeFile, appendFile, mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { tailFile } from './file-tail.js';

/**
 * Start collecting lines from tailFile into a live array.
 *
 * Returns the array (mutated as lines arrive) plus a promise that resolves when
 * the iterator finishes (abort or maxLines reached). Callers poll the array via
 * `waitForLines(...)` and then `ctrl.abort()` + `await done` to settle.
 */
function startCollecting(
  filePath: string,
  signal: AbortSignal,
  maxLines = 100,
): { lines: string[]; done: Promise<string[]> } {
  const lines: string[] = [];
  const done = (async () => {
    for await (const line of tailFile(filePath, signal)) {
      lines.push(line);
      if (lines.length >= maxLines) break;
    }
    return lines;
  })();
  return { lines, done };
}

/** Wait for a specified number of milliseconds. */
function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Poll a predicate until it returns true, or throw after a generous timeout.
 *
 * Used to wait on the collected-line set surfacing through the poll-based
 * watcher (100ms interval) instead of a hard-coded sleep that can be too short
 * when the whole suite runs in parallel under load.
 */
async function waitForCondition(
  predicate: () => boolean,
  {
    timeoutMs = 5000,
    intervalMs = 25,
    label = 'condition',
  }: {
    timeoutMs?: number;
    intervalMs?: number;
    label?: string;
  } = {},
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) {
      throw new Error(`Timed out after ${timeoutMs}ms waiting for ${label}`);
    }
    await wait(intervalMs);
  }
}

/** Wait until every expected entry is present in the collected lines array. */
function waitForLines(
  lines: string[],
  expected: string[],
  opts?: { timeoutMs?: number },
): Promise<void> {
  return waitForCondition(() => expected.every((e) => lines.includes(e)), {
    ...opts,
    label: `lines to contain [${expected.join(', ')}]`,
  });
}

describe('tailFile', () => {
  let tmpDir: string;
  const controllers: AbortController[] = [];

  afterEach(async () => {
    // Abort any still-running tailers
    for (const ctrl of controllers) {
      ctrl.abort();
    }
    controllers.length = 0;

    // Clean up temp directory
    if (tmpDir) {
      await rm(tmpDir, { recursive: true, force: true }).catch(() => {});
    }
  });

  async function setup(): Promise<string> {
    tmpDir = await mkdtemp(join(tmpdir(), 'file-tail-test-'));
    return join(tmpDir, 'test.log');
  }

  function createController(): AbortController {
    const ctrl = new AbortController();
    controllers.push(ctrl);
    return ctrl;
  }

  it('should yield lines appended to a file after tailing starts', async () => {
    const filePath = await setup();
    const ctrl = createController();

    // Start collecting lines in the background
    const { lines, done } = startCollecting(filePath, ctrl.signal, 3);

    // Wait for watcher to initialize, then append lines
    await wait(200);
    await appendFile(filePath, 'line one\nline two\nline three\n');

    // Poll until the watcher surfaces every line, then settle the iterator
    await waitForLines(lines, ['line one', 'line two', 'line three']);
    ctrl.abort();
    await done;

    expect(lines).toContain('line one');
    expect(lines).toContain('line two');
    expect(lines).toContain('line three');
  });

  it('should handle partial lines split across writes', async () => {
    const filePath = await setup();
    const ctrl = createController();

    const { lines, done } = startCollecting(filePath, ctrl.signal, 2);

    // Write a partial line, then complete it in the next write
    await wait(200);
    await appendFile(filePath, 'partial');
    await wait(200);
    await appendFile(filePath, ' complete\nsecond line\n');

    await waitForLines(lines, ['partial complete', 'second line']);
    ctrl.abort();
    await done;

    expect(lines).toContain('partial complete');
    expect(lines).toContain('second line');
  });

  it('should skip empty lines', async () => {
    const filePath = await setup();
    const ctrl = createController();

    const { lines, done } = startCollecting(filePath, ctrl.signal, 2);

    await wait(200);
    await appendFile(filePath, 'first\n\n\nsecond\n');

    await waitForLines(lines, ['first', 'second']);
    ctrl.abort();
    await done;

    expect(lines).toEqual(['first', 'second']);
  });

  it('should stop when abort signal is triggered', async () => {
    const filePath = await setup();
    const ctrl = createController();

    const { lines, done } = startCollecting(filePath, ctrl.signal, 100);

    await wait(200);
    await appendFile(filePath, 'before abort\n');

    await waitForLines(lines, ['before abort']);
    ctrl.abort();

    await done;
    expect(lines).toContain('before abort');
    // Should resolve after abort, not hang
  });

  it('should handle multiple rapid writes (coalescing)', async () => {
    const filePath = await setup();
    const ctrl = createController();

    const { lines, done } = startCollecting(filePath, ctrl.signal, 5);

    await wait(200);

    // Write multiple times with delays > polling interval (100ms) to ensure
    // each write is detected as a separate stat change by the poller. These
    // inter-write sleeps create the scenario (separate stat changes); they do
    // not gate the assertions, which poll on the collected-line set below.
    await appendFile(filePath, 'rapid1\n');
    await wait(120);
    await appendFile(filePath, 'rapid2\n');
    await wait(120);
    await appendFile(filePath, 'rapid3\n');
    await wait(120);
    await appendFile(filePath, 'rapid4\n');
    await wait(120);
    await appendFile(filePath, 'rapid5\n');

    await waitForLines(lines, ['rapid1', 'rapid2', 'rapid3', 'rapid4', 'rapid5']);
    ctrl.abort();
    await done;

    expect(lines).toContain('rapid1');
    expect(lines).toContain('rapid2');
    expect(lines).toContain('rapid3');
    expect(lines).toContain('rapid4');
    expect(lines).toContain('rapid5');
  });

  it('should flush partial content on abort', async () => {
    const filePath = await setup();
    const ctrl = createController();

    const { lines, done } = startCollecting(filePath, ctrl.signal, 100);

    await wait(200);
    // Write a line without trailing newline
    await appendFile(filePath, 'complete line\nno trailing newline');

    // The complete line surfaces via the poller; the trailing partial only
    // flushes on abort, so wait for the complete line first, then abort.
    await waitForLines(lines, ['complete line']);
    ctrl.abort();
    await done;

    expect(lines).toContain('complete line');
    expect(lines).toContain('no trailing newline');
  });

  it('should pre-create the file if it does not exist', async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'file-tail-test-'));
    const filePath = join(tmpDir, 'nonexistent.log');
    const ctrl = createController();

    const { lines, done } = startCollecting(filePath, ctrl.signal, 1);

    await wait(200);
    await appendFile(filePath, 'written after creation\n');

    await waitForLines(lines, ['written after creation']);
    ctrl.abort();
    await done;

    expect(lines).toContain('written after creation');
  });
});
