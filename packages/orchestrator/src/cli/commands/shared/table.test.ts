import { describe, expect, it } from 'vitest';
import { renderTable } from './table.js';

describe('renderTable', () => {
  // fails-when: the separator row is dropped or the column gap changes from two spaces
  it('pads columns, adds a dashed separator, and trims trailing spaces', () => {
    expect(
      renderTable(
        ['ID', 'STATUS'],
        [
          ['abc', 'ok'],
          ['a', 'pending'],
        ],
      ),
    ).toBe(['ID   STATUS', '---  -------', 'abc  ok', 'a    pending'].join('\n'));
  });

  // breaks-if-wrong: a short row (missing trailing cells) must render, not throw
  it('renders a row with missing cells as empty', () => {
    expect(renderTable(['A', 'B'], [['x']])).toBe(['A  B', '-  -', 'x'].join('\n'));
  });
});
