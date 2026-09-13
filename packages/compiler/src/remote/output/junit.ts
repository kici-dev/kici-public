/**
 * JUnit XML output formatter for CI integration.
 *
 * Used with `--junit` flag to produce standard JUnit XML output that
 * can be consumed by CI systems (Jenkins, GitLab, etc.).
 *
 * Each fixture maps to a <testsuite>, each job maps to a <testcase>.
 */

import type { RunResult } from './summary.js';

/**
 * Format run results as JUnit XML following the standard schema.
 *
 * @param results The run results to format.
 * @param failureMessages Optional map of jobKey -> last lines of output for failure details.
 * @returns Valid JUnit XML string.
 */
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

    for (const job of result.jobs) {
      const jobTimeSeconds = job.durationMs !== undefined ? job.durationMs / 1000 : 0;

      if (job.status === 'failed') {
        const failureKey = `${result.fixtureId}:${job.name}`;
        const failureText = failureMessages?.get(failureKey) ?? 'Step failed';

        lines.push(
          `    <testcase name="${escapeXml(job.name)}" classname="${escapeXml(result.fixtureId)}" time="${jobTimeSeconds.toFixed(3)}">`,
        );
        lines.push(`      <failure message="Step failed">${escapeXml(failureText)}</failure>`);
        lines.push('    </testcase>');
      } else if (job.status === 'skipped') {
        lines.push(
          `    <testcase name="${escapeXml(job.name)}" classname="${escapeXml(result.fixtureId)}" time="${jobTimeSeconds.toFixed(3)}">`,
        );
        lines.push('      <skipped />');
        lines.push('    </testcase>');
      } else {
        lines.push(
          `    <testcase name="${escapeXml(job.name)}" classname="${escapeXml(result.fixtureId)}" time="${jobTimeSeconds.toFixed(3)}" />`,
        );
      }
    }

    lines.push('  </testsuite>');
  }

  lines.push('</testsuites>');

  return lines.join('\n');
}

/**
 * Escape special XML characters in a string.
 */
function escapeXml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}
