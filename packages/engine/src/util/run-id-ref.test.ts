import { describe, it, expect } from 'vitest';
import {
  invalidRunIdMessage,
  isRunId,
  parseRunIdRef,
  pickRunIdMatch,
  runIdHasPrefix,
  runIdPrefixRange,
} from './run-id-ref.js';

const RUN_ID = '709c899a-b06f-45d0-a3e2-d0a14fa62094';

describe('parseRunIdRef', () => {
  it('reads a full run id as itself, lowercased', () => {
    // breaks-if-wrong: a full id never goes through prefix resolution
    expect(parseRunIdRef(RUN_ID.toUpperCase())).toEqual({ kind: 'uuid', runId: RUN_ID });
  });

  it('reads the short id people copy as a prefix', () => {
    // fails-when: an 8-character short id is refused or passed on as a run id
    expect(parseRunIdRef('709c899a')).toEqual({ kind: 'prefix', hex: '709c899a' });
    expect(parseRunIdRef('709C899A-b06f')).toEqual({ kind: 'prefix', hex: '709c899ab06f' });
  });

  it('refuses text that cannot start a run id, and a prefix that is too short', () => {
    expect(parseRunIdRef('not-a-run').kind).toBe('invalid');
    expect(parseRunIdRef('').kind).toBe('invalid');
    expect(parseRunIdRef('709').kind).toBe('invalid');
    expect(parseRunIdRef('709c899ab06f45d0a3e2d0a14fa620941').kind).toBe('invalid');
  });
});

describe('runIdPrefixRange', () => {
  it('bounds exactly the run ids that start with the prefix', () => {
    const { low, high } = runIdPrefixRange('709c899a');
    expect(low).toBe('709c899a-0000-0000-0000-000000000000');
    expect(high).toBe('709c899a-ffff-ffff-ffff-ffffffffffff');
    // fails-when: the range misses a run id with the prefix
    expect(RUN_ID >= low && RUN_ID <= high).toBe(true);
    // breaks-if-wrong: a neighbouring id outside the prefix stays outside
    const next = '709c899b-0000-0000-0000-000000000000';
    expect(next >= low && next <= high).toBe(false);
  });

  it('keeps every bound a valid run id, for a prefix that crosses a hyphen', () => {
    const { low, high } = runIdPrefixRange('709c899ab0');
    expect(isRunId(low) && isRunId(high)).toBe(true);
    expect(low).toBe('709c899a-b000-0000-0000-000000000000');
  });
});

describe('runIdHasPrefix', () => {
  it('compares hex digits, ignoring hyphens and case', () => {
    expect(runIdHasPrefix(RUN_ID, '709c899ab06f')).toBe(true);
    expect(runIdHasPrefix(RUN_ID.toUpperCase(), '709c899a')).toBe(true);
    expect(runIdHasPrefix(RUN_ID, '709c899b')).toBe(false);
  });
});

describe('pickRunIdMatch', () => {
  const hint = 'list shows ids';
  it('returns the one match when nothing else is unseen', () => {
    expect(pickRunIdMatch({ ref: '709c', matches: [RUN_ID], unseen: 0, findHint: hint })).toBe(
      RUN_ID,
    );
  });

  it('fails naming the matches, and how many more exist', () => {
    // fails-when: one of several matches is picked silently
    expect(() =>
      pickRunIdMatch({ ref: '709c', matches: [RUN_ID], unseen: 2, findHint: hint }),
    ).toThrow(`Run id prefix '709c' is ambiguous: it matches ${RUN_ID}, and 2 more.`);
  });

  it('fails saying no run matches, and where full ids are', () => {
    expect(() => pickRunIdMatch({ ref: 'dead', matches: [], unseen: 0, findHint: hint })).toThrow(
      "No run id starts with 'dead' (list shows ids).",
    );
    expect(invalidRunIdMessage('x', 'why', hint)).toBe(
      "Invalid run id 'x': why. Pass a full run id, or its first 4 or more characters (list shows ids).",
    );
  });
});
