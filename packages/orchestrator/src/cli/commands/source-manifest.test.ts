import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { runGithubManifestSetup, type ManifestSetupDeps } from './source-manifest.js';

function makeClient(over?: { get?: unknown; post?: unknown }) {
  return {
    get:
      over?.get ??
      vi.fn().mockResolvedValue({ webhookUrl: 'https://api.kici.dev/webhook/o/github' }),
    post: over?.post ?? vi.fn().mockResolvedValue({ routingKey: 'github:12345', name: 'acme' }),
  };
}

function makeDeps(over?: Partial<ManifestSetupDeps>): ManifestSetupDeps {
  return {
    startLoopback: vi.fn().mockResolvedValue({
      formUrl: 'http://127.0.0.1:1/',
      redirectUrl: 'http://127.0.0.1:1/cb',
      waitForCode: vi.fn().mockResolvedValue({ code: 'c', state: 's' }),
      close: vi.fn(),
    }),
    openBrowser: vi.fn(),
    readLine: vi.fn().mockResolvedValue('pasted-code'),
    convert: vi.fn().mockResolvedValue({
      appId: '12345',
      slug: 'acme',
      name: 'Acme Prod',
      privateKey: 'pem',
      webhookSecret: 'w',
      htmlUrl: 'https://github.com/apps/acme',
    }),
    waitForInstallation: vi.fn().mockResolvedValue({ installationId: 9, accountLogin: 'acme' }),
    verifyRepoAccess: vi.fn().mockResolvedValue({ repoCount: 2 }),
    writeRecoveryFile: vi.fn().mockReturnValue('/tmp/kici-gh-pem/key.pem'),
    ...over,
  };
}

let logSpy: ReturnType<typeof vi.spyOn>;
let errSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => {
  logSpy.mockRestore();
  errSpy.mockRestore();
});

describe('runGithubManifestSetup', () => {
  it('runs the happy path (loopback) with stubbed deps', async () => {
    const client = makeClient();
    const deps = makeDeps();
    await runGithubManifestSetup({ name: 'acme' }, client as never, deps);

    expect(deps.startLoopback).toHaveBeenCalled();
    expect(deps.openBrowser).toHaveBeenCalledWith('http://127.0.0.1:1/');
    expect(deps.convert).toHaveBeenCalledWith('c');
    // GitHub is the source of truth for the stored name + slug, so the POST
    // body carries the conversion response's name/slug, not the CLI `--name`.
    expect(client.post).toHaveBeenCalledWith(
      '/api/v1/admin/sources',
      expect.objectContaining({
        provider: 'github',
        name: 'Acme Prod',
        slug: 'acme',
        appId: '12345',
        privateKey: 'pem',
        webhookSecret: 'w',
      }),
    );
    expect(deps.waitForInstallation).toHaveBeenCalled();
    expect(deps.verifyRepoAccess).toHaveBeenCalledWith(
      expect.objectContaining({ appId: '12345' }),
      9,
    );
  });

  it('aborts before creating an app when the webhook url is not resolvable', async () => {
    const get = vi
      .fn()
      .mockResolvedValue({ webhookUrl: null, webhookNote: 'platform-no-public-url' });
    const client = makeClient({ get });
    const deps = makeDeps();
    await expect(runGithubManifestSetup({ name: 'acme' }, client as never, deps)).rejects.toThrow(
      /webhook url/i,
    );
    // No App was created.
    expect(deps.startLoopback).not.toHaveBeenCalled();
    expect(deps.convert).not.toHaveBeenCalled();
  });

  it('uses the paste-code path in --no-browser mode', async () => {
    const client = makeClient();
    const deps = makeDeps();
    await runGithubManifestSetup({ name: 'acme', noBrowser: true }, client as never, deps);
    // The static-site URL is printed, the code is read from stdin, and the
    // loopback is NOT used to wait for a callback.
    expect(deps.readLine).toHaveBeenCalled();
    expect(deps.convert).toHaveBeenCalledWith('pasted-code');
    const printed = logSpy.mock.calls.flat().join('\n');
    expect(printed).toContain('kici.dev/gh-manifest-callback');
  });

  it('surfaces credentials when storage fails after conversion (orphan-app safety)', async () => {
    const post = vi.fn().mockRejectedValue(new Error('store failed'));
    const client = makeClient({ post });
    const deps = makeDeps({
      convert: vi.fn().mockResolvedValue({
        appId: '777',
        slug: 'acme',
        privateKey: 'PEMDATA',
        webhookSecret: 'w',
      }),
    });
    await expect(runGithubManifestSetup({ name: 'acme' }, client as never, deps)).rejects.toThrow(
      /store failed/,
    );
    expect(deps.writeRecoveryFile).toHaveBeenCalledWith('777', 'PEMDATA');
    const printed = errSpy.mock.calls.flat().join('\n');
    expect(printed).toContain('777');
    expect(printed).toMatch(/source add github/);
  });

  it('targets an org create endpoint when --github-org is set', async () => {
    const client = makeClient();
    const deps = makeDeps();
    await runGithubManifestSetup({ name: 'acme', githubOrg: 'acme-inc' }, client as never, deps);
    expect(deps.startLoopback).toHaveBeenCalledWith(
      expect.objectContaining({
        createUrl: 'https://github.com/organizations/acme-inc/settings/apps/new',
      }),
    );
  });

  it('uses --webhook-url verbatim and skips platform-mode URL resolution', async () => {
    const get = vi.fn(); // pre-flight resolver must NOT be called
    const startLoopback = vi.fn().mockResolvedValue({
      formUrl: 'http://127.0.0.1:1/',
      redirectUrl: 'http://127.0.0.1:1/cb',
      waitForCode: vi.fn().mockResolvedValue({ code: 'c', state: 's' }),
      close: vi.fn(),
    });
    const client = makeClient({ get });
    const deps = makeDeps({ startLoopback });

    await runGithubManifestSetup(
      { name: 'acme', webhookUrl: 'https://my.org/kici-hook' },
      client as never,
      deps,
    );

    // The platform-mode pre-flight GET was bypassed entirely.
    expect(get).not.toHaveBeenCalled();
    // The override URL is baked into the served manifest verbatim.
    const secondCall = startLoopback.mock.calls[1]?.[0] as { manifestJson: string };
    expect(secondCall.manifestJson).toContain('https://my.org/kici-hook');
  });

  it('rejects a non-https --webhook-url before creating anything', async () => {
    const client = makeClient();
    const deps = makeDeps();
    await expect(
      runGithubManifestSetup(
        { name: 'acme', webhookUrl: 'http://my.org/hook' },
        client as never,
        deps,
      ),
    ).rejects.toThrow(/https/i);
    expect(deps.convert).not.toHaveBeenCalled();
  });
});
