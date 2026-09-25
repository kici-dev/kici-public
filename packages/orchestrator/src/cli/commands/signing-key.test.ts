import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { Command } from 'commander';
import { registerSigningKeyCommands } from './signing-key.js';

/**
 * The `kici-admin signing-key` command tree wiring: list / generate / rotate /
 * retire / revoke / export are all registered. The DB-direct behavior
 * (generate/rotate/export against real rows) is covered by the repo unit tests
 * (signing-keys-repo.test.ts), the DbSigner tests, and the
 * provenance-orchestrator-signing E2E. `list` in both its database and
 * admin-API modes is covered by signing-key-list.test.ts.
 *
 * Surface ids exercised here (needled by the coverage gate):
 *   cli:kici-admin:signing-key
 *   cli:kici-admin:signing-key list
 *   cli:kici-admin:signing-key generate
 *   cli:kici-admin:signing-key rotate
 *   cli:kici-admin:signing-key retire
 *   cli:kici-admin:signing-key revoke
 *   cli:kici-admin:signing-key export
 */
describe('kici-admin signing-key command tree', () => {
  let program: Command;

  beforeAll(() => {
    program = new Command();
    program.exitOverride();
    registerSigningKeyCommands(program, () => {
      throw new Error('registration alone never builds an admin client');
    });
  });

  afterAll(() => {
    // nothing to tear down (no DB opened by registration alone)
  });

  it('registers the signing-key group and all subcommands', () => {
    const group = program.commands.find((c) => c.name() === 'signing-key');
    expect(group).toBeDefined();
    const subs = group!.commands.map((c) => c.name()).sort();
    expect(subs).toEqual(['export', 'generate', 'list', 'retire', 'revoke', 'rotate']);
  });

  it('export requires --public (private material is never exportable)', () => {
    const group = program.commands.find((c) => c.name() === 'signing-key')!;
    const exportCmd = group.commands.find((c) => c.name() === 'export')!;
    // --public is a requiredOption; its description names the public-only contract.
    const publicOpt = exportCmd.options.find((o) => o.long === '--public');
    expect(publicOpt?.mandatory).toBe(true);
    expect(exportCmd.description()).toMatch(/public halves ONLY/i);
  });

  it('revoke requires a reason (audit)', () => {
    const group = program.commands.find((c) => c.name() === 'signing-key')!;
    const revokeCmd = group.commands.find((c) => c.name() === 'revoke')!;
    const reasonOpt = revokeCmd.options.find((o) => o.long === '--reason');
    expect(reasonOpt?.required).toBe(true);
  });
});

describe('kici-admin signing-key list with no data source', () => {
  const savedDatabaseUrl = process.env.KICI_DATABASE_URL;

  afterEach(() => {
    vi.restoreAllMocks();
    if (savedDatabaseUrl === undefined) delete process.env.KICI_DATABASE_URL;
    else process.env.KICI_DATABASE_URL = savedDatabaseUrl;
  });

  it('names both ways to reach the keys when neither a database URL nor a token is set', async () => {
    delete process.env.KICI_DATABASE_URL;
    const errors: string[] = [];
    vi.spyOn(console, 'error').mockImplementation((line: unknown) => {
      errors.push(String(line));
    });
    const exit = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);
    const program = new Command();
    program.exitOverride();
    registerSigningKeyCommands(program, () => null);
    await program.parseAsync(['node', 'kici-admin', 'signing-key', 'list']);
    expect(exit).toHaveBeenCalledWith(1);
    // fails-when: the command names only the admin token, leaving an operator
    // with database access no hint that --database-url works too.
    expect(errors.join('\n')).toMatch(/--database-url/);
    expect(errors.join('\n')).toMatch(/--token/);
    expect(errors.join('\n')).toMatch(/KICI_ADMIN_TOKEN/);
  });
});
