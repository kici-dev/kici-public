import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, afterEach, beforeEach } from 'vitest';

import {
  writeCredentialFile,
  readCredentialFile,
  type CredentialFileData,
} from './peer-credentials.js';

// --- File I/O tests ---
// DB tests are covered by E2E (e2e/tests/cluster-peer-credentials.test.ts).

describe('credential file I/O', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'kici-cred-test-'));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  const sampleData: CredentialFileData = {
    instanceId: 'worker-abc-123',
    credential: 'base64-encoded-credential-secret',
    role: 'worker',
    issuedAt: '2026-03-22T12:00:00.000Z',
  };

  it('writeCredentialFile + readCredentialFile roundtrip preserves data', async () => {
    const filePath = join(tempDir, 'credential.json');
    await writeCredentialFile(filePath, sampleData);
    const result = await readCredentialFile(filePath);
    expect(result).toEqual(sampleData);
  });

  it('readCredentialFile returns null for non-existent file', async () => {
    const result = await readCredentialFile(join(tempDir, 'does-not-exist.json'));
    expect(result).toBeNull();
  });

  it('writeCredentialFile creates parent directory', async () => {
    const filePath = join(tempDir, 'nested', 'dir', 'credential.json');
    await writeCredentialFile(filePath, sampleData);

    const result = await readCredentialFile(filePath);
    expect(result).toEqual(sampleData);
  });

  it('file permissions are 0o600 (owner read/write only)', async () => {
    const filePath = join(tempDir, 'credential.json');
    await writeCredentialFile(filePath, sampleData);

    const st = await stat(filePath);
    // Mask to get permission bits only (lower 9 bits)
    const perms = st.mode & 0o777;
    expect(perms).toBe(0o600);
  });

  it('overwrites existing file', async () => {
    const filePath = join(tempDir, 'credential.json');
    await writeCredentialFile(filePath, sampleData);

    const updatedData: CredentialFileData = {
      ...sampleData,
      instanceId: 'worker-updated-456',
      credential: 'new-credential-secret',
    };
    await writeCredentialFile(filePath, updatedData);

    const result = await readCredentialFile(filePath);
    expect(result).toEqual(updatedData);
  });
});
