---
title: Runs and logs
description: The run list, run detail panels, and the log viewer.
---



## Run list

The run list is the default page when entering an organization (`/orgs/:customerId/runs`).

### Columns

Each run is displayed in a table row (desktop) or card (mobile) with:

- **Status** -- colored badge (green = success, red = failed/error/timed out, amber = running/cancelling, yellow = queued/pending/held, gray = cancelled/skipped)
- **Trigger** -- icon indicating the event type (push, pull request, tag, dispatch, etc.)
- **Workflow** -- the workflow name from your `.kici/workflows/` directory
- **Branch** -- the git ref that triggered the run
- **Commit** -- the first 7 characters of the commit SHA, linked to the provider (GitHub)
- **Duration** -- how long the run took (e.g. "2m 30s")
- **Time** -- relative timestamp (e.g. "5 minutes ago")

### Row actions

Each row carries the same re-run / cancel actions as the run detail page, so the common "retry a flaky run" loop no longer requires opening the run first. They appear on the desktop table, the mobile card, and the commit-grouped view:

- **Re-run** -- shown on terminal-state runs (success, failed, cancelled, error, timed out) that were triggered by a webhook or are themselves a re-run. Opens the same confirmation dialog before re-running on the same commit, then navigates to the new run.
- **Cancel** -- shown on pending, running, cancelling, or queued runs. For a running run it sends a graceful cancel; for an already-cancelling run a **Force cancel** action appears to kill it immediately without cleanup.

Activating a row action never navigates to the run — it runs in place and (for re-run) opens the confirmation dialog.

### Filters

Dropdown filters appear above the table:

- **Status** -- filter by success, failed, running, or cancelled
- **Workflow** -- filter by workflow name
- **Branch** -- filter by git branch
- **Repository** -- filter by repository

A "More filters" button reveals additional filters:

- **Trigger type** -- filter by push, pull_request, tag, dispatch, etc.

Filters persist in URL query parameters (e.g. `/runs?status=failed&branch=main`), making filtered views shareable and bookmark-friendly. A "Clear filters" button appears when any filter is active.

### Sorting

Click any column header to sort the table by that column. Clicking the same header toggles between ascending and descending order. The current sort is reflected in the URL (e.g. `?sort=workflowName&dir=desc`), so sorted views are shareable.

Sorting is server-side -- the API returns results in the requested order.

### Column visibility

A gear icon button (labeled "Toggle columns") next to the filter bar opens a menu of toggleable columns. Uncheck a column to hide it from the table. Column visibility preferences are saved per organization in `localStorage`.

### Commit grouped view

A "Group by commit" toggle switch groups runs by their commit SHA. When enabled, runs sharing the same commit are collapsed under a group header showing the commit SHA (first 7 characters), commit message, and aggregate status dots. This is useful for seeing all workflow runs triggered by a single push.

### Compile indicator

Runs where the lock file was recompiled during execution show a hammer icon next to the workflow name. Hover over the icon to see the tooltip "Lock file recompiled".

### Pagination

The run list shows 20 runs per page with **Newer** / **Older** controls. A footer displays an approximate total count (e.g. "~237 runs"). Paging is cursor-based (next/previous), so there is no jump-to-page-N control; changing a filter or sort returns you to the first page.

### Empty states

- **No runs, no orchestrator registered** -- "No orchestrator connected" with guidance to connect an orchestrator and a "Connect an orchestrator" button linking to the getting-started page.
- **No runs, orchestrator registered, webhooks arriving but nothing matched** -- "Webhooks are arriving but not matching". This strip appears when an orchestrator is connected and webhook deliveries arrived in the last hour but none produced a run -- the classic "almost there, but a trigger is misconfigured" moment. It shows how many webhooks were received and how many matched a trigger, a `kici preview push` hint to test your triggers locally, and (for members with the event-log read permission) a **View event log** link to inspect the individual deliveries. When the orchestrator can't be reached the copy degrades to "N webhooks received but none produced a run" without claiming a match count. Deliveries the relay rejected outright -- an unknown source or a rate/size cap -- are surfaced too, both in the strip's rejected count and as **Unknown source** / **Rejected (cap)** rows in the event log.
- **No runs, orchestrator registered, nothing arriving yet** -- "No runs yet" with guidance to push code to trigger a workflow run.
- **No filter matches** -- "No matching runs" with guidance to adjust filters.












