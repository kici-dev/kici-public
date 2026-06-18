import { describe, it, expect } from 'vitest';
import { EventLogStatus } from './event-log.js';

describe('EventLogStatus', () => {
  it('includes lockfile_corrupt', () => {
    expect(EventLogStatus.options).toContain('lockfile_corrupt');
    expect(() => EventLogStatus.parse('lockfile_corrupt')).not.toThrow();
  });
});
