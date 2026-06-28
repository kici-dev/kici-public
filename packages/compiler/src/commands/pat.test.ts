import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../remote/config.js', () => ({
  loadGlobalConfig: vi.fn(),
}));

import { loadGlobalConfig } from '../remote/config.js';
import { patCreateCommand } from './pat.js';

const mockedLoadConfig = loadGlobalConfig as ReturnType<typeof vi.fn>;

function jsonResponse(body: unknown, status = 201): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('patCreateCommand', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockedLoadConfig.mockResolvedValue({ pat: 'kici_pat_user', platformEndpoint: 'https://api.x' });
  });

  it('posts an agent PAT with kind + agentLabel and the user bearer', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(
        jsonResponse({ id: 'p1', token: 'kici_pat_agent', name: 'claude', expiresAt: 'soon' }),
      );

    const ok = await patCreateCommand({
      name: 'claude',
      agent: true,
      label: 'claude',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    expect(ok).toBe(true);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe('https://api.x/api/v1/pats');
    expect(init.headers.Authorization).toBe('Bearer kici_pat_user');
    expect(JSON.parse(init.body)).toEqual({ name: 'claude', kind: 'agent', agentLabel: 'claude' });
  });

  it('mints a user PAT (no agentLabel) when --agent is absent', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(jsonResponse({ id: 'p1', token: 'kici_pat_x', name: 'ci', expiresAt: 's' }));

    const ok = await patCreateCommand({
      name: 'ci',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    expect(ok).toBe(true);
    expect(JSON.parse(fetchImpl.mock.calls[0][1].body)).toEqual({ name: 'ci', kind: 'user' });
  });

  it('fails when --agent is set without a label', async () => {
    const fetchImpl = vi.fn();
    const ok = await patCreateCommand({
      agent: true,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(ok).toBe(false);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('fails when not logged in', async () => {
    mockedLoadConfig.mockResolvedValue({});
    const fetchImpl = vi.fn();
    const ok = await patCreateCommand({
      name: 'ci',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(ok).toBe(false);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('reports a server error', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ error: 'nope' }, 400));
    const ok = await patCreateCommand({
      name: 'claude',
      agent: true,
      label: 'claude',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(ok).toBe(false);
  });
});
