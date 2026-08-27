---
name: bump-version
description: Bump or update a repository's version number — package.json, pyproject.toml, Cargo.toml, Chart.yaml, VERSION files and friends — following the conventions the repo already uses for bumping, committing, tagging, and changelogs. Use this whenever the user asks to bump, update, or set a version, cut or prepare a release, or get a change ready to publish, and also when work you just finished needs a version bump before it can ship. Trigger it even on terse phrasings like "update the package", "bump it", "new version", or "ship this" — the version bump is usually what they mean.
---

# Bump a repository's version

A version bump is a tiny diff that is easy to get subtly wrong: the number lands in the
wrong file, the lockfile drifts, the commit doesn't match the style of every other release
commit, or a tool that owns the version gets overwritten by hand. None of that shows up
until release time, when it's expensive.

So the work here is mostly **reading the repo before writing to it**. The repo already
knows how it does releases; your job is to find that out and follow it, not to impose a
generic convention.

## 1. Find the version, and find out who owns it

First locate the current version, then — before editing anything — check whether a tool
owns it. Some setups derive the version from git tags or generate the bump commit
themselves, and hand-editing those actively breaks the release.

```bash
git log --oneline -20
ls -a                      # look for release config in the root
```

Signs the version is **not** yours to hand-edit:

| What you find | What owns the version |
|---|---|
| `.changeset/` directory | Changesets — add a changeset file instead; CI does the bump |
| `release-please-config.json`, `.release-please-manifest.json` | release-please — bumps come from Conventional Commits |
| `.releaserc*`, `semantic-release` in devDependencies | semantic-release — CI derives the version from commits |
| `[tool.setuptools_scm]`, `versioningit`, `dunamai` | Version is derived from git tags; the tag *is* the bump |
| `.bumpversion.cfg`, `[tool.bumpversion]` | bump-my-version / bump2version — run the tool so every file it tracks stays in sync |
| No version field at all (Go modules, most Composer packages) | The git tag is the version; there is no file to edit |

When one of these is present, use it rather than editing files, and say so — the user may
not know their repo is set up that way. If it is genuinely a plain hand-maintained version
field, continue.

Watch for the same version appearing in more than one place: a lockfile (`package-lock.json`,
`Cargo.lock`), a `__version__` in `__init__.py`, a `Chart.yaml` `appVersion`, a README badge,
a Dockerfile label. Grep for the current version string so you catch every copy:

```bash
grep -rn --exclude-dir=node_modules --exclude-dir=.git "1\.2\.3" .
```

## 2. Learn the repo's release convention from its history

Read the last several releases rather than guessing. Three things matter, and each varies
a lot between repos:

```bash
git log --oneline -20              # how are release commits worded?
git tag --sort=-creatordate | head # are there tags, and what shape — v1.2.3 or 1.2.3?
ls CHANGELOG.md HISTORY.md 2>/dev/null
```

Commit message styles you'll actually meet: a bare number (`1.0.4`, what `npm version`
produces), `chore(release): v1.2.0`, `Bump version to 1.2.0`, or a Conventional Commits
`chore: release 1.2.0`. Match whichever the repo uses — release commits are scanned by
humans and sometimes by scripts, so consistency has real value.

If the repo has tags, plan to create one in the same shape. If it has none, don't
introduce tagging as a side effect of a bump; that's a change of practice, not a bump.

## 3. Choose the bump from what actually changed

Read the commits since the last release, then apply semver honestly:

```bash
git log --oneline <last-version-tag-or-commit>..HEAD
git diff <last-version-tag-or-commit>..HEAD --stat
```

- **patch** — bug fixes, internal refactors, docs, dependency bumps with no API change
- **minor** — new functionality that existing callers can ignore: a new export, a new
  optional parameter, a new CLI flag
- **major** — anything that breaks an existing caller: removed or renamed exports, changed
  return shapes, raised minimum runtime versions

Two things worth pausing on. Below `1.0.0` many projects treat minor as their breaking
bump, so check whether the repo's own history does that before applying strict semver. And
a major bump is a promise to every consumer — when the change looks breaking, say so and
confirm rather than deciding unilaterally.

State your reasoning in one line when you report back ("new exported function, so minor").
It's the part the user is most likely to want to overrule, and it's cheap to change before
the commit and annoying after.

## 4. Apply the bump with the ecosystem's own tool

Prefer the native tool over editing files by hand — it updates every place the ecosystem
knows about (lockfiles especially) and won't typo the JSON.

| Ecosystem | Command |
|---|---|
| npm / Node | `npm version <major\|minor\|patch> --no-git-tag-version` (also updates `package-lock.json`) |
| Yarn | `yarn version --new-version <version> --no-git-tag-version` |
| Poetry | `poetry version <major\|minor\|patch>` |
| uv | `uv version --bump <major\|minor\|patch>` |
| Plain PEP 621 | edit `[project] version` in `pyproject.toml` (plus any `__version__`) |
| Rust | `cargo set-version <version>`, else edit `Cargo.toml` and run `cargo update -p <crate>` to refresh `Cargo.lock` |
| Maven | `mvn versions:set -DnewVersion=<version>` |
| Gradle | edit `version` in `gradle.properties` or `build.gradle` |
| .NET | edit `<Version>` in the `.csproj` or `Directory.Build.props` |
| Helm | edit `version` in `Chart.yaml` (and `appVersion` when the app itself moved) |

