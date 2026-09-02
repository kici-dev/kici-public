import { describe, it, expect, vi, beforeEach } from 'vitest';

const { openMock, loggerMock } = vi.hoisted(() => {
  return {
    openMock: vi.fn(async () => undefined),
    loggerMock: {
      info: vi.fn(),
      error: vi.fn(),
      warn: vi.fn(),
      debug: vi.fn(),
    },
  };
});

vi.mock('open', () => ({ default: openMock }));

vi.mock('@kici-dev/core', () => ({
  logger: loggerMock,
  toErrorMessage: (err: unknown) => (err instanceof Error ? err.message : String(err)),
}));

import {
  feedbackCommand,
  FEEDBACK_CONTRACT,
  FEEDBACK_NEW_ISSUE_URL,
  FEEDBACK_SECURITY_ADVISORY_URL,
  FEEDBACK_TRACKER_URL,
} from './feedback.js';

function printed(): string {
  return loggerMock.info.mock.calls.map((c) => String(c[0])).join('\n');
}

describe('feedback command', () => {
  beforeEach(() => {
    openMock.mockClear();
    loggerMock.info.mockClear();
    loggerMock.error.mockClear();
  });

  it('prints the tracker, the guide, and the duplicate search before anything else', async () => {
    const ok = await feedbackCommand();
    expect(ok).toBe(true);
    const out = printed();
    expect(out).toContain(FEEDBACK_TRACKER_URL);
    expect(out).toContain(FEEDBACK_CONTRACT.guideUrl);
    // Searching first is what keeps a public tracker from collecting the same
    // finding once per agent that reads the docs.
    expect(out).toContain(FEEDBACK_CONTRACT.searchCommand);
  });

  it('states the approval gate — an agent drafts, a human says yes', async () => {
    await feedbackCommand();
    const out = printed();
    expect(FEEDBACK_CONTRACT.approval.required).toBe(true);
    expect(out).toContain(FEEDBACK_CONTRACT.approval.rule);
  });

  it('routes suspected vulnerabilities to the private advisory, never a public issue', async () => {
    await feedbackCommand();
    const out = printed();
    expect(out).toContain(FEEDBACK_SECURITY_ADVISORY_URL);
    expect(out).toMatch(/never .*public issue/i);
  });

  it('warns against putting customer data in a public issue', async () => {
    await feedbackCommand();
    const out = printed();
    expect(out).toMatch(/secret|token/i);
    expect(FEEDBACK_CONTRACT.prohibited.length).toBeGreaterThan(0);
    for (const rule of FEEDBACK_CONTRACT.prohibited) {
      expect(out).toContain(rule);
    }
  });

  it('prints every required field so a drafted issue is complete', async () => {
    await feedbackCommand();
    const out = printed();
    expect(FEEDBACK_CONTRACT.requiredFields.length).toBeGreaterThan(0);
    for (const field of FEEDBACK_CONTRACT.requiredFields) {
      expect(out).toContain(field.label);
    }
  });

  it('opens nothing and reaches no network by default', async () => {
    const ok = await feedbackCommand();
    expect(ok).toBe(true);
    expect(openMock).not.toHaveBeenCalled();
  });

  it('opens the prefilled issue form with --open', async () => {
    const ok = await feedbackCommand({ open: true });
    expect(ok).toBe(true);
    expect(openMock).toHaveBeenCalledWith(FEEDBACK_NEW_ISSUE_URL);
  });

  it('falls back to printing the URL when the browser cannot be opened', async () => {
    openMock.mockRejectedValueOnce(new Error('no display'));
    const ok = await feedbackCommand({ open: true });
    expect(ok).toBe(false);
    expect(printed()).toContain(FEEDBACK_NEW_ISSUE_URL);
  });

  it('emits the contract as machine-readable JSON with --json', async () => {
    const write = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    try {
      const ok = await feedbackCommand({ json: true });
      expect(ok).toBe(true);
      const payload = JSON.parse(write.mock.calls.map((c) => String(c[0])).join(''));
      expect(payload).toEqual(FEEDBACK_CONTRACT);
      // An agent must be able to read the gate without parsing prose.
      expect(payload.approval.required).toBe(true);
      expect(payload.newIssueUrl).toBe(FEEDBACK_NEW_ISSUE_URL);
    } finally {
      write.mockRestore();
    }
  });

  it('prints no decorative prose in JSON mode', async () => {
    const write = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    try {
      await feedbackCommand({ json: true });
      // Anything on the logger would corrupt a piped parse.
      expect(loggerMock.info).not.toHaveBeenCalled();
    } finally {
      write.mockRestore();
    }
  });

  it('names the issue template the tracker actually serves', () => {
    expect(FEEDBACK_NEW_ISSUE_URL).toContain(FEEDBACK_CONTRACT.template);
    expect(FEEDBACK_CONTRACT.template).toMatch(/\.yml$/);
  });
});
