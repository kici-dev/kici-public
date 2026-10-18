import { describe, expect, it } from 'vitest';

import {
  collectHelpEntries,
  findDoubledDefaults,
  rendersDefault,
  statesDefaultTwice,
  type DefaultsHelpNode,
  type HelpEntry,
} from './cli-help-defaults.js';

interface FakeOption {
  flags: string;
  description: string;
  defaultValue?: unknown;
}

/** A command whose help renders a default the way Commander does: `<desc> (default: <json>)`. */
function node(
  name: string,
  options: FakeOption[],
  commands: DefaultsHelpNode[] = [],
  args: FakeOption[] = [],
): DefaultsHelpNode {
  const render = (item: { description: string }): string => {
    const { description, defaultValue } = item as FakeOption;
    if (defaultValue === undefined) return description;
    const suffix = `(default: ${JSON.stringify(defaultValue)})`;
    return description ? `${description} ${suffix}` : suffix;
  };
  return {
    name: () => name,
    commands,
    createHelp: () => ({
      visibleOptions: () => options,
      optionDescription: render,
      visibleArguments: () => args.map((a) => ({ ...a, name: () => a.flags })),
      argumentDescription: render,
    }),
  };
}

function entry(authored: string, rendered: string): HelpEntry {
  return { label: 'cli --x', authored, rendered };
}

describe('statesDefaultTwice', () => {
  it.each([
    ['Vault mount path (default: secret)', 'secret'],
    ['Max results (default 50, max 200)', '50'],
    ['Context type (defaults to "template")', 'template'],
    ['Step index (default 0; -1 is the job setup log)', '0'],
    ['Repo patterns. Default: ["*"]', '["*"]'],
    ['Output dir; defaults to the cwd', '.'],
  ])('flags %j with a rendered default', (authored, value) => {
    const rendered = `${authored} (default: ${JSON.stringify(value)})`;
    // fails-when: a hand-written default shape is not recognised, so the double prints.
    expect(statesDefaultTwice(entry(authored, rendered))).toBe(true);
  });

  it('flags a default Commander renders after choices or before env', () => {
    const authored = 'Mode (default: fast)';
    // fails-when: only a suffix that opens with `default:` counts, so a double behind
    // `choices:` slips through.
    expect(
      statesDefaultTwice(entry(authored, `${authored} (choices: "fast", "slow", default: "fast")`)),
    ).toBe(true);
    expect(statesDefaultTwice(entry(authored, `${authored} (default: "fast", env: MODE)`))).toBe(
      true,
    );
  });

  it.each([
    // breaks-if-wrong: an option stating its default once, either way, must stay clean.
    ['Vault mount path', 'Vault mount path (default: "secret")'],
    ['Vault mount path (default: secret)', 'Vault mount path (default: secret)'],
    // breaks-if-wrong: a passing use of the word is not a stated default.
    [
      'Fall back to the tier default (repeatable)',
      'Fall back to the tier default (repeatable) (default: [])',
    ],
    [
      'Open the form in the default browser',
      'Open the form in the default browser (default: false)',
    ],
    // breaks-if-wrong: a stated default beside a rendered env hint alone is single.
    ['Token (default: none)', 'Token (default: none) (env: TOKEN)'],
  ])('leaves %j alone', (authored, rendered) => {
    expect(statesDefaultTwice(entry(authored, rendered))).toBe(false);
  });
});

describe('rendersDefault', () => {
  it('reads only the suffix Commander appended', () => {
    // fails-when: a hand-written `(default: x)` in the authored text counts as rendered.
    expect(rendersDefault(entry('Path (default: x)', 'Path (default: x)'))).toBe(false);
    expect(rendersDefault(entry('', '(default: "x")'))).toBe(true);
  });
});

describe('findDoubledDefaults', () => {
  it('walks every nested command, option and argument', () => {
    const root = node(
      'cli',
      [{ flags: '--quiet', description: 'Less output' }],
      [
        node(
          'backend',
          [],
          [
            node(
              'add',
              [
                {
                  flags: '--mount-path <path>',
                  description: 'Vault mount path (default: secret)',
                  defaultValue: 'secret',
                },
                { flags: '--base-path <path>', description: 'Vault base path', defaultValue: 'kv' },
              ],
              [],
              [
                {
                  flags: 'name',
                  description: 'Backend name (default: main)',
                  defaultValue: 'main',
                },
              ],
            ),
          ],
        ),
      ],
    );
    expect(collectHelpEntries(root).map((e) => e.label)).toEqual([
      'cli --quiet',
      'cli backend add --mount-path <path>',
      'cli backend add --base-path <path>',
      'cli backend add <name>',
    ]);
    // fails-when: the walk stops above the leaf, skips arguments, or flags a single default.
    expect(findDoubledDefaults(root)).toEqual([
      'cli backend add --mount-path <path>: Vault mount path (default: secret) (default: "secret")',
      'cli backend add <name>: Backend name (default: main) (default: "main")',
    ]);
  });
});
