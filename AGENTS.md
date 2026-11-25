# clear-pi contributor instructions

## Version every pull request

Every PR targeting `main` must carry a stable SemVer version greater than the
current `main` version, including documentation, tests, dependencies and CI-only
changes. Update from the latest `main` before choosing the version. If another PR
merges first using that version, update/rebase and select a new version before merge.

Choose the bump according to the user-visible impact:
- **patch**: compatible bug fixes, documentation, tooling, tests and maintenance;
- **minor**: new backward-compatible functionality;
- **major**: breaking behavior, configuration or supported-host compatibility.

Use `npm version patch --no-git-tag-version` (or `minor` / `major`). Commit both
`package.json` and `package-lock.json`. Add a meaningful `## [X.Y.Z]` entry to
`CHANGELOG.md` describing the changes. Keep one final version for the whole PR,
not one increment per commit; revise it only if the scope or main version changes.
Do not create release tags locally or move/delete an existing release tag.

Before handing off a PR, run:

```sh
git fetch origin main
npm ci
npm run check:version -- --base origin/main
npm run typecheck
npm test
npm run check:package
```

CI validates increasing versions, matching lockfile metadata and changelog entries.
The `CI / verify` check should be required by branch protection, with branches
required to be up to date before merging (or use equivalent merge serialization).
This prevents two independently green PRs from merging the same version.

## Release architecture

Keep `main` protected: require PRs, restrict deletions and block force pushes.
The release workflow must never commit or push to `main`, bypass its protections,
or reset its checkout to a later branch tip. For each push to `main`, verify and
package exactly the event SHA, tag it `v<package.json version>`, and publish the
GitHub Release with its npm tarball. The version comes from the reviewed PR;
there is no additional automatic bump after merge. Reruns may reuse a tag only
when it points to the same commit. Never silently replace a different source.

Pi loads the shipped TypeScript directly. Keep an explicit `pi.extensions` entry,
include all runtime helpers and `config.json` in the package, and exclude tests,
CI and development dependencies. npm publication is not configured or implied.
