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
