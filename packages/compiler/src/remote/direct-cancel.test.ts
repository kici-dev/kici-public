import { describe, expect, it, vi } from 'vitest';
import { cancelRunDirect, DirectCancelError } from './direct-cancel.js';
import { directCancelTarget } from '../commands/runs/cancel.js';

function fetchAnswering(status: number, body: unknown) {
  return vi.fn(async () => new Response(JSON.stringify(body), { status }));
}

describe('cancelRunDirect', () => {
  it('posts to the admin cancel route with the bearer token and force flag', async () => {
    const fetchImpl = fetchAnswering(200, { status: 'cancelled', cancelledJobs: 2 });
    const result = await cancelRunDirect('http://127.0.0.1:4319/', 'tok', 'run-1', {
      force: true,
      fetchImpl,
    });
    // fails-when: the cancel goes to the test-relay route, which refuses
    // webhook-triggered runs such as every `kici run --local` run.
    expect(fetchImpl).toHaveBeenCalledWith(
      'http://127.0.0.1:4319/api/v1/admin/runs/run-1/cancel',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({ Authorization: 'Bearer tok' }),
        body: JSON.stringify({ force: true }),
      }),
    );
    expect(result).toEqual({ alreadyTerminal: false, status: 'cancelled', cancelledJobs: 2 });
  });

  it('reads a 409 terminal answer as an already-finished run, not an error', async () => {
    const fetchImpl = fetchAnswering(409, {
      error: 'Run already in terminal state',
      status: 'success',
    });
    await expect(cancelRunDirect('http://o', 't', 'r', { fetchImpl })).resolves.toEqual({
      alreadyTerminal: true,
      status: 'success',
      cancelledJobs: 0,
    });
  });

  it('throws the orchestrator message on any other refusal', async () => {
    const fetchImpl = fetchAnswering(404, { error: 'Run not found' });
    await expect(cancelRunDirect('http://o', 't', 'r', { fetchImpl })).rejects.toThrow(
      DirectCancelError,
    );
    await expect(cancelRunDirect('http://o', 't', 'r', { fetchImpl })).rejects.toThrow(
      /Run not found/,
    );
  });
});

describe('directCancelTarget', () => {
  const platform = { platformEndpoint: 'https://api.kici.dev', pat: 'kici_pat', activeOrgId: 'o' };
  const saved = { direct: { url: 'http://saved:10143', token: 'saved-tok' } };

  it('goes direct when KICI_ORCHESTRATOR_TOKEN and _URL are set, even with a Platform login', () => {
    // fails-when: runs cancel ignores the env target and asks the Platform,
    // which answers "Run not found" for a run only the local plane holds.
    expect(
      directCancelTarget(platform, {
        KICI_ORCHESTRATOR_URL: 'http://127.0.0.1:4319',
        KICI_ORCHESTRATOR_TOKEN: 'plane-tok',
      }),
    ).toEqual({ url: 'http://127.0.0.1:4319', token: 'plane-tok' });
  });

  it('keeps the Platform when only a saved direct target sits beside a Platform login', () => {
    // breaks-if-wrong: a `kici connect` + `kici login` user's cancel moves off the Platform.
    expect(directCancelTarget({ ...platform, ...saved }, {})).toBeUndefined();
  });

  it('uses a saved direct target when no Platform login exists', () => {
    expect(directCancelTarget(saved, {})).toEqual({
      url: 'http://saved:10143',
      token: 'saved-tok',
    });
  });

  it('never selects a direct target from KICI_ORCHESTRATOR_URL alone', () => {
    expect(directCancelTarget(platform, { KICI_ORCHESTRATOR_URL: 'http://x' })).toBeUndefined();
  });
});
