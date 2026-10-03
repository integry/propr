# Dependency audit exception

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
