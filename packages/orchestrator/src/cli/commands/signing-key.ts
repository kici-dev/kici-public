/**
 * `kici-admin signing-key` — orchestrator-owned provenance signing key
 * management (orchestrator DB plane; classified `kici-admin` per
 * .claude/rules/platform-admin.md).
 *
 *   signing-key list                      List keys (kid / status / created_at).
 *   signing-key generate                  Generate the initial db-custody key
 *                                         (no-op if one is already active).
 *   signing-key rotate                    Generate a new db-custody key and
 *                                         activate it (old → retiring).
 *   signing-key retire <kid>              Move a retiring key to retired.
 *   signing-key revoke <kid> --reason <r> Distrust a compromised key.
 *   signing-key export --public [--out f] Emit the { issuer, jwks } backup /
 *                                         air-gap trust-root artifact. Public
 *                                         halves ONLY — never private material.
 *
 * The PRIVATE key is non-exportable by design: there is no export of private
 * material and no import. Loss recovery is a routine rotation (§ H of the design).
 */
import { writeFile } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import type { Command } from 'commander';
import { createLogger, createPool, toErrorMessage } from '@kici-dev/shared';
import { runIdempotentStep } from '@kici-dev/shared/idempotency';
import { loadConfig } from '../../config.js';
import { createDb } from '../../db/client.js';
import { OrchestratorSigningKeyRepo } from '../../db/repos/signing-keys-repo.js';
import { DbSigner } from '../../oidc/db-signer.js';

const logger = createLogger({ prefix: 'kici-admin-signing-key' });

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
      'KICI_SECRET_KEY is required to generate a db-custody signing key (it wraps the private JWK).',
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

interface WithDb<T> {
  (repo: OrchestratorSigningKeyRepo): Promise<T>;
}

async function withRepo<T>(databaseUrl: string | undefined, fn: WithDb<T>): Promise<T> {
  const pool = createPool(resolveDatabaseUrl(databaseUrl));
  const db = createDb(pool);
  try {
    return await fn(new OrchestratorSigningKeyRepo(db));
  } finally {
    await db.destroy();
    await pool.end().catch(() => {});
  }
}

/** Generate a fresh db-custody key and activate it (demoting any prior active). */
async function generateAndActivate(
  repo: OrchestratorSigningKeyRepo,
  secretKey: string,
): Promise<string> {
  const g = await DbSigner.generate(secretKey);
  await repo.upsertActive({
    kid: g.kid,
    public_jwk: g.publicJwk as unknown as Record<string, unknown>,
    encrypted_private_jwk: g.encryptedPrivateJwk,
    alg: g.signer.alg,
    signer_kind: g.signer.signerKind,
    key_ref: g.signer.keyRef,
  });
  return g.kid;
}

