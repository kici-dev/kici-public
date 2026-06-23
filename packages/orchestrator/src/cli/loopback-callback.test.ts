import { describe, it, expect, afterEach } from 'vitest';
import { startManifestLoopback } from './loopback-callback.js';

let lb: Awaited<ReturnType<typeof startManifestLoopback>> | undefined;
afterEach(() => lb?.close());

describe('startManifestLoopback', () => {
  it('serves the manifest form at the form url', async () => {
    lb = await startManifestLoopback({
      state: 's',
      manifestJson: '{"name":"x"}',
      createUrl: 'https://github.com/settings/apps/new',
    });
    const html = await (await fetch(lb.formUrl)).text();
    expect(html).toContain('name="manifest"');
  });

  it('resolves waitForCode when the redirect is hit', async () => {
    lb = await startManifestLoopback({
      state: 's',
      manifestJson: '{}',
      createUrl: 'https://github.com/settings/apps/new',
    });
    const assertion = expect(lb.waitForCode(5_000)).resolves.toEqual({ code: 'tmp', state: 's' });
    await fetch(`${lb.redirectUrl}?code=tmp&state=s`);
    await assertion;
  });

  it('rejects a state mismatch (CSRF guard)', async () => {
    lb = await startManifestLoopback({
      state: 's',
      manifestJson: '{}',
      createUrl: 'https://github.com/settings/apps/new',
    });
    // Attach the rejection handler before firing the request so the rejection
    // never sits unhandled in the microtask window between request + await.
    const assertion = expect(lb.waitForCode(5_000)).rejects.toThrow(/state/i);
    await fetch(`${lb.redirectUrl}?code=tmp&state=WRONG`);
    await assertion;
  });

  it('times out when no callback arrives', async () => {
    lb = await startManifestLoopback({
      state: 's',
      manifestJson: '{}',
      createUrl: 'https://github.com/settings/apps/new',
    });
    await expect(lb.waitForCode(20)).rejects.toThrow(/timed out/i);
  });
});
