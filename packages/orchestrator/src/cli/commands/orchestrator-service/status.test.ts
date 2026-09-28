/**
 * Tests for the orchestrator status command's folder-anchored behavior:
 * refusal when no targeting flag and no CWD manifest, and --instance-dir
 * resolution flowing through to manager.status with a ServiceConfig built
 * from the manifest. The action also reads the env file for the port + calls
 * /health, but the default mock returns state: 'stopped' so the HTTP path
 * is skipped.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Command } from 'commander';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type {
  DiscoveredInstance,
  ServiceConfig,
  ServiceManager,
  ServicePlatform,
  ServiceStatus,
} from '../../service/types.js';

let mockListResult: DiscoveredInstance[] = [];
let mockStatusResult: ServiceStatus = { state: 'stopped' };
const mockStatus = vi.fn(async () => mockStatusResult);
const mockList = vi.fn(async (_isUserLevel: boolean) => mockListResult);
let mockKiciRoot = '';

/** Platforms whose driver the command operated through — discovery `list` calls excluded. */
const operatedPlatforms: string[] = [];

/** Wrap a driver operation so it records which platform's driver ran it. */
function op<A extends unknown[], R>(platform: string, fn: (...a: A) => R): (...a: A) => R {
  return (...args: A) => {
    operatedPlatforms.push(platform);
    return fn(...args);
  };
}

vi.mock('../../service/index.js', async () => {
  const actual =
    await vi.importActual<typeof import('../../service/index.js')>('../../service/index.js');

  const makeManager = (platform: ServicePlatform): ServiceManager =>
    ({
      platform,
      install: vi.fn(),
      uninstall: vi.fn(),
      start: vi.fn(),
      stop: vi.fn(),
      restart: vi.fn(),
      status: op(platform, (...args: unknown[]) =>
        mockStatus(...(args as Parameters<typeof mockStatus>)),
      ),
      logs: vi.fn(),
      isInstalled: vi.fn(),
      list: (...args: unknown[]) => mockList(...(args as Parameters<typeof mockList>)),
    }) as unknown as ServiceManager;
  return {
    ...actual,
    detectPlatform: vi.fn().mockReturnValue('systemd'),
    resolveUserLevel: vi.fn().mockReturnValue(true),
    kiciConfigRoot: vi.fn(() => mockKiciRoot),
    createServiceManager: vi.fn(async (platform: ServicePlatform) => makeManager(platform)),
    // Manager selection lives in the seam, so the real one runs here with the
    // driver factory injected: every candidate platform gets its own double, and
    // `op` records which one the command actually operated through.
    resolveInstanceTarget: (args: Parameters<typeof actual.resolveInstanceTarget>[0]) =>
      actual.resolveInstanceTarget({ ...args, createManager: async (p) => makeManager(p) }),
  };
});

import { registerStatusCommand, formatConfigPaths, readinessTimeoutMs } from './status.js';
import { writeIndex, writeManifest } from '../../service/index.js';
import type { InstanceManifest } from '../../service/index.js';
import { Hono } from 'hono';
import { createHealthRoutes, type HealthRoutesDeps } from '../../../routes/health.js';
import { DB_POOL_ACQUIRE_TIMEOUT_DEFAULT_MS } from '../../../config.js';

