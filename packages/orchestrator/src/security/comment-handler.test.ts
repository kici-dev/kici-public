import { describe, it, expect, vi } from 'vitest';
import { parseKiciCommand, handleApprovalComment } from './comment-handler.js';
import type { HandleApprovalCommentParams } from './comment-handler.js';
import type { IdentityLink, PermissionLevel } from './trust-resolver.js';

vi.mock('@kici-dev/shared', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@kici-dev/shared')>();
  return {
    ...actual,
    createLogger: () => ({
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    }),
    toErrorMessage: (err: unknown) => (err instanceof Error ? err.message : String(err)),
  };
});

describe('parseKiciCommand', () => {
  it('parses /kici approve', () => {
    expect(parseKiciCommand('/kici approve')).toEqual({ action: 'approve' });
  });

  it('parses /kici reject', () => {
    expect(parseKiciCommand('/kici reject')).toEqual({ action: 'reject' });
  });

  it('parses /kici approve with run ID', () => {
    expect(parseKiciCommand('/kici approve run-123')).toEqual({
      action: 'approve',
      runId: 'run-123',
    });
  });

  it('returns null for non-kici comments', () => {
    expect(parseKiciCommand('Some other comment')).toBeNull();
  });

  it('parses command at start of any line (multiline)', () => {
    const body = 'Looks good to me!\n/kici approve\nThanks';
    expect(parseKiciCommand(body)).toEqual({ action: 'approve' });
  });

  it('handles case-insensitive command', () => {
    expect(parseKiciCommand('/kici APPROVE')).toEqual({ action: 'approve' });
    expect(parseKiciCommand('/kici Reject')).toEqual({ action: 'reject' });
  });

  it('ignores partial matches', () => {
    expect(parseKiciCommand('not /kici approve')).toBeNull();
  });

  it('returns null for empty string', () => {
    expect(parseKiciCommand('')).toBeNull();
  });

  it('ignores /kici without command', () => {
    expect(parseKiciCommand('/kici')).toBeNull();
  });
});

