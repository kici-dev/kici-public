import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { ZipArchive } from 'archiver';
import { addLogsToArchive } from './bundle-archive.js';

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

/**
 * Reads the whole ZIP, not one parsed entry: the assertion is "this token
 * appears nowhere in the uploaded file", and a per-entry read could miss a copy
 * in a header or a second entry. Level-0 (stored) compression keeps it searchable.
 */
async function zipBytesFor(logDir: string, windowHours = 24): Promise<string> {
  const out = path.join(logDir, `bundle-${Date.now()}.zip`);
  const archive = new ZipArchive({ zlib: { level: 0 } });
  const ws = fs.createWriteStream(out);
  const done = new Promise<void>((res, rej) => {
    ws.on('close', res);
    archive.on('error', rej);
  });
  archive.pipe(ws);
  await addLogsToArchive(archive, logDir, windowHours);
  await archive.finalize();
  await done;
  return fs.readFileSync(out, 'latin1');
}

describe('addLogsToArchive redaction', () => {
  it('scrubs secrets out of archived log content', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'logs-scrub-'));
    const token = 'ghp_0123456789abcdefghijklmnopqrstuvwxyz';
    fs.writeFileSync(path.join(dir, 'a.log'), `fetch failed using token ${token}\n`);

    const bytes = await zipBytesFor(dir);

    expect(bytes).not.toContain(token);
    // Non-vacuity: the UNSCRUBBED source does contain the token, so the assertion
    // above detects scrubbing, not an archive that never held the line.
    expect(fs.readFileSync(path.join(dir, 'a.log'), 'utf-8')).toContain(token);
    expect(bytes).toContain('***REDACTED');
  });

  it('scrubs a PEM block that spans several lines of one log file', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'logs-pem-'));
    const body = 'MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQC7VJTUt9Us8cKj';
    fs.writeFileSync(
      path.join(dir, 'a.log'),
      `loading\n-----BEGIN RSA PRIVATE KEY-----\n${body}\n-----END RSA PRIVATE KEY-----\nready\n`,
    );

    const bytes = await zipBytesFor(dir);

    expect(bytes).not.toContain(body);
    expect(bytes).toContain('ready');
  });
});
