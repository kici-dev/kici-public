import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile, mkdir, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

const { openMock, loggerMock } = vi.hoisted(() => {
  return {
    openMock: vi.fn(async () => undefined),
    loggerMock: {
      info: vi.fn(),
      error: vi.fn(),
      warn: vi.fn(),
      debug: vi.fn(),
    },
  };
});

vi.mock('open', () => ({ default: openMock }));

vi.mock('@kici-dev/core', () => ({
  logger: loggerMock,
  toErrorMessage: (err: unknown) => (err instanceof Error ? err.message : String(err)),
}));

import { docsCommand, docsLlmCommand } from './docs.js';

describe('docs command', () => {
  beforeEach(() => {
    openMock.mockClear();
    loggerMock.info.mockClear();
    loggerMock.error.mockClear();
  });

  it('opens the docs URL via `open` by default', async () => {
    const ok = await docsCommand({ open: true });
    expect(ok).toBe(true);
    expect(openMock).toHaveBeenCalledWith('https://kici.dev/docs/');
  });

  it('prints the URL when --no-open is passed', async () => {
    const ok = await docsCommand({ open: false });
    expect(ok).toBe(true);
    expect(openMock).not.toHaveBeenCalled();
    expect(loggerMock.info).toHaveBeenCalledWith('https://kici.dev/docs/');
  });
});

describe('docs llm command', () => {
  let bundleDir: string;
  let stdoutWriteSpy: ReturnType<typeof vi.spyOn>;
  let stdoutChunks: string[];

  beforeEach(async () => {
    loggerMock.info.mockClear();
    loggerMock.error.mockClear();
    bundleDir = await mkdtemp(path.join(tmpdir(), 'kici-docs-llm-test-'));
    await mkdir(bundleDir, { recursive: true });
    await writeFile(
      path.join(bundleDir, 'llms.txt'),
      '# KiCI\n\n> short index\n\n## Section A\n- [Foo](https://kici.dev/x/)\n',
      'utf-8',
    );
    await writeFile(
      path.join(bundleDir, 'llms-full.txt'),
      '# KiCI documentation bundle\n\n## Foo\n\nbody body body\n',
      'utf-8',
    );
    await writeFile(
      path.join(bundleDir, 'llms-sdk.txt'),
      '# KiCI SDK reference\n\n## SDK core\n\nsdk body content\n',
      'utf-8',
    );
    await writeFile(
      path.join(bundleDir, 'llms-patterns.txt'),
      '# KiCI Workflow patterns\n\npatterns body content\n',
      'utf-8',
    );
    stdoutChunks = [];
    stdoutWriteSpy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown) => {
      stdoutChunks.push(typeof chunk === 'string' ? chunk : String(chunk));
      return true;
    });
  });

  afterEach(async () => {
    stdoutWriteSpy.mockRestore();
    await rm(bundleDir, { recursive: true, force: true });
  });

  it('prints the llms.txt index when no topic is given', async () => {
    const ok = await docsLlmCommand({ bundleDir });
    expect(ok).toBe(true);
    const joined = stdoutChunks.join('');
    expect(joined).toContain('# KiCI');
    expect(joined).toContain('## Section A');
    expect(joined).not.toContain('body body body');
  });

  it('prints a task bundle by topic', async () => {
    const ok = await docsLlmCommand({ bundleDir, topic: 'sdk' });
    expect(ok).toBe(true);
    expect(stdoutChunks.join('')).toContain('sdk body content');
  });

  it('prints the full bundle for the "full" topic', async () => {
    const ok = await docsLlmCommand({ bundleDir, topic: 'full' });
    expect(ok).toBe(true);
    expect(stdoutChunks.join('')).toContain('body body body');
  });

  it('writes a topic bundle to --out instead of stdout', async () => {
    const outPath = path.join(bundleDir, 'captured.txt');
    const ok = await docsLlmCommand({ bundleDir, topic: 'patterns', out: outPath });
    expect(ok).toBe(true);
    expect(stdoutChunks).toHaveLength(0);
    expect(await readFile(outPath, 'utf-8')).toContain('patterns body content');
  });

  it('returns false and lists available topics for an unknown topic', async () => {
    const ok = await docsLlmCommand({ bundleDir, topic: 'nope' });
    expect(ok).toBe(false);
    expect(loggerMock.error).toHaveBeenCalled();
    const logged = [
      ...loggerMock.error.mock.calls.flat(),
      ...loggerMock.info.mock.calls.flat(),
    ].join(' ');
    expect(logged).toContain('sdk');
    expect(logged).toContain('patterns');
    expect(logged).toContain('full');
  });

  it('returns false and logs an error when the bundle dir is missing', async () => {
    const ok = await docsLlmCommand({ bundleDir: path.join(bundleDir, 'nope'), topic: 'sdk' });
    expect(ok).toBe(false);
    expect(loggerMock.error).toHaveBeenCalled();
  });
});
