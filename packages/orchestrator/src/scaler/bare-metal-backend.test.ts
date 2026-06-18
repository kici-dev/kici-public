import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { ScalerEventType } from './types.js';
import type { LabelSetConfig } from './types.js';

// Create a reusable mock ChildProcess factory.
// stdout/stderr are real PassThrough streams so the backend's internal
// `.pipe(merged)` wiring works and tests can feed captured output by writing
// to mockChildProcess.stdout / .stderr.
function createMockChildProcess(pid: number = 12345) {
  const emitter = new EventEmitter();
  return Object.assign(emitter, {
    pid,
    stdin: null,
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    stdio: [null, null, null],
    killed: false,
    connected: true,
    exitCode: null as number | null,
    signalCode: null as string | null,
    unref: vi.fn(),
    ref: vi.fn(),
    kill: vi.fn(),
    send: vi.fn(),
    disconnect: vi.fn(),
    [Symbol.dispose]: vi.fn(),
  });
}

let mockChildProcess: ReturnType<typeof createMockChildProcess>;

vi.mock('node:child_process', () => ({
  spawn: vi.fn(() => mockChildProcess),
  execFile: vi.fn(
    (_path: string, _args: string[], _opts: unknown, cb: (err: Error | null) => void) => {
      cb(null);
      const emitter = new EventEmitter();
      return Object.assign(emitter, { unref: vi.fn() });
    },
  ),
}));

// Import after mocking
const { BareMetalScalerBackend } = await import('./bare-metal-backend.js');
const childProcessModule = await import('node:child_process');

const defaultLabelSets: LabelSetConfig[] = [
  {
    labels: ['linux', 'bare-metal'],
    binaryPath: '/opt/kici/kici-agent',
    resources: { limits: { memory: '4g', cpus: 4 } },
  },
  {
    labels: ['linux', 'gpu', 'cuda'],
    binaryPath: '/opt/kici/kici-agent-gpu',
    env: { CUDA_VISIBLE_DEVICES: '0,1' },
  },
];

function createBackend(
  overrides?: Partial<ConstructorParameters<typeof BareMetalScalerBackend>[0]>,
) {
  return new BareMetalScalerBackend({
    name: 'test-bare-metal',
    labelSets: defaultLabelSets,
    maxAgents: 5,
    ...overrides,
  });
}

