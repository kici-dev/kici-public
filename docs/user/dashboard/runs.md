---
title: Runs and logs
description: The run list, run detail panels, and the log viewer.
---



## Run list

The run list is the default page when entering an organization (`/orgs/:customerId/runs`).

### Columns

Each run is displayed in a table row (desktop) or card (mobile) with:

- **Status** -- colored badge (green = success, red = failed/error/timed out, amber = running/cancelling, yellow = queued/pending, gray = cancelled/skipped)
- **Trigger** -- icon indicating the event type (push, pull request, tag, dispatch, etc.)
- **Workflow** -- the workflow name from your `.kici/workflows/` directory
- **Branch** -- the git ref that triggered the run
- **Commit** -- the first 7 characters of the commit SHA, linked to the provider (GitHub)
- **Duration** -- how long the run took (e.g. "2m 30s")
- **Time** -- relative timestamp (e.g. "5 minutes ago")

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

The run list shows 20 runs per page with numbered pagination controls. A footer displays the current range and total count (e.g. "Showing 1-20 of 237 runs").

### Empty states

- **No runs, WS disconnected** -- "No orchestrator connected" with guidance to check orchestrator configuration and a link to settings.
- **No runs, WS connected** -- "No runs yet" with guidance to push code to trigger a workflow run.
- **No filter matches** -- "No matching runs" with guidance to adjust filters.










## Run detail

Click any run in the list to open its detail page (`/orgs/:customerId/runs/:runId`).

### Layout

The page uses a responsive multi-panel layout that adapts to screen width:

- **Wide desktop (>= 1200px)** -- three-panel layout with a resizable job tree (left), content area (center), and metadata sidebar (right). Two draggable dividers between the panels let you resize them. Panel sizes persist to `localStorage`.
- **Medium desktop (< 1200px)** -- two-panel layout with the job tree and content area. Metadata is accessible via a "Show metadata" drawer button.
- **Mobile (< 768px)** -- stacked layout with the job tree at the top and content below. Metadata is available as a tab alongside Logs, Payload, Timeline, Graph, and Summary.

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
- **Attestations** -- build-provenance attestations produced by the run's steps (via `ctx.attestProvenance`), one row per attested artifact with a **verified** badge and a bundle download. See [Build provenance and attestations](../provenance.md#viewing-attestations-in-the-dashboard) for what the badge checks and how to verify a bundle against a specific file.

On wide desktop (>= 1200px), Metadata is shown in a dedicated sidebar panel instead of as a tab.

### Metadata

The metadata panel shows detailed information organized into sections:

- **Run metadata** -- run ID, status, trigger event, branch, commit SHA (linked to provider), workflow name (linked to source file on provider), duration, and timestamps
- **Job metadata** -- job name, status, agent ID, matrix values (if present), duration
- **Step metadata** -- step name, step index, status, duration
- **Trust context** (PR-triggered runs only) -- shows the contributor's trust tier (trusted, known, or unknown), lock file source (head or base branch), and secrets access level

Provider-specific links (e.g., GitHub commit URL, branch URL, PR link, workflow source file link) are automatically generated based on the repository context. The workflow name in the metadata panel is a clickable link to the `.kici/workflows/<name>.ts` source file on the provider (e.g. GitHub blob view).

### WebSocket connection indicator

A small indicator in the sidebar footer shows the real-time WebSocket connection status:

- **Green dot** -- connected and receiving live updates
- **Red dot (pulsing)** -- disconnected

## Log viewer

The log viewer renders step output with full terminal color support.

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
- If the WS connection drops, the dashboard reconnects automatically and refetches all cached data to catch up on missed updates.
- Log lines received during streaming are held in memory. For very long-running steps with massive output, the REST endpoint is the authoritative source for complete logs.

### Provisioning logs

Above the step logs, a collapsible **Provisioning logs** section shows the orchestrator-side lifecycle of the agent that ran the job — the scaler lifecycle events emitted while bringing an agent up. It starts expanded while provisioning is in progress (no step logs yet) and collapses once steps begin producing output.

When the scaler **fails** to provision an agent (for example a missing binary, an unpullable container image, or a microVM that fails to boot), the failure appears here along with a bounded tail of the agent process's own stdout/stderr captured by the scaler. This is the surface to check for a run that fails with no step logs at all — the agent never started, so the cause lives in the provisioning lifecycle rather than in any step's output.

### Performance

The log viewer uses virtualized scrolling to handle large outputs. Only the visible lines plus a small buffer are rendered in the DOM, keeping performance smooth even for logs with 10,000+ lines.
