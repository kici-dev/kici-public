import { describe, expect, it } from 'vitest';
import { PassThrough } from 'node:stream';
import { confirmPrompt, NO_CONFIRMATION_ANSWER } from './confirm.js';

/** A prompt wired to in-memory streams; `answer` is what the operator types. */
function prompt(answer: string | null): { result: Promise<boolean>; written: () => string } {
  const input = new PassThrough();
  const output = new PassThrough();
  let written = '';
  output.on('data', (chunk: Buffer) => {
    written += chunk.toString();
  });
  const result = confirmPrompt('Delete it? [y/N] ', { input, output });
  if (answer !== null) input.write(answer);
  input.end();
  return { result, written: () => written };
}

describe('confirmPrompt', () => {
  it.each([
    ['y', 'y\n'],
    ['yes', 'yes\n'],
    ['upper-case YES', 'YES\n'],
    ['an answer padded with spaces', '  y  \n'],
    ['a last line with no newline', 'y'],
  ])('resolves true for %s', async (_label, answer) => {
    // breaks-if-wrong: an operator who answers yes must still get the action.
    await expect(prompt(answer).result).resolves.toBe(true);
  });

  it.each([
    ['n', 'n\n'],
    ['an empty line (the [y/N] default)', '\n'],
    ['any other word', 'sure\n'],
  ])('resolves false for %s', async (_label, answer) => {
    await expect(prompt(answer).result).resolves.toBe(false);
  });

  it('rejects when stdin ends before any answer', async () => {
    // fails-when: a closed stdin resolves false (or never settles), so a verb
    //   run from a script without --yes exits 0 having done nothing.
    await expect(prompt(null).result).rejects.toThrow(NO_CONFIRMATION_ANSWER);
  });

  it('writes the prompt to the output stream', async () => {
    const p = prompt('n\n');
    await p.result;
    expect(p.written()).toContain('Delete it? [y/N] ');
  });
});
