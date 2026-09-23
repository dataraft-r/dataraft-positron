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
  dataraft.core = "d6626eafc8eec7355f7ae226d6e319f9d7d99371",
  dataraft.lake = "82574476d3198343eeb1363f4a7a969efa4f233b",
  dataraft.adapters = "ab28d72c14a6276317a0c45d5aeebd0572bd87a3",
  dataraft.catalog = "e5f34db0ab22792e549d73e0febb1a04a10b7530",
  dataraft.ide = "57849070c9c35f8818c58a148c6c6deb3c336836"
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
