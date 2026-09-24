# DataRaft for Positron

Inspect governed data products, releases and quality evidence in an existing R session. Structured product pages show contracts, lifecycle state, input and output ports, delivery SLA, rules and sources. Edit ODCS 3.2 contract YAML through a guided form in Positron or VS Code.

## Install

Build with Node 22 or newer:

```sh
npm ci --ignore-scripts
npm test
npm run package
```

Use **Extensions: Install from VSIX** and select `dataraft-positron.vsix`. Live R integration requires the separate `dataraft.ide` R package plus the DataRaft packages used by your workspace.

1. Start an R console in Positron and create your products or connect your lake.
2. Run **DataRaft: Select R Session**. The extension never starts a session.
3. Run **DataRaft: Select Workspace or Lake** to choose a context, or **Refresh Metadata** to inspect workspace definitions.
4. Run **Open Data Product Overview** for a workspace summary, then open a product for its contract, ports and explicit Trial, View, Lineage and Refresh actions. Expand products for details and lake releases. Quality, runs, freshness and incidents show metadata with their generation timestamps.

Product lifecycle and port details require `dataraft.ide` 0.1.0.9007 or newer. Older bridges remain readable and the page explains which guarantees are unavailable. SLA information is descriptive in this view; an SLA can be evaluated on publication in R. Changes to lifecycle state, policies, dependencies and backfills remain R operations; the extension does not implicitly publish, promote or rewrite a partition.

Refresh is manual. Expanding an uncached product requests its detail. No background polling, automatic trials, approvals or publishing occur. A busy R session rejects execution requests. Switching sessions invalidates responses still in flight.

**Trial Product** explicitly runs user code and source reads through `dr_run(x, write = FALSE)`; the configured destination is not published. **View Bounded Rows in R** requests a bounded existing table or trial result in the R data viewer. Rows never pass through this extension. **Show Frozen Report Metadata** lists report identifiers and timestamps. Directed lineage supports keyboard focus and selecting a node focuses its matching product in the tree.

## Contract YAML

**Open Contract YAML Editor** edits ODCS 3.2 YAML as the authoritative document. Edits preserve comments and unknown metadata. The editor proposes a diff before applying a version-checked workspace edit, which remains unsaved for your review. Dirty buffers and external changes invalidate pending edits. Diagnostics point to parsed YAML source ranges. The portable `dr_contract_yaml()` metadata export is not an executable ODCS contract.

The saved-file baseline comes from opening the editor and explicit saves. If another program changes the file, preserve any unsaved work and review those external changes, then close and reopen the contract editor before previewing further edits. Reopening establishes a fresh disk baseline; the extension does not automatically save over the changed file.

**Validate Saved ODCS Contract in R** uses `dr_contract_from_odcs()` against the saved file. **Profile Selected Workspace Table** shows inferred schema metadata; **Check Bounded Table Sample against Saved Contract** explicitly checks a bounded in-memory sample and returns counts. Neither command transfers table cells. Sampling does not establish full-dataset quality.

## VS Code and remote workspaces

Without Positron, **Open Metadata JSON** loads metadata-channel snapshots into the same structured views and the YAML editor remains available. Live R commands explain that Positron is required. Untrusted workspaces allow offline snapshot inspection and YAML editing only.

This is a workspace extension: in Positron Workbench or a remote workspace, install it on the same host as the R session. Both must access the same temporary directory and saved YAML paths. A local extension host with a separately hosted R session is unsupported.

## Transport and limits

Metadata, trial and viewer requests use the metadata channel (wire discriminator 1). **Show R Rule Diagnostics** uses the independent diagnostics channel (wire discriminator 2), not a successor metadata protocol. The extension sends base64-encoded JSON to `dataraft.ide::ide_request()` using the selected R console session ID. It ignores `executeCode()` results and never parses console output or evaluates R source. The bridge requires `dataraft.ide` 0.1.0.9003 or newer. The transport passes its private temporary directory as a trusted `ide_context(response_root = ...)` argument, separately from request JSON. R confines response writes to that canonical directory. An atomic response file carries a matching request ID and exact metadata DTOs. Requests are serialized; cancellation/disposal prevents queued extension requests from dispatching. Timeout or cancellation stops waiting, but R work already queued may still finish.

