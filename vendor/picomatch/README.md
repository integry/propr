# Vendored `picomatch` 4.0.7 with a repeated-extglob guard

This directory is a locally vendored build of `picomatch` 4.0.7, the version
that `vite`, `vitest`, `tinyglobby`, `fdir` and other `picomatch@^4`
consumers load, with a guard against
[GHSA-fc5q-39xc-vjpf](https://github.com/advisories/GHSA-fc5q-39xc-vjpf).
`vendor/picomatch-v2` is the same guard on the 2.x line.

## Wiring

npm installs the packed tarball `vendor/picomatch-4.0.8-extglobguard.1.tgz`, not
this directory. The root `package.json` declares it as a direct dependency,
`"picomatch": "file:vendor/picomatch-4.0.8-extglobguard.1.tgz"`, and its
`overrides` entry `"picomatch": "$picomatch"` points every transitive
`picomatch` at it (npm 10.9 silently prunes a top-level `file:` override with no
matching direct dependency, hence the `$picomatch` form). The three 2.x
consumers, `anymatch`, `micromatch` and `readdirp`, are the exception: their
scoped overrides install `vendor/picomatch-v2` instead (see its README for how
npm treats those nested entries). `package-lock.json` pins the tarball by
integrity, and the Dockerfiles `COPY vendor` so image installs can resolve it.

This directory is the reviewable source of the tarball and must stay
byte-identical to it; `test/vendoredPicomatch.test.mjs` checks the source, the
tarball, the lockfile integrity and the installed packages against each other.
After any change here (including this README, which is packed too), repack it
and update the lockfile integrity. npm keeps (and never recomputes) the
recorded integrity of an existing `file:` tarball entry, so set it explicitly on
every lockfile entry that resolves to the tarball:

```sh
npm pack ./vendor/picomatch --pack-destination vendor
node -e "const fs=require('fs'),c=require('crypto');const t='vendor/picomatch-4.0.8-extglobguard.1.tgz';const l=JSON.parse(fs.readFileSync('package-lock.json'));const i='sha512-'+c.createHash('sha512').update(fs.readFileSync(t)).digest('base64');for(const e of Object.values(l.packages))if(e.resolved==='file:'+t)e.integrity=i;fs.writeFileSync('package-lock.json',JSON.stringify(l,null,2)+'\\n')"
npm install
```

`npm pack` is reproducible, so an unchanged directory repacks to the committed
bytes.

## Provenance

- Base: upstream [`picomatch@4.0.7`](https://registry.npmjs.org/picomatch/-/picomatch-4.0.7.tgz)
  (MIT, license retained in `LICENSE`). `index.js`, `posix.js` and `lib/` other
  than `lib/parse.js` are byte-identical to it, and its `lib/` matches the
  upstream `4.0.7` git tag.
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

The only code change is in `lib/parse.js`:

- a new helper, `hasUnboundedWildcard(branch)`, true when a branch holds a
  bare `*` wildcard or `+` quantifier (one not opening a nested `*(...)` or
  `+(...)` extglob), at any group depth, outside escapes, quotes and bracket
  expressions;
- one check at the end of `analyzeRepeatedExtglob`, for every branch count:
  `if (branches.some(hasUnboundedWildcard)) return { risky: true };`.

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

## Version

`4.0.8-extglobguard.1` is intentionally above `4.0.7` and is not a published
upstream release. npm audit and GitHub dependency review match the advisory
range `<= 4.0.7` including prereleases, so the vendored package must sort above
`4.0.7`.

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