Pass the "don't tag/commit for me" flag (`--no-git-tag-version` and friends) when you want
to control the commit message and tag yourself, which you usually do — the default commit
these tools write may not match the repo's convention.

## 5. Keep the diff to the version and nothing else

A release commit should be readable at a glance. The common way it stops being readable:
running an install (`npm install`, `poetry lock`, `cargo build`) as part of the work
rewrites the lockfile wholesale — hundreds of lines of unrelated dependency churn ride
along with two version lines.

Check the diff before committing, and revert anything that isn't the bump:

```bash
git diff --stat
git diff                      # expect only version fields
git checkout -- package-lock.json   # if it picked up unrelated churn
```

Then verify the project still builds, since a broken build tagged as a release is the
expensive failure mode:

```bash
npm run build     # or the repo's equivalent: cargo build, poetry build, mvn package
```

## 6. Update the changelog if the repo keeps one

If `CHANGELOG.md` exists, add an entry in the format already in the file — usually a
`## [1.2.0] - YYYY-MM-DD` heading with grouped bullets (Added / Changed / Fixed). Describe
changes in terms of what a consumer of the package notices, not the internal mechanics.
Skip this silently when the repo has no changelog; adding one is a separate decision.

## 7. Commit, tag, push

```bash
git commit -m "<message matching the repo's convention>"
git tag v1.2.0        # only if the repo tags releases, in its existing shape
git push -u origin <branch>
git push origin v1.2.0
```

If the repo's history shows no tags, skip tagging. If it tags but you're on a feature
branch, hold the tag until the branch merges — tags on branch commits that later get
squashed point at commits nobody keeps.

## 8. Publish to the registry

A bump that never gets published is invisible to consumers — `npm install` still hands them
the old version. So the release isn't finished at the commit; it's finished when the new
version is on the registry.

**First check whether CI already does it.** If a workflow publishes on tag or release,
pushing the tag *is* the publish, and running it again locally races with CI or fails on a
duplicate version:

```bash
grep -rl "publish\|release" .github/workflows/ 2>/dev/null
```

**Then confirm what you're about to push, and where.** A dry run prints the exact file
list, the resolved version, and the registry it would go to — cheap insurance against
publishing to the wrong registry or shipping a package that's missing its build output:

```bash
npm publish --dry-run
npm whoami --registry=https://registry.npmjs.org   # confirm you're authenticated
```

Scoped packages are the usual surprise here: `@scope/name` goes to npmjs.org by default,
and only lands somewhere else if `publishConfig.registry` is set in `package.json` or the
scope is mapped in `.npmrc` (`@scope:registry=https://npm.pkg.github.com`, with the token
in `NODE_AUTH_TOKEN` or `GITHUB_TOKEN`). A scoped package's first *public* release on
npmjs also needs `--access public`, since scoped packages default to private.

If `prepublishOnly` or `prepack` is defined, it runs before the upload — a failing build
stops the publish, which is exactly what you want.

**Then publish:**

| Ecosystem | Command |
|---|---|
| npm | `npm publish` (add `--access public` for a scoped package's first public release) |
| Yarn (berry) | `yarn npm publish` |
| Rust | `cargo publish` |
| Python | `poetry publish --build`, or `python -m build && twine upload dist/*` |
| Maven | `mvn deploy` |
| .NET | `dotnet nuget push <pkg>.<version>.nupkg --source <feed>` |
| Helm | `helm push <chart>-<version>.tgz oci://<registry>` |
| Go | nothing to upload — the pushed tag is the release |

Confirm it landed, since a silent failure here is easy to miss:

```bash
npm view <package-name> version
```

**Version numbers are single-use.** npm refuses to republish over an existing version,
unpublishing is only allowed within 72 hours and is blocked once others depend on it, a
yanked crate doesn't free its number, and PyPI won't accept a re-upload of a deleted
release. That's why the dry run comes first — and if something does slip through, the fix
is another bump, never a re-publish of the same number.

Because publishing is outward-facing and effectively permanent, make sure this release is
actually meant to go out before running it — then run it. Publishing to a registry the
user hasn't mentioned, or on credentials you haven't confirmed, is the one thing worth
stopping to ask about.

## Quick checklist

1. Locate the version — and confirm no tool (changesets, release-please, setuptools-scm) owns it
2. Read `git log`/`git tag` for the repo's commit, tag, and changelog conventions
3. Pick major/minor/patch from the commits since the last release; confirm anything breaking
4. Bump with the ecosystem's tool, keeping tag/commit control
5. Grep for other copies of the old version and update them too
6. Check the diff is only version lines; build to confirm it still works
7. Changelog entry, if the repo has one
8. Commit in the repo's style, tag if it tags, push
9. Publish: check CI doesn't already do it, `--dry-run` to verify files and registry, then publish and confirm it landed
