import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import ts from 'typescript';
import { CLIENT_VERSION_HEADER, PLATFORM_UPGRADE_REQUIRED_MESSAGE } from '@kici-dev/engine';
import { DashboardApiErrorCode } from '@kici-dev/engine/protocol/dashboard-api-errors';
import {
  CLI_RELEASE_VERSION,
  ClientNewerThanPlatformError,
  platformFetch,
} from './platform-fetch.js';

const SRC = path.resolve(import.meta.dirname, '..');

afterEach(() => {
  vi.unstubAllGlobals();
});

/** Stubs the global fetch with one answer and returns the mock. */
function stubFetch(response: () => Response = () => new Response('{}', { status: 200 })) {
  const mock = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => response());
  vi.stubGlobal('fetch', mock);
  return mock;
}

function sentHeaders(mock: ReturnType<typeof stubFetch>): Headers {
  return new Headers(mock.mock.calls[0]![1]!.headers);
}

describe('platformFetch', () => {
  // fails-when: a Platform request leaves without the release version, so a Platform cannot
  // refuse a CLI newer than itself
  it('every Platform request carries the client version header', async () => {
    const inits: (RequestInit | undefined)[] = [
      undefined,
      { method: 'GET' },
      { headers: { Authorization: 'Bearer x', 'Content-Type': 'application/json' } },
      { headers: new Headers({ Authorization: 'Bearer x' }) },
      { headers: [['Authorization', 'Bearer x']] },
    ];
    for (const init of inits) {
      const mock = stubFetch();
      await platformFetch('https://platform.test/api/v1/user/orgs', init);
      const headers = sentHeaders(mock);
      expect(headers.get(CLIENT_VERSION_HEADER), JSON.stringify(init)).toBe(CLI_RELEASE_VERSION);
      // breaks-if-wrong: the caller's own headers still go out
      if (init?.headers) expect(headers.get('Authorization')).toBe('Bearer x');
    }
  });

  it('sends a release version', () => {
    expect(CLI_RELEASE_VERSION).toMatch(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/);
  });

  // fails-when: the refusal is returned as an ordinary 409, so the command prints "HTTP 409"
  it('throws the Platform message when it refuses a newer client', async () => {
    stubFetch(
      () =>
        new Response(
          JSON.stringify({
            error: DashboardApiErrorCode.enum.client_newer_than_platform,
            message: PLATFORM_UPGRADE_REQUIRED_MESSAGE,
          }),
          { status: 409, headers: { 'Content-Type': 'application/json' } },
        ),
    );
    const call = platformFetch('https://platform.test/api/v1/user/orgs');
    await expect(call).rejects.toBeInstanceOf(ClientNewerThanPlatformError);
    await expect(platformFetch('https://platform.test/api/v1/x')).rejects.toThrow(
      PLATFORM_UPGRADE_REQUIRED_MESSAGE,
    );
  });

  // breaks-if-wrong: an ordinary conflict, or a body that is not JSON, still reaches the caller
  it('returns any other 409 untouched', async () => {
    for (const body of ['{"error":"conflict","message":"name taken"}', 'not json']) {
      stubFetch(() => new Response(body, { status: 409 }));
      const res = await platformFetch('https://platform.test/api/v1/x');
      expect(res.status).toBe(409);
      expect(await res.text()).toBe(body);
    }
  });
});

/**
 * Global `fetch` references outside platform-fetch.ts, each to a URL that is not a Platform:
 * the file, how many references it holds, and why it bypasses `platformFetch`.
 */
