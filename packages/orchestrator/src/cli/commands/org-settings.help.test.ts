/**
 * Pins the user-visible shape of `kici-admin org-settings`: every command's
 * name, description, arguments and options (with required and default
 * markers) in registration order, plus the rendered `--help` text of each
 * command in the tree.
 */

import { describe, expect, it } from 'vitest';
import { Command } from 'commander';
import { registerOrgSettingsCommands } from './org-settings.js';
import type { AdminApiClient } from '../api-client.js';

function buildOrgSettings(): Command {
  const program = new Command('kici-admin').configureHelp({ helpWidth: 100 });
  const noClient = (): AdminApiClient => {
    throw new Error('no client in a help test');
  };
  registerOrgSettingsCommands(program, noClient);
  return program.commands.find((c) => c.name() === 'org-settings')!;
}

function helpTree(cmd: Command, prefix = ''): string[] {
  const out = [`${prefix}${cmd.name()} :: ${cmd.description()}`];
  for (const a of cmd.registeredArguments) {
    out.push(`${prefix}  arg ${a.name()} required=${a.required} :: ${a.description}`);
  }
  for (const o of cmd.options) {
    const dflt = o.defaultValue === undefined ? '' : ` default=${String(o.defaultValue)}`;
    out.push(`${prefix}  ${o.flags} mandatory=${o.mandatory}${dflt} :: ${o.description}`);
  }
  for (const sub of cmd.commands) out.push(...helpTree(sub, `${prefix}  `));
  return out;
}

function allCommands(cmd: Command, path: string[] = []): Array<[string, Command]> {
  const here: Array<[string, Command]> = [[[...path, cmd.name()].join(' '), cmd]];
  return here.concat(...cmd.commands.map((sub) => allCommands(sub, [...path, cmd.name()])));
}

describe('org-settings help pin', () => {
  // fails-when: a command, argument or option is added, removed, reordered, or
  // changes its text, required marker or default anywhere in the org-settings tree.
  it('keeps the full command tree unchanged', () => {
    expect(helpTree(buildOrgSettings()).join('\n')).toMatchSnapshot();
  });

  // fails-when: the rendered --help text of any org-settings command changes.
  it.each(allCommands(buildOrgSettings()))('%s --help is unchanged', (_path, cmd) => {
    expect(cmd.helpInformation()).toMatchSnapshot();
  });
});