export function registerSigningKeyCommands(program: Command): void {
  const signingKey = program
    .command('signing-key')
    .description('Orchestrator-owned provenance signing key management (orchestrator DB)');

  signingKey
    .command('list')
    .description('List provenance signing keys (kid / status / created_at)')
    .option('--database-url <url>', 'Orchestrator DB URL (else KICI_DATABASE_URL)')
    .option('--json', 'Emit raw JSON')
    .action(async (opts: { databaseUrl?: string; json?: boolean }) => {
      try {
        const rows = await withRepo(opts.databaseUrl, (repo) => repo.listTrusted());
        if (opts.json) {
          console.log(
            JSON.stringify(
              rows.map((r) => ({
                kid: r.kid,
                status: r.status,
                signerKind: r.signer_kind,
                createdAt: r.created_at,
              })),
              null,
              2,
            ),
          );
          return;
        }
        if (rows.length === 0) {
          process.stderr.write('No signing keys found.\n');
          return;
        }
        for (const r of rows) {
          console.log(
            `${r.kid}  ${r.status.padEnd(9)}  ${r.signer_kind.padEnd(8)}  ${r.created_at}`,
          );
        }
      } catch (err) {
        console.error(`Error: ${toErrorMessage(err)}`);
        process.exit(1);
      }
    });

  signingKey
    .command('generate')
    .description('Generate the initial db-custody signing key (no-op if one is active)')
    .option('--database-url <url>', 'Orchestrator DB URL (else KICI_DATABASE_URL)')
    .option('--yes', 'Skip the confirmation prompt')
    .option('--dry-run', 'Show what would happen without generating')
    .action(async (opts: { databaseUrl?: string; yes?: boolean; dryRun?: boolean }) => {
      try {
        const secretKey = resolveSecretKey();
        await withRepo(opts.databaseUrl, async (repo) => {
          await runIdempotentStep(
            {
              name: 'signing-key/generate',
              check: async () => ((await repo.getActiveRow()) ? null : { reason: 'no active key' }),
              summarize: () =>
                'Generate a new db-custody ES256 provenance signing key and activate it',
              apply: async () => {
                const kid = await generateAndActivate(repo, secretKey);
                logger.info('generated provenance signing key', { kid });
                process.stderr.write(`Generated active signing key ${kid}.\n`);
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

  signingKey
    .command('rotate')
    .description('Generate a new db-custody key and activate it (old key → retiring)')
    .option('--database-url <url>', 'Orchestrator DB URL (else KICI_DATABASE_URL)')
    .option('--yes', 'Skip the confirmation prompt')
    .option('--dry-run', 'Show what would happen without rotating')
    .action(async (opts: { databaseUrl?: string; yes?: boolean; dryRun?: boolean }) => {
      try {
        const secretKey = resolveSecretKey();
        await withRepo(opts.databaseUrl, async (repo) => {
          await runIdempotentStep(
            {
              name: 'signing-key/rotate',
              // Rotation always changes state (a fresh key is minted).
              check: async () => ({ reason: 'rotate to a new key' }),
              summarize: () =>
                'Generate a NEW db-custody ES256 signing key and activate it; the current active key becomes retiring (still served in the JWKS)',
              apply: async () => {
                const kid = await generateAndActivate(repo, secretKey);
                logger.info('rotated provenance signing key', { kid });
                process.stderr.write(`Rotated: new active signing key ${kid}.\n`);
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

  signingKey
    .command('retire <kid>')
    .description(
      'Move a retiring key to retired (stays in the JWKS; historical bundles keep verifying)',
    )
    .option('--database-url <url>', 'Orchestrator DB URL (else KICI_DATABASE_URL)')
    .action(async (kid: string, opts: { databaseUrl?: string }) => {
      try {
        await withRepo(opts.databaseUrl, (repo) => repo.retire(kid));
        process.stderr.write(`Retired signing key ${kid}.\n`);
      } catch (err) {
        console.error(`Error: ${toErrorMessage(err)}`);
        process.exit(1);
      }
    });

  signingKey
    .command('revoke <kid>')
    .description(
      'Distrust a compromised key (REMOVED from the JWKS; everything it signed is distrusted)',
    )
    .requiredOption('--reason <reason>', 'Why the key is being revoked (audit)')
    .option('--database-url <url>', 'Orchestrator DB URL (else KICI_DATABASE_URL)')
    .option('--yes', 'Skip the confirmation prompt')
    .action(async (kid: string, opts: { reason: string; databaseUrl?: string; yes?: boolean }) => {
      try {
        if (!opts.yes) {
          const ok = await confirmInteractive(
            `Revoke signing key ${kid}? Everything it ever signed becomes UNVERIFIABLE. [y/N] `,
          );
          if (!ok) {
            console.error('Aborted.');
            process.exit(1);
          }
        }
        await withRepo(opts.databaseUrl, (repo) => repo.revoke(kid, opts.reason));
        logger.info('revoked provenance signing key', { kid, reason: opts.reason });
        process.stderr.write(`Revoked signing key ${kid}.\n`);
      } catch (err) {
        console.error(`Error: ${toErrorMessage(err)}`);
        process.exit(1);
      }
    });

  signingKey
    .command('export')
    .description(
      'Export the { issuer, jwks } backup + air-gap trust-root artifact (public halves ONLY)',
    )
    .requiredOption(
      '--public',
      'Confirm export of PUBLIC key material only (private is non-exportable)',
    )
    .option('--out <file>', 'Write to a file instead of stdout')
    .option('--database-url <url>', 'Orchestrator DB URL (else KICI_DATABASE_URL)')
    .action(async (opts: { public: boolean; out?: string; databaseUrl?: string }) => {
      try {
        const config = loadConfig();
        const issuer = config.provenanceSigningIssuer;
        if (!issuer) {
          throw new Error(
            'KICI_ORCHESTRATOR_PROVENANCE_ISSUER is not configured; nothing to export.',
          );
        }
        const rows = await withRepo(opts.databaseUrl, (repo) => repo.listTrusted());
        const artifact = { issuer, jwks: { keys: rows.map((r) => r.public_jwk) } };
        const json = JSON.stringify(artifact, null, 2);
        if (opts.out) {
          await writeFile(opts.out, `${json}\n`);
          process.stderr.write(`Wrote trust-root export (${rows.length} key(s)) to ${opts.out}.\n`);
        } else {
          console.log(json);
        }
      } catch (err) {
        console.error(`Error: ${toErrorMessage(err)}`);
        process.exit(1);
      }
    });
}
