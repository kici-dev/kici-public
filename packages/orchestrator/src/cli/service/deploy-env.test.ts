import { describe, it, expect } from 'vitest';
import { buildDeployEnvLines, upsertDeployEnvLines } from './deploy-env.js';

describe('buildDeployEnvLines', () => {
  it('emits mode + container fields for compose', () => {
    expect(
      buildDeployEnvLines({
        platform: 'compose',
        serviceName: 'kici-orchestrator',
        containerRuntime: 'podman',
        envFilePath: '/etc/kici/orch1.env',
      }),
    ).toEqual([
      'KICI_DEPLOY_MODE=compose',
      'KICI_DEPLOY_CONFIG_FILE=/etc/kici/orch1.env',
      'KICI_DEPLOY_CONTAINER=kici-orchestrator',
      'KICI_DEPLOY_CONTAINER_RUNTIME=podman',
      'KICI_DEPLOY_COMPOSE_FILE=/etc/kici/kici-orchestrator-compose.yaml',
    ]);
  });

  it('omits the runtime line for compose when runtime is unknown', () => {
    expect(
      buildDeployEnvLines({
        platform: 'compose',
        serviceName: 'orch1',
        envFilePath: '/etc/kici/orch1.env',
      }),
    ).toEqual([
      'KICI_DEPLOY_MODE=compose',
      'KICI_DEPLOY_CONFIG_FILE=/etc/kici/orch1.env',
      'KICI_DEPLOY_CONTAINER=orch1',
      'KICI_DEPLOY_COMPOSE_FILE=/etc/kici/orch1-compose.yaml',
    ]);
  });

  it('emits mode and config file for systemd', () => {
    expect(
      buildDeployEnvLines({
        platform: 'systemd',
        serviceName: 'kici-orchestrator',
        envFilePath: '/etc/kici/orch1.env',
      }),
    ).toEqual(['KICI_DEPLOY_MODE=systemd', 'KICI_DEPLOY_CONFIG_FILE=/etc/kici/orch1.env']);
  });

  it('emits mode and config file for launchd and windows', () => {
    expect(
      buildDeployEnvLines({
        platform: 'launchd',
        serviceName: 'x',
        envFilePath: '/etc/kici/orch1.env',
      }),
    ).toEqual(['KICI_DEPLOY_MODE=launchd', 'KICI_DEPLOY_CONFIG_FILE=/etc/kici/orch1.env']);
    expect(
      buildDeployEnvLines({
        platform: 'windows',
        serviceName: 'x',
        envFilePath: '/etc/kici/orch1.env',
      }),
    ).toEqual(['KICI_DEPLOY_MODE=windows', 'KICI_DEPLOY_CONFIG_FILE=/etc/kici/orch1.env']);
  });

  it('stamps the env file path for every platform', () => {
    expect(
      buildDeployEnvLines({
        platform: 'systemd',
        serviceName: 'kici-orchestrator',
        envFilePath: '/etc/kici/kici-orchestrator.env',
      }),
    ).toContain('KICI_DEPLOY_CONFIG_FILE=/etc/kici/kici-orchestrator.env');
  });

  it('stamps the compose file only for a compose deployment', () => {
    const compose = buildDeployEnvLines({
      platform: 'compose',
      serviceName: 'orch1',
      envFilePath: '/etc/kici/orch1.env',
    });
    expect(compose).toContain('KICI_DEPLOY_COMPOSE_FILE=/etc/kici/orch1-compose.yaml');

    const systemd = buildDeployEnvLines({
      platform: 'systemd',
      serviceName: 'orch1',
      envFilePath: '/etc/kici/orch1.env',
    });
    expect(systemd.some((l) => l.startsWith('KICI_DEPLOY_COMPOSE_FILE='))).toBe(false);
  });

  it('re-stamping replaces the config-file line rather than duplicating it', () => {
    const first = upsertDeployEnvLines(
      'KICI_PORT=4000\n',
      buildDeployEnvLines({
        platform: 'systemd',
        serviceName: 'orch1',
        envFilePath: '/etc/kici/old.env',
      }),
    );
    const second = upsertDeployEnvLines(
      first,
      buildDeployEnvLines({
        platform: 'systemd',
        serviceName: 'orch1',
        envFilePath: '/etc/kici/new.env',
      }),
    );
    const configLines = second.split('\n').filter((l) => l.startsWith('KICI_DEPLOY_CONFIG_FILE='));
    expect(configLines).toEqual(['KICI_DEPLOY_CONFIG_FILE=/etc/kici/new.env']);
  });
});

describe('upsertDeployEnvLines', () => {
  it('appends the deploy lines to existing content', () => {
    const out = upsertDeployEnvLines('KICI_MODE=platform\nKICI_PORT=8080\n', [
      'KICI_DEPLOY_MODE=systemd',
    ]);
    expect(out).toBe('KICI_MODE=platform\nKICI_PORT=8080\nKICI_DEPLOY_MODE=systemd\n');
  });

  it('is idempotent — re-running replaces existing KICI_DEPLOY_* lines', () => {
    const first = upsertDeployEnvLines('KICI_MODE=platform\n', ['KICI_DEPLOY_MODE=systemd']);
    const second = upsertDeployEnvLines(first, [
      'KICI_DEPLOY_MODE=compose',
      'KICI_DEPLOY_CONTAINER=orch1',
    ]);
    expect(second).toBe(
      'KICI_MODE=platform\nKICI_DEPLOY_MODE=compose\nKICI_DEPLOY_CONTAINER=orch1\n',
    );
    expect(second.match(/KICI_DEPLOY_MODE=/g)).toHaveLength(1);
  });

  it('handles empty existing content', () => {
    expect(upsertDeployEnvLines('', ['KICI_DEPLOY_MODE=windows'])).toBe(
      'KICI_DEPLOY_MODE=windows\n',
    );
  });
});
