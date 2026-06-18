import { workflow, job, step, waitForStep, push } from '@kici-dev/sdk';
import { mkdir, writeFile, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';

/**
 * waitFor example workflow.
 *
 * Two jobs run in sequence:
 *   1. `producer` writes a marker file to a temp directory after a
 *      short delay.
 *   2. `consumer` runs a `waitForStep` that polls the marker path
 *      until it exists, then proceeds. The success branch returns the
 *      marker contents so a downstream step (or test) can read them.
 *
 * Marker path is shared via a known temp-directory name. Real-world
 * uses look much like this: poll a registry for an image tag, poll an
 * external API for a job result, poll a file system for a build
 * output, etc.
 */

const MARKER_DIR = join(tmpdir(), 'kici-example-wait-for-marker');
const MARKER_PATH = join(MARKER_DIR, 'ready.txt');

const producer = job('producer', {
  runsOn: 'local',
  steps: [
    step('write-marker', async (ctx) => {
      ctx.log.info(`Producer will write marker at ${MARKER_PATH} after a short delay`);
      await mkdir(dirname(MARKER_PATH), { recursive: true });
      await new Promise((resolve) => setTimeout(resolve, 1500));
      await writeFile(MARKER_PATH, 'build-output-v1\n', 'utf-8');
      ctx.log.info('Marker written');
    }),
  ],
});

const awaitMarker = waitForStep<{ path: string; size: number }>('await-marker', {
  check: async () => {
    try {
      const info = await stat(MARKER_PATH);
      if (!info.isFile()) return null;
      return { path: MARKER_PATH, size: info.size };
    } catch {
      return null;
    }
  },
  intervalMs: 200,
  timeoutMs: 10_000,
});

const consumer = job('consumer', {
  runsOn: 'local',
  needs: [producer],
  steps: [awaitMarker],
});

export default workflow('wait-for-marker', {
  on: push({ branches: ['main', 'master'] }),
  jobs: [producer, consumer],
});
