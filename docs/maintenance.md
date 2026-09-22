# Compatibility and pin maintenance

Owner: JanWein (repository maintainer). Review compatibility pins monthly and
when a relevant security advisory or upstream breaking change is published.
A review does not require upgrading a working baseline; record that decision
in the compatibility PR or issue. CI deliberately never follows `latest`.

The family R commits, CRAN snapshot, R version, npm lockfile, Positron API package,
and Positron desktop build describe one tested combination. Their pins make a
past result reproducible but require coordinated maintenance. The desktop
checksum is verified before extraction; its packaged commit, build, Debian
metadata and executable size detect a wrong or incomplete installation. Size
is a completeness check, not an additional cryptographic guarantee.

## Updating a supported combination

1. Choose an explicit stable Positron release from the official release notes.
   On Linux with `curl` and `dpkg-deb`, run
   `node test/update-positron-release.cjs 2026.09.1-2` (substitute the selected
   version). The script verifies the official SHA-256 before extraction and
   derives metadata and executable size rather than requiring manual copying.
2. Review the generated `test/positron-release.json` diff and official release
   notes. Check the `@posit-dev/positron` API compatibility table before changing
   its separate npm pin; regenerate `package-lock.json` through npm if needed.
3. Select compatible R package commits in `test/setup-r.R`, review the CRAN
   snapshot and R version in the workflow, and synchronize family CI pins.
   For R bridge changes, merge the tested bridge first, then pin its exact SHA.
4. Run unit tests, the persistent R integration, the VS Code host checks and
   the native Positron job. Review the native screenshots and provenance
   artifacts. A passing API test does not certify human usability.
5. Merge the compatibility PR only after these checks pass. Keep prior pins in
   git history for rollback. Update the family compatibility record when needed.

## Two independent bridge channels

`schemas/bridge-metadata-v1.json` describes the metadata channel's first schema;
`schemas/bridge-diagnostics-v1.json` describes the source diagnostics channel's
first schema. Diagnostics is not a successor to metadata. For compatibility
with released code, their numeric wire discriminators remain `1` and `2` in
`request.version` and `response.contract`. Renaming files does not migrate the
wire format. Existing metadata operations continue using discriminator `1`.
The public R boundary is `ide_context()` plus `ide_request()`; operation helpers
are internal and clients validate the returned envelope before using data.
