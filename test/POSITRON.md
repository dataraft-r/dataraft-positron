# Native Positron and Ark acceptance

`npm run test:positron` runs `positron-host.cjs` inside the checksum-pinned
Positron **2026.09.1-2** application, using its bundled R extension and Ark kernel.
The hosted Linux job requires **R 4.5.1** and pinned DataRaft packages. It needs a
display or Xvfb. Missing runtimes, unavailable UI, failed assertions, and timeouts
fail the test; none turn into skips. See `positron-release.json`,
`install-positron.cjs`, and `run-positron.cjs` for installation and provenance.

The test creates its own synthetic workspace and starts a real registered R
console through the Positron API. Setup executes in that console and writes an
atomic acknowledgement containing versions and the R process ID. Subsequent
requests use the extension's production bridge and that same selected session.
There is no substituted runtime API, bridge handler, trial function, or viewer,
and no separate R subprocess standing in for Ark.

A Playwright CDP connection drives the actual Electron workbench:

1. Select the R console in the command palette and its session picker.
2. Refresh all five metadata views; click a product tree row and inspect its
   real JSON document.
3. Trial a passing and a failing product through the palette and product picker.
   Check the returned `completed` and `blocked` results.
4. Click failed evidence in the quality tree and verify one failed row out of
   two.
5. Request R diagnostics for the retained failing result and verify a diagnostic
   on the actual saved function source, including its line and severity.
6. View the passing result and inspect the native Positron Data Explorer status
   bar: exactly three rows from a twenty-row result, with the expected column.
7. Click a node in the production lineage webview and verify the corresponding
   product is selected in the tree.
8. Exercise the production YAML form buttons: Preview, Discard, Apply, and stale
   preview rejection after a concurrent document edit.

Workbench view-focus commands reveal panes as setup. The actions under test use
actual palette, picker, tree and webview clicks. Completion waits observe runtime
state, atomic files, generated view timestamps, editor documents or visible DOM;
there are no fixed-duration sleeps that assume an operation has completed.

The runner writes app/archive/runtime provenance. The suite writes R and package
versions, completed journeys, screenshots and a Playwright trace under
`.vscode-test/positron-artifacts`. Failure HTML and screenshots use only the
isolated synthetic fixture. Do not point this runner at a personal profile or
workspace. `DATARAFT_EXPECT_R_VERSION` permits explicit local exploratory runs
with another version; the CI job fixes it to `4.5.1` and the actual version remains
recorded.

These tests do not establish Windows/macOS, Workbench/remote sessions, screen
reader behavior, or human usability. They do not replace the release VSIX manual
acceptance procedure. Local syntax/unit/fixture checks are not evidence that a
native GUI run passed; inspect the dedicated hosted job and its artifacts.

Upstream references for the pinned application:

- [R extension and runtime registration](https://github.com/posit-dev/positron/blob/2026.09.1-2/extensions/positron-r/src/extension.ts)
- [Quick input selectors](https://github.com/posit-dev/positron/blob/2026.09.1-2/test/e2e/pages/quickInput.ts)
- [Native Data Explorer selectors](https://github.com/posit-dev/positron/blob/2026.09.1-2/test/e2e/pages/dataExplorer.ts)

The independent `test:integration` command still tests a persistent R subprocess
and the file/Node protocol boundary. `test:host` still targets VS Code's custom
editor host. Neither substitutes for this native Positron job.
