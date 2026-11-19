# Vendored `picomatch` 4.0.7 with a repeated-extglob guard

This directory is a locally vendored build of `picomatch` 4.0.7, the version
that `vite`, `vitest`, `tinyglobby`, `fdir` and other `picomatch@^4`
consumers load, with a guard against
[GHSA-fc5q-39xc-vjpf](https://github.com/advisories/GHSA-fc5q-39xc-vjpf).
`vendor/picomatch-v2` is the same guard on the 2.x line.

## Wiring

npm installs the packed tarball `vendor/picomatch-4.0.8-extglobguard.3.tgz`, not
this directory. The root `package.json` declares it as a direct dependency,
`"picomatch": "file:vendor/picomatch-4.0.8-extglobguard.3.tgz"`, and its
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
node -e "const fs=require('fs'),c=require('crypto');const t='vendor/picomatch-4.0.8-extglobguard.3.tgz';const l=JSON.parse(fs.readFileSync('package-lock.json'));const i='sha512-'+c.createHash('sha512').update(fs.readFileSync(t)).digest('base64');for(const e of Object.values(l.packages))if(e.resolved==='file:'+t)e.integrity=i;fs.writeFileSync('package-lock.json',JSON.stringify(l,null,2)+'\\n')"
npm install
```

`npm pack` is reproducible, so an unchanged directory repacks to the committed
bytes.

## Provenance

- Base: upstream [`picomatch@4.0.7`](https://registry.npmjs.org/picomatch/-/picomatch-4.0.7.tgz)
  (MIT, license retained in `LICENSE`). `index.js`, `posix.js` and `lib/` other
  than `lib/parse.js` and `lib/utils.js` are byte-identical to it, and the rest
  of its `lib/` matches the upstream `4.0.7` git tag.
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

The code changes for the advisory are all in `lib/parse.js`. The first guards
repeated extglobs:

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

### Repeated groups (`extglobguard.3`)

A plain group, an `@(...)` group, a `!(...)` negation or a comma brace followed
by `+` compiles to a regex group under a `+` quantifier, which the extglob
guard above never sees: `(*a)+` → `([^/]*?a)+`, `(*)+x` → `([^/]*?)+x`,
`{*a,}+` → `([^/]*?a|)+`, `!(a)+` → `(?:(?!(?:a))[^/]*?)+`. On unpatched
builds, matching the 27-character `aaaaaaaaaaaaaaaaaaaaaaaaaab` took 3.4 s
against `(*a)+` and 20 s against `(*)+x`, and `(a+|b)+` took 13 s on 29
characters. The second change in `lib/parse.js` gives these groups the
extglob guard's treatment:

- `(` records where its group starts (including an `@` prefix), and the
  closing `)` of a plain group, a `!(...)` and a comma brace carries that
  record;
- when the `+` handler would emit a regex quantifier right after such a close,
  `repeatGroupLiterally` asks `isRiskyRepeatedGroup` whether the body can
  match the same text in more than one way, and if so rewrites the group and
  its `+` into one literal text token, the same way `extglobClose` rewrites a
  risky extglob.

A body is risky when its tokens hold a live `*`/`**` wildcard, a regex `+`
quantifier or an unliteralized `*(...)`, `+(...)`, `?(...)` or `!(...)`; when
it holds an alternation (`|` or a brace comma) below its top level; or when its
top-level branches are not all plain literals that concatenate in only one way
(checked with the Sardinas–Patterson test, after lower-casing for `nocase`), so
`(a|aa)+`, `(a|a)+`, `(ab|a|ba)+` and `(a|)+` are risky while `(js|ts)+` and
`{a,b}+` are not. A `!(...)` followed by `+` is always risky, because the
negation's output ends in a star. Nested forms such as `((*)+)+` literalize the
inner group first and then repeat a fixed literal. Fixed-length bodies (`(a)+`,
`(abc)+`, `([0-9])+`, `(a?)+`) and everything not followed by `+`, including
`(*)*x`, compile as before. `maxExtglobRecursion: false` turns this check off
together with the extglob guard. Every probe above runs in under 1 ms on a
5,000-character subject.

### Behaviour change and residual risk

Running upstream's own mocha suite (from the git tag of the same version) against the
patched `lib/` passes every test except nine assertions that pin the vulnerable
shape itself: `isMatch('abc', '+(*)c')` (twice), `isMatch('ax', '*(a*|b)')`,
`isMatch('my/folder (Work, Accts)', '*/*(W*, *)*')` and, since the
repeated-group check, `isMatch('ab', '(a+|b)+')` and `isMatch('abab', '(a+|b)+')`
(five assertions across the bash, minimatch and extglobs specs). Those
patterns now match only their literal text. No glob in this repository uses a
repeated extglob or a repeated group.

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

`4.0.8-extglobguard.3` is intentionally above `4.0.7` and is not a published
upstream release. npm audit and GitHub dependency review match the advisory
range `<= 4.0.7` including prereleases, so the vendored package must sort above
`4.0.7`.

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
