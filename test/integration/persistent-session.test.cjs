const { test } = require("node:test");
const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const { mkdtemp, rm } = require("node:fs/promises");
const { join } = require("node:path");
const { tmpdir } = require("node:os");
const Ajv2020 = require("ajv/dist/2020");
const addFormats = require("ajv-formats");
const schema = require("../../schemas/bridge-v1.json");
const { BridgeTransport } = require("../../dist/transport");

test(
  "real persistent R workspace crosses the canonical file protocol",
  { timeout: 180000 },
  async (t) => {
    const ajv = new Ajv2020({ allErrors: true, strict: false });
    addFormats(ajv);
    const validateResponse = ajv.compile(schema);
    const validateRequest = ajv.compile({
      $ref: schema.$id + "#/$defs/request",
    });
    const root = await mkdtemp(join(tmpdir(), "dataraft-integration-"));
    const executable = process.env.DATARAFT_R_COMMAND || "R";
    const child = spawn(
      executable,
      [
        "--vanilla",
        "--slave",
        "--file=" + join(__dirname, "session.R"),
        "--args",
        root,
      ],
      { stdio: ["pipe", "ignore", "pipe"], env: process.env },
    );
    let stderr = "";
    child.stderr.on("data", (data) => {
      stderr = (stderr + data).slice(-16384);
    });
    child.stdin.on("error", () => {});
    const exited = new Promise((resolve, reject) => {
      child.on("error", reject);
      child.on("close", (code) =>
        code === 0
          ? resolve()
          : reject(new Error(`R fixture exited ${code}: ${stderr}`)),
      );
    });
    // A process startup failure must not become an unhandled rejection while the
    // transport is waiting for its first file.
    exited.catch(() => {});
    const send = (line) =>
      new Promise((resolve, reject) => {
        child.stdin.write(line + "\n", (error) =>
          error ? reject(error) : resolve(),
        );
      });
    const bridge = new BridgeTransport(
      (code, sessionId) => {
        assert.equal(sessionId, "persistent-r-fixture");
        const match = code.match(
          /^dataraft\.ide::ide_request\("([A-Za-z0-9+/=]+)"\)$/,
        );
        assert.ok(match, "only the fixed encoded R entry point is sent");
        const request = JSON.parse(
          Buffer.from(match[1], "base64").toString("utf8"),
        );
        assert.ok(
          validateRequest(request),
          JSON.stringify(validateRequest.errors),
        );
        return send(match[1]);
      },
      60000,
      root,
    );
    let responseCount = 0;
    async function request(input) {
      const response = await Promise.race([
        bridge.request("persistent-r-fixture", input, t.signal),
        exited.then(() => {
          throw new Error("R session closed before its response.");
        }),
      ]);
      assert.equal(
        response.error,
        null,
        `${input.operation}: ${JSON.stringify(response.error)}`,
      );
      assert.ok(
        validateResponse(response),
        JSON.stringify(validateResponse.errors),
      );
      const json = JSON.stringify(response);
      for (const secret of [
        "ROW_VALUE_42",
        "PRIVATE_PERSON",
        "PRIVATE_CLAIM_HISTORY",
        "SOURCE_BODY_MUST_NOT_LEAK",
      ]) {
        assert.ok(
          !json.includes(secret),
          "table values and executable source text stay in R",
        );
      }
      responseCount++;
      return response.data;
    }
    try {
      const contexts = await request({ operation: "contexts" });
      assert.ok(contexts.items.some((x) => x.handle === "binding:lake"));
      const products = await request({ operation: "products" });
      const orders = products.items.find((x) => x.id === "orders");
      const workflow = products.items.find((x) => x.id === "workflow");
      assert.ok(orders);
      assert.ok(
        workflow,
        "actual dr_product_workflow is discoverable without execution",
      );
      assert.ok(
        !products.items.some((x) =>
          ["binding:active", "binding:delayed"].includes(x.handle),
        ),
      );
      await request({ operation: "product", handle: orders.handle });
      await request({ operation: "product", handle: workflow.handle });
      await request({ operation: "lineage" });
      const published = await request({
        operation: "products",
        context: "binding:lake",
      });
      assert.equal(
        published.items.find((x) => x.id === "orders").can_view,
        true,
      );
      assert.equal(
        published.items.find((x) => x.id === "portfolio").can_view,
        false,
        "model manifests are not table previews",
      );
      for (const operation of [
        "releases",
        "runs",
        "quality",
        "freshness",
        "incidents",
        "reports",
        "lineage",
      ]) {
        await request({ operation, context: "binding:lake" });
      }
      const trial = await request({
        operation: "trial",
        handle: orders.handle,
      });
      assert.equal(trial.status, "completed");
      const retained = await request({
        operation: "product",
        handle: trial.handle,
      });
      assert.equal(retained.kind, "result");
      assert.equal(retained.handle, trial.handle);
      const quality = await request({
        operation: "quality",
        handle: trial.handle,
      });
      assert.ok(
        quality.items.length > 0,
        "trial evidence remains available in this R session",
      );
      const profile = await request({
        operation: "profile",
        handle: "binding:rows",
      });
      assert.deepEqual(
        profile.columns.map((x) => x.name),
        ["id", "owner", "description"],
      );
      await send("UPDATE_WORKSPACE");
      const changed = await request({ operation: "products" });
      assert.ok(
        changed.items.some((x) => x.id === "orders.changed"),
        "the next request observes a changed binding",
      );
      t.diagnostic(
        `${responseCount} real R responses passed file transport, canonical JSON Schema and Node protocol checks`,
      );
    } catch (error) {
      throw new Error(`${error.message}\nR stderr: ${stderr}`, {
        cause: error,
      });
    } finally {
      bridge.dispose();
      child.stdin.end();
      const terminate = setTimeout(() => child.kill(), 5000);
      terminate.unref();
      try {
        await exited;
      } finally {
        clearTimeout(terminate);
        await rm(root, { recursive: true, force: true });
      }
    }
  },
);
