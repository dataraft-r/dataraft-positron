# Positron acceptance and VSIX release checklist

This is a manual acceptance procedure, **not a record of a completed GUI test**.
Run it against the exact VSIX intended for release. Node, R transport and VS Code
host tests do not establish Positron console or data-viewer behavior.

## Record the candidate

Record the git commit, VSIX SHA-256, extension version, OS, Positron version
(**Help: About**), local/Workbench/remote mode, and test date. In the selected R
console save the output of:

```r
R.version.string
vapply(c("dataraft.core", "dataraft.ide", "dataraft.adapters", "yaml"),
       function(x) as.character(packageVersion(x)), character(1))
.libPaths()
```

Use installed candidate R packages, including `dataraft.ide` 0.1.0.9003 or newer.
The extension accesses the independent diagnostics channel through the public
`dataraft.ide::ide_request()` boundary; operation helpers are internal.
Install the extension on the **same host as R**;
both processes must see the same temporary directory and saved workspace files.
A local extension host and separately hosted R session are unsupported. Trust
this test workspace. No lake or database is required for the checks below.

## Create a small saved workspace fixture

Create an empty project folder, open that folder in Positron and save the
following as UTF-8 `acceptance.R` inside it:

```r
library(dataraft.core)

nonnegative <- function(data) {
  all(data$amount >= 0)
}
orders <- dr_product(
  "orders", data.frame(id = 1:3, amount = c(10, -20, 30))
) |> dr_add_quality(nonnegative, name = "nonnegative")
passing <- dr_product(
  "passing", data.frame(id = 1:3, amount = c(10, 20, 30))
) |> dr_add_quality(nonnegative, name = "nonnegative")
slow <- dr_product("slow", function() {
  Sys.sleep(10)
  data.frame(id = 1L)
})
```

Set R's working directory to that folder and run:

```r
source("acceptance.R", keep.source = TRUE)
```

Do not paste the function into the console instead: the diagnostic test needs
its real saved source reference. Discovery should not execute `slow`.

## Live session checks

Use Command Palette names below; the result-specific commands also appear on
result nodes in **Data Products**. Record each row as PASS, FAIL or NOT RUN, with
observed behavior and any issue link.

| Check | Action | Required observation |
| --- | --- | --- |
| Selection | **DataRaft: Select R Session**, choose this R console; **DataRaft: Select Workspace or Lake**, choose Workspace. | `orders`, `passing` and `slow` appear; no new R session starts and no source runs during discovery. |
| Metadata | **DataRaft: Inspect Product**, choose `orders`; expand its rules. | Named `nonnegative` rule is visible. Metadata contains no table cells or function body. |
| Failed trial | **DataRaft: Trial Product**, choose `orders`. | A retained trial result appears with status `blocked`; quality evidence reports `nonnegative` failed. The request completes without publishing. |
| R diagnostics | Right-click that **result**, then **DataRaft: Show R Rule Diagnostics** (`dataraft.showRuleDiagnostics`). Open Problems and select the diagnostic. | The diagnostic opens the actual `nonnegative` function in `acceptance.R`, at its source range. It does not guess the product call's line. |
| Stale source | Edit `acceptance.R` without saving. Request diagnostics for the old result again. Then save the edit and retry. | Existing annotations clear; stale/dirty source is omitted with feedback. No old range is applied to changed text. Re-source with `keep.source = TRUE`, trial again and request diagnostics to restore a valid annotation. |
| Passing result | **Trial Product**, choose `passing`. | Status is `completed`, with passing quality evidence. |
| Bounded View | Set `dataraft.maximumRows` to `2` in Settings. Right-click the passing result and choose **DataRaft: View Bounded Rows in R**. | The R data viewer opens with exactly two rows. No cells appear in extension metadata JSON. Restore the setting after testing. |
| Busy session | Run `Sys.sleep(15)` directly in the R console; while busy, request **Refresh Metadata** or a trial. | The extension rejects the busy request; it does not silently dispatch additional work. Refresh succeeds after R is idle. |
| Cancellation | Trial `slow` and click Cancel on the request progress while it is running. | Waiting stops. R may continue the already dispatched function; cancellation must not claim to terminate it. Once R is idle, a new refresh/trial succeeds and the cancelled response does not replace current UI state. |
| Session change | Start a second R console with a distinct product, such as `other <- dataraft.core::dr_product("other", data.frame(id = 9L))`. Start a `slow` trial in the first console, then **Select R Session** to select the second and refresh. | Only second-session metadata appears. A late response from the first session cannot restore its tree or diagnostics. Switching back requires a refresh. |

