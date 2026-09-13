/**
 * Env-file resolution + content for `kici-admin orchestrator install`.
 *
 * Three write paths — the interactive wizard, copying a supplied --env-file,
 * or writing an enumerated stub the operator fills in by hand — plus the
 * flag/TTY precedence that picks between them. Kept out of install.ts so the
 * command action stays small and the decision + stub content are unit-testable
 * without driving the whole install through Commander.
 */

import fs from 'node:fs';
import path from 'node:path';
import { OrchestratorMode } from '@kici-dev/engine';
import { copyFileSecurelySync, writeFileSecurelySync } from '../../../helpers/secure-write.js';
import { upsertEnvAssignment } from '../../service/env-assignment.js';
import { ENV_FILE_MODE } from '../shared/env-file-mode.js';
import type { OrchestratorSourceHint } from '../../wizard/orchestrator-wizard.js';

/** Which config source the install writes the env file from. */
export type InstallEnvMode = 'wizard' | 'env-file' | 'stub';

/** Result of writing the install env file. */
export interface WriteInstallEnvResult {
  /** Present only in wizard mode when the operator opted into a GitHub App source. */
  sourceHint?: OrchestratorSourceHint;
}

/** Public compose quickstart, pointed at from the stub env file. */
export const COMPOSE_QUICKSTART_URL = 'https://docs.kici.dev/user/quickstart/compose/';

/** Direct-ingress guide, pointed at from the stub env file's KICI_WEBHOOK_PUBLIC_URL line. */
export const GITHUB_INGRESS_URL = 'https://docs.kici.dev/operator/orchestrator/github-ingress/';

/**
 * Operating mode a fresh install writes when the operator names none.
 *
 * `hybrid` is a superset of `platform`: the orchestrator accepts every
 * Platform-relayed webhook exactly as `platform` does, and additionally serves
 * its own ingress route, which verifies the HMAC signature before it acts on a
 * delivery. It requires no configuration beyond what `platform` requires, so an
 * orchestrator whose port nothing reaches behaves identically to a `platform`
 * one — while an operator who later exposes that port stops losing pushes to a
 * relay outage.
 */
export const DEFAULT_INSTALL_MODE: OrchestratorMode = OrchestratorMode.enum.hybrid;

export interface WizardModeInput {
  /** --wizard=true / --no-wizard=false / undefined when neither is passed. */
  wizard?: boolean;
  /** --env-file value, if any. */
  envFile?: string;
  /** --dev (spins up a local Postgres and fills the DB URL). */
  dev?: boolean;
  /** Whether stdout is attached to an interactive terminal. */
  isTTY: boolean;
  /** Whether the process runs under CI (non-interactive). */
  isCI: boolean;
}

/**
 * Pick the install env mode. Precedence: an explicit --env-file wins; then an
 * explicit --wizard / --no-wizard; --dev keeps the stub (it provisions the DB,
 * so the wizard's DB prompt would be redundant); otherwise the wizard is the
 * default only on a bare interactive terminal (mirrors `kici init`), and every
 * non-interactive/scripted install writes the stub.
 */
export function resolveWizardMode(input: WizardModeInput): InstallEnvMode {
  if (input.envFile) return 'env-file';
  if (input.wizard === true) return 'wizard';
  if (input.wizard === false) return 'stub';
  if (input.dev) return 'stub';
  if (input.isTTY && !input.isCI) return 'wizard';
  return 'stub';
}

/**
 * Build the stub env file: every required key with an inline explanation, a
 * generation command for the two secrets, and a pointer to the compose
 * quickstart. Fills KICI_DATABASE_URL from a --dev container URL when present,
 * and KICI_MODE from `--mode` when the operator named one.
 */
export function buildStubEnv(opts: { devDbUrl?: string; mode?: OrchestratorMode }): string {
  const dbUrl = opts.devDbUrl ?? 'postgresql://kici:password@localhost:5432/kici';
  const mode = opts.mode ?? DEFAULT_INSTALL_MODE;
  return [
    '# KiCI orchestrator configuration',
    '#',
    '# Fill in the required values below, then run:',
    '#   kici-admin orchestrator start',
    '#',
    '# Generate the two secrets with: openssl rand -hex 32',
    `# Full walkthrough: ${COMPOSE_QUICKSTART_URL}`,
    '#',
    '# --- Required ---',
    '# Operating mode: hybrid (default -- Platform relay + direct webhook ingress) | platform | observed | independent',
    `KICI_MODE=${mode}`,
    '# PostgreSQL connection string (always required).',
    `KICI_DATABASE_URL=${dbUrl}`,
    '# Platform connection URL (required in platform/hybrid/observed mode).',
    'KICI_PLATFORM_URL=wss://api.kici.dev/ws',
    '# Orchestrator REGISTRATION token from the dashboard',
    '#   (Settings -> Orchestrators -> New orchestrator; starts with kici_ok_).',
    '#   This is NOT a cluster join token (kici_join_v1.<routing>.<secret>), which',
    '#   is used only by `kici-admin join` to add a peer to an existing cluster.',
    'KICI_PLATFORM_TOKEN=',
    '# Secrets encryption key (32-byte hex) -- generate: openssl rand -hex 32',
    'KICI_SECRET_KEY=',
    '# Admin token for kici-admin auth (source add, etc.) -- generate: openssl rand -hex 32',
    'KICI_BOOTSTRAP_ADMIN_TOKEN=',
    '#',
    '# --- Optional ---',
    '# HTTP listen port (default 4000).',
    '# KICI_PORT=4000',
    "# Public base URL of this orchestrator's own webhook ingress. Set it to have",
    '#   providers post straight to this orchestrator, so a Platform outage cannot',
    `#   drop a delivery. Guide: ${GITHUB_INGRESS_URL}`,
    '# KICI_WEBHOOK_PUBLIC_URL=https://ci.example.com',
    '',
  ].join('\n');
}

