import { describe, it, expect, vi, afterEach } from 'vitest';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startCredentialHelperHost, shimSource } from './credential-helper-host.js';

/** Spawn the shim exactly as git does: argv[0] is the op, the query is stdin. */
function run(bin: string, op: string, input: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, [op], { stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (d) => {
      out += d;
    });
    child.on('error', reject);
    child.on('close', () => resolve(out));
    child.stdin.end(input);
  });
}
const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const c of cleanups.splice(0)) await c();
});

async function host(answer: Parameters<typeof startCredentialHelperHost>[0]['answer']) {
  const dir = await mkdtemp(join(tmpdir(), 'kici-helper-test-'));
  const h = await startCredentialHelperHost({ dir, answer });
  cleanups.push(async () => {
    await h.close();
    await rm(dir, { recursive: true, force: true });
  });
  return h;
}

const GIT_INPUT = 'protocol=https\nhost=github.com\npath=kici-dev/tester.git\n\n';

describe('startCredentialHelperHost', () => {
  it('answers a real git credential `get` through the shim', async () => {
    const answer = vi.fn().mockResolvedValue({ username: 'x-access-token', password: 'ghs_x' });
    const h = await host(answer);

    // Spawn the shim exactly as git would.
    const stdout = await run(h.helperPath, 'get', GIT_INPUT);

    expect(stdout).toBe('username=x-access-token\npassword=ghs_x\n');
    expect(answer).toHaveBeenCalledWith({
      protocol: 'https',
      host: 'github.com',
      path: 'kici-dev/tester.git',
    });
  });

  it('writes the shim executable and owner-only', async () => {
    const h = await host(async () => null);
    const info = await stat(h.helperPath);
    // 0o700: git must be able to exec it; nothing else on the box should read it.
    expect(info.mode & 0o777).toBe(0o700);
  });

  it('returns an empty reply when there is no credential, so git falls through', async () => {
    const h = await host(async () => null);
    const stdout = await run(h.helperPath, 'get', GIT_INPUT);
    expect(stdout).toBe('');
  });

  it('is a silent no-op for store and erase', async () => {
    const answer = vi.fn();
    const h = await host(answer);
    for (const op of ['store', 'erase']) {
      const stdout = await run(h.helperPath, op, GIT_INPUT);
      expect(stdout).toBe('');
    }
    expect(answer).not.toHaveBeenCalled();
  });

  it('does not leak the resolver error to git', async () => {
    const h = await host(async () => {
      throw new Error('boom ghs_supersecrettokenvalue0001');
    });
    const stdout = await run(h.helperPath, 'get', GIT_INPUT);
    expect(stdout).toBe('');
    expect(stdout).not.toContain('ghs_');
  });

  it('exits cleanly when the socket is gone, rather than hanging a push', async () => {
    const h = await host(async () => ({ username: 'u', password: 'p' }));
    await h.close();
    const stdout = await run(h.helperPath, 'get', GIT_INPUT);
    expect(stdout).toBe('');
  });

  it('writes no secret into the shim itself', async () => {
    const h = await host(async () => ({ username: 'u', password: 'ghs_secret' }));
    const source = await readFile(h.helperPath, 'utf-8');
    expect(source).not.toContain('ghs_secret');
  });

  it('flushes a large reply rather than truncating it on exit', async () => {
    // process.exit() after a pipe write drops pending bytes. A short token can
    // fit in the pipe buffer and mask that; a long one cannot.
    const password = 'ghs_' + 'x'.repeat(60_000);
    const h = await host(async () => ({ username: 'x-access-token', password }));
    const stdout = await run(h.helperPath, 'get', GIT_INPUT);
    expect(stdout).toBe(`username=x-access-token\npassword=${password}\n`);
  });

  it('serves several sequential requests on one socket', async () => {
    // git invokes the helper once per network operation, so the server must
    // outlive a single connection.
    const h = await host(async () => ({ username: 'u', password: 'p' }));
    for (let i = 0; i < 3; i += 1) {
      expect(await run(h.helperPath, 'get', GIT_INPUT)).toBe('username=u\npassword=p\n');
    }
  });
});

describe('shimSource', () => {
  it('embeds the socket path as a literal, not by interpolation into code', () => {
    const src = shimSource("/tmp/we'ird/git-credential.sock");
    // A naive template would break on the quote; JSON.stringify keeps it valid.
    expect(src).toContain(JSON.stringify("/tmp/we'ird/git-credential.sock"));
  });
});