## Run detail

Click any run in the list to open its detail page (`/orgs/:customerId/runs/:runId`).

### Layout

The page uses a responsive multi-panel layout that adapts to screen width:

- **Wide desktop (>= 1200px)** -- three-panel layout with a resizable job tree (left), content area (center), and metadata sidebar (right). Two draggable dividers between the panels let you resize them. Panel sizes persist to `localStorage`.
- **Medium desktop (< 1200px)** -- two-panel layout with the job tree and content area. Metadata is accessible via a "Show metadata" drawer button.
- **Mobile (< 768px)** -- stacked layout with the job tree at the top and content below. Metadata is available as a tab alongside Logs, Payload, Timeline, Graph, Summary, Artifacts, and Attestations.

### Run header

A summary bar above the two panels shows:

- **Breadcrumbs** -- Runs > github > owner/repo > commit SHA > #runId > workflow name (each segment is clickable and filters the run list by that dimension)
- **Status badge** -- the current run status
- **Trigger icon** -- visual indicator of the event type
- **Branch** -- the git ref with a branch icon
- **Commit SHA** -- linked to the provider's commit page
- **Duration** -- total run time
- **Timestamp** -- relative time since the run started (hover for absolute time)
- **Re-run button** -- available for terminal-state runs (success, failed, cancelled, error, timed out) triggered by webhooks. Opens a confirmation dialog before re-running on the same commit. After confirmation, navigates to the new run.
- **Cancel button** -- available for pending, running, cancelling, or queued runs. For running runs, sends a graceful cancel; for already-cancelling runs, a "Force cancel" button appears to immediately kill without cleanup.
- **Lineage badge** -- if the run is a re-run, a badge shows the parent/child relationship with a link to the original run.

### Job tree

The left panel shows a tree of jobs and their steps:

- Each job shows a **status dot**, **name**, and **duration** (live timer while running)
- Click a job row to select the job and view its combined logs (all steps merged with sticky headers)
- Click the expand chevron on a job to expand/collapse its steps
- Each step shows a **status dot**, **name**, and **duration**
- Click a step to select it and view its individual logs

