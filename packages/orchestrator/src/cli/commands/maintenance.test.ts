import { describe, expect, it } from 'vitest';
import { Command } from 'commander';
import { registerSecretCommands } from './secret.js';
import { registerSourceCommands } from './source.js';
import { registerMaintenanceCommands } from './maintenance.js';

function build(): Command {
  const program = new Command();
  program.exitOverride();
  const getClient = () => ({}) as any;
  // Maintenance must run after secret/source so it can attach purge verbs.
  registerSecretCommands(program, getClient);
  registerSourceCommands(program, getClient);
  registerMaintenanceCommands(program, getClient);
  return program;
}

describe('kici-admin maintenance commands', () => {
  it('registers queue clear with --confirm required', () => {
    const program = build();
    const queue = program.commands.find((c) => c.name() === 'queue');
    expect(queue).toBeDefined();
    const clear = queue!.commands.find((c) => c.name() === 'clear');
    expect(clear).toBeDefined();
    const required = clear!.options.filter((o) => o.mandatory).map((o) => o.long);
    expect(required).toContain('--confirm');
    expect(clear!.options.map((o) => o.long)).toContain('--yes');
  });

  it('registers execution purge-stale with --routing-key and --confirm required', () => {
    const program = build();
    const exec = program.commands.find((c) => c.name() === 'execution');
    expect(exec).toBeDefined();
    const purge = exec!.commands.find((c) => c.name() === 'purge-stale');
    expect(purge).toBeDefined();
    const required = purge!.options.filter((o) => o.mandatory).map((o) => o.long);
    expect(required).toEqual(expect.arrayContaining(['--routing-key', '--confirm']));
  });

  it('attaches secret purge to the existing secret namespace', () => {
    const program = build();
    const secret = program.commands.find((c) => c.name() === 'secret');
    expect(secret).toBeDefined();
    const purge = secret!.commands.find((c) => c.name() === 'purge');
    expect(purge).toBeDefined();
    const required = purge!.options.filter((o) => o.mandatory).map((o) => o.long);
    expect(required).toContain('--confirm');
    expect(purge!.options.map((o) => o.long)).toEqual(expect.arrayContaining(['--org', '--yes']));
  });

  it('attaches source purge-stale to the existing source namespace', () => {
    const program = build();
    const source = program.commands.find((c) => c.name() === 'source');
    expect(source).toBeDefined();
    const purge = source!.commands.find((c) => c.name() === 'purge-stale');
    expect(purge).toBeDefined();
    const required = purge!.options.filter((o) => o.mandatory).map((o) => o.long);
    expect(required).toContain('--routing-key');
    expect(purge!.options.map((o) => o.long)).toEqual(
      expect.arrayContaining(['--dry-run', '--confirm']),
    );
  });
});
