import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { setupSshAuth } from './ssh-auth.js';

const PEM = '-----BEGIN OPENSSH PRIVATE KEY-----\nfake\n-----END OPENSSH PRIVATE KEY-----';

describe('setupSshAuth', () => {
  const priorTmp = process.env.KICI_TMPDIR;
  afterEach(() => {
    if (priorTmp === undefined) delete process.env.KICI_TMPDIR;
    else process.env.KICI_TMPDIR = priorTmp;
  });

  // fails-when: the known_hosts path is only shell-quoted — ssh then splits
  // `.../with space/...` into two files and verifies against neither.
  it('keeps a temp path with a space as one known_hosts file for ssh', async () => {
    process.env.KICI_TMPDIR = await mkdtemp(join(tmpdir(), 'with space-'));
    const auth = await setupSshAuth({ privateKey: PEM, hostKeyPolicy: 'accept-new' });
    try {
      expect(auth.tempDir).toContain('with space');
      expect(auth.gitSshCommand).toContain(
        `-o 'UserKnownHostsFile="${join(auth.tempDir, 'known_hosts')}"'`,
      );
    } finally {
      await auth.cleanup();
    }
  });
});