**Status dot colours** -- green = success; red = failed or timed out; amber = running or cancelling; orange = recovering (the job's agent disconnected and the job is waiting for it to reconnect before its recovery deadline); yellow = queued, pending, or held; gray = cancelled, skipped, or drift dropped (the executing agent re-evaluated the workflow and no longer produced this job, so it never ran). Hover a dot for the status name.

**Job-level selection** -- clicking a job row selects it and shows combined logs from all of its steps, with sticky step headers separating each step's output. This provides a unified view of the entire job's execution without needing to click through steps individually.

**Matrix jobs** are grouped under a parent node. For example, a matrix with 3 Node.js versions appears as "Test (3 variants)" with expandable sub-entries like "Test (node:18)", "Test (node:20)", "Test (node:22)".

**Hook steps** -- lifecycle hook steps (e.g. `onCancel`, `cleanup`, `onSuccess`) are displayed with a distinct badge to differentiate them from regular steps.


**Auto-expand on failure** -- when viewing a failed run, the first failed job is automatically expanded and the failed step is selected.

**URL sync** -- selecting a job updates the URL to `/runs/:runId/jobs/:jobId`, and selecting a step updates it to `/runs/:runId/jobs/:jobId/steps/:stepIndex`, making selections bookmarkable and shareable.

### Keyboard navigation

The job tree supports keyboard navigation:

- **Arrow Up/Down** -- move focus through tree items
- **Enter** -- select a job (show combined logs) or select a step (show step logs)
- **Escape** -- deselect the current selection and navigate to the first job

### Tabs

The content area has the following tabs:

- **Logs** (default) -- shows log output for the selected job or step
- **Payload** -- webhook payload viewer showing the raw event payload that triggered the run. This tab appears only for runs triggered by a webhook event (and re-runs of those, which copy the original payload); runs started by a schedule, manual schedule, lifecycle event, or another run carry no payload, so the tab is hidden for them
- **Timeline** -- CSS Gantt chart showing the execution timeline of all jobs, with percentage-based bars and striped animation for running jobs. A **Provisioning** milestones section between the dispatch and execution phases plots scaler lifecycle events for the run — including a **Provisioning failed** marker when the scaler could not bring an agent up
- **Graph** -- dependency graph (DAG) view of the run's jobs: each job is a node, and arrows point from a job to the jobs that depend on it. Matrix jobs appear as one node per variant. Each node shows the job name, status, and duration; a job's left accent border and the status line are colored by run state (running nodes pulse, failed nodes are red, skipped nodes are dimmed). Click a node to open that job's details (the same selection the Timeline and right panel use); hover a node to highlight what it depends on and what depends on it. Dependency edges flagged to run even when the upstream failed are drawn as dashed orange arrows. The Timeline tab remains the place to see durations and overlap on a time axis
- **Summary** -- contextual overview scoped to the current selection (run-level trigger/repo/timing info, or job-level execution context with environment variables, runtime info, and sandbox details)
- **Artifacts** -- named, durable build outputs the run uploaded via `ctx.artifacts.upload`, one row per artifact with the producing job, size, content hash, and creation time. Use **Download** on any row to fetch it directly from storage (the link points straight at the stored object, so the bytes never pass through the control plane). Artifacts expire after the orchestrator's configured retention, after which they no longer appear here. See [Artifacts](../sdk/artifacts.md) for the SDK API that produces them.
- **Attestations** -- build-provenance attestations produced by the run's steps (via `ctx.attestProvenance`), one row per attested artifact with a **verified** badge and a bundle download. See [Build provenance and attestations](../provenance.md#viewing-attestations-in-the-dashboard) for what the badge checks and how to verify a bundle against a specific file.

On wide desktop (>= 1200px), Metadata is shown in a dedicated sidebar panel instead of as a tab.

### Metadata

The metadata panel shows detailed information organized into sections:

- **Run metadata** -- run ID, status, trigger event, branch, commit SHA (linked to provider), workflow name (linked to source file on provider), duration, and timestamps. The **Triggered by** line carries an **agent badge** (with the agent's label) when the run was triggered or cancelled through an agent credential — an agent PAT or an agent org key — so an agent-driven run is obvious from its detail page
- **Job metadata** -- job name, status, agent ID, matrix values (if present), duration
- **Step metadata** -- step name, step index, status, duration
- **Trust context** (PR-triggered runs only) -- shows the contributor's trust tier (trusted, known, or unknown), lock file source (head or base branch), and secrets access level

Provider-specific links (e.g., GitHub commit URL, branch URL, PR link, workflow source file link) are automatically generated based on the repository context. The workflow name in the metadata panel is a clickable link to the `.kici/workflows/<name>.ts` source file on the provider (e.g. GitHub blob view).

### WebSocket connection indicator

A small indicator in the sidebar footer shows the status of the live-updates
connection -- the real-time stream that pushes run, step, and log changes to the
page as they happen. It has three states:

- **Green dot** -- connected; the dashboard is receiving live updates.
- **Amber dot (pulsing)** -- reconnecting; the connection dropped and is being
  retried automatically.
- **Red dot (pulsing)** -- disconnected; live updates are paused.

Hovering (or focusing) the indicator opens a short explanation of what live
updates are, the impact while they are paused (run views fall back to refreshing
every ~20 seconds instead of updating live), and the auto-retry status. When the
connection is not active, the popover also offers a **Retry now** control that
forces an immediate reconnection instead of waiting for the next automatic retry.

## Log viewer

The log viewer renders step output with full terminal color support.

### Failed steps carry their error in the log

When a step fails, the error that stopped it is written into that step's own log
as its last entry, prefixed `[kici] Step '<name>' failed:`. You do not have to
re-run the job to find out why it went red.

This matters most for a step that shells out: a subprocess wrapper usually folds
the command's captured error output into the error it throws, so the failing
command's own message travels with it. A very large error message is trimmed in
the log — the entry says how much was dropped, and the step's recorded error
keeps the full text.

### stdout and stderr are recorded separately

Every stored log entry records which stream it came from — standard output or
standard error — so a diagnostic can be told apart from ordinary progress output
when you read the raw log records, for example the log a `kici run --local` run
prints. The viewer itself shows both streams inline, in the order they were
produced. Entries from an agent that does not report a stream are recorded as
standard output.

### ANSI color rendering

Log lines containing ANSI escape codes are rendered with color. Supported sequences include:

- Standard 16 colors (red, green, blue, etc.) and bright variants
- 256-color palette
- Truecolor (24-bit RGB)
- Bold, faint, italic, underline, and inverse text

Colors use CSS classes with a dark background (similar to a terminal), regardless of the dashboard's light/dark theme setting.

### Timestamps

A clock icon button next to the search bar toggles per-line timestamps in the log viewer. When enabled, each log line shows the timestamp in the gutter alongside the line number. The timestamp format respects the UTC/local time preference. The setting persists to `localStorage`.

### Search

A search bar at the top of the log viewer provides:

- **Debounced search** -- type a query and matches are highlighted after 300ms
- **Match count** -- shows "N of M" with the current and total match count
- **Navigation** -- up/down arrows to jump between matches (also Enter/Shift+Enter)
- **Clear** -- press Escape or click the X button to clear the search
- **Wraparound** -- navigation wraps from the last match back to the first

### Permalink

Click any line number in the gutter to:

1. Highlight that line with a blue tint
2. Update the URL hash to `#L42` (for line 42)

Sharing the URL scrolls the recipient directly to the highlighted line.

### Copy to clipboard

Hover over any line to reveal a copy button on the right. Clicking it copies the line's **plain text** (ANSI escape codes are stripped) to the clipboard. A "Copied!" tooltip confirms the action.

### Live log streaming

When viewing a running job, logs appear in real time as the agent executes steps. The dashboard maintains a WebSocket connection and subscribes to log updates for the currently selected step.

**Auto-scroll** -- new lines automatically scroll into view as they arrive. If you scroll up to review earlier output, auto-scroll pauses and a **"Jump to bottom"** button appears. Clicking it resumes auto-scroll.

**Streaming indicator** -- a pulsing "Streaming" badge appears next to the Logs tab header while a step is actively running.

**Completion banner** -- when a step finishes, a banner appears at the bottom of the log viewer showing the final status (success or failed) and total line count.

**Status updates** -- the run list and run detail pages update live as jobs and steps change state. You do not need to refresh the page to see a run complete.

**Known limitations**:

- Live streaming requires an active WebSocket connection. Some corporate proxies may block WebSocket upgrades.
- If the WS connection drops, the dashboard reconnects automatically and refetches the data you are currently viewing to catch up on missed updates.
- Log lines received during streaming are held in memory. For very long-running steps with massive output, the REST endpoint is the authoritative source for complete logs.

### Provisioning logs

Above the step logs, a collapsible **Provisioning logs** section shows the orchestrator-side lifecycle of the agent that ran the job — the scaler lifecycle events emitted while bringing an agent up. It starts expanded while provisioning is in progress (no step logs yet) and collapses once steps begin producing output.

When the scaler **fails** to provision an agent (for example a missing binary, an unpullable container image, or a microVM that fails to boot), the failure appears here along with a bounded tail of the agent process's own stdout/stderr captured by the scaler. This is the surface to check for a run that fails with no step logs at all — the agent never started, so the cause lives in the provisioning lifecycle rather than in any step's output.

### Performance

The log viewer uses virtualized scrolling to handle large outputs. Only the visible lines plus a small buffer are rendered in the DOM, keeping performance smooth even for logs with 10,000+ lines.

## Run retention

Your plan sets a **run retention window** — how far back the dashboard serves run history. The window applies to the run list and to individual runs alike: once a run is older than the window, opening its link, reading its jobs, step logs, payload, timeline, artifacts, or attestations, and rerunning it all stop working.

Opening a link to a run that has aged out shows an **Outside your retention window** page naming your organization's window, rather than "Run not found" — the run existed, it is simply past what the plan covers. A run that never existed (or belongs to another organization) still shows the ordinary not-found page.

A few consequences worth knowing:

- **Bookmarked run links expire.** A link you saved months ago stops resolving once the run leaves the window. Export or copy anything you need to keep — the run detail page's data is not archived on your behalf.
- **Rerunning an aged-out run is refused.** Trigger a fresh run from the current commit instead.
- **Support sessions read the same window.** A KiCI operator helping with a ticket sees exactly what you see; there is no operator override for retention.
- **Raising your plan's retention does not always bring old runs back.** A run already marked as aged out under the previous, shorter window stays hidden. Runs that had aged past the old window but had not yet been marked come back once the change takes effect.

Retention is a plan limit; see your organization's billing settings for the window your current plan provides.
