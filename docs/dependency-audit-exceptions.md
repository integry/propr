# Dependency audit exception

**minimatch GHSA-g3hv-75wg-m249, remediated 2026-10-31 without an exception.**
This moderate-severity globparts amplification advisory was published on
2026-10-30. It affects all `minimatch < 11.0.1`, has no 10.x or 3.x backport,
and made `npm run audit:runtime` fail. Repomix 1.18.x still declares
`minimatch ^10.2.6` (`npm audit` suggests "downgrading" to repomix 0.2.4, which
is wrong). Scoped `package.json` overrides now resolve the affected paths to
patched versions:

- `repomix` → `minimatch` 11.0.3, the only runtime minimatch.
- `@electron/asar@4` → `minimatch` 11.0.3 and `glob` 14.0.3 (glob 14 requires
  minimatch 11 and also fixes GHSA-3g3m-2fjr-6pw4, `glob >=9 <=14.0.1`). This is
  the asar that `@electron/packager` uses to build `app.asar` and match the
  `unpack` glob.

Both packages only use the `minimatch`, `Minimatch` and `braceExpand` exports,
which minimatch 11 keeps. Repomix packing (include and ignore patterns,
ignore-control files, nested paths, dotfiles) and asar `unpack` produce the same
file sets as with minimatch 10. `test/minimatchAdvisory.test.mjs` guards the
lockfile and this matching behaviour. Remove the overrides once Repomix and
`@electron/asar` declare minimatch 11 themselves.

The audits stay fail-closed, and the wrapper's thresholds are unchanged. The
following dev-only paths still use vulnerable minimatch. The runtime audit omits
them and they are below the packaging audit's `high` threshold:
`eslint`/`@eslint/*` and `glob@7` (3.1.5);
`@electron/asar@3` in `electron-installer-common`, which the deb/rpm makers use
only to read `package.json` from a built `app.asar` (3.1.5); and `nodemon` and
`@typescript-eslint/typescript-estree` (10.2.6). None of these takes
repository-controlled patterns at runtime. They should move to minimatch 11 when
their upstreams do.

## braces GHSA-vfj7-8cjw-p6xm

**Remediated 2026-10-17.** The `braces` dependency is now resolved to the
reviewed, vendored depth-guard build in `vendor/braces` (see
`vendor/braces/README.md` for provenance), so GHSA-vfj7-8cjw-p6xm no longer
appears in the audits and this expired exception no longer applies to
anything. The description below is kept for the audit wrapper's history.

The runtime and desktop packaging audits temporarily accept only
[GHSA-vfj7-8cjw-p6xm](https://github.com/advisories/GHSA-vfj7-8cjw-p6xm),
the high-severity stack-exhaustion denial of service in `braces <=3.0.3`.
The exception expires **2026-10-17 at 00:00 UTC**. It also stops applying if npm
reports a fix for the `braces` entry or changes the advisory's range or severity.

As of 2026-10-03, npm reports no patched release. Existing runtime dependencies
include `chokidar` and `fast-glob`, as well as
`repomix → globby → fast-glob → micromatch → braces`. Six affected packages in
the audit are consequences of this one advisory. The dependency versions are
unchanged by this exception.

This is a temporary acceptance of availability risk to unblock CI, **not a
security fix or a claim that the vulnerable code is unreachable**. Context
generation passes include paths and repository ignore patterns to Repomix;
repository-controlled input must not be assumed safe. Deeply nested brace
patterns can exhaust the call stack. No runtime mitigation is added here.

The audit wrapper checks exact advisory identity rather than ignoring package
names. A dependent package is excepted only if every cause traces exclusively
to this advisory. Other findings retain the existing thresholds (low for runtime,
high for desktop packaging); malformed reports, registry failures and unknown
dependency chains cannot pass as exceptions. Every use prints the advisory,
affected packages, expiry and outstanding risk in CI.

Before expiry, the maintainers must remove the vulnerable dependency paths or
adopt a reviewed upstream fix and regenerate the lockfile. Re-run both
`npm run audit:runtime` and `npm run desktop:audit:packaging`, remove this
exception when no longer needed, and verify context generation and file
watching if their dependencies change. Do not automatically extend the deadline.
