import { describe, it, expect } from 'vitest';
import { relativeTime, renderTable, colorStatus, stripAnsi } from './render.js';

describe('render helpers', () => {
  it('relativeTime formats a recent ISO timestamp', () => {
    const now = Date.parse('2026-06-12T00:00:30.000Z');
    expect(relativeTime('2026-06-12T00:00:00.000Z', now)).toBe('30s ago');
  });

  it('relativeTime steps up to minutes/hours/days', () => {
    const now = Date.parse('2026-06-12T12:00:00.000Z');
    expect(relativeTime('2026-06-12T11:55:00.000Z', now)).toBe('5m ago');
    expect(relativeTime('2026-06-12T09:00:00.000Z', now)).toBe('3h ago');
    expect(relativeTime('2026-06-10T12:00:00.000Z', now)).toBe('2d ago');
  });

  it('relativeTime returns dash for undefined', () => {
    expect(relativeTime(undefined, 0)).toBe('—');
  });

  it('renderTable aligns columns and prints a header', () => {
    const out = renderTable(
      ['id', 'status'],
      [
        ['abc', 'ok'],
        ['longer-id', 'failed'],
      ],
    );
    const lines = out.split('\n');
    expect(stripAnsi(lines[0])).toContain('id');
    expect(stripAnsi(lines[0])).toContain('status');
    expect(lines[1]).toContain('abc');
  });

  it('colorStatus returns the raw text (color stripped when NO_COLOR)', () => {
    process.env.NO_COLOR = '1';
    expect(colorStatus('failed')).toBe('failed');
    delete process.env.NO_COLOR;
  });
});
