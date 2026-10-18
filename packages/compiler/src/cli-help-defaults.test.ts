/**
 * `kici --help` (top level and every subcommand) states each option default
 * once: Commander renders it, so no description spells it out too.
 */
import { describe, expect, it } from 'vitest';
import {
  collectHelpEntries,
  findDoubledDefaults,
  rendersDefault,
} from '@kici-dev/test-support/cli-help-defaults';
import { buildProgram } from './cli.js';

describe('kici help states each default once', () => {
  it('prints no doubled default in the help of any command', () => {
    const program = buildProgram();
    // fails-when: the walk reads no entry with a rendered default, so the check below
    // passes vacuously.
    expect(collectHelpEntries(program).filter(rendersDefault).length).toBeGreaterThan(0);
    // fails-when: a description hand-writes the default Commander also renders.
    expect(findDoubledDefaults(program)).toEqual([]);
  });
});