function mkTmp(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function makeManifest(overrides: Partial<InstanceManifest> = {}): InstanceManifest {
  return {
    component: 'orchestrator',
    name: 'kici-test',
    platform: 'systemd',
    isUserLevel: true,
    envFilePath: '/x/kici-test.env',
    configDir: '/x/',
    logDir: '/x/logs/',
    installBase: '/opt/kici/kici-test/',
    createdAt: '2026-05-28T00:00:00Z',
    kiciVersion: '0.1.13',
    ...overrides,
  };
}

describe('orchestrator status — folder-anchored', () => {
  let program: Command;
  let tmpInstanceDir: string;
  let tmpConfigRoot: string;
  let consoleLogSpy: ReturnType<typeof vi.spyOn>;
  let consoleErrorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    tmpInstanceDir = mkTmp('kici-e4-st-i-');
    tmpConfigRoot = mkTmp('kici-e4-st-c-');

    mockListResult = [];
    mockStatusResult = { state: 'stopped' };
    mockStatus.mockClear();
    mockList.mockClear();
    operatedPlatforms.length = 0;
    mockKiciRoot = tmpConfigRoot;

    program = new Command();
    program.name('orchestrator');
    registerStatusCommand(program);

    consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    consoleLogSpy.mockRestore();
    consoleErrorSpy.mockRestore();
    for (const dir of [tmpInstanceDir, tmpConfigRoot]) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('refuses without --instance-dir/--name and no CWD manifest', async () => {
    const savedCwd = process.cwd();
    const emptyCwd = mkTmp('kici-e4-st-cwd-');
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {
      throw new Error('process.exit called');
    }) as never);

    try {
      process.chdir(emptyCwd);
      await expect(program.parseAsync(['node', 'orchestrator', 'status'])).rejects.toThrow(
        'process.exit called',
      );

      expect(exitSpy).toHaveBeenCalledWith(1);
      const errArgs = consoleErrorSpy.mock.calls.map((c) => c.join(' ')).join('\n');
      expect(errArgs).toContain('No orchestrator instances installed on this host');
      expect(mockStatus).not.toHaveBeenCalled();
    } finally {
      process.chdir(savedCwd);
      exitSpy.mockRestore();
      fs.rmSync(emptyCwd, { recursive: true, force: true });
    }
  });

  it('resolves via --instance-dir and calls manager.status', async () => {
    const manifest = makeManifest({ name: 'kici-test' });
    writeManifest(tmpInstanceDir, manifest);
    writeIndex(tmpConfigRoot, [
      {
        component: 'orchestrator',
        name: 'kici-test',
        platform: 'systemd',
        isUserLevel: true,
        instanceDir: tmpInstanceDir,
      },
    ]);

    await program.parseAsync(['node', 'orchestrator', 'status', '--instance-dir', tmpInstanceDir]);

    expect(mockStatus).toHaveBeenCalledTimes(1);
    const cfg = mockStatus.mock.calls[0]![0] as ServiceConfig;
    expect(cfg.name).toBe('kici-test');
    expect(cfg.component).toBe('orchestrator');
    expect(cfg.envFilePath).toBe(manifest.envFilePath);
    expect(cfg.workingDirectory).toBe(manifest.configDir);
    expect(cfg.isUserLevel).toBe(true);
  });

  it('prints the config paths in both outputs for a stopped service', async () => {
    // fails-when: the formatter is computed but never emitted, or is emitted
    // only while the service is running — this instance is stopped, which is
    // the case the command exists to answer.
    const manifest = makeManifest({ name: 'kici-test' });
    writeManifest(tmpInstanceDir, manifest);
    writeIndex(tmpConfigRoot, [
      {
        component: 'orchestrator',
        name: 'kici-test',
        platform: 'systemd',
        isUserLevel: true,
        instanceDir: tmpInstanceDir,
      },
    ]);

    await program.parseAsync(['node', 'orchestrator', 'status', '--instance-dir', tmpInstanceDir]);
    const text = consoleLogSpy.mock.calls.map((c: unknown[]) => c.join(' ')).join('\n');
    expect(text).toContain('--- Config files ---');
    expect(text).toContain(`Env file:      ${manifest.envFilePath}`);

    consoleLogSpy.mockClear();
    await program.parseAsync([
      'node',
      'orchestrator',
      'status',
      '--instance-dir',
      tmpInstanceDir,
      '--json',
    ]);
    const json = JSON.parse(String(consoleLogSpy.mock.calls[0]![0])) as {
      configPaths: Record<string, string>;
    };
    expect(json.configPaths).toEqual({ envFile: manifest.envFilePath });
  });

  it('reports the compose file from the manifest, not from the host platform', async () => {
    // fails-when: the compose branch reads detectPlatform() instead of the
    // manifest. detectPlatform is mocked to 'systemd' here — the value it
    // returns on any systemd Linux, including a host whose orchestrator is a
    // compose install — while the manifest records the install's real shape.
    // Reading the host value drops the compose file for the common case.
    const manifest = makeManifest({ name: 'kici-test', platform: 'compose' });
    writeManifest(tmpInstanceDir, manifest);
    writeIndex(tmpConfigRoot, [
      {
        component: 'orchestrator',
        name: 'kici-test',
        platform: 'compose',
        isUserLevel: true,
        instanceDir: tmpInstanceDir,
      },
    ]);

    await program.parseAsync([
      'node',
      'orchestrator',
      'status',
      '--instance-dir',
      tmpInstanceDir,
      '--json',
    ]);
    const json = JSON.parse(String(consoleLogSpy.mock.calls[0]![0])) as {
      configPaths: Record<string, string>;
    };
    expect(json.configPaths).toEqual({
      envFile: '/x/kici-test.env',
      composeFile: '/x/kici-test-compose.yaml',
    });
  });

  it('reports paths for the driver --platform forced, not for the manifest', async () => {
    // `--platform` forces one driver for the whole command, so the status it
    // prints describes that driver's view. Re-deriving the platform from the
    // manifest instead makes the two disagree: a systemd driver reporting a
    // compose file for a stack it is not operating.
    //
    // fails-when: `installPlatform` is read off `resolved.manifest.platform`
    // again — `composeFile` reappears here while `manager` is the systemd one.
    const manifest = makeManifest({ name: 'kici-test', platform: 'compose' });
    writeManifest(tmpInstanceDir, manifest);

    await program.parseAsync([
      'node',
      'orchestrator',
      'status',
      '--instance-dir',
      tmpInstanceDir,
      '--platform',
      'systemd',
      '--json',
    ]);

    expect([...new Set(operatedPlatforms)]).toEqual(['systemd']);
    const json = JSON.parse(String(consoleLogSpy.mock.calls[0]![0])) as {
      configPaths: Record<string, string>;
    };
    expect(json.configPaths).toEqual({ envFile: '/x/kici-test.env' });
  });

  it('omits the compose file for a bare-metal install', async () => {
    // breaks-if-wrong: the counterpart of the case above. A systemd install must
    // never be handed a compose file it does not have. The manifest is the only
    // input either case reads, so this one cannot itself separate host from
    // manifest — the compose case above is what pins that axis.
    const manifest = makeManifest({ name: 'kici-test', platform: 'systemd' });
    writeManifest(tmpInstanceDir, manifest);
    writeIndex(tmpConfigRoot, [
      {
        component: 'orchestrator',
        name: 'kici-test',
        platform: 'systemd',
        isUserLevel: true,
        instanceDir: tmpInstanceDir,
      },
    ]);

    await program.parseAsync([
      'node',
      'orchestrator',
      'status',
      '--instance-dir',
      tmpInstanceDir,
      '--json',
    ]);
    const json = JSON.parse(String(consoleLogSpy.mock.calls[0]![0])) as {
      configPaths: Record<string, string>;
    };
    expect(json.configPaths).toEqual({ envFile: '/x/kici-test.env' });
  });

  // fails-when: the action picks the manager from the host. detectPlatform is
  // pinned to 'systemd' by the module mock, so a host-derived selection operates
  // the systemd driver and operatedPlatforms holds 'systemd'.
  it('operates a compose-manifest install through the compose driver on a systemd host', async () => {
    writeManifest(tmpInstanceDir, makeManifest({ name: 'kici-test', platform: 'compose' }));

    await program.parseAsync(['node', 'orchestrator', 'status', '--instance-dir', tmpInstanceDir]);

    expect(mockStatus).toHaveBeenCalledTimes(1);
    expect([...new Set(operatedPlatforms)]).toEqual(['compose']);
  });

  // breaks-if-wrong: the overwhelmingly common case must be unaffected — a
  // systemd install on a systemd host still operates through the systemd driver.
  it('operates a systemd-manifest install through the systemd driver', async () => {
    writeManifest(tmpInstanceDir, makeManifest({ name: 'kici-test', platform: 'systemd' }));

    await program.parseAsync(['node', 'orchestrator', 'status', '--instance-dir', tmpInstanceDir]);

    expect(mockStatus).toHaveBeenCalledTimes(1);
    expect([...new Set(operatedPlatforms)]).toEqual(['systemd']);
  });
});

