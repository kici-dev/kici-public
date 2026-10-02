import { describe, expect, it, vi, beforeEach, afterAll } from 'vitest';
import { Command } from 'commander';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const mockEmitKiciEventDirect = vi.fn();

vi.mock('@kici-dev/shared', async (importOriginal) => {
  const original = (await importOriginal()) as Record<string, unknown>;
  return {
    ...original,
    emitKiciEventDirect: mockEmitKiciEventDirect,
  };
});

const { registerEventCommands } = await import('./event.js');

interface MockClient {
  post: ReturnType<typeof vi.fn>;
  listEvents?: ReturnType<typeof vi.fn>;
  getEvent?: ReturnType<typeof vi.fn>;
}

function makeMockClient(): MockClient {
  return { post: vi.fn() };
}

async function runCommand(
  args: string[],
  client: MockClient = makeMockClient(),
): Promise<{ stdout: string; stderr: string; exitCode: number | null; client: MockClient }> {
  const program = new Command();
  program.exitOverride();
  registerEventCommands(program, () => client as any);

  const logs: string[] = [];
  const errors: string[] = [];
  const origLog = console.log;
  const origError = console.error;
  let exitCode: number | null = null;

  console.log = (...a: any[]) => logs.push(a.join(' '));
  console.error = (...a: any[]) => errors.push(a.join(' '));

  const origExit = process.exit;
  process.exit = ((code?: number) => {
    exitCode = code ?? 0;
    throw new Error(`EXIT:${code}`);
  }) as any;

  try {
    await program.parseAsync(args, { from: 'user' });
  } catch (err: any) {
    if (!err.message?.startsWith('EXIT:') && !err.code?.startsWith('commander.')) {
      console.log = origLog;
      console.error = origError;
      process.exit = origExit;
      throw err;
    }
  } finally {
    console.log = origLog;
    console.error = origError;
    process.exit = origExit;
  }

  return { stdout: logs.join('\n'), stderr: errors.join('\n'), exitCode, client };
}

// Create a tmp directory for payload fixture files shared by all tests.
const TMP_DIR = mkdtempSync(join(tmpdir(), 'kici-event-cli-test-'));

function writePayloadFile(name: string, body: unknown): string {
  const p = join(TMP_DIR, name);
  writeFileSync(p, JSON.stringify(body));
  return p;
}

