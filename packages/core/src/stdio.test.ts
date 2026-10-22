import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const STDIO = fileURLToPath(new URL('./stdio.ts', import.meta.url));

/**
 * Write 200 KB to a pipe whose reader starts late, then `process.exit(0)`.
 * `sleep` keeps the reader idle until the writer has already exited.
 */
function bytesReceived(blocking: boolean): number {
  const script = [
    blocking ? `const { makeCliStdioBlocking } = await import(${JSON.stringify(STDIO)});` : '',
    blocking ? 'makeCliStdioBlocking();' : '',
    "process.stdout.write('x'.repeat(200_000));",
    'process.exit(0);',
  ].join('\n');
  const res = spawnSync(
    'bash',
    ['-c', 'node --input-type=module -e "$0" | (sleep 0.3; wc -c)', script],
    { encoding: 'utf8' },
  );
  return Number(res.stdout.trim());
}

describe('makeCliStdioBlocking', () => {
  // fails-when: the handle stays asynchronous, so process.exit drops queued output.
  it('delivers every byte to a slow pipe reader before process.exit', () => {
    expect(bytesReceived(true)).toBe(200_000);
  });

  // The positive control: without the call this environment really loses output,
  // so the assertion above can fail for the reason it claims to test.
  it('loses output without it (control)', () => {
    expect(bytesReceived(false)).toBeLessThan(200_000);
  });
});
