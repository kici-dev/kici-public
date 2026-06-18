/**
 * kici init command
 *
 * Creates .kici/ directory structure with workflow templates.
 * Supports TypeScript mode (with package.json/node_modules) and MJS mode (pure JS).
 */

import { readFile, writeFile, mkdir, access, rm } from 'node:fs/promises';
import path from 'node:path';
import { $ } from 'zx';
import pc from 'picocolors';
import { checkbox, confirm, select } from '@inquirer/prompts';
import { initZx, logger, toErrorMessage } from '@kici-dev/core';
import {
  workflowPaths,
  generatePackageJson,
  tsconfigTemplate,
  agentsMdTemplate,
} from '../templates/index.js';
import { getTypeScriptPaths } from '../execution/sdk-alias.js';
import { detectHookTools, installHook, findGitDir } from '../hooks/index.js';
import type { HookToolName } from '../hooks/index.js';
import {
  PackageManager,
  detectPackageManager,
  installBuildPolicyArgs,
  installCommand,
  parsePackageManager,
} from '@kici-dev/core/package-manager';

/**
 * Options for init command
 */
export interface InitOptions {
  /** Overwrite existing .kici/ directory */
  force?: boolean;
  /** Skip the dependency install step */
  skipInstall?: boolean;
  /**
   * Force a specific package manager for the install step, bypassing detection.
   * One of `npm` / `pnpm` / `yarn`.
   */
  packageManager?: string;
  /** JavaScript-only mode (no TypeScript, no dependencies) */
  mjs?: boolean;
  /** Write .npmrc pointing @kici-dev scope to local Verdaccio */
  useVerdaccioLocal?: boolean;
  /** Private registry URL to scaffold a `registries:` entry for. */
  privateRegistry?: string;
  /** Optional npm scope (e.g. `@my-org`) the private registry serves. */
  privateRegistryScope?: string;
  /** Qualified secret reference (`env:NAME`) the private registry token comes from. */
  privateRegistrySecret?: string;
  /** Skip writing the .kici/AGENTS.md LLM-authoring context file. Default: write it. */
  noAgentsMd?: boolean;
}

/**
 * Initialize .kici/ directory with workflow templates
 *
 * @param options - Configuration options for initialization
 * @returns true on success, false on error
 */