/**
 * Build-time constants the orchestrator's /health route reads through
 * `typeof KICI_*`. Setting them on globalThis gives the real route distinct
 * values, so an assertion can tell a rendered field from a default.
 */
const BUILD_GLOBALS = {
  KICI_PKG_VERSION: '9.8.7',
  KICI_BUILD_DATE: '2026-09-25T15:27:17.455Z',
  KICI_BUILD_COMMIT: 'c0ffee123',
  KICI_SDK_VERSION: '9.8.6',
  KICI_SDK_BUNDLE_HASH: 'b012bd8bace3df9e574252bf290c652b',
  KICI_SHARED_VERSION: '9.8.5',
  KICI_SHARED_BUNDLE_HASH: 'c43dafa78ecdfdff530b94f7f0629d29',
  KICI_ENGINE_VERSION: '9.8.4',
  KICI_ENGINE_BUNDLE_HASH: '0253acfa2150e263bde9698a0d8e9595',
} as const;

/** A database handle whose readiness query succeeds, or throws when `healthy` is false. */
function fakeDb(healthy: boolean): HealthRoutesDeps['db'] {
  const execute = async () => {
    if (!healthy) throw new Error('connection refused');
    return [];
  };
  return {
    selectFrom: () => ({ select: () => ({ limit: () => ({ execute }) }) }),
  } as unknown as HealthRoutesDeps['db'];
}

