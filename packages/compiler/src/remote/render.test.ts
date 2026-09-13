import { describe, it, expect, vi, afterEach } from 'vitest';
import { relativeTime, renderTable, colorStatus, stripAnsi } from './render.js';

/**
 * Re-import `render.js` with picocolors reporting a chosen colour support.
 *
 * `colorStatus` branches on `pc.isColorSupported`, which picocolors computes
 * ONCE at its own module load from the environment. Assigning
 * `process.env.NO_COLOR` inside a test body therefore changes nothing — the
 * decision was already made — so an assertion written that way only reports the
 * ambient environment of whoever ran it. Stubbing the env and re-importing does
 * not help either: picocolors resolves from `node_modules`, which vitest
 * externalises, so the cached instance survives `vi.resetModules()`.
 *
 * Substituting the module is what makes colour support an input rather than an
 * accident. Marking each stub so the colourised branch is recognisable also
 * keeps the "did it colourise?" assertion independent of any real ANSI codes.
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

  // Positive counterpart to the case above. On its own that assertion holds
  // just as well for a `colorStatus` that never colourises anything, so the
  // pair is what pins the stripping to colour support rather than to the
  // function being inert. It is also the half that fails on a colour-capable
  // runner when the branch is wrong, which is where this was caught.
  it('colorStatus colorizes when color IS supported', async () => {
    const { colorStatus: colored } = await loadRenderWithColor(true);
    expect(colored('failed')).toBe('<red>failed</red>');
  });
});

afterEach(() => {
  vi.doUnmock('picocolors');
  vi.resetModules();
});
