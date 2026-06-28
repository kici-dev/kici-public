#!/usr/bin/env node
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { realpathSync } from 'node:fs';

import { Command, Argument, Option } from 'commander';
import pc from 'picocolors';
import { shouldSuppressBanner } from './cli-banner.js';

declare const KICI_VERSION: string;
const version = typeof KICI_VERSION !== 'undefined' ? KICI_VERSION : '0.0.1';

/**
 * Build the kici Commander program with every command registered. Exported so
 * the surface registry can walk the real command tree without parsing argv (no
 * action runs during a tree walk).
 */
export function buildProgram(): Command {
  const program = new Command();

  program.name('kici').description('KiCI workflow compiler').version(version);

  // Print version header before every command, unless the invocation requested
  // structured (`--json`) or quiet output — stdout must stay parseable then.
  program.hook('preAction', (_thisCommand, actionCommand) => {
    if (shouldSuppressBanner(actionCommand)) return;
    console.log(pc.gray(`kici v${version}`));
  });

  // Configure custom error output
  program.configureOutput({
    outputError: (str, write) => {
      write(pc.red(str));
    },
  });

  program
    .command('compile')
    .description('Compile workflows from .kici/workflows/ to kici.lock.json')
    .option('--check', 'Validate workflows without writing lock file', false)
    .option('--kici-dir <path>', 'Path to .kici directory', '.kici')
    .option('--verbose', 'Detailed output', false)
    .option('--watch', 'Watch for changes and recompile', false)
    .action(async (options) => {
      const { compileCommand, watchCommand } = await import('./commands/index.js');
      if (options.watch) {
        // Watch mode - runs indefinitely
        await watchCommand({
          kiciDir: options.kiciDir,
          verbose: options.verbose,
        });
        // watchCommand handles its own exit
      } else {
        // Single compilation
        const success = await compileCommand({
          kiciDir: options.kiciDir,
          check: options.check,
          verbose: options.verbose,
        });
        process.exit(success ? 0 : 1);
      }
    });

  const fixtureEventArg = new Argument(
    '<event>',
    'Event to generate fixture for (e.g., pr:open, push, schedule, lifecycle:workflow_complete)',
  );

  program
    .command('fixture')
    .addArgument(fixtureEventArg)
    .description('Generate fixture template for event type')
    .option('--output <path>', 'Write to file instead of stdout')
    .action(async (event, options) => {
      const { fixtureCommand } = await import('./commands/index.js');
      await fixtureCommand(event, options);
    });

  // --- kici run (local and remote subcommands) ---

  const runCommand = program.command('run').description('Execute workflows locally or remotely');

  runCommand
    .command('local')
    .argument('[event]', 'Event type (e.g., push, pr:open, schedule) — optional with --pick')
    .description('Execute workflows locally without orchestrator infrastructure')
    .option('-p, --pick', 'Interactively pick a workflow and trigger to simulate', false)
    .option('--workflow <name>', 'Run only the specified workflow')
    .option('--job <name>', 'Run only the specified job (and its dependencies)')
    .option('--branch <name>', 'Override detected git branch')
    .option('--sha <hash>', 'Override detected git SHA')
    .option('--payload <path>', 'Path to explicit event payload JSON file')
    .option('--concurrency <n>', 'Max parallel jobs (default: CPU cores)', parseInt)
    .option('--keep-going', 'Continue after job failure', false)
    .option('--container', 'Use Podman container isolation', false)
    .option(
      '--env <KEY=VALUE>',
      'Environment variable override (repeatable)',
      (val: string, prev: string[]) => [...prev, val],
      [] as string[],
    )
    .option(
      '--input <KEY=VALUE>',
      'Typed workflow-dispatch input (repeatable)',
      (val: string, prev: string[]) => [...prev, val],
      [] as string[],
    )
    .option('--quiet', 'Suppress streaming output', false)
    .option('--json', 'Output structured JSON result', false)
    .option('--junit <path>', 'Output JUnit XML result')
    .option(
      '--files <path>',
      'Override changed file paths (repeatable, default: git diff)',
      (val: string, prev: string[]) => [...prev, val],
      [] as string[],
    )
    .option('--debug', 'Verbose internals', false)
    .option('--kici-dir <path>', 'Path to .kici directory', '.kici')
    .option(
      '--in-place',
      'Run against the real working directory instead of an isolated tmp checkout',
      false,
    )
    .option(
      '--keep',
      'Always retain the isolated tmp checkout (default: keep only on failure)',
      false,
    )
    .option('--check', 'Run in check mode: report drift, change nothing', false)
    .option('--fail-on-drift', 'In check mode, exit non-zero if any step reports drift', false)
    .action(async (event, options) => {
      if (options.pick && options.workflow) {
        console.error('Error: --pick is mutually exclusive with --workflow.');
        process.exit(2);
      }
      if (!options.pick && !event) {
        console.error('Error: missing event argument. Pass an event or use --pick.');
        process.exit(2);
      }
      const { runLocalCommand } = await import('./commands/index.js');
      const { resolveCheckMode } = await import('./commands/check-mode.js');
      let checkMode;
      try {
        checkMode = resolveCheckMode({ check: options.check, failOnDrift: options.failOnDrift });
      } catch (err) {
        console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
        process.exit(2);
      }
      const success = await runLocalCommand({
        event,
        checkMode,
        pick: options.pick,
        workflow: options.workflow,
        job: options.job,
        branch: options.branch,
        sha: options.sha,
        payload: options.payload,
        concurrency: options.concurrency,
        keepGoing: options.keepGoing,
        container: options.container,
        env: options.env,
        inputs: options.input,
        quiet: options.quiet,
        json: options.json,
        junit: options.junit,
        files: options.files,
        debug: options.debug,
        kiciDir: options.kiciDir,
        inPlace: options.inPlace,
        keep: options.keep,
      });
      process.exit(success ? 0 : 1);
    });

  runCommand
    .command('remote')
    .argument('[fixture]', 'Fixture name or glob pattern (omit to list available)')
    .description('Execute fixtures remotely via orchestrator')
    .option('--workflow <name>', 'Run a specific workflow directly (bypass triggers)')
    .option('--all', 'Run all available fixtures', false)
    .option('-p, --pick', 'Interactively pick fixtures to run', false)
    .option('--parallel', 'Run matching fixtures concurrently', false)
    .option('--no-wait', "Fire and forget (print runIds, don't stream)")
    .option('--quiet', 'Suppress output except final result', false)
    .option('--json', 'Output structured JSON result', false)
    .option('--junit <path>', 'Output JUnit XML result')
    .option('--history', 'Show recent run history', false)
    .option('--routing-key <key>', 'Override routing key for this run')
    .option('--org <id>', 'Target organization (overrides the active org)')
    .option('--orchestrator <name>', 'Target orchestrator cluster (overrides the per-org default)')
    .option('--debug', 'Verbose internals', false)
    .option('--kici-dir <path>', 'Path to .kici directory', '.kici')
    .option(
      '--context <ctx.key=value>',
      'Inject a namespaced context secret, uploaded encrypted to the orchestrator (repeatable)',
      (val: string, prev: string[]) => [...prev, val],
      [] as string[],
    )
    .option(
      '--env <KEY=VALUE>',
      'Provide a per-run secret (repeatable); uploaded encrypted to the orchestrator',
      (val: string, prev: string[]) => [...prev, val],
      [] as string[],
    )
    .option('--check', 'Run in check mode: report drift, change nothing', false)
    .option('--fail-on-drift', 'In check mode, exit non-zero if any step reports drift', false)
    .option(
      '--target <selector>',
      'Narrow runsOnAll jobs to hosts matching this label selector (repeatable, AND-combined)',
      (val: string, prev: string[]) => [...prev, val],
      [] as string[],
    )
    .option(
      '--target-allow-empty',
      'A --target that narrows a runsOnAll job to zero hosts skips it instead of failing',
      false,
    )
    .option(
      '--input <KEY=VALUE>',
      'Typed workflow-dispatch input (repeatable)',
      (val: string, prev: string[]) => [...prev, val],
      [] as string[],
    )
    .option(
      '--approve-all, --yes',
      'Auto-approve every approval gate this run holds on (run-scoped; eligibility still enforced)',
      false,
    )
    .action(async (fixture, options) => {
      if (options.pick && fixture) {
        console.error(
          'Error: --pick selects fixtures interactively; do not also pass a fixture name.',
        );
        process.exit(2);
      }
      if (options.pick && options.all) {
        console.error('Error: --pick is mutually exclusive with --all.');
        process.exit(2);
      }
      if (options.pick && options.workflow) {
        console.error('Error: --pick is mutually exclusive with --workflow.');
        process.exit(2);
      }
      const { runRemoteCommand } = await import('./commands/index.js');
      const { resolveCheckMode } = await import('./commands/check-mode.js');
      let checkMode;
      try {
        checkMode = resolveCheckMode({ check: options.check, failOnDrift: options.failOnDrift });
      } catch (err) {
        console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
        process.exit(2);
      }
      const success = await runRemoteCommand(fixture, {
        ...options,
        checkMode,
        envFlags: options.env,
        targets: options.target,
        targetAllowEmpty: options.targetAllowEmpty,
        approveAll: options.approveAll,
        inputs: options.input,
      });
      process.exit(success ? 0 : 1);
    });

  // --- kici preview (dry-run trigger preview only) ---

  program
    .command('preview')
    .argument('[event]', 'Event type to preview (e.g., push, pr:open, schedule)')
    .description('Preview which workflows match a trigger event (no execution)')
    .option('--branch <name>', 'Override target branch for trigger matching (default: main)')
    .option('--sha <hash>', 'Override commit SHA')
    .option('--workflow <name>', 'Filter to specific workflow in display')
    .option('--job <name>', 'Filter to specific job in display')
    .option('--debug', 'Verbose internals', false)
    .option('--kici-dir <path>', 'Path to .kici directory', '.kici')
    .option(
      '--files <path>',
      'Simulate changed file path for trigger matching (repeatable)',
      (val: string, prev: string[]) => [...prev, val],
      [] as string[],
    )
    .option(
      '--secret <key=value>',
      'Inject flat secret (repeatable)',
      (val: string, prev: string[]) => [...prev, val],
      [] as string[],
    )
    .option(
      '--context <ctx.key=value>',
      'Inject context secret (repeatable)',
      (val: string, prev: string[]) => [...prev, val],
      [] as string[],
    )
    .action(async (event, options) => {
      const { previewCommand } = await import('./commands/index.js');
      const success = await previewCommand(event, options);
      process.exit(success ? 0 : 1);
    });

  program
    .command('init')
    .description('Initialize .kici/ directory with default workflows')
    .option('--force', 'Overwrite existing .kici/ directory', false)
    .option('--skip-install', 'Create files without installing dependencies', false)
    .option(
      '--package-manager <npm|pnpm|yarn>',
      'Force a package manager for the install step (default: auto-detect)',
    )
    .option('--mjs', 'JavaScript-only mode (no TypeScript, no dependencies)', false)
    .option('--no-agents-md', 'Skip writing .kici/AGENTS.md (LLM authoring context)')
    .option('--private-registry <url>', 'Scaffold a workflow registries: entry pointing at <url>')
    .option(
      '--private-registry-scope <scope>',
      'Optional npm package scope (e.g. @my-org) for the private registry',
    )
    .option(
      '--private-registry-secret <ref>',
      'Qualified secret reference (env:NAME) the private registry token comes from',
      'production:NPM_TOKEN',
    )
    .addOption(new Option('--use-verdaccio-local').default(false).hideHelp())
    .action(async (options) => {
      const { initCommand } = await import('./commands/index.js');
      // commander turns `--no-agents-md` into options.agentsMd=false when the flag
      // is passed (true by default). Translate to the InitOptions field shape.
      const success = await initCommand({
        ...options,
        noAgentsMd: options.agentsMd === false,
      });
      process.exit(success ? 0 : 1);
    });

  const hookCommand = program.command('hook').description('Manage pre-commit hooks');

  hookCommand
    .command('install')
    .description('Install kici compile pre-commit hook')
    .option('--git', 'Use raw git hook (.git/hooks/pre-commit)', false)
    .action(async (options) => {
      const { hookInstallCommand } = await import('./commands/index.js');
      const success = await hookInstallCommand({
        git: options.git,
      });
      process.exit(success ? 0 : 1);
    });

  program
    .command('login')
    .description('Authenticate with KiCI via browser OAuth (default) or API key (--token)')
    .option('--token <key>', 'API key for direct authentication (legacy)')
    .option('--device', 'Force device authorization flow (for headless/SSH environments)')
    .option('--platform-endpoint <url>', 'Platform relay URL')
    .option(
      '--oidc-issuer <url>',
      'OIDC issuer URL (defaults to the hosted KiCI IdP unless a flag/env selects another)',
    )
    .option('--routing-key <key>', 'Routing key for webhook source identification')
    .addHelpText(
      'after',
      `
Environment variables:
  KICI_BROWSER_CMD     Custom browser command (use {url} placeholder, or 'none' to suppress)
  KICI_CALLBACK_PORT   Fixed port for OAuth PKCE callback server (default: random)
  KICI_CONFIG_DIR      Override config directory (default: ~/.kici)
  KICI_OIDC_ISSUER     Override OIDC issuer URL
  KICI_OIDC_CLIENT_ID  Override OIDC client ID
`,
    )
    .action(async (options) => {
      const { loginCommand } = await import('./commands/index.js');
      const success = await loginCommand({
        token: options.token,
        device: options.device,
        platformEndpoint: options.platformEndpoint,
        oidcIssuer: options.oidcIssuer,
        routingKey: options.routingKey,
      });
      process.exit(success ? 0 : 1);
    });

  program
    .command('logout')
    .description('Revoke PAT and clear local credentials')
    .action(async () => {
      const { logoutCommand } = await import('./commands/index.js');
      const success = await logoutCommand();
      process.exit(success ? 0 : 1);
    });

  const orgCommand = program.command('org').description('Manage organizations');

  orgCommand
    .command('list')
    .description('List organizations you belong to')
    .action(async () => {
      const { orgListCommand } = await import('./commands/index.js');
      const success = await orgListCommand();
      process.exit(success ? 0 : 1);
    });

  orgCommand
    .command('use')
    .argument('<name>', 'Organization name or ID')
    .description('Switch active organization')
    .action(async (name) => {
      const { orgUseCommand } = await import('./commands/index.js');
      const success = await orgUseCommand(name);
      process.exit(success ? 0 : 1);
    });

  orgCommand
    .command('current')
    .description('Show current active organization')
    .action(async () => {
      const { orgCurrentCommand } = await import('./commands/index.js');
      const success = await orgCurrentCommand();
      process.exit(success ? 0 : 1);
    });

  const orchestratorsCommand = program
    .command('orchestrators')
    .description("Inspect the org's orchestrator clusters and pick a default for run remote");

  orchestratorsCommand
    .command('list')
    .description('List the connected orchestrator clusters for the active org')
    .option('--org <id>', 'Target organization (overrides the active org)')
    .action(async (options) => {
      const { orchestratorsListCommand } = await import('./commands/index.js');
      const success = await orchestratorsListCommand({ org: options.org });
      process.exit(success ? 0 : 1);
    });

  orchestratorsCommand
    .command('use')
    .argument('<name>', 'Orchestrator cluster name')
    .description('Set the per-org default orchestrator cluster for run remote')
    .option('--org <id>', 'Target organization (overrides the active org)')
    .action(async (name, options) => {
      const { orchestratorsUseCommand } = await import('./commands/index.js');
      const success = await orchestratorsUseCommand(name, { org: options.org });
      process.exit(success ? 0 : 1);
    });

  const secretsCommand = program.command('secrets').description('Manage secrets');

  secretsCommand
    .command('list')
    .description('List test-available secret contexts')
    .action(async () => {
      const { secretsListCommand } = await import('./commands/index.js');
      const success = await secretsListCommand();
      process.exit(success ? 0 : 1);
    });

  const patCommand = program.command('pat').description('Manage personal access tokens');

  patCommand
    .command('create')
    .description('Mint a personal access token (use --agent for a coding-agent token)')
    .option('--name <name>', 'Token name (defaults to the agent label)')
    .option('--agent', 'Mint an agent-kind PAT for the KiCI MCP server', false)
    .option('--expires-in-days <n>', 'Custom expiry in days', (v) => parseInt(v, 10))
    .action(async (options) => {
      const { patCreateCommand } = await import('./commands/index.js');
      const success = await patCreateCommand({
        name: options.name,
        agent: options.agent,
        label: options.name,
        expiresInDays: options.expiresInDays,
      });
      process.exit(success ? 0 : 1);
    });

  const runsCommand = program.command('runs').description('Inspect and manage execution runs');

  runsCommand
    .command('list')
    .description('List execution runs (mirrors the dashboard Runs page)')
    .option('--status <s>', 'Filter by status')
    .option('--workflow <w>', 'Filter by workflow name')
    .option('--branch <b>', 'Filter by branch/ref')
    .option('--repo <r>', 'Filter by repository')
    .option('--trigger <t>', 'Filter by trigger type')
    .option('--source <routingKey>', 'Filter by source routing key')
    .option('--since <ts>', 'Only runs since (ISO-8601 or epoch ms)')
    .option('--page <n>', 'Page number', (v) => parseInt(v, 10))
    .option('--json', 'Output raw JSON', false)
    .action(async (options) => {
      const { runsListCommand } = await import('./commands/index.js');
      const success = await runsListCommand(options);
      process.exit(success ? 0 : 1);
    });

  runsCommand
    .command('show')
    .argument('<run-id>', 'Run ID to inspect')
    .description('Show a run summary with its jobs and steps')
    .option('--json', 'Output raw JSON', false)
    .action(async (runId, options) => {
      const { runsShowCommand } = await import('./commands/index.js');
      const success = await runsShowCommand(runId, { json: options.json });
      process.exit(success ? 0 : 1);
    });

  runsCommand
    .command('logs')
    .argument('<run-id>', 'Run ID')
    .description('Print step logs for a run')
    .option('--job <name>', 'Only logs for this job')
    .option('-f, --follow', 'Tail logs for a live run', false)
    .option('--json', 'Output raw JSON', false)
    .action(async (runId, options) => {
      const { runsLogsCommand } = await import('./commands/index.js');
      const success = await runsLogsCommand(runId, {
        job: options.job,
        follow: options.follow,
        json: options.json,
      });
      process.exit(success ? 0 : 1);
    });

  runsCommand
    .command('rerun')
    .argument('<run-id>', 'Run ID to rerun')
    .description('Re-trigger a run')
    .option('--json', 'Output raw JSON', false)
    .action(async (runId, options) => {
      const { runsRerunCommand } = await import('./commands/index.js');
      const success = await runsRerunCommand(runId, { json: options.json });
      process.exit(success ? 0 : 1);
    });

  runsCommand
    .command('cancel')
    .argument('[run-id]', 'Run ID to cancel')
    .description('Cancel a run, or all in-progress runs on a branch')
    .option('--force', 'Force cancel (kill immediately, skip hooks)', false)
    .option('--branch <name>', 'Cancel all in-progress runs on this branch')
    .action(async (runId, options) => {
      const { runsCancelCommand } = await import('./commands/index.js');
      const success = await runsCancelCommand(runId, {
        force: options.force,
        branch: options.branch,
      });
      process.exit(success ? 0 : 1);
    });

  program
    .command('approve')
    .argument('<run-id>', 'Run ID whose approval gate to approve')
    .description('Approve a held approval gate for a run')
    .option('--job <name>', 'Approve the hold for a specific job')
    .option('--step <index>', 'Approve a step-scoped hold (requires --job)')
    .action(async (runId, options) => {
      const { approveCommand } = await import('./commands/index.js');
      const success = await approveCommand(runId, {
        job: options.job,
        step: options.step,
      });
      process.exit(success ? 0 : 1);
    });

  program
    .command('reject')
    .argument('<run-id>', 'Run ID whose approval gate to reject')
    .description('Reject a held approval gate for a run')
    .option('--job <name>', 'Reject the hold for a specific job')
    .option('--step <index>', 'Reject a step-scoped hold (requires --job)')
    .requiredOption('--reason <text>', 'Reason for the rejection')
    .action(async (runId, options) => {
      const { rejectCommand } = await import('./commands/index.js');
      const success = await rejectCommand(runId, {
        job: options.job,
        step: options.step,
        reason: options.reason,
      });
      process.exit(success ? 0 : 1);
    });

  program
    .command('types')
    .description('Generate TypeScript declarations for secret contexts')
    .option('--kici-dir <path>', 'Path to .kici directory', '.kici')
    .action(async (options) => {
      const { typesCommand } = await import('./commands/index.js');
      const success = await typesCommand({
        kiciDir: options.kiciDir,
      });
      process.exit(success ? 0 : 1);
    });

  program
    .command('endpoints')
    .description('List all webhook entrypoints for the current project')
    .option('--kici-dir <path>', 'Path to .kici directory', '.kici')
    .action(async (options) => {
      const { endpointsCommand } = await import('./commands/index.js');
      const success = await endpointsCommand({
        kiciDir: options.kiciDir,
      });
      process.exit(success ? 0 : 1);
    });

  program
    .command('diagnostics')
    .description('Show orchestrators, scalers, and agents (mirrors the dashboard Diagnostics page)')
    .option('--json', 'Output raw JSON', false)
    .option('--verbose', 'Show extended per-agent fields', false)
    .option('--orchestrator <id>', 'Scope the tree to one connection id')
    .action(async (options) => {
      const { diagnosticsCommand } = await import('./commands/index.js');
      const success = await diagnosticsCommand({
        json: options.json,
        verbose: options.verbose,
        orchestrator: options.orchestrator,
      });
      process.exit(success ? 0 : 1);
    });

  const workflowsCommand = program
    .command('workflows')
    .description('Manage workflow registrations');

  workflowsCommand
    .command('list')
    .description('List permanently registered workflows')
    .option('--json', 'Output as JSON', false)
    .option('--stale <duration>', 'Filter stale registrations (e.g., 30d, 7d)')
    .option('--trigger-type <type>', 'Filter by trigger type')
    .option('--repo <repo>', 'Filter by repository')
    .action(async (options) => {
      const { workflowsListCommand } = await import('./commands/index.js');
      const success = await workflowsListCommand({
        json: options.json,
        stale: options.stale,
        triggerType: options.triggerType,
        repo: options.repo,
      });
      process.exit(success ? 0 : 1);
    });

  // --- kici docs (open docs site + print bundled LLM context) ---

  const docsCommandGroup = program
    .command('docs')
    .description('Open the KiCI documentation site in the default browser')
    .option('--no-open', 'Print the docs URL instead of opening a browser')
    .action(async (options) => {
      const { docsCommand } = await import('./commands/index.js');
      const success = await docsCommand({ open: options.open });
      process.exit(success ? 0 : 1);
    });

  docsCommandGroup
    .command('llm [topic]')
    .description(
      'Print KiCI LLM docs bundles. No topic prints the llms.txt index; <topic> prints a task bundle (e.g. sdk, cli, patterns, features, providers, architecture, getting-started); "full" prints the complete bundle.',
    )
    .option('--out <path>', 'Write the bundle to a file instead of stdout')
    .action(async (topic, options) => {
      const { docsLlmCommand } = await import('./commands/index.js');
      const success = await docsLlmCommand({ topic, out: options.out });
      process.exit(success ? 0 : 1);
    });

  // --- kici admin (operator-facing commands) ---

  const adminCommand = program
    .command('admin')
    .description('Operator-facing commands for running instances');

  adminCommand
    .command('drain-worker')
    .description('Trigger graceful drain on a worker instance')
    .requiredOption('--url <url>', 'Worker URL (e.g., http://worker-host:<port>)')
    .action(async (options) => {
      const { drainWorkerCommand } = await import('./commands/index.js');
      const success = await drainWorkerCommand({ url: options.url });
      process.exit(success ? 0 : 1);
    });

  program
    .command('verify-attestation')
    .argument(
      '[artifact]',
      'Artifact path to digest-check against the attestation subject (optional)',
    )
    .description('Verify a KiCI provenance attestation bundle offline')
    .option('--bundle <path>', 'Path or URL to the attestation bundle JSON')
    .option(
      '--trust-root <url-or-file>',
      'Trusted issuer URL, or a self-contained { issuer, jwks } file (default: hosted KiCI platform)',
    )
    .option('--audience <aud>', 'Expected token audience')
    .option('--json', 'Output structured JSON result', false)
    .action(async (artifact, options) => {
      const { verifyAttestationCommand } = await import('./commands/index.js');
      const success = await verifyAttestationCommand(artifact, options);
      process.exit(success ? 0 : 1);
    });

  return program;
}

