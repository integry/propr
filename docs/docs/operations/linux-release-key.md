# Linux desktop release key

The current owner-provisioned Linux desktop release identity, effective for new
Linux previews signed on or after **2026-10-19**, is:

**80FE0A7667A92A0AD3CEAE6D4C2FF8C3CC4E1599**

[Download the ASCII-armored public key](/keys/propr-desktop-release.asc).
This is public information; the export contains no private key material.

The RSA4096 primary signing key has user ID `ProPR Desktop Release Signing`. It was
issued on **2026-10-19** and expires on **2028-10-18**. It has no subkeys; the
primary key itself signs. For new previews it signs native RPM headers and
payloads, the release `SHA256SUMS` (as `SHA256SUMS.asc`), and the APT repository
metadata (`APT-InRelease` and `APT-Release.gpg`). DEB payloads are unchanged and
carry no embedded signature; APT authenticates them through the signed metadata
and package hashes. This key does not authenticate older releases retroactively.

Inspect the downloaded export with GnuPG without installing host trust:

```sh
gpg --show-keys --with-colons --with-fingerprint propr-desktop-release.asc
```

Require exactly one `pub` record, RSA4096, no `sub` records, and the full
fingerprint above in its following `fpr` record. Compare this notice through
independently reviewed project documentation, not only a key delivered alongside
an installer. Reject expired, revoked, or different keys. See
[Linux package authentication](linux-rpm-signing.md) for checksum verification and
scoped APT trust. APT verifies repository metadata and hashes, not an embedded
signature inside each DEB.

## 2026-10-19 rotation from the previous identity

The previous identity was:

- Fingerprint **DD4E7F65CE2345A1F4597D643CF856B53093D3A3**
- User ID `ProPR Desktop RPM Signing`, RSA4096 primary signing key
- Issued **2026-10-12**, expires **2028-10-11**
- [Historical public export](/keys/propr-desktop-release-historical-DD4E7F65CE2345A1F4597D643CF856B53093D3A3.asc)
  (byte-for-byte the export previously published as `propr-desktop-release.asc`)

The owner no longer has the passphrase for the previous private key and generated
a replacement key locally. **No compromise has been reported**, and the previous
key has **not** been revoked. Because the old key cannot sign, the replacement is **not
cross-signed** by it. The transition is instead authenticated only by this
reviewed project documentation and the code pin in the authenticated
`integry/propr` repository: compare the new fingerprint here with the pin in
`apps/desktop/scripts/rpm-signing.mjs` on the reviewed main branch. Do not expect
or accept a "transition statement" signed by the old key.

The previous key signs nothing new after this rotation. Releases that were
signed with it keep their original signatures, assets and trust classification
unchanged; verify them only with the historical export and its own fingerprint.
Verification against the new code pin says nothing about those older releases,
and nothing here re-labels or re-signs them.

### Consumer trust updates

To verify a new preview, obtain the new public export from this notice and confirm
its full fingerprint as above. Then:

- **RPM**: import the new public key into the RPM database you use for ProPR
  previews (`sudo rpmkeys --import propr-desktop-release.asc`, or the equivalent
  `rpm --import`). `rpmkeys --checksig --verbose` must report both the header and
  the header+payload signature with key ID `cc4e1599` (the fingerprint suffix).
  Keep the old key only if you still need to verify older RPMs signed with it;
  otherwise remove it (for example `sudo rpm -e gpg-pubkey-3093d3a3` on RPM 4.x).
  It is not revoked, so removal is housekeeping rather than an emergency.
- **Direct downloads**: verify `SHA256SUMS.asc` in a fresh isolated keyring that
  contains only the new export, then check `SHA256SUMS`.
- **APT repository bundle**: replace the source-scoped keyring named in
  `signed-by=` with a binary export of the new key (or create a new keyring file
  and point the new preview's `deb` line at it). Do not add either key to
  `/etc/apt/trusted.gpg` or `trusted.gpg.d`. A repository bundle signed by the new
  key fails `apt update` with a keyring containing only the old key; that failure
  is expected and must not be overridden.

## Custody, compromise and future rotation

The owner must keep encrypted offline backups, the passphrase, and a revocation
certificate under restricted custody; this notice specifies the required
procedure, not an audit of those backups. Never put private exports, passwords,
backup locations, or recovery material in issues, documentation, artifacts, or CI
logs. Test restoration using a controlled owner process; implementation tests use
disposable keys only.

For a suspected compromise or a key question, contact the repository maintainers
through [integry/propr on GitHub](https://github.com/integry/propr/issues).
Do not post secrets. No private contact address is asserted here.

On compromise, maintainers must disable signing and publication authorization,
publish the revocation certificate and affected-release notice through reviewed
docs and existing trusted channels, and arrange a replacement identity. Consumers
must stop trusting the affected key; local RPM databases and scoped APT keyrings
do not discover revocations automatically. Consult the latest reviewed notice
before installing.

Before expiry or a future rotation, publish both complete fingerprints, effective
dates, and the replacement public export, authenticating the transition with the
old key where the owner still controls it. When the old key is unavailable, as in
the 2026-10-19 rotation, say so explicitly and rely on reviewed documentation.
Review the code pin and public settings together: the protected
`PROPR_DESKTOP_RPM_PUBLIC_KEY` and `PROPR_DESKTOP_RPM_FINGERPRINT` settings must
match the reviewed pin before any signing run. Preserve historical notices and
immutable assets with their original trust classification; never relabel them or
bypass verification to accommodate expiry.

This notice and download are delivered through the normal reviewed documentation
pipeline. They do not establish a live production APT endpoint.
