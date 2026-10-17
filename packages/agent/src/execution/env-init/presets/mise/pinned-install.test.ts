import { describe, it, expect, afterEach, vi } from 'vitest';
import { mkdtemp, mkdir, writeFile, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import type { MiseInitConfig } from '@kici-dev/sdk';
import { runInitPhase } from '../../init-phase.js';
import { buildInitShellFor } from '../../../sandbox/workflow-runner.js';
import { createEnvFiles, readEnvDelta } from '../../../sandbox/env-file.js';
import type { EnvDelta } from '../../../sandbox/env-delta.js';
import type { RunnerToAgentMessage } from '../../../sandbox/ipc-protocol.js';
import { miseExpander } from './expander.js';

afterEach(() => {
  vi.unstubAllEnvs();
});

async function writeExecutable(path: string, body: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, body, { mode: 0o755 });
}

/** A fake mise that reports `reported` and emits one env export. */
function fakeMise(reported: string, marker?: string): string {
  return [
    '#!/bin/sh',
    ...(marker ? [`echo "$*" >> '${marker}'`] : []),
    'case "$1" in',
    `  --version) echo "${reported} linux-x64 (2026-05-05)" ;;`,
    "  env) echo 'export FAKE_MISE_ENV=pinned' ;;",
    'esac',
    '',
  ].join('\n');
}

interface Harness {
  home: string;
  clone: string;
  marks: string;
  fakebin: string;
  pinnedDir: string;
}

/**
 * HOME, a clone dir and a fake `curl` on PATH. The fake curl prints an installer
 * that records its MISE_VERSION and writes a fake mise reporting
 * `installerReports` to MISE_INSTALL_PATH.
 */
async function makeHarness(installerReports: string): Promise<Harness> {
  const root = await mkdtemp(join(tmpdir(), 'mise-pin-'));
  const h: Harness = {
    home: join(root, 'home'),
    clone: join(root, 'clone'),
    marks: join(root, 'marks'),
    fakebin: join(root, 'fakebin'),
    pinnedDir: join(root, 'home', '.local', 'share', 'kici', 'mise', '2026.5.1'),
  };
  await Promise.all([mkdir(h.home), mkdir(h.clone), mkdir(h.marks), mkdir(h.fakebin)]);
  const prepared = join(root, 'installed-mise');
  await writeExecutable(prepared, fakeMise(installerReports));
  const installer = join(root, 'installer.sh');
  await writeFile(
    installer,
    [
      `printf '%s' "$MISE_VERSION" > '${h.marks}/installer-version'`,
      `cp '${prepared}' "$MISE_INSTALL_PATH"`,
      'chmod +x "$MISE_INSTALL_PATH"',
      '',
    ].join('\n'),
  );
  await writeExecutable(
    join(h.fakebin, 'curl'),
    ['#!/bin/sh', `echo called >> '${h.marks}/curl-calls'`, `cat '${installer}'`, ''].join('\n'),
  );
  vi.stubEnv('HOME', h.home);
  vi.stubEnv('PATH', `${h.fakebin}:${process.env.PATH ?? '/usr/bin:/bin'}`);
  return h;
}

/** Expand the real preset and run it through the runner's real shell factory. */
async function runPreset(h: Harness, config: MiseInitConfig) {
  const files = await createEnvFiles(h.marks);
  const spec = await miseExpander.expand({
    cloneRoot: h.clone,
    config: { cache: false, ...config },
    platform: 'linux',
  });
  const msgs: RunnerToAgentMessage[] = [];
  const send = (m: RunnerToAgentMessage): void => {
    msgs.push(m);
  };
  let delta: EnvDelta | undefined;
  const result = await runInitPhase({
    specs: [spec],
    shellFor: buildInitShellFor(h.clone, send),
    sendIpc: send,
    stepIndexBase: 0,
    env: {
      beginCapture: async () => {
        vi.stubEnv('KICI_ENV', files.envFile);
        vi.stubEnv('KICI_PATH', files.pathFile);
      },
      applyDelta: async () => {
        delta = await readEnvDelta(files);
      },
    },
  });
  const text = [
    result.error ?? '',
    ...msgs.flatMap((m) => (m.type === 'log.line' ? [m.line] : [])),
  ].join('\n');
  return { result, delta, text };
}

