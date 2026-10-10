/**
 * `kici connect <url>` and `kici disconnect`.
 *
 * `connect` saves an orchestrator as the direct target `kici run remote` and
 * `kici types` use, with the orchestrator admin token an operator issued. The
 * token is verified against the orchestrator (`GET /api/v1/test/whoami`)
 * before anything is saved, so a mistyped or revoked token never lands in the
 * config. `disconnect` forgets that target and nothing else: a Platform login
 * stays.
 */
import pc from 'picocolors';
import { password } from '@inquirer/prompts';
import { logger, toErrorMessage } from '@kici-dev/core';
import { loadGlobalConfig, mergeGlobalConfig, saveGlobalConfig } from '../remote/config.js';
import { DirectRunClient, type DirectWhoami } from '../remote/direct-client.js';
import { normalizeOrchestratorUrl } from '../remote/target.js';

export interface ConnectDeps {
  /** Verify a token; defaults to `GET /api/v1/test/whoami` on the orchestrator. */
  whoami?: (url: string, token: string) => Promise<DirectWhoami>;
  /** Read all of standard input; defaults to the process stdin. */
  readStdin?: () => Promise<string>;
  /** Prompt for the token on a terminal; defaults to a masked prompt. */
  promptToken?: () => Promise<string>;
  /** Whether standard input is a terminal; defaults to `process.stdin.isTTY`. */
  isTty?: boolean;
  env?: NodeJS.ProcessEnv;
}

async function readAllStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk as Buffer));
  return Buffer.concat(chunks).toString('utf-8');
}

/** The token from stdin, `KICI_ORCHESTRATOR_TOKEN`, or a terminal prompt. */
async function readToken(
  opts: { tokenStdin?: boolean },
  deps: ConnectDeps,
): Promise<string | undefined> {
  if (opts.tokenStdin) {
    const raw = await (deps.readStdin ?? readAllStdin)();
    return raw.split(/\r?\n/)[0]?.trim() || undefined;
  }
  const env = deps.env ?? process.env;
  if (env.KICI_ORCHESTRATOR_TOKEN) return env.KICI_ORCHESTRATOR_TOKEN;
  if (deps.isTty ?? Boolean(process.stdin.isTTY)) {
    const prompt =
      deps.promptToken ?? (() => password({ message: 'Orchestrator token:', mask: '*' }));
    return (await prompt()).trim() || undefined;
  }
  return undefined;
}

/** One line naming who the token is and where its runs land. */
function describeConnection(url: string, me: DirectWhoami): string {
  const who = me.subject ?? me.label;
  const org = me.orgId ?? 'not assigned yet';
  return `Connected to ${url} as ${who} (role ${me.role}, orchestrator mode ${me.mode}, organization ${org})`;
}

/**
 * Verify the token against the orchestrator, then save the direct target.
 *
 * @returns true when the target was verified and saved.
 */
export async function connectCommand(
  url: string,
  opts: { tokenStdin?: boolean },
  deps: ConnectDeps = {},
): Promise<boolean> {
  let normalized: string;
  try {
    normalized = normalizeOrchestratorUrl(url);
  } catch (err) {
    logger.error(pc.red(toErrorMessage(err)));
    return false;
  }

  const token = await readToken(opts, deps);
  if (!token) {
    logger.error(
      pc.red(
        'No orchestrator token: pipe it in with --token-stdin, or set KICI_ORCHESTRATOR_TOKEN.',
      ),
    );
    return false;
  }

  const verify =
    deps.whoami ?? ((u: string, t: string) => new DirectRunClient({ url: u, token: t }).whoami());
  let me: DirectWhoami;
  try {
    me = await verify(normalized, token);
  } catch (err) {
    logger.error(pc.red(`Not connected: ${toErrorMessage(err)}`));
    return false;
  }

  await mergeGlobalConfig({ direct: { url: normalized, token } });
  logger.info(pc.green(describeConnection(normalized, me)));
  if (!me.permissions.trigger) {
    logger.info(
      pc.yellow(
        `This ${me.role} token can follow runs but not start them; ask for an owner or admin token to run kici run remote.`,
      ),
    );
  }
  return true;
}

/** Forget the saved direct target; every other config field stays. */
export async function disconnectCommand(): Promise<boolean> {
  const config = await loadGlobalConfig();
  if (!config.direct) {
    logger.info('No orchestrator is connected.');
    return true;
  }
  const { url } = config.direct;
  delete config.direct;
  await saveGlobalConfig(config);
  const next = config.pat
    ? 'kici run remote goes through your KiCI Platform login again.'
    : 'Run `kici connect <url>` or `kici login` before the next kici run remote.';
  logger.info(`Disconnected from ${url}. ${next}`);
  return true;
}
