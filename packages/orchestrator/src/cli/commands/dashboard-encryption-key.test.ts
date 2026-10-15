import { beforeAll, describe, expect, it } from 'vitest';
import { Command } from 'commander';
import { registerDashboardEncryptionKeyCommands } from './dashboard-encryption-key.js';

/**
 * Command tree wiring with the runbook's flags. The DB-direct behavior is
 * covered in `src/secrets/` (`dashboard-encryption-keys-repo.test.ts`,
 * `dashboard-encryption-key.test.ts`).
 *
 * Surface ids exercised here (needled by the coverage gate):
 *   cli:kici-admin:dashboard-encryption-key
 *   cli:kici-admin:dashboard-encryption-key show
 *   cli:kici-admin:dashboard-encryption-key list
 *   cli:kici-admin:dashboard-encryption-key rotate
 */
describe('kici-admin dashboard-encryption-key command tree', () => {
  let program: Command;

  beforeAll(() => {
    program = new Command();
    program.exitOverride();
    registerDashboardEncryptionKeyCommands(program);
  });

  it('registers the group and all subcommands', () => {
    const group = program.commands.find((c) => c.name() === 'dashboard-encryption-key');
    expect(group).toBeDefined();
    expect(group!.commands.map((c) => c.name()).sort()).toEqual(['list', 'rotate', 'show']);
  });

  it('rotate exposes the idempotent-step confirm / dry-run flags', () => {
    const group = program.commands.find((c) => c.name() === 'dashboard-encryption-key')!;
    const rotate = group.commands.find((c) => c.name() === 'rotate')!;
    const longs = rotate.options.map((o) => o.long);
    expect(longs).toContain('--yes');
    expect(longs).toContain('--dry-run');
    // Rotation must not orphan in-flight browsers holding the previous kid.
    expect(rotate.description()).toMatch(/still decrypts/i);
  });

  it('show advertises both JWKS URLs, not one conflated URL', () => {
    const group = program.commands.find((c) => c.name() === 'dashboard-encryption-key')!;
    const show = group.commands.find((c) => c.name() === 'show')!;
    expect(show.description()).toMatch(/JWKS URLs/);
  });

  it('show and list support --json for scripted operator use', () => {
    const group = program.commands.find((c) => c.name() === 'dashboard-encryption-key')!;
    for (const name of ['show', 'list']) {
      const cmd = group.commands.find((c) => c.name() === name)!;
      expect(cmd.options.map((o) => o.long)).toContain('--json');
    }
  });
});
