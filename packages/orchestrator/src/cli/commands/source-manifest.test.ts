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
    // The POST carries the conversion response's name/slug, not the CLI `--name`.
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

  // fails-when: the abort still blames the Platform connection whatever the cause.
  it('names the missing piece and offers --webhook-url', async () => {
    const get = vi
      .fn()
      .mockResolvedValue({ webhookUrl: null, webhookNote: 'platform-url-unknown' });
    const deps = makeDeps();
    await expect(
      runGithubManifestSetup({ name: 'acme' }, makeClient({ get }) as never, deps),
    ).rejects.toThrow(/did not send its GitHub webhook URL[\s\S]*--webhook-url/);
    expect(deps.startLoopback).not.toHaveBeenCalled();
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

  /** The URL line `--no-browser` prints, and the manifest its fragment carries. */
  function printedSetupUrl(): {
    url: string;
    manifest: Record<string, unknown>;
    createUrl: string;
  } {
    const line = logSpy.mock.calls
      .flat()
      .map(String)
      .find((l: string) => l.includes('#m='));
    expect(line).toBeDefined();
    const url = line!.trim();
    const fragment = new URLSearchParams(url.slice(url.indexOf('#') + 1));
    return {
      url,
      manifest: JSON.parse(Buffer.from(fragment.get('m')!, 'base64url').toString('utf-8')),
      createUrl: fragment.get('createUrl')!,
    };
  }

  it("--no-browser prints the Platform's page when the orchestrator reports one", async () => {
    const page = 'http://127.0.0.1:14460/github/manifest-callback';
    const get = vi.fn((path: string) =>
      Promise.resolve(
        path === '/api/v1/admin/sources/github-webhook-url'
          ? { webhookUrl: 'http://127.0.0.1:14460/webhook/org_x/github', manifestCallbackUrl: page }
          : {},
      ),
    );
    await runGithubManifestSetup(
      { name: 'acme', noBrowser: true },
      makeClient({ get }) as never,
      makeDeps(),
    );
    const { url, manifest } = printedSetupUrl();
    // fails-when: the advertised page is ignored and the kici.dev page is printed
    expect(url.startsWith(`${page}#m=`)).toBe(true);
    expect(manifest.redirect_url).toBe(page);
    const printed = logSpy.mock.calls.flat().join('\n');
    expect(printed).not.toContain('kici.dev/gh-manifest-callback');
  });

  it('--no-browser falls back to the kici.dev page when none is reported', async () => {
    await runGithubManifestSetup(
      { name: 'acme', noBrowser: true },
      makeClient() as never,
      makeDeps(),
    );
    const { url, manifest } = printedSetupUrl();
    // breaks-if-wrong: hosted operators keep today's page
    expect(url.startsWith('https://kici.dev/gh-manifest-callback#m=')).toBe(true);
    expect(manifest.redirect_url).toBe('https://kici.dev/gh-manifest-callback');
  });

  it('the loopback mode ignores the reported page', async () => {
    const get = vi.fn().mockResolvedValue({
      webhookUrl: 'https://kici.corp.example/webhook/o/github',
      manifestCallbackUrl: 'https://kici.corp.example/github/manifest-callback',
    });
    const deps = makeDeps();
    await runGithubManifestSetup({ name: 'acme' }, makeClient({ get }) as never, deps);
    // breaks-if-wrong: the browser flow keeps its loopback redirect
    const served = vi.mocked(deps.startLoopback).mock.calls[1]?.[0] as { manifestJson: string };
    expect(JSON.parse(served.manifestJson).redirect_url).toBe('http://127.0.0.1:1/cb');
  });

  it('--github-url builds the server create URL and converts there', async () => {
    const deps = makeDeps();
    await runGithubManifestSetup(
      { name: 'acme', noBrowser: true, githubUrl: 'https://ghe.corp.example' },
      makeClient() as never,
      deps,
    );
    // fails-when: --github-url stops reaching manifestCreateUrl or the conversion
    expect(printedSetupUrl().createUrl).toBe('https://ghe.corp.example/settings/apps/new');
    expect(deps.convert).toHaveBeenCalledWith('pasted-code', {
      githubUrl: 'https://ghe.corp.example',
    });
  });

  it('--github-url with --github-org targets the server org create URL (loopback)', async () => {
    const deps = makeDeps();
    await runGithubManifestSetup(
      { name: 'acme', githubOrg: 'acme', githubUrl: 'https://ghe.corp.example' },
      makeClient() as never,
      deps,
    );
    expect(deps.startLoopback).toHaveBeenCalledWith(
      expect.objectContaining({
        createUrl: 'https://ghe.corp.example/organizations/acme/settings/apps/new',
      }),
    );
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

  it('uses --webhook-url verbatim instead of the URL the orchestrator resolves for its mode', async () => {
    const get = vi.fn().mockResolvedValue({
      webhookUrl: 'https://api.kici.dev/webhook/o/github',
    });
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

    // The loopback flow uses neither the pre-flight's webhook URL (the explicit one
    // wins) nor its manifest page, so it never reads it.
    // fails-when: the pre-flight read moves back before the --no-browser branch
    expect(
      get.mock.calls.filter(([p]) => p === '/api/v1/admin/sources/github-webhook-url'),
    ).toHaveLength(0);
    const secondCall = startLoopback.mock.calls[1]?.[0] as { manifestJson: string };
    expect(JSON.parse(secondCall.manifestJson).hook_attributes.url).toBe(
      'https://my.org/kici-hook',
    );
  });

  it('--webhook-url with --no-browser still reads the callback URL, once', async () => {
    const page = 'https://kici.corp.example/github/manifest-callback';
    const get = vi.fn().mockResolvedValue({ webhookUrl: null, manifestCallbackUrl: page });
    await runGithubManifestSetup(
      { name: 'acme', noBrowser: true, webhookUrl: 'https://my.org/kici-hook' },
      makeClient({ get }) as never,
      makeDeps(),
    );
    // breaks-if-wrong: --no-browser prints the reported page, so it must still read it
    expect(
      get.mock.calls.filter(([p]) => p === '/api/v1/admin/sources/github-webhook-url'),
    ).toHaveLength(1);
    const { url, manifest } = printedSetupUrl();
    expect(url.startsWith(`${page}#m=`)).toBe(true);
    expect((manifest.hook_attributes as { url: string }).url).toBe('https://my.org/kici-hook');
  });

  it.each([
    // breaks-if-wrong: --webhook-url against an orchestrator without the pre-flight
    //   route must still proceed, silently.
    [new Error('HTTP 404'), null],
    [new Error('HTTP 500: boom'), 'HTTP 500: boom'],
    [
      new Error('cannot reach the orchestrator admin API'),
      'cannot reach the orchestrator admin API',
    ],
  ])('--webhook-url proceeds when the pre-flight cannot be read (%s)', async (err, noted) => {
    const get = vi.fn((path: string) =>
      path === '/api/v1/admin/sources/github-webhook-url'
        ? Promise.reject(err)
        : Promise.resolve({}),
    );
    const deps = makeDeps();
    await runGithubManifestSetup(
      { name: 'acme', noBrowser: true, webhookUrl: 'https://my.org/kici-hook' },
      makeClient({ get }) as never,
      deps,
    );
    expect(printedSetupUrl().url.startsWith('https://kici.dev/gh-manifest-callback#m=')).toBe(true);
    expect(deps.convert).toHaveBeenCalled();
    const stderr = errSpy.mock.calls.flat().join('\n');
    // fails-when: a failure other than a 4xx falls back to the default page silently
    if (noted) {
      expect(stderr).toContain(
        `Note: could not read the manifest pre-flight (${noted}); using the default page`,
      );
    } else {
      expect(stderr).not.toContain('Note:');
    }
  });

  /** A pre-flight reporting `manifestCallbackUrl` next to a resolvable webhook URL. */
  function reportingPage(page: string) {
    return vi.fn((path: string) =>
      Promise.resolve(
        path === '/api/v1/admin/sources/github-webhook-url'
          ? { webhookUrl: 'https://kici.corp.example/webhook/o/github', manifestCallbackUrl: page }
          : {},
      ),
    );
  }

  it.each([
    'javascript:alert(1)',
    'ftp://kici.corp.example/github/manifest-callback',
    'https://user:pw@kici.corp.example/github/manifest-callback',
    'https://kici.corp.example/github/manifest-callback#x',
    'https://kici.corp.example/github/manifest-callback\nX',
    'not a url',
  ])('refuses a reported manifest page %j before creating anything', async (page) => {
    const deps = makeDeps();
    // fails-when: the reported value is printed and baked into redirect_url unchecked
    await expect(
      runGithubManifestSetup(
        { name: 'acme', noBrowser: true },
        makeClient({ get: reportingPage(page) }) as never,
        deps,
      ),
    ).rejects.toThrow(/unusable manifest page URL/);
    expect(deps.startLoopback).not.toHaveBeenCalled();
    expect(deps.readLine).not.toHaveBeenCalled();
    expect(logSpy.mock.calls.flat().join('\n')).not.toContain('#m=');
  });

  it('accepts an https manifest page with a base path verbatim', async () => {
    const page = 'https://ci.corp.example/kici/github/manifest-callback';
    await runGithubManifestSetup(
      { name: 'acme', noBrowser: true },
      makeClient({ get: reportingPage(page) }) as never,
      makeDeps(),
    );
    // breaks-if-wrong: a valid reported page under a base path is printed as reported
    expect(printedSetupUrl().url.startsWith(`${page}#m=`)).toBe(true);
  });

  it('the loopback mode does not read the reported page at all', async () => {
    const deps = makeDeps();
    await runGithubManifestSetup(
      { name: 'acme' },
      makeClient({ get: reportingPage('javascript:alert(1)') }) as never,
      deps,
    );
    // breaks-if-wrong: the browser flow never prints or bakes the page, so a value it
    //   does not use must not stop it
    expect(deps.convert).toHaveBeenCalledWith('c');
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

describe('runGithubManifestSetup on GitHub Enterprise Server', () => {
  const GHES = 'https://ghe.corp.example';

  /** The body of the `POST /api/v1/admin/sources` call. */
  const postedBody = (client: ReturnType<typeof makeClient>) =>
    (client.post as ReturnType<typeof vi.fn>).mock.calls[0]![1] as Record<string, unknown>;

  it('stores the server with the new App', async () => {
    const client = makeClient();
    await runGithubManifestSetup({ name: 'acme', githubUrl: GHES }, client as never, makeDeps());
    // fails-when: the manifest flow stores a GHES App as a github.com source
    expect(postedBody(client)).toMatchObject({ appId: '12345', githubUrl: GHES });

    const plain = makeClient();
    await runGithubManifestSetup({ name: 'acme' }, plain as never, makeDeps());
    // breaks-if-wrong: github.com setups post today's body
    expect(postedBody(plain)).not.toHaveProperty('githubUrl');
    const explicit = makeClient();
    await runGithubManifestSetup(
      { name: 'acme', githubUrl: 'https://github.com' },
      explicit as never,
      makeDeps(),
    );
    expect(postedBody(explicit)).not.toHaveProperty('githubUrl');
  });

  it("prints the server's install page", async () => {
    await runGithubManifestSetup(
      { name: 'acme', githubUrl: GHES },
      makeClient() as never,
      makeDeps(),
    );
    // fails-when: the install link still points at github.com for a server's App
    expect(logSpy.mock.calls.flat().join('\n')).toContain(
      'https://ghe.corp.example/github-apps/acme/installations/new',
    );

    logSpy.mockClear();
    const deps = makeDeps();
    await runGithubManifestSetup({ name: 'acme' }, makeClient() as never, deps);
    // breaks-if-wrong: github.com setups keep the github.com install page, opened in the browser
    expect(logSpy.mock.calls.flat().join('\n')).toContain(
      'https://github.com/apps/acme/installations/new',
    );
    expect(deps.openBrowser).toHaveBeenCalledWith('https://github.com/apps/acme/installations/new');
  });

  it('waits for the installation and verifies access on the server', async () => {
    const deps = makeDeps();
    await runGithubManifestSetup({ name: 'acme', githubUrl: GHES }, makeClient() as never, deps);
    // fails-when: the install wait or the access check asks api.github.com for a server's App
    expect(deps.waitForInstallation).toHaveBeenCalledWith(
      expect.objectContaining({ appId: '12345', privateKey: 'pem', githubUrl: GHES }),
      expect.anything(),
    );
    expect(deps.verifyRepoAccess).toHaveBeenCalledWith(
      expect.objectContaining({ appId: '12345', githubUrl: GHES }),
      9,
    );

    const plain = makeDeps();
    await runGithubManifestSetup({ name: 'acme' }, makeClient() as never, plain);
    // breaks-if-wrong: github.com setups pass credentials with no server
    expect(vi.mocked(plain.waitForInstallation).mock.calls[0]![0]).not.toHaveProperty('githubUrl');
  });

  it('the recovery hint repeats --github-url', async () => {
    const post = vi.fn().mockRejectedValue(new Error('store failed'));
    await expect(
      runGithubManifestSetup(
        { name: 'acme', githubUrl: GHES },
        makeClient({ post }) as never,
        makeDeps(),
      ),
    ).rejects.toThrow(/store failed/);
    const hint = errSpy.mock.calls
      .flat()
      .map(String)
      .find((l: string) => l.includes('kici-admin source add github'));
    // fails-when: the recovery command re-adds a server's App as a github.com source
    expect(hint).toContain(`--github-url ${GHES}`);

    errSpy.mockClear();
    await expect(
      runGithubManifestSetup({ name: 'acme' }, makeClient({ post }) as never, makeDeps()),
    ).rejects.toThrow(/store failed/);
    // breaks-if-wrong: the github.com recovery command stays as it was
    expect(errSpy.mock.calls.flat().join('\n')).not.toContain('--github-url');
  });
});

describe('runGithubManifestSetup source org', () => {
  const attachedGet = (path: string) =>
    Promise.resolve(
      path === '/api/v1/admin/sources'
        ? { platformAttachment: 'attached', attachedOrgId: 'org_A', sources: [] }
        : { webhookUrl: 'https://api.kici.dev/webhook/o/github' },
    );

  it('refuses an org other than the attached one before creating the App', async () => {
    // fails-when: the org is only checked by the store route, after the App exists.
    const deps = makeDeps();
    await expect(
      runGithubManifestSetup(
        { name: 'acme', customerId: 'org_B' },
        makeClient({ get: vi.fn(attachedGet) }) as never,
        deps,
      ),
    ).rejects.toThrow(/does not match this orchestrator's Platform organization "org_A"/);
    expect(deps.startLoopback).not.toHaveBeenCalled();
    expect(deps.convert).not.toHaveBeenCalled();
  });

  it('refuses a pending attachment with no --org before creating the App', async () => {
    const get = vi.fn((path: string) =>
      Promise.resolve(
        path === '/api/v1/admin/sources'
          ? { platformAttachment: 'pending', attachedOrgId: null, sources: [] }
          : { webhookUrl: 'https://api.kici.dev/webhook/o/github' },
      ),
    );
    const deps = makeDeps();
    await expect(
      runGithubManifestSetup({ name: 'acme' }, makeClient({ get }) as never, deps),
    ).rejects.toThrow(/not authenticated with the Platform yet/);
    expect(deps.startLoopback).not.toHaveBeenCalled();
  });

  it('posts the requested org', async () => {
    const client = makeClient({ get: vi.fn(attachedGet) });
    await runGithubManifestSetup(
      { name: 'acme', customerId: 'org_A' },
      client as never,
      makeDeps(),
    );
    expect(client.post).toHaveBeenCalledWith(
      '/api/v1/admin/sources',
      expect.objectContaining({ customerId: 'org_A' }),
    );
  });

  it('proceeds against an orchestrator that does not report its attachment', async () => {
    // breaks-if-wrong: an older orchestrator still runs the flow.
    const deps = makeDeps();
    await runGithubManifestSetup(
      { name: 'acme', customerId: 'org_B' },
      makeClient() as never,
      deps,
    );
    expect(deps.convert).toHaveBeenCalled();
  });
});
