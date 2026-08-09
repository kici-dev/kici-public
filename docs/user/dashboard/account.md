---
title: Account
description: Personal account settings.
---




Your own email-to-self run notifications live on the dedicated [Notifications](./notifications.md) page (in the org sidebar), on its **My notifications** tab. The `/orgs/:customerId/account/notifications` URL redirects there.

## Account

The standalone account page (`/account`) provides access to personal settings outside of any organization context. It has these tabs:

- **Profile** -- view your name and email
- **Personal access tokens** -- create and revoke PATs for programmatic API access
- **Linked accounts** -- connect external provider identities (e.g. GitHub) to your KiCI account

Linked accounts control run-attribution metadata only — unlinking a provider here does not remove it as a way to sign in. To change how you sign in, see [Account and sign-in](../account-and-login.md).

Your own run notifications are org-scoped, so they live on the [Notifications](./notifications.md) page inside an organization rather than on this standalone page.

This page is also accessible within an org context via the user menu in the sidebar (`/orgs/:customerId/account`).
