# Vendored `picomatch` 2.3.2 with a repeated-extglob guard

This directory is a locally vendored build of `picomatch` 2.3.2, the 2.x API
that `micromatch@4` (used by `fast-glob`, and so by `@propr/core` and
`repomix → globby`), `anymatch@3` and `readdirp@3` (both used by `chokidar@3`
in `@propr/api`) declare as `picomatch@^2`, with the same guard against
[GHSA-fc5q-39xc-vjpf](https://github.com/advisories/GHSA-fc5q-39xc-vjpf) as
`vendor/picomatch`. The 2.x line is kept rather than moving these consumers to
the 4.x code because 3.0/4.0 changed Windows-path detection, `scan()` part
splitting and globstar handling that `micromatch` and `fast-glob` rely on.

## Wiring

npm installs the packed tarball `vendor/picomatch-4.0.8-v2.3.2-extglobguard.2.tgz`
as the nested `node_modules/<consumer>/node_modules/picomatch` of `anymatch`,
`micromatch` and `readdirp`, through scoped `overrides` in the root
`package.json`, each
`{ "picomatch": "file:vendor/picomatch-4.0.8-v2.3.2-extglobguard.2.tgz" }`. The
package inside the tarball is still named `picomatch`, so `require('picomatch')`
from those consumers loads it. `package-lock.json` pins all three nested
entries by integrity, and the Dockerfiles `COPY vendor` so image installs can
resolve it.

npm 10 and 11 keep these nested lockfile entries on `npm install`,
`npm install --package-lock-only` and `npm ci`. But when an entry is missing
from the lockfile, npm deduplicates it onto the root `picomatch` (the 4.x
build, which is then reported `invalid` by `npm ls`), and a scoped `$ref`
override to a second root dependency behaves the same. If that happens,
restore the three entries by hand, copying the shape of the committed ones
(`version`, `resolved: "file:vendor/…"`, `integrity`, `license`, `engines`),
and confirm with `npm ls picomatch --all`.

This directory is the reviewable source of the tarball and must stay
byte-identical to it; `test/vendoredPicomatch.test.mjs` checks the source, the
tarball, the lockfile integrity and the installed packages against each other.
After any change here (including this README, which is packed too), repack it
and update the lockfile integrity. npm keeps (and never recomputes) the
recorded integrity of an existing `file:` tarball entry, so set it explicitly on
every lockfile entry that resolves to the tarball:

```sh
npm pack ./vendor/picomatch-v2 --pack-destination vendor
node -e "const fs=require('fs'),c=require('crypto');const t='vendor/picomatch-4.0.8-v2.3.2-extglobguard.2.tgz';const l=JSON.parse(fs.readFileSync('package-lock.json'));const i='sha512-'+c.createHash('sha512').update(fs.readFileSync(t)).digest('base64');for(const e of Object.values(l.packages))if(e.resolved==='file:'+t)e.integrity=i;fs.writeFileSync('package-lock.json',JSON.stringify(l,null,2)+'\\n')"
npm install
```

`npm pack` is reproducible, so an unchanged directory repacks to the committed
bytes.

## Provenance

- Base: upstream [`picomatch@2.3.2`](https://registry.npmjs.org/picomatch/-/picomatch-2.3.2.tgz)
  (MIT, license retained in `LICENSE`). `index.js` and `lib/` other than
  `lib/parse.js` and `lib/utils.js` are byte-identical to it, and the rest of
  its `lib/` matches the upstream `2.3.2` git tag.
- `package.json` (version, description, dropped scripts and dev metadata) and
  this README (replacing upstream's) are the only other differences.

## The guard

[GHSA-fc5q-39xc-vjpf](https://github.com/advisories/GHSA-fc5q-39xc-vjpf)
(high severity, CWE-1333) is a regular-expression denial of service in every
published `picomatch` release `<= 4.0.7`, with no patched release (the
advisory lists no fixed version, and 4.0.7 is the latest on npm). Upstream
already literalizes some risky repeated extglobs in `analyzeRepeatedExtglob`
(`lib/parse.js`), but it skips single-branch bodies, so `+(*)`, `+(*a)` or
`*(*.js)` compile to `(?:[^/]*?a)+`-style regexes that nest an unbounded
quantifier inside another. A 29-character subject takes about 35 s against
`+(*)` and 11 s against `+(*a)` on unpatched 2.3.2 and 4.0.7.

The only code change for the advisory is in `lib/parse.js`:

- a new helper, `hasUnboundedWildcard(branch)`, true when a branch holds a
  bare `*` wildcard or `+` quantifier (one not opening a nested `*(...)` or
  `+(...)` extglob), at any group depth, outside escapes, quotes and bracket
  expressions;
- a second helper, `hasUnboundedToken(tokens)`, true when the tokens `parse()`
  emitted for the extglob's body hold a live `*` wildcard or regex `+`
  quantifier. It reads the parser's own result, so its bracket and quote rules
  are the parser's: `hasUnboundedWildcard` alone misses the `*` after an
  unclosed `[` (`+([*)`), after a `[` inside a class (`+([[]*)`) and after a
  `"` that a run of plain text swallows (`+(a"*)`), which compile to
  `(?:\[[^/]*?)+`-style regexes;
- one check at the end of `analyzeRepeatedExtglob`, for every branch count:
  `if (branches.some(hasUnboundedWildcard) || hasUnboundedToken(tokens)) return { risky: true };`,
  with `extglobClose` passing the body's tokens.

A risky `+(...)`/`*(...)` extglob is matched as literal text by the existing
upstream code path, the same treatment upstream already gives `+(*|?)` or
`+(a|aa)`. With the patch, every probe above compiles to a literal and runs in
under 2 ms. `@(...)`, `?(...)`, `!(...)`, repeats of fixed-length bodies such
as `+([0-9])` or `+(abc|def)`, nested repeats such as `*(f*(o))` and
upstream's existing safe rewrites (`+(*(a)|*(b))` → `[ab]*`) are unchanged.

### Behaviour change and residual risk

Running upstream's own mocha suite (from the git tag of the same version) against the
patched `lib/` passes every test except four assertions that pin the vulnerable
shape itself: `isMatch('abc', '+(*)c')` (twice), `isMatch('ax', '*(a*|b)')` and
`isMatch('my/folder (Work, Accts)', '*/*(W*, *)*')`. Those patterns now match
only their literal text. No glob in this repository uses a repeated extglob.

Nested repeats such as `+(a*(a))`, where the inner repeat can match the same
character that starts the outer iteration, are still exponential. Upstream
leaves that class to its `maxExtglobRecursion` check, and its bash-compatibility
tests pin `*(f*(o))`, which has the same shape but is unambiguous. This vendored
build does not change that; it remains an upstream issue
([micromatch/picomatch#175](https://github.com/micromatch/picomatch/issues/175)).

## Linear-time `removeBackslashes`

`lib/utils.js` also differs from upstream, in `removeBackslashes` (and its
now-unused `REGEX_REMOVE_BACKSLASH` import) only. Upstream
runs `REGEX_REMOVE_BACKSLASH` (`/(?:\[.*?[^\\]\]|\\(?=.))/g`), which rescans to
the end of the line from every `[` that has no closing `]`: 65,000 `[`
characters took about 1.6 s (CodeQL "polynomial regular expression used on
uncontrolled data"). The replacement walks the string once with precomputed
"next unescaped `]`" and "next line terminator" tables and returns exactly what
the regex replacement returned (checked against it exhaustively for every
string up to six characters over `[`, `]`, `\`, `a`, `*` and the four line
terminators, plus random longer strings); the same input now takes about 1 ms.
`REGEX_REMOVE_BACKSLASH` stays in `lib/constants.js`, which is unchanged, as
part of the exported `constants`.

## Version

`4.0.8-v2.3.2-extglobguard.2` contains the 2.3.2 code but must still sort above
`4.0.7`: npm audit and GitHub dependency review compare the installed
`picomatch` version against the advisory range `<= 4.0.7` (including
prereleases) regardless of the major line. The `v2.3.2` prerelease identifier
records the actual base. The consumers' `^2` ranges are satisfied through the
overrides, not by the version number.

The `-extglobguard.N` suffix must change whenever the tarball's content changes
(any edit to this directory, README included). npm only reinstalls a `file:`
tarball dependency when its version differs from the one already in
`node_modules`, so a repacked tarball under an unchanged version leaves existing
checkouts on the old build. Bump `N` in `package.json`, rename the tarball to
match, and update every reference to the old name (root `package.json`,
`package-lock.json`, `THIRD_PARTY_LICENSES.md`,
`test/vendoredPicomatch.test.mjs`, the signed-RPM acceptance files under
`apps/desktop/scripts/` and `docs/dependency-audit-exceptions.md`).

## Maintenance

When upstream `picomatch` publishes releases that fix GHSA-fc5q-39xc-vjpf
(above `4.0.7`, plus a 2.x backport or new majors of the 2.x consumers):

1. Remove the root `package.json` entries: the direct `dependencies`
   `"picomatch"`, the `overrides` entry
   `"picomatch": "$picomatch"` and the scoped `anymatch`, `micromatch` and
   `readdirp` `picomatch` overrides (or pin them to the fixed releases).
2. Delete `vendor/picomatch`, `vendor/picomatch-v2`, both tarballs and
   `test/vendoredPicomatch.test.mjs`.
3. Regenerate `package-lock.json` and confirm no `file:vendor/picomatch`
   resolution remains in it.
4. Re-run `npm run audit:runtime` and `npm run desktop:audit:packaging`.
