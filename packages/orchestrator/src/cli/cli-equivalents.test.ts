/**
 * Guard: every dashboard-write `cliEquivalent` names a `kici-admin` command
 * that exists.
 *
 * The dashboard, the Platform's policy 403 and `kici-admin org-settings
 * dashboard-writes show` all print an operation's `cliEquivalent` as the
 * command an operator runs once the dashboard write is disabled. The string is
 * free-form in the engine registry, so this test walks the real `buildProgram()`
 * tree and resolves each one: the command path, every `--flag`, and every
 * `<arg>` / `[arg]` placeholder must exist on the command it names.
 */
import { describe, it, expect } from 'vitest';
import type { Command } from 'commander';
import { DASHBOARD_WRITE_OPERATIONS } from '@kici-dev/engine/protocol/dashboard-write-operations';
import { buildProgram } from './kici-admin.js';

const BINARY = 'kici-admin';

function isPlaceholder(token: string): boolean {
  return (
    (token.startsWith('<') && token.endsWith('>')) || (token.startsWith('[') && token.endsWith(']'))
  );
}

function findOption(cmd: Command, flag: string) {
  return cmd.options.find((o) => o.long === flag || o.short === flag);
}

/**
 * Resolve one `cliEquivalent` string against a Commander program.
 *
 * Returns one message per problem; an empty array means the string names a
 * command path, flags and argument placeholders that all exist.
 */
function checkCliEquivalent(program: Command, cliEquivalent: string): string[] {
  const tokens = cliEquivalent.trim().split(/\s+/);
  if (tokens[0] !== BINARY) {
    return [`"${cliEquivalent}" does not start with "${BINARY}"`];
  }

  const problems: string[] = [];
  let node: Command = program;
  const path: string[] = [];
  let i = 1;
  // The command path is every leading token that is not a flag or a placeholder.
  for (; i < tokens.length; i++) {
    const seg = tokens[i];
    if (seg.startsWith('-') || isPlaceholder(seg)) break;
    const next = node.commands.find((c) => c.name() === seg);
    if (!next) {
      const parent = [BINARY, ...path].join(' ');
      return [`"${cliEquivalent}": "${parent}" has no subcommand "${seg}"`];
    }
    node = next;
    path.push(seg);
  }
  if (path.length === 0) {
    return [`"${cliEquivalent}" names no subcommand`];
  }

  const where = [BINARY, ...path].join(' ');
  let valueExpected = false;
  for (; i < tokens.length; i++) {
    const token = tokens[i];
    if (token.startsWith('-')) {
      const [flag, inlineValue] = token.split('=', 2);
      const option = findOption(node, flag) ?? findOption(program, flag);
      if (!option) {
        problems.push(`"${cliEquivalent}": "${where}" has no option "${flag}"`);
        valueExpected = false;
        continue;
      }
      const takesValue = option.required || option.optional;
      valueExpected = takesValue && inlineValue === undefined;
      continue;
    }
    if (isPlaceholder(token)) {
      const name = token.slice(1, -1).replace(/\.\.\.$/, '');
      const args = node.registeredArguments.map((a) => a.name());
      if (valueExpected) {
        valueExpected = false;
        continue;
      }
      if (!args.includes(name)) {
        problems.push(
          `"${cliEquivalent}": "${where}" has no argument "${name}" (arguments: ${args.join(', ') || 'none'})`,
        );
      }
      continue;
    }
    // A bare token after the command path is only valid as the value of the
    // option just before it.
    if (!valueExpected) {
      problems.push(
        `"${cliEquivalent}": unexpected token "${token}" after "${where}" (not a subcommand, option value or placeholder)`,
      );
    }
    valueExpected = false;
  }
  return problems;
}

describe('dashboard-write cliEquivalent strings', () => {
  const program = buildProgram();

  it('names a kici-admin command, flags and arguments that exist, for every operation', () => {
    const problems = DASHBOARD_WRITE_OPERATIONS.flatMap((d) =>
      checkCliEquivalent(program, d.cliEquivalent).map((p) => `${d.name}: ${p}`),
    );
    // fails-when: an entry names a subcommand, an option or an argument the
    //   `kici-admin` tree does not register (e.g. `kici-admin backend sync --one`).
    // breaks-if-wrong: the entries that do resolve (`kici-admin secret set`,
    //   `kici-admin context set-policy --allow-local-execution`,
    //   `kici-admin held-run approve`) must still produce no problem.
    expect(problems).toEqual([]);
  });

  it('covers every operation in the registry', () => {
    // fails-when: the walk silently checks nothing (an empty registry import).
    expect(DASHBOARD_WRITE_OPERATIONS.length).toBeGreaterThan(0);
    for (const d of DASHBOARD_WRITE_OPERATIONS) {
      expect(d.cliEquivalent.startsWith(`${BINARY} `), d.name).toBe(true);
    }
  });
});

describe('checkCliEquivalent', () => {
  const program = buildProgram();

  // Each input below must be refused: together they prove the checker can see
  // a missing command, a missing option, a missing argument and a stray token.
  it.each([
    ['a missing subcommand', 'kici-admin secret no-such-verb', 'has no subcommand "no-such-verb"'],
    ['a missing group', 'kici-admin no-such-group list', 'has no subcommand "no-such-group"'],
    ['a missing option', 'kici-admin backend sync --one', 'has no option "--one"'],
    ['a missing argument', 'kici-admin backend sync <backend>', 'has no argument "backend"'],
    ['a bare argument value', 'kici-admin backend sync vault-prod', 'no subcommand "vault-prod"'],
    [
      'a stray bare token',
      'kici-admin backend sync <name> vault-prod',
      'unexpected token "vault-prod"',
    ],
    ['another binary', 'kici secret set', 'does not start with "kici-admin"'],
    ['no subcommand at all', 'kici-admin --url', 'names no subcommand'],
  ])('refuses %s', (_label, input, message) => {
    // fails-when: the checker accepts the input (returns no problem).
    const problems = checkCliEquivalent(program, input);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain(message);
  });

  // breaks-if-wrong: each of these names something that exists, so the checker
  // must return no problem for it.
  it.each([
    ['a leaf command', 'kici-admin secret set'],
    ['a group node', 'kici-admin org-settings global-workflows'],
    ['a boolean-valued option', 'kici-admin context set-policy --allow-local-execution'],
    ['an option and its value', 'kici-admin context set-policy --env <name>'],
    ['an inline option value', 'kici-admin context set-policy --env=staging'],
    ['an optional argument', 'kici-admin backend sync <name>'],
    ['a bracketed optional argument', 'kici-admin backend sync [name]'],
    ['a global option', 'kici-admin backend sync --url'],
  ])('accepts %s', (_label, input) => {
    expect(checkCliEquivalent(program, input)).toEqual([]);
  });
});
