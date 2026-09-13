---
title: Activity and DLQ
description: The org forensic activity log and the dead-letter queue.
---



## Activity

The activity page (`/orgs/:customerId/activity`) is the org-level forensic log. It merges two streams into one chronological view: tenant-plane audit entries (every tenant-plane mutation -- invites, role changes, source registrations, plan changes) and orchestrator access entries (every read and admin action -- run cancels, secret reveals, context edits, dashboard data fetches). Filters live in the URL via search params so a filtered view is bookmarkable and shareable. The page uses cursor-based pagination and supports filtering by source (audit / access / all), free-text search, run ID, **Agent name** (rows attributed to one agent label), **Agent-driven only** (any agent-attributed row), and other dimensions. Rows driven by an agent credential (an agent PAT or an agent org key) render an **agent badge** with the agent's label. Requires `audit:read` permission. The legacy `/orgs/:customerId/audit-log` URL redirects here to preserve bookmarks.

### Export JSONL

The **Export JSONL** button downloads the currently-filtered activity view as a newline-delimited JSON file (`application/x-ndjson`) -- one JSON object per line -- for retention, compliance evidence, or offline analysis. The export honors the exact filters in the URL and always includes archived rows for that window, so the file is the complete record for the filter, not just the page on screen. Requires `audit:read`. Each export itself writes an `activity.export` entry to the activity log (with the applied filters and the exported row count), so pulling the data out is auditable too.

## DLQ

The DLQ (dead-letter queue) page lists internal events whose dispatch attempts were exhausted (or that hit a non-retryable error). Each row shows when the event landed in the DLQ, the event name, the attempt count, the failure reason, and the last error message.


Both actions ask for confirmation first. If the action fails -- for example the orchestrator is unreachable -- the dialog closes and a red notification names the failure, so a failed retry is never mistaken for a successful one. The notification stays on screen until you dismiss it.
