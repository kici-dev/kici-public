/**
 * `kici init`: scaffolds .kici/ with workflow templates, in TypeScript mode
 * (package.json + node_modules) or MJS mode (pure JS).
 */

import { readFile, writeFile, mkdir, access, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { $ } from 'zx';
import pc from 'picocolors';
import { checkbox, confirm, select } from '@inquirer/prompts';
import { initZx, logger, toErrorMessage } from '@kici-dev/core';
import { isCiEnvironment } from '@kici-dev/core/ci-env';
import {
  KICI_DIGEST_DEFAULT_EXCLUSIONS,
  KICI_IGNORE_FILENAME,
} from '@kici-dev/core/kici-source-digest';
import {
  workflowPaths,
  generatePackageJson,
  generateSampleFixture,
  scaffoldPrChecks,
  PR_CHECKS_WORKFLOW,
  resolveVersionPin,
  tsconfigTemplate,
  agentsMdTemplate,
} from '../templates/index.js';
import { getTypeScriptPaths } from '../execution/sdk-alias.js';
import { isWorkspaceMember } from '../lockfile/workspace-siblings.js';
import { detectHookTools, installHook, findGitDir } from '../hooks/index.js';
import type { HookToolName } from '../hooks/index.js';
import { rewriteRunsOnForHost, shouldOfferFirstRun } from './init-host-os.js';
import {
  DefaultBranchSource,
  type DetectedDefaultBranch,
  detectCheckedOutBranch,
  detectDefaultBranch,
} from './init-branches.js';
import {
  MemberRegistration,
  addMissingVersion,
  memberEntry,
  memberSiblingSpecifier,
  registerKiciWorkspaceMember,
} from './init-workspace.js';
import {
  PackageManager,
  WorkspaceKind,
  YarnFlavor,
  detectPackageManager,
  detectWorkspaceRoot,
  detectYarnFlavor,
  installBuildPolicyArgs,
  installCommand,
  parsePackageManager,
} from '@kici-dev/core/package-manager';

export interface InitOptions {
  /** Overwrite existing .kici/ directory */
  force?: boolean;
  /** Skip the dependency install step */
  skipInstall?: boolean;
  /** Package manager for the install step (`npm` / `pnpm` / `yarn`), bypassing detection. */
  packageManager?: string;
  /** JavaScript-only mode (no TypeScript, no dependencies) */
  mjs?: boolean;
  /** Private registry URL to scaffold a `registries:` entry for. */
  privateRegistry?: string;
  /** Optional npm scope (e.g. `@my-org`) the private registry serves. */
  privateRegistryScope?: string;
  /** Qualified secret reference (`env:NAME`) the private registry token comes from. */
  privateRegistrySecret?: string;
  /** Skip writing the .kici/AGENTS.md LLM-authoring context file. Default: write it. */
  noAgentsMd?: boolean;
  /** Force integrate mode: join .kici/ to the detected workspace (skip the prompt). */
  workspace?: boolean;
  /** Force standalone mode even inside a workspace (skip the prompt). */
  standalone?: boolean;
}

/** @returns true on success, false on error */
export async function initCommand(options: InitOptions = {}): Promise<boolean> {
  initZx();
  try {
    const kiciDir = path.resolve('.kici');

    const exists = await checkExists(kiciDir);
    if (exists && !options.force) {
      if (options.workspace) return await migrateToWorkspaceMember(kiciDir, options);
      logger.error(pc.red('\nError: .kici/ directory already exists.'));
      logger.error(pc.gray('Use --force to overwrite.\n'));
      return false;
    }

    if (exists && options.force) {
      logger.info(pc.yellow('Removing existing .kici/ directory...'));
      await rm(kiciDir, { recursive: true, force: true });
    }

    const workflows = await selectWorkflows();

    logger.info(pc.cyan('\nInitializing kici...\n'));
    logger.info(pc.gray('Creating .kici/'));
    await mkdir(kiciDir, { recursive: true });
    logger.info(pc.gray('Creating .kici/workflows/'));
    await mkdir(path.join(kiciDir, 'workflows'), { recursive: true });

    await writeScaffoldTemplates(kiciDir, workflows);

    const kiciIgnorePath = path.resolve('.kiciignore');
    if (!(await checkExists(kiciIgnorePath))) {
      logger.info(pc.gray('Writing .kiciignore'));
      await writeFile(kiciIgnorePath, kiciIgnoreTemplate, 'utf-8');
    }

    // types/ holds a snapshot of one org's secret keys fetched from the
    // Platform: a local development aid, not source (see writeKiciGitignore).
    await writeKiciGitignore(kiciDir);

    // Declare the digest's exclusion set up front, so a new repo is complete by
    // construction and never learns about the file from a drift-gate failure.
    await writeKiciIgnore(kiciDir);

    // Standalone (self-contained .kici/) vs integrate (join the detected
    // workspace so workflows can import sibling packages).
    const devMode = await detectDevelopmentMode();
    const mode = await resolveScaffoldMode(options);
    const useVerdaccio = devMode;

    if (mode.kind === 'integrate') {
      logger.info(
        pc.cyan(`Adding .kici/ to the ${mode.workspaceKind} workspace at ${mode.workspaceRoot}`),
      );
      await wireMemberDeps(kiciDir, mode, devMode, options);
    } else {
      await wireStandaloneDeps(kiciDir, devMode, options);
    }

    // Option A workflow snippet + option C .npmrc.example.
    if (options.privateRegistry) {
      await writePrivateRegistryScaffold(kiciDir, {
        url: options.privateRegistry,
        scope: options.privateRegistryScope,
        secretRef: options.privateRegistrySecret ?? 'production:NPM_TOKEN',
      });
    }

    if (await shouldWriteAgentsMd(options)) {
      await writeAgentsMd(kiciDir);
    }

    logger.info(pc.gray('Updating .gitignore'));
    await updateGitignore(useVerdaccio);

    if (process.stdout.isTTY && !isCiEnvironment()) {
      const gitDir = await findGitDir();
      if (gitDir) {
        await offerHookInstallation(useVerdaccio);
      }
    }

    await printNextSteps(mode, options);

    // Default No: spinning up the warm plane is opt-in. Skipped in CI / non-TTY
    // / --mjs / --skip-install, where it cannot compile the workflow.
    if (
      shouldOfferFirstRun({
        isTTY: Boolean(process.stdout.isTTY),
        ci: isCiEnvironment(),
        mjs: Boolean(options.mjs),
        skipInstall: Boolean(options.skipInstall),
      })
    ) {
      const runNow = await confirm({
        message: 'Run it now? (kici run push --local)',
        default: false,
      });
      if (runNow) {
        const { runRoutedCommand } = await import('./run-routed.js');
        await runRoutedCommand({ event: 'push', local: true });
      }
    }

    return true;
  } catch (error) {
    const message = toErrorMessage(error);
    logger.error(pc.red(`\nError: ${message}\n`));

    if (process.env.KICI_DEBUG === 'true' && error instanceof Error && error.stack) {
      logger.error(pc.gray(error.stack));
    }

    return false;
  }
}

/** Print the success line and the next steps for the layout just scaffolded. */
async function printNextSteps(mode: ScaffoldMode, options: InitOptions): Promise<void> {
  logger.info(pc.green('\n✓ kici initialized successfully!\n'));
  logger.info(pc.gray('Next steps:'));
  logger.info(pc.gray('  1. Edit workflows in .kici/workflows/'));
  if (mode.kind === 'integrate') {
    const flavor =
      mode.workspaceKind === WorkspaceKind.Yarn
        ? await detectYarnFlavor(mode.workspaceRoot)
        : YarnFlavor.Classic;
    const spec = memberSiblingSpecifier(mode.workspaceKind, flavor);
    logger.info(
      pc.gray(
        `  2. To import a workspace package in a workflow, declare it in .kici/package.json (e.g. "@your-scope/utils": "${spec}")`,
      ),
    );
    logger.info(pc.gray('  3. Compile: kici compile'));
    logger.info(pc.gray('  4. Commit .kici/ and the workspace file changes to your repository\n'));
  } else if (options.mjs || options.skipInstall) {
    logger.info(pc.gray('  2. Run your package manager install in .kici/ to generate a lockfile'));
    logger.info(pc.gray('  3. Preview matching: kici preview push'));
    logger.info(pc.gray('  4. Commit .kici/ to your repository\n'));
  } else {
    logger.info(pc.gray('  2. Preview matching: kici preview push'));
    logger.info(pc.gray('  3. Commit .kici/ to your repository\n'));
  }
}

/** pr-checks targets the default branch; the fixture pushes to the checked-out branch, else the default. */
async function writeScaffoldTemplates(kiciDir: string, workflows: string[]): Promise<void> {
  const cwd = process.cwd();
  const defaultBranch = await detectDefaultBranch(cwd);
  const fixtureBranch = (await detectCheckedOutBranch(cwd)) ?? defaultBranch.branch;
  const hasSrcDir = await isDirectory(path.resolve('src'));

  for (const workflow of workflows) {
    logger.info(pc.gray(`Writing .kici/workflows/${workflow}.ts`));
    const sourcePath = workflowPaths[workflow as keyof typeof workflowPaths];
    let content = await readFile(sourcePath, 'utf-8');
    if (workflow === PR_CHECKS_WORKFLOW) {
      content = scaffoldPrChecks(content, { defaultBranch: defaultBranch.branch, hasSrcDir });
      logger.info(pc.gray(describePrTarget(defaultBranch)));
    }
    // Rewrite the template runsOn to the host's own kici:os:* so the first
    // `kici run push --local` dispatches on this machine (no-op on Linux).
    content = rewriteRunsOnForHost(content, os.platform(), os.arch());
    await writeFile(path.join(kiciDir, 'workflows', `${workflow}.ts`), content, 'utf-8');
  }

  logger.info(pc.gray('Creating .kici/tests/'));
  await mkdir(path.join(kiciDir, 'tests'), { recursive: true });
  logger.info(pc.gray('Writing .kici/tests/push-test.ts'));
  const fixtureContent = generateSampleFixture(fixtureBranch);
  await writeFile(path.join(kiciDir, 'tests', 'push-test.ts'), fixtureContent, 'utf-8');
  logger.info(pc.green('Created sample test fixture at .kici/tests/push-test.ts'));
}

/** The log line naming the branch pr-checks targets and where it came from. */
function describePrTarget({ branch, source }: DetectedDefaultBranch): string {
  switch (source) {
    case DefaultBranchSource.OriginHead:
      return `pr-checks targets '${branch}', the default branch in origin/HEAD.`;
    case DefaultBranchSource.RemoteHead:
      return `pr-checks targets '${branch}', the default branch of the origin remote.`;
    case DefaultBranchSource.Fallback:
      return `pr-checks targets '${branch}': no origin remote named a default branch. Edit .kici/workflows/pr-checks.ts if yours differs.`;
  }
}

/** True when `targetPath` is a directory; false when it is absent or anything else. */
async function isDirectory(targetPath: string): Promise<boolean> {
  try {
    return (await stat(targetPath)).isDirectory();
  } catch {
    return false;
  }
}

async function checkExists(targetPath: string): Promise<boolean> {
  try {
    await access(targetPath);
    return true;
  } catch {
    return false;
  }
}

/** Interactive in TTY mode; every workflow in non-TTY / CI. */
async function selectWorkflows(): Promise<string[]> {
  if (!process.stdout.isTTY || isCiEnvironment()) {
    return ['hello-world', 'pr-checks'];
  }

  const selected = await checkbox({
    message: 'Which workflows would you like to include?',
    choices: [
      {
        name: 'Hello World (minimal push example)',
        value: 'hello-world',
        checked: true,
      },
      {
        name: 'PR Checks (comprehensive PR workflow)',
        value: 'pr-checks',
        checked: true,
      },
    ],
  });

  if (selected.length === 0) {
    return ['hello-world'];
  }

  return selected;
}

/**
 * Development mode pins `@kici-dev/sdk` to the `latest` dist-tag and points the
 * scope at the dev registry, for local testing. On when
 * `KICI_DEV=true` or the root package.json sets `kici.development`.
 */
async function detectDevelopmentMode(): Promise<boolean> {
  if (process.env.KICI_DEV === 'true') {
    return true;
  }

  try {
    const rootPkgPath = path.resolve(process.cwd(), 'package.json');
    const content = await readFile(rootPkgPath, 'utf-8');
    const pkg = JSON.parse(content) as { kici?: { development?: boolean } };
    return pkg.kici?.development === true;
  } catch {
    return false;
  }
}

/**
 * An explicit `--package-manager` wins (an invalid value throws); otherwise
 * {@link detectPackageManager} over `dir`, defaulting to npm.
 */
async function resolvePackageManager(
  override?: string,
  dir: string = process.cwd(),
): Promise<PackageManager> {
  if (override) {
    const parsed = parsePackageManager(override);
    if (!parsed) {
      throw new Error(
        `Invalid --package-manager value '${override}'. Expected one of: npm, pnpm, yarn.`,
      );
    }
    return parsed;
  }
  return detectPackageManager(dir);
}

/**
 * The dev-mode `@kici-dev` scope → registry line, or `null` when
 * `KICI_DEV_REGISTRY` is unset (then no `.npmrc` is written). The URL comes
 * from the environment, not a literal: this file ships in the published
 * package, so a hard-coded internal hostname would reach every customer.
 */
function devRegistryNpmrc(): string | null {
  const registry = process.env.KICI_DEV_REGISTRY?.trim();
  return registry ? `@kici-dev:registry=${registry}\n` : null;
}

/** Write .kici/tsconfig.json + the empty types/ dir (TypeScript mode only). */
async function writeTsConfigAndTypesDir(kiciDir: string): Promise<void> {
  logger.info(pc.gray('Writing .kici/tsconfig.json'));
  await writeFile(path.join(kiciDir, 'tsconfig.json'), await generateTsConfig(), 'utf-8');
  const typesDir = path.join(kiciDir, 'types');
  await mkdir(typesDir, { recursive: true });
  logger.info(pc.gray('Created .kici/types/ for generated type declarations'));
}

/** Run the given package manager's install in `dir`, with pnpm's build-gate flag. */
async function runInstall(pm: PackageManager, dir: string): Promise<void> {
  const [bin, action] = installCommand(pm);
  const buildPolicyArgs = installBuildPolicyArgs(pm);
  logger.info(pc.gray(`Running ${bin} ${action}...`));
  await $`cd ${dir} && ${bin} ${action} ${buildPolicyArgs}`;
}

/**
 * .kici/package.json (+ .kici/.npmrc and root .npmrc in dev mode), then
 * tsconfig + isolated install in TypeScript mode.
 */
async function wireStandaloneDeps(
  kiciDir: string,
  devMode: boolean,
  options: InitOptions,
): Promise<void> {
  logger.info(pc.gray('Writing .kici/package.json'));
  const versionPin = await resolveVersionPin(devMode, process.cwd());
  await writeFile(path.join(kiciDir, 'package.json'), generatePackageJson(versionPin), 'utf-8');

  const devNpmrc = devMode ? devRegistryNpmrc() : null;
  if (devMode && !devNpmrc) {
    logger.info(pc.yellow('Dev mode: KICI_DEV_REGISTRY is unset, writing no .npmrc.'));
  }
  if (devNpmrc) {
    logger.info(pc.yellow('Pointing @kici-dev to the dev registry.'));
    await writeFile(path.join(kiciDir, '.npmrc'), devNpmrc, 'utf-8');
    const rootNpmrc = path.resolve('.npmrc');
    if (!(await checkExists(rootNpmrc))) {
      logger.info(pc.gray('Writing .npmrc (dev registry scope)'));
      await writeFile(rootNpmrc, devNpmrc, 'utf-8');
    }
  }

  if (!options.mjs) {
    await writeTsConfigAndTypesDir(kiciDir);
    if (!options.skipInstall) {
      const pm = await resolvePackageManager(options.packageManager);
      await runInstall(pm, kiciDir);
    }
  }
}

/**
 * Member dep wiring: `.kici/` keeps its own package.json and joins the
 * workspace package list, so every install of the workspace (the developer's
 * and the agent's) installs `.kici/` too. Writes a root .npmrc in dev mode and
 * .kici/tsconfig in TypeScript mode, then installs at the workspace root. Each
 * step leaves an existing file alone and the install runs only when a step
 * changed something, so re-running on a complete layout changes nothing.
 *
 * @returns true when any file was written.
 */
async function wireMemberDeps(
  kiciDir: string,
  mode: IntegrateMode,
  devMode: boolean,
  options: InitOptions,
): Promise<boolean> {
  let changed = false;
  const manifestPath = path.join(kiciDir, 'package.json');
  if (!(await checkExists(manifestPath))) {
    logger.info(pc.gray('Writing .kici/package.json (workspace member)'));
    const versionPin = await resolveVersionPin(devMode, mode.workspaceRoot);
    await writeFile(manifestPath, generatePackageJson(versionPin), 'utf-8');
    changed = true;
  } else if (mode.workspaceKind === WorkspaceKind.Yarn) {
    const raw = await readFile(manifestPath, 'utf-8');
    const withVersion = addMissingVersion(raw);
    if (withVersion !== raw) {
      logger.info(
        pc.gray('Adding "version" to .kici/package.json (yarn ignores a member without one)'),
      );
      await writeFile(manifestPath, withVersion, 'utf-8');
      changed = true;
    }
  }

  const registration = await registerKiciWorkspaceMember(
    mode.workspaceRoot,
    mode.workspaceKind,
    kiciDir,
  );
  if (registration === MemberRegistration.Added) {
    logger.info(
      pc.gray(
        `Added ${memberEntry(mode.workspaceRoot, kiciDir)} to the ${mode.workspaceKind} workspace packages`,
      ),
    );
    changed = true;
  }

  const devNpmrc = devMode ? devRegistryNpmrc() : null;
  if (devMode && !devNpmrc) {
    logger.info(pc.yellow('Dev mode: KICI_DEV_REGISTRY is unset, writing no .npmrc.'));
  }
  const rootNpmrc = path.join(mode.workspaceRoot, '.npmrc');
  if (devNpmrc && !(await checkExists(rootNpmrc))) {
    logger.info(pc.gray('Writing workspace-root .npmrc (dev registry scope)'));
    await writeFile(rootNpmrc, devNpmrc, 'utf-8');
    changed = true;
  }

  if (!options.mjs && !(await checkExists(path.join(kiciDir, 'tsconfig.json')))) {
    await writeTsConfigAndTypesDir(kiciDir);
    changed = true;
  }

  await noteRootSdkDeclaration(mode.workspaceRoot);

  if (changed && !options.skipInstall) {
    const pm = await resolvePackageManager(options.packageManager, mode.workspaceRoot);
    await runInstall(pm, mode.workspaceRoot);
  }
  return changed;
}

/**
 * `kici init --workspace` on an existing `.kici/`: complete the workspace-member
 * layout in place. It writes `.kici/package.json` and `.kici/tsconfig.json`
 * when missing and adds `.kici` to the workspace packages when not listed. It
 * never touches workflows, tests or the dependencies in the root manifest, and
 * installs only when it changed something. A complete layout is left as it is.
 * A `.kici/` with its own package.json that the workspace does not list is a
 * standalone scaffold with its own lockfile. It is refused, because a member
 * would leave that lockfile stale.
 */
async function migrateToWorkspaceMember(kiciDir: string, options: InitOptions): Promise<boolean> {
  if (options.standalone) throw new Error(WORKSPACE_STANDALONE_CONFLICT);
  const mode = await resolveWorkspaceMode();
  const listed = isWorkspaceMember(mode.workspaceRoot, memberEntry(mode.workspaceRoot, kiciDir));
  if (!listed && (await checkExists(path.join(kiciDir, 'package.json')))) {
    logger.error(
      pc.red(
        `\nError: .kici/ has its own package.json but is not a member of the ${mode.workspaceKind} workspace at ${mode.workspaceRoot}.`,
      ),
    );
    logger.error(
      pc.gray(
        'Add .kici to the workspace packages and remove the lockfile inside .kici/, ' +
          'or run kici init --workspace --force to scaffold .kici/ again (this replaces it).\n',
      ),
    );
    return false;
  }
  const changed = await wireMemberDeps(kiciDir, mode, await detectDevelopmentMode(), options);
  logger.info(
    changed
      ? pc.green(
          `\n✓ .kici/ is now a member of the ${mode.workspaceKind} workspace at ${mode.workspaceRoot}\n`,
        )
      : pc.green('\n✓ .kici/ is already a workspace member; nothing to change\n'),
  );
  return true;
}

/**
 * `.kici/` resolves @kici-dev/sdk from its own package.json. A root declaration
 * stays where it is, because other workspace code may import the SDK. This
 * names it so the developer can remove it when nothing else uses it.
 */
async function noteRootSdkDeclaration(workspaceRoot: string): Promise<void> {
  const manifestPath = path.join(workspaceRoot, 'package.json');
  let pkg: { dependencies?: Record<string, string>; devDependencies?: Record<string, string> };
  try {
    pkg = JSON.parse(await readFile(manifestPath, 'utf-8')) as typeof pkg;
  } catch {
    return;
  }
  const range = pkg.devDependencies?.['@kici-dev/sdk'] ?? pkg.dependencies?.['@kici-dev/sdk'];
  if (range === undefined) return;
  logger.info(
    pc.gray(
      `${manifestPath} still declares @kici-dev/sdk (${range}). .kici/ does not need it; ` +
        'remove it if no other workspace package imports the SDK.',
    ),
  );
}

const WORKSPACE_STANDALONE_CONFLICT = 'Cannot combine --workspace and --standalone.';

type ScaffoldMode =
  | { kind: 'standalone' }
  | { kind: 'integrate'; workspaceRoot: string; workspaceKind: WorkspaceKind };

/** The integrate (workspace-member) scaffold mode. */
type IntegrateMode = Extract<ScaffoldMode, { kind: 'integrate' }>;

/** The workspace at or above the current directory, or an error naming the fix. */
async function resolveWorkspaceMode(): Promise<IntegrateMode> {
  const ws = await detectWorkspaceRoot(process.cwd());
  if (!ws) {
    throw new Error(
      'Cannot integrate: no pnpm/npm/yarn workspace found at or above the current directory. ' +
        'Run from a workspace root, or omit --workspace for a standalone .kici/.',
    );
  }
  return { kind: 'integrate', workspaceRoot: ws.root, workspaceKind: ws.kind };
}

/**
 * Flags win; otherwise a detected workspace prompts in interactive mode and
 * defaults to standalone in CI / non-TTY. No workspace means standalone.
 */
async function resolveScaffoldMode(options: InitOptions): Promise<ScaffoldMode> {
  if (options.workspace && options.standalone) {
    throw new Error(WORKSPACE_STANDALONE_CONFLICT);
  }
  if (options.standalone) return { kind: 'standalone' };
  if (options.workspace) return resolveWorkspaceMode();

  const ws = await detectWorkspaceRoot(process.cwd());
  if (!ws) return { kind: 'standalone' };
  if (!process.stdout.isTTY || isCiEnvironment()) return { kind: 'standalone' };
  const choice = await promptScaffoldMode(ws.kind);
  return choice === 'integrate'
    ? { kind: 'integrate', workspaceRoot: ws.root, workspaceKind: ws.kind }
    : { kind: 'standalone' };
}

async function promptScaffoldMode(kind: WorkspaceKind): Promise<'standalone' | 'integrate'> {
  return await select<'standalone' | 'integrate'>({
    message: `A ${kind} workspace was detected. How should the workflows be set up?`,
    choices: [
      {
        name: 'Standalone — self-contained .kici/ with its own lockfile and install',
        value: 'standalone',
      },
      {
        name: 'Integrate — join the workspace; workflows can import your other packages',
        value: 'integrate',
      },
    ],
    default: 'standalone',
  });
}

/**
 * When sdkPath is set in .kici/package.json, adds a path mapping so the IDE
 * autocompletes from the local SDK source.
 */
async function generateTsConfig(): Promise<string> {
  const typeScriptPaths = await getTypeScriptPaths();

  if (!typeScriptPaths) {
    return tsconfigTemplate;
  }

  const baseConfig = JSON.parse(tsconfigTemplate);
  baseConfig.compilerOptions.paths = typeScriptPaths;

  return JSON.stringify(baseConfig, null, 2) + '\n';
}

const KICI_GITIGNORE_TEMPLATE = `# Generated type declarations (\`kici types\` / authenticated \`kici compile\`).
# A snapshot of one org's secret keys — a local development aid, not source.
types/
`;

/**
 * Never overwrites an existing file (the customer may have edited it). Ignores
 * only `types/`, NOT `kici.lock.json`: the orchestrator fetches the lock from
 * the repo, so it is source.
 */
export async function writeKiciGitignore(kiciDir: string): Promise<void> {
  const gitignorePath = path.join(kiciDir, '.gitignore');
  if (await checkExists(gitignorePath)) {
    logger.info(pc.gray('Skipping .kici/.gitignore (already exists)'));
    return;
  }
  logger.info(pc.gray('Writing .kici/.gitignore'));
  await writeFile(gitignorePath, KICI_GITIGNORE_TEMPLATE, 'utf-8');
}

/**
 * Rendered from `KICI_DIGEST_DEFAULT_EXCLUSIONS`, not a hand-typed list: the
 * file replaces the defaults rather than merging with them, so a stale
 * template would make the hash unstable, not merely drift cosmetically.
 */
function buildKiciIgnoreTemplate(): string {
  return [
    '# Paths the workflow source digest does NOT cover.',
    '#',
    '# This file IS the exclusion list: it replaces the built-in defaults rather',
    '# than adding to them. The entries below are those defaults. Removing one',
    '# re-includes that path in the hash — and node_modules/, .npmrc and',
    '# package-lock.json are rewritten during a run, so dropping one makes the',
    '# hash change on every run and the drift gate reject it. `kici compile`',
    '# warns when that happens.',
    '#',
    '# Patterns are gitignore-style, relative to .kici/. Unrelated to the',
    '# repo-root .kiciignore, which selects what `kici run --remote` uploads.',
    '#',
    '# This file is itself hashed: which files define a workflow identity is',
    '# part of that identity, so editing it forces a recompile.',
    '',
    ...KICI_DIGEST_DEFAULT_EXCLUSIONS,
    '',
  ].join('\n');
}

/**
 * Never overwrites an existing file (the customer may have tuned it), and
 * never runs from `kici compile`: a compile writing into the tree it hashes is
 * the hazard the exclusion set exists to close.
 */
export async function writeKiciIgnore(kiciDir: string): Promise<void> {
  const kiciIgnorePath = path.join(kiciDir, KICI_IGNORE_FILENAME);
  if (await checkExists(kiciIgnorePath)) {
    logger.info(pc.gray(`Skipping .kici/${KICI_IGNORE_FILENAME} (already exists)`));
    return;
  }
  logger.info(pc.gray(`Writing .kici/${KICI_IGNORE_FILENAME}`));
  await writeFile(kiciIgnorePath, buildKiciIgnoreTemplate(), 'utf-8');
}

/**
 * Appends missing .kici/ entries; a no-op when a broad `.kici/` pattern is
 * already present.
 *
 * @param useVerdaccio - When true, also adds .npmrc entries for .kici/ and root
 */
async function updateGitignore(useVerdaccio: boolean): Promise<void> {
  const gitignorePath = path.resolve('.gitignore');
  const entries = ['.kici/node_modules/', '.kici/.secrets'];
  if (useVerdaccio) {
    entries.push('.kici/.npmrc', '.npmrc');
  }

  let content = '';
  const gitignoreExists = await checkExists(gitignorePath);
  if (gitignoreExists) {
    content = await readFile(gitignorePath, 'utf-8');
  }

  const lines = content.split('\n');

  const broadCoverage = lines.some((line) => {
    const trimmed = line.trim();
    return trimmed === '.kici/' || trimmed === '.kici/*';
  });

  if (broadCoverage) {
    return;
  }

  let newContent = content;
  for (const entry of entries) {
    const alreadyPresent = lines.some((line) => {
      const trimmed = line.trim();
      return trimmed === entry || trimmed === entry.replace(/\/$/, '');
    });

    if (!alreadyPresent) {
      newContent =
        newContent.endsWith('\n') || newContent === ''
          ? newContent + entry + '\n'
          : newContent + '\n' + entry + '\n';
    }
  }

  await writeFile(gitignorePath, newContent, 'utf-8');
}

/**
 * Both files are inert until the customer wires them up. Existing files are
 * never overwritten.
 */
async function writePrivateRegistryScaffold(
  kiciDir: string,
  args: { url: string; scope?: string; secretRef: string },
): Promise<void> {
  const scopeLine = args.scope ? `\n      scope: '${args.scope}',` : '';
  const npmrcScopeLine = args.scope
    ? `${args.scope}:registry=${args.url}\n`
    : `registry=${args.url}\n`;
  const url = args.url.replace(/\/+$/, '');

  const workflowExample = `// Example: workflow declaring a private npm registry.
// Copy or adapt into a real workflow under .kici/workflows/.
//
// The agent renders these into the .kici/.npmrc before running \`npm install\`.
// The token is resolved from the qualified secret reference at dispatch time
// (the orchestrator looks it up under the named context's scoped secrets).
import { workflow, job, step } from '@kici-dev/sdk';

export default workflow('private-registry-example', {
  registries: [
    {
      url: '${args.url}',${scopeLine}
      tokenSecret: '${args.secretRef}',
    },
  ],
  jobs: [
    job('build', {
      runsOn: 'kici:os:linux',
      steps: [step('install', async () => { /* deps install with auth */ })],
    }),
  ],
});
`;

  const npmrcExample = `# Example .kici/.npmrc using the option C escape hatch.
# Customer commits this file (without secret values), declares
# \`installEnv: ['<env>:<NAME>']\` on the workflow to project the
# secret as an env var on the install subprocess, and npm's native
# \${VAR} substitution does the rest.
${npmrcScopeLine}//${url.replace(/^https?:\/\//, '')}/:_authToken=\${MY_NPM_TOKEN}
`;

  const examplePath = path.join(kiciDir, 'workflows', 'private-registry-example.ts.example');
  if (await checkExists(examplePath)) {
    logger.info(
      pc.gray('Skipping .kici/workflows/private-registry-example.ts.example (already exists)'),
    );
  } else {
    logger.info(pc.gray('Writing .kici/workflows/private-registry-example.ts.example'));
    await writeFile(examplePath, workflowExample, 'utf-8');
  }

  const npmrcPath = path.join(kiciDir, '.npmrc.example');
  if (await checkExists(npmrcPath)) {
    logger.info(pc.gray('Skipping .kici/.npmrc.example (already exists)'));
  } else {
    logger.info(pc.gray('Writing .kici/.npmrc.example'));
    await writeFile(npmrcPath, npmrcExample, 'utf-8');
  }
}

/** Repo-root .kiciignore: what `kici run --remote` uploads. */
const kiciIgnoreTemplate = `node_modules/
.git/
dist/
coverage/
*.log
`;

/** The flag wins; otherwise prompt in TTY mode (default Y), write in CI / non-TTY. */
async function shouldWriteAgentsMd(options: InitOptions): Promise<boolean> {
  if (options.noAgentsMd) return false;
  if (!process.stdout.isTTY || isCiEnvironment()) return true;
  return await confirm({
    message: 'Add LLM authoring context (.kici/AGENTS.md)?',
    default: true,
  });
}

/** Never overwrites an existing file: the customer may have hand-edited it. */
async function writeAgentsMd(kiciDir: string): Promise<void> {
  const target = path.join(kiciDir, 'AGENTS.md');
  if (await checkExists(target)) {
    logger.info(pc.gray('Skipping .kici/AGENTS.md (already exists)'));
    return;
  }
  logger.info(pc.gray('Writing .kici/AGENTS.md'));
  await writeFile(target, agentsMdTemplate, 'utf-8');
}

async function offerHookInstallation(useVerdaccio: boolean): Promise<void> {
  const tools = await detectHookTools();

  let selectedTool: HookToolName;

  if (tools.length === 0) {
    const useHusky = await confirm({
      message: 'No pre-commit tool found. Install husky for git hooks?',
      default: false,
    });

    if (!useHusky) {
      const useGitHook = await confirm({
        message: 'Add kici compile to .git/hooks/pre-commit instead?',
        default: false,
      });

      if (!useGitHook) {
        return;
      }
      selectedTool = 'git';
    } else {
      // Installer handles husky init via `npx husky init`
      selectedTool = 'husky';
    }
  } else if (tools.length === 1) {
    const install = await confirm({
      message: `Found ${tools[0].name}. Add kici compile hook?`,
      default: true,
    });

    if (!install) {
      return;
    }
    selectedTool = tools[0].name;
  } else {
    const tool = await select({
      message: 'Multiple pre-commit tools detected. Which would you like to use?',
      choices: tools.map((t) => ({
        name: t.name,
        value: t.name,
      })),
    });

    selectedTool = tool as HookToolName;
  }

  const result = await installHook(selectedTool, { useVerdaccio });

  if (result.success) {
    if (result.action === 'skipped') {
      logger.info(pc.yellow(`Hook already installed: ${result.message}`));
    } else {
      logger.info(pc.green(`Hook installed: ${result.message}`));
    }
  } else {
    logger.warn(pc.yellow(`Warning: ${result.message}`));
  }
}
