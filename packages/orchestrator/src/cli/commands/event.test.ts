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
