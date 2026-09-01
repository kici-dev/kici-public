---
title: Git credentials
description: Authenticated git in a workflow — declaring credentials from the secrets backend, and pushing
---

Two facts drive everything on this page, and neither is guessable:

- **Cloning your own repository needs no credential.** The framework checks it
  out for you, and the app KiCI installs already holds read access.
- **Pushing always needs a credential you supply.** The KiCI app holds read
  access only, so every push — including to the job's own repository — needs one.

## Declare credentials once, by name

Credentials are declared on the job as a named map. **Every value is the name of
a secret**, in `<context>:<secret-name>` form — never the credential itself:

```typescript
job('release', {
  runsOn: 'linux',
  gitCredentials: {
    // `default` is used whenever a call names no credential
    default: {
      kind: 'app',
      appIdSecret: 'ci:ACME_APP_ID',
      installationIdSecret: 'ci:ACME_INSTALL_ID',
      privateKeySecret: 'ci:ACME_APP_KEY',
    },
    forge: { kind: 'token', tokenSecret: 'ci:FORGE_PAT' },
    vendor: { kind: 'ssh', privateKeySecret: 'ci:VENDOR_DEPLOY_KEY' },
  },
  steps: [build, tagAndPush],
});
```

Store the secrets first with `kici-admin secret set`. Pasting a private key
straight into the workflow is rejected when the workflow is defined, naming the
field — a key written into `.kici/` would be committed to your repository.

## Push

Your checkout is read-only by default. Opening a write window is explicit:

```typescript
step('tag', async ({ $, repo }) => {
  await $`git tag v${version}`;
  await repo.withWrite({ permissions: { contents: 'write' } }, async () => {
    await $`git push origin v${version}`;
  });
});
```

Inside the callback, git operations on that repository use a write credential.
Outside it they do not, so an accidental push elsewhere in the job fails.

Pass `credential: 'forge'` to use a named entry instead of `default`.

**KiCI never guesses the permission set.** What a push needs depends on what is
being pushed — changing anything under `.github/workflows/` additionally requires
`workflows`:

```typescript
await repo.withWrite({ permissions: { contents: 'write', workflows: 'write' } }, async () => {
  await $`git push origin HEAD`;
});
```

If the app was not granted a permission you request, the forge refuses to issue
the credential at all. The error names the repository and the permissions you
asked for, **before any git command runs** — not at the end of a long build.

## Clone more than one repository

A workflow often needs several repositories, not just its own. Mint one token
that covers all of them, then clone each with it:

```typescript
const { token } = await kici.git.github.getToken({
  repositories: ['acme/app', 'acme/shared-lib'],
  permissions: { contents: 'read' },
});

for (const repo of ['acme/app', 'acme/shared-lib']) {
  await $`git clone https://x-access-token:${token}@github.com/${repo}.git`;
}
```

A GitHub App token is issued per installation, so one call covers every
repository you name. Each repository must be inside the app's installation. If
one is not, the forge refuses the whole request and the error names it.

The credential helper is installed on your own checkout only, so a repository
you clone yourself does not inherit it. That is why this case mints a token
rather than relying on the helper.

## Call the forge API

`gh` does not read git credential helpers, so this is the one case that wants the
token as a value:

```typescript
const { token } = await kici.git.github.getToken({
  repositories: ['acme/app'],
  permissions: { contents: 'write' },
});
await $({ env: { ...process.env, GH_TOKEN: token } })`gh release create v${version}`;
```

The token is masked in step logs. Prefer `withWrite` for git itself, which never
places a credential in the step environment.

## Credentials that only exist at run time

A credential fetched during the run — from a vault, or a cloud secret store via
the job's OIDC identity — cannot be named ahead of time. Use the `*Value` half of
the pair, which says "this is the credential, not a name for one":

```typescript
gitCredentials: { default: { kind: 'token', tokenValue: fetchedAtRuntime } }
```

To pass a derived credential to a **later** job, publish it with
`ctx.setSecretOutput()` and name it with the reserved `needs:` context — that
path is encrypted, scoped to the run, and deleted when the run ends:

```typescript
const mint = job('mint', {
  runsOn: 'linux',
  run: async (ctx) => {
    const token = (await ctx.$`vault write -f auth/token/create`).stdout.trim();
    ctx.setSecretOutput('FORGE_TOKEN', token);
  },
});

const build = job('build', {
  runsOn: 'linux',
  needs: [mint],
  gitCredentials: { default: { kind: 'token', tokenSecret: 'needs:FORGE_TOKEN' } },
  steps: [cloneAndPush],
});
```

Never put a credential in a regular job output: regular outputs are not masked,
are stored, and are shown in the dashboard.

For a **minted app token**, prefer re-deriving over transporting — those expire
after an hour, so one minted in an earlier job is often already dead by the time
a later job reads it. Have the later job name the same secret, or mint its own.

## How it works, and why long jobs still push

An app token expires an hour after it is issued, and cannot be renewed. Rather
than capture one at checkout time, the agent installs a git credential helper on
the checkout: git asks it on every network operation, and it obtains a fresh
credential each time. A push at the end of a three-hour build works exactly as it
does at the start, and no credential is ever written into `.git/config`, into
`git remote -v`, or into the step's environment.

## Limits worth knowing

- **Container jobs cannot use this yet.** A container job runs git inside the
  container, which has no route to the credential service. Bare-metal jobs are
  unaffected.
- **The reserved `needs:` context is not resolvable yet** on a deployed
  orchestrator; naming it produces a clear error rather than a wrong credential.
- **A write window is bounded by the repository and the callback, not the step.**
  Steps running concurrently in the same job can push to the same repository
  while it is open. They cannot reach a different one.
- **A credential you supply yourself cannot be narrowed.** A personal access
  token or SSH key grants whatever it was created with, so a requested permission
  set is reported as unscoped rather than pretended to be enforced.
- **Being allowed to push is not the same as the push succeeding.** A branch
  protection rule or repository ruleset can still reject it.
