import { describe, it, expect, vi } from 'vitest';
import { classifyNewHolds, handleNewHolds } from './run-hold-watch.js';
import type { HeldRunSummary } from './held-run-resolve.js';
import type { HeldRunContext } from './held-run-client.js';

const ctx: HeldRunContext = { endpoint: 'https://x', token: 't', orgId: 'org-1' };

function hold(over: Partial<HeldRunSummary> = {}): HeldRunSummary {
  return { id: 'h1', runId: 'run-1', status: 'pending', ...over };
}

describe('classifyNewHolds', () => {
  it('returns one action per new pending hold and updates the seen set', () => {
    const { actions, seen } = classifyNewHolds([hold(), hold({ id: 'h2' })], new Set(), true);
    expect(actions.map((a) => a.kind)).toEqual(['prompt', 'prompt']);
    expect([...seen].sort()).toEqual(['h1', 'h2']);
  });

  it('skips holds already seen', () => {
    const { actions } = classifyNewHolds([hold()], new Set(['h1']), true);
    expect(actions).toHaveLength(0);
  });

  it('skips non-pending holds', () => {
    const { actions } = classifyNewHolds([hold({ status: 'approved' })], new Set(), true);
    expect(actions).toHaveLength(0);
  });

  it('emits notify (not prompt) when not a TTY', () => {
    const { actions } = classifyNewHolds([hold()], new Set(), false);
    expect(actions[0].kind).toBe('notify');
  });
});

describe('handleNewHolds', () => {
  it('approves via the client when the prompt returns yes', async () => {
    const approve = vi.fn(async () => true);
    const reject = vi.fn(async () => true);
    await handleNewHolds({
      holds: [hold({ id: 'h9', payload: { summaryMarkdown: '## diff' } })],
      seen: new Set(),
      isTty: true,
      confirm: async () => true,
      resolveContext: async () => ctx,
      approve,
      reject,
    });
    expect(approve).toHaveBeenCalledWith(ctx, 'h9');
    expect(reject).not.toHaveBeenCalled();
  });

  it('rejects via the client when the prompt returns no', async () => {
    const approve = vi.fn(async () => true);
    const reject = vi.fn(async () => true);
    await handleNewHolds({
      holds: [hold({ id: 'h9' })],
      seen: new Set(),
      isTty: true,
      confirm: async () => false,
      resolveContext: async () => ctx,
      approve,
      reject,
    });
    expect(reject).toHaveBeenCalledWith(ctx, 'h9', expect.any(String));
    expect(approve).not.toHaveBeenCalled();
  });

  it('does not prompt in non-TTY mode (notify only)', async () => {
    const confirm = vi.fn(async () => true);
    const approve = vi.fn(async () => true);
    await handleNewHolds({
      holds: [hold()],
      seen: new Set(),
      isTty: false,
      confirm,
      resolveContext: async () => ctx,
      approve,
    });
    expect(confirm).not.toHaveBeenCalled();
    expect(approve).not.toHaveBeenCalled();
  });

  it('approveAll auto-approves with the autoApprove flag and never prompts', async () => {
    const confirm = vi.fn(async () => true);
    const approve = vi.fn(async () => true);
    const reject = vi.fn(async () => true);
    await handleNewHolds({
      holds: [hold({ id: 'h1' }), hold({ id: 'h2' })],
      seen: new Set(),
      isTty: true,
      approveAll: true,
      confirm,
      resolveContext: async () => ctx,
      approve,
      reject,
    });
    expect(confirm).not.toHaveBeenCalled();
    expect(reject).not.toHaveBeenCalled();
    expect(approve).toHaveBeenNthCalledWith(1, ctx, 'h1', true);
    expect(approve).toHaveBeenNthCalledWith(2, ctx, 'h2', true);
  });

  it('returns the updated seen-set so a hold is handled once', async () => {
    const seen = await handleNewHolds({
      holds: [hold({ id: 'h1' })],
      seen: new Set(),
      isTty: true,
      confirm: async () => true,
      resolveContext: async () => ctx,
      approve: async () => true,
    });
    expect(seen.has('h1')).toBe(true);
  });
});
