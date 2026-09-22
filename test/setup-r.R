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
  dataraft.core = "871982715c6000c8f1018456576e6cd517a5b7a6",
  dataraft.lake = "7462a326a1cb65280795cc89217d72b1b9a69d22",
  dataraft.adapters = "2c770354c67476919e534c6bfe82682e51c1bf51",
  dataraft.catalog = "11c1f5f3705f83d609250a6c954012a2b430ad75",
  dataraft.ide = "dc34be1c9bd94d52f619a010ee577cf45ee7381a"
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
