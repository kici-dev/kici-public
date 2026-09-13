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
- **Fleet** -- read-only view of the organization's declared host fleet, listing each host's status, labels, and a per-host detail page (shown directly below Workflows, only when you hold `fleet:read`)
- **Attestations** -- build-provenance attestations produced by workflow runs, with a verify-status filter and a per-attestation detail page
- **Infrastructure** -- per-org infrastructure health: an orchestrator → scaler → agent tree, execution metrics, infrastructure alerts, and secret-backend health. Each orchestrator cluster is a row keyed by cluster name with a **Manage** link into its per-cluster scoped views (overview, contexts, secrets, DLQ, workflows)
- **Metrics** -- time-series charts of orchestrator health (dispatch & agents, execution, webhooks, caching, logs, errors), scoped to this org
- **Contexts** -- deployment contexts with protection rules. Contexts and secrets belong to an orchestrator, so this entry opens the contexts page of the org's orchestrator (or asks you to pick one when the org has several), and stays highlighted while you are on it
- **Secrets** -- secret scope management with context bindings, opened on the org's orchestrator the same way as Contexts
- **Approval queue** -- held runs pending approval (shows a badge with pending count)
- **Activity** -- forensic log merging tenant-plane mutations and orchestrator reads into one chronological stream
- **DLQ** -- dead-letter queue of internal events whose dispatch retries were exhausted (shows a badge with the current depth)
- **Notifications** -- execution-notification channels, Slack connections, subscriptions, and the delivery log
- **Settings** -- organization settings with tabbed sub-pages

The sidebar footer shows the WebSocket connection indicator, your user profile, UTC/local time toggle, theme toggle, and a collapse button.


### Mobile navigation

On screens narrower than 768px (the `sm` breakpoint), the sidebar collapses and is replaced by a bottom tab bar. The bar shows four primary destinations -- Runs, Infra (infrastructure), Metrics, Settings -- plus a **More** tab that opens a drawer listing every remaining destination: Workflows, Attestations, Contexts, Secrets, Approval queue, Activity, DLQ, Notifications, and (when applicable) Getting started and Fleet. Every destination in the desktop sidebar is therefore reachable on mobile.

When runs are waiting for your approval, an **Approvals** tab with a red count badge appears directly in the bottom bar so approvers can reach the approval queue in one tap; otherwise the approval queue lives in the More drawer. The mobile tab list is derived from the same navigation source as the desktop sidebar, so the two never drift.

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

| Key              | Context    | Action                                      |
| ---------------- | ---------- | ------------------------------------------- |
| j                | Run list   | Move the selection down                     |
| k                | Run list   | Move the selection up                       |
| Enter            | Run list   | Open the selected run                       |
| /                | Log viewer | Focus the log search box                    |
| n                | Log viewer | Jump to next match                          |
| p                | Log viewer | Jump to previous match                      |
| Enter            | Log search | Jump to next match (search box focused)     |
| Shift+Enter      | Log search | Jump to previous match (search box focused) |
| Escape           | Log search | Clear search (search box focused)           |
| Arrow Up/Down    | Job tree   | Move focus                                  |
| Arrow Right/Left | Job tree   | Expand/collapse the focused job or group    |
| Enter            | Job tree   | Select job or step                          |
| Escape           | Job tree   | Deselect                                    |
| ?                | Anywhere   | Show the keyboard shortcuts overlay         |
| Escape           | Any dialog | Close the open dialog                       |

Press `?` anywhere in the dashboard to open an overlay listing every shortcut. Shortcuts that only move a highlight or open a panel -- the run-list `j` / `k`, the log-viewer `/` / `n` / `p`, and `?` itself -- are ignored while you are typing in a text field, so they never interfere with search or forms. Focus on a control you cannot type into -- a checkbox, radio button, toggle, file/range picker, or a dropdown with no search box -- does not suppress them, so they keep working after you flip a toggle, press a toolbar button, or pick a filter. A searchable dropdown does suppress them, because its box is a text field you can type in. `Enter` is the exception: any focused control -- a button, a link, a checkbox, a text field, a dropdown -- keeps it, so the key does whatever that control does rather than opening the highlighted run. All of them are also ignored while something is open on top of the page -- a dialog, a dropdown menu, or an open select -- so the shortcuts overlay never stacks on top of something you already have open, a single Escape closes the thing you are actually in, and keys never act on the page hidden behind an open menu. A help popover is not one of these: it takes no focus, so shortcuts keep working while one is showing.

## Error pages

The dashboard shows informative error pages instead of blank screens:

- **404** -- "Page not found" with a "Go home" button linking to the organizations page
- **500** -- "Failed to load" with an error message, a trace ID for support, and a "Go home" button (shown when API requests fail)
- **Client-side rendering errors** -- caught by the error boundary, showing "Something went wrong" with a trace ID and a "Reload page" button
- **Auth errors** -- authentication failures on the OIDC callback page show the error message with a retry mechanism and a "Back to login" link
