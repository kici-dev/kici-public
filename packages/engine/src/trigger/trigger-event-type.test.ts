import { describe, expect, it } from 'vitest';
import {
  isPullRequestFamilyTriggerEvent,
  PULL_REQUEST_FAMILY_TRIGGER_EVENTS,
  TRIGGER_EVENT_TYPES,
} from './trigger-event-type.js';

describe('isPullRequestFamilyTriggerEvent', () => {
  it('recognises every PR-family type, bare and with an action suffix', () => {
    for (const type of PULL_REQUEST_FAMILY_TRIGGER_EVENTS) {
      expect(isPullRequestFamilyTriggerEvent(type)).toBe(true);
      expect(isPullRequestFamilyTriggerEvent(`${type}:opened`)).toBe(true);
    }
  });

  it('reads every other canonical type as not PR-family', () => {
    const family = new Set<string>(PULL_REQUEST_FAMILY_TRIGGER_EVENTS);
    for (const type of TRIGGER_EVENT_TYPES) {
      if (family.has(type)) continue;
      expect(isPullRequestFamilyTriggerEvent(type)).toBe(false);
      expect(isPullRequestFamilyTriggerEvent(`${type}:something`)).toBe(false);
    }
  });

  it('reads an absent or unrecognised value as not PR-family', () => {
    expect(isPullRequestFamilyTriggerEvent(null)).toBe(false);
    expect(isPullRequestFamilyTriggerEvent(undefined)).toBe(false);
    expect(isPullRequestFamilyTriggerEvent('')).toBe(false);
    expect(isPullRequestFamilyTriggerEvent('something_else')).toBe(false);
  });

  it('does not match a type that merely starts with a family name', () => {
    expect(isPullRequestFamilyTriggerEvent('pull_request_target')).toBe(false);
    expect(isPullRequestFamilyTriggerEvent('review_comment_edited')).toBe(false);
  });
});