describe('BareMetalScalerBackend', () => {
  let killSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    mockChildProcess = createMockChildProcess(12345);
    killSpy = vi.spyOn(process, 'kill').mockImplementation(() => true);
  });

  afterEach(() => {
    killSpy.mockRestore();
  });

  describe('spawn()', () => {
    it('calls spawn() with correct binary path and env vars', async () => {
      const backend = createBackend();
      await backend.spawn(['linux', 'bare-metal'], 'agent-1', 'http://localhost:4000');

      expect(childProcessModule.spawn).toHaveBeenCalledWith(
        '/opt/kici/kici-agent',
        [],
        expect.objectContaining({
          env: expect.objectContaining({
            KICI_ORCHESTRATOR_URL: 'http://localhost:4000',
            KICI_AGENT_ID: 'agent-1',
            KICI_LABELS:
              'linux,bare-metal,kici:agent:bare-metal,kici:scaler:test-bare-metal,kici:role:builder,kici:role:init-runner',
            KICI_SCALER_MANAGED: '1',
          }),
        }),
      );
    });

    it('passes additional env from label set config', async () => {
      const backend = createBackend();
      await backend.spawn(['linux', 'gpu', 'cuda'], 'agent-2', 'http://localhost:4000');

      expect(childProcessModule.spawn).toHaveBeenCalledWith(
        '/opt/kici/kici-agent-gpu',
        [],
        expect.objectContaining({
          env: expect.objectContaining({
            CUDA_VISIBLE_DEVICES: '0,1',
          }),
        }),
      );
    });

    it('uses detached: true for process group isolation', async () => {
      const backend = createBackend();
      await backend.spawn(['linux', 'bare-metal'], 'agent-1', 'http://localhost:4000');

      expect(childProcessModule.spawn).toHaveBeenCalledWith(
        expect.any(String),
        [],
        expect.objectContaining({
          detached: true,
          stdio: ['ignore', 'pipe', 'pipe'],
        }),
      );
    });

    it('tracks agent with PID as backendRef', async () => {
      const backend = createBackend();
      const managed = await backend.spawn(
        ['linux', 'bare-metal'],
        'agent-1',
        'http://localhost:4000',
      );

      expect(managed.id).toBe('agent-1');
      expect(managed.backendRef).toBe('12345');
      expect(managed.state).toBe('running');
      expect(managed.labelSet).toEqual(['linux', 'bare-metal']);
    });

    it('calls child.unref()', async () => {
      const backend = createBackend();
      await backend.spawn(['linux', 'bare-metal'], 'agent-1', 'http://localhost:4000');

      expect(mockChildProcess.unref).toHaveBeenCalledOnce();
    });

    it('throws when label set not found', async () => {
      const backend = createBackend();
      await expect(
        backend.spawn(['windows', 'arm'], 'agent-1', 'http://localhost:4000'),
      ).rejects.toThrow(
        'Label set [windows, arm] not supported by bare-metal backend "test-bare-metal"',
      );
    });

    it('throws when at capacity', async () => {
      const backend = createBackend({ maxAgents: 1 });
      await backend.spawn(['linux', 'bare-metal'], 'agent-1', 'http://localhost:4000');

      mockChildProcess = createMockChildProcess(12346);
      await expect(
        backend.spawn(['linux', 'bare-metal'], 'agent-2', 'http://localhost:4000'),
      ).rejects.toThrow('Bare-metal backend "test-bare-metal" at capacity (1/1)');
    });
  });

  describe('enforceCgroups (systemd-run wrapping)', () => {
    let originalPlatform: PropertyDescriptor | undefined;

    beforeEach(() => {
      originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform');
      Object.defineProperty(process, 'platform', {
        value: 'linux',
        configurable: true,
      });
    });

    afterEach(() => {
      if (originalPlatform) {
        Object.defineProperty(process, 'platform', originalPlatform);
      }
    });

    it('wraps in systemd-run when enforceCgroups is true and effectiveLimits has cpu+mem', async () => {
      const backend = createBackend({ enforceCgroups: true });
      await backend.spawn(
        ['linux', 'bare-metal'],
        'agent-cg-1',
        'http://localhost:4000',
        undefined,
        { cpus: 2, memBytes: 4 * 1024 * 1024 * 1024 }, // 2 cpus, 4 GiB
      );

      expect(childProcessModule.spawn).toHaveBeenCalledWith(
        'systemd-run',
        expect.arrayContaining([
          '--user',
          '--scope',
          '--quiet',
          '--slice=kici-scaler',
          '--unit=kici-agent-agent-cg-1',
          '--property=CPUQuota=200%',
          `--property=MemoryMax=${4 * 1024 * 1024 * 1024}`,
          '/opt/kici/kici-agent',
        ]),
        expect.any(Object),
      );
    });

    it('translates fractional cpu requests into rounded percent CPUQuota', async () => {
      const backend = createBackend({ enforceCgroups: true });
      await backend.spawn(
        ['linux', 'bare-metal'],
        'agent-cg-2',
        'http://localhost:4000',
        undefined,
        { cpus: 0.5, memBytes: 0 },
      );

      const calls = vi.mocked(childProcessModule.spawn).mock.calls;
      const args = calls[calls.length - 1][1] as string[];
      expect(args).toContain('--property=CPUQuota=50%');
      // No memory cap when memBytes is 0
      expect(args.find((a) => a.startsWith('--property=MemoryMax='))).toBeUndefined();
    });

    it('does not wrap when enforceCgroups is false (default advisory mode)', async () => {
      const backend = createBackend({ enforceCgroups: false });
      await backend.spawn(
        ['linux', 'bare-metal'],
        'agent-direct-1',
        'http://localhost:4000',
        undefined,
        { cpus: 2, memBytes: 4 * 1024 * 1024 * 1024 },
      );

      expect(childProcessModule.spawn).toHaveBeenCalledWith(
        '/opt/kici/kici-agent',
        [],
        expect.any(Object),
      );
    });

    it('does not wrap when effectiveLimits has no positive fields', async () => {
      const backend = createBackend({ enforceCgroups: true });
      await backend.spawn(
        ['linux', 'bare-metal'],
        'agent-direct-2',
        'http://localhost:4000',
        undefined,
        { cpus: 0, memBytes: 0 },
      );

      expect(childProcessModule.spawn).toHaveBeenCalledWith(
        '/opt/kici/kici-agent',
        [],
        expect.any(Object),
      );
    });

    it('falls back to direct spawn on non-Linux hosts even when enforceCgroups is true', async () => {
      Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true });
      const backend = createBackend({ enforceCgroups: true });
      await backend.spawn(
        ['linux', 'bare-metal'],
        'agent-direct-3',
        'http://localhost:4000',
        undefined,
        { cpus: 1, memBytes: 1024 * 1024 * 1024 },
      );

      expect(childProcessModule.spawn).toHaveBeenCalledWith(
        '/opt/kici/kici-agent',
        [],
        expect.any(Object),
      );
    });
  });

  describe('spawn env sanitization', () => {
    const originalEnv = process.env;

    beforeEach(() => {
      // Snapshot process.env so we can safely mutate it
      process.env = { ...originalEnv };
    });

    afterEach(() => {
      process.env = originalEnv;
    });

    /** Extract the env object passed to child_process.spawn */
    function getSpawnEnv(): Record<string, string> {
      const calls = vi.mocked(childProcessModule.spawn).mock.calls;
      const lastCall = calls[calls.length - 1];
      return (lastCall[2] as { env: Record<string, string> }).env;
    }

    it('does not leak orchestrator secrets to spawned agent', async () => {
      process.env.KICI_DATABASE_URL = 'postgres://localhost:5432/kici';
      process.env.GITHUB_PRIVATE_KEY = '-----BEGIN RSA PRIVATE KEY-----';
      process.env.KICI_PLATFORM_TOKEN = 'super-secret-token';
      process.env.WEBHOOK_SECRET = 'hmac-secret';
      process.env.S3_ACCESS_KEY = 'AKIAIOSFODNN7EXAMPLE';
      process.env.S3_SECRET_KEY = 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY';

      const backend = createBackend();
      await backend.spawn(['linux', 'bare-metal'], 'agent-1', 'ws://orch:8080');

      const env = getSpawnEnv();
      expect(env).not.toHaveProperty('KICI_DATABASE_URL');
      expect(env).not.toHaveProperty('GITHUB_PRIVATE_KEY');
      expect(env).not.toHaveProperty('KICI_PLATFORM_TOKEN');
      expect(env).not.toHaveProperty('WEBHOOK_SECRET');
      expect(env).not.toHaveProperty('S3_ACCESS_KEY');
      expect(env).not.toHaveProperty('S3_SECRET_KEY');
    });

    it('passes only allowlisted system vars', async () => {
      process.env.PATH = '/usr/bin';
      process.env.HOME = '/home/user';
      process.env.LANG = 'en_US.UTF-8';
      process.env.RANDOM_VAR = 'leaked';
      process.env.AWS_SECRET_ACCESS_KEY = 'secret';

      const backend = createBackend();
      await backend.spawn(['linux', 'bare-metal'], 'agent-1', 'ws://orch:8080');

      const env = getSpawnEnv();
      expect(env.PATH).toBe('/usr/bin');
      expect(env.HOME).toBe('/home/user');
      expect(env.LANG).toBe('en_US.UTF-8');
      expect(env).not.toHaveProperty('RANDOM_VAR');
      expect(env).not.toHaveProperty('AWS_SECRET_ACCESS_KEY');
    });

    it('forwards KICI_AGENT_ENV_ prefixed vars with prefix stripped', async () => {
      process.env.KICI_AGENT_ENV_HTTP_PROXY = 'http://proxy:3128';
      process.env.KICI_AGENT_ENV_NO_PROXY = 'localhost';
      process.env.KICI_AGENT_ENV_CUSTOM_FLAG = 'enabled';

      const backend = createBackend();
      await backend.spawn(['linux', 'bare-metal'], 'agent-1', 'ws://orch:8080');

      const env = getSpawnEnv();
      // Forwarded with prefix stripped
      expect(env.HTTP_PROXY).toBe('http://proxy:3128');
      expect(env.NO_PROXY).toBe('localhost');
      expect(env.CUSTOM_FLAG).toBe('enabled');
      // Original prefixed keys must NOT appear
      expect(env).not.toHaveProperty('KICI_AGENT_ENV_HTTP_PROXY');
      expect(env).not.toHaveProperty('KICI_AGENT_ENV_NO_PROXY');
      expect(env).not.toHaveProperty('KICI_AGENT_ENV_CUSTOM_FLAG');
    });

    it('scalers.yaml env overrides KICI_AGENT_ENV_ forwarded vars', async () => {
      process.env.KICI_AGENT_ENV_CUSTOM = 'from-prefix';

      const backend = createBackend({
        labelSets: [
          {
            labels: ['linux', 'bare-metal'],
            binaryPath: '/opt/kici/kici-agent',
            env: { CUSTOM: 'from-yaml' },
          },
        ],
      });
      await backend.spawn(['linux', 'bare-metal'], 'agent-1', 'ws://orch:8080');

      const env = getSpawnEnv();
      expect(env.CUSTOM).toBe('from-yaml');
    });

    it('sets explicit KICI_* agent vars', async () => {
      const backend = createBackend();
      await backend.spawn(['linux', 'bare-metal'], 'test-agent-1', 'ws://orch:8080');

      const env = getSpawnEnv();
      expect(env.KICI_ORCHESTRATOR_URL).toBe('ws://orch:8080');
      expect(env.KICI_AGENT_ID).toBe('test-agent-1');
      expect(env.KICI_LABELS).toBe(
        'linux,bare-metal,kici:agent:bare-metal,kici:scaler:test-bare-metal,kici:role:builder,kici:role:init-runner',
      );
      expect(env.KICI_SCALER_MANAGED).toBe('1');
      expect(env.KICI_EXECUTION_MODE).toBe('bare-metal');
      expect(env.KICI_PORT).toBe('0');
    });

    it('includes only kici:role:builder when roles is ["builder"]', async () => {
      const backend = createBackend({ roles: ['builder'] });
      await backend.spawn(['linux', 'bare-metal'], 'agent-1', 'ws://orch:8080');

      const env = getSpawnEnv();
      expect(env.KICI_LABELS).toContain('kici:role:builder');
      expect(env.KICI_LABELS).not.toContain('kici:role:init-runner');
    });

    it('includes no role labels when roles is [] (execution only)', async () => {
      const backend = createBackend({ roles: [] });
      await backend.spawn(['linux', 'bare-metal'], 'agent-1', 'ws://orch:8080');

      const env = getSpawnEnv();
      expect(env.KICI_LABELS).not.toContain('kici:role:');
    });
  });

  describe('destroy()', () => {
    it('sends SIGTERM to process group (negative PID)', async () => {
      const backend = createBackend();
      await backend.spawn(['linux', 'bare-metal'], 'agent-1', 'http://localhost:4000');

      // Simulate process exiting after SIGTERM
      killSpy.mockImplementation((pid: number, signal?: string | number) => {
        if (signal === 'SIGTERM') {
          mockChildProcess.exitCode = 0;
          mockChildProcess.emit('exit', 0, null);
        }
        return true;
      });

      await backend.destroy('agent-1');

      expect(killSpy).toHaveBeenCalledWith(-12345, 'SIGTERM');
      expect(backend.getActiveCount()).toBe(0);
    });

    it('sends SIGKILL after 5s timeout', async () => {
      vi.useFakeTimers();
      const backend = createBackend();
      await backend.spawn(['linux', 'bare-metal'], 'agent-1', 'http://localhost:4000');

      // SIGTERM does nothing, process stays alive
      killSpy.mockImplementation(() => true);

      const destroyPromise = backend.destroy('agent-1');

      // Advance past 5s timeout
      await vi.advanceTimersByTimeAsync(5100);
      await destroyPromise;

      expect(killSpy).toHaveBeenCalledWith(-12345, 'SIGTERM');
      expect(killSpy).toHaveBeenCalledWith(-12345, 'SIGKILL');
      expect(backend.getActiveCount()).toBe(0);

      vi.useRealTimers();
    });

    it('handles ESRCH (process already dead)', async () => {
      const backend = createBackend();
      await backend.spawn(['linux', 'bare-metal'], 'agent-1', 'http://localhost:4000');

      const esrchError = Object.assign(new Error('No such process'), { code: 'ESRCH' });
      killSpy.mockImplementation(() => {
        throw esrchError;
      });

      // Should not throw
      await backend.destroy('agent-1');
      expect(backend.getActiveCount()).toBe(0);
    });

    it('handles non-existent managed ID gracefully', async () => {
      const backend = createBackend();
      // Should not throw
      await backend.destroy('non-existent');
    });

    it('handles NaN PID when spawn failed before PID assignment', async () => {
      // Simulate spawn failing before PID is assigned (e.g. ENOENT)
      const noPidProcess = createMockChildProcess(12345);
      // Override pid to undefined (like when spawn fails with ENOENT)
      Object.defineProperty(noPidProcess, 'pid', { value: undefined });
      mockChildProcess = noPidProcess;

      const backend = createBackend();
      const managed = await backend.spawn(
        ['linux', 'bare-metal'],
        'agent-nopid',
        'http://localhost:4000',
      );

      // backendRef should be "undefined" string since pid was undefined
      expect(managed.backendRef).toBe('undefined');
      expect(backend.getActiveCount()).toBe(1);

      // destroy() should handle NaN PID gracefully without calling process.kill
      await backend.destroy('agent-nopid');
      expect(backend.getActiveCount()).toBe(0);
      // process.kill should NOT have been called (NaN PID guard)
      expect(killSpy).not.toHaveBeenCalled();
    });
  });

  describe('shutdownAll()', () => {
    it('kills all tracked processes', async () => {
      const backend = createBackend();

      const mock1 = createMockChildProcess(12345);
      mockChildProcess = mock1;
      await backend.spawn(['linux', 'bare-metal'], 'agent-1', 'http://localhost:4000');

      const mock2 = createMockChildProcess(12346);
      mockChildProcess = mock2;
      await backend.spawn(['linux', 'gpu', 'cuda'], 'agent-2', 'http://localhost:4000');

      // Route SIGTERM to the correct mock process by PID
      killSpy.mockImplementation((pid: number, signal?: string | number) => {
        if (signal === 'SIGTERM') {
          if (pid === -12345) {
            mock1.exitCode = 0;
            mock1.emit('exit', 0, null);
          } else if (pid === -12346) {
            mock2.exitCode = 0;
            mock2.emit('exit', 0, null);
          }
        }
        return true;
      });

      expect(backend.getActiveCount()).toBe(2);
      await backend.shutdownAll();
      expect(backend.getActiveCount()).toBe(0);
    });
  });

  describe('getActiveCount()', () => {
    it('returns correct count', async () => {
      const backend = createBackend();
      expect(backend.getActiveCount()).toBe(0);

      await backend.spawn(['linux', 'bare-metal'], 'agent-1', 'http://localhost:4000');
      expect(backend.getActiveCount()).toBe(1);

      const mock2 = createMockChildProcess(12346);
      mockChildProcess = mock2;
      await backend.spawn(['linux', 'gpu', 'cuda'], 'agent-2', 'http://localhost:4000');
      expect(backend.getActiveCount()).toBe(2);
    });
  });

  describe('process exit event', () => {
    it('auto-removes from tracking map', async () => {
      const backend = createBackend();
      await backend.spawn(['linux', 'bare-metal'], 'agent-1', 'http://localhost:4000');
      expect(backend.getActiveCount()).toBe(1);

      // Simulate process exit
      mockChildProcess.emit('exit', 0, null);
      expect(backend.getActiveCount()).toBe(0);
    });
  });

  describe('reload()', () => {
    it('validates bare-metal label sets must have binaryPath', () => {
      const backend = createBackend();
      const result = backend.reload([
        { labels: ['linux', 'bare-metal'], binaryPath: '/valid/path' },
        { labels: ['linux', 'node20'] }, // Missing binaryPath
      ]);

      expect(result.valid).toBe(false);
      if (!result.valid) {
        expect(result.errors).toHaveLength(1);
        expect(result.errors[0]).toContain("'binaryPath'");
      }
    });

    it('accepts valid label sets', () => {
      const backend = createBackend();
      const result = backend.reload([
        { labels: ['linux', 'bare-metal'], binaryPath: '/opt/kici/agent' },
      ]);
      expect(result.valid).toBe(true);
    });

    it('updates label sets on successful reload', () => {
      const backend = createBackend();
      const newLabelSets: LabelSetConfig[] = [
        { labels: ['linux', 'new'], binaryPath: '/new/path' },
      ];
      backend.reload(newLabelSets);

      expect(backend.labelSets).toEqual(newLabelSets);
    });
  });

  describe('type', () => {
    it('returns "bare-metal"', () => {
      const backend = createBackend();
      expect(backend.type).toBe('bare-metal');
    });
  });

  describe('spawn failure (child.on("error"))', () => {
    it('emits scaler.failed with the spawn error when the binary cannot start', async () => {
      const events: Array<{ eventType: string; detail: string }> = [];
      const backend = createBackend();

      await backend.spawn(['linux', 'bare-metal'], 'agent-enoent', 'http://localhost:4000', (e) =>
        events.push({ eventType: e.eventType, detail: e.detail }),
      );

      // Simulate the child failing to spawn (e.g. ENOENT for a missing binary).
      const enoent = Object.assign(new Error('spawn /opt/kici/kici-agent ENOENT'), {
        code: 'ENOENT',
      });
      mockChildProcess.emit('error', enoent);

      await vi.waitFor(() => {
        const failed = events.find((e) => e.eventType === ScalerEventType.enum['scaler.failed']);
        expect(failed).toBeDefined();
        expect(failed!.detail).toMatch(/ENOENT|spawn/i);
      });

      // The failed spawn must be cleaned up from tracking.
      expect(backend.getActiveCount()).toBe(0);
    });

    it('includes captured agent output in the scaler.failed detail', async () => {
      const events: Array<{ eventType: string; detail: string }> = [];
      const backend = createBackend();

      await backend.spawn(['linux', 'bare-metal'], 'agent-crash', 'http://localhost:4000', (e) =>
        events.push({ eventType: e.eventType, detail: e.detail }),
      );

      // Feed a few lines through the agent's captured output, then crash.
      const capture = backend.getLogCapture('agent-crash')!;
      mockChildProcess.stdout.write('booting agent\n');
      mockChildProcess.stderr.write('FATAL: config file missing\n');

      await vi.waitFor(() => {
        expect(capture.tail()).toContain('FATAL: config file missing');
      });

      mockChildProcess.emit('error', new Error('boom'));

      await vi.waitFor(() => {
        const failed = events.find((e) => e.eventType === ScalerEventType.enum['scaler.failed']);
        expect(failed).toBeDefined();
        expect(failed!.detail).toContain('captured output');
        expect(failed!.detail).toContain('FATAL: config file missing');
      });
    });
  });

  /**
   * Startup-time tool requirements reported by the scaler. Missing tools
   * here cause orchestrator startup to fail with a clear error (see
   * validateRequiredTools in @kici-dev/shared). The KICI_SANDBOX opt-in
   * must gate a bwrap `path-binary` requirement so that:
   *
   * 1. Linux operators who typo `KICI_SANDBOX=true` without installing
   *    bubblewrap learn at deploy time, not at first job dispatch.
   * 2. macOS and Windows operators cannot enable KICI_SANDBOX at all —
   *    `which bwrap` / `where bwrap` both fail on those platforms, so the
   *    startup check rejects the config immediately.
   */
  describe('getRequiredTools (KICI_SANDBOX opt-in)', () => {
    const entry = {
      name: 'bare-metal',
      labelSets: [
        {
          labels: ['linux', 'bare-metal'],
          binaryPath: '/opt/kici/kici-agent',
        },
      ],
    } as Parameters<typeof BareMetalScalerBackend.getRequiredTools>[0];

    const originalEnv = process.env;

    beforeEach(() => {
      process.env = { ...originalEnv };
      delete process.env.KICI_AGENT_ENV_KICI_SANDBOX;
    });

    afterEach(() => {
      process.env = originalEnv;
    });

    it('does not require bwrap by default', () => {
      const reqs = BareMetalScalerBackend.getRequiredTools(entry);
      expect(reqs.some((r) => r.type === 'path-binary' && r.name === 'bwrap')).toBe(false);
    });

    it('requires node — the bare-metal agent is a #!/usr/bin/env node script', () => {
      const reqs = BareMetalScalerBackend.getRequiredTools(entry);
      const nodeReq = reqs.find((r) => r.type === 'path-binary' && r.name === 'node');
      expect(nodeReq).toBeDefined();
      expect(nodeReq!.reason).toMatch(/node/i);
    });

    it('requires bwrap when KICI_AGENT_ENV_KICI_SANDBOX=true is set on the orchestrator', () => {
      process.env.KICI_AGENT_ENV_KICI_SANDBOX = 'true';

      const reqs = BareMetalScalerBackend.getRequiredTools(entry);
      const bwrapReq = reqs.find((r) => r.type === 'path-binary' && r.name === 'bwrap');
      expect(bwrapReq).toBeDefined();
      expect(bwrapReq!.reason).toMatch(/KICI_SANDBOX=true/);
      expect(bwrapReq!.reason).toMatch(/Linux-only/);
    });

    it('requires bwrap when a label set hardcodes env.KICI_SANDBOX=true in scalers.yaml', () => {
      const entryWithLabelSandbox = {
        ...entry,
        labelSets: [
          {
            labels: ['linux', 'secure'],
            binaryPath: '/opt/kici/kici-agent',
            env: { KICI_SANDBOX: 'true' },
          },
        ],
      } as Parameters<typeof BareMetalScalerBackend.getRequiredTools>[0];

      const reqs = BareMetalScalerBackend.getRequiredTools(entryWithLabelSandbox);
      expect(reqs.some((r) => r.type === 'path-binary' && r.name === 'bwrap')).toBe(true);
    });

    it('does NOT require bwrap when KICI_AGENT_ENV_KICI_SANDBOX is set to any value other than "true"', () => {
      // Must be an exact-string check — stray values like '1', 'yes', 'True'
      // should not pull in the hard bwrap requirement.
      process.env.KICI_AGENT_ENV_KICI_SANDBOX = 'false';
      expect(
        BareMetalScalerBackend.getRequiredTools(entry).some(
          (r) => r.type === 'path-binary' && r.name === 'bwrap',
        ),
      ).toBe(false);

      process.env.KICI_AGENT_ENV_KICI_SANDBOX = '';
      expect(
        BareMetalScalerBackend.getRequiredTools(entry).some(
          (r) => r.type === 'path-binary' && r.name === 'bwrap',
        ),
      ).toBe(false);
    });

    it('still reports the binaryPath file-access requirement alongside bwrap', () => {
      process.env.KICI_AGENT_ENV_KICI_SANDBOX = 'true';

      const reqs = BareMetalScalerBackend.getRequiredTools(entry);
      // binaryPath (file-access) + node (path-binary) + bwrap (path-binary)
      expect(reqs).toHaveLength(3);
      expect(reqs.some((r) => r.type === 'file-access' && r.path === '/opt/kici/kici-agent')).toBe(
        true,
      );
      expect(reqs.some((r) => r.type === 'path-binary' && r.name === 'node')).toBe(true);
      expect(reqs.some((r) => r.type === 'path-binary' && r.name === 'bwrap')).toBe(true);
    });
  });
});