Source diagnostics currently support uniquely named native **function** checks
with trustworthy saved source references. Ordinary formula checks such as
`~ amount >= 0` have no reliable source range and are omitted. Generated rules,
ambiguous/nested mappings, changed files and files outside the open workspace
are also omitted. Missing annotations are not evidence that a check passed;
inspect the trial's quality evidence. Files must be UTF-8 and at most 1 MiB.

## YAML preview, apply and explicit save

In the first console, with its working directory still at the project folder:

```r
contract <- dr_contract(
  id = "orders.contract", version = "1.0.0",
  columns = c(id = "integer", amount = "numeric"),
  rules = list(nonnegative = ~ amount >= 0)
)
yaml::write_yaml(dataraft.adapters::dr_contract_odcs(contract),
                 "orders.contract.yaml")
```

1. Run **DataRaft: Open Contract YAML Editor** and select the saved file.
   Change the contract version field to `1.0.1`, then click **Preview field
   edits**. Check that the diff proposes only the intended change and that the
   saved file is unchanged.
2. Return to the editor and click **Apply preview to document**. The document
   must be dirty; **Compare YAML with Saved File** must still show the change.
   Applying is not saving.
3. Explicitly save the document. Reopen it and verify version `1.0.1` persists.
   Run **Validate Saved ODCS Contract in R** against that file and verify success.
4. Preview another edit, then modify the document through **Open YAML text**
   before applying. The pending preview must be invalidated or rejected. Create
   a fresh preview to proceed; no intervening edit may be overwritten.
5. Add a comment and unknown metadata in YAML text, save, then repeat a field
   edit. Verify that both survive preview, apply and save.

Record the actual button-click results separately from automated host results.
Do not replace these checks with direct document edits or command invocation.

## Build and release gate

From a clean checkout with Node 22 or newer:

```sh
npm ci --ignore-scripts
npm test
npm run test:integration
npm run test:host
npm run package
```

The R integration needs the packages listed in
[the integration instructions](../test/integration/README.md); use
`DATARAFT_R_COMMAND` and `R_LIBS` for a non-default R installation. Host tests
need a graphical environment or Xvfb. An unavailable dependency is a blocked
gate, not a successful test. Inspect the VSIX contents and manifest: expected
publisher/version, bundled schemas and runtime assets, license, and no tokens,
private fixtures or unintended files. Record its SHA-256 using the platform's
hash utility.

Use **Extensions: Install from VSIX**, select `dataraft-positron.vsix`, reload
Positron and verify the installed version. Run the manual checks above against
that installed artifact. Keep a pass/fail record including failing steps and
logs; redact sensitive metadata. A release candidate is accepted only when all
required checks pass on the declared supported environment. Record other
platforms as NOT RUN rather than implying coverage.

Open VSX publication is a separate authorized step. Before any upload, verify
ownership of the `dataraft-r` publisher namespace, the intended release version,
license and redistribution requirements, and access to an appropriately scoped
publishing token through approved secret storage. Confirm current registry
requirements and the artifact checksum. Do not put credentials in the repo,
logs or this checklist. This procedure does not publish, provision credentials
or claim that publisher ownership has been verified.
