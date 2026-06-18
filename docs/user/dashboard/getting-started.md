---
title: Getting started
description: The dashboard onboarding checklist and your organizations list.
---


## Getting started

When you first sign in to a brand-new organization with no orchestrator, no webhook source, and no runs, the dashboard opens this page automatically. Once your organization has any activity, the run list becomes your landing page instead. The **Getting started** sidebar entry stays available so you can return to the checklist at any time.

The six steps are:

1. **Install the kici CLI** -- `npm install -g kici`.
2. **Create a workflow** -- `kici init` scaffolds a `.kici/` directory in your repository.
3. **Run a workflow locally** -- `kici run local pr:open` executes a workflow on your machine with no orchestrator required.
4. **Connect an orchestrator** -- deploy an orchestrator and connect it with a join token from **Settings → Orchestrator keys**.
5. **Add a webhook source** -- register a source under **Settings → Sources** so pushes and pull requests trigger runs.
6. **Trigger your first run** -- push to your repository to produce your first run through the relay.

## Organizations


The organizations page (`/orgs`) lists all organizations your account has access to.

Organizations are sorted alphabetically by display name. Each entry shows your role (owner or member). A "Create organization" button opens an inline form to create a new org by name.
