/**
 * Where `kici run remote` (and `kici types`) send a run: straight to an
 * orchestrator, or through the KiCI Platform.
 *
 * Precedence, first match wins:
 *   1. `--orchestrator-url` (token from `KICI_ORCHESTRATOR_TOKEN`, else the
 *      saved direct target when it names the same orchestrator).
 *   2. `KICI_ORCHESTRATOR_TOKEN`, with `KICI_ORCHESTRATOR_URL` or the saved
 *      direct URL.
 *   3. The direct target saved by `kici connect`.
 *   4. The Platform login saved by `kici login`.
 *
 * `KICI_ORCHESTRATOR_URL` alone never selects a direct target. The agent and
 * the orchestrator read that variable as their own socket address, so a host
 * or container that runs one often has it set, and a `kici` command there
 * would otherwise switch transport without asking. An empty variable counts as
 * unset.
 */
import type { GlobalConfig } from './config.js';

export type RunTarget =
  | { kind: 'direct'; url: string; token: string; source: 'flag' | 'env' | 'saved' }
  | { kind: 'platform'; endpoint: string; pat: string; source: 'platform-login' };

export type RunTargetResolution = { ok: true; target: RunTarget } | { ok: false; error: string };

export const NO_RUN_TARGET_MESSAGE =
  'No run target is configured. Run `kici connect <url>` to send runs straight to an ' +
  'orchestrator, or `kici login` to send them through the KiCI Platform.';

/**
 * Normalize an orchestrator URL to the HTTP base its API is served under:
 * no trailing slash, and an agent-style `ws(s)://…/ws` socket URL mapped to
 * its `http(s)://` server (the agent socket and the HTTP API share one
 * server). A base path is kept.
 *
 * @throws When the URL does not parse or its scheme is not http(s) or ws(s).
 */
export function normalizeOrchestratorUrl(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    throw new Error(`"${raw}" is not a valid orchestrator URL.`);
  }
  const scheme = SCHEME_MAP[url.protocol];
  if (!scheme) {
    throw new Error(`"${raw}" is not an orchestrator URL: use an http:// or https:// address.`);
  }
  const wasSocket = url.protocol === 'ws:' || url.protocol === 'wss:';
  let pathname = url.pathname.replace(/\/+$/, '');
  if (wasSocket && pathname.endsWith('/ws')) pathname = pathname.slice(0, -'/ws'.length);
  return `${scheme}//${url.host}${pathname}`;
}

const SCHEME_MAP: Record<string, string> = {
  'http:': 'http:',
  'https:': 'https:',
  'ws:': 'http:',
  'wss:': 'https:',
};

/** Read an env var, treating an empty string as unset. */
function envValue(env: NodeJS.ProcessEnv, key: string): string | undefined {
  const value = env[key];
  return value ? value : undefined;
}

/**
 * Resolve the run target from a `--orchestrator-url` flag, the environment and
 * the saved config.
 */
export function resolveRunTarget(input: {
  flagUrl?: string;
  env: NodeJS.ProcessEnv;
  config: GlobalConfig;
}): RunTargetResolution {
  const { flagUrl, env, config } = input;
  const envUrl = envValue(env, 'KICI_ORCHESTRATOR_URL');
  const envToken = envValue(env, 'KICI_ORCHESTRATOR_TOKEN');
  const saved = config.direct;

  try {
    if (flagUrl) {
      const url = normalizeOrchestratorUrl(flagUrl);
      const savedToken =
        saved && normalizeOrchestratorUrl(saved.url) === url ? saved.token : undefined;
      const token = envToken ?? savedToken;
      if (!token) {
        return {
          ok: false,
          error: `No token for ${url}: set KICI_ORCHESTRATOR_TOKEN, or run \`kici connect ${url}\`.`,
        };
      }
      return { ok: true, target: { kind: 'direct', url, token, source: 'flag' } };
    }
    if (envToken && (envUrl || saved)) {
      const url = normalizeOrchestratorUrl(envUrl ?? saved!.url);
      return { ok: true, target: { kind: 'direct', url, token: envToken, source: 'env' } };
    }
    if (saved) {
      return {
        ok: true,
        target: {
          kind: 'direct',
          url: normalizeOrchestratorUrl(saved.url),
          token: saved.token,
          source: 'saved',
        },
      };
    }
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
  if (config.pat && config.platformEndpoint) {
    return {
      ok: true,
      target: {
        kind: 'platform',
        endpoint: config.platformEndpoint,
        pat: config.pat,
        source: 'platform-login',
      },
    };
  }
  return { ok: false, error: NO_RUN_TARGET_MESSAGE };
}
