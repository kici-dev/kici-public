/**
 * Tests for `kici-admin held-run`.
 *
 * Three things are asserted that a route-level test cannot see:
 *
 * 1. **The registration seam.** The real `buildProgram()` is walked, so a
 *    command file that exists but is never registered fails here rather than
 *    silently shipping as no command at all. That seam is the recurring
 *    unmutated shape on this plan.
 * 2. **Hold resolution is the SHARED resolver.** The disambiguation error text
 *    is `resolveHeldRunId`'s own, so a second local resolver would show up as a
 *    different message.
 * 3. **Nothing is POSTed when resolution fails.** An ambiguous `--job` must not
 *    answer an arbitrary one of the two holds it matched.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { Command } from 'commander';
import { HoldType } from '@kici-dev/engine';
import { registerHeldRunCommands, formatHeldRuns, formatDecision } from './held-run.js';
import { buildProgram } from '../kici-admin.js';
import type { AdminApiClient } from '../api-client.js';

const ORG = 'org-1';
const RUN = 'run-abc';

const REVIEWER_HOLD = {
  id: 'hold-rev',
  runId: RUN,
  jobId: 'build',
  holdScope: 'job' as const,
  stepIndex: null,
  status: 'pending',
  holdType: HoldType.enum.reviewer,
  queueType: 'context',
  reason: 'Held for approval',
  expiresAt: '2026-08-29T00:00:00Z',
  clauses: [],
};

const SECURITY_HOLD = {
  ...REVIEWER_HOLD,
  id: 'hold-sec',
  holdType: HoldType.enum.security,
  queueType: 'security',
};

function harness(heldRuns: unknown[]) {
  const get = vi.fn().mockResolvedValue({ heldRuns });
  const post = vi.fn().mockResolvedValue({ status: 'released' });
  const program = new Command();
  program.exitOverride();
  registerHeldRunCommands(program, () => ({ get, post }) as unknown as AdminApiClient);
  return { program, get, post };
}

const BASE = ['node', 'kici-admin', 'held-run'];

describe('kici-admin held-run', () => {
  let exit: ReturnType<typeof vi.spyOn>;
  let errors: string[];

  beforeEach(() => {
    errors = [];
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation((msg: unknown) => {
      errors.push(String(msg));
    });
    // `process.exit` is called on a resolution failure; throwing instead lets
    // the test observe that the POST never happened.
    exit = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Error(`exit:${code}`);
    }) as never);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    exit.mockRestore();
  });

  it('is registered on the real kici-admin program, with all three leaves', () => {
    const group = buildProgram().commands.find((c) => c.name() === 'held-run');
    expect(group).toBeDefined();
    expect(group!.commands.map((c) => c.name()).sort()).toEqual(['approve', 'list', 'reject']);
  });

  it('lists a run’s pending holds through the admin route', async () => {
    const { program, get } = harness([REVIEWER_HOLD]);
    await program.parseAsync([...BASE, 'list', '--customer-id', ORG, '--run-id', RUN]);
    expect(get).toHaveBeenCalledWith(`/api/v1/admin/held-runs?customerId=${ORG}&runId=${RUN}`);
  });

  it('approves the sole pending hold with no filter', async () => {
    const { program, post } = harness([REVIEWER_HOLD]);
    await program.parseAsync([...BASE, 'approve', '--customer-id', ORG, '--run-id', RUN]);
    expect(post).toHaveBeenCalledWith('/api/v1/admin/held-runs/decision', {
      customerId: ORG,
      heldRunId: 'hold-rev',
      decision: 'approve',
    });
  });

  it('refuses to guess between a job’s two holds, and POSTs nothing', async () => {
    // The shape Task 11h named: one job gated by a reviewer hold AND a security
    // hold writes two pending rows, and both must be answered separately.
    const { program, post } = harness([REVIEWER_HOLD, SECURITY_HOLD]);
    await expect(
      program.parseAsync([...BASE, 'approve', '--customer-id', ORG, '--run-id', RUN]),
    ).rejects.toThrow('exit:1');
    expect(post).not.toHaveBeenCalled();
    // The shared resolver's own message, listing both candidates with the flags
    // that separate them.
    expect(errors.join('\n')).toContain('--hold-type <type>');
    expect(errors.join('\n')).toContain('build (reviewer)');
    expect(errors.join('\n')).toContain('build (security)');
  });

  it('separates that pair with --hold-type', async () => {
    const { program, post } = harness([REVIEWER_HOLD, SECURITY_HOLD]);
    await program.parseAsync([
      ...BASE,
      'approve',
      '--customer-id',
      ORG,
      '--run-id',
      RUN,
      '--hold-type',
      HoldType.enum.security,
    ]);
    expect(post.mock.calls[0][1]).toMatchObject({ heldRunId: 'hold-sec' });
  });

  it('separates that pair with --hold', async () => {
    const { program, post } = harness([REVIEWER_HOLD, SECURITY_HOLD]);
    await program.parseAsync([
      ...BASE,
      'approve',
      '--customer-id',
      ORG,
      '--run-id',
      RUN,
      '--hold',
      'hold-rev',
    ]);
    expect(post.mock.calls[0][1]).toMatchObject({ heldRunId: 'hold-rev' });
  });

  it('sends the reject reason, which commander requires', async () => {
    const { program, post } = harness([REVIEWER_HOLD]);
    post.mockResolvedValue({ status: 'rejected' });
    await program.parseAsync([
      ...BASE,
      'reject',
      '--customer-id',
      ORG,
      '--run-id',
      RUN,
      '--reason',
      'not this one',
    ]);
    expect(post).toHaveBeenCalledWith('/api/v1/admin/held-runs/decision', {
      customerId: ORG,
      heldRunId: 'hold-rev',
      decision: 'reject',
      reason: 'not this one',
    });
  });

  it('refuses a reject with no reason before any request is made', async () => {
    const { program, get, post } = harness([REVIEWER_HOLD]);
    await expect(
      program.parseAsync([...BASE, 'reject', '--customer-id', ORG, '--run-id', RUN]),
    ).rejects.toThrow(/reason/);
    expect(get).not.toHaveBeenCalled();
    expect(post).not.toHaveBeenCalled();
  });

  it('surfaces the route’s own refusal verbatim rather than rewording it', async () => {
    const { program, post } = harness([REVIEWER_HOLD]);
    post.mockRejectedValue(new Error('Held runs are answered through the KiCI Platform'));
    await expect(
      program.parseAsync([...BASE, 'approve', '--customer-id', ORG, '--run-id', RUN]),
    ).rejects.toThrow('exit:1');
    expect(errors.join('\n')).toContain('Held runs are answered through the KiCI Platform');
  });
});

describe('held-run rendering', () => {
  it('prints the hold id and the approvers a clause-bearing hold needs', () => {
    const out = formatHeldRuns(
      { heldRuns: [{ ...REVIEWER_HOLD, clauses: [{ team: 'platform' }, { user: 'alice' }] }] },
      'table',
    );
    // The id is the `--hold <id>` disambiguator, so it must be printed.
    expect(out).toContain('hold-rev');
    expect(out).toContain('{team}platform AND alice');
  });

  it('says who may approve when a hold names nobody', () => {
    expect(formatHeldRuns({ heldRuns: [REVIEWER_HOLD] }, 'table')).toContain('anyone eligible');
  });

  it('says so plainly when a run has no pending holds', () => {
    expect(formatHeldRuns({ heldRuns: [] }, 'table')).toBe('No pending holds for this run.');
  });

  it('renders json verbatim', () => {
    expect(JSON.parse(formatHeldRuns({ heldRuns: [REVIEWER_HOLD] }, 'json')).heldRuns).toHaveLength(
      1,
    );
  });

  it('distinguishes a released hold from one still waiting on other clauses', () => {
    expect(formatDecision({ status: 'released' }, 'approve')).toContain('re-dispatched');
    expect(formatDecision({ status: 'pending', remainingClauses: 2 }, 'approve')).toContain(
      '2 clause(s) remain',
    );
    expect(formatDecision({ status: 'rejected' }, 'reject')).toContain('cancelled');
  });
});

describe('the four disambiguators reach the shared resolver', () => {
  let exit: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    exit = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Error(`exit:${code}`);
    }) as never);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    exit.mockRestore();
  });

  const OTHER_JOB = { ...REVIEWER_HOLD, id: 'hold-other', jobId: 'deploy' };
  const STEP_HOLD = {
    ...REVIEWER_HOLD,
    id: 'hold-step',
    holdScope: 'step' as const,
    stepIndex: 2,
  };

  it('forwards --job', async () => {
    const { program, post } = harness([REVIEWER_HOLD, OTHER_JOB]);
    await program.parseAsync([
      ...BASE,
      'approve',
      '--customer-id',
      ORG,
      '--run-id',
      RUN,
      '--job',
      'deploy',
    ]);
    expect(post.mock.calls[0][1]).toMatchObject({ heldRunId: 'hold-other' });
  });

  it('forwards --step, which the resolver requires --job alongside', async () => {
    const { program, post } = harness([REVIEWER_HOLD, STEP_HOLD]);
    await program.parseAsync([
      ...BASE,
      'approve',
      '--customer-id',
      ORG,
      '--run-id',
      RUN,
      '--job',
      'build',
      '--step',
      '2',
    ]);
    expect(post.mock.calls[0][1]).toMatchObject({ heldRunId: 'hold-step' });
  });

  it('forwards --job on reject too, not only on approve', async () => {
    const { program, post } = harness([REVIEWER_HOLD, OTHER_JOB]);
    post.mockResolvedValue({ status: 'rejected' });
    await program.parseAsync([
      ...BASE,
      'reject',
      '--customer-id',
      ORG,
      '--run-id',
      RUN,
      '--job',
      'deploy',
      '--reason',
      'no',
    ]);
    expect(post.mock.calls[0][1]).toMatchObject({ heldRunId: 'hold-other', decision: 'reject' });
  });
});
