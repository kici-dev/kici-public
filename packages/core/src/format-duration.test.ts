import { describe, it, expect } from 'vitest';
import { formatDuration } from './format-duration.js';

describe('formatDuration', () => {
  it('returns 0s for negative values', () => {
    expect(formatDuration(-100)).toBe('0s');
  });

  it('formats sub-second values with one decimal', () => {
    expect(formatDuration(0)).toBe('0.0s');
    expect(formatDuration(300)).toBe('0.3s');
    expect(formatDuration(999)).toBe('1.0s');
  });

  it('formats seconds with one decimal', () => {
    expect(formatDuration(5000)).toBe('5.0s');
    expect(formatDuration(12300)).toBe('12.3s');
    expect(formatDuration(59999)).toBe('60.0s');
  });

  it('formats minutes and seconds', () => {
    expect(formatDuration(60000)).toBe('1m 0s');
    expect(formatDuration(83000)).toBe('1m 23s');
    expect(formatDuration(120000)).toBe('2m 0s');
    expect(formatDuration(305000)).toBe('5m 5s');
  });

  it('formats hours, minutes, and seconds', () => {
    expect(formatDuration(3600000)).toBe('1h 0m 0s');
    expect(formatDuration(3661000)).toBe('1h 1m 1s');
    expect(formatDuration(7323000)).toBe('2h 2m 3s');
  });
});
