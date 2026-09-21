import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

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

vi.mock('@kici-dev/core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@kici-dev/core')>();
  return {
    ...actual,
    logger: loggerMock,
    toErrorMessage: (err: unknown) => (err instanceof Error ? err.message : String(err)),
  };
});

import {
  feedbackCommand,
  FEEDBACK_CONTRACT,
  FEEDBACK_NEW_ISSUE_URL,
  FEEDBACK_SECURITY_ADVISORY_URL,
  FEEDBACK_TRACKER_URL,
  parseFeedbackDraft,
  draftIssueUrl,
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

describe('feedback draft', () => {
  const complete = {
    title: 'kici compile --check writes a lock file',
    advertised: 'docs say --check writes nothing',
    observed: 'it wrote .kici/lock.json',
    reproduction: '$ kici init\n$ kici compile --check',
    version: '0.8.0',
    environment: 'Node 24, Ubuntu 24.04',
    justification: 'the docs cannot be read to allow a write',
  };

  beforeEach(() => {
    openMock.mockClear();
    loggerMock.info.mockClear();
    loggerMock.error.mockClear();
  });

  it('builds the prefilled issue-form URL from a complete draft, one query param per field', () => {
    const r = parseFeedbackDraft(complete);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const url = new URL(draftIssueUrl(r.draft));
    expect(url.origin + url.pathname).toBe('https://github.com/kici-dev/kici-public/issues/new');
    expect(url.searchParams.get('template')).toBe(FEEDBACK_CONTRACT.template);
    // breaks-if-wrong: every field must round-trip through the encoding,
    // newlines included — GitHub reads the value back verbatim.
    for (const [k, v] of Object.entries(complete)) expect(url.searchParams.get(k)).toBe(v);
  });

  it('refuses a draft missing a required field, naming it', () => {
    // fails-when: `justification` is absent — the field agents skip most.
    const { justification: _drop, ...partial } = complete;
    const r = parseFeedbackDraft(partial);
    expect(r).toEqual({ ok: false, problems: ['missing required field: justification'] });
  });

  it('refuses unknown keys and non-string values', () => {
    const r = parseFeedbackDraft({ ...complete, extra: 'x', version: 8 });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.problems).toEqual(
      expect.arrayContaining(['unknown field: extra', 'field must be a non-empty string: version']),
    );
  });

  it('--draft prints the URL as the last stdout line and opens it only with --open', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'kici-feedback-'));
    const file = path.join(dir, 'draft.json');
    await writeFile(file, JSON.stringify(complete));
    const writes: string[] = [];
    const spy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
      writes.push(String(chunk));
      return true;
    });
    try {
      expect(await feedbackCommand({ draft: file })).toBe(true);
      expect(openMock).not.toHaveBeenCalled();
      const url = writes.join('').trim().split('\n').at(-1)!;
      expect(url.startsWith(FEEDBACK_NEW_ISSUE_URL)).toBe(true);

      expect(await feedbackCommand({ draft: file, open: true })).toBe(true);
      expect(openMock).toHaveBeenCalledWith(url);
    } finally {
      spy.mockRestore();
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('--draft with an invalid file exits non-zero and files nothing', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'kici-feedback-'));
    const file = path.join(dir, 'draft.json');
    await writeFile(file, JSON.stringify({ title: 'only a title' }));
    try {
      expect(await feedbackCommand({ draft: file, open: true })).toBe(false);
      expect(openMock).not.toHaveBeenCalled();
      expect(loggerMock.error.mock.calls.flat().join('\n')).toContain(
        'missing required field: advertised',
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('--json teaches the draft path', async () => {
    const writes: string[] = [];
    const spy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
      writes.push(String(chunk));
      return true;
    });
    try {
      await feedbackCommand({ json: true });
    } finally {
      spy.mockRestore();
    }
    const contract = JSON.parse(writes.join(''));
    expect(contract.draftCommand).toBe('kici feedback --draft <file.json> --open');
    // The literal in the contract and the field list are authored separately;
    // fails-when: a field is added to one and not the other.
    expect(contract.draftFields).toEqual([
      'title',
      ...FEEDBACK_CONTRACT.requiredFields.map((f) => f.id),
    ]);
  });
});
