import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { PendingGlobalEvalTracker, parseGlobalEvalResult } from './pending-global-evals.js';

/**
 * Hostile payloads an agent can put on `job.status`.
 *
 * `jobStatusSchema.data` is `z.record(z.string(), z.unknown())`, so
 * `globalEvalResult` reaches the orchestrator entirely unchecked — any agent
 * that owns the round job can send any of these, and a version-skewed customer
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
    // Positive control: the parser is not simply rejecting everything, so the
    // rejections below mean something.
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
      // `PendingTracker.resolve` calls `extractResolveMeta` SYNCHRONOUSLY, on
      // the agent WebSocket message path. A throw there escapes into a promise
      // nobody awaits, which the process-level handler turns into a shutdown —
      // so this asserts the call itself does not throw, not merely that the
      // tracked promise settles.
      const tracker = new PendingGlobalEvalTracker();
      const promise = tracker.track('job-1');
      expect(() => tracker.resolve('job-1', payload as never)).not.toThrow();
      await expect(promise).resolves.toBe(payload);
    },
  );
});

/**
 * Source-level guard on the message boundary.
 *
 * No unit test can observe `createApp`'s `onJobStatus` callback without standing
 * up the whole agent WebSocket server, but the property that matters is textual
 * and exact: the round result must be **parsed** where it arrives, never cast.
 * Same idiom the agent uses for its own cross-file ordering guards.
 */
describe('app.ts wires the round result through the parser', () => {
  const appSource = readFileSync(fileURLToPath(new URL('../app.ts', import.meta.url)), 'utf8');

  it('reads globalEvalResult in exactly one place (positive control)', () => {
    const reads = appSource.match(/globalEvalResult/g) ?? [];
    expect(reads).toHaveLength(1);
  });

  it('parses that read instead of casting it', () => {
    expect(appSource).toContain('parseGlobalEvalResult(msg.data.globalEvalResult)');
    // The cast this replaced would silently hand arbitrary agent JSON to a
    // consumer that dereferences it.
    expect(appSource).not.toContain('as GlobalEvalRoundResult');
  });

  it('rejects the pending round when the parse fails', () => {
    const branch = appSource.slice(
      appSource.indexOf('parseGlobalEvalResult(msg.data.globalEvalResult)'),
    );
    expect(branch.slice(0, 400)).toContain('deps.pendingGlobalEvals.reject(msg.jobId');
  });
});
