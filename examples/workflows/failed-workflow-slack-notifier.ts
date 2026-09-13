import { workflow, job, step, workflowComplete } from '@kici-dev/sdk';

/**
 * Failed-workflow Slack notifier (global workflow)
 *
 * Reacts to ANY workflow that fails across the org — the orchestrator auto-emits
 * a `workflow_complete` lifecycle event for every run, so this one workflow
 * watches them all with no per-repo wiring. It routes each failure to a Slack
 * channel and a fixed set of @-mentions via the inline ROUTES table, then posts
 * with `fetch`. The takeaway: "any source → any destination" needs no external
 * action package — swap the `fetch` body for Discord / Teams / PagerDuty / a
 * plain HTTP webhook to change the destination, and edit ROUTES to change the
 * routing. The one class it cannot catch is a dead orchestrator (a global
 * workflow can't run if the orchestrator that would dispatch it is gone) — that
 * failure class belongs to the managed notification plane.
 */

// Repo glob → Slack channel id + Slack member ids to @-tag. This is the one
// table a customer edits: the last `*` row is the catch-all fallback.
const ROUTES: Array<{ repo: string; channel: string; tag: string[] }> = [
  { repo: 'acme/api-*', channel: 'C0123ABCD', tag: ['U0AAA', 'U0BBB'] },
  { repo: 'acme/web', channel: 'C0777WEB', tag: ['U0CCC'] },
  { repo: '*', channel: 'C0FALLBACK', tag: [] },
];

/**
 * Minimal owner/repo glob matcher with no external dependency (the examples
 * package may import only `@kici-dev/sdk`): `*` matches within a single path
 * segment, `**` matches across segments, and every other regex metacharacter is
 * escaped so a literal `.` in a repo name never acts as a wildcard.
 */
function matchGlob(glob: string, value: string): boolean {
  if (glob === '*' || glob === '**') return true;
  const pattern = glob
    .replace(/[.+^${}()|[\]\\]/g, '\\$&') // escape regex metacharacters first
    .replace(/\*\*/g, ' ') // placeholder so the next line ignores `**`
    .replace(/\*/g, '[^/]*') // `*` → within-segment wildcard
    .replace(/ /g, '.*'); // `**` → cross-segment wildcard
  return new RegExp(`^${pattern}$`).test(value);
}

export default workflow('failed-workflow-slack-notifier', {
  // No `source` filter → org-wide: matches every workflow that completes with a
  // failed status, whatever repo or provider triggered it.
  on: workflowComplete({ status: ['failed'] }),
  jobs: [
    job('notify', {
      runsOn: 'kici:os:linux',
      steps: [
        step('post-to-slack', async (ctx) => {
          // The failed run's repo comes from `ctx.sourceRepo` (set for global
          // workflows), NOT `ctx.event` (which is only available inside a
          // rule). `ctx.rawPayload` carries the full lifecycle payload for any
          // extra fields a customer wants to route on.
          const repo = ctx.sourceRepo?.identifier ?? 'unknown';
          const route = ROUTES.find((r) => matchGlob(r.repo, repo)) ?? ROUTES[ROUTES.length - 1]!;
          const tags = route.tag.map((u) => `<@${u}>`).join(' ');
          const text = `❌ *${repo}* failed ${tags}`.trim();

          // Under `kici run remote` / an E2E run, skip the real POST and log the
          // intended message instead — so the example is safe to exercise
          // without a live Slack workspace.
          if (ctx.isTestRun) {
            ctx.log.info(`[test-run] would post to ${route.channel}: ${text}`);
            return;
          }

          const token = await ctx.secrets.get('SLACK_BOT_TOKEN');
          const res = await fetch('https://slack.com/api/chat.postMessage', {
            method: 'POST',
            signal: ctx.signal,
            headers: {
              Authorization: `Bearer ${token}`,
              'Content-Type': 'application/json; charset=utf-8',
            },
            body: JSON.stringify({ channel: route.channel, text }),
          });
          const body = (await res.json()) as { ok?: boolean; error?: string };
          if (!body.ok) throw new Error(`Slack post failed: ${body.error ?? res.status}`);
        }),
      ],
    }),
  ],
});
