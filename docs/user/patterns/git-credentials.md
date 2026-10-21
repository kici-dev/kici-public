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

Store the secrets first with `kici-admin secret set`, in a scope bound to the
context the reference names (`kici-admin context bind`). A `ci:` reference is
read through the bindings of the `ci` context, the same way a job's context
secrets are. If no scope bound to the `ci` context carries the secret, the
reference is refused: a scope that only shares the context's name is not read. Pasting a private key straight into the workflow is rejected when the
workflow is defined, naming the field — a key written into `.kici/` would be
committed to your repository.

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

## SSH keys

A `kind: 'ssh'` credential is a private deploy key. Use it when a forge accepts a
key and not a token, or to push to a repository the KiCI app cannot reach.

### The job needs an ssh client

The machine that runs the job must have an `ssh` command on its `PATH`. The
[default agent image](../container-jobs.md#the-default-agent-image) has none.
Install one with the [apt preset](../sdk/core.md#toolchain-presets):

```typescript
job('publish', {
  runsOn: 'linux',
  init: { apt: { packages: ['openssh-client'] } },
  gitCredentials: { pages: { kind: 'ssh', privateKeySecret: 'ci:PAGES_DEPLOY_KEY' } },
  steps: [publish],
});
```

If no ssh client is on `PATH` after the init phase, the job fails before its
first step. The error names the credentials and the fix.

### Push to the SSH URL inside `withWrite`

The key applies only inside a `withWrite` callback, and only to git commands
that run in the job's checkout (`repo.path`) and reach an SSH URL. KiCI does
not change `origin`, which stays an HTTPS URL. Name the SSH URL in the push:

```typescript
await repo.withWrite({ permissions: { contents: 'write' }, credential: 'pages' }, async () => {
  await $`git push git@github.com:acme/site.git HEAD:refs/heads/gh-pages`;
});
```

For the length of the callback, the checkout's `core.sshCommand` setting points
ssh at the key. When the callback ends, KiCI puts back the previous setting. Git
in another directory, or outside the callback, does not use the key.

The key is a file that the job's processes can read while the window is open.
KiCI deletes it when the last window that uses it closes.

### Host keys are checked strictly

ssh refuses a host whose key it does not already know. It never trusts a key on
first use, and KiCI never writes a host key for you. ssh accepts a host key from
these places:

- The keys that GitHub (`github.com`), GitLab (`gitlab.com`) and Bitbucket Cloud
  (`bitbucket.org`) publish. The agent includes them.
- `~/.ssh/known_hosts` of the user that runs the job.
- The machine's `/etc/ssh/ssh_known_hosts`.

To push to another host, add its key to `~/.ssh/known_hosts` in a step before
`withWrite`. Take the key from a source you trust, such as the forge's
documentation. Do not take it from `ssh-keyscan` during the run: that trusts
whatever key the network shows. If a forge changes its key before your agent is
updated, add the new key the same way.

An unknown host fails the push with `Host key verification failed`.

### What an SSH key cannot do

- **Permissions do not narrow it.** The key can do what the forge allows it to
  do, whatever `permissions` the window asks for.
- **Container jobs cannot use it.** The key stays on the agent's host, so a job
  with `container:` cannot read it. Opening the write window fails and names
  `container:`.

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

## What a job may ask for

A credential is authorized against the workflow you wrote, not against the code
running in the job. Three things must all hold before the orchestrator resolves
one:

1. **The job declared it.** The orchestrator records the job's `gitCredentials`
   map when it dispatches the job, and compares every request against that
   record. A request naming a credential the job did not declare is refused.
   This is why you pass `credential: 'forge'` — a name — rather than building a
   credential reference in step code.
2. **The named context admits the run.** A `prod:` reference runs the `prod`
   context's own protection rules first: its branch restrictions, its
   `minimumTrust`, its approval requirement. A credential named from a branch
   the context does not allow is refused, and the git operation fails. The job
   sees `Refusing a git credential for '<repo>': context 'prod' did not provide
it for this run in org '<org>'`, followed by the three possible causes: the
   context does not exist in that org, its protection rules do not admit the
   run, or no secret bound to it carries the key. The orchestrator log line
   `Git credential refused` names which cause applied, and the rule. The job
   does not get the rule, because the orchestrator does not describe its own
   configuration to code it does not trust. The org is the org of the run's
   source: a context in a different org on the same orchestrator does not
   provide a credential to the run.
3. **The contributor is trusted.** A run from an untrusted ref — a fork pull
   request — gets no declared credential at all. It still clones with the
   source credential, so the build runs; only the declared credentials are
   withheld. The reduced-privilege note on the run says so.

For a job of an [organization-wide workflow](../global-workflows.md#secrets-come-from-the-workflow-repository),
the context's repository and branch rules check the workflow repository and the
branch its workflow was registered from, not the source repository.

The context in a reference does **not** have to appear in the job's `contexts:`
list. The reference names its own context, and that context's rules are what
authorize it.

## Generated jobs

A job produced by a `dynamicJob` generator has no entry in the lock file, so it
cannot declare credentials of its own. The **generator** declares them, and every
job it produces inherits that map:

```typescript
dynamicJob('shards', {
  gitCredentials: {
    forge: { kind: 'token', tokenSecret: 'ci:FORGE_PAT' },
  },
  generate: async ({ ctx }) =>
    ctx.event.payload.targets.map((target) =>
      job(`publish-${target}`, {
        runsOn: 'linux',
        run: async ({ $, repo }) => {
          await repo.withWrite(
            { permissions: { contents: 'write' }, credential: 'forge' },
            async () => {
              await $`git push origin HEAD`;
            },
          );
        },
      }),
    ),
});
```

Three points follow from where the declaration lives:

- **All generated jobs share one map.** The generator is granted one ceiling, and
  every job it produces gets exactly that ceiling. Use a second generator when
  two sets of jobs need different credentials.
- **A `gitCredentials` map on a generated job is ignored.** The generator's
  declaration is committed source that KiCI reads from the lock file. A generated
  job's own declaration would come from the code that produced it, which is what
  the authorization check above exists to be independent of.
- **The options form is required.** `dynamicJob('shards', async () => …)` — the
  bare function form — has nowhere to put the declaration. Pass
  `{ generate, gitCredentials }` instead; `needs` stays optional.

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
- **A credential reference built in step code is refused.** The SDK takes a
  credential _name_; there is no way to pass a reference. Code that constructs
  one and sends it directly is rejected by the agent and, if it reaches the
  orchestrator, by the declaration check above.
- **A write window is bounded by the repository and the callback, not the step.**
  Steps running concurrently in the same job can push to the same repository
  while it is open. They cannot reach a different one.
- **A credential you supply yourself cannot be narrowed.** A personal access
  token or SSH key grants whatever it was created with, so a requested permission
  set is reported as unscoped rather than pretended to be enforced.
- **An SSH key has its own requirements:** an ssh client on the job's machine,
  a push to an SSH URL, and a known host key. See [SSH keys](#ssh-keys).
- **Being allowed to push is not the same as the push succeeding.** A branch
  protection rule or repository ruleset can still reject it.
