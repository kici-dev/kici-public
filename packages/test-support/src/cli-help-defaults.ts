/**
 * Proves a CLI's `--help` states each option default once.
 *
 * Commander appends `(default: "x")` to an option or argument that has a
 * default value. A description that also spells the default out by hand
 * prints it twice: `Vault mount path (default: secret) (default: "secret")`.
 * The walk here reads the description Commander renders for every option and
 * argument of every command, and reports each one that carries both.
 */

/** An option or argument as Commander's help renders it. */
export interface DefaultsHelpItem {
  readonly description: string;
}

/** The slice of Commander's `Help` that renders one help entry. */
export interface DefaultsHelp {
  visibleOptions(
    cmd: DefaultsHelpNode,
  ): ReadonlyArray<DefaultsHelpItem & { readonly flags: string }>;
  optionDescription(option: DefaultsHelpItem): string;
  visibleArguments(cmd: DefaultsHelpNode): ReadonlyArray<DefaultsHelpItem & { name(): string }>;
  argumentDescription(argument: DefaultsHelpItem): string;
}

/** The structural slice of a Commander `Command` the walk needs. */
export interface DefaultsHelpNode {
  name(): string;
  createHelp(): DefaultsHelp;
  readonly commands: readonly DefaultsHelpNode[];
}

/**
 * A default stated in the author's own words: `(default: x)`, `(default 50, max 200)`,
 * `(defaults to "x")`, `Default: x`, `defaults to x`, `default is x`. A passing use of
 * the word ("the tier default", "the default browser") is not a statement of the
 * option's default and does not match.
 */
const HAND_WRITTEN_DEFAULT = /\(defaults?\b|\bdefaults?\s*:|\bdefaults?\s+(?:to|is)\b/i;

/** The `(…)` suffix Commander appends; it names the default as `default: <value>`. */
const RENDERED_DEFAULT = /^ ?\((?:.*, )?default: /;

/** One option or argument entry of a command's help. */
export interface HelpEntry {
  /** The command path and the flags (or `<argument>`), as `kici-admin backend add --mount-path <path>`. */
  readonly label: string;
  /** The description the CLI author wrote. */
  readonly authored: string;
  /** The description `--help` prints: the authored text plus Commander's `(…)` suffix. */
  readonly rendered: string;
}

/** Every option and argument entry of `root` and every command beneath it. */
export function collectHelpEntries(root: DefaultsHelpNode): HelpEntry[] {
  const entries: HelpEntry[] = [];
  const walk = (cmd: DefaultsHelpNode, path: string): void => {
    const help = cmd.createHelp();
    for (const option of help.visibleOptions(cmd)) {
      entries.push({
        label: `${path} ${option.flags}`,
        authored: option.description,
        rendered: help.optionDescription(option),
      });
    }
    for (const argument of help.visibleArguments(cmd)) {
      entries.push({
        label: `${path} <${argument.name()}>`,
        authored: argument.description,
        rendered: help.argumentDescription(argument),
      });
    }
    for (const sub of cmd.commands) walk(sub, `${path} ${sub.name()}`);
  };
  walk(root, root.name());
  return entries;
}

/** True when Commander appended a `default: …` to the authored description. */
export function rendersDefault(entry: HelpEntry): boolean {
  return (
    entry.rendered.startsWith(entry.authored) &&
    RENDERED_DEFAULT.test(entry.rendered.slice(entry.authored.length))
  );
}

/** True when the help entry states its default both by hand and through Commander. */
export function statesDefaultTwice(entry: HelpEntry): boolean {
  return rendersDefault(entry) && HAND_WRITTEN_DEFAULT.test(entry.authored);
}

/** `<label>: <rendered description>` for every entry under `root` that states its default twice. */
export function findDoubledDefaults(root: DefaultsHelpNode): string[] {
  return collectHelpEntries(root)
    .filter(statesDefaultTwice)
    .map((entry) => `${entry.label}: ${entry.rendered}`);
}
