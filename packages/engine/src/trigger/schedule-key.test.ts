import { describe, it, expect } from 'vitest';
import { scheduleTriggerKey } from './schedule-key.js';

describe('scheduleTriggerKey', () => {
  it('joins cronExpression and timezone with a newline', () => {
    expect(scheduleTriggerKey('0 9 * * 1', 'UTC')).toBe('0 9 * * 1\nUTC');
  });

  it('distinguishes two triggers that differ only in timezone', () => {
    expect(scheduleTriggerKey('0 9 * * 1', 'UTC')).not.toBe(
      scheduleTriggerKey('0 9 * * 1', 'Europe/Bucharest'),
    );
  });

  it('treats an empty timezone as a distinct, stable key', () => {
    expect(scheduleTriggerKey('0 9 * * 1', '')).toBe('0 9 * * 1\n');
  });
});
