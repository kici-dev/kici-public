/**
 * `kici-admin dashboard-encryption-key` — the orchestrator's X25519
 * dashboard-encryption key: the trust root a browser seals a secret / variable
 * value to under the `encrypted` dashboard-write posture, so the hosted control
 * plane relays only opaque ciphertext.
 *
 *   dashboard-encryption-key show     Print the active kid, its public JWK, where
 *                                     the JWKS is published, and the Verified-tier
 *                                     URL (when that tier is opted into).
 *   dashboard-encryption-key list     List every key on record (kid / status / created_at).
 *   dashboard-encryption-key rotate   Mint a new active key; the prior active key
 *                                     is retired from the published JWKS, but its
 *                                     private half stays on record so envelopes
 *                                     already sealed to it still decrypt.
 *
 * The PRIVATE half is master-key wrapped (`KICI_SECRET_KEY`) in the orchestrator
 * DB and is never exportable — recovery from a lost key is a routine rotation.
 */
import { createInterface } from 'node:readline';
import type { Command } from 'commander';
import { createLogger, createPool, toErrorMessage } from '@kici-dev/shared';
import { runIdempotentStep } from '@kici-dev/shared/idempotency';
import { loadConfig } from '../../config.js';
import { createDb } from '../../db/client.js';
import { DashboardEncryptionKeyRepo } from '../../db/repos/dashboard-encryption-keys-repo.js';
import { ClusterSettingsReader } from '../../cluster/cluster-settings-reader.js';
import { jwksUrlFor, resolveVerifiedIssuer } from '../../cluster/verified-issuer.js';
import { generateDashboardEncryptionKey } from '../../secrets/dashboard-encryption-key.js';

const logger = createLogger({ prefix: 'kici-admin-dashboard-encryption-key' });

function resolveDatabaseUrl(explicit?: string): string {
  const url = explicit ?? process.env.KICI_DATABASE_URL;
  if (!url) {
    throw new Error('Database URL required. Pass --database-url or set KICI_DATABASE_URL.');
  }
  return url;
}

function resolveSecretKey(): string {
  const config = loadConfig();
  if (!config.secretKey) {
    throw new Error(
      'KICI_SECRET_KEY is required for the dashboard encryption key (it wraps the private key).',
    );
  }
  return config.secretKey;
}

async function confirmInteractive(prompt: string): Promise<boolean> {
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  try {
    const answer = await new Promise<string>((resolve) => rl.question(prompt, resolve));
    const a = answer.trim().toLowerCase();
    return a === 'y' || a === 'yes';
  } finally {
    rl.close();
  }
}

async function withRepo<T>(
  databaseUrl: string | undefined,
  fn: (repo: DashboardEncryptionKeyRepo, db: ReturnType<typeof createDb>) => Promise<T>,
): Promise<T> {
  const pool = createPool(resolveDatabaseUrl(databaseUrl));
  const db = createDb(pool);
  try {
    return await fn(new DashboardEncryptionKeyRepo(db), db);
  } finally {
    await db.destroy();
    await pool.end().catch(() => {});
  }
}

/**
 * Where this orchestrator publishes its own JWKS. Independent of the Verified
 * tier: publication happens whenever a provenance issuer is configured, whether
 * or not the dashboard is told to fetch the encryption key from there.
 */
function publishedJwksUrl(): string | null {
  const issuer = loadConfig().provenanceSigningIssuer;
  return issuer ? jwksUrlFor(issuer) : null;
}

/** Mint a fresh key and activate it (demoting any prior active to revoked). */
async function generateAndActivate(
  repo: DashboardEncryptionKeyRepo,
  secretKey: string,
): Promise<string> {
  const generated = await generateDashboardEncryptionKey(secretKey);
  await repo.upsertActive({
    kid: generated.kid,
    public_jwk: generated.publicJwk as unknown as Record<string, unknown>,
    encrypted_private_key: generated.encryptedPrivateKey,
  });
  return generated.kid;
}

