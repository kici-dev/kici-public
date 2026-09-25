/**
 * Tests for the master-key rotation sweeps `rotate-key` gained.
 *
 * The property under test is the one the published rotation procedure depended
 * on and did not have: after a sweep, a row that was sealed under the OLD key
 * opens under the CURRENT key ALONE — so dropping `KICI_SECRET_KEY_OLD` no
 * longer strands it. Each case carries a positive control proving the row was
 * genuinely unreadable with the current key before the sweep.
 */
import { describe, expect, it, vi } from 'vitest';
import { decrypt, deriveKey, encrypt } from '@kici-dev/shared';
import { createMockDb } from '../__test-helpers__/mock-db.js';
import { DbSigner, unwrapPrivateJwk } from '../oidc/db-signer.js';
import type { ResolvedMasterKeys } from './config.js';
import { PRIVATE_KEY_AAD } from './ephemeral-keys.js';
import { JOB_SECRETS_SWEEP_BATCH, rotateMasterKeyWrappedTables } from './master-key-rotation.js';
import { jobSecretsAad } from './job-secret-seal.js';
import { TERMINAL_DISPATCH_STATUSES } from '../queue/job-queue.js';
import { secretOutputAad } from './secret-output-crypto.js';

const CURRENT_MATERIAL = 'a'.repeat(64);
const OLD_MATERIAL = 'b'.repeat(64);
const OTHER_MATERIAL = 'c'.repeat(64);

const KEYS: ResolvedMasterKeys = {
  material: CURRENT_MATERIAL,
  materialOld: OLD_MATERIAL,
  current: deriveKey(CURRENT_MATERIAL),
  old: deriveKey(OLD_MATERIAL),
};

const RUN_ID = 'run-1';

/**
 * Queue one result set per sweep, in the order
 * `rotateMasterKeyWrappedTables` reads them: signing keys, dashboard keys,
 * ephemeral keys, secret outputs, then the stored job secrets of the dispatch
 * queue, pending job contexts and pending workflow contexts.
 */
function mockDbWith(rowSets: unknown[][]) {
  const { db, mocks } = createMockDb({});
  for (const rows of rowSets) mocks.selectExecute.mockResolvedValueOnce(rows);
  return { db, mocks };
}

/** Every `set({...})` payload the sweeps handed to `updateTable`. */
function setPayloads(mocks: { updateSet: { mock: { calls: unknown[][] } } }) {
  return mocks.updateSet.mock.calls.map((c) => c[0] as Record<string, unknown>);
}

