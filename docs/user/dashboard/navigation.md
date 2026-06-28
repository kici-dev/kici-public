---
title: Navigation and layout
description: Sidebar, mobile navigation, theme, time display, keyboard shortcuts, and error pages.
---

## Navigation

### Sidebar

The left sidebar provides persistent navigation across all org-scoped pages:

- **Org switcher** -- dropdown at the top to switch between organizations
- **Getting started** -- onboarding checklist (shows a `done/total` badge until complete or dismissed)
- **Runs** -- the default landing page, showing your workflow run history
- **Workflows** -- permanently registered workflows listening for events
- **Fleet** -- read-only view of the organization's declared host fleet, listing each host's status, labels, and a per-host detail page (shown directly below Workflows, only when fleet management is enabled for the org and you hold `fleet:read`)
- **Diagnostics** -- infrastructure health, execution metrics, and recent errors
- **Metrics** -- time-series charts of orchestrator health (dispatch & agents, execution, webhooks, caching, logs, errors), scoped to this org
- **Orchestrators** -- the orchestrator clusters connected to this org, keyed by cluster name; selecting one opens its per-cluster scoped views (overview, environments, secrets, DLQ, workflows)
- **Environments** -- deployment environments with protection rules
- **Secrets** -- secret scope management with environment bindings
- **Approval queue** -- held runs pending approval (shows a badge with pending count)
- **Activity** -- forensic log merging tenant-plane mutations and orchestrator reads into one chronological stream
- **DLQ** -- dead-letter queue of internal events whose dispatch retries were exhausted (shows a badge with the current depth)
- **Settings** -- organization settings with tabbed sub-pages

The sidebar footer shows the WebSocket connection indicator, your user profile, UTC/local time toggle, theme toggle, and a collapse button.


### Mobile navigation

On screens narrower than 768px (the `sm` breakpoint), the sidebar collapses and is replaced by a bottom tab bar with six navigation items: Runs, Workflows, Envs (environments), Secrets, Health (diagnostics), and Settings. Note that the mobile tab bar shows a subset of the full sidebar navigation -- activity and approval queue are only available in the full desktop sidebar.

## Theme

The dashboard supports three theme modes:

- **System** (default) -- follows your operating system's dark/light preference
- **Dark** -- forced dark mode
- **Light** -- forced light mode

Toggle between modes using the sun/moon icon in the sidebar footer. The selection persists to `localStorage`.

## Date and time preferences

A toggle button in the sidebar lets you switch between **local time** and **UTC time** display. When UTC mode is enabled:

- All timestamps in the run list, run detail header, metadata panel, and log viewer show UTC times
- Tooltips on relative timestamps (e.g. "5 minutes ago") show the absolute time in UTC
- The timeline Gantt chart uses UTC for time labels

The preference persists to `localStorage`.

## Keyboard shortcuts

| Key           | Context    | Action                 |
| ------------- | ---------- | ---------------------- |
| Arrow Up/Down | Job tree   | Move focus             |
| Enter         | Job tree   | Select job or step     |
| Escape        | Job tree   | Navigate to first job  |
| Enter         | Log search | Jump to next match     |
| Shift+Enter   | Log search | Jump to previous match |
| Escape        | Log search | Clear search           |

## Error pages

The dashboard shows informative error pages instead of blank screens:

- **404** -- "Page not found" with a "Go home" button linking to the organizations page
- **500** -- "Failed to load" with an error message, a trace ID for support, and a "Go home" button (shown when API requests fail)
- **Client-side rendering errors** -- caught by the error boundary, showing "Something went wrong" with a trace ID and a "Reload page" button
- **Auth errors** -- authentication failures on the OIDC callback page show the error message with a retry mechanism and a "Back to login" link
