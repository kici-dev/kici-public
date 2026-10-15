import { describe, it, expect, vi, afterEach } from 'vitest';
import { relativeTime, renderTable, colorStatus, stripAnsi } from './render.js';

/**
 * Re-import `render.js` with picocolors reporting a chosen colour support.
 *
 * picocolors computes `isColorSupported` ONCE at load, so setting
 * `process.env.NO_COLOR` in a test changes nothing. Re-importing does not help:
 * vitest externalises `node_modules`, so the instance survives
 * `vi.resetModules()`. Substituting the module makes colour support an input;
 * marked stubs keep the assertion independent of real ANSI codes.
 */
async function loadRenderWithColor(
  isColorSupported: boolean,
): Promise<typeof import('./render.js')> {
  vi.resetModules();
  const mark =
    (name: string) =>
    (s: string): string =>
      isColorSupported ? `<${name}>${s}</${name}>` : s;
  vi.doMock('picocolors', () => ({
    default: {
      isColorSupported,
      bold: mark('b'),
      cyan: mark('cyan'),
      dim: mark('dim'),
      gray: mark('gray'),
      green: mark('green'),
      red: mark('red'),
      yellow: mark('yellow'),
    },
  }));
  return import('./render.js');
}

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

  it('colorStatus returns the raw text when color is unsupported', async () => {
    const { colorStatus: uncolored } = await loadRenderWithColor(false);
    expect(uncolored('failed')).toBe('failed');
  });

  // Positive counterpart: alone, the case above also passes for a `colorStatus`
  // that never colourises, so the pair pins stripping to colour support.
  it('colorStatus colorizes when color IS supported', async () => {
    const { colorStatus: colored } = await loadRenderWithColor(true);
    expect(colored('failed')).toBe('<red>failed</red>');
  });
});

afterEach(() => {
  vi.doUnmock('picocolors');
  vi.resetModules();
});
