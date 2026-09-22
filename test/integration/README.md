# Real R session integration

Run `npm run test:integration` from the extension repository after installing its
Node dependencies and these R packages:

- `dataraft.core`, `dataraft.lake`, `dataraft.catalog`, `dataraft.ide`
- `duckdb`, `bit64`, `dm`, and their package dependencies

The command starts a real persistent R subprocess. It fails if R or a required
package is missing; it does not skip an unavailable integration. Unit tests stay
separate under `npm test`.

By default it uses `R` from `PATH`. Set `DATARAFT_R_COMMAND` to an R executable or
wrapper path, and use R's standard `R_LIBS` environment variable when testing
packages installed outside the default libraries. The executable path is passed
directly to process spawning, without a shell. For example:

```sh
DATARAFT_R_COMMAND=/path/to/R R_LIBS=/path/to/test-library npm run test:integration
```

The test creates a temporary local DuckDB lake and an R workspace with real
products, a workflow, a model, retained trial results, and deliberately unsafe
active/delayed bindings. Requests use the production `BridgeTransport`, matching
request IDs, atomic response files, the canonical JSON Schema, and Node protocol
validation. R stdout is discarded. A trial result handle is inspected again in
the same process, its quality evidence is fetched, and a binding is changed
before the next metadata request. Sensitive synthetic table values and source
text must never appear in response metadata. Temporary resources are removed.

This verifies the R/file/Node boundary, not the Positron GUI or its runtime
session selection API. The test does not invoke the GUI data viewer.
