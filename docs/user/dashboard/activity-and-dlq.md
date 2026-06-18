---
title: Activity and DLQ
description: The org forensic activity log and the dead-letter queue.
---



## Activity

The activity page (`/orgs/:customerId/activity`) is the org-level forensic log. It merges two streams into one chronological view: tenant-plane audit entries (every tenant-plane mutation -- invites, role changes, source registrations, plan changes) and orchestrator access entries (every read and admin action -- run cancels, secret reveals, environment edits, dashboard data fetches). Filters live in the URL via search params so a filtered view is bookmarkable and shareable. The page uses cursor-based pagination and supports filtering by source (audit / access / all), free-text search, run ID, and other dimensions. Requires `audit:read` permission. The legacy `/orgs/:customerId/audit-log` URL redirects here to preserve bookmarks.

## DLQ

The DLQ (dead-letter queue) page lists internal events whose dispatch attempts were exhausted (or that hit a non-retryable error). Each row shows when the event landed in the DLQ, the event name, the attempt count, the failure reason, and the last error message.

