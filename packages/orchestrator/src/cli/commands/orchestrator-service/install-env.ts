/**
 * Env file for `kici-admin orchestrator install`: wizard, copied --env-file, or
 * a stub the operator fills in. Kept out of install.ts so the mode decision and
 * stub content are unit-testable without Commander.
 */

import fs from 'node:fs';
import path from 'node:path';
import { OrchestratorMode } from '@kici-dev/engine';
import { copyFileSecurelySync, writeFileSecurelySync } from '../../../helpers/secure-write.js';
import { upsertEnvAssignment } from '../../service/env-assignment.js';
import { ENV_FILE_MODE } from '../shared/env-file-mode.js';
import type { OrchestratorSourceHint } from '../../wizard/orchestrator-wizard.js';

export type InstallEnvMode = 'wizard' | 'env-file' | 'stub';

export interface WriteInstallEnvResult {
  /** Present only in wizard mode when the operator opted into a GitHub App source. */
  sourceHint?: OrchestratorSourceHint;
}

/** Public compose quickstart, pointed at from the stub env file. */
export const COMPOSE_QUICKSTART_URL = 'https://docs.kici.dev/user/quickstart/compose/';

/** Direct-ingress guide, pointed at from the stub env file's KICI_WEBHOOK_PUBLIC_URL line. */
export const GITHUB_INGRESS_URL = 'https://docs.kici.dev/operator/orchestrator/github-ingress/';

/**
 * Mode a fresh install writes when the operator names none. `hybrid` is
 * `platform` plus its own HMAC-verified ingress route, with no extra
 * configuration: with the port unreachable it behaves as `platform`, and
 * exposing the port later stops losing pushes to a relay outage.
 */
export const DEFAULT_INSTALL_MODE: OrchestratorMode = OrchestratorMode.enum.hybrid;

export interface WizardModeInput {
  /** --wizard=true / --no-wizard=false / undefined when neither is passed. */
  wizard?: boolean;
  envFile?: string;
  /** --dev (spins up a local Postgres and fills the DB URL). */
  dev?: boolean;
  /** Whether stdout is an interactive terminal. */
  isTTY: boolean;
  isCI: boolean;
}

/**
 * Precedence: --env-file, then --wizard / --no-wizard; --dev keeps the stub (it
 * provisions the DB, so the wizard's DB prompt is redundant); else the wizard
 * only on an interactive non-CI terminal (as `kici init`), the stub otherwise.
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
 * Every required key with an inline explanation. KICI_DATABASE_URL comes from
 * a --dev container URL when present, KICI_MODE from `--mode`.
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
  envFileSource?: string;
  /** Dev-provisioned DB URL, written into the stub or appended to an env file. */
  devDbUrl?: string;
  /**
   * From `--mode`: written into the stub and preselected in the wizard. Unset
   * falls back to {@link DEFAULT_INSTALL_MODE}.
   */
  orchestratorMode?: OrchestratorMode;
  /**
   * The operator typed `--mode` (Commander did not default it). The env-file
   * path bakes the unit's entry point from its `KICI_MODE`, so a defaulted
   * `hybrid` must never overwrite a joined cluster's `independent`, while a
   * named `--mode` must.
   */
  modeExplicit?: boolean;
}

/**
 * Every path ends at {@link ENV_FILE_MODE}: the file holds the secrets master
 * key, so it is never group- or world-readable. Creating or replacing stages
 * through a sibling temporary at that mode, so the destination is never
 * briefly looser; the trailing chmod tightens a pre-existing file the append
 * path only extends.
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
    // The unit's entry point is baked from KICI_MODE now, so a named --mode
    // must reach the copied file: set later, an `independent` orchestrator
    // would point at the Platform-connected server, which refuses to boot. A
    // defaulted --mode writes nothing, so the file keeps its own mode.
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
