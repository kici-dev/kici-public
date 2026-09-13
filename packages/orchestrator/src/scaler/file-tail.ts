/**
 * File tailing utility for append-only log files.
 *
 * Provides an async generator that yields complete lines as they are appended
 * to a file, using `fs.watchFile()` for change notifications and partial line
 * buffering for split writes.
 *
 * Used by the Firecracker backend to tail serial console and VMM log files
 * from the jailer chroot directory. The guest writes to `/dev/console`
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
 * Largest slice read from the file per poll. A burst is drained across several
 * ticks instead of materialising the whole delta in one string.
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
 * Tail an append-only file, yielding complete lines as they are written.
 *
 * Pre-creates the file if it does not exist to avoid watch errors.
 * Tracks byte offset and partial (incomplete) trailing lines across reads.
 * Stops when the provided AbortSignal is triggered.
 *
 * @param filePath - Path to the file to tail
 * @param signal - AbortSignal to stop tailing
 * @yields Complete lines (non-empty) as they are appended to the file
 */
export async function* tailFile(filePath: string, signal: AbortSignal): AsyncGenerator<string> {
  // Pre-create the file if it does not exist
  await writeFile(filePath, '', { flag: 'a' });

  let offset = 0;
  let partial = '';
  /** True while the rest of an over-long logical line is being discarded. */
  let skippingOverlongLine = false;
  /**
   * Decoder carried across reads.
   *
   * Each poll reads at most {@link MAX_READ_BYTES}, and that boundary falls
   * wherever the byte count lands — including inside a multi-byte UTF-8
   * sequence. Decoding each slice on its own turns that character into a
   * replacement character and then mis-decodes the continuation bytes at the
   * head of the next slice. The decoder holds the incomplete tail and prepends
   * it, so the character survives the split.
   *
   * It never holds more than three bytes, and the file is append-only, so those
   * bytes always arrive in the next read.
   */
  const decoder = new StringDecoder('utf8');

  /**
   * Read at most {@link MAX_READ_BYTES} of new data from the current offset.
   *
   * The offset advances by the bytes actually consumed, never by a fresh
   * `statSync`: taking the file's size *now* silently drops anything appended
   * while the read stream was draining.
   *
   * @returns the complete lines the slice produced, plus whether more data is
   * already waiting so the caller can keep draining
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
        // Advance by consumed bytes, so the next poll resumes exactly here.
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

  // Use a callback-based approach with fs.watchFile (polling) for reliability
  // across all platforms and filesystem types (including tmpfs, overlayfs in containers).
  // fs.watch() can miss events on certain filesystems; watchFile uses stat polling.
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
          // A burst larger than MAX_READ_BYTES needs several passes; keep
          // draining rather than waiting for the next 100ms poll tick.
          if (more && !stopped) {
            drain();
            return;
          }
          reading = false;
        },
        () => {
          // Read error -- ignore, will retry on next change
          reading = false;
        },
      );
    };
    drain();
  }

  // Start watching with 100ms polling interval
  watchFile(filePath, { interval: 100 }, onFileChange);

  // Also do an initial read in case data was written before we started watching
  onFileChange();

  // Stop on abort
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
        // Wait for new data or abort
        await new Promise<void>((resolve) => {
          resolveWaiter = resolve;
          // Check if we got stopped while setting up the waiter
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
