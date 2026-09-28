/**
 * The contract between `kici-admin agent install` and the agent: the env file
 * the installer writes must load through the agent's own config loader. The
 * loader refuses any KICI_* variable it does not know, so a key the installer
 * misspells stops the agent at startup — which no test on either side alone
 * can see.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { loadConfig } from '@kici-dev/agent';
import { renderAgentEnvFile } from './agent-env.js';

/** Parse `KEY=value` lines the way systemd's EnvironmentFile= does for these values. */
function parseEnvFile(content: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    env[trimmed.slice(0, eq)] = trimmed.slice(eq + 1);
  }
  return env;
}

describe('agent install env file → agent loadConfig', () => {
  let saved: NodeJS.ProcessEnv;

  beforeEach(() => {
    saved = { ...process.env };
    // Every ambient KICI_* variable goes: KICI_DEV=true in a developer shell
    // would downgrade the unknown-variable check to a warning and let this
    // test pass without checking anything.
    for (const key of Object.keys(process.env)) {
      if (key.startsWith('KICI_')) delete process.env[key];
    }
  });

  afterEach(() => {
    process.env = saved;
  });

  function loadWith(env: Record<string, string>) {
    Object.assign(process.env, env);
    return loadConfig();
  }

  it('loads every field the installer writes', () => {
    // fails-when: the installer writes a key the agent does not know (the
    // loader throws), or a key the agent reads differently (labels or port
    // come back wrong).
    const env = parseEnvFile(
      renderAgentEnvFile({
        header: '# test',
        orchestratorUrl: 'ws://orch.example.com:4000/ws',
        token: 'tok-1',
        labels: ['linux', 'gpu'],
        port: 8181,
      }),
    );

    const config = loadWith(env);

    expect(config.orchestratorUrl).toBe('ws://orch.example.com:4000/ws');
    expect(config.labels).toEqual(['linux', 'gpu']);
    expect(config.port).toBe(8181);
  });

  it('refuses a variable the agent does not read, so the check above is live', () => {
    // The negative control: the key the installer used to write. If this stops
    // throwing, the unknown-variable check is off in this environment and the
    // test above proves nothing.
    expect(() =>
      loadWith({
        KICI_ORCHESTRATOR_URL: 'ws://orch.example.com:4000/ws',
        KICI_AGENT_LABELS: 'linux',
      }),
    ).toThrow(/KICI_AGENT_LABELS/);
  });
});

describe('renderAgentEnvFile', () => {
  it('omits the fields it was not given', () => {
    expect(renderAgentEnvFile({ header: '# h', orchestratorUrl: 'ws://o/ws' })).toBe(
      '# h\nKICI_ORCHESTRATOR_URL=ws://o/ws\n',
    );
    expect(renderAgentEnvFile({ header: '# h', labels: [] })).toBe('# h\n');
  });
});
