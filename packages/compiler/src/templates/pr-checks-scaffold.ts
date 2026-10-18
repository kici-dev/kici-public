/** pr-checks fitted to the repository: its default branch, and no `src/` filtering without `src/`. */

export interface PrChecksScaffoldOptions {
  defaultBranch: string;
  hasSrcDir: boolean;
}

/** Template text this module edits. Each must occur exactly once in the template. */
const PR_TRIGGER_ANCHOR = "on: pr({ target: 'main', paths: ['src/**'] }),";
const SRC_RULE_ANCHOR = `

    rule('require-src-changes', async (ctx) => {
      return ctx.changedFiles.some((file) => file.startsWith('src/'));
    }),`;
const SDK_IMPORT_ANCHOR =
  "import { workflow, job, step, pr, rule, skip, isEventType } from '@kici-dev/sdk';";
const SDK_IMPORT_WITHOUT_RULE =
  "import { workflow, job, step, pr, skip, isEventType } from '@kici-dev/sdk';";

/** A TypeScript single-quoted string literal whose value is exactly `value`. */
export function tsSingleQuoted(value: string): string {
  return `'${value.replace(/[\\']/g, (ch) => `\\${ch}`)}'`;
}

/** Replace `anchor`, which must occur exactly once, so template drift fails loudly. */
function replaceAnchor(content: string, name: string, anchor: string, replacement: string): string {
  const count = content.split(anchor).length - 1;
  if (count !== 1) {
    throw new Error(`pr-checks template: anchor "${name}" found ${count} times, expected 1`);
  }
  return content.replace(anchor, () => replacement);
}

/** The pr-checks template with its PR target and `src/` filtering fitted to the repository. */
export function scaffoldPrChecks(template: string, opts: PrChecksScaffoldOptions): string {
  const target = tsSingleQuoted(opts.defaultBranch);
  const trigger = opts.hasSrcDir
    ? `on: pr({ target: ${target}, paths: ['src/**'] }),`
    : `on: pr({ target: ${target} }),`;
  let content = replaceAnchor(template, 'pr-trigger', PR_TRIGGER_ANCHOR, trigger);
  content = replaceAnchor(
    content,
    'src-rule',
    SRC_RULE_ANCHOR,
    opts.hasSrcDir ? SRC_RULE_ANCHOR : '',
  );
  return replaceAnchor(
    content,
    'sdk-import',
    SDK_IMPORT_ANCHOR,
    opts.hasSrcDir ? SDK_IMPORT_ANCHOR : SDK_IMPORT_WITHOUT_RULE,
  );
}
