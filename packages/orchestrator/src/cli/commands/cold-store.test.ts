/**
 * Smoke tests for `kici-admin cold-store` Phase C wiring.
 *
 * Each subcommand registers under `cold-store` and either:
 *   - rejects fast (exit 2) with a clear "Database URL required" when
 *     KICI_DATABASE_URL / DATABASE_URL is unset and no --database-url
 *     flag is passed; or
 *   - rejects fast (exit 2) with an adapter-aware error when the table
 *     is unknown.
 *
 * Real archive / list-chunks behaviour is exercised end-to-end by the
 * Bucket-B `cold-store-execution-runs` E2E (which has a real
 * deployed-staging Postgres + S3 to talk to). These tests cover only
 * the CLI surface and argument plumbing.
 */
import { describe, expect, it } from 'vitest';
import { Command } from 'commander';
import { registerColdStoreCommands } from './cold-store.js';

function buildProgram(): Command {
  const program = new Command();
  program.name('kici-admin');
  program.exitOverride();
  registerColdStoreCommands(program, () => {
    throw new Error('getClient must not be called by cold-store commands');
  });
  return program;
}

async function runCapture(
  argv: string[],
): Promise<{ stdout: string; stderr: string; exitCode: number | null }> {
  const program = buildProgram();
  let stdout = '';
  let stderr = '';
  let exitCode: number | null = null;

  const origWrite = process.stdout.write.bind(process.stdout);
  const origErr = process.stderr.write.bind(process.stderr);
  const origLog = console.log;
  const origLogErr = console.error;
  const origExit = process.exit.bind(process);

  process.stdout.write = ((chunk: unknown, ..._rest: unknown[]) => {
    stdout += typeof chunk === 'string' ? chunk : String(chunk);
    return true;
  }) as typeof process.stdout.write;
  process.stderr.write = ((chunk: unknown, ..._rest: unknown[]) => {
    stderr += typeof chunk === 'string' ? chunk : String(chunk);
    return true;
  }) as typeof process.stderr.write;
  console.log = (...args: unknown[]) => {
    stdout += args.map(String).join(' ') + '\n';
  };
  console.error = (...args: unknown[]) => {
    stderr += args.map(String).join(' ') + '\n';
  };
  process.exit = ((code?: number) => {
    exitCode = code ?? 0;
    throw new Error(`__exit_${code ?? 0}__`);
  }) as typeof process.exit;

  // Ensure no ambient KICI_DATABASE_URL leaks into the CLI under test.
  const savedKici = process.env.KICI_DATABASE_URL;
  delete process.env.KICI_DATABASE_URL;

  try {
    await program.parseAsync(['node', 'kici-admin', ...argv]);
  } catch (err) {
    if (err instanceof Error && !/^__exit_/.test(err.message)) {
      const msg = err.message;
      if (!msg.includes('(outputHelp)')) stderr += `\n${msg}`;
    }
  } finally {
    process.stdout.write = origWrite;
    process.stderr.write = origErr;
    console.log = origLog;
    console.error = origLogErr;
    process.exit = origExit;
    if (savedKici !== undefined) process.env.KICI_DATABASE_URL = savedKici;
  }
  return { stdout, stderr, exitCode };
}

describe('kici-admin cold-store (Phase C — surface smoke)', () => {
  it('archive-now requires a database URL', async () => {
    const { stderr, exitCode } = await runCapture(['cold-store', 'archive-now', 'execution_runs']);
    expect(stderr).toMatch(/Database URL required/);
    expect(exitCode).toBe(2);
  });

  it('dry-run-archive requires a database URL', async () => {
    const { stderr, exitCode } = await runCapture([
      'cold-store',
      'dry-run-archive',
      'execution_runs',
    ]);
    expect(stderr).toMatch(/Database URL required/);
    expect(exitCode).toBe(2);
  });

  it('list-chunks requires a database URL', async () => {
    const { stderr, exitCode } = await runCapture(['cold-store', 'list-chunks', 'execution_runs']);
    expect(stderr).toMatch(/Database URL required/);
    expect(exitCode).toBe(2);
  });

  it('verify-chunk requires a database URL', async () => {
    const { stderr, exitCode } = await runCapture([
      'cold-store',
      'verify-chunk',
      'abc123',
      '--table',
      'execution_runs',
      '--tenant',
      'rk1',
      '--partition-date',
      '2026-04-01',
    ]);
    expect(stderr).toMatch(/Database URL required/);
    expect(exitCode).toBe(2);
  });

  it('replay-chunk requires a database URL', async () => {
    const { stderr, exitCode } = await runCapture([
      'cold-store',
      'replay-chunk',
      'abc123',
      '--table',
      'execution_runs',
      '--tenant',
      'rk1',
      '--partition-date',
      '2026-04-01',
    ]);
    expect(stderr).toMatch(/Database URL required/);
    expect(exitCode).toBe(2);
  });

  it('reconcile requires a database URL', async () => {
    const { stderr, exitCode } = await runCapture(['cold-store', 'reconcile', 'execution_runs']);
    expect(stderr).toMatch(/Database URL required/);
    expect(exitCode).toBe(2);
  });

  it('peek-chunk requires a database URL', async () => {
    const { stderr, exitCode } = await runCapture([
      'cold-store',
      'peek-chunk',
      'abc123',
      '--table',
      'execution_runs',
      '--tenant',
      'rk1',
      '--partition-date',
      '2026-04-01',
    ]);
    expect(stderr).toMatch(/Database URL required/);
    expect(exitCode).toBe(2);
  });
});
