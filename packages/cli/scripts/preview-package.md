# Internal Hosted Fleet CLI preparation

This is a **manual, prepare-only** path. The root operator selects the candidate
source and accepts it for live testing separately. Public site, checkout,
stable releases, npm tags, Docker publication and fleet deployment remain held.
No new credentials or publication gate are introduced.

## Reviewed inputs and trust

Use a clean checkout containing this preparation helper at the exact full
lowercase 40-character source commit in
`integry/propr`, already reachable from a freshly fetched, operator-reviewed
`origin/main` revision. The origin URL must be the canonical HTTPS or SSH GitHub
URL. Record that main revision explicitly as `TRUSTED_MAIN`; the helper checks
it against `refs/remotes/origin/main`, checks ancestry and exact HEAD, validates
repository/agent Dockerfile metadata, and rejects tracked or untracked changes.
A local ref is not independent proof of upstream trust: the operator must obtain
this checkout/ref from the canonical repository through their trusted checkout
process. Keep input JSON and output logs outside the source tree (or in ignored
`dist-publish/`). Do not edit source package versions or installed package files.

Obtain the three reviewed references from the separately authorized existing
**Preview Runtime Images** publication gate. Validation-only prepare runs do not
produce usable registry inputs. If any input is unavailable, stop and leave
publication authorization to that gate. Neither this command nor its smoke
publishes images or falls back to stable app/UI/agent images.

Write a JSON input file with exactly this schema, substituting real values:

```json
{
  "schemaVersion": 1,
  "repository": "integry/propr",
  "sourceRevision": "<full-lowercase-source-SHA>",
  "images": {
    "app": "propr/app:<full-lowercase-source-SHA>@sha256:<64-lowercase-hex>",
    "ui": "propr/ui:<full-lowercase-source-SHA>@sha256:<64-lowercase-hex>",
    "agent": "propr/agent:<full-lowercase-source-SHA>@sha256:<64-lowercase-hex>"
  }
}
```

All three references are required. Arbitrary registries, image repositories,
mutable beta/latest tags, missing digests and mixed source revisions are rejected.
Preparation re-inspects the **digest-pinned** references, not the mutable tags.
The shared preview verifier checks each runnable platform's config for the exact
source/repository OCI labels. App and UI must both support exactly linux/amd64
and linux/arm64; the unified managed-agent bundle must support only linux/amd64
and carry the existing bundled CLI version labels. The fleet target is therefore
**linux/amd64**. A valid source tag alone is never accepted as evidence.

## Prepare and test

Use Linux amd64, Node 22, npm, Git, and the same `regctl` version/tool installation
used by the existing Preview Runtime Images workflow. Registry reads must work
without adding broad source-build credentials. Install the pinned workspace
build dependencies from the lockfile with lifecycle scripts disabled:

```sh
npm ci --ignore-scripts --no-audit --no-fund
node packages/cli/scripts/build-publish.mjs \
  --preview-input "$PREVIEW_INPUT_FILE" \
  --trusted-main "$TRUSTED_MAIN"
```

The command accepts no publication flag in preview mode. The shared packaging
path also preserves nested vendored modules, runtime JSON assets, and their
public dependencies so both stable and preview tarballs install independently. It verifies inputs
before building, uses the established standalone CLI vendoring path, changes
only generated package version/manifest artifacts, packs with scripts disabled,
and installs the tarball into a temporary clean npm prefix. The smoke checks
`propr --version`, `propr --help`, private workspace dependency/import removal,
and exact bundled runtime selection through the installed orchestrator's default
manifest lookup. No Docker daemon, provider secret, service startup, or live
acceptance is needed. Installation downloads public npm dependencies.

Successful outputs are under `dist-publish/preview/<expected-cli-version>/`:

- `propr-cli-<expected-cli-version>.tgz`: standalone installable artifact.
- `manifest.json`: byte-identical copy of the bundled launcher manifest.
- `provenance.json`: source SHA, trusted main SHA, version, verified image
  references/platforms, tarball/manifest SHA-256, lockfile hash, Node/npm versions,
  and install/runtime smoke results.
- `SHA256SUMS`: tarball, manifest and provenance hashes.

Failed preparation does not expose a completed output directory. Existing
completed output directories are not overwritten. Preserve them as immutable
records. The version is `<base>-preview.<full-source-SHA>.<full-runtime-binding-hash>`;
identical inputs give the same version and changing any runtime digest changes
it. These hashes are integrity evidence, not signatures or an independent supply
chain attestation. Package builds use the repository lockfile; downstream npm
installation still resolves the public dependency ranges inherited from stable
packaging. This path does not promise byte-for-byte reproducibility across
Node/npm toolchains or frozen downstream dependency resolution.

For automated validation in a future prepare-only CI job, use the same command
from a manual dispatch on `integry/propr` main, with full-history source checkout,
no persisted checkout credentials, `contents: read`, and no release/npm/Docker
secrets. The helper requires `GITHUB_SHA` to equal the explicit trusted main SHA
and `GITHUB_REF=refs/heads/main` for GitHub Actions. Upload the completed directory
as a run-specific artifact, not a release or npm package. No new CI workflow is
added here; the supported entry point is the manual command above.

Tests use synthetic registry fixtures without live provider secrets:

```sh
node --test test/previewCliPackage.test.mjs test/previewRuntimeImages.test.mjs test/previewAgentImage.test.mjs
PROPR_CLI_PACKAGE_SMOKE=1 node --test test/previewCliPackage.test.mjs
```

## Fleet handoff and separate work

Give the fleet operator the immutable run-specific artifact URL (with retention
information) or local tarball, its SHA-256 through a trusted handoff channel,
`sourceRevision`, **exact expected CLI version**, manifest and provenance.
After downloading/copying the bundle, check `sha256sum --check SHA256SUMS` and
compare the tarball hash to that trusted expected value before installing.

A later **propr-fleet** change must explicitly accept these inputs, verify the
checksum/source/version and bundled app/UI/agent references, then install the
exact tarball and verify the installed version. The current stable numeric
version installer is not changed here. Do not use npm/latest, suppress its checks,
or patch installed internals to force acceptance. The clean-prefix command used
for smoke verification is also available for a downloaded artifact:

```sh
node packages/cli/scripts/smoke-preview-package.mjs "$TARBALL" "$MANIFEST"
```

Docs images are outside the verified preview scope and are omitted; keep docs
disabled for this fleet validation. Redis/cloudflared keep the established
third-party pins and are not represented as source-built artifacts. Separate
work includes fleet installer support, any docs preview support, artifact
hosting/retention or signing requirements, runtime image publication if needed,
and operator-owned live Hosted Fleet acceptance. Preparing this CLI does not
establish that a particular hosted-bootstrap candidate has passed live testing.
