import { describe, expect, it, vi } from 'vitest';
import {
  createCompileSchemaView,
  gateLabelSets,
  judgeCompileSchema,
  withRerunLockNote,
  type CompileSchemaCandidate,
} from './compile-schema-gate.js';
import type { LockJob } from '@kici-dev/engine';
import type { WorkflowDispatchContext } from './dispatch-matched-workflow.js';

const known = (
  schema: number | null,
  release: string | null = '0.24.0',
): CompileSchemaCandidate => ({
  source: `agent:${schema}`,
  schema,
  release,
});

describe('judgeCompileSchema', () => {
  it('doomed when every candidate is known and none matches', () => {
    expect(judgeCompileSchema(5, [known(7), known(7)])).toEqual({
      doomed: true,
      implementedSchema: 7,
      implementerRelease: '0.24.0',
    });
  });

  // fails-when: an unknown candidate (an agent that reports no schema) counts as a mismatch
  it('dispatches when one candidate is unknown', () => {
    expect(judgeCompileSchema(5, [known(7), known(null)])).toEqual({ doomed: false });
  });

  it('dispatches when there is no candidate', () => {
    expect(judgeCompileSchema(5, [])).toEqual({ doomed: false });
  });

  // fails-when: the rule compares with the orchestrator's COMPILE_SCHEMA_VERSION instead of the
  // candidates — a pinned older agent image would then be refused runs it can serve
  it("dispatches when the candidate implements the lock's schema even if the orchestrator does not", () => {
    expect(judgeCompileSchema(5, [known(5, '0.6.0')])).toEqual({ doomed: false });
  });

  it('names the lowest schema and no release when candidates disagree', () => {
    expect(judgeCompileSchema(5, [known(8, '0.30.0'), known(7, '0.24.0')])).toEqual({
      doomed: true,
      implementedSchema: 7,
      implementerRelease: undefined,
    });
  });
});

describe('createCompileSchemaView', () => {
  const agent = (id: string, labels: string[], schema: number | null) => ({
    agentId: id,
    labels: new Set(labels),
    compileSchemaVersion: schema,
    version: '0.24.0',
  });
  const registry = (agents: ReturnType<typeof agent>[]) => ({
    getAllEntries: () => agents.values() as never,
    agentSatisfies: (a: { labels: Set<string> }, labels: string[]) =>
      labels.every((l) => a.labels.has(l)),
  });

  /** A scaler reporting `scaled` for any label set. */
  const scalerOf = (scaled: CompileSchemaCandidate[]) => ({
    compileSchemaForLabels: vi.fn(async () => scaled),
  });
  /** The candidates for `labelSets` of one linux agent implementing schema 7 and `scaler`. */
  const linuxCandidates = (scaler: ReturnType<typeof scalerOf>, labelSets: string[][]) =>
    createCompileSchemaView({
      registry: registry([agent('a', ['linux'], 7)]),
      scaler,
      livenessGraceMs: 1000,
    }).candidatesFor(labelSets);

  it('collects matching agents and the scaler match', async () => {
    const view = createCompileSchemaView({
      registry: registry([agent('a', ['linux', 'gpu'], 7), agent('b', ['windows'], 7)]),
      scaler: scalerOf([{ source: 'scaler:x', schema: 7, release: '0.24.0' }]),
      livenessGraceMs: 1000,
    });
    const candidates = await view.candidatesFor([['linux']]);
    expect(candidates.map((c) => c.source)).toEqual(['agent:a', 'scaler:x']);
  });

  // fails-when: an empty label set skips the scaler — a job with no exact label is then
  // judged on the connected agents alone, though `requestScale([])` would spawn one from
  // the first ungated label set
  it('asks the scaler for an empty label set too', async () => {
    const scaler = scalerOf([{ source: 'scaler:x', schema: null, release: null }]);
    const candidates = await linuxCandidates(scaler, [[]]);
    expect(scaler.compileSchemaForLabels).toHaveBeenCalledWith([]);
    expect(candidates.map((c) => c.source)).toEqual(['agent:a', 'scaler:x']);
    // breaks-if-wrong: the unknown scaler candidate keeps the run dispatching
    expect(judgeCompileSchema(5, candidates)).toEqual({ doomed: false });
  });

  // fails-when: the view keeps one scaler label set per label set asked — a job whose
  // exclusions move `requestScale` to another set is judged on a source it never spawns
  // breaks-if-wrong: an unknown eligible set keeps a run dispatching beside a known stale one
  it('keeps every eligible scaler label set as a candidate', async () => {
    const candidates = await linuxCandidates(
      scalerOf([
        { source: 'scaler:small', schema: 7, release: '0.24.0' },
        { source: 'scaler:large', schema: null, release: null },
      ]),
      [['linux']],
    );
    expect(candidates.map((c) => c.source)).toEqual(['agent:a', 'scaler:small', 'scaler:large']);
    expect(judgeCompileSchema(5, candidates)).toEqual({ doomed: false });
  });

  it('is a complete view without a DB', async () => {
    const view = createCompileSchemaView({ registry: registry([]), livenessGraceMs: 1000 });
    expect(await view.isCompleteView()).toBe(true);
  });
});

describe('gateLabelSets', () => {
  const job = (runsOn: unknown[]) => ({ name: 'j', runsOn }) as unknown as LockJob;
  const buildLabels = ['kici:role:builder', 'kici:os:linux', 'kici:arch:x64'];

  it('uses the build labels when the source build runs', () => {
    expect(
      gateLabelSets({ buildNeeded: true, sourceHit: false, buildLabels, staticJobs: [job([])] }),
    ).toEqual([buildLabels]);
  });

  it("uses each static job's exact labels on a cache hit", () => {
    expect(
      gateLabelSets({
        buildNeeded: true,
        sourceHit: true,
        buildLabels,
        staticJobs: [job([{ kind: 'exact', value: 'gpu' }])],
      }),
    ).toEqual([['gpu']]);
  });

  it('drops regex selectors', () => {
    expect(
      gateLabelSets({
        buildNeeded: false,
        sourceHit: false,
        buildLabels,
        staticJobs: [job([{ kind: 'regex', source: '^box-', flags: '' }])],
      }),
    ).toEqual([[]]);
  });
});

describe('withRerunLockNote', () => {
  const ctx = {
    rerunLineage: { parentRunId: 'p', originalRunId: 'o' },
    repoIdentifier: 'acme/app',
    ref: '1889df900fd4886706990f81ef150fe052a70f18',
  } as unknown as WorkflowDispatchContext;

  it('appends the note to a legacy agent mismatch on a re-run', () => {
    const reason = 'kici.lock.json was compiled by an incompatible @kici-dev/compiler: …';
    expect(withRerunLockNote(ctx, reason)).toContain('acme/app@1889df9');
  });

  it('does not repeat a note an agent already wrote', () => {
    const reason = withRerunLockNote(
      ctx,
      'The workflow lock was compiled for a different compile schema: x.',
    );
    expect(withRerunLockNote(ctx, reason)).toBe(reason);
  });

  // breaks-if-wrong: a first run, or another build failure, keeps its reason verbatim
  it('leaves other failures and first runs alone', () => {
    expect(withRerunLockNote(ctx, 'npm install failed')).toBe('npm install failed');
    const first = { ...ctx, rerunLineage: undefined } as WorkflowDispatchContext;
    const reason = 'kici.lock.json was compiled by an incompatible @kici-dev/compiler: …';
    expect(withRerunLockNote(first, reason)).toBe(reason);
  });
});