describe('mise preset version pin (real bash, offline fakes)', () => {
  it('installs the pinned release with MISE_VERSION and puts it first on the step PATH', async () => {
    const h = await makeHarness('2026.5.1');
    const { result, delta } = await runPreset(h, { version: 'v2026.5.1' });
    expect(result.ok).toBe(true);
    // fails-when: the preset ignores version (the unpinned installer runs without MISE_VERSION)
    expect(await readFile(join(h.marks, 'installer-version'), 'utf8')).toBe('v2026.5.1');
    expect(existsSync(join(h.pinnedDir, 'mise'))).toBe(true);
    expect(delta?.pathPrepends[0]).toBe(h.pinnedDir);
    expect(delta?.env.FAKE_MISE_ENV).toBe('pinned');
  });

  it('fails the init when the installed mise reports another release', async () => {
    const h = await makeHarness('2026.4.0');
    const { result, text } = await runPreset(h, { version: '2026.5.1' });
    // fails-when: the version check is missing and a wrong installer result is accepted
    expect(result.ok).toBe(false);
    expect(text).toContain('mise version mismatch: init pins 2026.5.1');
  });

  it('reuses a pinned binary already at the release without calling the installer', async () => {
    const h = await makeHarness('2026.5.1');
    await writeExecutable(join(h.pinnedDir, 'mise'), fakeMise('2026.5.1'));
    const { result, delta } = await runPreset(h, { version: '2026.5.1' });
    expect(result.ok).toBe(true);
    // fails-when: every pinned run downloads mise again
    expect(existsSync(join(h.marks, 'curl-calls'))).toBe(false);
    // fails-when: the pin is ignored and a mise already on the host PATH is used instead
    expect(delta?.pathPrepends[0]).toBe(h.pinnedDir);
  });

  it('unpinned: keeps using the mise already on PATH and never calls the installer', async () => {
    const h = await makeHarness('2026.5.1');
    await writeExecutable(join(h.fakebin, 'mise'), fakeMise('2099.1.1'));
    const { result, delta } = await runPreset(h, {});
    // breaks-if-wrong: the refactor changes the unpinned path (an installer call, or a pinned dir on PATH)
    expect(result.ok).toBe(true);
    expect(existsSync(join(h.marks, 'curl-calls'))).toBe(false);
    expect(delta?.pathPrepends).toEqual([join(h.home, '.local/share/mise/shims')]);
  });
});

describe('mise env handoff (real bash)', () => {
  it('writes values mise quotes as plain values and leaves PATH out', async () => {
    const h = await makeHarness('2026.5.1');
    await writeExecutable(
      join(h.fakebin, 'mise'),
      [
        '#!/bin/sh',
        'if [ "$1" = env ]; then',
        `  printf '%s\\n' "export A_SPACE='a b'" "export A_SQ='it'\\''s'" "export A_DQ='say \\"hi\\"'" "export A_PLAIN=x" "export PATH='/opt/mise/bin:/usr/bin'"`,
        'fi',
        '',
      ].join('\n'),
    );
    const { result, delta } = await runPreset(h, {});
    expect(result.ok).toBe(true);
    // fails-when: the handoff keeps mise's shell quotes (A_SPACE arrives as "'a b'")
    expect(delta?.env).toMatchObject({
      A_SPACE: 'a b',
      A_SQ: "it's",
      A_DQ: 'say "hi"',
      A_PLAIN: 'x',
    });
    // breaks-if-wrong: PATH reaches $KICI_ENV and replaces the step PATH
    expect(delta?.env.PATH).toBeUndefined();
  });
});

describe('review focus: a user PATH in a pinned preset env', () => {
  it('keeps the pinned mise first for the install and version-check commands', async () => {
    const h = await makeHarness('2026.5.1');
    // A decoy dir the user's PATH puts first, holding a mise that answers a different
    // release and a curl that must never run. /opt/x/bin stays in the PATH as given.
    const decoy = join(h.marks, 'decoy-bin');
    const decoyHits = join(h.marks, 'decoy-hits');
    await writeExecutable(join(decoy, 'mise'), fakeMise('2099.1.1', decoyHits));
    await writeExecutable(join(decoy, 'curl'), `#!/bin/sh\necho curl >> '${decoyHits}'\nexit 7\n`);
    await writeExecutable(join(h.pinnedDir, 'mise'), fakeMise('2026.5.1'));
    const userPath = `/opt/x/bin:${decoy}:/usr/bin:/bin`;

    // Positive control: under the user's PATH alone, `mise` resolves to the decoy,
    // so only the preset's own prepend can make the pinned mise win.
    const resolved = execFileSync('bash', ['-c', 'command -v mise'], {
      env: { PATH: userPath },
    })
      .toString()
      .trim();
    expect(resolved).toBe(join(decoy, 'mise'));

    const { result, delta, text } = await runPreset(h, {
      version: 'v2026.5.1',
      env: { PATH: userPath },
    });

    // fails-when: the pinned dir is not first on the command's PATH. The decoy then
    // answers `mise --version` with 2099.1.1 and the init fails with a mismatch.
    expect(result.ok, text).toBe(true);
    // fails-when: any mise or curl call reaches the user's PATH entries
    expect(existsSync(decoyHits)).toBe(false);
    // breaks-if-wrong: steps lose the pinned dir as their first PATH entry
    expect(delta?.pathPrepends[0]).toBe(h.pinnedDir);
    // breaks-if-wrong: the user PATH leaks into the step env through $KICI_ENV
    expect(delta?.env.PATH).toBeUndefined();
  });

  it('sibling: without a pin, the same user PATH lets its own mise answer', async () => {
    const h = await makeHarness('2026.5.1');
    const decoy = join(h.marks, 'decoy-bin');
    const decoyHits = join(h.marks, 'decoy-hits');
    await writeExecutable(join(decoy, 'mise'), fakeMise('2099.1.1', decoyHits));
    const { result, delta } = await runPreset(h, {
      env: { PATH: `/opt/x/bin:${decoy}:/usr/bin:/bin` },
    });
    expect(result.ok).toBe(true);
    // fails-when: the decoy is unreachable, which would make the pinned case above pass vacuously
    expect(existsSync(decoyHits)).toBe(true);
    expect(delta?.pathPrepends).toEqual([join(h.home, '.local/share/mise/shims')]);
  });
});
