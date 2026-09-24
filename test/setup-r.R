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
  dataraft.core = "b753ea7c40dd88df9c3448912941e4ee9e6e352f",
  dataraft.lake = "6fb0a57d4e4b3157636933594c64b3637184a51e",
  dataraft.adapters = "8af12ffb0a45569f9326ed4905b50c6c2498ac11",
  dataraft.metrics = "60d37099d78ac54689dcaa1f2ed75f11ddb5cd72",
  dataraft.ide = "99e42ab9f6e25e16c4afa25b766e64fe8d67774f"
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
# The portfolio fixture is installed by the coordinated umbrella PR. Once
# merged, replace this branch ref with its immutable commit SHA.
portfolio_ref <- Sys.getenv("DATARAFT_PORTFOLIO_REF", "feature/portfolio-acceptance-20260924")
remotes::install_github(
  paste0("dataraft-r/dataraft@", portfolio_ref),
  dependencies = FALSE, upgrade = "never", build_vignettes = FALSE
)
required <- c(names(refs), "dataraft", "duckdb", "bit64", "dm", "yaml")
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
