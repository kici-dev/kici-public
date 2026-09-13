import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { CompiledFixture } from './compiler.js';

const mockCheckbox = vi.fn();

vi.mock('@inquirer/prompts', () => ({
  checkbox: (...args: unknown[]) => mockCheckbox(...args),
}));

vi.mock('@kici-dev/core', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { runFixturePicker, FixturePickerCancelledError } from './picker.js';

function mkFixture(id: string, eventType = 'push'): CompiledFixture {
  return {
    id,
    sourceFile: `/repo/.kici/tests/${id}.ts`,
    fixture: { options: { event: { _type: eventType } } },
  } as unknown as CompiledFixture;
}

describe('runFixturePicker', () => {
  const originalIsTty = process.stdin.isTTY;

  beforeEach(() => {
    vi.clearAllMocks();
    Object.defineProperty(process.stdin, 'isTTY', { configurable: true, get: () => true });
  });

  afterEach(() => {
    Object.defineProperty(process.stdin, 'isTTY', { configurable: true, get: () => originalIsTty });
  });

  it('returns the fixtures whose ids were toggled', async () => {
    const fixtures = [mkFixture('a'), mkFixture('b'), mkFixture('c')];
    mockCheckbox.mockResolvedValueOnce(['a', 'c']);

    const result = await runFixturePicker(fixtures);

    expect(result.map((f) => f.id)).toEqual(['a', 'c']);
    expect(mockCheckbox).toHaveBeenCalledTimes(1);
  });

  it('offers every fixture id as a choice value', async () => {
    const fixtures = [mkFixture('a'), mkFixture('b')];
    mockCheckbox.mockResolvedValueOnce(['b']);

    await runFixturePicker(fixtures);

    const call = mockCheckbox.mock.calls[0]![0] as { choices: Array<{ value: string }> };
    expect(call.choices.map((c) => c.value)).toEqual(['a', 'b']);
  });

  it('throws FixturePickerCancelledError when stdin is not a TTY', async () => {
    Object.defineProperty(process.stdin, 'isTTY', { configurable: true, get: () => false });

    await expect(runFixturePicker([mkFixture('a')])).rejects.toBeInstanceOf(
      FixturePickerCancelledError,
    );
    expect(mockCheckbox).not.toHaveBeenCalled();
  });

  it('maps inquirer cancellation to FixturePickerCancelledError', async () => {
    mockCheckbox.mockRejectedValueOnce(new Error('User force closed the prompt'));

    await expect(runFixturePicker([mkFixture('a')])).rejects.toBeInstanceOf(
      FixturePickerCancelledError,
    );
  });
});
