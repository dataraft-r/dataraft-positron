# Sourced into the real Ark console. No mock runtime, viewer, or bridge.
library(dataraft.core)
library(dataraft.ide)
source(
  file.path(native_root, "native-rule.R"),
  keep.source = TRUE,
  encoding = "UTF-8"
)
passing_orders <- dr_product(
  "passing.orders",
  data.frame(id = seq_len(20L), amount = as.numeric(seq_len(20L)))
) |>
  dr_add_quality(dr_quality_rule(native_nonnegative, name = "nonnegative"))
failing_orders <- dr_product(
  "failing.orders",
  data.frame(id = 1:2, amount = c(-1, 2))
) |>
  dr_add_quality(dr_quality_rule(native_nonnegative, name = "nonnegative"))
governed_orders <- dr_product(
  "governed.orders", data.frame(id = 1:2, amount = c(1, 2)),
  contract = dr_contract("governed.orders", version = "1.0.0",
    columns = c(id = "integer", amount = "numeric"), key = "id")
) |>
  dr_add_output(dr_output(
    "warehouse", dataraft.adapters::dr_target_rds(file.path(native_root, "governed.rds")),
    sla = dr_sla(available_by = "08:00", timezone = "UTC")
  ))

# The larger portfolio is the same installed example exercised by R package tests.
# Copy it into the isolated workspace so every displayed product has inspectable
# source and the screenshots retain a reproducible definition.
portfolio_source <- system.file("examples", "portfolio-case.R", package = "dataraft",
                                mustWork = TRUE)
stopifnot(file.copy(portfolio_source, file.path(native_root, "portfolio-case.R")))
source(file.path(native_root, "portfolio-case.R"), local = TRUE,
       keep.source = TRUE, encoding = "UTF-8")
portfolio <- portfolio_case(file.path(native_root, "portfolio-outputs"))
for (name in names(portfolio$products)) {
  assign(paste0("portfolio_", name), portfolio$products[[name]], envir = .GlobalEnv)
}
