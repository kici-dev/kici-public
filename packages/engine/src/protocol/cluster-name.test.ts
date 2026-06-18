import { describe, expect, it } from 'vitest';
import {
  CLUSTER_NAME_FORMAT_MESSAGE,
  CLUSTER_NAME_MAX_LENGTH,
  CLUSTER_NAME_REGEX,
  clusterNameSchema,
  generateClusterName,
} from './cluster-name.js';

describe('CLUSTER_NAME_REGEX', () => {
  const valid = [
    'cluster-a3f9b1',
    'production',
    'production-arm',
    'p',
    'a-b-c-d',
    'cluster1',
    'a' + '1'.repeat(62), // 63 chars total
  ];
  for (const name of valid) {
    it(`accepts ${name}`, () => {
      expect(CLUSTER_NAME_REGEX.test(name)).toBe(true);
    });
  }

  const invalid = [
    '', // empty
    '1cluster', // starts with digit
    '-cluster', // starts with hyphen
    'Cluster', // uppercase
    'cluster_name', // underscore not allowed
    'cluster.name', // dot not allowed
    'cluster name', // space not allowed
    'cluster/name', // slash not allowed
    'a' + 'b'.repeat(63), // 64 chars
  ];
  for (const name of invalid) {
    it(`rejects ${JSON.stringify(name)}`, () => {
      expect(CLUSTER_NAME_REGEX.test(name)).toBe(false);
    });
  }
});

describe('clusterNameSchema', () => {
  it('parses a valid name', () => {
    expect(clusterNameSchema.parse('production')).toBe('production');
  });

  it('rejects an invalid name with the documented message', () => {
    const result = clusterNameSchema.safeParse('Bad_Name');
    expect(result.success).toBe(false);
    if (!result.success) {
      const issue = result.error.issues[0];
      expect(issue?.message).toBe(CLUSTER_NAME_FORMAT_MESSAGE);
    }
  });

  it('rejects an empty string with the documented message', () => {
    const result = clusterNameSchema.safeParse('');
    expect(result.success).toBe(false);
    if (!result.success) {
      // zod emits min-length and regex issues — at least one must carry the message
      const messages = result.error.issues.map((i) => i.message);
      expect(messages).toContain(CLUSTER_NAME_FORMAT_MESSAGE);
    }
  });

  it('rejects an over-length string', () => {
    const tooLong = 'a' + 'b'.repeat(CLUSTER_NAME_MAX_LENGTH);
    expect(tooLong.length).toBe(CLUSTER_NAME_MAX_LENGTH + 1);
    const result = clusterNameSchema.safeParse(tooLong);
    expect(result.success).toBe(false);
  });
});

describe('generateClusterName', () => {
  it('returns a regex-conforming cluster-<6hex> name from fixed bytes', () => {
    const fixedBytes = (size: number) =>
      new Uint8Array(Array.from({ length: size }, (_, i) => (i + 1) * 17));
    const name = generateClusterName(fixedBytes);
    // (1*17, 2*17, 3*17) = (17, 34, 51) = 0x11, 0x22, 0x33
    expect(name).toBe('cluster-112233');
    expect(CLUSTER_NAME_REGEX.test(name)).toBe(true);
  });

  it('produces distinct names for distinct randomness', () => {
    let counter = 0;
    const incrementing = (size: number) =>
      new Uint8Array(Array.from({ length: size }, () => counter++));
    const first = generateClusterName(incrementing);
    const second = generateClusterName(incrementing);
    expect(first).not.toBe(second);
  });
});
