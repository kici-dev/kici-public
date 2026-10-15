import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { PendingGlobalEvalTracker, parseGlobalEvalResult } from './pending-global-evals.js';

/**
 * Hostile payloads an agent can put on `job.status`. `jobStatusSchema.data` is
 * `z.record(z.string(), z.unknown())`, so the round result arrives unchecked:
 * any agent owning the round job can send these, and a version-skewed customer
 * agent can send them by accident.
 */
const HOSTILE: Array<[label: string, payload: unknown]> = [
  ['an empty object', {}],
  ['a string', 'not a result'],
  ['a number', 42],
  ['a boolean', true],
  ['an array', [{ workflowName: 'a', run: true }]],
  ['null', null],
  ['undefined', undefined],
  ['candidates as a string', { candidates: 'x' }],
  ['candidates as an object', { candidates: { workflowName: 'a' } }],
  ['a candidate missing run', { candidates: [{ workflowName: 'a' }] }],
  ['a candidate with a non-string name', { candidates: [{ workflowName: 7, run: true }] }],
];

describe('parseGlobalEvalResult', () => {
  it('accepts a well-formed result', () => {
    // Positive control: the parser does not reject everything.
    const parsed = parseGlobalEvalResult({
      candidates: [{ workflowName: 'org-ci', run: true, jobs: [{ name: 'gen-a' }] }],
    });
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.value.candidates[0].workflowName).toBe('org-ci');
      expect(parsed.value.candidates[0].jobs).toEqual([{ name: 'gen-a' }]);
    }
  });

  it('accepts an empty candidate list', () => {
    expect(parseGlobalEvalResult({ candidates: [] }).ok).toBe(true);
  });

  it.each(HOSTILE)('rejects %s with a readable error', (_label, payload) => {
    const parsed = parseGlobalEvalResult(payload);
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.error).toContain('malformed result');
  });
});

describe('PendingGlobalEvalTracker', () => {
  it('resolves a well-formed result', async () => {
    const tracker = new PendingGlobalEvalTracker();
    const promise = tracker.track('job-1');
    tracker.resolve('job-1', { candidates: [{ workflowName: 'a', run: true }] });
    await expect(promise).resolves.toEqual({
      candidates: [{ workflowName: 'a', run: true }],
    });
  });

  it('rejects cleanly on the boundary error rather than throwing at resolve time', async () => {
    const tracker = new PendingGlobalEvalTracker();
    const promise = tracker.track('job-1');
    const parsed = parseGlobalEvalResult({});
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) tracker.reject('job-1', new Error(parsed.error));
    await expect(promise).rejects.toThrow(/malformed result/);
  });

  it.each(HOSTILE)(
    'survives %s reaching resolve() directly, without throwing on the message path',
    async (_label, payload) => {
      // `PendingTracker.resolve` calls `extractResolveMeta` SYNCHRONOUSLY on the agent
      // WebSocket message path; a throw there escapes into an unawaited promise, which
      // the process-level handler turns into a shutdown. So this asserts the call
      // itself does not throw, not merely that the tracked promise settles.
      const tracker = new PendingGlobalEvalTracker();
      const promise = tracker.track('job-1');
      expect(() => tracker.resolve('job-1', payload as never)).not.toThrow();
      await expect(promise).resolves.toBe(payload);
    },
  );
});

/**
 * Source-level guard on the message boundary. A unit test cannot observe
 * `createApp`'s `onJobStatus` callback without the whole agent WebSocket server,
 * but the property is textual: the round result must be **parsed** where it
 * arrives, never cast. It arrives in `settlePendingPrecursor`
 * (`precursor-result.ts`), which `app.ts` hands every agent `job.status` frame
 * to, so both files are read. Same idiom as the agent's cross-file ordering
 * guards.
 */
describe('the agent job.status boundary wires the round result through the parser', () => {
  const settleSource = readFileSync(
    fileURLToPath(new URL('./precursor-result.ts', import.meta.url)),
    'utf8',
  );
  const appSource = readFileSync(fileURLToPath(new URL('../app.ts', import.meta.url)), 'utf8');

  it('reads globalEvalResult in exactly one place (positive control)', () => {
    const reads = settleSource.match(/globalEvalResult/g) ?? [];
    expect(reads).toHaveLength(1);
    // fails-when: app.ts grows its own read of the payload beside the settle
    // function — a second, uncovered boundary.
    expect(appSource.match(/globalEvalResult/g) ?? []).toHaveLength(0);
  });

  it('parses that read instead of casting it', () => {
    expect(settleSource).toContain('parseGlobalEvalResult(data.globalEvalResult)');
    // A cast would silently hand arbitrary agent JSON to a consumer that
    // dereferences it.
    expect(settleSource).not.toContain('as GlobalEvalRoundResult');
    expect(appSource).not.toContain('as GlobalEvalRoundResult');
  });

  it('rejects the pending round when the parse fails', () => {
    const branch = settleSource.slice(
      settleSource.indexOf('parseGlobalEvalResult(data.globalEvalResult)'),
    );
    expect(branch.slice(0, 400)).toContain('pendingGlobalEvals.reject(jobId');
  });

  it('app.ts hands the agent frame to the shared settle function', () => {
    // fails-when: app.ts settles a tracker inline again, so the local socket
    // and the shared-database channel can drift on what "finished" means.
    expect(appSource).toContain('settlePendingPrecursor(');
    expect(appSource).not.toContain('deps.pendingGlobalEvals.resolve(');
    expect(appSource).not.toContain('deps.pendingBuilds.resolve(');
  });
});
