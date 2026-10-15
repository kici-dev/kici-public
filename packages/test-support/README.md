# @kici-dev/test-support

Test helpers that the KiCI package test suites share. This package is never published to npm.
The public source mirror carries it, because the tests of the public packages import it.

## Modules

- `@kici-dev/test-support/test-db`: `describeWithTestDb` gives a suite its own throwaway
  PostgreSQL database. The harness creates and migrates the database before the suite and
  drops it after the suite. `terminateTestDbBackends` closes the connections that still hold
  a test database, so that the test can drop the database.
- `@kici-dev/test-support/mock-db-query`: the query evaluator that the in-memory mock databases
  use to apply `where` filters and `select` projections.
- `@kici-dev/test-support/logger-mock`: `withSilentLogger` is the body of the
  `vi.mock('@kici-dev/shared', …)` call that silences the logger and keeps every other export.
  The `vi.mock` call stays in the `src/__test-helpers__/shared-mocks.ts` file of each package,
  because vitest hoists `vi.mock` only in the modules that it transforms. A test file imports
  that file before the module under test.

A helper that needs the types of one package stays in the `src/__test-helpers__/` directory of
that package.

## Rules

- Put a helper here only when two or more packages use it.
- Import this package only from test code. Never import it from the source of a package.
- Package builds do not include test helpers, so a published package never imports this
  package.
