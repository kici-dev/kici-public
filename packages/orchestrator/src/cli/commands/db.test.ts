import { describe, expect, it } from 'vitest';
import { Command } from 'commander';
import { registerDbCommands } from './db.js';

function buildDbCommand(): Command {
  const program = new Command();
  program.exitOverride();
  const mockGetClient = () => ({}) as any;
  registerDbCommands(program, mockGetClient);
  return program.commands.find((c) => c.name() === 'db')!;
}

describe('kici-admin db namespace', () => {
  it('registers migrate (existing HTTP-based)', () => {
    const db = buildDbCommand();
    const migrate = db.commands.find((c) => c.name() === 'migrate');
    expect(migrate).toBeDefined();
    expect(migrate!.options.map((o) => o.long)).toContain('--status');
  });

  it('registers fresh with --confirm required and --yes / --database-url optional', () => {
    const db = buildDbCommand();
    const fresh = db.commands.find((c) => c.name() === 'fresh');
    expect(fresh).toBeDefined();
    const required = fresh!.options.filter((o) => o.mandatory).map((o) => o.long);
    expect(required).toContain('--confirm');
    const flags = fresh!.options.map((o) => o.long);
    expect(flags).toEqual(expect.arrayContaining(['--database-url', '--yes']));
  });

  it('registers ensure <name>', () => {
    const db = buildDbCommand();
    const ensure = db.commands.find((c) => c.name() === 'ensure');
    expect(ensure).toBeDefined();
    expect(ensure!.options.map((o) => o.long)).toContain('--database-url');
    expect(ensure!.options.map((o) => o.long)).toContain('--grant-connect-role');
  });

  it('registers create-role with required user/password and optional createdb', () => {
    const db = buildDbCommand();
    const createRole = db.commands.find((c) => c.name() === 'create-role');
    expect(createRole).toBeDefined();
    const required = createRole!.options.filter((o) => o.mandatory).map((o) => o.long);
    expect(required).toEqual(expect.arrayContaining(['--user', '--password']));
    expect(createRole!.options.map((o) => o.long)).toContain('--createdb');
  });

  it('registers create-readonly-user with required user/password', () => {
    const db = buildDbCommand();
    const createRo = db.commands.find((c) => c.name() === 'create-readonly-user');
    expect(createRo).toBeDefined();
    const required = createRo!.options.filter((o) => o.mandatory).map((o) => o.long);
    expect(required).toEqual(expect.arrayContaining(['--user', '--password']));
  });

  it('registers check-schema with --json', () => {
    const db = buildDbCommand();
    const check = db.commands.find((c) => c.name() === 'check-schema');
    expect(check).toBeDefined();
    expect(check!.options.map((o) => o.long)).toContain('--json');
  });
});
