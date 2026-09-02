import pc from 'picocolors';
import open from 'open';
import { logger, toErrorMessage } from '@kici-dev/core';

/** The public tracker. Reports about KiCI itself go here — never customer data. */
export const FEEDBACK_TRACKER_URL = 'https://github.com/kici-dev/kici-public';

/** The issue form tuned for an advertised-versus-actual report. */
export const FEEDBACK_TEMPLATE = 'agent_report.yml';

export const FEEDBACK_NEW_ISSUE_URL = `${FEEDBACK_TRACKER_URL}/issues/new?template=${FEEDBACK_TEMPLATE}`;

/** Suspected vulnerabilities go here instead, privately. */
export const FEEDBACK_SECURITY_ADVISORY_URL = `${FEEDBACK_TRACKER_URL}/security/advisories/new`;

export interface FeedbackField {
  id: string;
  label: string;
  description: string;
}

export interface FeedbackContract {
  tracker: string;
  newIssueUrl: string;
  template: string;
  securityAdvisoryUrl: string;
  guideUrl: string;
  searchCommand: string;
  approval: { required: boolean; rule: string };
  qualifies: string[];
  doesNotQualify: string[];
  requiredFields: FeedbackField[];
  prohibited: string[];
  privateReportCommand: string;
}

/**
 * The single definition of what a reportable discrepancy is and what a report
 * must carry. `kici feedback` prints it, `--json` emits it verbatim, and
 * hack/feedback-contract.test.ts asserts the published guide says the same
 * thing — so the CLI and the doc cannot drift apart.
 */
export const FEEDBACK_CONTRACT: FeedbackContract = {
  tracker: FEEDBACK_TRACKER_URL,
  newIssueUrl: FEEDBACK_NEW_ISSUE_URL,
  template: FEEDBACK_TEMPLATE,
  securityAdvisoryUrl: FEEDBACK_SECURITY_ADVISORY_URL,
  guideUrl: 'https://kici.dev/docs/user/reporting-discrepancies/',
  searchCommand: 'gh issue list --repo kici-dev/kici-public --search "<terms>" --state all',
  approval: {
    required: true,
    rule: 'Draft the issue, show the full body to the person you are working with, and file it only after they say yes.',
  },
  qualifies: [
    'A documented flag, command, or option that does not exist in the version you ran.',
    'Documented output — a shape, a field, an exit code — that differs from what the command produced.',
    'A CLI --help description that contradicts the published docs.',
    'A documented behaviour that does not happen, or a documented guarantee that does not hold.',
    'A documented error or limit that the tool does not actually enforce.',
  ],
  doesNotQualify: [
    'Usage questions, or behaviour you find surprising but that the docs describe correctly.',
    'Feature requests and design preferences.',
    'Anything you inferred from reading docs without running the command.',
    'Anything reproduced only on a locally built or unreleased version.',
    'A failure that is your workflow, your credentials, or your environment.',
  ],
  requiredFields: [
    {
      id: 'advertised',
      label: 'What the docs or CLI advertise',
      description:
        'The exact claim, quoted, plus its source: a docs URL or the command whose --help says it.',
    },
    {
      id: 'observed',
      label: 'What actually happened',
      description: 'The real output or behaviour, quoted, with any error text.',
    },
    {
      id: 'reproduction',
      label: 'Minimal reproduction, including setup',
      description:
        'Every step from an empty directory: the setup commands, a minimal synthetic workflow, and the exact command you ran.',
    },
    {
      id: 'version',
      label: 'Version and environment',
      description: 'Output of `kici --version`, plus Node version and OS.',
    },
    {
      id: 'justification',
      label: 'Why this is a discrepancy',
      description:
        'One or two sentences ruling out the likely misreads — why the docs cannot be read to match what you observed.',
    },
  ],
  prohibited: [
    'No secrets, tokens, or credentials — not even redacted-looking ones.',
    'No private repository names, internal hostnames, organization ids, or run ids.',
    'No log excerpts you have not read line by line.',
    'Reproduce with a minimal synthetic workflow, never the real one you were working on.',
  ],
  privateReportCommand: 'kici report --run <run-id> --upload',
};

export interface FeedbackOptions {
  /** Open the prefilled issue form in the default browser. */
  open?: boolean;
  /** Emit the contract as JSON on stdout instead of prose. */
  json?: boolean;
}

function printContract(): void {
  const c = FEEDBACK_CONTRACT;

  logger.info(pc.bold('Reporting a KiCI discrepancy'));
  logger.info('');
  logger.info(
    'Use this when the published docs or the CLI advertise one behaviour and KiCI does another.',
  );
  logger.info(`Tracker: ${c.tracker}`);
  logger.info(`Full guide: ${c.guideUrl}`);
  logger.info('');

  logger.info(pc.bold('1. Search first'));
  logger.info('Comment on an existing report rather than opening a second one.');
  logger.info(`  ${c.searchCommand}`);
  logger.info('');

  logger.info(pc.bold('2. Check it qualifies'));
  for (const item of c.qualifies) logger.info(`  ${pc.green('+')} ${item}`);
  logger.info('  Not a discrepancy:');
  for (const item of c.doesNotQualify) logger.info(`  ${pc.gray('-')} ${item}`);
  logger.info('');

  logger.info(pc.bold('3. Never file these publicly'));
  logger.info(
    `  A suspected vulnerability is never a public issue — open a private advisory instead:\n    ${c.securityAdvisoryUrl}`,
  );
  logger.info(
    `  A problem with your own runs is not a tracker issue — send it privately instead:\n    ${c.privateReportCommand}`,
  );
  for (const rule of c.prohibited) logger.info(`  ${pc.yellow('!')} ${rule}`);
  logger.info('');

  logger.info(pc.bold('4. Draft the report'));
  for (const field of c.requiredFields) {
    logger.info(`  ${field.label}`);
    logger.info(pc.gray(`    ${field.description}`));
  }
  logger.info('');

  logger.info(pc.bold('5. Get approval, then file'));
  logger.info(`  ${c.approval.rule}`);
  logger.info(`  Form: ${c.newIssueUrl}`);
  logger.info(pc.gray(`  Or: kici feedback --open`));
  logger.info('');
  logger.info(pc.gray('Machine-readable: kici feedback --json'));
}

/**
 * Print the contract for reporting a KiCI discrepancy: what qualifies, what a
 * report must carry, what must never appear in a public issue, and the rule
 * that an agent drafts a report but a human decides to file it.
 *
 * The command reaches no network and files nothing. `--open` opens the
 * prefilled issue form; `--json` emits the same contract for an agent to
 * consume without parsing prose.
 */
export async function feedbackCommand(options: FeedbackOptions = {}): Promise<boolean> {
  if (options.json) {
    process.stdout.write(`${JSON.stringify(FEEDBACK_CONTRACT, null, 2)}\n`);
    return true;
  }

  printContract();

  if (!options.open) return true;

  try {
    await open(FEEDBACK_NEW_ISSUE_URL);
    return true;
  } catch (error) {
    logger.error(pc.red(`Could not open a browser: ${toErrorMessage(error)}`));
    logger.info(pc.gray(`Open ${FEEDBACK_NEW_ISSUE_URL} manually.`));
    return false;
  }
}
