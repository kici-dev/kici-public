/** `--junit` output for CI systems: each fixture is a <testsuite>, each job a <testcase>. */

import { jobLabel, spansWorkflows, type RunResult } from './summary.js';

/** @param failureMessages `fixtureId:<testcase name>` -> last lines of output, for failure details. */
export function formatJunitResult(
  results: RunResult[],
  failureMessages?: Map<string, string>,
): string {
  const totalTests = results.reduce((sum, r) => sum + r.jobs.length, 0);
  const totalFailures = results.reduce(
    (sum, r) => sum + r.jobs.filter((j) => j.status === 'failed').length,
    0,
  );
  const totalTimeSeconds = results.reduce((sum, r) => sum + r.totalDurationMs / 1000, 0);

  const lines: string[] = [];
  lines.push('<?xml version="1.0" encoding="UTF-8"?>');
  lines.push(
    `<testsuites name="kici-test" tests="${totalTests}" failures="${totalFailures}" time="${totalTimeSeconds.toFixed(3)}">`,
  );

  for (const result of results) {
    const suiteTests = result.jobs.length;
    const suiteFailures = result.jobs.filter((j) => j.status === 'failed').length;
    const suiteTimeSeconds = result.totalDurationMs / 1000;

    lines.push(
      `  <testsuite name="${escapeXml(result.fixtureId)}" tests="${suiteTests}" failures="${suiteFailures}" time="${suiteTimeSeconds.toFixed(3)}">`,
    );

    // A fixture that ran several workflows names each testcase `<workflow> / <job>`,
    // so two workflows' same-named jobs stay distinct.
    const labelWorkflow = spansWorkflows(result.jobs);
    for (const job of result.jobs) {
      const jobTimeSeconds = job.durationMs !== undefined ? job.durationMs / 1000 : 0;
      const name = jobLabel(job, labelWorkflow);

      if (job.status === 'failed') {
        const failureKey = `${result.fixtureId}:${name}`;
        const failureText = failureMessages?.get(failureKey) ?? 'Step failed';

        lines.push(
          `    <testcase name="${escapeXml(name)}" classname="${escapeXml(result.fixtureId)}" time="${jobTimeSeconds.toFixed(3)}">`,
        );
        lines.push(`      <failure message="Step failed">${escapeXml(failureText)}</failure>`);
        lines.push('    </testcase>');
      } else if (job.status === 'skipped') {
        lines.push(
          `    <testcase name="${escapeXml(name)}" classname="${escapeXml(result.fixtureId)}" time="${jobTimeSeconds.toFixed(3)}">`,
        );
        lines.push('      <skipped />');
        lines.push('    </testcase>');
      } else {
        lines.push(
          `    <testcase name="${escapeXml(name)}" classname="${escapeXml(result.fixtureId)}" time="${jobTimeSeconds.toFixed(3)}" />`,
        );
      }
    }

    lines.push('  </testsuite>');
  }

  lines.push('</testsuites>');

  return lines.join('\n');
}

function escapeXml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}
