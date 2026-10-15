/**
 * Tails append-only log files: the Firecracker backend tails the serial console
 * and VMM log files in the jailer chroot. The guest writes to `/dev/console`
 * unprivileged, so everything this module buffers is tenant-controlled: every
 * buffer here is bounded, and an overflow is reported in-band rather than
 * growing the orchestrator's heap.
 */

import { createReadStream, statSync, watchFile, unwatchFile } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { StringDecoder } from 'node:string_decoder';

/**
 * Largest logical line kept intact. A guest that writes without ever emitting a
 * newline (`yes | tr -d '\n' > /dev/console`) would otherwise grow the partial
 * buffer at disk-write speed until the Node heap limit takes the orchestrator —
 * and every in-flight job on it — down.
 */
export const MAX_LINE_BYTES = 64 * 1024;

/**
 * Largest slice read per poll, so a burst drains across several reads instead
 * of materialising the whole delta in one string.
 */
export const MAX_READ_BYTES = 1024 * 1024;

/**
 * Largest number of complete lines held for the consumer. `forwardLine` →
 * Winston → Loki is orders of magnitude slower than a guest can write to the
 * serial console, so the queue is the second place unbounded growth appears.
 * Matches the agent-side log buffer's cap, which uses gap markers for the same
 * situation.
 */
export const MAX_QUEUED_LINES = 10_000;

/** Prefix of the in-band gap marker pushed when the queue overflows. */
const DROP_MARKER_PREFIX = '[dropped ';

/**
 * Tail an append-only file, yielding complete non-empty lines as they are
 * written, until `signal` aborts. Pre-creates the file to avoid watch errors.
 */
export async function* tailFile(filePath: string, signal: AbortSignal): AsyncGenerator<string> {
  await writeFile(filePath, '', { flag: 'a' });

  let offset = 0;
  let partial = '';
  /** True while the rest of an over-long logical line is being discarded. */
  let skippingOverlongLine = false;
  /**
   * Carried across reads: a {@link MAX_READ_BYTES} slice can end inside a
   * multi-byte UTF-8 sequence, and decoding slices separately would corrupt that
   * character. The decoder holds the incomplete tail (at most three bytes, which
   * the append-only file always delivers in the next read).
   */
  const decoder = new StringDecoder('utf8');

  /**
   * The offset advances by the bytes actually consumed, never by a fresh
   * `statSync`: taking the file's size *now* silently drops anything appended
   * while the read stream was draining.
   *
   * @returns the slice's complete lines, and whether more data is already waiting
   */
  function readNewData(): Promise<{ lines: string[]; more: boolean }> {
    return new Promise<{ lines: string[]; more: boolean }>((resolve, reject) => {
      let fileSize: number;
      try {
        fileSize = statSync(filePath).size;
      } catch {
        resolve({ lines: [], more: false });
        return;
      }

      if (fileSize <= offset) {
        resolve({ lines: [], more: false });
        return;
      }

      const end = Math.min(fileSize, offset + MAX_READ_BYTES) - 1;
      const startOffset = offset;
      const chunks: Buffer[] = [];
      const stream = createReadStream(filePath, { start: startOffset, end });

      stream.on('data', (chunk: string | Buffer) => {
        chunks.push(typeof chunk === 'string' ? Buffer.from(chunk, 'utf-8') : chunk);
      });

      stream.on('end', () => {
        const buf = Buffer.concat(chunks);
        offset = startOffset + buf.length;
        const raw = decoder.write(buf);
        const parts = raw.split('\n');

        // The last element is either '' (the slice ended with \n) or an
        // incomplete line to carry into the next read.
        const incompletePart = parts.pop()!;

        const lines: string[] = [];
        for (const part of parts) {
          if (skippingOverlongLine) {
            // The truncation marker was already emitted; drop everything up to
            // and including the newline that ends the over-long line.
            skippingOverlongLine = false;
            partial = '';
            continue;
          }
          const line = partial + part;
          partial = '';
          if (line.length === 0) continue;
          lines.push(
            line.length > MAX_LINE_BYTES ? `${line.slice(0, MAX_LINE_BYTES)} [truncated]` : line,
          );
        }

        if (!skippingOverlongLine) {
          partial += incompletePart;
          if (partial.length > MAX_LINE_BYTES) {
            lines.push(`${partial.slice(0, MAX_LINE_BYTES)} [truncated]`);
            partial = '';
            skippingOverlongLine = true;
          }
        }

        resolve({ lines, more: offset < fileSize });
      });

      stream.on('error', (err) => {
        reject(err);
      });
    });
  }

  // fs.watchFile (stat polling), not fs.watch(), which can miss events on some
  // filesystems (tmpfs, overlayfs in containers).
  const lineQueue: string[] = [];
  /** Cumulative count of complete lines dropped to keep the queue at its cap. */
  let droppedLines = 0;
  let resolveWaiter: (() => void) | null = null;
  let stopped = false;
  let reading = false;

  function enqueue(lines: string[]) {
    for (const line of lines) {
      lineQueue.push(line);
    }
    // Drop from the FRONT: the newest lines are the ones a boot-failure
    // triage needs, and the gap is reported in-band so the loss is visible.
    if (lineQueue.length > MAX_QUEUED_LINES) {
      // One extra, so the marker itself fits inside the cap.
      const overflow = lineQueue.length - MAX_QUEUED_LINES + 1;
      // A marker already at the front is not a lost line — its own count is
      // already in `droppedLines`.
      const markerAtFront = lineQueue[0]?.startsWith(DROP_MARKER_PREFIX) === true;
      droppedLines += overflow - (markerAtFront ? 1 : 0);
      lineQueue.splice(0, overflow, `${DROP_MARKER_PREFIX}${droppedLines} lines]`);
    }
    if (lines.length > 0 && resolveWaiter) {
      const r = resolveWaiter;
      resolveWaiter = null;
      r();
    }
  }

  function onFileChange() {
    if (stopped || reading) return;
    reading = true;
    const drain = (): void => {
      readNewData().then(
        ({ lines, more }) => {
          enqueue(lines);
          // Keep draining a large burst rather than waiting for the next poll tick.
          if (more && !stopped) {
            drain();
            return;
          }
          reading = false;
        },
        () => {
          // Ignore a read error; the next change retries.
          reading = false;
        },
      );
    };
    drain();
  }

  watchFile(filePath, { interval: 100 }, onFileChange);

  // Data may predate the watch.
  onFileChange();

  const onAbort = () => {
    stopped = true;
    unwatchFile(filePath, onFileChange);
    if (resolveWaiter) {
      const r = resolveWaiter;
      resolveWaiter = null;
      r();
    }
  };

  if (signal.aborted) {
    stopped = true;
    unwatchFile(filePath, onFileChange);
  } else {
    signal.addEventListener('abort', onAbort, { once: true });
  }

  try {
    while (!stopped) {
      if (lineQueue.length > 0) {
        yield lineQueue.shift()!;
      } else {
        await new Promise<void>((resolve) => {
          resolveWaiter = resolve;
          // Stopped while the waiter was being set up.
          if (stopped) {
            resolveWaiter = null;
            resolve();
          }
        });
      }
    }

    // Flush whatever the queue still holds, then any trailing partial content.
    while (lineQueue.length > 0) {
      yield lineQueue.shift()!;
    }
    if (partial.length > 0) {
      yield partial;
      partial = '';
    }
  } finally {
    stopped = true;
    unwatchFile(filePath, onFileChange);
    signal.removeEventListener('abort', onAbort);
  }
}
