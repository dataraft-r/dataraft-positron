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
