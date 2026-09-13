import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, appendFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { tailFile, MAX_LINE_BYTES, MAX_QUEUED_LINES, MAX_READ_BYTES } from './file-tail.js';

/**
 * The serial console is guest-controlled: a job inside a tenant's microVM
 * writes to `/dev/console` unprivileged, and every byte lands in the
 * orchestrator's process. These tests pin the three bounds that stop one
 * tenant's job from taking down every tenant on that orchestrator, plus the
 * consumed-bytes offset that stops a burst from being silently dropped.
 */
describe('tailFile', () => {
  let dir: string;
  let file: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'kici-file-tail-'));
    file = join(dir, 'serial.log');
    await writeFile(file, '');
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  /** Collect lines until `want` of them arrive or the deadline passes. */
  async function collect(want: number, timeoutMs = 5000): Promise<string[]> {
    const controller = new AbortController();
    const out: string[] = [];
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      for await (const line of tailFile(file, controller.signal)) {
        out.push(line);
        if (out.length >= want) break;
      }
    } finally {
      clearTimeout(timer);
      controller.abort();
    }
    return out;
  }

  it('yields complete lines as they are appended', async () => {
    await appendFile(file, 'first\nsecond\n');
    const lines = await collect(2);
    expect(lines).toEqual(['first', 'second']);
  });

  it('joins a logical line split across writes, and skips the empty ones', async () => {
    // The partial-line carry-over is the buffer the bounding rewrite reshaped
    // most: an incomplete trailing slice is held and prepended to the first
    // part of the NEXT read, and empty parts never reach the consumer. The
    // over-long cases below exercise the discard path instead, so without this
    // the ordinary join has no coverage at all.
    await appendFile(file, 'partial');

    const controller = new AbortController();
    const seen: string[] = [];
    const timer = setTimeout(() => controller.abort(), 10_000);
    // Completed only after the tailer has buffered the incomplete slice.
    const completion = setTimeout(() => {
      void appendFile(file, ' complete\n\n\nsecond\n');
    }, 400);
    try {
      for await (const line of tailFile(file, controller.signal)) {
        seen.push(line);
        if (seen.length >= 2) break;
      }
    } finally {
      clearTimeout(timer);
      clearTimeout(completion);
      controller.abort();
    }

    expect(seen).toEqual(['partial complete', 'second']);
  });

  it('truncates a newline-free write instead of buffering it without bound', async () => {
    // `yes | tr -d '\n' > /dev/console`: 10 MiB with no line terminator.
    await appendFile(file, 'x'.repeat(10 * 1024 * 1024));
    const lines = await collect(1);

    expect(lines).toHaveLength(1);
    expect(lines[0].endsWith(' [truncated]')).toBe(true);
    // Bounded by the cap, not by what the guest wrote.
    expect(lines[0].length).toBeLessThanOrEqual(MAX_LINE_BYTES + ' [truncated]'.length);
  });

  it('resumes on the next logical line after truncating an over-long one', async () => {
    await appendFile(file, `${'x'.repeat(MAX_LINE_BYTES * 2)}\nafter\n`);
    const lines = await collect(2);

    expect(lines[0].endsWith(' [truncated]')).toBe(true);
    // The remainder of the over-long line is discarded, not merged into the
    // next one.
    expect(lines[1]).toBe('after');
  });

  it('drops from the front with an in-band marker when the queue overflows', async () => {
    // More complete lines than the queue can hold, written before any consumer
    // reads: the queue fills in one drain pass.
    const total = MAX_QUEUED_LINES + 500;
    let payload = '';
    for (let i = 0; i < total; i++) payload += `line-${i}\n`;
    await appendFile(file, payload);

    const controller = new AbortController();
    const seen: string[] = [];
    const timer = setTimeout(() => controller.abort(), 10_000);
    try {
      for await (const line of tailFile(file, controller.signal)) {
        seen.push(line);
        if (seen.length >= 2) break;
      }
    } finally {
      clearTimeout(timer);
      controller.abort();
    }

    expect(seen[0]).toMatch(/^\[dropped \d+ lines\]$/);
    // The newest lines are what a boot-failure triage needs, so the oldest go.
    expect(seen[1]).not.toBe('line-0');
  });

  it('keeps a multi-byte character that straddles the bounded-read boundary', async () => {
    // The read boundary falls wherever MAX_READ_BYTES lands, which is happily
    // inside a UTF-8 sequence. Decoding each slice on its own replaces that
    // character and mis-decodes the continuation bytes leading the next slice.
    // A three-byte character placed astride the boundary is the smallest case
    // that shows it.
    const glyph = '☃'; // U+2603, three bytes
    // Fill the first bounded read to one byte short of its boundary, so the
    // glyph's first byte is the last byte of read 1 and its other two lead
    // read 2. `filler` is one complete line; `prefix` opens the next one.
    const prefix = 'y'.repeat(9);
    const filler = 'x'.repeat(MAX_READ_BYTES - 11);
    await appendFile(file, `${filler}\n${prefix}${glyph}tail\n`);

    const lines = await collect(2);
    expect(lines).toHaveLength(2);
    expect(lines[1]).toBe(`${prefix}${glyph}tail`);
    expect(lines[1]).not.toContain('�');
  });

  it('resumes exactly where a bounded read stopped, across a multi-read burst', async () => {
    // A delta larger than one bounded read needs several passes. Advancing the
    // offset by a fresh `statSync` — taking the file's size *now* rather than
    // the bytes actually consumed — skips everything between the end of the
    // slice and EOF, so the burst's tail and everything appended after it are
    // silently lost.
    const bigLine = `${'a'.repeat(MAX_READ_BYTES + 4096)}\n`;
    await appendFile(file, bigLine);

    const controller = new AbortController();
    const seen: string[] = [];
    const timer = setTimeout(() => controller.abort(), 10_000);
    try {
      for await (const line of tailFile(file, controller.signal)) {
        seen.push(line);
        if (seen.length === 1) {
          // Appended after the first bounded read has already begun.
          await appendFile(file, 'sentinel-after-burst\n');
        }
        if (seen.length >= 2) break;
      }
    } finally {
      clearTimeout(timer);
      controller.abort();
    }

    expect(seen).toHaveLength(2);
    expect(seen[1]).toBe('sentinel-after-burst');
  });
});
