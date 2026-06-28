---
title: Account
description: Personal account settings.
---





## Account

The standalone account page (`/account`) provides access to personal settings outside of any organization context. It has these tabs:

- **Profile** -- view your name and email
- **Personal access tokens** -- create and revoke PATs for programmatic API access
- **Linked accounts** -- connect external provider identities (e.g. GitHub) to your KiCI account
- **My notifications** -- manage your own email-to-self run notifications for the current organization (no admin permission needed)

Linked accounts control run-attribution metadata only — unlinking a provider here does not remove it as a way to sign in. To change how you sign in, see [Account and sign-in](../account-and-login.md).

**My notifications** is scoped to the organization you are viewing — notifications match that org's runs and are emailed to your account address. Organization-wide channels and subscriptions (Slack, team/org recipients) live on the [organization Notifications settings](./settings.md#notifications) and need the notifications admin permission.

This page is also accessible within an org context via the user menu in the sidebar (`/orgs/:customerId/account`).
