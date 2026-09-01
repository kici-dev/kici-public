import { describe, it, expect } from 'vitest';
import {
  buildAgentCloudInit,
  type ClaimCodeCredentials,
  type CloudInitCredentials,
} from './agent-cloud-init.js';

const creds: CloudInitCredentials = {
  agentToken: 'kat_supersecret',
  agentId: 'a1',
  orchestratorUrl: 'wss://orch/ws',
  labels: ['cloud=hetzner', 'linux'],
};

const AGENT_ENV_FILE_FOR_TEST = '/etc/kici-agent.env';

describe('buildAgentCloudInit — core', () => {
  it('embeds the four agent env vars and KICI_SCALER_MANAGED=1', () => {
    const out = buildAgentCloudInit(creds, { maxLifetimeMinutes: 30, deliveryMode: 'payload' });
    expect(out).toContain('KICI_ORCHESTRATOR_URL=wss://orch/ws');
    expect(out).toContain('KICI_AGENT_TOKEN=kat_supersecret');
    expect(out).toContain('KICI_AGENT_ID=a1');
    expect(out).toContain('KICI_LABELS=cloud=hetzner,linux');
    expect(out).toContain('KICI_SCALER_MANAGED=1');
  });

  it('starts with the #cloud-config header', () => {
    const out = buildAgentCloudInit(creds, { maxLifetimeMinutes: 30 });
    expect(out.startsWith('#cloud-config\n')).toBe(true);
  });

  it('schedules the L2 max-lifetime self-poweroff', () => {
    const out = buildAgentCloudInit(creds, { maxLifetimeMinutes: 45, deliveryMode: 'payload' });
    expect(out).toMatch(/systemd-run --on-active=45m .*\/sbin\/poweroff/);
  });

  it('floors maxLifetimeMinutes to at least 1', () => {
    const out = buildAgentCloudInit(creds, { maxLifetimeMinutes: 0 });
    expect(out).toMatch(/--on-active=1m/);
  });

  it('writes the token only in the root-only env-file entry, nowhere else', () => {
    const out = buildAgentCloudInit(creds, { maxLifetimeMinutes: 30, deliveryMode: 'container' });
    expect(out.split('kat_supersecret').length - 1).toBe(1);
    expect(out).toMatch(/permissions:\s*['"]?0600['"]?/);
  });

  it('container mode runs the default agent image via docker --env-file', () => {
    const out = buildAgentCloudInit(creds, { maxLifetimeMinutes: 30, deliveryMode: 'container' });
    expect(out).toContain('quay.io/kici-dev/kici-agent:latest');
    expect(out).toContain('--env-file /etc/kici-agent.env');
  });

  it('startCommand overrides the delivery-mode command', () => {
    const out = buildAgentCloudInit(creds, {
      maxLifetimeMinutes: 30,
      startCommand: '/opt/my-agent start',
    });
    expect(out).toContain('/opt/my-agent start');
    expect(out).not.toContain('docker run');
  });
});

describe('buildAgentCloudInit — claim-code delivery', () => {
  const claimCreds: ClaimCodeCredentials = {
    claimCode: 'c1',
    agentId: 'a1',
    orchestratorUrl: 'wss://orch/ws',
    labels: ['cloud=hetzner', 'linux'],
  };

  it('renders the claim code and no agent token', () => {
    const out = buildAgentCloudInit(claimCreds, {
      maxLifetimeMinutes: 30,
      deliveryMode: 'container',
    });
    expect(out).toContain('KICI_SCALER_CLAIM_CODE=c1');
    expect(out).toContain('KICI_AGENT_ID=a1');
    expect(out).toContain('KICI_ORCHESTRATOR_URL=wss://orch/ws');
    expect(out).toContain('KICI_LABELS=cloud=hetzner,linux');
    expect(out).toContain('KICI_SCALER_MANAGED=1');
    expect(out).not.toContain('KICI_AGENT_TOKEN');
  });

  it('still renders the deprecated token form', () => {
    const out = buildAgentCloudInit(creds, {
      maxLifetimeMinutes: 30,
      deliveryMode: 'container',
    });
    expect(out).toContain('KICI_AGENT_TOKEN=kat_supersecret');
    expect(out).not.toContain('KICI_SCALER_CLAIM_CODE');
  });
});

describe('buildAgentCloudInit — customization axes', () => {
  it('appends agentEnv to the env file', () => {
    const out = buildAgentCloudInit(creds, {
      maxLifetimeMinutes: 30,
      agentEnv: { HTTP_PROXY: 'http://proxy:3128', CACHE_URL: 'http://cache' },
    });
    expect(out).toContain('HTTP_PROXY=http://proxy:3128');
    expect(out).toContain('CACHE_URL=http://cache');
  });

  it('stamps an arbitrary correlation env via agentEnv (no dedicated e2e field)', () => {
    const out = buildAgentCloudInit(
      { agentToken: 't', agentId: 'a1', orchestratorUrl: 'http://o', labels: [] },
      { maxLifetimeMinutes: 30, agentEnv: { KICI_E2E_RUN_ID: 'run-xyz' } },
    );
    expect(out).toContain('KICI_E2E_RUN_ID=run-xyz');
  });

  it('unions packages', () => {
    const out = buildAgentCloudInit(creds, { maxLifetimeMinutes: 30, packages: ['git', 'jq'] });
    expect(out).toMatch(/packages:/);
    expect(out).toContain('git');
    expect(out).toContain('jq');
  });

  it('appends extra write_files after the env file', () => {
    const out = buildAgentCloudInit(creds, {
      maxLifetimeMinutes: 30,
      writeFiles: [
        { path: '/etc/docker/daemon.json', content: '{"features":{}}', permissions: '0644' },
      ],
    });
    expect(out).toContain('/etc/docker/daemon.json');
  });

  it('orders runcmd: before -> poweroff -> start -> after', () => {
    const out = buildAgentCloudInit(creds, {
      maxLifetimeMinutes: 30,
      deliveryMode: 'container',
      runcmdBefore: ['echo pre'],
      runcmdAfter: ['echo post'],
    });
    const iBefore = out.indexOf('echo pre');
    const iPower = out.indexOf('/sbin/poweroff');
    const iStart = out.indexOf('docker run');
    const iAfter = out.indexOf('echo post');
    expect(iBefore).toBeGreaterThan(-1);
    expect(iBefore).toBeLessThan(iPower);
    expect(iPower).toBeLessThan(iStart);
    expect(iStart).toBeLessThan(iAfter);
  });

  it('keeps the token out of runcmd even with custom runcmd', () => {
    const out = buildAgentCloudInit(creds, {
      maxLifetimeMinutes: 30,
      runcmdBefore: ['echo hi'],
      agentEnv: { FOO: 'bar' },
    });
    expect(out.split('kat_supersecret').length - 1).toBe(1);
  });
});

describe('buildAgentCloudInit — baseCloudConfig merge', () => {
  const base = [
    'users:',
    '  - name: builder',
    '    sudo: ALL=(ALL) NOPASSWD:ALL',
    'packages:',
    '  - curl',
    'runcmd:',
    '  - echo base-first',
  ].join('\n');

  it('passes through non-KiCI keys (users)', () => {
    const out = buildAgentCloudInit(creds, { maxLifetimeMinutes: 30, baseCloudConfig: base });
    expect(out).toContain('name: builder');
    expect(out).toContain('NOPASSWD');
  });

  it('unions base + option packages', () => {
    const out = buildAgentCloudInit(creds, {
      maxLifetimeMinutes: 30,
      baseCloudConfig: base,
      packages: ['git'],
    });
    expect(out).toContain('curl');
    expect(out).toContain('git');
  });

  it('runs base runcmd first, then before -> poweroff -> start -> after', () => {
    const out = buildAgentCloudInit(creds, {
      maxLifetimeMinutes: 30,
      deliveryMode: 'container',
      baseCloudConfig: base,
      runcmdBefore: ['echo pre'],
    });
    const iBase = out.indexOf('echo base-first');
    const iPre = out.indexOf('echo pre');
    const iStart = out.indexOf('docker run');
    expect(iBase).toBeLessThan(iPre);
    expect(iPre).toBeLessThan(iStart);
  });

  it('keeps the env file present and the token single-occurrence with a base', () => {
    const out = buildAgentCloudInit(creds, { maxLifetimeMinutes: 30, baseCloudConfig: base });
    expect(out).toContain(AGENT_ENV_FILE_FOR_TEST);
    expect(out.split('kat_supersecret').length - 1).toBe(1);
  });

  it("preserves a base's own non-reserved write_files entry alongside the env file", () => {
    const baseWithFile = [
      'write_files:',
      '  - path: /etc/motd',
      '    content: welcome',
      '    permissions: "0644"',
    ].join('\n');
    const out = buildAgentCloudInit(creds, {
      maxLifetimeMinutes: 30,
      baseCloudConfig: baseWithFile,
    });
    // Both the base's file and the KiCI env file survive the concat, and the
    // env file is still the only 0600 entry carrying the token.
    expect(out).toContain('/etc/motd');
    expect(out).toContain('welcome');
    expect(out).toContain(AGENT_ENV_FILE_FOR_TEST);
    expect(out).toMatch(/permissions:\s*['"]?0600['"]?/);
    expect(out.split('kat_supersecret').length - 1).toBe(1);
  });
});

describe('buildAgentCloudInit — userDataEncoding', () => {
  it('base64 output decodes back to the exact raw cloud-config', () => {
    const raw = buildAgentCloudInit(creds, { maxLifetimeMinutes: 30, deliveryMode: 'container' });
    const encoded = buildAgentCloudInit(creds, {
      maxLifetimeMinutes: 30,
      deliveryMode: 'container',
      userDataEncoding: 'base64',
    });
    // The encoded form is not the raw form...
    expect(encoded).not.toContain('#cloud-config');
    // ...but decodes byte-for-byte back to it.
    const decoded = Buffer.from(encoded, 'base64').toString('utf8');
    expect(decoded).toBe(raw);
    expect(decoded.startsWith('#cloud-config')).toBe(true);
    // The token appears exactly once on the decoded form.
    expect(decoded.split('kat_supersecret').length - 1).toBe(1);
  });

  it("default ('raw' / omitted) is unchanged and still starts with #cloud-config", () => {
    const omitted = buildAgentCloudInit(creds, { maxLifetimeMinutes: 30 });
    const raw = buildAgentCloudInit(creds, { maxLifetimeMinutes: 30, userDataEncoding: 'raw' });
    expect(omitted.startsWith('#cloud-config')).toBe(true);
    expect(raw.startsWith('#cloud-config')).toBe(true);
    expect(raw).toBe(omitted);
  });
});

describe('buildAgentCloudInit — validation', () => {
  it('throws when writeFiles targets the reserved env-file path', () => {
    expect(() =>
      buildAgentCloudInit(creds, {
        maxLifetimeMinutes: 30,
        writeFiles: [{ path: '/etc/kici-agent.env', content: 'x' }],
      }),
    ).toThrow(/reserved/i);
  });

  it('throws when baseCloudConfig writes the reserved env-file path', () => {
    const base = ['write_files:', '  - path: /etc/kici-agent.env', '    content: x'].join('\n');
    expect(() =>
      buildAgentCloudInit(creds, { maxLifetimeMinutes: 30, baseCloudConfig: base }),
    ).toThrow(/reserved/i);
  });

  it('throws on an invalid agentEnv key', () => {
    expect(() =>
      buildAgentCloudInit(creds, { maxLifetimeMinutes: 30, agentEnv: { 'BAD-KEY': 'v' } }),
    ).toThrow(/agentEnv/i);
  });

  it('throws on an agentEnv value with a newline', () => {
    expect(() =>
      buildAgentCloudInit(creds, { maxLifetimeMinutes: 30, agentEnv: { OK: 'a\ninjected=1' } }),
    ).toThrow(/newline/i);
  });

  it('throws on a non-list baseCloudConfig.runcmd', () => {
    expect(() =>
      buildAgentCloudInit(creds, { maxLifetimeMinutes: 30, baseCloudConfig: 'runcmd: not-a-list' }),
    ).toThrow(/runcmd must be a list/i);
  });
});
