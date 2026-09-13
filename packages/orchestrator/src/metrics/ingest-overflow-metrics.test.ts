import { describe, it, expect, beforeEach } from 'vitest';
import {
  setIngestOverflowBuffered,
  getIngestOverflowBuffered,
  resetIngestOverflowMetricState,
} from './prometheus.js';

describe('ingest overflow metric state', () => {
  beforeEach(() => resetIngestOverflowMetricState());

  it('tracks the buffered depth gauge value', () => {
    expect(getIngestOverflowBuffered()).toBe(0);
    setIngestOverflowBuffered(7);
    expect(getIngestOverflowBuffered()).toBe(7);
    resetIngestOverflowMetricState();
    expect(getIngestOverflowBuffered()).toBe(0);
  });
});