export interface WriteInstallEnvArgs {
  mode: InstallEnvMode;
  envFilePath: string;
  /** Source path for env-file mode. */
  envFileSource?: string;
  /** Dev-provisioned DB URL, threaded into the stub / appended to an env file. */
  devDbUrl?: string;
  /**
   * Operating mode from `--mode`. Written into the stub, and preselected in the
   * wizard's mode prompt. Unset falls back to {@link DEFAULT_INSTALL_MODE}.
   */
  orchestratorMode?: OrchestratorMode;
  /**
   * Whether the operator actually typed `--mode`, as opposed to Commander
   * filling in {@link DEFAULT_INSTALL_MODE}.
   *
   * Only the env-file path needs the distinction. The file the operator hands
   * in may already declare `KICI_MODE`, and the install bakes the service unit's
   * entry point from that value — so a defaulted `hybrid` must never overwrite a
   * joined cluster's `independent`, while a named `--mode` must.
   */
  modeExplicit?: boolean;
}

/**
 * Materialise the env file for the resolved mode.
 *
 * Every write path ends at {@link ENV_FILE_MODE}: the file carries the secrets
 * master key, so it must never be group- or world-readable. Each path that
 * creates or replaces the file stages it through a sibling temporary at that
 * mode, so the destination never exists more permissively even briefly. The
 * trailing chmod tightens the one path that only appends — a file that was
 * already there at looser permissions.
 */
export async function writeInstallEnvFile(
  args: WriteInstallEnvArgs,
): Promise<WriteInstallEnvResult> {
  const result = await materialiseInstallEnvFile(args);
  fs.chmodSync(args.envFilePath, ENV_FILE_MODE);
  return result;
}

async function materialiseInstallEnvFile(
  args: WriteInstallEnvArgs,
): Promise<WriteInstallEnvResult> {
  const { mode, envFilePath, envFileSource, devDbUrl, orchestratorMode, modeExplicit } = args;

  if (mode === 'wizard') {
    const { runOrchestratorWizard } = await import('../../wizard/orchestrator-wizard.js');
    const c = await runOrchestratorWizard({ defaultMode: orchestratorMode });
    let content = '# KiCI orchestrator configuration (generated by setup wizard)\n';
    content += `KICI_MODE=${c.mode}\n`;
    content += `KICI_DATABASE_URL=${c.databaseUrl}\n`;
    content += `KICI_PORT=${c.port}\n`;
    content += `KICI_SECRET_KEY=${c.secretsKey}\n`;
    content += `KICI_BOOTSTRAP_ADMIN_TOKEN=${c.bootstrapAdminToken}\n`;
    if (c.platformUrl) content += `KICI_PLATFORM_URL=${c.platformUrl}\n`;
    if (c.platformToken) content += `KICI_PLATFORM_TOKEN=${c.platformToken}\n`;
    if (c.webhookPublicUrl) content += `KICI_WEBHOOK_PUBLIC_URL=${c.webhookPublicUrl}\n`;
    writeFileSecurelySync(envFilePath, content, ENV_FILE_MODE);
    console.log(`Wrote wizard configuration to ${envFilePath}`);
    return { sourceHint: c.source };
  }

  if (mode === 'env-file') {
    const source = path.resolve(envFileSource!);
    if (!fs.existsSync(source)) throw new Error(`env file not found: ${source}`);
    copyFileSecurelySync(source, envFilePath, ENV_FILE_MODE);
    console.log(`Copied env file to ${envFilePath}`);
    // The unit's entry point is baked from KICI_MODE at install time, so a
    // named --mode has to reach the copied file: setting it afterwards would
    // leave an `independent` orchestrator pointed at the Platform-connected
    // server, which refuses to boot. A defaulted --mode writes nothing, so a
    // file that already names its mode keeps it.
    if (modeExplicit && orchestratorMode) {
      writeFileSecurelySync(
        envFilePath,
        upsertEnvAssignment(fs.readFileSync(envFilePath, 'utf-8'), 'KICI_MODE', orchestratorMode),
        ENV_FILE_MODE,
      );
      console.log(`Set KICI_MODE=${orchestratorMode} in ${envFilePath} (from --mode)`);
    }
    return {};
  }

  // stub mode
  if (!fs.existsSync(envFilePath)) {
    writeFileSecurelySync(
      envFilePath,
      buildStubEnv({ devDbUrl, mode: orchestratorMode }),
      ENV_FILE_MODE,
    );
    console.log(`Created env file at ${envFilePath}`);
  } else if (devDbUrl) {
    fs.appendFileSync(envFilePath, `\nKICI_DATABASE_URL=${devDbUrl}\n`);
    console.log(`Appended KICI_DATABASE_URL to ${envFilePath}`);
  }
  return {};
}
