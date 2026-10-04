import { describe, it, expect } from 'vitest';
import { Command } from 'commander';
import { routeRootArgs, ROOT_VERSION_FLAG } from './root-option-routing.js';

/**
 * A small tree with the shapes the router must tell apart: a root with value,
 * optional-value and boolean options; a group whose leaf declares `--url` (a
 * root flag) and `--version`; and a leaf that declares neither.
 */
function tree(): Command {
  const root = new Command('kici-admin')
    .option('-u, --url <url>')
    .option('-t, --token <token>')
    .option('-c, --color [when]')
    .option('-q, --quiet')
    .version('1.0.0', `-V, ${ROOT_VERSION_FLAG}`);
  const orch = root.command('orchestrator').alias('orch');
  orch.command('upgrade').option('--url <url>').option('--version <version>').option('--yes');
  orch.command('status <name>');
  root.command('join').option('--token <token>');
  return root;
}

/** The routed argv with each stand-in restored, plus which indices were hidden. */
function route(args: string[]): { routed: string[]; hidden: number[]; restored: string[] } {
  const r = routeRootArgs(tree(), args);
  const hidden = r.args.flatMap((a, i) => (a !== args[i] && a !== ROOT_VERSION_FLAG ? [i] : []));
  return { routed: r.args, hidden, restored: r.args.map(r.restore) };
}

describe('routeRootArgs: --version', () => {
  it('rewrites a --version that comes before the command name', () => {
    expect(route(['--version']).routed).toEqual([ROOT_VERSION_FLAG]);
    expect(route(['-q', '-u', 'http://x', '--version']).routed).toEqual([
      '-q',
      '-u',
      'http://x',
      ROOT_VERSION_FLAG,
    ]);
  });

  it('leaves a --version after the command name to the command', () => {
    const args = ['orchestrator', 'upgrade', '--version', '1.2.3'];
    expect(route(args).routed).toEqual(args);
    expect(route(['-u', 'http://x', 'orchestrator', '--version']).routed).toEqual([
      '-u',
      'http://x',
      'orchestrator',
      '--version',
    ]);
  });

  it('skips the value of a root option that takes one', () => {
    expect(route(['-u', '--version']).routed).toEqual(['-u', '--version']);
    // An optional value is taken only when it does not look like an option.
    expect(route(['-c', 'always', '--version']).routed).toEqual([
      '-c',
      'always',
      ROOT_VERSION_FLAG,
    ]);
    expect(route(['-c', '--version']).routed).toEqual(['-c', ROOT_VERSION_FLAG]);
  });

  it('stops at the -- terminator', () => {
    expect(route(['--', '--version']).routed).toEqual(['--', '--version']);
  });
});

describe('routeRootArgs: a command option under a root flag', () => {
  // fails-when: the router passes the flag through — the root then consumes it.
  it('hides the flag and its value from the root after the declaring command', () => {
    const args = ['orchestrator', 'upgrade', '--url', 'https://x/o.tgz', '--yes'];
    const r = route(args);
    expect(r.hidden).toEqual([2, 3]);
    // Each stand-in looks like an option the root does not know, so the root
    // hands it, and everything after it, to the subcommand.
    for (const i of r.hidden) expect(r.routed[i]).toMatch(/^--/);
    expect(r.restored).toEqual(args);
  });

  it('hides an inline --url=<value> as one token', () => {
    const r = route(['orchestrator', 'upgrade', '--url=https://x/o.tgz']);
    expect(r.hidden).toEqual([2]);
    expect(r.restored[2]).toBe('--url=https://x/o.tgz');
  });

  it('follows a command alias', () => {
    expect(route(['orch', 'upgrade', '--url', 'https://x']).hidden).toEqual([2, 3]);
  });

  it('gives each hidden token its own stand-in', () => {
    const r = route(['join', '--token', 'a', '--token', 'b']);
    expect(r.hidden).toEqual([1, 2, 3, 4]);
    expect(new Set(r.hidden.map((i) => r.routed[i])).size).toBe(4);
    expect(r.restored).toEqual(['join', '--token', 'a', '--token', 'b']);
  });

  // breaks-if-wrong: everything else still reaches the root as typed.
  it('leaves a root flag the command does not declare to the root', () => {
    expect(route(['orchestrator', 'upgrade', '-u', 'http://o', '-t', 'adm']).hidden).toEqual([]);
    expect(route(['join', '-t', 'adm', '--url', 'http://o']).hidden).toEqual([]);
    expect(route(['orchestrator', 'status', 'svc', '--url', 'http://o']).hidden).toEqual([]);
  });

  it('leaves the flag to the root before the declaring command', () => {
    expect(route(['--url', 'http://o', 'orchestrator', 'upgrade']).hidden).toEqual([]);
    expect(route(['orchestrator', '--url', 'http://o', 'upgrade']).hidden).toEqual([]);
  });

  it('does not read a token after a positional argument as a command name', () => {
    // Commander dispatches only on the first operand, so `orchestrator` after
    // the unknown `nosuch` is an argument, and the chain never reaches upgrade.
    expect(route(['nosuch', 'orchestrator', 'upgrade', '--url', 'http://o']).hidden).toEqual([]);
    expect(route(['orchestrator', 'status', 'svc', '--url', 'http://o']).hidden).toEqual([]);
  });

  // fails-when: the router skips a command option's value without hiding it —
  // the root then reads `-V` as its version flag.
  // breaks-if-wrong: a value that does not look like an option is not hidden.
  it('hides an option-shaped value of a command option from the root', () => {
    const r = route(['orchestrator', 'upgrade', '--version', '-V']);
    expect(r.hidden).toEqual([3]);
    expect(r.restored).toEqual(['orchestrator', 'upgrade', '--version', '-V']);
    expect(route(['orchestrator', 'upgrade', '--version', '1.2.3']).hidden).toEqual([]);
  });

  it('does not route past the -- terminator', () => {
    expect(route(['join', '--', '--token', 'a']).hidden).toEqual([]);
  });
});
