import { spawn } from 'node:child_process';
import type { BetweenJobsRunOn } from '../config.js';

export type ResetStatus = 'success' | 'failed' | 'timeout' | 'skipped';

export interface ExecResult {
  code: number | null;
  timedOut?: boolean;
}
export type ExecFn = (command: string, timeoutMs: number) => Promise<ExecResult>;

export interface ResetInput {
  command?: string;
  timeoutMs: number;
  runOn: BetweenJobsRunOn;
  jobFailed: boolean;
  exec?: ExecFn;
}

export interface ResetResult {
  status: ResetStatus;
  durationMs: number;
}

/** Default exec: run the command through the shell, SIGKILL on timeout. */
const defaultExec: ExecFn = (command, timeoutMs) =>
  new Promise((resolve) => {
    const child = spawn('/bin/sh', ['-c', command], { stdio: 'ignore' });
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, timeoutMs);
    child.on('exit', (code) => {
      clearTimeout(timer);
      resolve({ code, timedOut });
    });
    child.on('error', () => {
      clearTimeout(timer);
      resolve({ code: 1, timedOut });
    });
  });

/**
 * Run the operator between-jobs reset command. Fail-open: never throws, always
 * resolves to a status. Skips when unconfigured, or when runOn=on-failure and
 * the job succeeded.
 */
export async function runBetweenJobsReset(input: ResetInput): Promise<ResetResult> {
  const started = performance.now();
  const done = (status: ResetStatus): ResetResult => ({
    status,
    durationMs: Math.round(performance.now() - started),
  });
  if (!input.command) return done('skipped');
  if (input.runOn === 'on-failure' && !input.jobFailed) return done('skipped');

  const exec = input.exec ?? defaultExec;
  try {
    const r = await exec(input.command, input.timeoutMs);
    if (r.timedOut) return done('timeout');
    return done(r.code === 0 ? 'success' : 'failed');
  } catch {
    return done('failed');
  }
}
