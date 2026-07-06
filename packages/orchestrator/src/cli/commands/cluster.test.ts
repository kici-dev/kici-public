import { describe, it, expect } from 'vitest';
import { Command } from 'commander';
import { registerClusterCommands } from './cluster.js';

// Surface id needle: cli:kici-admin:cluster reconcile-identity

describe('registerClusterCommands', () => {
  it('registers `cluster reconcile-identity` with --adopt-db, --dry-run, --yes', () => {
    const program = new Command();
    registerClusterCommands(program);
    const cluster = program.commands.find((c) => c.name() === 'cluster');
    expect(cluster).toBeDefined();
    const recon = cluster!.commands.find((c) => c.name() === 'reconcile-identity');
    expect(recon).toBeDefined();
    const optNames = recon!.options.map((o) => o.long);
    expect(optNames).toEqual(
      expect.arrayContaining(['--adopt-db', '--dry-run', '--yes', '--database-url', '--bucket']),
    );
  });
});