describe('handleApprovalComment', () => {
  function createMockHeldRunStore() {
    return {
      listByQueueType: vi.fn().mockResolvedValue([]),
      approveByQueueType: vi.fn().mockResolvedValue({}),
      reject: vi.fn().mockResolvedValue({}),
    } as any;
  }

  const defaultLinks: IdentityLink[] = [
    {
      userId: 'user-1',
      provider: 'github',
      providerUsername: 'alice',
      providerUserId: '1001',
    },
  ];
  const defaultPermissions = new Map<string, PermissionLevel>([['user-1', 'write']]);

  function createBaseParams(
    overrides?: Partial<HandleApprovalCommentParams>,
  ): HandleApprovalCommentParams {
    return {
      commentBody: '/kici approve',
      commenterUsername: 'alice',
      commenterUserId: '1001',
      provider: 'github',
      repoIdentifier: 'owner/repo',
      prNumber: 42,
      orgId: 'org-1',
      identityLinks: defaultLinks,
      orgMemberPermissions: defaultPermissions,
      heldRunStore: createMockHeldRunStore(),
      credentials: {},
      ...overrides,
    };
  }

  it('returns not handled when no /kici command in comment', async () => {
    const params = createBaseParams({ commentBody: 'LGTM' });
    const result = await handleApprovalComment(params);
    expect(result.handled).toBe(false);
    expect(result.reason).toBeUndefined();
  });

  it('returns not handled when commenter has no identity link', async () => {
    const params = createBaseParams({
      commenterUsername: 'unknown-user',
      commenterUserId: '99999',
    });
    const result = await handleApprovalComment(params);
    expect(result.handled).toBe(false);
    expect(result.reason).toBe('No identity link for commenter');
  });

  it('returns not handled when commenter has ci_trust:read', async () => {
    const params = createBaseParams({
      commenterUsername: 'bob',
      commenterUserId: '2002',
      identityLinks: [
        { userId: 'user-2', provider: 'github', providerUsername: 'bob', providerUserId: '2002' },
      ],
      orgMemberPermissions: new Map([['user-2', 'read']]),
    });
    const result = await handleApprovalComment(params);
    expect(result.handled).toBe(false);
    expect(result.reason).toBe('Insufficient ci_trust level');
  });

  it('approves security hold with ci_trust:write commenter', async () => {
    const store = createMockHeldRunStore();
    store.listByQueueType.mockResolvedValue([
      { id: 'hold-1', run_id: 'run-1', queue_type: 'security', status: 'pending' },
    ]);

    const params = createBaseParams({ heldRunStore: store });
    const result = await handleApprovalComment(params);

    expect(result.handled).toBe(true);
    expect(store.approveByQueueType).toHaveBeenCalledWith('org-1', 'hold-1', 'user-1', 'security');
  });

  it('rejects security hold on /kici reject', async () => {
    const store = createMockHeldRunStore();
    store.listByQueueType.mockResolvedValue([
      { id: 'hold-1', run_id: 'run-1', queue_type: 'security', status: 'pending' },
    ]);

    const params = createBaseParams({
      commentBody: '/kici reject',
      heldRunStore: store,
    });
    const result = await handleApprovalComment(params);

    expect(result.handled).toBe(true);
    expect(store.reject).toHaveBeenCalledWith(
      'org-1',
      'hold-1',
      'Rejected by alice via /kici reject',
    );
  });

  it('handles no pending security holds gracefully', async () => {
    const store = createMockHeldRunStore();
    store.listByQueueType.mockResolvedValue([]);

    const params = createBaseParams({ heldRunStore: store });
    const result = await handleApprovalComment(params);

    expect(result.handled).toBe(true);
    expect(store.approveByQueueType).not.toHaveBeenCalled();
  });

  it('filters to specific run when runId provided', async () => {
    const store = createMockHeldRunStore();
    store.listByQueueType.mockResolvedValue([
      { id: 'hold-1', run_id: 'run-1', queue_type: 'security', status: 'pending' },
      { id: 'hold-2', run_id: 'run-2', queue_type: 'security', status: 'pending' },
    ]);

    const params = createBaseParams({
      commentBody: '/kici approve run-1',
      heldRunStore: store,
    });
    const result = await handleApprovalComment(params);

    expect(result.handled).toBe(true);
    expect(store.approveByQueueType).toHaveBeenCalledTimes(1);
    expect(store.approveByQueueType).toHaveBeenCalledWith('org-1', 'hold-1', 'user-1', 'security');
  });

  it('allows ci_trust:admin to approve', async () => {
    const store = createMockHeldRunStore();
    store.listByQueueType.mockResolvedValue([
      { id: 'hold-1', run_id: 'run-1', queue_type: 'security', status: 'pending' },
    ]);

    const params = createBaseParams({
      commenterUsername: 'admin',
      commenterUserId: '9999',
      identityLinks: [
        {
          userId: 'admin-1',
          provider: 'github',
          providerUsername: 'admin',
          providerUserId: '9999',
        },
      ],
      orgMemberPermissions: new Map([['admin-1', 'admin']]),
      heldRunStore: store,
    });
    const result = await handleApprovalComment(params);

    expect(result.handled).toBe(true);
    expect(store.approveByQueueType).toHaveBeenCalled();
  });

  it('posts check status on approval when poster and commitSha are provided', async () => {
    const store = createMockHeldRunStore();
    store.listByQueueType.mockResolvedValue([
      { id: 'hold-1', run_id: 'run-1', queue_type: 'security', status: 'pending' },
    ]);

    const mockPoster = {
      provider: 'github' as const,
      postCheckStatus: vi.fn().mockResolvedValue(undefined),
    };

    const params = createBaseParams({
      heldRunStore: store,
      checkStatusPoster: mockPoster,
      commitSha: 'abc123',
    });
    const result = await handleApprovalComment(params);

    expect(result.handled).toBe(true);
    expect(mockPoster.postCheckStatus).toHaveBeenCalledWith(
      'owner/repo',
      'abc123',
      'success',
      'Approved',
      'Approved by alice via /kici approve',
      {},
    );
  });

  it('posts failure check status on rejection', async () => {
    const store = createMockHeldRunStore();
    store.listByQueueType.mockResolvedValue([
      { id: 'hold-1', run_id: 'run-1', queue_type: 'security', status: 'pending' },
    ]);

    const mockPoster = {
      provider: 'github' as const,
      postCheckStatus: vi.fn().mockResolvedValue(undefined),
    };

    const params = createBaseParams({
      commentBody: '/kici reject',
      heldRunStore: store,
      checkStatusPoster: mockPoster,
      commitSha: 'abc123',
    });
    const result = await handleApprovalComment(params);

    expect(result.handled).toBe(true);
    expect(mockPoster.postCheckStatus).toHaveBeenCalledWith(
      'owner/repo',
      'abc123',
      'failure',
      'Rejected',
      'Rejected by alice via /kici reject',
      {},
    );
  });

  it('does not post check status when all hold operations fail', async () => {
    const store = createMockHeldRunStore();
    store.listByQueueType.mockResolvedValue([
      { id: 'hold-1', run_id: 'run-1', queue_type: 'security', status: 'pending' },
      { id: 'hold-2', run_id: 'run-2', queue_type: 'security', status: 'pending' },
    ]);
    store.approveByQueueType.mockRejectedValue(new Error('DB connection lost'));

    const mockPoster = {
      provider: 'github' as const,
      postCheckStatus: vi.fn().mockResolvedValue(undefined),
    };

    const params = createBaseParams({
      heldRunStore: store,
      checkStatusPoster: mockPoster,
      commitSha: 'abc123',
    });
    const result = await handleApprovalComment(params);

    expect(result.handled).toBe(true);
    expect(store.approveByQueueType).toHaveBeenCalledTimes(2);
    expect(mockPoster.postCheckStatus).not.toHaveBeenCalled();
  });
});