const NON_PLATFORM_FETCHES: ReadonlyMap<string, { count: number; why: string }> = new Map([
  ['commands/drain-worker.ts', { count: 1, why: 'the orchestrator admin API' }],
  ['commands/runs/artifacts/download.ts', { count: 1, why: 'a presigned artifact URL' }],
  ['commands/report/upload.ts', { count: 1, why: 'a presigned bundle upload URL' }],
  ['commands/verify-attestation.ts', { count: 1, why: 'an attestation bundle URL' }],
  ['provenance-trust-root.ts', { count: 1, why: "an orchestrator's provenance issuer" }],
  ['remote/oidc-discovery.ts', { count: 1, why: 'the identity provider discovery document' }],
  ['remote/oauth.ts', { count: 1, why: 'the identity provider endpoints' }],
  ['remote/uploader.ts', { count: 1, why: 'a presigned upload URL' }],
  ['remote/direct-cancel.ts', { count: 1, why: 'the orchestrator admin API' }],
  ['local-plane/plane-trigger.ts', { count: 1, why: 'the local plane orchestrator' }],
  ['local-plane/orchestrator-process.ts', { count: 1, why: 'the local plane orchestrator' }],
  ['local-plane/plane-liveness.ts', { count: 2, why: 'the local plane orchestrator' }],
  ['remote/shipped-git/shipped-git.ts', { count: 2, why: 'a local function that runs git fetch' }],
  [
    'remote/shipped-git/shipped-git-config.ts',
    { count: 1, why: 'a local variable holding a git fetch refspec' },
  ],
]);

/** Every source file under `dir`, test files excluded, relative to {@link SRC}. */
function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const abs = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...sourceFiles(abs));
    else if (/\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name)) {
      out.push(path.relative(SRC, abs).split(path.sep).join('/'));
    }
  }
  return out;
}

/**
 * How many times `source` names the bare identifier `fetch` as a value: a call, a default, a
 * `?? fetch`. A property (`x.fetch`), a key, a declaration name and `typeof fetch` in a type do
 * not count.
 */
function globalFetchReferences(source: string): number {
  const file = ts.createSourceFile('x.ts', source, ts.ScriptTarget.Latest, true);
  let count = 0;
  const visit = (node: ts.Node): void => {
    if (ts.isIdentifier(node) && node.text === 'fetch') {
      const p = node.parent;
      const isName =
        (ts.isPropertyAccessExpression(p) && p.name === node) ||
        ((ts.isPropertyAssignment(p) ||
          ts.isPropertySignature(p) ||
          ts.isMethodDeclaration(p) ||
          ts.isFunctionDeclaration(p) ||
          ts.isVariableDeclaration(p) ||
          ts.isParameter(p) ||
          ts.isBindingElement(p)) &&
          p.name === node) ||
        ts.isTypeQueryNode(p) ||
        ts.isImportSpecifier(p);
      if (!isName) count += 1;
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return count;
}

describe('every Platform request goes through platformFetch', () => {
  it('the scan sees a bare fetch, and only a bare fetch', () => {
    // Positive control: the scan finds the one fetch platform-fetch.ts makes, so it can see a
    // file at all.
    const own = readFileSync(path.join(SRC, 'remote/platform-fetch.ts'), 'utf-8');
    expect(globalFetchReferences(own)).toBeGreaterThan(0);
    expect(
      globalFetchReferences(
        'const r = await fetch(`${config.platformEndpoint}/api/v1/x`);\n' +
          'const f = opts.fetchImpl ?? fetch;\nfunction g(impl: typeof fetch = fetch) {}\n',
      ),
    ).toBe(3);
    expect(
      globalFetchReferences(
        'res.fetch(); const o = { fetch: 1 }; type F = typeof fetch; await platformFetch(u);\n',
      ),
    ).toBe(0);
  });

  // fails-when: a call site keeps a bare fetch to a Platform URL, so that request carries no
  // client version and a Platform cannot refuse the CLI there
  it('no source file outside platform-fetch.ts names the global fetch, except the listed ones', () => {
    const found = new Map<string, number>();
    for (const rel of sourceFiles(SRC)) {
      if (rel === 'remote/platform-fetch.ts') continue;
      const n = globalFetchReferences(readFileSync(path.join(SRC, rel), 'utf-8'));
      if (n > 0) found.set(rel, n);
    }
    expect(Object.fromEntries(found)).toEqual(
      Object.fromEntries([...NON_PLATFORM_FETCHES].map(([file, { count }]) => [file, count])),
    );
  });
});
