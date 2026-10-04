/**
 * Decide which command each root-option token in a kici-admin argv belongs to.
 *
 * Commander matches a program option anywhere in argv: the root's own
 * `parseOptions` consumes `-u, --url`, `-t, --token` and `-V, --cli-version`
 * even after a command name. That lets an operator put a global option after
 * the command (`kici-admin runs list -u <url>`), but on its own it would also
 * take an option away from any command that declares one with the same flag,
 * such as `orchestrator upgrade --url <archive-url>` or
 * `join --token <join-token>`.
 *
 * {@link routeRootArgs} prepares the argv for the root's `parseOptions`:
 *
 * - A flag that the command being run declares, and that also names a root
 *   option, belongs to that command when it comes after the command's name. It
 *   is hidden from the root behind an opaque stand-in token, which the root
 *   classifies as an unknown option and so hands on to the subcommand; the
 *   stand-ins are mapped back to the original tokens before the subcommand
 *   parses them.
 * - `--version` before the first command name is the root's version flag. The
 *   root cannot register `--version` itself (`orchestrator upgrade` and
 *   `agent upgrade` own `--version <version>`), so it is rewritten to the
 *   registered `--cli-version`. After a command name it is left alone.
 *
 * - The value of a command option, when it is shaped like an option (`-uP4ss`,
 *   `--url`), is hidden from the root the same way, so the root does not read
 *   it as one of its own flags.
 *
 * Every other token reaches the root unchanged, so a root option after a
 * command that does not declare that flag still sets the global option.
 */

import type { Command, Option } from 'commander';

/** The flag the root registers its version option under. */
export const ROOT_VERSION_FLAG = '--cli-version';

/**
 * Prefix of the stand-in tokens. It starts with `--` so the root reads it as an
 * unknown option (which moves it and every later token to the subcommand's
 * argv), and the U+0000 makes a collision with a real argument impossible: a
 * process argument cannot contain a NUL byte.
 */
const SHIELD_PREFIX = '--\u0000kici-admin-command-option-';

/** The root's argv, routed, and the map from each stand-in back to its token. */
export interface RoutedRootArgs {
  readonly args: string[];
  /** Map a token from the root's parse result back to the original token. */
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

/**
 * How many tokens after `args[i]` an option consumes as its value. An option
 * value given inline (`--url=x`) consumes none.
 */
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

/**
 * Route a kici-admin argv (the user arguments, without `node` and the script)
 * for the root command's `parseOptions`. See the module comment.
 */
export function routeRootArgs(root: Command, args: readonly string[]): RoutedRootArgs {
  const out = [...args];
  const shielded = new Map<string, string>();
  const shield = (index: number): void => {
    const token = `${SHIELD_PREFIX}${index}`;
    shielded.set(token, out[index]!);
    out[index] = token;
  };

  // The commands entered so far, below the root, from the outermost down.
  const chain: Command[] = [];
  let current = root;
  // Once the deepest command has a positional argument, later operands are
  // arguments, not subcommand names.
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
