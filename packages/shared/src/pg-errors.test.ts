import { describe, expect, it } from 'vitest';
import { isPgUndefinedTable, isPgUniqueViolation } from './pg-errors.js';

describe('isPgUniqueViolation', () => {
  it('returns true for a 23505 error matching the named constraint', () => {
    const err = { code: '23505', constraint: 'teams_org_name_uniq' };
    expect(isPgUniqueViolation(err, 'teams_org_name_uniq')).toBe(true);
  });

  it('returns true for the roles constraint', () => {
    const err = { code: '23505', constraint: 'roles_org_id_name_unique' };
    expect(isPgUniqueViolation(err, 'roles_org_id_name_unique')).toBe(true);
  });

  it('returns false for a 23505 error on a different constraint', () => {
    const err = { code: '23505', constraint: 'some_other_uniq' };
    expect(isPgUniqueViolation(err, 'teams_org_name_uniq')).toBe(false);
  });

  it('returns true for any 23505 when no constraint is requested', () => {
    expect(isPgUniqueViolation({ code: '23505' })).toBe(true);
  });

  it('returns false for a non-unique pg error code', () => {
    expect(
      isPgUniqueViolation(
        { code: '23503', constraint: 'teams_org_name_uniq' },
        'teams_org_name_uniq',
      ),
    ).toBe(false);
  });

  it('returns false for null, non-objects, and errors without a code', () => {
    expect(isPgUniqueViolation(null)).toBe(false);
    expect(isPgUniqueViolation('boom')).toBe(false);
    expect(isPgUniqueViolation(new Error('plain'))).toBe(false);
    expect(isPgUniqueViolation({ constraint: 'teams_org_name_uniq' }, 'teams_org_name_uniq')).toBe(
      false,
    );
  });
});

describe('isPgUndefinedTable', () => {
  // fails-when: a missing licensing or migration table is read as an ordinary error
  it('returns true for a 42P01 error', () => {
    expect(isPgUndefinedTable({ code: '42P01' })).toBe(true);
  });

  // breaks-if-wrong: any other database error is taken for a missing table
  it.each([{ code: '42703' }, { code: '23505' }, new Error('connection refused'), null, '42P01'])(
    'returns false for %s',
    (err) => {
      expect(isPgUndefinedTable(err)).toBe(false);
    },
  );
});
