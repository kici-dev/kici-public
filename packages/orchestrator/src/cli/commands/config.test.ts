/**
 * `kici-admin config set` warns for a path nothing reads back.
 *
 * The shared config store is written by `/admin/config` and read by
 * `buildConfigBundle` alone. Startup parses the environment, and the reloader
 * is constructed with no shared store, so a `config set` on any other path is
 * stored, versioned, and never applied — which the CLI used to report as a
 * plain success.
 */

import { Command } from 'commander';
import { describe, expect, it, vi } from 'vitest';
import type { AdminApiClient } from '../api-client.js';
import { sharedConfigSchema } from '../../config/schema.js';
import {
  isConsumedSharedConfigPath,
  registerConfigCommands,
  sharedConfigSetWarning,
} from './config.js';

describe('sharedConfigSetWarning', () => {
  // fails-when: a path no orchestrator reads back is set and the command says
  //   nothing. `cacheTtlDays` is the exact sequence the operator docs used to
  //   prescribe — `config set cacheTtlDays 7` then `config reload` — which
  //   returns success and changes nothing.
  // `secrets.keyFile` and `secrets.bootstrapAdminToken` are the two the bare
  // `secrets` prefix used to silence. Both are declared by sharedConfigSchema
  // and neither reaches buildConfigBundle, which reads `shared.secrets?.key`
  // and nothing else beneath `secrets`.
  it.each([
    'cacheTtlDays',
    'queue.maxDepth',
    'agentAuth',
    'cluster.raftHeartbeatMs',
    'secrets.keyFile',
    'secrets.bootstrapAdminToken',
  ])('warns for `%s`, and names what does reach a running orchestrator', (path) => {
    const warning = sharedConfigSetWarning(path);

    expect(warning).toContain(path);
    expect(warning).toContain('cluster-settings');
    expect(warning).toContain('org-settings');
  });

  // breaks-if-wrong: a warning on every path trains the operator to ignore the
  //   channel. These are the paths `buildConfigBundle` genuinely reads out of
  //   the shared document and hands to a joining orchestrator, so setting one
  //   does change what a new peer boots with.
  it.each(['storage', 'storage.bucket', 'storage.forcePathStyle', 'secrets.key'])(
    'stays silent for `%s`',
    (path) => {
      expect(sharedConfigSetWarning(path)).toBeNull();
    },
  );

  // Pinned against the schema rather than a hand-written list, so a sibling
  // added to `secrets` later is covered without editing this file.
  // fails-when: `secrets` returns to the consumed list, silencing every
  //   sibling under it.
  // breaks-if-wrong: `secrets.key` is the one the join bundle carries, so it
  //   must stay silent.
  it('warns for every `secrets` field the join bundle does not carry', () => {
    const fields = Object.keys(sharedConfigSchema.shape.secrets.unwrap().shape);
    expect(fields).toContain('key');
    for (const field of fields) {
      const warning = sharedConfigSetWarning(`secrets.${field}`);
      if (field === 'key') expect(warning).toBeNull();
      else expect(warning).toContain(`secrets.${field}`);
    }
  });

  // fails-when: the prefix match is a bare `startsWith`, which would silence
  //   an unrelated sibling whose name merely begins with a consumed one.
  it('matches whole path segments, not string prefixes', () => {
    expect(isConsumedSharedConfigPath('storage')).toBe(true);
    expect(isConsumedSharedConfigPath('storage.bucket')).toBe(true);
    expect(isConsumedSharedConfigPath('storageQuota')).toBe(false);
    expect(isConsumedSharedConfigPath('secretsBackend')).toBe(false);
  });
});

describe('kici-admin config set', () => {
  async function runSet(path: string, value: string, rejectWith?: Error) {
    const configSet = rejectWith
      ? vi.fn().mockRejectedValue(rejectWith)
      : vi.fn().mockResolvedValue({ version: 3 });
    const program = new Command();
    program.exitOverride();
    registerConfigCommands(program, () => ({ configSet }) as unknown as AdminApiClient);

    const stdout = vi.spyOn(console, 'log').mockImplementation(() => {});
    const stderr = vi.spyOn(console, 'error').mockImplementation(() => {});
    // The action's catch calls process.exit(1). Unstubbed, an unexpected throw
    // tears the vitest worker down instead of failing the test, so the run
    // reports an infrastructure error rather than the assertion that broke.
    const exit = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Error(`process.exit(${code ?? 0})`);
    }) as never);
    try {
      await program.parseAsync(['config', 'set', path, value], { from: 'user' });
      return {
        configSet,
        stdout: stdout.mock.calls.map((c) => c.join(' ')).join('\n'),
        stderr: stderr.mock.calls.map((c) => c.join(' ')).join('\n'),
      };
    } finally {
      stdout.mockRestore();
      stderr.mockRestore();
      exit.mockRestore();
    }
  }

  // fails-when: the warning helper exists but the command never calls it. A
  //   unit test over the helper alone would pass against an unwired command.
  it('emits the warning on stderr for a path nothing reads back', async () => {
    const { stderr } = await runSet('cacheTtlDays', '7');
    expect(stderr).toContain('cacheTtlDays');
    expect(stderr).toContain('cluster-settings');
  });

  it('emits nothing extra for a path the join bundle carries', async () => {
    const { stderr } = await runSet('storage.bucket', '"kici-cache"');
    expect(stderr).toBe('');
  });

  // The command, not the helper: `secrets.keyFile` is one of the two paths the
  // bare `secrets` prefix used to silence, and it is as inert as cacheTtlDays.
  it('emits the warning for a `secrets` sibling the bundle does not carry', async () => {
    const { stderr } = await runSet('secrets.keyFile', '"/etc/kici/key"');
    expect(stderr).toContain('secrets.keyFile');
    expect(stderr).toContain('cluster-settings');
  });

  // fails-when: `process.exit` is left unstubbed. The action's catch calls it,
  //   so a failing write ends the vitest worker — the run then reports an
  //   infrastructure error and no assertion in this file is attributed.
  it('a failing write reaches the exit path rather than ending the worker', async () => {
    await expect(runSet('cacheTtlDays', '7', new Error('boom'))).rejects.toThrow('process.exit(1)');
  });

  // breaks-if-wrong: warning is additive. The write still happens, the exit
  //   code stays 0, and stdout still carries only the API result — refusing
  //   here would be a compat break needing a deprecation ledger row.
  it('still writes the value and leaves stdout unchanged', async () => {
    const { configSet, stdout } = await runSet('cacheTtlDays', '7');
    expect(configSet).toHaveBeenCalledWith('cacheTtlDays', 7, undefined);
    expect(stdout).toBe(JSON.stringify({ version: 3 }, null, 2));
    expect(process.exitCode).toBeUndefined();
  });
});
