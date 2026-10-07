/** Render a left-aligned, two-space-gapped text table with a dashed separator row. */
export function renderTable(headers: string[], rows: string[][]): string {
  const widths = headers.map((h, i) => Math.max(h.length, ...rows.map((r) => (r[i] ?? '').length)));
  const fmtRow = (cells: string[]) =>
    cells
      .map((c, i) => (c ?? '').padEnd(widths[i]!))
      .join('  ')
      .trimEnd();
  return [fmtRow(headers), widths.map((w) => '-'.repeat(w)).join('  '), ...rows.map(fmtRow)].join(
    '\n',
  );
}
