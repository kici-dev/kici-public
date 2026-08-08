import { describe, it, expect, vi } from 'vitest';
import {
  checkLogin,
  checkActiveOrg,
  checkLiveToken,
  checkOrchestrator,
  checkLockFile,
  checkLabels,
  doctorCommand,
  type LockState,
  type DoctorDeps,
} from './doctor.js';
import type { GlobalConfig } from '../remote/config.js';
import type { LockFile } from '../types.js';
import type { DiagnosticsInfrastructureResponse } from '@kici-dev/engine';

const NOW = Date.parse('2026-07-10T00:00:00.000Z');
const base: GlobalConfig = {
  pat: 'tok',
  platformEndpoint: 'https://api.kici.dev',
  activeOrgId: 'org1',
  patExpiresAt: '2026-12-31T00:00:00.000Z',
};

describe('checkLogin', () => {
  it('fails with a login hint when no credentials are stored', () => {
    const r = checkLogin({}, NOW);
    expect(r.status).toBe('fail');
    expect(r.nextCommand).toBe('kici login');
  });

  it('fails when the token is expired', () => {
    const r = checkLogin({ ...base, patExpiresAt: '2026-01-01T00:00:00.000Z' }, NOW);
    expect(r.status).toBe('fail');
    expect(r.nextCommand).toBe('kici login');
  });

  it('warns when the token expires within 7 days', () => {
    const r = checkLogin({ ...base, patExpiresAt: '2026-07-13T00:00:00.000Z' }, NOW);
    expect(r.status).toBe('warn');
    expect(r.nextCommand).toBe('kici login');
  });

  it('passes when credentials are present and unexpired', () => {
    expect(checkLogin(base, NOW).status).toBe('pass');
  });
});

describe('checkActiveOrg', () => {
  it('fails with an org hint when no active org is set', () => {
    const r = checkActiveOrg({ ...base, activeOrgId: undefined });
    expect(r.status).toBe('fail');
    expect(r.nextCommand).toBe('kici org use <name>');
  });

  it('passes when an active org is set', () => {
    expect(checkActiveOrg(base).status).toBe('pass');
  });
});

describe('checkLiveToken', () => {
  it('warns (skipped) when the probe was not attempted', () => {
    expect(checkLiveToken(null).status).toBe('warn');
  });

  it('passes when the Platform accepted the token', () => {
    expect(checkLiveToken({ ok: true, infra: { orchestrators: [], alerts: [] } }).status).toBe(
      'pass',
    );
  });

  it('fails with a login hint on an auth error', () => {
    const r = checkLiveToken({ ok: false, kind: 'unauthorized', message: 'bad token' });
    expect(r.status).toBe('fail');
    expect(r.nextCommand).toBe('kici login');
  });

  it('warns on a non-auth transport error', () => {
    expect(checkLiveToken({ ok: false, kind: 'http', message: 'network down' }).status).toBe(
      'warn',
    );
  });
});

function infra(
  orchestrators: DiagnosticsInfrastructureResponse['orchestrators'],
): DiagnosticsInfrastructureResponse {
  return { orchestrators, alerts: [] };
}

describe('checkOrchestrator', () => {
  it('warns (skipped) when the probe was not attempted or failed', () => {
    expect(checkOrchestrator(null).status).toBe('warn');
    expect(checkOrchestrator({ ok: false, kind: 'http', message: 'x' }).status).toBe('warn');
  });

  it('warns when no orchestrator has ever connected for the org', () => {
    const r = checkOrchestrator({ ok: true, infra: infra([]) });
    expect(r.status).toBe('warn');
  });

  it('fails when orchestrators are registered but none are connected', () => {
    const r = checkOrchestrator({
      ok: true,
      infra: infra([{ connected: false } as never]),
    });
    expect(r.status).toBe('fail');
    expect(r.nextCommand).toBe('kici diagnostics');
  });

  it('passes when at least one orchestrator is connected', () => {
    const r = checkOrchestrator({ ok: true, infra: infra([{ connected: true } as never]) });
    expect(r.status).toBe('pass');
  });
});

describe('checkLockFile', () => {
  const present: LockState = {
    exists: true,
    fresh: true,
    committed: true,
    gitAvailable: true,
    lock: { schemaVersion: 1, workflows: [] } as unknown as LockFile,
  };

  it('fails when the lock file is missing', () => {
    const r = checkLockFile({ ...present, exists: false, lock: null });
    expect(r.status).toBe('fail');
    expect(r.nextCommand).toBe('kici compile');
  });

  it('warns when the lock file is stale', () => {
    const r = checkLockFile({ ...present, fresh: false });
    expect(r.status).toBe('warn');
    expect(r.nextCommand).toBe('kici compile');
  });

  it('warns when the lock file has uncommitted changes', () => {
    const r = checkLockFile({ ...present, committed: false });
    expect(r.status).toBe('warn');
  });

  it('passes when present, fresh, and committed', () => {
    expect(checkLockFile(present).status).toBe('pass');
  });

  it('passes (ignores committed) when not in a git repo', () => {
    expect(checkLockFile({ ...present, gitAvailable: false, committed: false }).status).toBe(
      'pass',
    );
  });
});