export async function initCommand(options: InitOptions = {}): Promise<boolean> {
  initZx();
  try {
    const kiciDir = path.resolve('.kici');

    // Check for existing directory
    const exists = await checkExists(kiciDir);
    if (exists && !options.force) {
      logger.error(pc.red('\nError: .kici/ directory already exists.'));
      logger.error(pc.gray('Use --force to overwrite.\n'));
      return false;
    }

    if (exists && options.force) {
      logger.info(pc.yellow('Removing existing .kici/ directory...'));
      await rm(kiciDir, { recursive: true, force: true });
    }

    // Select workflows (interactive in TTY mode)
    const workflows = await selectWorkflows();

    // Create directory structure
    logger.info(pc.cyan('\nInitializing kici...\n'));
    logger.info(pc.gray('Creating .kici/'));
    await mkdir(kiciDir, { recursive: true });
    logger.info(pc.gray('Creating .kici/workflows/'));
    await mkdir(path.join(kiciDir, 'workflows'), { recursive: true });

    // Detect the default branch for template customization
    const defaultBranch = await detectDefaultBranch();

    // Write workflow templates
    for (const workflow of workflows) {
      logger.info(pc.gray(`Writing .kici/workflows/${workflow}.ts`));
      const sourcePath = workflowPaths[workflow as keyof typeof workflowPaths];
      let content = await readFile(sourcePath, 'utf-8');
      if (defaultBranch !== 'main') {
        content = content.replaceAll("targeting('main')", `targeting('${defaultBranch}')`);
        content = content.replaceAll(
          'targeting the main branch',
          `targeting the ${defaultBranch} branch`,
        );
      }
      await writeFile(path.join(kiciDir, 'workflows', `${workflow}.ts`), content, 'utf-8');
    }

    // Create sample test fixture
    logger.info(pc.gray('Creating .kici/tests/'));
    await mkdir(path.join(kiciDir, 'tests'), { recursive: true });
    logger.info(pc.gray('Writing .kici/tests/push-test.ts'));
    const fixtureContent = generateSampleFixture(defaultBranch);
    await writeFile(path.join(kiciDir, 'tests', 'push-test.ts'), fixtureContent, 'utf-8');
    logger.info(pc.green('Created sample test fixture at .kici/tests/push-test.ts'));

    // Create .kiciignore with sensible defaults
    const kiciIgnorePath = path.resolve('.kiciignore');
    if (!(await checkExists(kiciIgnorePath))) {
      logger.info(pc.gray('Writing .kiciignore'));
      await writeFile(kiciIgnorePath, kiciIgnoreTemplate, 'utf-8');
    }

    // Always generate package.json (required for dependency caching)
    const devMode = options.useVerdaccioLocal || (await detectDevelopmentMode());
    logger.info(pc.gray('Writing .kici/package.json'));
    const pkgContent = generatePackageJson(devMode);
    await writeFile(path.join(kiciDir, 'package.json'), pkgContent, 'utf-8');

    // Write .npmrc to point @kici-dev scope to local Verdaccio
    const useVerdaccio = devMode;
    if (useVerdaccio) {
      logger.info(pc.yellow('Pointing @kici-dev to local Verdaccio registry.'));
      const npmrc = '@kici-dev:registry=http://verdaccio.local:4873\n';
      await writeFile(path.join(kiciDir, '.npmrc'), npmrc, 'utf-8');
      // Root .npmrc so npm install in .kici/ resolves the scope
      const rootNpmrc = path.resolve('.npmrc');
      if (!(await checkExists(rootNpmrc))) {
        logger.info(pc.gray('Writing .npmrc (Verdaccio scope)'));
        await writeFile(rootNpmrc, npmrc, 'utf-8');
      }
    }

    // TypeScript mode: tsconfig.json, npm install
    if (!options.mjs) {
      logger.info(pc.gray('Writing .kici/tsconfig.json'));
      const tsconfigContent = await generateTsConfig();
      await writeFile(path.join(kiciDir, 'tsconfig.json'), tsconfigContent, 'utf-8');

      // Create types directory for kici types output
      const typesDir = path.join(kiciDir, 'types');
      await mkdir(typesDir, { recursive: true });
      logger.info(pc.gray('Created .kici/types/ for generated type declarations'));

      if (!options.skipInstall) {
        const pm = await resolvePackageManager(options.packageManager);
        const [bin, action] = installCommand(pm);
        const buildPolicyArgs = installBuildPolicyArgs(pm);
        logger.info(pc.gray(`Running ${bin} ${action}...`));
        // Run the detected package manager's install in .kici/ directory.
        await $`cd ${kiciDir} && ${bin} ${action} ${buildPolicyArgs}`;
      }
    }

    // Private registry scaffolding (option A workflow snippet + option C .npmrc.example)
    if (options.privateRegistry) {
      await writePrivateRegistryScaffold(kiciDir, {
        url: options.privateRegistry,
        scope: options.privateRegistryScope,
        secretRef: options.privateRegistrySecret ?? 'production:NPM_TOKEN',
      });
    }

    // Optional LLM-authoring context file
    if (await shouldWriteAgentsMd(options)) {
      await writeAgentsMd(kiciDir);
    }

    // Update .gitignore
    logger.info(pc.gray('Updating .gitignore'));
    await updateGitignore(useVerdaccio);

    // Offer hook installation (only in interactive mode and git repos)
    if (process.stdout.isTTY && process.env.CI !== 'true') {
      const gitDir = await findGitDir();
      if (gitDir) {
        await offerHookInstallation(useVerdaccio);
      }
    }

    logger.info(pc.green('\n✓ kici initialized successfully!\n'));
    logger.info(pc.gray('Next steps:'));
    logger.info(pc.gray('  1. Edit workflows in .kici/workflows/'));
    if (options.mjs || options.skipInstall) {
      logger.info(
        pc.gray('  2. Run your package manager install in .kici/ to generate a lockfile'),
      );
      logger.info(pc.gray('  3. Test locally: kici test push'));
      logger.info(pc.gray('  4. Commit .kici/ to your repository\n'));
    } else {
      logger.info(pc.gray('  2. Test locally: kici test push'));
      logger.info(pc.gray('  3. Commit .kici/ to your repository\n'));
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

/**
 * Check if a path exists
 *
 * @param targetPath - Path to check
 * @returns true if exists, false otherwise
 */
async function checkExists(targetPath: string): Promise<boolean> {
  try {
    await access(targetPath);
    return true;
  } catch {
    return false;
  }
}

/**
 * Select which workflows to include
 *
 * Interactive in TTY mode, defaults to all workflows in non-TTY/CI.
 *
 * @returns Array of workflow names to include
 */
async function selectWorkflows(): Promise<string[]> {
  // Non-interactive: CI or non-TTY
  if (!process.stdout.isTTY || process.env.CI === 'true') {
    return ['hello-world', 'pr-checks'];
  }

  // Interactive prompt
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

  // Ensure at least one selected
  if (selected.length === 0) {
    return ['hello-world']; // Default if user deselects all
  }

  return selected;
}

/**
 * Detect the default branch of the current git repository.
 *
 * Tries in order:
 * 1. git symbolic-ref refs/remotes/origin/HEAD (set after clone)
 * 2. Current branch (HEAD)
 * 3. Falls back to 'main'
 */
async function detectDefaultBranch(): Promise<string> {
  try {
    const result = await $`git symbolic-ref refs/remotes/origin/HEAD`.quiet();
    // Returns e.g. "refs/remotes/origin/master\n"
    const ref = result.stdout.trim();
    const branch = ref.replace('refs/remotes/origin/', '');
    if (branch) return branch;
  } catch {
    // origin/HEAD not set (e.g. git init without remote)
  }

  try {
    const result = await $`git rev-parse --abbrev-ref HEAD`.quiet();
    const branch = result.stdout.trim();
    if (branch && branch !== 'HEAD') return branch;
  } catch {
    // Not a git repo or detached HEAD
  }

  return 'main';
}

/**
 * Detect if running in development mode
 *
 * Development mode uses workspace:* dependencies for local testing.
 * Checks:
 * 1. KICI_DEV environment variable
 * 2. Root package.json kici.development flag
 *
 * @returns true if in development mode
 */
async function detectDevelopmentMode(): Promise<boolean> {
  // Method 1: Environment variable
  if (process.env.KICI_DEV === 'true') {
    return true;
  }

  // Method 2: Check root package.json for kici.development flag
  try {
    const rootPkgPath = path.resolve(process.cwd(), 'package.json');
    const content = await readFile(rootPkgPath, 'utf-8');
    const pkg = JSON.parse(content) as { kici?: { development?: boolean } };
    return pkg.kici?.development === true;
  } catch {
    // Root package.json doesn't exist or can't be read
    return false;
  }
}

/**
 * Resolve which package manager to use for the dependency install step.
 *
 * An explicit `--package-manager <name>` flag wins and short-circuits
 * detection; an invalid value throws so the user sees a clear error. With no
 * flag, fall back to {@link detectPackageManager} over the current working
 * directory (npm / pnpm / yarn signals, defaulting to npm).
 *
 * @param override - The raw `--package-manager` flag value, if provided.
 */
async function resolvePackageManager(override?: string): Promise<PackageManager> {
  if (override) {
    const parsed = parsePackageManager(override);
    if (!parsed) {
      throw new Error(
        `Invalid --package-manager value '${override}'. Expected one of: npm, pnpm, yarn.`,
      );
    }
    return parsed;
  }
  return detectPackageManager(process.cwd());
}

/**
 * Generate tsconfig.json content with optional TypeScript path mappings.
 *
 * If sdkPath is configured in .kici/package.json, adds path mapping
 * to enable IDE autocomplete from local SDK source.
 *
 * @returns tsconfig.json content as string
 */
async function generateTsConfig(): Promise<string> {
  const typeScriptPaths = await getTypeScriptPaths();

  if (!typeScriptPaths) {
    // No path mappings, return base template
    return tsconfigTemplate;
  }

  // Parse base template and add paths
  const baseConfig = JSON.parse(tsconfigTemplate);
  baseConfig.compilerOptions.paths = typeScriptPaths;

  return JSON.stringify(baseConfig, null, 2) + '\n';
}

/**
 * Update .gitignore with .kici/ entries
 *
 * Safely appends to .gitignore, checking for existing entries to avoid duplicates.
 * Handles cases where .gitignore doesn't exist or already has broader patterns.
 *
 * @param useVerdaccio - When true, also adds .npmrc entries for .kici/ and root
 */
async function updateGitignore(useVerdaccio: boolean): Promise<void> {
  const gitignorePath = path.resolve('.gitignore');
  const entries = ['.kici/node_modules/', '.kici/.secrets'];
  if (useVerdaccio) {
    entries.push('.kici/.npmrc', '.npmrc');
  }

  // Read existing .gitignore (or empty string if doesn't exist)
  let content = '';
  const gitignoreExists = await checkExists(gitignorePath);
  if (gitignoreExists) {
    content = await readFile(gitignorePath, 'utf-8');
  }

  const lines = content.split('\n');

  // Check if broader pattern already covers everything
  const broadCoverage = lines.some((line) => {
    const trimmed = line.trim();
    return trimmed === '.kici/' || trimmed === '.kici/*';
  });

  if (broadCoverage) {
    return; // Already covered, don't duplicate
  }

  // Add each entry that isn't already present
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
 * Scaffolds a private-registry example workflow + a `.kici/.npmrc.example`.
 * Both files are inert by default — the customer wires them up after editing.
 * Existing files are never overwritten.
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
// (the orchestrator looks it up under the named environment's scoped secrets).
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

/**
 * Generate sample test fixture content.
 * Uses the detected default branch for realistic fixture configuration.
 */
function generateSampleFixture(defaultBranch: string): string {
  return `import { fixture, push } from '@kici-dev/sdk';

/**
 * Sample test fixture: push to ${defaultBranch} branch.
 *
 * Run with: kici run remote push-${defaultBranch}
 * List all:  kici run remote
 */
export const push${capitalize(defaultBranch)} = fixture('push-${defaultBranch}', {
  event: push({ branches: ['${defaultBranch}'] }),
});
`;
}

/**
 * Capitalize the first letter of a string.
 */
function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/** Default .kiciignore content */
const kiciIgnoreTemplate = `node_modules/
.git/
dist/
coverage/
*.log
`;

/**
 * Decide whether to scaffold .kici/AGENTS.md. The flag wins; otherwise we
 * prompt in TTY mode (default Y) and default to writing in CI / non-TTY.
 */
async function shouldWriteAgentsMd(options: InitOptions): Promise<boolean> {
  if (options.noAgentsMd) return false;
  if (!process.stdout.isTTY || process.env.CI === 'true') return true;
  return await confirm({
    message: 'Add LLM authoring context (.kici/AGENTS.md)?',
    default: true,
  });
}

/**
 * Write the AGENTS.md template. Never overwrites an existing file — the
 * customer may have hand-edited it for their project.
 */
async function writeAgentsMd(kiciDir: string): Promise<void> {
  const target = path.join(kiciDir, 'AGENTS.md');
  if (await checkExists(target)) {
    logger.info(pc.gray('Skipping .kici/AGENTS.md (already exists)'));
    return;
  }
  logger.info(pc.gray('Writing .kici/AGENTS.md'));
  await writeFile(target, agentsMdTemplate, 'utf-8');
}

/**
 * Offer to install pre-commit hook.
 * Detects existing hook tools and prompts user.
 */
async function offerHookInstallation(useVerdaccio: boolean): Promise<void> {
  const tools = await detectHookTools();

  // Determine which tool to use
  let selectedTool: HookToolName;

  if (tools.length === 0) {
    // No hook tool detected - offer raw git hook or husky
    const useHusky = await confirm({
      message: 'No pre-commit tool found. Install husky for git hooks?',
      default: false,
    });

    if (!useHusky) {
      // Offer raw git hook
      const useGitHook = await confirm({
        message: 'Add kici compile to .git/hooks/pre-commit instead?',
        default: false,
      });

      if (!useGitHook) {
        return; // User declined both options
      }
      selectedTool = 'git';
    } else {
      // Installer handles husky init via `npx husky init`
      selectedTool = 'husky';
    }
  } else if (tools.length === 1) {
    // Single tool detected - confirm installation
    const install = await confirm({
      message: `Found ${tools[0].name}. Add kici compile hook?`,
      default: true,
    });

    if (!install) {
      return;
    }
    selectedTool = tools[0].name;
  } else {
    // Multiple tools detected - let user choose
    const tool = await select({
      message: 'Multiple pre-commit tools detected. Which would you like to use?',
      choices: tools.map((t) => ({
        name: t.name,
        value: t.name,
      })),
    });

    selectedTool = tool as HookToolName;
  }

  // Install the hook
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
