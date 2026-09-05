# Releasing

`.github/workflows/publish.yml` is the source of truth. This page explains what it does and
why; when the two disagree, the workflow is right and this page is the bug.

## The flow

A pushed `vX.Y.Z` tag publishes `chronicle-cli` to npm. Nothing else does.

1. Bump `package.json` version and add the CHANGELOG entry on a branch. Open a PR, get CI
   green, merge to `main`.
2. Tag the merge commit and push the tag:

   ```bash
   git checkout main && git pull
   git tag v1.4.0 <merge-commit>
   git push origin v1.4.0
   ```

3. The workflow runs the gates, verifies the tag matches `package.json`, and publishes.

There is no manual step in between, and no passkey ceremony.

## What the workflow enforces

**The tag must match `package.json`.** A tag of `v1.4.0` against a `package.json` saying
`1.3.0` fails the job before anything is published. This is the guard against tagging the wrong
commit.

**The gates run as npm lifecycle scripts**, not as separate workflow steps:

- `prepublishOnly` runs `npm run typecheck` and `npm test`.
- `prepack` runs the Vite build and the publish compile (`tsc -p tsconfig.publish.json`),
  producing `dist/` and `dist-server/`.

`npm publish` triggers both, so a type error or a failing test stops the publish.

**Publishing is OIDC trusted publishing.** GitHub mints a short-lived token for the run and npm
exchanges it. There is no stored `NPM_TOKEN`, and provenance attestation is emitted
automatically.

**Two runs never race.** A concurrency group keyed on the tag ref, with
`cancel-in-progress: false`, so a force-repushed tag queues behind the first run rather than
racing it.

## Why the workflow looks the way it does

**`registry-url` is deliberately absent** from the `setup-node` step. Setting it scaffolds an
`.npmrc` with an empty `NODE_AUTH_TOKEN` line, which can make npm attempt token auth before the
OIDC exchange. The default registry is already `registry.npmjs.org`.

**npm is upgraded to an exact pinned version.** Trusted publishing needs npm 11.5.1 or newer,
and Node 24.0 ships 11.3.0, so the upgrade is load-bearing rather than tidiness. It is pinned
to an exact version rather than `@latest` because this job holds `id-token: write` and publish
rights: pulling whatever npm is current at release time would be a non-reproducible
supply-chain surface. Bump it deliberately, after validating the newer npm.

## What ships

`package.json`'s `files` field decides. The published tarball carries `bin/`, `dist/`,
`dist-server/`, `data/`, `scripts/`, the licence and the notice. The `.ts` sources are not
published, because `bin/chronicle.mjs` imports the compiled `dist-server/server/standalone.js`:
Node's type-stripping loader does not apply the same way to a dependency's source under
`node_modules`.

## One-time setup

Done once by the package owner, on npmjs.com: `chronicle-cli` → Settings → Trusted Publisher →
GitHub Actions, with organization `chizhangucb`, repository `chronicle`, workflow filename
`publish.yml`, environment blank.

## The CI gate

`.github/workflows/ci.yml` runs on every push to `main` and every PR targeting it:

- **`gitleaks`** scans full history on a push and the PR's own commits on a pull request.
  The job id is required by branch protection **by name**, so keep it stable. The binary is
  pinned by version and by SHA-256, so a retagged release cannot change what runs; bump both
  values together.
- **`check`** runs typecheck, the test suite, and the client build on Node 24, with Python 3.12
  pinned for the guards that shell out to it. `CHRONICLE_REQUIRE_PYTHON=1` turns a
  "no python3" skip into a failure, so a silently skipped guard cannot pass CI.
- **`e2e`** runs the Playwright smoke suite against a seeded large fixture in real Chromium.

Branches-up-to-date is enforced natively by branch protection's
`required_status_checks.strict`, not by a workflow job.

Lint is a later phase. Do not add eslint or prettier to this workflow.
