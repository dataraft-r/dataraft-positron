# A real, persistent R workspace. Protocol responses travel only through files.
library(dataraft.core)
library(dataraft.lake)
library(dataraft.ide)

root <- commandArgs(trailingOnly = TRUE)[[1L]]
workspace <- new.env(parent = emptyenv())
workspace$rows <- data.frame(
  id = "ROW_VALUE_42",
  owner = "PRIVATE_PERSON",
  description = "PRIVATE_CLAIM_HISTORY"
)
workspace$orders <- dr_product(
  "orders",
  data.frame(id = 1:3, amount = c(25, 50, 75)),
  contract = dr_contract(
    "orders.contract",
    "1.0.0",
    "Risk",
    "Orders",
    "one order",
    c(id = "integer", amount = "numeric"),
    key = "id"
  )
)
workspace$workflow <- dr_workflow() |>
  dr_add_product(dr_product("workflow")) |>
  dr_add_source(function() stop("SOURCE_BODY_MUST_NOT_LEAK"))
workspace$model <- dr_product(
  "portfolio",
  dm::dm(customers = data.frame(id = 1:2)),
  contracts = list(customers = dr_contract("customers.contract", columns = c(id = "integer")))
)
makeActiveBinding(
  "active",
  function() stop("ACTIVE_BINDING_EXECUTED"),
  workspace
)
delayedAssign(
  "delayed",
  stop("DELAYED_BINDING_EXECUTED"),
  assign.env = workspace
)
workspace$lake <- dr_open_lake(file.path(root, "lake"))
dr_publish(workspace$orders, to = workspace$lake)
dr_publish(workspace$model, to = workspace$lake)
# Saved ODCS fixtures use the same public exporter as an editor-created contract.
workspace$sample_rows <- data.frame(
  amount = c(10, -20, -987654321),
  claimant = c(
    "QUALITY_PRIVATE_FIRST",
    "QUALITY_PRIVATE_SECOND",
    "QUALITY_PRIVATE_THIRD"
  )
)
sample_contract <- dr_contract(
  id = "sample.contract",
  version = "1.0.0",
  columns = c(amount = "numeric", claimant = "character"),
  rules = list(nonnegative = ~ amount >= 0)
)
odcs <- dataraft.adapters::dr_contract_odcs(sample_contract)
yaml::write_yaml(odcs, file.path(root, "sample.contract.yaml"))
odcs$schema[[1L]]$quality[[1L]]$implementation$predicate <-
  'system("CONTRACT_SOURCE_MUST_NOT_LEAK")'
yaml::write_yaml(odcs, file.path(root, "invalid.contract.yaml"))
# A true srcref-backed function rule; source contents never cross the bridge.
rule_file <- file.path(root, "rule-source.R")
writeLines(c("# Unicode source: 雪", "positive <- function(data) data$amount >= 0"), rule_file, useBytes = TRUE)
rule_environment <- new.env(parent = baseenv())
source(rule_file, local = rule_environment, keep.source = TRUE, encoding = "UTF-8")
workspace$diagnostic_product <- dr_product("diagnostic.orders", data.frame(amount = -1),
  contract = dr_contract("diagnostic.contract", columns = c(amount = "numeric"))) |>
  dr_add_quality(dr_quality_rule(rule_environment$positive, name = "positive"))
context <- ide_context(workspace, response_root = root, read_roots = root)

input <- file("stdin", open = "r")
repeat {
  encoded <- readLines(input, n = 1L, warn = FALSE)
  if (!length(encoded)) {
    break
  }
  if (identical(encoded, "UPDATE_WORKSPACE")) {
    workspace$orders <- dr_product("orders.changed", data.frame(id = 4:6))
    next
  }
  ide_request(encoded, context = context)
}
close(input)
dr_close_lake(workspace$lake)