describe('kici-admin event CLI', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.KICI_DATABASE_URL;
  });

  afterAll(() => {
    rmSync(TMP_DIR, { recursive: true, force: true });
  });

  describe('emit', () => {
    it('emits event in direct-DB mode via --database-url', async () => {
      mockEmitKiciEventDirect.mockResolvedValue({ eventId: 'evt-uuid-0001' });
      const payloadPath = writePayloadFile('basic.json', { foo: 'bar', n: 42 });

      const { stdout, exitCode } = await runCommand([
        'event',
        'emit',
        'deploy.started',
        '--payload-file',
        payloadPath,
        '--database-url',
        'postgresql://localhost/kici',
      ]);

      expect(exitCode).toBeNull();
      expect(mockEmitKiciEventDirect).toHaveBeenCalledWith('postgresql://localhost/kici', {
        eventName: 'deploy.started',
        payload: { foo: 'bar', n: 42 },
        sourceRoutingKey: undefined,
        sourceRepo: undefined,
      });
      expect(stdout).toContain('evt-uuid-0001');
    });

    it('forwards --source-routing-key and --source-repo to the helper', async () => {
      mockEmitKiciEventDirect.mockResolvedValue({ eventId: 'evt-uuid-0002' });
      const payloadPath = writePayloadFile('cross.json', { fruit: 'apple' });

      await runCommand([
        'event',
        'emit',
        'cross.repo.event',
        '--payload-file',
        payloadPath,
        '--source-routing-key',
        'github:99',
        '--source-repo',
        'owner/repo',
        '--database-url',
        'postgresql://env/kici',
      ]);

      expect(mockEmitKiciEventDirect).toHaveBeenCalledWith(
        'postgresql://env/kici',
        expect.objectContaining({
          eventName: 'cross.repo.event',
          payload: { fruit: 'apple' },
          sourceRoutingKey: 'github:99',
          sourceRepo: 'owner/repo',
        }),
      );
    });

    it('uses HTTP mode when --database-url absent and no env var is set', async () => {
      const payloadPath = writePayloadFile('http.json', { hello: 'world' });
      const client = makeMockClient();
      client.post.mockResolvedValue({ eventId: 'http-evt-0003' });

      const { stdout } = await runCommand(
        ['event', 'emit', 'custom.event', '--payload-file', payloadPath, '--json'],
        client,
      );

      expect(client.post).toHaveBeenCalledWith('/api/v1/admin/events/emit', {
        eventName: 'custom.event',
        payload: { hello: 'world' },
        sourceRoutingKey: undefined,
        sourceRepo: undefined,
      });
      expect(mockEmitKiciEventDirect).not.toHaveBeenCalled();
      // --json mode emits exactly the structured record on stdout.
      const parsed = JSON.parse(stdout);
      expect(parsed).toEqual({ eventId: 'http-evt-0003' });
    });

    it('accepts KICI_DATABASE_URL from env', async () => {
      process.env.KICI_DATABASE_URL = 'postgresql://env-host/kici';
      mockEmitKiciEventDirect.mockResolvedValue({ eventId: 'env-evt-0004' });
      const payloadPath = writePayloadFile('env.json', { ok: true });

      await runCommand(['event', 'emit', 'from.env', '--payload-file', payloadPath]);

      expect(mockEmitKiciEventDirect).toHaveBeenCalledWith(
        'postgresql://env-host/kici',
        expect.objectContaining({ eventName: 'from.env' }),
      );
    });

    it('fails with clear error when --payload-file does not exist', async () => {
      const { stderr, exitCode } = await runCommand([
        'event',
        'emit',
        'any.event',
        '--payload-file',
        join(TMP_DIR, 'does-not-exist.json'),
        '--database-url',
        'postgresql://localhost/kici',
      ]);

      expect(exitCode).toBe(1);
      expect(stderr).toContain('could not read');
      expect(mockEmitKiciEventDirect).not.toHaveBeenCalled();
    });

    it('fails with clear error when --payload-file is not valid JSON object', async () => {
      const badPath = join(TMP_DIR, 'not-json.json');
      writeFileSync(badPath, 'this is not JSON');

      const { stderr, exitCode } = await runCommand([
        'event',
        'emit',
        'bad.json',
        '--payload-file',
        badPath,
        '--database-url',
        'postgresql://localhost/kici',
      ]);

      expect(exitCode).toBe(1);
      expect(stderr).toContain('invalid JSON');
      expect(mockEmitKiciEventDirect).not.toHaveBeenCalled();
    });

    it('rejects non-object JSON payloads (arrays, primitives) because the kici_events schema expects an object', async () => {
      const arrPath = writePayloadFile('array.json', [1, 2, 3]);

      const { stderr, exitCode } = await runCommand([
        'event',
        'emit',
        'array.event',
        '--payload-file',
        arrPath,
        '--database-url',
        'postgresql://localhost/kici',
      ]);

      expect(exitCode).toBe(1);
      expect(stderr).toContain('payload must be a JSON object');
      expect(mockEmitKiciEventDirect).not.toHaveBeenCalled();
    });
  });
});

