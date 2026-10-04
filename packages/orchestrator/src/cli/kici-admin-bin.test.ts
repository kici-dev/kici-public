import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

/**
 * The published `kici-admin` entry point runs through its shebang. Node reads
 * `--env-file` from anywhere in its argv, so the shebang must end node's options
 * before the script, or `kici-admin join --env-file <path>` never starts.
 */
const BIN = resolve(import.meta.dirname, '../../../kici-admin/bin/kici-admin.js');
const dir = mkdtempSync(join(tmpdir(), 'kici-admin-bin-'));

afterAll(() => rmSync(dir, { recursive: true, force: true }));

/** A script that carries the entry point's shebang and prints its own arguments. */
function probeWithShebang(shebang: string): string {
  const path = join(dir, `probe-${Math.random().toString(36).slice(2)}.mjs`);
  writeFileSync(path, `${shebang}\nconsole.log(JSON.stringify(process.argv.slice(2)));\n`);
  chmodSync(path, 0o755);
  return path;
}

describe('kici-admin entry point', () => {
  const shebang = readFileSync(BIN, 'utf-8').split('\n')[0];
  const missing = join(dir, 'not-written-yet.env');

  // fails-when: the shebang is `#!/usr/bin/env node`, so node takes `--env-file` itself
  //   and exits before the script runs.
  it('passes --env-file through to the CLI', () => {
    const out = execFileSync(probeWithShebang(shebang), ['join', '--env-file', missing], {
      encoding: 'utf-8',
    });
    expect(JSON.parse(out)).toEqual(['join', '--env-file', missing]);
  });

  // Positive control: the plain shebang is refused by node with this same input.
  it('the plain node shebang does not', () => {
    const res = spawnSync(probeWithShebang('#!/usr/bin/env node'), ['--env-file', missing], {
      encoding: 'utf-8',
    });
    expect(res.status).not.toBe(0);
    expect(res.stderr).toContain('not found');
  });
});
