import { describe, it, expect } from 'vitest';
import {
  describeRunnerCrash,
  EXIT_COMMAND_NOT_FOUND,
  isImageNodeMissing,
  pushBounded,
  type RunnerCrashInput,
} from './runner-crash.js';

function input(overrides: Partial<RunnerCrashInput> = {}): RunnerCrashInput {
  return {
    image: 'python:3.12-slim',
    runtimeInjected: false,
    exitCode: 1,
    stdoutTail: [],
    stderrTail: [],
    ...overrides,
  };
}

describe('isImageNodeMissing', () => {
  it('recognizes the command-not-found exit code', () => {
    // fails-when: exit 127 with no output text is not recognized.
    expect(isImageNodeMissing(input({ exitCode: EXIT_COMMAND_NOT_FOUND }))).toBe(true);
  });

  it("recognizes crun's not-found text when the exit code is unknown", () => {
    const stderrTail = [
      'crun: executable file `node` not found in $PATH: No such file or directory',
    ];
    expect(isImageNodeMissing(input({ exitCode: undefined, stderrTail }))).toBe(true);
  });

  it('never blames the image when a runtime was injected', () => {
    // breaks-if-wrong: an injected runtime crashing with 127 is not the image's node.
    expect(
      isImageNodeMissing(input({ runtimeInjected: true, exitCode: EXIT_COMMAND_NOT_FOUND })),
    ).toBe(false);
  });

  it('does not match an ordinary runner crash', () => {
    const stderrTail = ['Error: ENOENT: no such file or directory, open /workspace/x'];
    expect(isImageNodeMissing(input({ stderrTail }))).toBe(false);
  });
});

describe('describeRunnerCrash', () => {
  it('reports an unknown exit code when the runtime could not report one', () => {
    expect(describeRunnerCrash(input({ exitCode: null }))).toContain('unknown exit code');
  });

  it('includes stdout lines before stderr lines', () => {
    const msg = describeRunnerCrash(input({ stdoutTail: ['out'], stderrTail: ['err'] }));
    expect(msg).toContain('Runner output:\nout\nerr');
  });
});

describe('pushBounded', () => {
  it('drops the oldest line past the bound', () => {
    const lines = ['a', 'b'];
    pushBounded(lines, 'c', 2);
    expect(lines).toEqual(['b', 'c']);
  });
});