/** Build the program and parse argv — the bin-shim entry point. */
export function runCli(argv: string[] = process.argv): void {
  buildProgram().parse(argv);
}

/**
 * Decide whether this module is the process entry point, tolerating a
 * symlinked `argv[1]`. A `node_modules/.bin/kici` entry is a symlink, and when
 * it points at this compiled `cli.js` (the compiler package declares a `kici`
 * bin), `process.argv[1]` is the symlink path while `import.meta.url` is the
 * real file. A plain `resolve()` comparison sees two different paths and never
 * matches, silently skipping `runCli()` — so `kici compile` (and every other
 * subcommand) becomes a no-op when invoked through the bin symlink.
 * Dereference both sides with `realpathSync` so a symlinked invocation is
 * correctly recognised as the entry point. Falls back to a plain `resolve()`
 * comparison when `argv[1]` doesn't resolve to a real file (e.g. a virtual
 * entry point), preserving the previous behaviour for that edge case.
 */
export function isMainEntryPoint(argv1: string | undefined, importMetaUrl: string): boolean {
  if (!argv1) return false;
  const modulePath = fileURLToPath(importMetaUrl);
  try {
    return realpathSync(argv1) === realpathSync(modulePath);
  } catch {
    return resolve(argv1) === resolve(modulePath);
  }
}

// Only parse argv when this module is the process entry point. The published
// bin shim imports `runCli` and calls it explicitly; importing the module
// (e.g. the surface registry building the command tree) must NOT parse/exit.
if (isMainEntryPoint(process.argv[1], import.meta.url)) {
  runCli();
}