describe('rotateMasterKeyWrappedTables', () => {
  const warn = vi.fn();

  it('re-seals a signing key from the old master key to the current one', async () => {
    const generated = await DbSigner.generate(OLD_MATERIAL);

    // Positive control: the row is genuinely unreadable with the current key.
    expect(() => unwrapPrivateJwk(generated.encryptedPrivateJwk, CURRENT_MATERIAL)).toThrow();

    const { db, mocks } = mockDbWith([
      [
        {
          kid: generated.kid,
          encrypted_private_jwk: generated.encryptedPrivateJwk,
          key_version: 1,
        },
      ],
      [],
      [],
      [],
    ]);
    const result = await rotateMasterKeyWrappedTables(db as never, KEYS, warn);
    expect(result.signingKeys).toEqual({ reEncrypted: 1, skipped: 0 });

    const [set] = setPayloads(mocks);
    expect(set.key_version).toBe(2);
    // The re-sealed row opens under the CURRENT key alone.
    expect(unwrapPrivateJwk(set.encrypted_private_jwk as string, CURRENT_MATERIAL).kty).toBe('EC');
  });

  it('re-seals a dashboard key and a run ephemeral key', async () => {
    const dashboardDer = 'ZGFzaGJvYXJkLWtleQ==';
    const ephemeralDer = 'ZXBoZW1lcmFsLWtleQ==';
    const sealOld = (v: string) => encrypt(v, KEYS.old!, 1, PRIVATE_KEY_AAD).data;

    // Positive control for both.
    expect(() =>
      decrypt({ data: sealOld(dashboardDer), keyVersion: 1 }, KEYS.current, PRIVATE_KEY_AAD),
    ).toThrow();

    const { db, mocks } = mockDbWith([
      [],
      [{ kid: 'kid-1', encrypted_private_key: sealOld(dashboardDer), key_version: 1 }],
      [{ run_id: RUN_ID, encrypted_private_key: sealOld(ephemeralDer), key_version: 1 }],
      [],
    ]);
    const result = await rotateMasterKeyWrappedTables(db as never, KEYS, warn);
    expect(result.dashboardKeys).toEqual({ reEncrypted: 1, skipped: 0 });
    expect(result.ephemeralKeys).toEqual({ reEncrypted: 1, skipped: 0 });

    const [dash, eph] = setPayloads(mocks);
    expect(
      decrypt(
        { data: dash.encrypted_private_key as string, keyVersion: 2 },
        KEYS.current,
        PRIVATE_KEY_AAD,
      ),
    ).toBe(dashboardDer);
    expect(
      decrypt(
        { data: eph.encrypted_private_key as string, keyVersion: 2 },
        KEYS.current,
        PRIVATE_KEY_AAD,
      ),
    ).toBe(ephemeralDer);
  });

  it('re-seals a secret output against its own per-run AAD', async () => {
    const aad = secretOutputAad(RUN_ID);
    const sealed = encrypt('token-value', KEYS.old!, 1, aad).data;

    const { db, mocks } = mockDbWith([
      [],
      [],
      [],
      [
        {
          id: 'out-1',
          run_id: RUN_ID,
          output_key: 'API_KEY',
          encrypted_value: sealed,
          key_version: 1,
        },
      ],
    ]);
    const result = await rotateMasterKeyWrappedTables(db as never, KEYS, warn);
    expect(result.secretOutputs).toEqual({ reEncrypted: 1, skipped: 0 });

    const [set] = setPayloads(mocks);
    expect(decrypt({ data: set.encrypted_value as string, keyVersion: 2 }, KEYS.current, aad)).toBe(
      'token-value',
    );
    // Still bound to its run: the re-seal must not widen the AAD.
    expect(() =>
      decrypt(
        { data: set.encrypted_value as string, keyVersion: 2 },
        KEYS.current,
        secretOutputAad('other-run'),
      ),
    ).toThrow();
  });

  it('counts a row neither key opens as skipped and leaves it alone', async () => {
    const sealed = encrypt('lost', deriveKey(OTHER_MATERIAL), 1, PRIVATE_KEY_AAD).data;
    const logWarn = vi.fn();
    const { db, mocks } = mockDbWith([
      [],
      [],
      [{ run_id: RUN_ID, encrypted_private_key: sealed, key_version: 1 }],
      [],
    ]);
    const result = await rotateMasterKeyWrappedTables(db as never, KEYS, logWarn);
    expect(result.ephemeralKeys).toEqual({ reEncrypted: 0, skipped: 1 });
    expect(mocks.updateSet).not.toHaveBeenCalled();
    expect(logWarn).toHaveBeenCalledWith(expect.stringContaining('undecryptable'), {
      runId: RUN_ID,
    });
  });

  it('re-seals at the next version even with no old key (periodic re-encryption)', async () => {
    const currentOnly: ResolvedMasterKeys = {
      material: CURRENT_MATERIAL,
      materialOld: undefined,
      current: deriveKey(CURRENT_MATERIAL),
      old: undefined,
    };
    const sealed = encrypt('v3', currentOnly.current, 3, PRIVATE_KEY_AAD).data;
    const { db, mocks } = mockDbWith([
      [],
      [],
      [{ run_id: RUN_ID, encrypted_private_key: sealed, key_version: 3 }],
      [],
    ]);
    const result = await rotateMasterKeyWrappedTables(db as never, currentOnly, warn);
    expect(result.ephemeralKeys).toEqual({ reEncrypted: 1, skipped: 0 });
    expect(setPayloads(mocks)[0].key_version).toBe(4);
  });

  it('reports zeros for every empty store', async () => {
    const { db } = mockDbWith([[], [], [], [], [], [], []]);
    expect(await rotateMasterKeyWrappedTables(db as never, KEYS, warn)).toEqual({
      signingKeys: { reEncrypted: 0, skipped: 0 },
      dashboardKeys: { reEncrypted: 0, skipped: 0 },
      ephemeralKeys: { reEncrypted: 0, skipped: 0 },
      secretOutputs: { reEncrypted: 0, skipped: 0 },
      jobSecrets: { reEncrypted: 0, skipped: 0 },
    });
  });

  describe('stored job secrets', () => {
    const sealOld = (runId: string, v: string) =>
      encrypt(v, KEYS.old!, 1, jobSecretsAad(runId)).data;
    /** The four earlier sweeps read nothing; the job-secret selects follow in order. */
    const EARLIER = [[], [], [], []];

    it('re-seals every table under the current key, guarded on the ciphertext it read', async () => {
      const queued = sealOld('run-q', '{"secrets":{"A":"1"}}');
      const pendingJob = sealOld('run-p', '{"secrets":{"B":"2"}}');
      const pendingWorkflow = sealOld('run-w', '{"runWideFlatSecrets":{"C":"3"}}');
      // Positive control: the rows are unreadable under the current key alone.
      expect(() =>
        decrypt({ data: queued, keyVersion: 1 }, KEYS.current, jobSecretsAad('run-q')),
      ).toThrow();

      const { db, mocks } = mockDbWith([
        ...EARLIER,
        [{ id: 'job-1', run_id: 'run-q', sealed_secrets: queued }],
        [{ run_id: 'run-p', job_name: 'deploy', sealed_secrets: pendingJob }],
        [{ run_id: 'run-w', sealed_secrets: pendingWorkflow }],
      ]);
      const result = await rotateMasterKeyWrappedTables(db as never, KEYS, warn);
      expect(result.jobSecrets).toEqual({ reEncrypted: 3, skipped: 0 });

      const payloads = setPayloads(mocks).map((p) => p.sealed_secrets as string);
      expect(
        decrypt({ data: payloads[0], keyVersion: 1 }, KEYS.current, jobSecretsAad('run-q')),
      ).toBe('{"secrets":{"A":"1"}}');
      expect(
        decrypt({ data: payloads[2], keyVersion: 1 }, KEYS.current, jobSecretsAad('run-w')),
      ).toBe('{"runWideFlatSecrets":{"C":"3"}}');
      // fails-when: the UPDATE matches the row by key alone and clobbers a concurrent re-seal
      for (const old of [queued, pendingJob, pendingWorkflow]) {
        expect(mocks.updateWhere).toHaveBeenCalledWith('sealed_secrets', '=', old);
      }
    });

    it('counts a row neither key opens as skipped and leaves it alone', async () => {
      const lost = encrypt('{}', deriveKey(OTHER_MATERIAL), 1, jobSecretsAad('run-q')).data;
      const logWarn = vi.fn();
      const { db, mocks } = mockDbWith([
        ...EARLIER,
        [{ id: 'job-1', run_id: 'run-q', sealed_secrets: lost }],
        [],
        [],
      ]);
      const result = await rotateMasterKeyWrappedTables(db as never, KEYS, logWarn);
      expect(result.jobSecrets).toEqual({ reEncrypted: 0, skipped: 1 });
      expect(mocks.updateSet).not.toHaveBeenCalled();
      expect(logWarn).toHaveBeenCalledWith(expect.stringContaining('undecryptable'), {
        table: 'dispatch_queue',
        jobId: 'job-1',
      });
    });

    it('sweeps the queue in bounded batches, paged by id, skipping terminal rows', async () => {
      const full = Array.from({ length: JOB_SECRETS_SWEEP_BATCH }, (_, i) => ({
        id: `job-${String(i).padStart(4, '0')}`,
        run_id: 'run-q',
        sealed_secrets: sealOld('run-q', '{}'),
      }));
      const { db, mocks } = mockDbWith([...EARLIER, full, [], [], []]);
      const result = await rotateMasterKeyWrappedTables(db as never, KEYS, warn);
      expect(result.jobSecrets).toEqual({ reEncrypted: JOB_SECRETS_SWEEP_BATCH, skipped: 0 });
      // fails-when: the whole queue is re-sealed in one transaction holding every row lock
      expect(mocks.selectLimit).toHaveBeenCalledWith(JOB_SECRETS_SWEEP_BATCH);
      // A full batch asks for the next page, starting after its last id.
      expect(mocks.selectWhere).toHaveBeenCalledWith('id', '>', full[full.length - 1].id);
      // breaks-if-wrong: live rows are swept, terminal rows (scrubbed by the cleanup tick) are not
      expect(mocks.selectWhere).toHaveBeenCalledWith(
        'status',
        'not in',
        TERMINAL_DISPATCH_STATUSES,
      );
    });
  });
});
