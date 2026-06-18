/**
 * File tailing utility for append-only log files.
 *
 * Provides an async generator that yields complete lines as they are appended
 * to a file, using `fs.watch()` for change notifications and partial line
 * buffering for split writes.
 *
 * Used by the Firecracker backend to tail serial console and VMM log files
 * from the jailer chroot directory.
 */

import { createReadStream, statSync, watchFile, unwatchFile } from 'node:fs';
import { writeFile } from 'node:fs/promises';

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

  /**
   * Read new data from the file starting at the current offset.
   * Returns complete lines and buffers any incomplete trailing line.
   */
  function readNewData(): Promise<string[]> {
    return new Promise<string[]>((resolve, reject) => {
      let fileSize: number;
      try {
        fileSize = statSync(filePath).size;
      } catch {
        resolve([]);
        return;
      }

      if (fileSize <= offset) {
        resolve([]);
        return;
      }

      const chunks: string[] = [];
      const stream = createReadStream(filePath, { start: offset, encoding: 'utf-8' });

      stream.on('data', (chunk: string | Buffer) => {
        chunks.push(typeof chunk === 'string' ? chunk : chunk.toString('utf-8'));
      });

      stream.on('end', () => {
        const raw = chunks.join('');
        const parts = raw.split('\n');

        // The last element is either '' (line ended with \n) or an incomplete line
        const incompletePart = parts.pop()!;

        // Prepend any partial from previous read to the first element
        if (parts.length > 0) {
          parts[0] = partial + parts[0];
          partial = incompletePart;
        } else {
          // No newline found at all -- accumulate in partial
          partial += incompletePart;
          resolve([]);
          // Update offset even though no complete lines
          try {
            offset = statSync(filePath).size;
          } catch {
            // ignore
          }
          return;
        }

        // Filter empty lines
        const lines = parts.filter((l) => l.length > 0);

        // Update offset
        try {
          offset = statSync(filePath).size;
        } catch {
          // ignore
        }

        resolve(lines);
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
  let resolveWaiter: (() => void) | null = null;
  let stopped = false;

  function onFileChange() {
    if (stopped) return;
    readNewData().then(
      (lines) => {
        if (lines.length > 0) {
          lineQueue.push(...lines);
          if (resolveWaiter) {
            const r = resolveWaiter;
            resolveWaiter = null;
            r();
          }
        }
      },
      () => {
        // Read error -- ignore, will retry on next change
      },
    );
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

    // Flush any remaining partial content as a final line
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