Requests are limited to 16 KiB and responses to 1 MiB. Symlinks, unexpected DTO fields, invalid versions and stale request IDs are rejected. Metadata text may itself be sensitive; share snapshots deliberately. The bridge is not a sandbox for user transforms or a defense against another process running as the same OS user.

Implementation uses the [official Positron extension API](https://positron.posit.co/extension-development.html), pinned to `@posit-dev/positron` 0.2.10. The independent channel schemas are `schemas/bridge-metadata-v1.json` and `schemas/bridge-diagnostics-v1.json`. Their numeric wire discriminators remain 1 and 2 for compatibility; diagnostics is not a replacement metadata protocol. See [compatibility and pin maintenance](docs/maintenance.md) for ownership, review cadence and the update procedure.

## Validation

The test layers exercise different boundaries:

- `npm test` compiles TypeScript and runs Node tests. Real controller code uses an isolated VS Code/Positron API double to check R console filtering, cancelled selection, vanished/busy/untrusted sessions, session switches at asynchronous boundaries, explicit Trial and bounded View, stale responses and recovery. Transport tests use actual temporary files and atomic renames, including malformed responses, cancellation, queue recovery and cleanup. YAML tests cover AST preservation, conflict checks, sample profiling and diagnostic source ranges.
- `npm run test:integration` uses a real persistent R process and the actual bridge package to validate metadata and execution evidence across multiple requests. See `test/integration/README.md` for prerequisites.
- `npm run test:host` requires a graphical environment or Xvfb and uses the pinned VS Code 1.96.4 extension host. It checks every declared command and the real YAML custom-editor lifecycle: document edits, diagnostics, an unsaved-versus-saved diff and explicit save. A Playwright CDP client drives the production webview inside that Electron host: it fills a contract field and clicks Preview, Discard and Apply, checks that Apply leaves YAML unsaved, and verifies that a concurrent text edit invalidates the pending preview. The loopback debugging port is allocated only by the test runner; no production test hook is installed. It does not simulate a Positron runtime.

- `npm run test:positron` adds a dedicated native Positron and Ark journey with real command-palette, tree, lineage and YAML clicks, passing/failing R trials, source diagnostics and a bounded native Data Explorer. See [native test setup and scope](test/POSITRON.md). This suite must pass in the dedicated graphical job before claiming native GUI coverage; syntax and unit checks alone do not establish it.

The [manual Positron acceptance guide](docs/positron-acceptance.md) remains necessary for release VSIX checks, other platforms, remote sessions and human usability.

## R rule diagnostics

After an explicit Trial, select its retained result and run **Show R Rule Diagnostics**. This command requires a diagnostics-capable `dataraft.ide`; older bridges produce an upgrade message while existing v1 features remain usable. It does not rerun the product.

Only function rules loaded with `source(..., keep.source = TRUE)` can provide verified R source references. Formula locations are unavailable. The bridge snapshots source hashes before the trial; the extension accepts only unchanged UTF-8 files of at most one MiB inside the current workspace, with valid zero-based UTF-16 ranges. Dirty or stale editor buffers, changed files, outside-workspace paths and invalid ranges receive no markers. Diagnostic messages contain the rule identifier and status, without failure rows or condition text.

Markers clear on document edits, external changes to mapped files, refresh, session/context changes and extension disposal. A summary reports omitted locations; absent locations do not imply that rules passed. No source locations or paths are added to v1 responses.

Offline lineage snapshots accept at most 500 nodes and 500 edges, matching the live metadata bridge. Oversized files are rejected before opening a panel. Lineage uses stack-safe component traversal; closing a panel or deactivating the extension disposes its message listener and panel state.
