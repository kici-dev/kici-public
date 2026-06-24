import { describe, it, expect } from 'vitest';
import { buildDeployEnvLines, upsertDeployEnvLines } from './deploy-env.js';

describe('buildDeployEnvLines', () => {
  it('emits mode + container fields for compose', () => {
    expect(
      buildDeployEnvLines({
        platform: 'compose',
        serviceName: 'kici-orchestrator',
        containerRuntime: 'podman',
      }),
    ).toEqual([
      'KICI_DEPLOY_MODE=compose',
      'KICI_DEPLOY_CONTAINER=kici-orchestrator',
      'KICI_DEPLOY_CONTAINER_RUNTIME=podman',
    ]);
  });

  it('omits the runtime line for compose when runtime is unknown', () => {
    expect(buildDeployEnvLines({ platform: 'compose', serviceName: 'orch1' })).toEqual([
      'KICI_DEPLOY_MODE=compose',
      'KICI_DEPLOY_CONTAINER=orch1',
    ]);
  });

  it('emits only mode for systemd', () => {
    expect(buildDeployEnvLines({ platform: 'systemd', serviceName: 'kici-orchestrator' })).toEqual([
      'KICI_DEPLOY_MODE=systemd',
    ]);
  });

  it('emits only mode for launchd and windows', () => {
    expect(buildDeployEnvLines({ platform: 'launchd', serviceName: 'x' })).toEqual([
      'KICI_DEPLOY_MODE=launchd',
    ]);
    expect(buildDeployEnvLines({ platform: 'windows', serviceName: 'x' })).toEqual([
      'KICI_DEPLOY_MODE=windows',
    ]);
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