export function registerDashboardEncryptionKeyCommands(program: Command): void {
  const group = program
    .command('dashboard-encryption-key')
    .description(
      'Manage the X25519 key browsers seal dashboard secret/variable writes to (orchestrator DB)',
    );

  group
    .command('show')
    .description('Print the active dashboard-encryption key (kid, public JWK, JWKS URLs)')
    .option('--database-url <url>', 'Orchestrator DB URL (else KICI_DATABASE_URL)')
    .option('--json', 'Emit raw JSON')
    .action(async (opts: { databaseUrl?: string; json?: boolean }) => {
      try {
        const { row, verifiedUrl } = await withRepo(opts.databaseUrl, async (repo, db) => ({
          row: await repo.getActiveRow(),
          verifiedUrl: await resolveVerifiedIssuer(new ClusterSettingsReader(db)).then((issuer) =>
            issuer ? jwksUrlFor(issuer) : null,
          ),
        }));
        const publishedUrl = publishedJwksUrl();
        if (!row) {
          if (opts.json) {
            console.log(
              JSON.stringify(
                {
                  activeKid: null,
                  publicJwk: null,
                  publishedJwksUrl: publishedUrl,
                  verifiedIssuerUrl: verifiedUrl,
                },
                null,
                2,
              ),
            );
            return;
          }
          process.stderr.write(
            'No active dashboard-encryption key. It is generated automatically at boot when KICI_SECRET_KEY is set, or run "kici-admin dashboard-encryption-key rotate".\n',
          );
          return;
        }
        if (opts.json) {
          console.log(
            JSON.stringify(
              {
                activeKid: row.kid,
                publicJwk: row.public_jwk,
                publishedJwksUrl: publishedUrl,
                verifiedIssuerUrl: verifiedUrl,
                createdAt: row.created_at,
                activatedAt: row.activated_at,
              },
              null,
              2,
            ),
          );
          return;
        }
        console.log(`Active kid:  ${row.kid}`);
        console.log(`Public JWK:  ${JSON.stringify(row.public_jwk)}`);
        console.log(`Published JWKS URL:  ${publishedUrl ?? '(no provenance issuer configured)'}`);
        console.log(
          `Verified-tier URL:   ${verifiedUrl ?? '(not configured — convenient tier only)'}`,
        );
      } catch (err) {
        console.error(`Error: ${toErrorMessage(err)}`);
        process.exit(1);
      }
    });

  group
    .command('list')
    .description('List every dashboard-encryption key on record (kid / status / created_at)')
    .option('--database-url <url>', 'Orchestrator DB URL (else KICI_DATABASE_URL)')
    .option('--json', 'Emit raw JSON')
    .action(async (opts: { databaseUrl?: string; json?: boolean }) => {
      try {
        const rows = await withRepo(opts.databaseUrl, (repo) => repo.listServed());
        if (opts.json) {
          console.log(
            JSON.stringify(
              rows.map((r) => ({ kid: r.kid, status: r.status, createdAt: r.created_at })),
              null,
              2,
            ),
          );
          return;
        }
        if (rows.length === 0) {
          process.stderr.write('No dashboard-encryption keys found.\n');
          return;
        }
        for (const r of rows) {
          console.log(`${r.kid}  ${r.status.padEnd(8)}  ${r.created_at}`);
        }
      } catch (err) {
        console.error(`Error: ${toErrorMessage(err)}`);
        process.exit(1);
      }
    });

  group
    .command('rotate')
    .description(
      'Mint a new active dashboard-encryption key (the prior key still decrypts envelopes already sealed to it)',
    )
    .option('--database-url <url>', 'Orchestrator DB URL (else KICI_DATABASE_URL)')
    .option('--yes', 'Skip the confirmation prompt')
    .option('--dry-run', 'Show what would happen without rotating')
    .action(async (opts: { databaseUrl?: string; yes?: boolean; dryRun?: boolean }) => {
      try {
        const secretKey = resolveSecretKey();
        await withRepo(opts.databaseUrl, async (repo) => {
          await runIdempotentStep(
            {
              name: 'dashboard-encryption-key/rotate',
              // Rotation always changes state (a fresh key is minted).
              check: async () => ({ reason: 'rotate to a new key' }),
              summarize: () =>
                'Mint a NEW X25519 dashboard-encryption key and activate it; the current active key is retired from the published JWKS but still decrypts envelopes already sealed to it',
              apply: async () => {
                const kid = await generateAndActivate(repo, secretKey);
                logger.info('rotated dashboard encryption key', { kid });
                process.stderr.write(`Rotated: new active dashboard-encryption key ${kid}.\n`);
              },
            },
            { confirm: confirmInteractive, yes: opts.yes, dryRun: opts.dryRun },
          );
        });
      } catch (err) {
        console.error(`Error: ${toErrorMessage(err)}`);
        process.exit(1);
      }
    });
}
