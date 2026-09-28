# Dependency patches

pnpm applies each patch in this directory to one exact dependency version, as listed under `patchedDependencies` in `pnpm-workspace.yaml`. Each patch carries an upstream fix that no release contains yet.

| Patch                | What it fixes                                                                                                                                                                                                               | Upstream                                                                                                                                      | Remove when                       |
| -------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------- |
| `vitest@5.0.1.patch` | `Vitest.close()` removes the root temporary directory (`Vitest._tmpDir`). Without the patch, every run leaves a directory with a 21-character name and an `ssr/` folder of module copies in the system temporary directory. | [vitest-dev/vitest#11248](https://github.com/vitest-dev/vitest/pull/11248), issue [#11224](https://github.com/vitest-dev/vitest/issues/11224) | A vitest release contains #11248. |

## After a version bump

A patch keyed to one version does not apply to the next one. When you bump a patched dependency, do one of these:

- If the new version contains the upstream fix, delete the patch file, its `patchedDependencies` entry and its row above.
- If it does not, derive the patch again. Run `pnpm patch <name>@<new-version>`, make the same change, and run `pnpm patch-commit <dir>`. Then delete the old patch file and its entry, and update the row above.

Keep this file when no patch remains. Git does not track an empty directory, and the service Dockerfiles copy this directory, so an image build fails without it.
