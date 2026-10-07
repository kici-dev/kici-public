/**
 * `kici-admin org list` — both transports, the offline note, and the
 * older-orchestrator hint.
 *
 * Surface ids exercised here (needled by the coverage gate):
 *   cli:kici-admin:org
 *   cli:kici-admin:org list
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Command } from 'commander';

const withDbUrls: Array<string | undefined> = [];
const mockListHeldOrgIds = vi.fn();
const mockWithDb = vi.fn(async (fn: (db: unknown) => Promise<unknown>, url?: string) => {
  withDbUrls.push(url);
  return fn({});
});

vi.mock('../../db/repos/org-ids-repo.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  listHeldOrgIds: (...a: unknown[]) => mockListHeldOrgIds(...a),
}));
vi.mock('./shared/db.js', () => ({
  withDb: (fn: (db: unknown) => Promise<unknown>, url?: string) => mockWithDb(fn, url),
}));

const { registerOrgCommands } = await import('./org.js');
const { ORG_LIST_PATH, OrgIdSource, PlatformAttachment } =
  await import('../../db/repos/org-ids-repo.js');
const { buildProgram } = await import('../kici-admin.js');

const S = OrgIdSource.enum;
const HTTP_BODY = {
  platformAttachment: PlatformAttachment.enum.attached,
  attachedOrgId: 'org_a',
  orgs: [
    { orgId: '__default__', sources: [S.source] },
    { orgId: 'org_a', sources: [S.platform, S['remote-source'], S.context] },
  ],
};

async function run(args: string[], get = vi.fn(async () => HTTP_BODY)) {
  const program = new Command();
  program.exitOverride();
  registerOrgCommands(program, () => ({ get }) as never);
  const out: string[] = [];
  const err: string[] = [];
  let exitCode: number | null = null;
  const log = vi.spyOn(console, 'log').mockImplementation((...a) => void out.push(a.join(' ')));
  const error = vi.spyOn(console, 'error').mockImplementation((...a) => void err.push(a.join(' ')));
  const write = vi.spyOn(process.stderr, 'write').mockImplementation((s) => {
    err.push(String(s));
    return true;
  });
  const exit = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
    exitCode = code ?? 0;
    throw new Error(`EXIT:${code}`);
  }) as never);
  try {
    await program.parseAsync(args, { from: 'user' });
  } catch (e) {
    if (!(e instanceof Error) || !e.message.startsWith('EXIT:')) throw e;
  } finally {
    log.mockRestore();
    error.mockRestore();
    write.mockRestore();
    exit.mockRestore();
  }
  return { stdout: out.join('\n'), stderr: err.join('\n'), exitCode, get };
}

let savedDbUrl: string | undefined;
beforeEach(() => {
  savedDbUrl = process.env.KICI_DATABASE_URL;
  delete process.env.KICI_DATABASE_URL;
  withDbUrls.length = 0;
  mockWithDb.mockClear();
  mockListHeldOrgIds.mockReset().mockResolvedValue([{ orgId: 'org_a', sources: [S.context] }]);
});
afterEach(() => {
  if (savedDbUrl === undefined) delete process.env.KICI_DATABASE_URL;
  else process.env.KICI_DATABASE_URL = savedDbUrl;
});

describe('kici-admin org list', () => {
  it('reads the admin API by default and prints one row per org', async () => {
    const r = await run(['org', 'list']);
    expect(r.get).toHaveBeenCalledWith(ORG_LIST_PATH);
    expect(mockWithDb).not.toHaveBeenCalled();
    const lines = r.stdout.split('\n');
    expect(lines.some((l) => /^__default__\s+source$/.test(l))).toBe(true);
    expect(lines.some((l) => /^org_a\s+platform, remote-source, context$/.test(l))).toBe(true);
    expect(r.exitCode).toBeNull();
  });

  it('prints the admin API body verbatim with --json', async () => {
    const r = await run(['org', 'list', '--json']);
    expect(JSON.parse(r.stdout)).toEqual(HTTP_BODY);
  });

  // fails-when: --database-url is ignored and the command still calls the admin API
  it('reads the database with --database-url, without the Platform fields', async () => {
    const r = await run(['org', 'list', '--json', '--database-url', 'postgres://u@h/db']);
    expect(withDbUrls).toEqual(['postgres://u@h/db']);
    expect(r.get).not.toHaveBeenCalled();
    expect(JSON.parse(r.stdout)).toEqual({ orgs: [{ orgId: 'org_a', sources: [S.context] }] });
  });

  // fails-when: an exported KICI_DATABASE_URL switches to offline mode silently (Review Focus 2)
  it('says so when KICI_DATABASE_URL switched it to the database', async () => {
    process.env.KICI_DATABASE_URL = 'postgres://u@h/env';
    const r = await run(['org', 'list']);
    expect(r.get).not.toHaveBeenCalled();
    expect(r.stderr).toContain('read from the database');
    expect(r.stderr).toContain('KICI_DATABASE_URL');
  });

  // fails-when: a 404 from an older orchestrator surfaces as a bare HTTP error (Review Focus 3)
  // breaks-if-wrong: any other HTTP error passes through unchanged
  it('names an orchestrator that predates the route, and passes other errors through', async () => {
    const missing = await run(
      ['org', 'list'],
      vi.fn().mockRejectedValue(new Error('HTTP 404: 404 Not Found')),
    );
    expect(missing.exitCode).toBe(1);
    expect(missing.stderr).toContain('predates');
    expect(missing.stderr).toContain('--database-url');

    const denied = await run(
      ['org', 'list'],
      vi.fn().mockRejectedValue(new Error('HTTP 403: forbidden')),
    );
    expect(denied.exitCode).toBe(1);
    expect(denied.stderr).toContain('Error: HTTP 403: forbidden');
    expect(denied.stderr).not.toContain('predates');
  });

  it('says when no org id is found', async () => {
    const r = await run(
      ['org', 'list'],
      vi.fn(async () => ({ ...HTTP_BODY, orgs: [] })),
    );
    expect(r.stdout).toBe('No org ids found.');
    expect(r.exitCode).toBeNull();
  });

  it('is registered in the kici-admin tree as org list', () => {
    const org = buildProgram().commands.find((c) => c.name() === 'org');
    expect(org?.commands.map((c) => c.name())).toEqual(['list']);
  });
});

describe('org-id help', () => {
  const GROUPS = ['secret', 'context', 'variable', 'remote-source'];

  // fails-when: a converted command loses the description, or a new org-id input in these
  // groups ships without pointing at org list
  it('points every org-id input of the secret, context, variable and remote-source commands at org list', () => {
    const program = buildProgram();
    const checked: string[] = [];
    const missing: string[] = [];
    const walk = (cmd: Command, path: string): void => {
      for (const a of cmd.registeredArguments) {
        if (a.name() !== 'orgId') continue;
        checked.push(`${path} <orgId>`);
        if (!a.description.includes('kici-admin org list')) missing.push(`${path} <orgId>`);
      }
      for (const o of cmd.options) {
        if (o.long !== '--org') continue;
        checked.push(`${path} --org`);
        if (!o.description.includes('kici-admin org list')) missing.push(`${path} --org`);
      }
      for (const sub of cmd.commands) walk(sub, `${path} ${sub.name()}`);
    };
    for (const g of GROUPS)
      walk(
        program.commands.find((c) => c.name() === g)!,
        g,
      );
    // positive control: the walk reaches each group's org-id inputs
    expect(checked).toEqual(
      expect.arrayContaining([
        'secret scopes <orgId>',
        'secret set <orgId>',
        'secret set --org',
        'secret purge --org',
        'context list --org',
        'context purge --org',
        'variable list <orgId>',
        'remote-source show <orgId>',
      ]),
    );
    expect(missing).toEqual([]);
  });
});
