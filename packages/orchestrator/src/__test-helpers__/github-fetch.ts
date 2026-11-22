/**
 * A stub for the global `fetch` a real Octokit uses, so a test drives the real
 * client, its App auth strategy and its base URL, and asserts the request URLs
 * GitHub would have received.
 */
import { generateKeyPairSync } from 'node:crypto';
import { vi } from 'vitest';

/** A real RSA key, so the App auth strategy can sign its JWT. */
export const TEST_APP_PRIVATE_KEY = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  publicKeyEncoding: { type: 'spki', format: 'pem' },
}).privateKey;

/** One request the stubbed fetch received. */
export interface RecordedGithubRequest {
  method: string;
  url: string;
  /** The Authorization scheme: `bearer` for an App JWT, `token` for an installation token. */
  auth: string | null;
}

/** A canned answer for a request, or undefined for the default. */
type Responder = (req: RecordedGithubRequest) => { status: number; body: unknown } | undefined;

/** The default answer for the App-level and token routes the orchestrator calls. */
function defaultAnswer(req: RecordedGithubRequest): { status: number; body: unknown } {
  const path = new URL(req.url).pathname;
  if (req.method === 'POST' && path.endsWith('/access_tokens')) {
    return {
      status: 201,
      body: { token: 'ghs_test', expires_at: '2026-11-03T12:00:00Z', permissions: {} },
    };
  }
  if (path.endsWith('/app')) {
    return {
      status: 200,
      body: { id: 1, name: 'KiCI', slug: 'kici', events: [], permissions: {} },
    };
  }
  if (path.endsWith('/installation/repositories')) {
    return { status: 200, body: { total_count: 1, repositories: [] } };
  }
  return { status: 200, body: [] };
}

/**
 * Replace the global `fetch` with a recorder. `respond` overrides the answer
 * for the requests it returns a value for. Undo with `vi.unstubAllGlobals()`.
 */
export function stubGithubFetch(respond: Responder = () => undefined): RecordedGithubRequest[] {
  const requests: RecordedGithubRequest[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      const authorization = headers.get('authorization');
      const req: RecordedGithubRequest = {
        method: (init?.method ?? 'GET').toUpperCase(),
        url: typeof input === 'string' ? input : input.toString(),
        auth: authorization === null ? null : authorization.split(' ')[0]!.toLowerCase(),
      };
      requests.push(req);
      const { status, body } = respond(req) ?? defaultAnswer(req);
      return new Response(JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/json' },
      });
    }),
  );
  return requests;
}
