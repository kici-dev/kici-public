import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { Workflow } from '@kici-dev/sdk';
import { push, dispatch, pr, schedule } from '@kici-dev/sdk';
import type { TriggerConfig } from '@kici-dev/sdk';

const mockSelect = vi.fn();

vi.mock('@inquirer/prompts', () => ({
  select: (...args: unknown[]) => mockSelect(...args),
}));

vi.mock('@kici-dev/core', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

import { runPicker, PickerCancelledError } from './picker.js';

function mkWorkflow(name: string, on: TriggerConfig[]): Workflow {
  return {
    name,
    on,
    jobs: [],
  } as unknown as Workflow;
}

describe('runPicker', () => {
  const originalIsTty = process.stdin.isTTY;

  beforeEach(() => {
    vi.clearAllMocks();
    Object.defineProperty(process.stdin, 'isTTY', {
      configurable: true,
      get: () => true,
    });
  });

  afterEach(() => {
    Object.defineProperty(process.stdin, 'isTTY', {
      configurable: true,
      get: () => originalIsTty,
    });
  });

  it('single-trigger workflow skips the trigger prompt', async () => {
    const workflows = [mkWorkflow('ci', [push({ branches: 'main' })])];
    mockSelect.mockResolvedValueOnce('ci');

    const result = await runPicker(workflows);

    expect(result).toEqual({ event: 'push', workflow: 'ci' });
    expect(mockSelect).toHaveBeenCalledTimes(1);
  });

  it('multi-trigger workflow prompts for which trigger', async () => {
    const multi = mkWorkflow('deploy', [
      push({ branches: 'main' }),
      dispatch({ types: ['deploy'] }),
    ]);

    mockSelect.mockResolvedValueOnce('deploy');
    mockSelect.mockImplementationOnce(async (opts: { choices: Array<{ value: unknown }> }) => {
      return opts.choices[1]!.value;
    });

    const result = await runPicker([multi]);

    expect(mockSelect).toHaveBeenCalledTimes(2);
    expect(result.workflow).toBe('deploy');
    expect(result.event).toBe('dispatch');
  });

  it('filterEvent restricts the workflow list to the same family', async () => {
    const ci = mkWorkflow('ci', [pr({ target: 'main' })]);
    const cron = mkWorkflow('nightly', [schedule({ cron: '0 2 * * *' })]);

    mockSelect.mockImplementationOnce(
      async (opts: { choices: Array<{ value: unknown }> }) => opts.choices[0]!.value,
    );

    const result = await runPicker([ci, cron], { filterEvent: 'pr:open' });

    expect(mockSelect).toHaveBeenCalledTimes(1);
    const firstCall = mockSelect.mock.calls[0]![0] as {
      choices: Array<{ value: string }>;
    };
    expect(firstCall.choices.map((c) => c.value)).toEqual(['ci']);
    expect(result.workflow).toBe('ci');
    expect(result.event.startsWith('pr:')).toBe(true);
  });

  it('throws PickerCancelledError when stdin is not a TTY', async () => {
    Object.defineProperty(process.stdin, 'isTTY', {
      configurable: true,
      get: () => false,
    });
    const workflows = [mkWorkflow('ci', [push({ branches: 'main' })])];

    await expect(runPicker(workflows)).rejects.toBeInstanceOf(PickerCancelledError);
    expect(mockSelect).not.toHaveBeenCalled();
  });

  it('throws PickerCancelledError when filterEvent matches no workflows', async () => {
    const cron = mkWorkflow('nightly', [schedule({ cron: '0 2 * * *' })]);

    await expect(runPicker([cron], { filterEvent: 'pr:open' })).rejects.toBeInstanceOf(
      PickerCancelledError,
    );
  });

  it('propagates inquirer cancellation as PickerCancelledError', async () => {
    const workflows = [mkWorkflow('ci', [push({ branches: 'main' })])];
    mockSelect.mockRejectedValueOnce(new Error('User force closed the prompt'));

    await expect(runPicker(workflows)).rejects.toBeInstanceOf(PickerCancelledError);
  });
});
