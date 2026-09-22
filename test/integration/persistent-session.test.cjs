const { test } = require("node:test");
const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const { mkdtemp, rm, readFile, writeFile } = require("node:fs/promises");
const { join } = require("node:path");
const { tmpdir } = require("node:os");
const Ajv2020 = require("ajv/dist/2020");
const addFormats = require("ajv-formats");
const schema = require("../../schemas/bridge-v1.json");
const diagnosticsSchema = require("../../schemas/bridge-v2.json");
const { createHash } = require("node:crypto");
const { BridgeTransport } = require("../../dist/transport");

test(
  "real persistent R workspace crosses the canonical file protocol",
  { timeout: 180000 },
  async (t) => {
    const ajv = new Ajv2020({ allErrors: true, strict: false });
    addFormats(ajv);
    const validateResponse = ajv.compile(schema);
    const validateDiagnostics = ajv.compile(diagnosticsSchema);
    const validateDiagnosticsRequest = ajv.compile({
      $ref: diagnosticsSchema.$id + "#/$defs/request",
    });
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
        const validator =
          request.version === 2 ? validateDiagnosticsRequest : validateRequest;
        assert.ok(validator(request), JSON.stringify(validator.errors));
        return send(match[1]);
      },
      60000,
      root,
    );
    let responseCount = 0;
    async function request(input, expectedError = null) {
      const response = await Promise.race([
        bridge.request("persistent-r-fixture", input, t.signal),
        exited.then(() => {
          throw new Error("R session closed before its response.");
        }),
      ]);
      if (expectedError) {
        assert.equal(response.kind, "error");
        assert.equal(response.data, null);
        assert.equal(response.error?.code, expectedError);
        assert.equal(typeof response.error.message, "string");
        assert.ok(response.error.message.length > 0);
      } else {
        assert.equal(
          response.error,
          null,
          `${input.operation}: ${JSON.stringify(response.error)}`,
        );
      }
      const validator =
        input.version === 2 ? validateDiagnostics : validateResponse;
      assert.ok(validator(response), JSON.stringify(validator.errors));
      const json = JSON.stringify(response);
      for (const secret of [
        "ROW_VALUE_42",
        "PRIVATE_PERSON",
        "PRIVATE_CLAIM_HISTORY",
        "SOURCE_BODY_MUST_NOT_LEAK",
        "QUALITY_PRIVATE_FIRST",
        "QUALITY_PRIVATE_SECOND",
        "QUALITY_PRIVATE_THIRD",
        "987654321",
        "CONTRACT_SOURCE_MUST_NOT_LEAK",
      ]) {
        assert.ok(
          !json.includes(secret),
          "table values and executable source text stay in R",
        );
      }
      responseCount++;
      return expectedError ? response : response.data;
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
      const contractFile = join(root, "sample.contract.yaml");
      const contract = await request({
        operation: "validate_contract",
        file_path: contractFile,
      });
      assert.equal(contract.id, "sample.contract");
      assert.equal(contract.version, "1.0.0");
      assert.deepEqual(
        contract.columns.map(({ name, type }) => ({ name, type })),
        [
          { name: "amount", type: "numeric" },
          { name: "claimant", type: "character" },
        ],
      );
      const twoRows = await request({
        operation: "sample_quality",
        handle: "binding:sample_rows",
        file_path: contractFile,
        row_limit: 2,
      });
      const failure = twoRows.items.find((x) => x.rule === "nonnegative");
      assert.ok(failure, "the exported explicit quality rule is executed");
      assert.equal(failure.status, "failed");
      assert.equal(failure.n_total, 2);
      assert.equal(
        failure.n_failed,
        1,
        "the third failing row is outside the requested sample",
      );
      assert.equal(twoRows.truncated, false);
      const oneRow = await request({
        operation: "sample_quality",
        handle: "binding:sample_rows",
        file_path: contractFile,
        row_limit: 1,
      });
      const passed = oneRow.items.find((x) => x.rule === "nonnegative");
      assert.equal(passed.status, "passed");
      assert.equal(passed.n_total, 1);
      assert.equal(passed.n_failed, 0);
      assert.ok(!oneRow.items.some((x) => x.status === "failed"));

      await request(
        { operation: "product", handle: "result:unavailable-opaque-handle" },
        "not_found",
      );
      const recovered = await request({
        operation: "product",
        handle: trial.handle,
      });
      assert.equal(
        recovered.handle,
        trial.handle,
        "a structured handle error does not lose retained results or end the R session",
      );
      await request(
        {
          operation: "validate_contract",
          file_path: join(root, "invalid.contract.yaml"),
        },
        "execution_failed",
      );
      const recoveredContract = await request({
        operation: "validate_contract",
        file_path: contractFile,
      });
      assert.deepEqual(
        recoveredContract,
        contract,
        "unsafe ODCS is rejected without poisoning subsequent validation",
      );

      const diagnosticTrial = await request({
        operation: "trial",
        handle: "binding:diagnostic_product",
      });
      assert.equal(diagnosticTrial.status, "blocked");
      const diagnostics = await request({
        version: 2,
        operation: "diagnostics",
        handle: diagnosticTrial.handle,
      });
      assert.equal(
        diagnostics.items.length,
        1,
        "actual sourced function supplies one verified location",
      );
      const source = diagnostics.items[0];
      assert.equal(source.rule, "positive");
      assert.equal(source.status, "failed");
      assert.equal(source.severity, "error");
      assert.equal(source.path, join(root, "rule-source.R"));
      const original = await readFile(source.path);
      assert.equal(
        source.file_hash,
        createHash("sha256").update(original).digest("hex"),
      );
      assert.equal(source.start.line, 1);
      assert.equal(source.end.line, 1);
      assert.equal(source.start.character, "positive <- ".length);
      assert.equal(
        source.end.character,
        original.toString("utf8").split("\n")[1].length,
      );
      await writeFile(
        source.path,
        Buffer.concat([original, Buffer.from("# changed after trial\n")]),
      );
      const staleDiagnostics = await request({
        version: 2,
        operation: "diagnostics",
        handle: diagnosticTrial.handle,
      });
      assert.equal(
        staleDiagnostics.items.length,
        0,
        "changed source has no stale markers",
      );

      await send("UPDATE_WORKSPACE");
      const changed = await request({ operation: "products" });
      assert.ok(
        changed.items.some((x) => x.id === "orders.changed"),
        "the next request observes a changed binding",
      );
      assert.equal(
        responseCount,
        28,
        "25 existing responses plus sourced-rule trial, v2 diagnostics and stale-source rejection",
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
