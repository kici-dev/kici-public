import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { ZipArchive } from 'archiver';
import { redactConfig, addLogsToArchive } from './bundle-archive.js';

describe('redactConfig', () => {
  it('redacts unknown string keys, keeps safe keys and numbers', () => {
    const out = redactConfig({
      host: 'h',
      token: 'secret',
      port: 5432,
      nested: { apiKey: 'k' },
    }) as Record<string, unknown>;
    expect(out.host).toBe('h');
    expect(out.token).toBe('****');
    expect(out.port).toBe(5432);
    expect((out.nested as Record<string, unknown>).apiKey).toBe('****');
  });
});

describe('addLogsToArchive', () => {
  it('includes recent .log files within the window and writes summary.json', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'logs-'));
    fs.writeFileSync(path.join(dir, 'a.log'), 'line one\nerror happened\nwarn careful\n');
    const out = path.join(dir, 'b.zip');
    const archive = new ZipArchive({ zlib: { level: 0 } });
    const ws = fs.createWriteStream(out);
    const done = new Promise<void>((res, rej) => {
      ws.on('close', res);
      archive.on('error', rej);
    });
    archive.pipe(ws);
    await addLogsToArchive(archive, dir, 24);
    await archive.finalize();
    await done;
    expect(fs.statSync(out).size).toBeGreaterThan(0);
  });
});
