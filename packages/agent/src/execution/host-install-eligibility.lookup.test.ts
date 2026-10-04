import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** What the lookup reports on a Debian host whose npm is too old. */
const LOOKUP_DETAIL = '/usr/share/nodejs/npm/bin/npm-cli.js is npm 9.2.0, older than 11.10.0';

vi.mock('./npmrc-allowlist.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./npmrc-allowlist.js')>();
  return { ...actual, loadHostNpmIni: vi.fn(() => ({ ini: null, detail: LOOKUP_DETAIL })) };
});

import { HostInstallRefusal, checkHostInstallEligibility } from './host-install-eligibility.js';

describe("checkHostInstallEligibility — the agent's npm lookup found no npm", () => {
  let repo: string;

  beforeEach(async () => {
    repo = await mkdtemp(join(tmpdir(), 'kici-eligibility-lookup-'));
    await mkdir(join(repo, '.kici'));
    await writeFile(
      join(repo, '.kici', 'package.json'),
      JSON.stringify({ name: 'wf', private: true, devDependencies: { '@kici-dev/sdk': '^1.0.0' } }),
    );
  });

  afterEach(async () => {
    await rm(repo, { recursive: true, force: true });
  });

  it('refuses and names the npm the lookup refused', async () => {
    // fails-when: the check ignores a failed lookup, or drops its detail, so the
    // operator cannot tell which npm was too old.
    expect(await checkHostInstallEligibility(repo, { operatorNpmrc: null })).toEqual({
      eligible: false,
      refusal: HostInstallRefusal.NpmrcParserUnavailable,
      detail: `the agent's npm is not available: ${LOOKUP_DETAIL}`,
    });
  });
});
