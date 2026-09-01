import { describe, expect, it } from 'vitest';
import {
  TraceCheck,
  TraceVerdict,
  appendChecks,
  createCommitMessageTraceEntry,
  createContentRequirementsTraceEntry,
  createGlobalFilterTraceEntry,
  createTraceEntry,
  createWorkflowDecision,
  TRACE_TEXT_MAX,
} from './decision-trace.js';

/** A workflow whose triggers matched — the state both global gates run against. */
function matchedDecision(workflowName = 'org-ci') {
  return createWorkflowDecision(workflowName, true, [
    createTraceEntry('event type', 'push', 'push', true),
  ]);
}

describe('global-workflow trace entries', () => {
  it('records a filter exclusion in the decision trace', () => {
    const decision = appendChecks(matchedDecision(), [
      createGlobalFilterTraceEntry({ run: false, reason: 'filter returned false' }),
    ]);

    expect(decision.checks).toContainEqual(
      expect.objectContaining({ check: TraceCheck.GlobalFilter, passed: false }),
    );
    // Positive control: the trigger check that DID pass is still in the trace,
    // so the assertion above is reading an appended entry rather than an
    // emptied-out array.
    expect(decision.checks).toContainEqual(
      expect.objectContaining({ check: 'event type', passed: true }),
    );
  });

  it('demotes a matched decision when the filter excludes it', () => {
    const decision = appendChecks(matchedDecision(), [
      createGlobalFilterTraceEntry({ run: false, reason: 'filter returned false' }),
    ]);

    expect(decision.matched).toBe(false);
    expect(decision.summary).toBe('filter returned false');
  });

  it('leaves a matched decision matched when the filter admits it', () => {
    const decision = appendChecks(matchedDecision(), [createGlobalFilterTraceEntry({ run: true })]);

    expect(decision.matched).toBe(true);
    expect(decision.summary).toBe('Trigger conditions met');
    expect(decision.checks.at(-1)).toMatchObject({
      check: TraceCheck.GlobalFilter,
      value: TraceVerdict.Matched,
      passed: true,
    });
  });

  it('distinguishes an undecided filter from an excluding one', () => {
    const undecided = createGlobalFilterTraceEntry({
      run: false,
      indeterminate: true,
      reason: 'the global eval round returned no verdict for this workflow',
    });
    const excluded = createGlobalFilterTraceEntry({ run: false });

    expect(undecided.value).toBe(TraceVerdict.Indeterminate);
    expect(excluded.value).toBe(TraceVerdict.Excluded);
    // Both are still failures — an undecided gate must never read as a pass.
    expect(undecided.passed).toBe(false);
    expect(excluded.passed).toBe(false);
  });

  it('names the files a requires exclusion inspected', () => {
    const entry = createContentRequirementsTraceEntry({
      files: ['package.json', 'Dockerfile'],
      passed: false,
      reason: 'package.json: $.private is not false',
    });

    expect(entry).toMatchObject({
      check: TraceCheck.ContentRequirements,
      pattern: 'package.json, Dockerfile',
      value: TraceVerdict.Excluded,
      passed: false,
      reason: 'package.json: $.private is not false',
    });
  });

  it('distinguishes an unevaluable requires from an excluding one', () => {
    // The two drops mean opposite things to an author: a content mismatch is
    // the requirement working, while an unreadable file or a provider with no
    // file-contents fetcher means nothing ever read it.
    const unreadable = createContentRequirementsTraceEntry({
      files: ['package.json'],
      passed: false,
      indeterminate: true,
      reason: 'no file-contents fetcher available for this provider',
    });
    const mismatch = createContentRequirementsTraceEntry({
      files: ['package.json'],
      passed: false,
      reason: 'content requirements not satisfied',
    });

    expect(unreadable.value).toBe(TraceVerdict.Indeterminate);
    expect(mismatch.value).toBe(TraceVerdict.Excluded);
    // Both still fail — an unevaluable requirement never passes silently.
    expect(unreadable.passed).toBe(false);
    expect(mismatch.passed).toBe(false);
  });

  it('records an empty requires list without inventing a file name', () => {
    const entry = createContentRequirementsTraceEntry({ files: [], passed: true });
    expect(entry.pattern).toBe('(no files)');
    expect(entry.value).toBe(TraceVerdict.Matched);
  });

  it('does not mutate the decision it appends to', () => {
    const original = matchedDecision();
    const before = original.checks.length;

    appendChecks(original, [createGlobalFilterTraceEntry({ run: false })]);

    expect(original.checks).toHaveLength(before);
    expect(original.matched).toBe(true);
  });

  it('reports the first failing gate when both are appended', () => {
    const decision = appendChecks(matchedDecision(), [
      createContentRequirementsTraceEntry({
        files: ['package.json'],
        passed: false,
        reason: 'package.json: missing',
      }),
      createGlobalFilterTraceEntry({ run: false }),
    ]);

    expect(decision.matched).toBe(false);
    expect(decision.summary).toBe('package.json: missing');
  });
});

describe('createCommitMessageTraceEntry', () => {
  it('records the matched verdict in the value slot and describes the matcher in pattern', () => {
    const entry = createCommitMessageTraceEntry({
      match: { notContains: ['[skip ci]'] },
      text: 'feat: thing',
      passed: true,
    });
    expect(entry.check).toBe(TraceCheck.CommitMessage);
    expect(entry.value).toBe(TraceVerdict.Matched);
    expect(entry.pattern).toBe('notContains: [[skip ci]]');
    expect(entry.reason).toContain('feat: thing');
  });

  it('records an absent message as indeterminate, not excluded', () => {
    const entry = createCommitMessageTraceEntry({
      match: { contains: ['deploy'] },
      text: undefined,
      passed: false,
      indeterminate: true,
      reason: 'no commit message in payload',
    });
    expect(entry.value).toBe(TraceVerdict.Indeterminate);
    expect(entry.reason).toBe('no commit message in payload');
  });

  it('truncates an essay-length body in the trace', () => {
    const entry = createCommitMessageTraceEntry({
      match: { contains: ['x'] },
      text: 'a'.repeat(500),
      passed: true,
    });
    expect(entry.reason?.length).toBeLessThan(500);
    expect(entry.reason).toContain('…');
  });
});

describe('trace text bounding', () => {
  it('truncates every free-text field a trace entry carries', () => {
    const entry = createTraceEntry(
      'paths',
      'i'.repeat(5_000),
      'v'.repeat(100_000),
      false,
      'r'.repeat(5_000),
    );

    // The `check` label is a fixed vocabulary and is left alone; the three
    // fields fed from event content are each bounded on their own.
    expect(entry.check).toBe('paths');
    expect(entry.pattern.length).toBeLessThanOrEqual(TRACE_TEXT_MAX + 1);
    expect(entry.value.length).toBeLessThanOrEqual(TRACE_TEXT_MAX + 1);
    expect(entry.reason?.length).toBeLessThanOrEqual(TRACE_TEXT_MAX + 1);
    expect(entry.value).toContain('…');
  });

  it('leaves a short entry byte-identical', () => {
    const entry = createTraceEntry('branch', 'main', 'main', true, 'ok');
    expect(entry).toEqual({
      check: 'branch',
      pattern: 'main',
      value: 'main',
      passed: true,
      reason: 'ok',
    });
  });

  it('keeps an absent reason absent rather than truncating it into a string', () => {
    expect(createTraceEntry('branch', 'main', 'main', true).reason).toBeUndefined();
  });
});