describe('kici-admin event list / show', () => {
  const row = {
    id: '0b5c7a52-6c1e-4b8e-9d3a-7f1e2a3b4c5d',
    eventName: 'kici.scaler.scale-up',
    createdAt: '2026-10-01T10:00:00.000Z',
    state: 'processed',
    matchOutcome: 'no-target-repo',
    matchedCount: 0,
    attempts: 1,
    sourceRepo: null,
    sourceRoutingKey: null,
    targetRepos: ['org/provision'],
  };

  it('forwards the filters and prints the JSON verbatim', async () => {
    const response = { events: [row], limit: 50, nextCursor: null };
    const client = { post: vi.fn(), listEvents: vi.fn().mockResolvedValue(response) };
    const { stdout, exitCode } = await runCommand(
      ['event', 'list', '--name', 'kici.scaler.scale-up', '--outcome', 'no-target-repo', '--json'],
      client,
    );
    expect(exitCode).toBeNull();
    expect(client.listEvents).toHaveBeenCalledWith({
      name: 'kici.scaler.scale-up',
      outcome: 'no-target-repo',
    });
    expect(JSON.parse(stdout)).toEqual(response);
  });

  it('prints a table and the next-page cursor', async () => {
    const client = {
      post: vi.fn(),
      listEvents: vi
        .fn()
        .mockResolvedValue({ events: [row], limit: 1, nextCursor: '2026-10-01T10:00:00.000Z' }),
    };
    const { stdout } = await runCommand(['event', 'list', '--limit', '1'], client);
    expect(client.listEvents).toHaveBeenCalledWith({ limit: 1 });
    expect(stdout).toMatch(/ID\s+NAME\s+CREATED\s+STATE\s+OUTCOME\s+MATCHED\s+ATTEMPTS/);
    expect(stdout).toContain('no-target-repo');
    expect(stdout).toContain('Next page: --before 2026-10-01T10:00:00.000Z');
  });

  it('shows one event with its payload and runs', async () => {
    const detail = {
      ...row,
      matchOutcome: 'matched',
      matchedCount: 1,
      payload: { agentId: 'a1', claimCode: '[redacted]' },
      sourceRunId: null,
      sourceJobId: null,
      chainDepth: 0,
      expiresAt: '2026-10-08T10:00:00.000Z',
      lastError: null,
      nextRetryAt: null,
      dlqAt: null,
      dlqReason: null,
      runs: [{ runId: 'run-1', workflowName: 'provision', status: 'success', createdAt: 'x' }],
    };
    const client = { post: vi.fn(), getEvent: vi.fn().mockResolvedValue(detail) };
    const { stdout } = await runCommand(['event', 'show', row.id], client);
    expect(client.getEvent).toHaveBeenCalledWith(row.id);
    expect(stdout).toContain('Outcome:       matched');
    expect(stdout).toContain('"claimCode": "[redacted]"');
    expect(stdout).toMatch(/run-1\s+provision\s+success/);
  });

  it('says "Runs: none" for an event that dispatched nothing', async () => {
    const detail = {
      ...row,
      payload: {},
      sourceRunId: null,
      sourceJobId: null,
      chainDepth: 0,
      expiresAt: 'x',
      lastError: null,
      nextRetryAt: null,
      dlqAt: null,
      dlqReason: null,
      runs: [],
    };
    const client = { post: vi.fn(), getEvent: vi.fn().mockResolvedValue(detail) };
    const { stdout } = await runCommand(['event', 'show', row.id], client);
    expect(stdout).toContain('Runs: none');
  });

  it('says the payload is hidden when the role cannot read it', async () => {
    const detail = {
      ...row,
      payload: null,
      sourceRunId: null,
      sourceJobId: null,
      chainDepth: 0,
      expiresAt: 'x',
      lastError: null,
      nextRetryAt: null,
      dlqAt: null,
      dlqReason: null,
      runs: [],
    };
    const client = { post: vi.fn(), getEvent: vi.fn().mockResolvedValue(detail) };
    const { stdout } = await runCommand(['event', 'show', row.id], client);
    expect(stdout).toContain('Payload: hidden (needs event_log.read_payload)');
  });

  it('names an orchestrator that does not serve the route', async () => {
    // fails-when: an older orchestrator's bare 404 surfaces as "HTTP 404: 404 Not Found"
    const client = {
      post: vi.fn(),
      listEvents: vi.fn().mockRejectedValue(new Error('HTTP 404: 404 Not Found')),
    };
    const { stderr, exitCode } = await runCommand(['event', 'list'], client);
    expect(exitCode).toBe(1);
    expect(stderr).toBe(
      'Error: this orchestrator does not serve `kici-admin event list`; upgrade it',
    );
  });

  it("passes a known route's 404 through unchanged", async () => {
    // breaks-if-wrong: an unknown event id must not read as an old orchestrator
    const client = {
      post: vi.fn(),
      getEvent: vi.fn().mockRejectedValue(new Error('HTTP 404: Event not found')),
    };
    const { stderr, exitCode } = await runCommand(['event', 'show', row.id], client);
    expect(exitCode).toBe(1);
    expect(stderr).toBe('Error: HTTP 404: Event not found');
  });
});
