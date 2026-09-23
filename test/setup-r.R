# Ubuntu binaries from the same dated family snapshot avoid compiling DuckDB.
options(
  repos = c(
    CRAN = "https://packagemanager.posit.co/cran/__linux__/noble/2026-09-18"
  )
)
install.packages(c(
  "remotes",
  "DBI",
  "cli",
  "dbplyr",
  "digest",
  "dplyr",
  "fs",
  "jsonlite",
  "rlang",
  "lifecycle",
  "tibble",
  "withr",
  "duckdb",
  "bit64",
  "dm",
  "yaml"
))
# Minimal integration subset of the merged umbrella family-lock.json.
# Explicit refs preserve the tested combination without following main.
refs <- c(
  dataraft.core = "ff0a6a875f5b4405ad21f5aaf482e1087fc7bfe3",
  dataraft.lake = "842a0fc24ac6dcb57a83789a0ccd517905c53b9b",
  dataraft.adapters = "946e037d5e93835bc9b516d85b3dc1df50f2f032",
  dataraft.ide = "636213398632524bd5d22581eb2779c64beb8a8f"
)
for (package in names(refs)) {
  # Hard dependencies are installed above, in dependency order. Disabling
  # dependency resolution prevents old component Remotes replacing pins.
  remotes::install_github(
    paste0("dataraft-r/", package, "@", refs[[package]]),
    dependencies = FALSE,
    upgrade = "never",
    build_vignettes = FALSE
  )
  stopifnot(identical(
    utils::packageDescription(package, fields = "RemoteSha"),
    refs[[package]]
  ))
}
required <- c(names(refs), "duckdb", "bit64", "dm", "yaml")
stopifnot(all(vapply(required, requireNamespace, logical(1), quietly = TRUE)))
stopifnot(utils::packageVersion("duckdb") >= "1.5.5")

dir.create(".vscode-test", showWarnings = FALSE)
jsonlite::write_json(
  list(
    r_version = as.character(getRversion()),
    repository = unname(getOption("repos")[["CRAN"]]),
    packages = lapply(required, function(package) {
      list(
        name = package,
        version = as.character(utils::packageVersion(package)),
        remote_sha = utils::packageDescription(package, fields = "RemoteSha")
      )
    })
  ),
  ".vscode-test/r-provenance.json",
  auto_unbox = TRUE,
  pretty = TRUE,
  na = "null"
)
