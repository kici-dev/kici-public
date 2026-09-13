/**
 * Interactive multi-select fixture picker for `kici run remote --pick`.
 *
 * Lists every available fixture with its source and event type, lets the user
 * toggle one or more via a checkbox prompt, and returns the chosen fixtures.
 * The caller feeds them into the standard remote-dispatch pipeline, so a picked
 * run is identical to one selected by name / glob / --all.
 */

import path from 'node:path';
import pc from 'picocolors';
import { checkbox } from '@inquirer/prompts';
import { logger } from '@kici-dev/core';
import type { CompiledFixture } from './compiler.js';
import { describeEvent } from './describe-event.js';

export class FixturePickerCancelledError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FixturePickerCancelledError';
  }
}

function isStdinTty(): boolean {
  return Boolean(process.stdin.isTTY);
}

/** Build a single fixture's display row: `id  <source>  <event type>`. */
function fixtureRow(f: CompiledFixture): string {
  const opts = typeof f.fixture.options === 'function' ? null : f.fixture.options;
  const eventType = opts?.event ? describeEvent(opts.event) : '(async)';
  const source = path.relative(process.cwd(), f.sourceFile);
  return `${f.id}  ${pc.gray(source)}  ${eventType}`;
}

function printFixtureList(fixtures: CompiledFixture[]): void {
  logger.info(pc.bold('Available fixtures:'));
  for (const f of fixtures) {
    logger.info(`  ${pc.cyan(f.id)} — ${fixtureRow(f)}`);
  }
}

/**
 * Run the interactive multi-select fixture picker.
 *
 * @throws FixturePickerCancelledError when stdin is not a TTY or the user aborts.
 */
export async function runFixturePicker(fixtures: CompiledFixture[]): Promise<CompiledFixture[]> {
  if (!isStdinTty()) {
    printFixtureList(fixtures);
    throw new FixturePickerCancelledError(
      '--pick requires an interactive terminal. Pass a fixture name instead.',
    );
  }

  let chosenIds: string[];
  try {
    chosenIds = await checkbox<string>({
      message: 'Select fixtures to run',
      choices: fixtures.map((f) => ({ name: fixtureRow(f), value: f.id })),
      required: true,
    });
  } catch (err) {
    throw new FixturePickerCancelledError(
      `Picker cancelled: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  return fixtures.filter((f) => chosenIds.includes(f.id));
}
