#!/usr/bin/env bash
# Real sharp image-processing check for a built app image, shared by
# scripts/smoke-test-images.sh and scripts/smoke-test-preview-runtime-images.sh.
#
# sharp is a workspace dependency that npm may keep nested under
# packages/<name>/node_modules instead of hoisting it. Resolve it from every
# module that imports it in the shipped image — the core workspace build, the
# root build of core, and the API server — confirm it is the lockfile version,
# and run a real image operation, so a missing or unloadable nested tree fails
# here rather than at service start.
#
# Usage: smoke-check-app-sharp.sh <app-image>

set -euo pipefail

if [[ $# -ne 1 || -z "$1" ]]; then
  echo 'usage: smoke-check-app-sharp.sh <app-image>' >&2
  exit 2
fi
APP_IMAGE="$1"

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
EXPECTED_SHARP_VERSION="$(node -e '
  const lock = require(process.argv[1]).packages;
  const versions = new Set(["packages/core/node_modules/sharp", "packages/api/node_modules/sharp"]
    .map(path => lock[path]?.version || lock["node_modules/sharp"]?.version));
  if (versions.size !== 1 || versions.has(undefined)) throw new Error("package-lock.json does not pin one sharp version for core and api");
  console.log([...versions][0]);
' "$REPO_ROOT/package-lock.json")"

docker run --rm --network none --entrypoint node \
  -e "EXPECTED_SHARP_VERSION=$EXPECTED_SHARP_VERSION" \
  "$APP_IMAGE" --input-type=module -e '
  import { createRequire } from "node:module";
  import { pathToFileURL } from "node:url";
  const importers = [
    "/usr/src/app/packages/core/dist/services/attachmentService.js",
    "/usr/src/app/dist/packages/core/src/services/attachmentService.js",
    "/usr/src/app/dist/packages/api/mcp/toolsPreviews.js",
  ];
  for (const importer of importers) {
    const resolved = createRequire(importer).resolve("sharp");
    const { default: sharp } = await import(pathToFileURL(resolved).href);
    if (sharp.versions?.sharp !== process.env.EXPECTED_SHARP_VERSION) {
      throw new Error(`sharp from ${importer} is ${sharp.versions?.sharp}, expected ${process.env.EXPECTED_SHARP_VERSION}`);
    }
    if (!sharp.versions?.vips) throw new Error(`sharp from ${importer} did not load libvips`);
    const png = await sharp({ create: { width: 4, height: 3, channels: 3, background: "#336699" } }).png().toBuffer();
    const { data, info } = await sharp(png).resize(2, 2).raw().toBuffer({ resolveWithObject: true });
    if (info.width !== 2 || info.height !== 2 || data[0] !== 0x33 || data[2] !== 0x99) {
      throw new Error(`sharp from ${importer} produced an unexpected image`);
    }
    console.log(`${importer} -> ${resolved} (sharp ${sharp.versions.sharp}, vips ${sharp.versions.vips}, ${process.platform}/${process.arch})`);
  }
'
echo "✓ $APP_IMAGE resolves and runs sharp from the core and API workspaces"
