#!/usr/bin/env bash
# Official plugin registry check for a built app image, shared by
# scripts/smoke-test-images.sh and scripts/smoke-test-preview-runtime-images.sh.
#
# Core imports the registry package (@propr/plugins) by name at run time and,
# when it cannot, offers an empty Plugins catalog with one warning. Load the
# catalog through Core's own loader from both shipped builds of Core, compare
# it with the image's registry.json, and check every plugin's files (icon,
# skill folders, automation templates, compiled handlers), so an image without
# the registry fails here rather than silently showing no plugins.
#
# Usage: smoke-check-app-plugins.sh <app-image>

set -euo pipefail

if [[ $# -ne 1 || -z "$1" ]]; then
  echo 'usage: smoke-check-app-plugins.sh <app-image>' >&2
  exit 2
fi
APP_IMAGE="$1"

docker run --rm --network none --entrypoint node "$APP_IMAGE" --input-type=module -e '
  import fs from "node:fs";
  import path from "node:path";
  import { createRequire } from "node:module";
  import { pathToFileURL } from "node:url";
  const loaders = [
    "/usr/src/app/packages/core/dist/plugins/pluginCatalog.js",
    "/usr/src/app/dist/packages/core/src/plugins/pluginCatalog.js",
  ];
  const registryFile = createRequire(loaders[0]).resolve("@propr/plugins");
  const registry = await import(pathToFileURL(registryFile).href);
  const index = JSON.parse(fs.readFileSync(path.join(registry.PLUGINS_ROOT, "registry.json"), "utf8"));
  const expected = index.plugins.filter(entry => entry.development !== true).map(entry => entry.id);
  if (!expected.length) throw new Error("registry.json lists no official plugins");
  for (const loader of loaders) {
    const { officialPluginCatalog } = await import(pathToFileURL(loader).href);
    const ids = (await officialPluginCatalog()).map(manifest => manifest.id);
    if (JSON.stringify(ids) !== JSON.stringify(expected)) throw new Error(`${loader} offers [${ids}], expected [${expected}]`);
  }
  const file = (target, what) => { if (!fs.statSync(target, { throwIfNoEntry: false })?.isFile()) throw new Error(`${what} missing: ${target}`); };
  for (const plugin of registry.officialPlugins({ includeDevelopment: false })) {
    const { id } = plugin.manifest;
    file(plugin.assets.icon, `${id} icon`);
    for (const skill of plugin.assets.skills) file(path.join(skill.path, "SKILL.md"), `${id} skill ${skill.name}`);
    for (const template of plugin.assets.automationTemplates) {
      file(path.join(template.path, "template.json"), `${id} template ${template.id}`);
      file(path.join(template.path, "prompt.md"), `${id} template ${template.id}`);
    }
    if (plugin.assets.handlers) {
      if (!plugin.assets.handlers.endsWith(".js")) throw new Error(`${id} handlers are not compiled: ${plugin.assets.handlers}`);
      const handlers = await registry.loadPluginHandlers(id, { includeDevelopment: false });
      if (!handlers || !Object.values(handlers).some(value => typeof value === "function")) throw new Error(`${id} handlers did not load`);
    }
  }
  console.log(`${registryFile}: ${expected.length} official plugins (${expected.join(", ")})`);
'
echo "✓ $APP_IMAGE offers every official plugin from the registry package"
