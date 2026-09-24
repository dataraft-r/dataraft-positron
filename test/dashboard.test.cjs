const { test } = require("node:test");
const assert = require("node:assert/strict");
const {
  productHtml,
  snapshotHtml,
  contractHtml,
  overviewHtml,
} = require("../dist/dashboard");
const { validateEnvelope } = require("../dist/protocol");
const fixture = (name) =>
  structuredClone(require("./fixtures/" + name + ".json"));

test("product dashboard exposes guarantees as readable controls and escapes untrusted metadata", () => {
  const detail = fixture("product").data;
  detail.id = "<img src=x onerror=alert(1)>";
  detail.guarantees = {
    lifecycle: "validated",
    inputs: [],
    outputs: [
      {
        id: "warehouse",
        direction: "output",
        version: "2",
        access: "internal",
        contract_version: "2",
        sla: {
          refresh: "daily",
          available_by: "08:00",
          timezone: "Europe/Berlin",
          freshness: 24,
        },
      },
    ],
    policy_count: 2,
  };
  const response = { ...fixture("product"), data: detail };
  validateEnvelope(response);
  const html = productHtml(detail, response.generated, "nonce");
  assert.match(html, /Lifecycle/);
  assert.match(html, /warehouse/);
  assert.match(html, /08:00/);
  assert.match(html, /Trial without publishing/);
  assert.doesNotMatch(html, /<img src=x/);
  assert.match(html, /&lt;img src=x/);
  assert.doesNotMatch(html, /JSON\.stringify\(detail/);
});

test("overview counts known issues and escapes product names", () => {
  const product = fixture("product").data;
  product.id = "<script>alert(1)</script>";
  const html = overviewHtml(
    [product],
    [{ status: "failed" }],
    [],
    "2026-09-24T00:00:00Z",
    "nonce",
  );
  assert.match(html, /1<\/strong> warning or failed/);
  assert.match(html, /Inspect product/);
  assert.doesNotMatch(html, /<script>alert/);
});

test("snapshot table names truncation and never invents a successful check", () => {
  const response = fixture("quality");
  response.data.truncated = true;
  const html = snapshotHtml(response, "nonce");
  assert.match(html, /snapshot is limited/);
  assert.match(html, /<table>/);
  assert.match(html, /<th scope="col">Rule<\/th>/);
  const contract = {
    id: "orders",
    version: "1",
    key: ["id"],
    columns: [{ name: "id", type: "integer", required: true }],
  };
  assert.match(contractHtml("Validated", contract, "nonce"), /Columns/);
});
