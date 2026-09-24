# DataRaft for Positron v0.2.0

This experimental preview makes governed data products easier to explore in Positron. It also includes the portfolio acceptance case used for the extension website.

## Install

Download `dataraft-positron-0.2.0.vsix` from this release. In Positron, run **Extensions: Install from VSIX**, select the file and reload if prompted. Live R features require `dataraft.ide` and the DataRaft packages used by your R workspace. Install the extension on the same host as the R session.

## Changes since v0.1.0

- Browse a workspace overview and structured product pages for contracts, quality rules, policies, input and output ports, and delivery timing.
- Run explicit product trials, inspect completed or blocked results, see failed quality counts, and follow directed lineage.
- Edit ODCS YAML with a guided form, a diff preview and version-checked application. Failed R function rules can show diagnostics in their source files.
- Exercise a deterministic six-table insurance portfolio in native Positron acceptance tests. Its source data, contracts, model, blocked cash receipt, and lapse-rate calculation are also covered by framework regression tests. [Explore the six original screenshots](https://dataraft-r.github.io/dataraft/extension/portfolio-case/).
- Wait for Ark to report an idle R session between the five metadata refresh operations, avoiding a stale pane after a completed response.

## Validation and scope

The release workflow builds this VSIX from the exact `v0.2.0` commit only after its extension check workflow has passed, including Node tests, persistent R integration, and native Positron 2026.09.1-2 / R 4.5.1 user flows. The release includes a SHA-256 checksum file. This is a pre-release; automated checks do not establish manual usability, Windows/macOS or remote-session acceptance of the packaged VSIX.
