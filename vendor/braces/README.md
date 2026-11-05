# Vendored `braces` with depth guards

This directory is a locally vendored build of `braces` that remediates
[GHSA-vfj7-8cjw-p6xm](https://github.com/advisories/GHSA-vfj7-8cjw-p6xm)
(high severity, stack-exhaustion denial of service through deeply nested
brace patterns, affecting every published `braces` release `<= 3.0.3` with
no upstream fix available). It replaces the temporary audit exception
documented in `docs/dependency-audit-exceptions.md`, which expired on
2026-10-17.

## Wiring

npm installs the packed tarball `vendor/braces-3.0.4-depthguard.1.tgz`, not
this directory. The root `package.json` declares it as a direct dependency,
`"braces": "file:vendor/braces-3.0.4-depthguard.1.tgz"`, and its `overrides`
entry `"braces": "$braces"` points every transitive `braces` (micromatch,
fast-glob, chokidar, …) at that direct dependency. (A plain `file:` override
without the direct dependency is pruned silently by npm.) `package-lock.json`
pins the tarball by integrity, and the Dockerfiles `COPY vendor` so image
installs can resolve it.

This directory is the reviewable source of the tarball and must stay
byte-identical to it; `test/vendoredBraces.test.mjs` checks the source, the
tarball, the lockfile integrity and the installed package against each
other. After any change here (including this README, which is packed too),
repack it and update the lockfile integrity. npm keeps (and never
recomputes) the recorded integrity of an existing `file:` tarball entry, so
it has to be set explicitly to the repacked tarball's sha512:

```sh
npm pack ./vendor/braces --pack-destination vendor
node -e "const fs=require('fs'),c=require('crypto');const t='vendor/braces-3.0.4-depthguard.1.tgz';const l=JSON.parse(fs.readFileSync('package-lock.json'));l.packages['node_modules/braces'].integrity='sha512-'+c.createHash('sha512').update(fs.readFileSync(t)).digest('base64');fs.writeFileSync('package-lock.json',JSON.stringify(l,null,2)+'\\n')"
rm -rf node_modules/braces && npm install
```

`npm pack` is reproducible, so an unchanged directory repacks to the
committed bytes.

## Provenance

- Base: upstream [`braces@3.0.3`](https://registry.npmjs.org/braces/-/braces-3.0.3.tgz)
  (MIT, license retained in `LICENSE`).
- Patch: the guard-only nesting-depth backport published as
  [`@dieub/braces-depth-guard@3.0.3-pn.3`](https://registry.npmjs.org/@dieub/braces-depth-guard/-/braces-depth-guard-3.0.3-pn.3.tgz).
  The full tarball diff against upstream 3.0.3 was reviewed before
  vendoring: the file set is identical (no added files, no install
  scripts), and the code changes are limited to a `MAX_DEPTH` constant,
  `getMaxDepth`/`getMaxLength` option clamps in `lib/utils.js`, depth
  counters in the recursive walkers of `lib/parse.js`, `lib/compile.js`,
  `lib/expand.js` and `lib/stringify.js` that throw a controlled
  `SyntaxError`/`RangeError` past 100 levels of nesting, and a
  cycle-guarded queue-owner lookup in `lib/expand.js`.
- Only `package.json` (name/version/metadata) and this README differ from
  that reviewed patch; `index.js` and `lib/` are byte-identical to it.

## Version

The version `3.0.4-depthguard.1` is intentionally above `3.0.3` and is not
a published upstream release. Both open advisories (`GHSA-grv7-fg5c-xmjg`
`< 3.0.3`, `GHSA-vfj7-8cjw-p6xm` `<= 3.0.3`) match by version-number
comparison including prereleases, so the vendored package must sort above
`3.0.3`; a `3.0.3-*` prerelease (such as the npm alias override this
replaces) matches **both** advisories and fails GitHub dependency review.

## Maintenance

If upstream `braces` publishes a release above `3.0.3` that fixes
GHSA-vfj7-8cjw-p6xm:

1. Remove both `braces` entries from the root `package.json`: the direct
   `dependencies` entry `"braces": "file:vendor/braces-3.0.4-depthguard.1.tgz"`
   and the `overrides` entry `"braces": "$braces"` (or pin the override to
   the fixed release instead).
2. Delete this directory, the tarball and `test/vendoredBraces.test.mjs`.
3. Drop the `COPY vendor` lines from the Dockerfiles if nothing else is
   vendored.
4. Regenerate `package-lock.json` and confirm no `file:vendor/` resolution
   remains in it.
5. Re-run `npm run audit:runtime` and `npm run desktop:audit:packaging`.
