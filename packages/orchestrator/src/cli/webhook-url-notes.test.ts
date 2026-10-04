import { describe, it, expect } from 'vitest';
import { WebhookUrlNote } from '../sources/webhook-url-resolvers.js';
import { webhookNoteReason, webhookNoteHint } from './webhook-url-notes.js';

const FALLBACK_REASON = webhookNoteReason(undefined);

describe('webhook URL note text', () => {
  // fails-when: a note value has no reason of its own, so the CLI prints the
  //   generic fallback for a case it could explain. Property over every enum
  //   value, so a note added later without text fails here.
  it('every note has its own reason and a hint', () => {
    for (const note of WebhookUrlNote.options) {
      expect(webhookNoteReason(note), note).not.toBe(FALLBACK_REASON);
      expect(webhookNoteHint(note), note).toMatch(/\S/);
    }
  });

  it('points a platform-url-unknown manifest at --webhook-url', () => {
    expect(webhookNoteHint('platform-url-unknown')).toContain('--webhook-url');
  });
});
