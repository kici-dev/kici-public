---
title: Account and sign-in
description: How your KiCI account relates to sign-in methods, and how to change the way you sign in.
---

Your KiCI account is a single identity. It stays the same no matter how you
sign in — whether you signed up with GitHub or with an email and password.
Changing your sign-in method does not create a new account or move your data;
your organizations, roles, and API keys stay attached to the same identity.

## Where sign-in methods are managed

Sign-in methods and passwords are managed in your **account console**, provided
by the identity provider that handles single sign-on for KiCI. The dashboard's
**Linked accounts** page does not control how you sign in — see
[Linked accounts vs sign-in methods](#linked-accounts-vs-sign-in-methods) below.

You can open the account console from the dashboard: go to your personal
settings, open **Linked accounts**, and use the **Account console** link.

## Adding a password to a GitHub-created account

If you registered by signing in with GitHub and now want to sign in with an
email and password as well:

1. Open your account console.
2. Add a password (and, if prompted, confirm your email).

After this, you can sign in either with GitHub or with your email and password —
it is the same account.

## Removing GitHub as a sign-in method

To stop using GitHub to sign in:

1. First add a password (see above). The identity provider will not let you
   remove your only sign-in method, so you must have another one first.
2. In your account console, remove the GitHub sign-in method.

Your account, organizations, and data are unaffected — you simply sign in a
different way afterward.

## Linked accounts vs sign-in methods

The dashboard's **Linked accounts** page controls **run-attribution metadata**
only — for example, showing your GitHub username on the runs you trigger and
determining your contributor trust level. Unlinking a provider there removes
that display link; it does **not** remove the provider as a way to sign in.

To actually change how you sign in, use your account console as described above.
