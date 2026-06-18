import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { loadConfig, agentClientConnectionOptions, type AppConfig } from './config.js';

describe('loadConfig', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
    // Clear all KICI_ env vars
    for (const key of Object.keys(process.env)) {
      if (key.startsWith('KICI_')) {
        delete process.env[key];
      }
    }
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it('parses valid config with all required env vars', () => {
    process.env.KICI_ORCHESTRATOR_URL = 'ws://localhost:4000';
    process.env.KICI_AGENT_ID = 'test-agent-01';
    process.env.KICI_LABELS = 'linux,docker';
    const config = loadConfig();

    expect(config.orchestratorUrl).toBe('ws://localhost:4000');
    expect(config.agentId).toBe('test-agent-01');
    expect(config.labels).toEqual(['linux', 'docker']);
  });

  it('throws with clear error when KICI_ORCHESTRATOR_URL is missing', () => {
    expect(() => loadConfig()).toThrow('Configuration validation failed');
    expect(() => loadConfig()).toThrow('orchestratorUrl');
  });

  it('splits KICI_LABELS comma-separated string into array', () => {
    process.env.KICI_ORCHESTRATOR_URL = 'ws://localhost:4000';
    process.env.KICI_LABELS = 'linux,docker,gpu';

    const config = loadConfig();

    expect(config.labels).toEqual(['linux', 'docker', 'gpu']);
  });

  it('produces empty array for empty KICI_LABELS', () => {
    process.env.KICI_ORCHESTRATOR_URL = 'ws://localhost:4000';
    process.env.KICI_LABELS = '';

    const config = loadConfig();

    expect(config.labels).toEqual([]);
  });

  it('produces empty array when KICI_LABELS not set', () => {
    process.env.KICI_ORCHESTRATOR_URL = 'ws://localhost:4000';

    const config = loadConfig();

    expect(config.labels).toEqual([]);
  });

  it('applies default values', () => {
    process.env.KICI_ORCHESTRATOR_URL = 'ws://localhost:4000';

    const config = loadConfig();

    expect(config.port).toBe(8080);
    expect(config.maxLogSizeBytes).toBe(10 * 1024 * 1024); // 10MB = 10485760
    expect(config.defaultStepTimeoutMs).toBe(30 * 60 * 1000); // 30min = 1800000
    expect(config.logLevel).toBe('info');
    expect(config.dockerKeepFailed).toBe(false);
  });

  it('auto-generates agentId when KICI_AGENT_ID not provided', () => {
    process.env.KICI_ORCHESTRATOR_URL = 'ws://localhost:4000';

    const config = loadConfig();

    // Should be hostname-uuid8 format
    expect(config.agentId).toBeTruthy();
    expect(config.agentId).toMatch(/.+-[a-f0-9]{8}/);
  });

  it('uses KICI_AGENT_ID when provided', () => {
    process.env.KICI_ORCHESTRATOR_URL = 'ws://localhost:4000';
    process.env.KICI_AGENT_ID = 'custom-agent';

    const config = loadConfig();

    expect(config.agentId).toBe('custom-agent');
  });

  it('coerces numeric env vars', () => {
    process.env.KICI_ORCHESTRATOR_URL = 'ws://localhost:4000';
    process.env.KICI_PORT = '9090';
    process.env.KICI_MAX_LOG_SIZE_BYTES = '5242880';
    process.env.KICI_DEFAULT_STEP_TIMEOUT_MS = '60000';

    const config = loadConfig();

    expect(config.port).toBe(9090);
    expect(config.maxLogSizeBytes).toBe(5242880);
    expect(config.defaultStepTimeoutMs).toBe(60000);
  });

  it('parses KICI_DOCKER_KEEP_FAILED as boolean', () => {
    process.env.KICI_ORCHESTRATOR_URL = 'ws://localhost:4000';
    process.env.KICI_DOCKER_KEEP_FAILED = 'true';

    const config = loadConfig();

    expect(config.dockerKeepFailed).toBe(true);
  });

  it('defaults KICI_SANDBOX to false when unset', () => {
    process.env.KICI_ORCHESTRATOR_URL = 'ws://localhost:4000';

    const config = loadConfig();

    expect(config.sandbox).toBe(false);
  });

  it('parses KICI_SANDBOX=true as boolean true', () => {
    process.env.KICI_ORCHESTRATOR_URL = 'ws://localhost:4000';
    process.env.KICI_SANDBOX = 'true';

    const config = loadConfig();

    expect(config.sandbox).toBe(true);
  });

  it('parses KICI_SANDBOX=false as boolean false', () => {
    process.env.KICI_ORCHESTRATOR_URL = 'ws://localhost:4000';
    process.env.KICI_SANDBOX = 'false';

    const config = loadConfig();

    expect(config.sandbox).toBe(false);
  });

  it('defaults KICI_SANDBOX_NETWORK to "isolated" when unset', () => {
    process.env.KICI_ORCHESTRATOR_URL = 'ws://localhost:4000';

    const config = loadConfig();

    expect(config.sandboxNetwork).toBe('isolated');
  });

  it('parses KICI_SANDBOX_NETWORK=host', () => {
    process.env.KICI_ORCHESTRATOR_URL = 'ws://localhost:4000';
    process.env.KICI_SANDBOX_NETWORK = 'host';

    const config = loadConfig();

    expect(config.sandboxNetwork).toBe('host');
  });

  it('rejects invalid KICI_SANDBOX_NETWORK values with a clear error', () => {
    process.env.KICI_ORCHESTRATOR_URL = 'ws://localhost:4000';
    process.env.KICI_SANDBOX_NETWORK = 'maybe';

    expect(() => loadConfig()).toThrow(/sandboxNetwork/);
  });

  it('parses KICI_LOG_LEVEL enum values', () => {
    process.env.KICI_ORCHESTRATOR_URL = 'ws://localhost:4000';
    process.env.KICI_LOG_LEVEL = 'debug';

    const config = loadConfig();

    expect(config.logLevel).toBe('debug');
  });

  describe('KICI_ROLES parsing', () => {
    it('returns undefined when KICI_ROLES is unset (all roles, )', () => {
      process.env.KICI_ORCHESTRATOR_URL = 'ws://localhost:4000';
      const config = loadConfig();
      expect(config.roles).toBeUndefined();
    });

    it('returns [] when KICI_ROLES is empty string (execution only, )', () => {
      process.env.KICI_ORCHESTRATOR_URL = 'ws://localhost:4000';
      process.env.KICI_ROLES = '';
      const config = loadConfig();
      expect(config.roles).toEqual([]);
    });

    it('parses KICI_ROLES=builder to ["builder"]', () => {
      process.env.KICI_ORCHESTRATOR_URL = 'ws://localhost:4000';
      process.env.KICI_ROLES = 'builder';
      const config = loadConfig();
      expect(config.roles).toEqual(['builder']);
    });

    it('parses KICI_ROLES=init-runner to ["init-runner"]', () => {
      process.env.KICI_ORCHESTRATOR_URL = 'ws://localhost:4000';
      process.env.KICI_ROLES = 'init-runner';
      const config = loadConfig();
      expect(config.roles).toEqual(['init-runner']);
    });

    it('parses KICI_ROLES=builder,init-runner to ["builder", "init-runner"]', () => {
      process.env.KICI_ORCHESTRATOR_URL = 'ws://localhost:4000';
      process.env.KICI_ROLES = 'builder,init-runner';
      const config = loadConfig();
      expect(config.roles).toEqual(['builder', 'init-runner']);
    });

    it('normalizes KICI_ROLES=all to undefined', () => {
      process.env.KICI_ORCHESTRATOR_URL = 'ws://localhost:4000';
      process.env.KICI_ROLES = 'all';
      const config = loadConfig();
      expect(config.roles).toBeUndefined();
    });

    it('normalizes KICI_ROLES=builder,all to undefined', () => {
      process.env.KICI_ORCHESTRATOR_URL = 'ws://localhost:4000';
      process.env.KICI_ROLES = 'builder,all';
      const config = loadConfig();
      expect(config.roles).toBeUndefined();
    });

    it('rejects KICI_ROLES=unknown with clear error', () => {
      process.env.KICI_ORCHESTRATOR_URL = 'ws://localhost:4000';
      process.env.KICI_ROLES = 'unknown';
      expect(() => loadConfig()).toThrow('KICI_ROLES must contain only');
    });

    it('rejects KICI_ROLES=builder,invalid with clear error', () => {
      process.env.KICI_ORCHESTRATOR_URL = 'ws://localhost:4000';
      process.env.KICI_ROLES = 'builder,invalid';
      expect(() => loadConfig()).toThrow('KICI_ROLES must contain only');
    });
  });

  describe('KICI_LABELS reserved prefix rejection', () => {
    it('rejects KICI_LABELS with kici: prefix', () => {
      process.env.KICI_ORCHESTRATOR_URL = 'ws://localhost:4000';
      process.env.KICI_LABELS = 'kici:role:builder';
      expect(() => loadConfig()).toThrow(/kici:/);
    });

    it('accepts KICI_LABELS without kici: prefix', () => {
      process.env.KICI_ORCHESTRATOR_URL = 'ws://localhost:4000';
      process.env.KICI_LABELS = 'linux,docker';
      const config = loadConfig();
      expect(config.labels).toEqual(['linux', 'docker']);
    });
  });

  describe('scaler / execution mode fields', () => {
    it('parses KICI_SCALER_MANAGED=1 as boolean true', () => {
      process.env.KICI_ORCHESTRATOR_URL = 'ws://localhost:4000';
      process.env.KICI_SCALER_MANAGED = '1';
      const config = loadConfig();
      expect(config.scalerManaged).toBe(true);
    });

    it('defaults scalerManaged to false when KICI_SCALER_MANAGED unset', () => {
      process.env.KICI_ORCHESTRATOR_URL = 'ws://localhost:4000';
      const config = loadConfig();
      expect(config.scalerManaged).toBe(false);
    });

    it('coerces KICI_SCALER_IDLE_TIMEOUT', () => {
      process.env.KICI_ORCHESTRATOR_URL = 'ws://localhost:4000';
      process.env.KICI_SCALER_IDLE_TIMEOUT = '12000';
      const config = loadConfig();
      expect(config.scalerIdleTimeoutMs).toBe(12000);
    });

    it('defaults KICI_SCALER_IDLE_TIMEOUT to 5000', () => {
      process.env.KICI_ORCHESTRATOR_URL = 'ws://localhost:4000';
      const config = loadConfig();
      expect(config.scalerIdleTimeoutMs).toBe(5000);
    });

    it('coerces KICI_SCALER_PENDING_DISPATCH_TIMEOUT', () => {
      process.env.KICI_ORCHESTRATOR_URL = 'ws://localhost:4000';
      process.env.KICI_SCALER_PENDING_DISPATCH_TIMEOUT = '90000';
      const config = loadConfig();
      expect(config.scalerPendingDispatchTimeoutMs).toBe(90000);
    });

    it('defaults KICI_SCALER_PENDING_DISPATCH_TIMEOUT to 60000', () => {
      process.env.KICI_ORCHESTRATOR_URL = 'ws://localhost:4000';
      const config = loadConfig();
      expect(config.scalerPendingDispatchTimeoutMs).toBe(60000);
    });

    it('parses KICI_EXECUTION_MODE=container', () => {
      process.env.KICI_ORCHESTRATOR_URL = 'ws://localhost:4000';
      process.env.KICI_EXECUTION_MODE = 'container';
      const config = loadConfig();
      expect(config.executionMode).toBe('container');
    });

    it('rejects KICI_EXECUTION_MODE with unsupported value', () => {
      process.env.KICI_ORCHESTRATOR_URL = 'ws://localhost:4000';
      process.env.KICI_EXECUTION_MODE = 'wasm';
      expect(() => loadConfig()).toThrow(/executionMode/);
    });

    it('leaves executionMode undefined when env var unset', () => {
      process.env.KICI_ORCHESTRATOR_URL = 'ws://localhost:4000';
      const config = loadConfig();
      expect(config.executionMode).toBeUndefined();
    });
  });

  describe('unknown-KICI-var rejection', () => {
    it('throws on a typo in a KICI_ env var (drift catcher)', () => {
      process.env.KICI_ORCHESTRATOR_URL = 'ws://localhost:4000';
      process.env.KICI_SECERT_KEY = 'oops';
      expect(() => loadConfig()).toThrow(/Unknown KICI_/);
    });

    it('downgrades unknown KICI_ vars to a warning when KICI_DEV=true', () => {
      process.env.KICI_ORCHESTRATOR_URL = 'ws://localhost:4000';
      process.env.KICI_SECERT_KEY = 'oops';
      process.env.KICI_DEV = 'true';
      // Should not throw — KICI_DEV downgrades to warn
      expect(() => loadConfig()).not.toThrow();
    });

    it('reads KICI_JOB_HEARTBEAT_INTERVAL_MS into jobHeartbeatIntervalMs', () => {
      process.env.KICI_ORCHESTRATOR_URL = 'ws://localhost:4000';
      process.env.KICI_JOB_HEARTBEAT_INTERVAL_MS = '7777';
      const config = loadConfig();
      expect(config.jobHeartbeatIntervalMs).toBe(7777);
    });

    it('ignores non-KICI_ env vars (PATH, HOME, etc.)', () => {
      process.env.KICI_ORCHESTRATOR_URL = 'ws://localhost:4000';
      process.env.SOME_OTHER_ENV = 'whatever';
      expect(() => loadConfig()).not.toThrow();
    });
  });
});

describe('agentClientConnectionOptions', () => {
  function makeConfig(overrides: Partial<AppConfig> = {}): AppConfig {
    return {
      orchestratorUrl: 'ws://localhost:4000/ws',
      agentId: 'agent-1',
      labels: ['linux', 'container'],
      scalerManaged: true,
      ...overrides,
    } as AppConfig;
  }

  it('threads the agent token through so token-mode auth.request is sent', () => {
    const opts = agentClientConnectionOptions(makeConfig({ agentToken: 'kat_secret' }));
    expect(opts.token).toBe('kat_secret');
  });

  it('leaves token undefined when no token is configured (unauthenticated mode)', () => {
    const opts = agentClientConnectionOptions(makeConfig({ agentToken: undefined }));
    expect(opts.token).toBeUndefined();
  });

  it('carries the core connection identity fields', () => {
    const opts = agentClientConnectionOptions(
      makeConfig({ agentToken: 'kat_x', scalerManaged: true }),
    );
    expect(opts.url).toBe('ws://localhost:4000/ws');
    expect(opts.agentId).toBe('agent-1');
    expect(opts.labels).toEqual(['linux', 'container']);
    expect(opts.scalerManaged).toBe(true);
  });
});
