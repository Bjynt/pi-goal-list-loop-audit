# Releasing to npm

This repository publishes `pi-goal-list-loop-audit` through the GitHub Release
workflow at `.github/workflows/publish.yml`.

## One-time npm setup

In npm package settings, add a **Trusted Publisher** for:

- GitHub owner/repository: `DraconDev/pi-goal-list-loop-audit`
- workflow file: `.github/workflows/publish.yml`
- environment: leave unset unless the repository deliberately protects the job
  with an npm environment

The workflow uses npm OIDC provenance. Do not add a long-lived `NPM_TOKEN` to
the repository.

## Release checklist

Accumulated changes since the last release live under an `## Unreleased`
section at the top of `CHANGELOG.md` (with the in-repo milestone labels such
as `### 0.34.51`); the release commit renames that section to the released
version. Do not invent version headers for work that was never tagged —
untagged work stays under `Unreleased` until the release commit.

```bash
npm version <major.minor.patch> --no-git-tag-version
npm run release:check
# review the diff, then commit package.json + package-lock.json + changelog
# create and push the matching tag, for example:
git tag v<major.minor.patch>
git push origin main v<major.minor.patch>
```

Create a GitHub Release from that tag. Publishing happens only after the
release is marked **published**; the workflow checks that the tag equals the
`package.json` version, runs the complete test/typecheck/package inspection,
and then runs:

```bash
npm publish --provenance --access public
```

Verify availability from a separate machine or shell:

```bash
npm view pi-goal-list-loop-audit version dist-tags.latest
npm install -g pi-goal-list-loop-audit
# or in pi:
pi install npm:pi-goal-list-loop-audit
```

After installing in pi, run `/glla version` to confirm which package version
that running extension loaded. The command also prints the `npm view` check so
a stale global/package install is easy to spot; the registry query remains the
authoritative published-version check.

`publishConfig.access=public` is necessary for the scoped/public policy, but
it does not publish anything by itself. A commit, tag, or GitHub Release alone
is not proof that npm has the package; the registry check above is the proof.
