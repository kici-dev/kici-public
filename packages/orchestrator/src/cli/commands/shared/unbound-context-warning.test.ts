import { describe, expect, it, vi, beforeEach } from 'vitest';
import { ContextType } from '@kici-dev/engine';
import type { ContextLookupClient } from './unbound-context-warning.js';

const mockListContextsDirect = vi.fn();
const mockShowContextDirect = vi.fn();

vi.mock('@kici-dev/shared', async (importOriginal) => {
  const original = (await importOriginal()) as Record<string, unknown>;
  return {
    ...original,
    listContextsDirect: mockListContextsDirect,
    showContextDirect: mockShowContextDirect,
  };
});

const { unboundContextWarning, warnIfContextUnbound } =
  await import('./unbound-context-warning.js');

const DB = 'postgres://localhost/test';

function contextRow(name: string, type: string) {
  return { id: `id-${name}`, org_id: 'org-1', name, type, enabled: true };
}

/** An admin API client whose GETs answer the list and show routes. */
function httpClient(opts: { type: string; bindings: number } | null) {
  const get = vi.fn(async (path: string): Promise<unknown> => {
    if (path.startsWith('/api/v1/admin/contexts?')) {
      return { contexts: opts ? [contextRow('staging', opts.type)] : [] };
    }
    return {
      context: contextRow('staging', opts!.type),
      variables: [],
      bindings: Array.from({ length: opts!.bindings }, (_, i) => ({
        scope_pattern: `scope-${i}`,
        host_pattern: '**',
        created_at: '2026-09-24T00:00:00Z',
      })),
    };
  });
  return { client: { get: get as unknown as ContextLookupClient['get'] }, get };
}

describe('unboundContextWarning', () => {
  it('names the context, the deprecated reference fallback, and the exact bind command', () => {
    expect(unboundContextWarning('org-1', 'staging', ContextType.enum.fixed)).toBe(
      "warning: context 'staging' has no binding, so no job that lists it in contexts: receives its secrets. " +
        "A 'staging:<key>' reference still reads scope 'staging', through a deprecated fallback. " +
        'Bind a secret scope to it: kici-admin context bind --org org-1 --env staging --scope staging',
    );
  });

  it('names no fallback for a glob context, whose references never read a same-named scope', () => {
    // fails-when: the glob warning promises the fixed-context fallback
    expect(unboundContextWarning('org-1', 'preview-*', ContextType.enum.glob)).toBe(
      "warning: context 'preview-*' has no binding, so no job that lists it in contexts: receives its secrets. " +
        'Bind a secret scope to it: kici-admin context bind --org org-1 --env preview-* --scope preview-*',
    );
  });
});

describe('warnIfContextUnbound', () => {
  let warnings: string[];
  const warn = (line: string) => warnings.push(line);

  beforeEach(() => {
    vi.clearAllMocks();
    warnings = [];
  });

  it('warns for a fixed context with no binding (direct-DB mode)', async () => {
    mockListContextsDirect.mockResolvedValue({
      contexts: [contextRow('staging', ContextType.enum.fixed)],
    });
    mockShowContextDirect.mockResolvedValue({
      context: contextRow('staging', ContextType.enum.fixed),
      variables: [],
      bindings: [],
    });

    await warnIfContextUnbound({ orgId: 'org-1', name: 'staging', dbUrl: DB, warn });

    // fails-when: a bindingless fixed context passes silently
    expect(warnings).toEqual([unboundContextWarning('org-1', 'staging', ContextType.enum.fixed)]);
    expect(mockShowContextDirect).toHaveBeenCalledWith(DB, { orgId: 'org-1', name: 'staging' });
  });

  it('warns for a fixed context with no binding (HTTP mode)', async () => {
    const { client, get } = httpClient({ type: ContextType.enum.fixed, bindings: 0 });

    await warnIfContextUnbound({ orgId: 'org-1', name: 'staging', dbUrl: null, client, warn });

    expect(warnings).toEqual([unboundContextWarning('org-1', 'staging', ContextType.enum.fixed)]);
    expect(get).toHaveBeenCalledWith('/api/v1/admin/contexts?orgId=org-1');
    expect(get).toHaveBeenCalledWith('/api/v1/admin/contexts/staging?orgId=org-1');
  });

  it('stays silent for a bound context', async () => {
    // breaks-if-wrong: a correctly bound context must never warn
    await warnIfContextUnbound({
      orgId: 'org-1',
      name: 'staging',
      dbUrl: null,
      client: httpClient({ type: ContextType.enum.fixed, bindings: 1 }).client,
      warn,
    });
    expect(warnings).toEqual([]);
  });

  it('warns for a glob context with no binding', async () => {
    // A job whose declared name matches the pattern resolves through this row.
    await warnIfContextUnbound({
      orgId: 'org-1',
      name: 'staging',
      dbUrl: null,
      client: httpClient({ type: ContextType.enum.glob, bindings: 0 }).client,
      warn,
    });
    expect(warnings).toEqual([unboundContextWarning('org-1', 'staging', ContextType.enum.glob)]);
  });

  it('stays silent for a template row, which no job resolves through', async () => {
    // The type `context create-template` stores; no protocol enum names it.
    const templateType = 'template';
    await warnIfContextUnbound({
      orgId: 'org-1',
      name: 'staging',
      dbUrl: null,
      client: httpClient({ type: templateType, bindings: 0 }).client,
      warn,
    });
    expect(warnings).toEqual([]);
  });

  it('stays silent, without a show lookup, when no context has that name', async () => {
    // A positional `secret set` scope such as `aws/prod/db` names no context.
    mockListContextsDirect.mockResolvedValue({
      contexts: [contextRow('other', ContextType.enum.fixed)],
    });

    await warnIfContextUnbound({ orgId: 'org-1', name: 'aws/prod/db', dbUrl: DB, warn });

    expect(warnings).toEqual([]);
    expect(mockShowContextDirect).not.toHaveBeenCalled();
  });

  it('stays silent when the lookup fails, so the command it follows keeps its exit code', async () => {
    mockListContextsDirect.mockRejectedValue(new Error('connection refused'));
    await expect(
      warnIfContextUnbound({ orgId: 'org-1', name: 'staging', dbUrl: DB, warn }),
    ).resolves.toBeUndefined();
    expect(warnings).toEqual([]);
  });
});
