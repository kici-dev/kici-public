import { describe, it, expect, afterEach, vi } from 'vitest';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { GenericInitConfig } from '@kici-dev/sdk';
import { runInitPhase } from './init-phase.js';
import { buildInitShellFor } from '../sandbox/workflow-runner.js';
import type { RunnerToAgentMessage } from '../sandbox/ipc-protocol.js';

afterEach(() => {
  vi.unstubAllEnvs();
});

/** Run init specs through the runner's real shell factory in a fresh clone dir. */
async function runReal(specs: GenericInitConfig[], protectedEnvKeys = new Set<string>()) {
  const dir = await mkdtemp(join(tmpdir(), 'init-env-'));
  const msgs: RunnerToAgentMessage[] = [];
  const send = (m: RunnerToAgentMessage): void => {
    msgs.push(m);
  };
  const result = await runInitPhase({
    specs,
    shellFor: buildInitShellFor(dir, send),
    sendIpc: send,
    stepIndexBase: 0,
    protectedEnvKeys,
  });
  const logText = msgs
    .filter((m): m is Extract<RunnerToAgentMessage, { type: 'log.line' }> => m.type === 'log.line')
    .map((m) => m.line)
    .join('\n');
  return { dir, result, logText };
}

describe('init env reaches the init command (real bash)', () => {
  it('the command sees a spec env key', async () => {
    const { dir, result } = await runReal([
      { run: 'printf %s "$PROBE" > probe.out', env: { PROBE: 'x' } },
    ]);
    expect(result.ok).toBe(true);
    // fails-when: runOneInit runs the command without spec.env (the file holds '')
    expect(await readFile(join(dir, 'probe.out'), 'utf8')).toBe('x');
  });

  it('a spec key wins over the job env for that command', async () => {
    vi.stubEnv('PROBE_SHARED', 'job');
    const { dir } = await runReal([
      { run: 'printf %s "$PROBE_SHARED" > shared.out', env: { PROBE_SHARED: 'spec' } },
    ]);
    // fails-when: the overlay is applied under the job env instead of over it
    expect(await readFile(join(dir, 'shared.out'), 'utf8')).toBe('spec');
  });

  it('a KICI_ key keeps the agent value and the log names the key, never the value', async () => {
    vi.stubEnv('KICI_PROBE_RESERVED', 'agent-value');
    const { dir, result, logText } = await runReal([
      {
        run: 'printf %s "$KICI_PROBE_RESERVED|$PROBE" > reserved.out',
        env: { KICI_PROBE_RESERVED: 'spec-value-must-not-print', PROBE: 'x' },
      },
    ]);
    expect(result.ok).toBe(true);
    // breaks-if-wrong: a KICI_* key in spec.env overrides the reserved value
    expect(await readFile(join(dir, 'reserved.out'), 'utf8')).toBe('agent-value|x');
    expect(logText).toContain('"KICI_PROBE_RESERVED"');
    // fails-when: the refusal log echoes the refused value
    expect(logText).not.toContain('spec-value-must-not-print');
  });

  it('an operator secret key keeps the operator value', async () => {
    vi.stubEnv('PROBE_OPERATOR_SECRET', 'operator');
    const { dir, logText } = await runReal(
      [
        {
          run: 'printf %s "$PROBE_OPERATOR_SECRET" > secret.out',
          env: { PROBE_OPERATOR_SECRET: 'spec' },
        },
      ],
      new Set(['PROBE_OPERATOR_SECRET']),
    );
    // fails-when: protectedEnvKeys is not consulted
    expect(await readFile(join(dir, 'secret.out'), 'utf8')).toBe('operator');
    expect(logText).toContain('"PROBE_OPERATOR_SECRET"');
  });

  it('a spec env key does not leak into the next init or into process.env', async () => {
    const { dir, result } = await runReal([
      { run: 'true', env: { PROBE_LEAK: 'x' } },
      { run: 'printf %s "${PROBE_LEAK:-unset}" > leak.out' },
    ]);
    expect(result.ok).toBe(true);
    // breaks-if-wrong: the overlay is written into process.env and reaches later inits and steps
    expect(await readFile(join(dir, 'leak.out'), 'utf8')).toBe('unset');
    expect(process.env.PROBE_LEAK).toBeUndefined();
  });
});
