import { describe, it, expect } from 'vitest';
import { buildFatalReport } from './fatal-report.js';
import { LogMasker } from './log-masker.js';

const SECRET = 'job-secret-value-7f3a9c';

/** An install failure whose stdout and npm debug log echo a job secret. */
function installFailure(): Error {
  return new Error(
    [
      'Command failed: node npm-cli.js install --cache /tmp/c',
      'exit code 1',
      'stderr: (empty)',
      'stdout:',
      'npm error code E404',
      `npm verbose env DEPLOY_KEY=${SECRET}`,
      'npm debug log:',
      `12 verbose auth ${SECRET}`,
    ].join('\n'),
  );
}

function fatalText(report: ReturnType<typeof buildFatalReport>): string[] {
  return report.messages.map((m) =>
    m.type === 'log.line' ? m.line : m.type === 'job.complete' ? (m.error ?? '') : '',
  );
}

describe('buildFatalReport', () => {
  // fails-when: the fatal path sends its log line and job.complete error
  // through the raw send, so a job secret in install output reaches the run
  // log and the job's failure reason.
  // breaks-if-wrong: the masker removes only the secret — npm's own error line
  // still shows in every part of the report.
  it('masks a job secret in the log line, the job error and stderr, and keeps npm errors', () => {
    const masker = new LogMasker();
    masker.registerSecrets({ DEPLOY_KEY: SECRET });

    const report = buildFatalReport(installFailure(), masker);
    const [logLine, jobError] = fatalText(report);

    for (const text of [logLine!, jobError!, report.stderr]) {
      expect(text).not.toContain(SECRET);
      expect(text).toContain('npm error code E404');
      expect(text).toContain('exit code 1');
    }
    expect(logLine).toMatch(/^\[workflow-runner\] \[error\] Fatal: Command failed:/);
    expect(report.messages.map((m) => m.type)).toEqual(['log.line', 'job.complete']);

    // Positive control: without the masker the same input carries the secret.
    expect(fatalText(buildFatalReport(installFailure(), null)).join('\n')).toContain(SECRET);
  });

  // fails-when: a later registration on the job masker (an OIDC token, a
  // mounted file) drops the secrets registered before it.
  it('still masks a job secret after a later secret registration', () => {
    const masker = new LogMasker();
    masker.registerSecrets({ DEPLOY_KEY: SECRET });
    masker.registerSecrets({ __oidc_token__: 'oidc-token-value-9b1d' });
    const report = buildFatalReport(installFailure(), masker);
    for (const text of [...fatalText(report), report.stderr]) {
      expect(text).not.toContain(SECRET);
      expect(text).toContain('npm error code E404');
    }
  });

  it('sends the error as it is before the job secrets are known', () => {
    const report = buildFatalReport(new Error('no request received'), null);
    expect(fatalText(report)).toEqual([
      '[workflow-runner] [error] Fatal: no request received',
      'no request received',
    ]);
    expect(report.stderr).toContain('[workflow-runner] Fatal error: no request received\n');
  });
});
