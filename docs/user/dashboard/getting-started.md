---
title: Getting started
description: The dashboard onboarding checklist and your organizations list.
---


## Getting started

When you first sign in to a brand-new organization with no orchestrator, no webhook source, and no runs, the dashboard opens this page automatically. Once your organization has any activity, the run list becomes your landing page instead. The **Getting started** sidebar entry stays available until your organization has a connected orchestrator, a webhook source, and at least one run. After that, the entry is hidden, and a visit to the getting-started URL opens the run list.

The six steps are:

1. **Install the kici CLI** -- `npm install -g kici`.
2. **Create a workflow** -- `kici init` scaffolds a `.kici/` directory in your repository.
3. **Run a workflow locally** -- `kici run pr:open --local` executes a workflow on your machine with no orchestrator deployment required.
4. **Connect an orchestrator** -- deploy an orchestrator and connect it with a join token from **Settings → Orchestrator keys**.
5. **Add a webhook source** -- register a source with `kici-admin source add`; it then appears under **Settings → Sources**, where you can view its webhook URL. Pushes and pull requests to that source trigger runs.
6. **Trigger your first run** -- push to your repository to produce your first run through the relay.

If the onboarding data can't be loaded (for example a transient network error), the checklist area shows a short message with a **Try again** button instead of loading indefinitely -- retry once the connection recovers.

## Organizations


The organizations page (`/orgs`) lists all organizations your account has access to.

Organizations are sorted alphabetically by display name. Each entry shows your role (owner or member). A "Create organization" button opens an inline form to create a new org by name.

## Invitations

An invite email carries a link to the invite page. When you are not signed in, the page asks you to sign in or sign up first, and then returns you to the invite. The link keeps working through the sign-in for one hour. The page shows the invite to one account: the account whose verified email is the address the invite names. For any other account, the page says the invite is for another email address and offers a **Sign out** button. Sign in with the invited address, then open the link again.

**Accept** adds you to the organization and opens its run list. **Decline** removes the invite.

When you have pending invites, a banner lists them on the organizations page and above the pages of each organization. Each row names the organization and the invited role, with **Accept** and **Decline** buttons. When you close the banner, it stays hidden until the next page reload.
