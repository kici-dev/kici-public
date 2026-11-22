import { describe, expect, it } from 'vitest';
import {
  CLIENT_VERSION_HEADER,
  PLATFORM_UPGRADE_REQUIRED_MESSAGE,
  RELEASE_VERSION_PATTERN,
  compareReleaseBase,
  describeComponentVersion,
  isNewerRelease,
  readComponentVersion,
} from './release-version.js';

describe('compareReleaseBase', () => {
  // breaks-if-wrong: a dev build of a release is refused by its own Platform
  it('0.30.0-4512 equals 0.30.0', () => {
    expect(compareReleaseBase('0.30.0-4512', '0.30.0')).toBe(0);
    expect(compareReleaseBase('0.30.0', '0.30.0-4512')).toBe(0);
    expect(isNewerRelease('0.30.0-4512', '0.30.0')).toBe(false);
    expect(isNewerRelease('0.30.0', '0.30.0-4512')).toBe(false);
  });

  // fails-when: a newer patch, minor or major is read as equal or older
  it('0.30.1 is newer than 0.30.0', () => {
    expect(compareReleaseBase('0.30.1', '0.30.0')).toBe(1);
    expect(isNewerRelease('0.30.1', '0.30.0')).toBe(true);
    expect(isNewerRelease('0.31.0', '0.30.9')).toBe(true);
  });

  // fails-when: the parts compare as strings, so "1" sorts before "0.99"
  it('1.0.0 is newer than 0.99.9', () => {
    expect(compareReleaseBase('1.0.0', '0.99.9')).toBe(1);
    expect(isNewerRelease('1.0.0', '0.99.9')).toBe(true);
    expect(isNewerRelease('0.10.0', '0.9.0')).toBe(true);
  });

  it('0.29.9 is not newer than 0.30.0', () => {
    expect(compareReleaseBase('0.29.9', '0.30.0')).toBe(-1);
    expect(isNewerRelease('0.29.9', '0.30.0')).toBe(false);
    expect(isNewerRelease('0.30.0', '0.30.0')).toBe(false);
  });

  // fails-when: a non-version compares as a version and decides a refusal
  it('a non-version string is rejected by the pattern', () => {
    for (const bad of [
      'unknown',
      '',
      '1.2',
      '1.2.3.4',
      'v1.2.3',
      '1.2.3+abc',
      ' 1.2.3',
      '1.2.3-',
    ]) {
      expect(RELEASE_VERSION_PATTERN.test(bad), bad).toBe(false);
      expect(() => compareReleaseBase(bad, '1.0.0'), bad).toThrow(/not a release version/);
      expect(() => compareReleaseBase('1.0.0', bad), bad).toThrow(/not a release version/);
    }
    for (const good of ['0.0.1', '0.30.0', '0.30.0-4512', '1.0.0-rc.1', '10.20.30-a-b.c']) {
      expect(RELEASE_VERSION_PATTERN.test(good), good).toBe(true);
    }
  });
});

describe('the handshake constants', () => {
  it('match the wire contract', () => {
    expect(CLIENT_VERSION_HEADER).toBe('X-Kici-Client-Version');
    expect(PLATFORM_UPGRADE_REQUIRED_MESSAGE).toBe(
      'This component is newer than the KiCI Platform it connects to. Upgrade the Platform first.',
    );
  });
});

describe('readComponentVersion', () => {
  // fails-when: the refusal never sees a real release, so a newer component connects
  it('returns a release version of at most 64 characters', () => {
    const longest = `0.30.0-${'9'.repeat(57)}`;
    expect(longest).toHaveLength(64);
    for (const version of ['0.30.0', '0.30.0-4512', longest]) {
      expect(readComponentVersion(version), version).toBe(version);
    }
  });

  // breaks-if-wrong: a value in any other form must count as absent, never as a release
  it('treats every other value as absent', () => {
    for (const value of [
      undefined,
      null,
      30,
      {},
      ['0.30.0'],
      true,
      'unknown',
      'v0.30.0',
      `0.30.0-${'9'.repeat(58)}`,
    ]) {
      expect(readComponentVersion(value), JSON.stringify(value)).toBeUndefined();
    }
  });
});

describe('describeComponentVersion', () => {
  // fails-when: a value of any size or shape reaches a log line as is
  it('bounds a string and names the type of anything else', () => {
    expect(describeComponentVersion('v1')).toBe('"v1"');
    expect(describeComponentVersion('x'.repeat(65))).toBe(`"${'x'.repeat(64)}…"`);
    expect(describeComponentVersion(null)).toBe('null');
    expect(describeComponentVersion(30)).toBe('number');
    expect(describeComponentVersion({ a: 'x'.repeat(1000) })).toBe('object');
    expect(describeComponentVersion([1])).toBe('array');
  });
});