describe('checkLabels', () => {
  const lock = {
    schemaVersion: 1,
    workflows: [
      {
        name: 'w',
        jobs: [
          {
            _type: 'static',
            name: 'j',
            runsOn: [{ kind: 'exact', value: 'linux' }],
            needs: [],
            steps: [],
          },
        ],
      },
    ],
  } as unknown as LockFile;

  it('warns (skipped) with no lock file', () => {
    expect(checkLabels(null, { ok: true, infra: infra([]) }).status).toBe('warn');
  });

  it('warns (skipped) when the probe failed', () => {
    expect(checkLabels(lock, null).status).toBe('warn');
  });

  it('passes when a connected agent satisfies the runsOn labels', () => {
    const r = checkLabels(lock, {
      ok: true,
      infra: infra([{ connected: true, agents: [{ labels: ['linux'] }], scalers: [] } as never]),
    });
    expect(r.status).toBe('pass');
  });

  it('passes when a connected scaler labelSet satisfies the runsOn labels', () => {
    const r = checkLabels(lock, {
      ok: true,
      infra: infra([
        { connected: true, agents: [], scalers: [{ labelSets: [['linux']] }] } as never,
      ]),
    });
    expect(r.status).toBe('pass');
  });

  it('satisfies a regex runsOn matcher via source/flags', () => {
    const regexLock = {
      schemaVersion: 1,
      workflows: [
        {
          name: 'w',
          jobs: [
            {
              _type: 'static',
              name: 'j',
              runsOn: [{ kind: 'regex', source: '^lin', flags: '' }],
              needs: [],
              steps: [],
            },
          ],
        },
      ],
    } as unknown as LockFile;
    const r = checkLabels(regexLock, {
      ok: true,
      infra: infra([{ connected: true, agents: [{ labels: ['linux'] }], scalers: [] } as never]),
    });
    expect(r.status).toBe('pass');
  });

  it('warns and names the gap when no agent or scaler can satisfy the labels', () => {
    const r = checkLabels(lock, {
      ok: true,
      infra: infra([{ connected: true, agents: [{ labels: ['windows'] }], scalers: [] } as never]),
    });
    expect(r.status).toBe('warn');
    expect(r.message).toContain('linux');
  });

  it('warns when the only matching agent is disqualified by excludeLabels', () => {
    const excludeLock = {
      schemaVersion: 1,
      workflows: [
        {
          name: 'w',
          jobs: [
            {
              _type: 'static',
              name: 'j',
              runsOn: [{ kind: 'exact', value: 'linux' }],
              excludeLabels: [{ kind: 'exact', value: 'gpu' }],
              needs: [],
              steps: [],
            },
          ],
        },
      ],
    } as unknown as LockFile;
    // The sole connected agent matches runsOn (linux) but carries the excluded
    // label (gpu), so real dispatch would never place the job on it.
    const r = checkLabels(excludeLock, {
      ok: true,
      infra: infra([
        { connected: true, agents: [{ labels: ['linux', 'gpu'] }], scalers: [] } as never,
      ]),
    });
    expect(r.status).toBe('warn');
    expect(r.message).toContain('linux');
  });

  it('passes when a non-excluded agent satisfies the labels', () => {
    const excludeLock = {
      schemaVersion: 1,
      workflows: [
        {
          name: 'w',
          jobs: [
            {
              _type: 'static',
              name: 'j',
              runsOn: [{ kind: 'exact', value: 'linux' }],
              excludeLabels: [{ kind: 'exact', value: 'gpu' }],
              needs: [],
              steps: [],
            },
          ],
        },
      ],
    } as unknown as LockFile;
    const r = checkLabels(excludeLock, {
      ok: true,
      infra: infra([{ connected: true, agents: [{ labels: ['linux'] }], scalers: [] } as never]),
    });
    expect(r.status).toBe('pass');
  });
});

const FIXED_NOW = Date.parse('2026-07-10T00:00:00.000Z');

function deps(over: Partial<DoctorDeps> = {}): DoctorDeps {
  return {
    loadConfig: async () => ({}),
    probe: async () => null,
    gatherLockState: async () => ({
      exists: false,
      fresh: false,
      committed: false,
      gitAvailable: false,
      lock: null,
    }),
    now: () => FIXED_NOW,
    ...over,
  };
}

describe('doctorCommand', () => {
  it('exits 2 and prints JSON with a login fail when logged out', async () => {
    const logged: string[] = [];
    const spy = vi.spyOn(console, 'log').mockImplementation((m: string) => void logged.push(m));
    const code = await doctorCommand({ json: true }, deps());
    spy.mockRestore();
    expect(code).toBe(2);
    const parsed = JSON.parse(logged.join('\n'));
    expect(parsed.status).toBe('unhealthy');
    const login = parsed.checks.find((c: { name: string }) => c.name === 'login');
    expect(login.status).toBe('fail');
    expect(login.nextCommand).toBe('kici login');
  });

  it('exits 0 when every check passes', async () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const code = await doctorCommand(
      { json: true },
      deps({
        loadConfig: async () => ({
          pat: 'tok',
          platformEndpoint: 'https://api.kici.dev',
          activeOrgId: 'org1',
          patExpiresAt: '2026-12-31T00:00:00.000Z',
        }),
        gatherLockState: async () => ({
          exists: true,
          fresh: true,
          committed: true,
          gitAvailable: true,
          lock: { schemaVersion: 1, workflows: [] } as never,
        }),
        probe: async () => ({
          ok: true,
          infra: {
            orchestrators: [{ connected: true, agents: [], scalers: [] }],
            alerts: [],
          } as never,
        }),
      }),
    );
    spy.mockRestore();
    expect(code).toBe(0);
  });
});