describe('orchestrator status — health section', () => {
  let program: Command;
  let tmpInstanceDir: string;
  let tmpConfigRoot: string;
  let consoleLogSpy: ReturnType<typeof vi.spyOn>;
  let consoleErrorSpy: ReturnType<typeof vi.spyOn>;
  let requestedUrls: string[];

  /**
   * Answer the command's HTTP requests with the orchestrator's real health
   * routes, so the renderer is fed the body the running service returns.
   * `basePath` mounts them the way `KICI_BASE_PATH` does. `readyDelayMs` holds
   * the `/ready` answer back (`'never'` never sends one); a held request still
   * rejects when the caller aborts it.
   */
  function serveRealHealthRoutes(opts: {
    dbHealthy: boolean;
    basePath?: string;
    readyDelayMs?: number | 'never';
  }): void {
    const routes = createHealthRoutes({ db: fakeDb(opts.dbHealthy), isWarm: () => true });
    const app = opts.basePath ? new Hono().basePath(opts.basePath).route('/', routes) : routes;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL, init?: RequestInit) => {
        const url = new URL(String(input));
        requestedUrls.push(url.href);
        const answer = () => app.request(url.pathname);
        const delay = opts.readyDelayMs;
        if (!url.pathname.endsWith('/ready') || delay === undefined) return answer();
        return new Promise<Response>((resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(new Error('aborted')));
          if (delay !== 'never') setTimeout(() => resolve(answer()), delay);
        });
      }),
    );
  }

  function writeEnv(extra = ''): void {
    const envFilePath = path.join(tmpInstanceDir, 'orch.env');
    fs.writeFileSync(envFilePath, `KICI_MODE=independent\nKICI_PORT=4567\n${extra}`);
    writeManifest(tmpInstanceDir, makeManifest({ name: 'kici-test', envFilePath }));
  }

  async function runStatus(extraArgs: string[] = []): Promise<string> {
    await program.parseAsync([
      'node',
      'orchestrator',
      'status',
      '--instance-dir',
      tmpInstanceDir,
      ...extraArgs,
    ]);
    return consoleLogSpy.mock.calls.map((c: unknown[]) => c.join(' ')).join('\n');
  }

  /** Run the command under fake timers, letting `elapseMs` pass while it waits. */
  async function runStatusWhileTimePasses(elapseMs: number): Promise<string[]> {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      const done = runStatus();
      await vi.advanceTimersByTimeAsync(elapseMs);
      return (await done).split('\n');
    } finally {
      vi.useRealTimers();
    }
  }

  beforeEach(() => {
    tmpInstanceDir = mkTmp('kici-st-health-i-');
    tmpConfigRoot = mkTmp('kici-st-health-c-');
    mockKiciRoot = tmpConfigRoot;
    mockStatusResult = { state: 'running', pid: 4242 };
    mockStatus.mockClear();
    requestedUrls = [];
    for (const [key, value] of Object.entries(BUILD_GLOBALS)) {
      (globalThis as Record<string, unknown>)[key] = value;
    }
    writeEnv();

    program = new Command();
    program.name('orchestrator');
    registerStatusCommand(program);

    consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    for (const key of Object.keys(BUILD_GLOBALS)) {
      delete (globalThis as Record<string, unknown>)[key];
    }
    consoleLogSpy.mockRestore();
    consoleErrorSpy.mockRestore();
    mockStatusResult = { state: 'stopped' };
    for (const dir of [tmpInstanceDir, tmpConfigRoot]) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('renders the fields the running orchestrator reports on /health', async () => {
    // fails-when: the renderer reads a field the real /health route does not
    // return — the line for it is missing, and a heading with only fields the
    // route never sends prints empty.
    serveRealHealthRoutes({ dbHealthy: true });

    const text = await runStatus();
    const lines = text.split('\n');

    expect(requestedUrls).toContain('http://localhost:4567/health');
    expect(lines).toContain('Health:     ok');
    expect(lines).toContain(
      `Version:    ${BUILD_GLOBALS.KICI_PKG_VERSION} (built ${BUILD_GLOBALS.KICI_BUILD_DATE})`,
    );
    // fails-when: the route or the renderer reads the baked build commit, a
    // commit ID from the private repository.
    expect(text).not.toContain(BUILD_GLOBALS.KICI_BUILD_COMMIT);
    expect(lines).toContain(
      `SDK:        ${BUILD_GLOBALS.KICI_SDK_VERSION} (bundle ${BUILD_GLOBALS.KICI_SDK_BUNDLE_HASH.slice(0, 12)})`,
    );
    // /health reports fractional seconds; the line shows whole ones.
    expect(lines.find((l) => l.startsWith('Uptime:     '))).toMatch(/^Uptime: {5}\d+[smhd]/);
    expect(lines.some((l) => /^Uptime:.*\./.test(l))).toBe(false);
  });

  it('reports readiness from /ready, including a failing database', async () => {
    // fails-when: /ready is not queried, or its 503 body is discarded as an
    // unreachable endpoint.
    serveRealHealthRoutes({ dbHealthy: true });
    expect((await runStatus()).split('\n')).toContain('Ready:      yes');

    consoleLogSpy.mockClear();
    serveRealHealthRoutes({ dbHealthy: false });
    expect((await runStatus()).split('\n')).toContain('Ready:      no (failing: database)');
  });

  it('says readiness is unknown when /ready never answers', async () => {
    // fails-when: a silent /ready drops the Ready line, so an orchestrator whose
    // database hangs reads as healthy.
    serveRealHealthRoutes({ dbHealthy: true, readyDelayMs: 'never' });

    const lines = await runStatusWhileTimePasses(60_000);

    expect(lines).toContain('Health:     ok');
    expect(lines).toContain('Ready:      unknown (/ready did not answer)');
  });

  it('waits for /ready as long as the env file lets the database pool wait', async () => {
    // fails-when: /ready gets the fixed 3s request timeout, or a timeout that
    // ignores KICI_DB_POOL_ACQUIRE_TIMEOUT_MS — a readiness check waiting on a
    // slow database is cut off before it reports database: false.
    // breaks-if-wrong: the default pool timeout still bounds the wait, so the
    // same 15s answer is "unknown" when the env file sets no longer timeout.
    serveRealHealthRoutes({ dbHealthy: false, readyDelayMs: 15_000 });
    expect(await runStatusWhileTimePasses(60_000)).toContain(
      'Ready:      unknown (/ready did not answer)',
    );

    consoleLogSpy.mockClear();
    writeEnv('KICI_DB_POOL_ACQUIRE_TIMEOUT_MS=20000\n');
    serveRealHealthRoutes({ dbHealthy: false, readyDelayMs: 15_000 });
    expect(await runStatusWhileTimePasses(60_000)).toContain('Ready:      no (failing: database)');
  });

  it('queries the routes under KICI_BASE_PATH', async () => {
    // fails-when: the prefix is not applied — the routes mounted under
    // /orchestrator answer 404 at /health and the section is replaced by the
    // unreachable message.
    // breaks-if-wrong: without KICI_BASE_PATH the same mount is unreachable, so
    // the prefix is what makes the first run work.
    writeEnv('KICI_BASE_PATH=/orchestrator/\n');
    serveRealHealthRoutes({ dbHealthy: true, basePath: '/orchestrator' });

    const lines = (await runStatus()).split('\n');

    expect(requestedUrls).toContain('http://localhost:4567/orchestrator/health');
    expect(lines).toContain('Health:     ok');
    expect(lines).toContain('Ready:      yes');

    consoleLogSpy.mockClear();
    writeEnv();
    serveRealHealthRoutes({ dbHealthy: true, basePath: '/orchestrator' });
    expect(await runStatus()).toContain('(Could not reach health API)');
  });

  it('queries the address KICI_HOST binds, and localhost for a wildcard bind', async () => {
    writeEnv('KICI_HOST=10.0.0.5\n');
    serveRealHealthRoutes({ dbHealthy: true });
    await runStatus();
    expect(requestedUrls).toContain('http://10.0.0.5:4567/health');

    requestedUrls = [];
    writeEnv('KICI_HOST=0.0.0.0\n');
    await runStatus();
    expect(requestedUrls).toContain('http://localhost:4567/health');
  });

  it('returns the same values in --json, with readiness alongside health', async () => {
    serveRealHealthRoutes({ dbHealthy: false });

    const text = await runStatus(['--json']);
    const json = JSON.parse(text) as {
      health: Record<string, unknown>;
      readiness: { status: string; checks: Record<string, boolean> };
    };

    expect(json.health.version).toBe(BUILD_GLOBALS.KICI_PKG_VERSION);
    // The deprecated key stays, carrying the version.
    expect(json.health.buildCommit).toBe(BUILD_GLOBALS.KICI_PKG_VERSION);
    expect(text).not.toContain(BUILD_GLOBALS.KICI_BUILD_COMMIT);
    expect(json.readiness).toEqual({
      status: 'not ready',
      checks: { database: false, warm: true },
    });
  });

  it('still says the health API is unreachable when nothing answers', async () => {
    // breaks-if-wrong: the unreachable case keeps its own message instead of
    // an empty or partial section.
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('ECONNREFUSED');
      }),
    );

    const text = await runStatus();

    expect(text).toContain('(Could not reach health API)');
    expect(text).not.toContain('--- KiCI orchestrator ---');
  });
});

