/**
 * Decides which command each root-option token in a kici-admin argv belongs to.
 *
 * Commander's root `parseOptions` consumes `-u, --url`, `-t, --token` and
 * `-V, --cli-version` anywhere in argv. That allows `kici-admin runs list -u
 * <url>`, but would also steal a same-named command option such as
 * `orchestrator upgrade --url <archive-url>` or `join --token <join-token>`.
 *
 * {@link routeRootArgs} prepares the argv for the root:
 *
 * - A root-named flag that the running command declares, after the command's
 *   name, belongs to the command. An opaque stand-in hides it; the root treats
 *   the stand-in as unknown and passes it on, and it is restored before the
 *   subcommand parses.
 * - `--version` before the first command name becomes `--cli-version`: the
 *   root cannot register `--version` (`orchestrator upgrade` and
 *   `agent upgrade` own `--version <version>`). After a command name it stays.
 * - An option-shaped command option value (`-uP4ss`, `--url`) is hidden the
 *   same way.
 *
 * Every other token reaches the root unchanged, so a root option after a
 * command that does not declare it still sets the global option.
 */

import type { Command, Option } from 'commander';

/** The flag the root registers its version option under. */
export const ROOT_VERSION_FLAG = '--cli-version';

/**
 * `--` makes the root read a stand-in as unknown, moving it and every later
 * token to the subcommand; U+0000 rules out a collision, since a process
 * argument cannot contain NUL.
 */
const SHIELD_PREFIX = '--\u0000kici-admin-command-option-';

/** The root's argv, routed, and the map from each stand-in back to its token. */
export interface RoutedRootArgs {
  readonly args: string[];
  readonly restore: (token: string) => string;
}

function isOptionLike(arg: string): boolean {
  return arg.length > 1 && arg.startsWith('-');
}

/** The flag part of an option token: `--url=x` → `--url`, `-u` → `-u`. */
function flagOf(arg: string): { flag: string; inlineValue: boolean } {
  if (arg.startsWith('--')) {
    const eq = arg.indexOf('=');
    if (eq > 2) return { flag: arg.slice(0, eq), inlineValue: true };
  }
  return { flag: arg, inlineValue: false };
}

function findOption(options: readonly Option[], flag: string): Option | undefined {
  return options.find((o) => o.long === flag || o.short === flag);
}

function findSubcommand(cmd: Command, name: string): Command | undefined {
  return cmd.commands.find((c) => c.name() === name || c.aliases().includes(name));
}

/** Tokens after `args[i]` an option takes as its value; an inline `--url=x` takes none. */
function valueTokens(
  option: Option | undefined,
  inlineValue: boolean,
  args: readonly string[],
  i: number,
): number {
  if (!option || inlineValue) return 0;
  if (option.required) return i + 1 < args.length ? 1 : 0;
  if (option.optional) {
    const next = args[i + 1];
    return next !== undefined && !isOptionLike(next) ? 1 : 0;
  }
  return 0;
}

/** `args` excludes `node` and the script. See the module comment. */
export function routeRootArgs(root: Command, args: readonly string[]): RoutedRootArgs {
  const out = [...args];
  const shielded = new Map<string, string>();
  const shield = (index: number): void => {
    const token = `${SHIELD_PREFIX}${index}`;
    shielded.set(token, out[index]!);
    out[index] = token;
  };

  // Commands entered below the root, outermost first.
  const chain: Command[] = [];
  let current = root;
  // After the first positional, later operands are arguments, not subcommands.
  let operandSeen = false;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === '--') break;

    if (!isOptionLike(arg)) {
      const sub = operandSeen ? undefined : findSubcommand(current, arg);
      if (sub) {
        chain.push(sub);
        current = sub;
      } else {
        operandSeen = true;
      }
      continue;
    }

    if (chain.length === 0 && arg === '--version') {
      out[i] = ROOT_VERSION_FLAG;
      continue;
    }

    const { flag, inlineValue } = flagOf(arg);
    const rootOption = findOption(root.options, flag);
    const commandOption = chain
      .map((c) => findOption(c.options, flag))
      .findLast((o) => o !== undefined);
    const skip = valueTokens(commandOption ?? rootOption, inlineValue, args, i);

    if (rootOption && commandOption) {
      // The command declares this flag: hide it, and its value, from the root.
      for (let k = i; k <= i + skip; k++) shield(k);
    } else if (commandOption && skip > 0 && isOptionLike(args[i + 1]!)) {
      // A command option's value shaped like an option (`--password -uP4ss`)
      // belongs to the command: hide it, or the root reads it as its own flag.
      shield(i + 1);
    }
    i += skip;
  }

  return {
    args: out,
    restore: (token) => shielded.get(token) ?? token,
  };
}
