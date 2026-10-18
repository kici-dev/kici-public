/**
 * Key material for SSH-key git credentials inside write windows.
 *
 * A window that resolves to an SSH key gets the key written to
 * `<dir>/ssh/<hash of the credential name>-<n>/id`, beside a known_hosts file
 * of the pinned forge host keys, and an ssh command that uses both. Windows
 * that name the same credential while one is open share one directory, so
 * overlapping windows on one job reuse the file; it is deleted when the last
 * of them closes. A window opened after that gets a new directory (the next
 * `<n>`), so a deletion still in flight never removes its key.
 *
 * The key never enters the runner process: the runner receives the ssh command
 * and sets it as the checkout's `core.sshCommand` for the window.
 */

import { createHash } from 'node:crypto';
import { chown as fsChown, mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { buildStrictSshCommand } from './ssh-auth.js';
import { FORGE_KNOWN_HOSTS } from './forge-known-hosts.js';

export interface SshWriteKeys {
  /** Materialise (or reuse) the key for `credentialName`; returns the ssh command. */
  acquire(grantId: string, credentialName: string, privateKeyPem: string): Promise<string>;
  /** Drop `grantId`; deletes the key dir when no grant uses it. Idempotent. */
  release(grantId: string): Promise<void>;
  /** Delete every key dir. Idempotent. */
  closeAll(): Promise<void>;
}

interface Entry {
  dir: string;
  users: number;
  command: Promise<string>;
}

/** The job user's own file, so a host the customer pins in a step is honoured. */
const USER_KNOWN_HOSTS = '~/.ssh/known_hosts';

export function createSshWriteKeys(args: {
  /** The job's credential directory (already created). */
  dir: string;
  /** The runner's identity under `KICI_RUNNER_USER`: ssh must be able to read the key. */
  owner?: { uid: number; gid: number };
  chown?: (path: string, uid: number, gid: number) => Promise<void>;
}): SshWriteKeys {
  const chown = args.chown ?? fsChown;
  const root = join(args.dir, 'ssh');
  const entries = new Map<string, Entry>();
  const grantKey = new Map<string, string>();
  // Numbers each materialised directory: see the file comment.
  let generation = 0;

  const own = async (path: string): Promise<void> => {
    if (args.owner) await chown(path, args.owner.uid, args.owner.gid);
  };

  const materialise = async (dir: string, pem: string): Promise<string> => {
    await mkdir(root, { recursive: true, mode: 0o700 });
    await own(root);
    await mkdir(dir, { recursive: true, mode: 0o700 });
    await own(dir);
    const keyPath = join(dir, 'id');
    const knownHostsPath = join(dir, 'known_hosts');
    // ssh rejects a key file without a trailing newline.
    await writeFile(keyPath, pem.endsWith('\n') ? pem : `${pem}\n`, { mode: 0o600 });
    await own(keyPath);
    await writeFile(knownHostsPath, FORGE_KNOWN_HOSTS, { mode: 0o600 });
    await own(knownHostsPath);
    return buildStrictSshCommand({ keyPath, knownHostsFiles: [knownHostsPath, USER_KNOWN_HOSTS] });
  };

  const drop = async (key: string, entry: Entry): Promise<void> => {
    entries.delete(key);
    // Wait for a write still in flight, so the rm cannot race it.
    await entry.command.catch(() => undefined);
    await rm(entry.dir, { recursive: true, force: true });
  };

  return {
    acquire: async (grantId, credentialName, privateKeyPem) => {
      const key = createHash('sha256').update(credentialName).digest('hex').slice(0, 16);
      let entry = entries.get(key);
      if (!entry) {
        const dir = join(root, `${key}-${generation++}`);
        entry = { dir, users: 0, command: materialise(dir, privateKeyPem) };
        entries.set(key, entry);
      }
      entry.users += 1;
      grantKey.set(grantId, key);
      try {
        return await entry.command;
      } catch (err) {
        grantKey.delete(grantId);
        entry.users -= 1;
        if (entry.users === 0 && entries.get(key) === entry) await drop(key, entry);
        throw err;
      }
    },
    release: async (grantId) => {
      const key = grantKey.get(grantId);
      if (key === undefined) return;
      grantKey.delete(grantId);
      const entry = entries.get(key);
      if (!entry) return;
      entry.users -= 1;
      if (entry.users === 0) await drop(key, entry);
    },
    closeAll: async () => {
      grantKey.clear();
      const all = [...entries.entries()];
      for (const [key, entry] of all) await drop(key, entry);
      await rm(root, { recursive: true, force: true });
    },
  };
}
