# DataRaft for Positron

Inspect governed data products, releases and quality evidence in an existing R session. Edit ODCS 3.2 contract YAML in Positron or VS Code.

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
4. Expand products for contracts, columns, rules and sources. Inspect a lake product to load its releases. Quality, runs, freshness and incidents show metadata with their generation timestamps.

Refresh is manual. Expanding an uncached product requests its detail. No background polling, automatic trials, approvals or publishing occur. A busy R session rejects execution requests. Switching sessions invalidates responses still in flight.

**Trial Product** explicitly runs user code and source reads through `dr_trial`; the configured destination is not published. **View Bounded Rows in R** requests a bounded existing table or trial result in the R data viewer. Rows never pass through this extension. **Show Frozen Report Metadata** lists report identifiers and timestamps. Directed lineage supports keyboard focus and selecting a node focuses its matching product in the tree.

## Contract YAML

**Open Contract YAML Editor** edits ODCS 3.2 YAML as the authoritative document. Edits preserve comments and unknown metadata. The editor proposes a diff before applying a version-checked workspace edit, which remains unsaved for your review. Dirty buffers and external changes invalidate pending edits. Diagnostics point to parsed YAML source ranges. The portable `dr_contract_yaml()` metadata export is not an executable ODCS contract.

**Validate Saved ODCS Contract in R** uses `dr_contract_from_odcs()` against the saved file. **Profile Selected Workspace Table** shows inferred schema metadata; **Check Bounded Table Sample against Saved Contract** explicitly checks a bounded in-memory sample and returns counts. Neither command transfers table cells. Sampling does not establish full-dataset quality.

## VS Code and remote workspaces

Without Positron, **Open Metadata JSON** displays bridge-v1 snapshots and the YAML editor remains available. Live R commands explain that Positron is required. Untrusted workspaces allow offline JSON and YAML editing only.

This is a workspace extension: in Positron Workbench or a remote workspace, install it on the same host as the R session. Both must access the same temporary directory and saved YAML paths. A local extension host with a separately hosted R session is unsupported.

## Transport and limits

The bridge contract is numeric version 1. The extension sends base64-encoded JSON to `dataraft.ide::ide_request()` using the selected R console session ID. It ignores `executeCode()` results and never parses console output or R source. An atomic response file in a private temporary directory carries a matching request ID and exact metadata DTOs. Requests are serialized; cancellation/disposal prevents queued extension requests from dispatching. Timeout or cancellation stops waiting, but R work already queued may still finish.

Requests are limited to 16 KiB and responses to 1 MiB. Symlinks, unexpected DTO fields, invalid versions and stale request IDs are rejected. Metadata text may itself be sensitive; share snapshots deliberately. The bridge is not a sandbox for user transforms or a defense against another process running as the same OS user.

Implementation uses the [official Positron extension API](https://positron.posit.co/extension-development.html), pinned to `@posit-dev/positron` 0.2.10. The full bridge JSON Schema is included in `schemas/bridge-v1.json`.

## Validation

`npm test` compiles TypeScript and runs Node tests for transport, request injection, atomic rename, bounds, cancellation, queue disposal, strict DTO validation, lineage escaping and conflict-safe YAML editing. `npm run test:host` runs an extension-host smoke test when a graphical test environment is available. A real Positron session is required to validate the final R UI integration; Node tests do not substitute for that check.
