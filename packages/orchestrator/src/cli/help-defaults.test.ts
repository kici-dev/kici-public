/**
 * `kici-admin --help` (top level and every subcommand) states each option
 * default once: Commander renders it, so no description spells it out too.
 */
import { describe, expect, it } from 'vitest';
import { collectHelpEntries, findDoubledDefaults } from '@kici-dev/test-support/cli-help-defaults';
import { buildProgram } from './kici-admin.js';

describe('kici-admin help states each default once', () => {
  it('prints no doubled default in the help of any command', () => {
    const program = buildProgram();
    // fails-when: a description hand-writes the default Commander also renders, as
    // `Vault mount path (default: secret) (default: "secret")` did.
    expect(findDoubledDefaults(program)).toEqual([]);
    const mountPath = collectHelpEntries(program).find(
      (e) => e.label === 'kici-admin backend add --mount-path <path>',
    );
    // breaks-if-wrong: dropping the hand-written text must keep Commander's rendered default.
    expect(mountPath?.rendered).toBe('Vault mount path (default: "secret")');
  });

  it('catches a doubled default grafted onto the real command tree', () => {
    const program = buildProgram();
    program
      .command('fixture')
      .command('add')
      .argument('[name]', 'Backend name (default: main)', 'main')
      .option('--mount-path <path>', 'Vault mount path (default: secret)', 'secret')
      .option('--limit <n>', 'Max results (default 50, max 200)', '50')
      .option('--scope <s>', 'Scope filter (default: all)');
    // fails-when: the walk misses a nested command, an argument, or a hand-written
    // default that Commander also renders; an option with no Commander default stays clean.
    expect(findDoubledDefaults(program)).toEqual([
      'kici-admin fixture add --mount-path <path>: Vault mount path (default: secret) (default: "secret")',
      'kici-admin fixture add --limit <n>: Max results (default 50, max 200) (default: "50")',
      'kici-admin fixture add <name>: Backend name (default: main) (default: "main")',
    ]);
  });
});
