/**
 * Tests for JSONPath payload matching utility.
 */
import { describe, it, expect } from 'vitest';
import { matchJsonPath, matchJsonPathNot } from './jsonpath-matcher.js';

describe('matchJsonPath', () => {
  it('matches exact value at top-level path', () => {
    const payload = { env: 'prod', region: 'us-east' };
    expect(matchJsonPath(payload, { '$.env': 'prod' })).toBe(true);
    expect(matchJsonPath(payload, { '$.env': 'staging' })).toBe(false);
  });

  it('matches nested path', () => {
    const payload = { data: { status: 'deployed', version: 3 } };
    expect(matchJsonPath(payload, { '$.data.status': 'deployed' })).toBe(true);
    expect(matchJsonPath(payload, { '$.data.status': 'pending' })).toBe(false);
  });

  it('matches numeric values', () => {
    const payload = { count: 42, data: { level: 5 } };
    expect(matchJsonPath(payload, { '$.count': 42 })).toBe(true);
    expect(matchJsonPath(payload, { '$.count': 43 })).toBe(false);
    expect(matchJsonPath(payload, { '$.data.level': 5 })).toBe(true);
  });

  it('matches boolean values', () => {
    const payload = { active: true, debug: false };
    expect(matchJsonPath(payload, { '$.active': true })).toBe(true);
    expect(matchJsonPath(payload, { '$.active': false })).toBe(false);
    expect(matchJsonPath(payload, { '$.debug': false })).toBe(true);
  });

  it('matches null values', () => {
    const payload = { data: null, active: true };
    expect(matchJsonPath(payload, { '$.data': null })).toBe(true);
    expect(matchJsonPath(payload, { '$.active': null })).toBe(false);
  });

  it('returns false for missing path', () => {
    const payload = { env: 'prod' };
    expect(matchJsonPath(payload, { '$.nonexistent': 'value' })).toBe(false);
    expect(matchJsonPath(payload, { '$.deeply.nested.missing': 'value' })).toBe(false);
  });

  it('matches array element', () => {
    const payload = { tags: ['ci', 'deploy', 'prod'] };
    // JSONPath $.tags[*] returns all elements; any match = pass
    expect(matchJsonPath(payload, { '$.tags[*]': 'deploy' })).toBe(true);
    expect(matchJsonPath(payload, { '$.tags[*]': 'staging' })).toBe(false);
  });

  it('matches with array of acceptable values', () => {
    const payload = { env: 'staging' };
    expect(matchJsonPath(payload, { '$.env': ['prod', 'staging'] })).toBe(true);
    expect(matchJsonPath(payload, { '$.env': ['prod', 'dev'] })).toBe(false);
  });

  it('matches empty match object (matches everything)', () => {
    const payload = { env: 'prod' };
    expect(matchJsonPath(payload, {})).toBe(true);
  });

  it('requires ALL expressions to match', () => {
    const payload = { env: 'prod', region: 'us-east' };
    expect(matchJsonPath(payload, { '$.env': 'prod', '$.region': 'us-east' })).toBe(true);
    expect(matchJsonPath(payload, { '$.env': 'prod', '$.region': 'eu-west' })).toBe(false);
    expect(matchJsonPath(payload, { '$.env': 'staging', '$.region': 'us-east' })).toBe(false);
  });

  it('matches regex string values', () => {
    const payload = { version: 'v2.3.1', name: 'release-candidate-42' };
    expect(matchJsonPath(payload, { '$.version': '/^v\\d+\\./' })).toBe(true);
    expect(matchJsonPath(payload, { '$.version': '/^v\\d+$/' })).toBe(false);
    expect(matchJsonPath(payload, { '$.name': '/candidate-\\d+/' })).toBe(true);
  });

  it('matches regex with flags', () => {
    const payload = { status: 'DEPLOYED' };
    expect(matchJsonPath(payload, { '$.status': '/^deployed$/i' })).toBe(true);
    expect(matchJsonPath(payload, { '$.status': '/^deployed$/' })).toBe(false);
  });

  it('handles deeply nested objects', () => {
    const payload = {
      deployment: {
        metadata: {
          labels: {
            env: 'production',
          },
        },
      },
    };
    expect(matchJsonPath(payload, { '$.deployment.metadata.labels.env': 'production' })).toBe(true);
  });
});

describe('matchJsonPathNot', () => {
  it('returns true when not is undefined', () => {
    expect(matchJsonPathNot({ env: 'prod' }, undefined)).toBe(true);
  });

  it('returns true when not is empty object', () => {
    expect(matchJsonPathNot({ env: 'prod' }, {})).toBe(true);
  });

  it('returns true when not-expression path is missing', () => {
    const payload = { env: 'prod' };
    expect(matchJsonPathNot(payload, { '$.nonexistent': 'value' })).toBe(true);
  });

  it('returns false when not-expression matches', () => {
    const payload = { env: 'prod' };
    expect(matchJsonPathNot(payload, { '$.env': 'prod' })).toBe(false);
  });

  it('returns true when not-expression does not match', () => {
    const payload = { env: 'prod' };
    expect(matchJsonPathNot(payload, { '$.env': 'staging' })).toBe(true);
  });

  it('checks multiple not-expressions (any match = fail)', () => {
    const payload = { env: 'prod', region: 'us-east' };
    // Both don't match -- pass
    expect(matchJsonPathNot(payload, { '$.env': 'staging', '$.region': 'eu-west' })).toBe(true);
    // One matches -- fail
    expect(matchJsonPathNot(payload, { '$.env': 'prod', '$.region': 'eu-west' })).toBe(false);
    // Both match -- fail
    expect(matchJsonPathNot(payload, { '$.env': 'prod', '$.region': 'us-east' })).toBe(false);
  });

  it('supports array of values in not-expressions', () => {
    const payload = { env: 'staging' };
    expect(matchJsonPathNot(payload, { '$.env': ['prod', 'staging'] })).toBe(false);
    expect(matchJsonPathNot(payload, { '$.env': ['prod', 'dev'] })).toBe(true);
  });
});
