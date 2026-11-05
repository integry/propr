# E2E font fixtures

`inter-var-latin.woff2` is Inter 4.001 (`Version 4.001;git-66647c0bb`), the
variable font (`wght` 100–900) cut to the Latin unicode-range that Google
Fonts uses for propr-ui's stylesheet. It is a byte-for-byte copy of
`release-site-src/public/assets/fonts/inter-var-latin.woff2` from integry/propr-site
(commit 29ddc23d, "self-host fonts"), SHA-256
`3100e775e8616cd2611beecfa23a4263d7037586789b43f035236a2e6fbd4c62`.

Inter is Copyright 2016 The Inter Project Authors (https://github.com/rsms/inter)
and is licensed under the SIL Open Font License 1.1; the copyright notice and
license are in `OFL.txt` and in the font's own name table.

`e2e/repo-todo-rows.pw.ts` serves it in place of Google Fonts so the fallback
font and Inter phases run the same way with or without network access.