describe('readinessTimeoutMs', () => {
  it('covers the database-pool acquire timeout plus a margin', () => {
    // fails-when: the configured acquire timeout is ignored, or a 0 ("wait
    // without limit") or unparseable value yields an unbounded or NaN wait.
    const base = readinessTimeoutMs('');
    expect(base).toBeGreaterThan(DB_POOL_ACQUIRE_TIMEOUT_DEFAULT_MS);
    expect(readinessTimeoutMs('KICI_DB_POOL_ACQUIRE_TIMEOUT_MS=20000\n')).toBe(
      base - DB_POOL_ACQUIRE_TIMEOUT_DEFAULT_MS + 20_000,
    );
    expect(readinessTimeoutMs('KICI_DB_POOL_ACQUIRE_TIMEOUT_MS=0\n')).toBe(base);
    expect(readinessTimeoutMs('KICI_DB_POOL_ACQUIRE_TIMEOUT_MS=soon\n')).toBe(base);
  });
});

describe('formatConfigPaths', () => {
  it('lists the env file for a bare-metal install', () => {
    // fails-when: the env file line is dropped or relabelled — the array no
    // longer equals this literal.
    expect(
      formatConfigPaths({
        platform: 'systemd',
        serviceName: 'orch1',
        envFilePath: '/etc/kici/orch1.env',
        envContent: '',
      }),
    ).toEqual(['--- Config files ---', 'Env file:      /etc/kici/orch1.env']);
  });

  it('adds the compose file only for a compose install', () => {
    // fails-when: the compose line is emitted unconditionally — a systemd
    // operator would be sent to a file that does not exist. The systemd case
    // above pins that with an exact-array assertion.
    const compose = formatConfigPaths({
      platform: 'compose',
      serviceName: 'orch1',
      envFilePath: '/etc/kici/orch1.env',
      envContent: '',
    });
    expect(compose).toContain('Compose file:  /etc/kici/orch1-compose.yaml');
  });

  it('adds the scaler config when the env file names one', () => {
    // fails-when: the scaler lookup reads a different key, or the env file is
    // not consulted at all — the line is absent.
    const lines = formatConfigPaths({
      platform: 'systemd',
      serviceName: 'orch1',
      envFilePath: '/etc/kici/orch1.env',
      envContent: 'KICI_SCALER_CONFIG_PATH=/etc/kici/scalers.yaml\n',
    });
    expect(lines).toContain('Scaler config: /etc/kici/scalers.yaml');
  });

  it('falls back to the scaler config directory', () => {
    // fails-when: only KICI_SCALER_CONFIG_PATH is consulted — a directory-based
    // install reports no scaler config at all.
    const lines = formatConfigPaths({
      platform: 'systemd',
      serviceName: 'orch1',
      envFilePath: '/etc/kici/orch1.env',
      envContent: 'KICI_SCALER_CONFIG_DIR=/etc/kici/scalers.d\n',
    });
    expect(lines).toContain('Scaler config: /etc/kici/scalers.d');
  });
});
