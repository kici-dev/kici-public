import { describe, expect, it } from 'vitest';
import { TRIGGER_EVENT_TYPES, TRIGGER_EVENT_META } from './trigger-event-type';

describe('TRIGGER_EVENT_META', () => {
  it('has an entry for every trigger event type', () => {
    for (const type of TRIGGER_EVENT_TYPES) {
      expect(TRIGGER_EVENT_META[type]).toBeDefined();
      expect(TRIGGER_EVENT_META[type].label).toBeTruthy();
    }
  });

  it('has no extra keys beyond TRIGGER_EVENT_TYPES', () => {
    const metaKeys = Object.keys(TRIGGER_EVENT_META).sort();
    const typeKeys = [...TRIGGER_EVENT_TYPES].sort();
    expect(metaKeys).toEqual(typeKeys);
  });
});
