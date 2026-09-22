const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const { join, dirname } = require("node:path");
const { tmpdir } = require("node:os");
const { BridgeTransport } = require("../dist/transport");
const { validateEnvelope, rBridgeCode } = require("../dist/protocol");
const { lineageHtml, escapeHtml } = require("../dist/render");
const response = (
  req,
  kind = req.operation,
  data = { items: [], truncated: false },
) => ({
  contract: 1,
  generated: "2026-09-22T12:00:00Z",
  kind,
  request_id: req.request_id,
  data,
  error: null,
});
const decode = (code) =>
  JSON.parse(
    Buffer.from(
      code.match(/^dataraft\.ide::ide_request\("([A-Za-z0-9+/=]+)"\)$/)[1],
      "base64",
    ).toString(),
  );
const atomic = async (req, value = response(req)) => {
  await fs.writeFile(req.response_path + ".tmp", JSON.stringify(value));
  await fs.rename(req.response_path + ".tmp", req.response_path);
};
const deferred = () => {
  let resolve;
  const promise = new Promise((r) => (resolve = r));
  return { promise, resolve };
};
test("opaque handles roundtrip without becoming R code", () => {
  const handle = 'binding:x\");system("bad") #\n雪';
  const req = {
    version: 1,
    request_id: "id",
    response_path: "/tmp/private/response.json",
    operation: "product",
    handle,
  };
  assert.deepEqual(decode(rBridgeCode(req)), req);
  assert.throws(
    () => rBridgeCode({ ...req, handle: "x".repeat(17000) }),
    /16 KiB/,
  );
});
test("strict envelope rejects version drift, wrong types and extra data", () => {
  const req = { operation: "products", request_id: "id" },
    good = response(req);
  assert.deepEqual(validateEnvelope(good), good);
  for (const value of [
    { ...good, contract: "1" },
    { ...good, raw_rows: [] },
    { ...good, data: { items: [], truncated: "false" } },
    { ...good, generated: "yesterday" },
    { ...good, data: { items: [], truncated: false, secret: "x" } },
  ])
    assert.throws(() => validateEnvelope(value), /Invalid/);
  assert.throws(
    () => validateEnvelope(good, { requestId: "other", operation: "products" }),
    /match/,
  );
});
test("schema accepts all R checked-in response fixtures", async () => {
  const names = await fs.readdir(join(__dirname, "fixtures"));
  for (const name of names.filter((n) => n.endsWith(".json")))
    validateEnvelope(
      JSON.parse(await fs.readFile(join(__dirname, "fixtures", name), "utf8")),
    );
});
test("atomic rename wakes reader after executeCode acknowledged; private directory removed", async () => {
  let path;
  const bridge = new BridgeTransport((code) => {
    const req = decode(code);
    path = req.response_path;
    setTimeout(async () => {
      assert.equal((await fs.stat(dirname(path))).mode & 0o777, 0o700);
      await atomic(req);
    }, 15);
    return Promise.resolve({ ignored: "not an R value" });
  }, 500);
  const result = await bridge.request("R", { operation: "products" });
  assert.equal(result.contract, 1);
  await assert.rejects(fs.stat(dirname(path)), { code: "ENOENT" });
  bridge.dispose();
});
test("requests serialize until prior response completes", async () => {
  const first = deferred(),
    started = deferred();
  let active = 0,
    max = 0,
    calls = 0;
  const bridge = new BridgeTransport(async (code) => {
    active++;
    max = Math.max(active, max);
    const req = decode(code);
    calls++;
    if (calls === 1) {
      started.resolve();
      await first.promise;
    }
    await atomic(req);
    active--;
  }, 500);
  const a = bridge.request("R", { operation: "products" });
  await started.promise;
  const b = bridge.request("R", { operation: "contexts" });
  assert.equal(calls, 1);
  first.resolve();
  await Promise.all([a, b]);
  assert.equal(max, 1);
  bridge.dispose();
});
test("stale request IDs, oversized files, symlinks and malformed JSON fail closed", async () => {
  for (const mode of ["stale", "large", "symlink", "json"]) {
    const bridge = new BridgeTransport(async (code) => {
      const req = decode(code);
      if (mode === "stale")
        await atomic(req, { ...response(req), request_id: "stale" });
      if (mode === "large") {
        await fs.writeFile(req.response_path + ".tmp", "x".repeat(1048577));
        await fs.rename(req.response_path + ".tmp", req.response_path);
      }
      if (mode === "symlink") {
        await fs.writeFile(
          req.response_path + ".target",
          JSON.stringify(response(req)),
        );
        await fs.symlink(req.response_path + ".target", req.response_path);
      }
      if (mode === "json") {
        await fs.writeFile(req.response_path + ".tmp", "{");
        await fs.rename(req.response_path + ".tmp", req.response_path);
      }
    }, 500);
    await assert.rejects(
      bridge.request("R", { operation: "products" }),
      /match|Unsafe|oversized|JSON/,
    );
    bridge.dispose();
  }
});
test("timeout clears response directory without interrupting R", async () => {
  let path;
  const bridge = new BridgeTransport((code) => {
    path = decode(code).response_path;
  }, 20);
  await assert.rejects(
    bridge.request("R", { operation: "products" }),
    /timed out/,
  );
  await assert.rejects(fs.stat(dirname(path)), { code: "ENOENT" });
  bridge.dispose();
});
test("cancelled queued request never dispatches", async () => {
  const gate = deferred(),
    started = deferred();
  let calls = 0;
  const bridge = new BridgeTransport(async (code) => {
    calls++;
    started.resolve();
    await gate.promise;
    await atomic(decode(code));
  }, 500);
  const a = bridge.request("R", { operation: "products" });
  await started.promise;
  const controller = new AbortController();
  const b = bridge.request("R", { operation: "products" }, controller.signal);
  controller.abort();
  const rejection = assert.rejects(b, /cancelled/);
  gate.resolve();
  await a;
  await rejection;
  assert.equal(calls, 1);
  bridge.dispose();
});
test("disposal cancels active and queued work and future requests", async () => {
  const started = deferred();
  let calls = 0;
  const bridge = new BridgeTransport(() => {
    calls++;
    started.resolve();
  }, 500);
  const a = bridge.request("R", { operation: "products" });
  await started.promise;
  const b = bridge.request("R", { operation: "products" });
  const aa = assert.rejects(a, /cancelled/),
    bb = assert.rejects(b, /disposed/);
  bridge.dispose();
  await Promise.all([aa, bb]);
  assert.equal(calls, 1);
  await assert.rejects(
    bridge.request("R", { operation: "products" }),
    /disposed/,
  );
});
test("lineage HTML escapes labels, supplies directed edges and keyboard focus", () => {
  const evil = "</script><img src=x onerror=alert(1)>";
  const html = lineageHtml(
    {
      nodes: [
        { id: evil, kind: "product" },
        { id: "b", kind: "asset" },
      ],
      edges: [{ from: evil, to: "b", relation: "uses" }],
      truncated: false,
    },
    "2026-09-22T00:00:00Z",
    "nonce",
  );
  assert.ok(!html.includes(evil));
  assert.match(html, /&lt;\/script&gt;/);
  assert.match(html, /default-src 'none'/);
  assert.match(html, /marker-end/);
  assert.match(html, /tabindex="0"/);
  assert.match(html, /keydown/);
  assert.equal(escapeHtml("\"'&<>"), "&quot;&#39;&amp;&lt;&gt;");
});

test("deadline performs one final read if a filesystem notification is lost", async () => {
  const native = require("node:fs");
  const original = native.watch;
  const { EventEmitter } = require("node:events");
  native.watch = () => Object.assign(new EventEmitter(), { close() {} });
  const bridge = new BridgeTransport((code) => {
    const req = decode(code);
    setTimeout(() => atomic(req), 10);
  }, 60);
  try {
    assert.equal(
      (await bridge.request("R", { operation: "products" })).kind,
      "products",
    );
  } finally {
    bridge.dispose();
    native.watch = original;
  }
});

test("canonical schema rejects per-kind additions and preserves nullable metadata", async () => {
  for (const name of (await fs.readdir(join(__dirname, "fixtures"))).filter(
    (n) => n.endsWith(".json"),
  )) {
    const value = JSON.parse(
      await fs.readFile(join(__dirname, "fixtures", name), "utf8"),
    );
    const extra = structuredClone(value);
    if (extra.data) extra.data.unexpected = true;
    else extra.error.unexpected = true;
    assert.throws(() => validateEnvelope(extra), /Invalid/, name);
  }
  const profile = response(
    { operation: "profile", request_id: "x" },
    "profile",
    {
      id: null,
      version: null,
      columns: [{ name: "unknown", type: null, required: false }],
      key: [],
    },
  );
  validateEnvelope(profile);
  const product = JSON.parse(
    await fs.readFile(join(__dirname, "fixtures", "product.json"), "utf8"),
  );
  product.data.contract = profile.data;
  validateEnvelope(product);
  const wrongError = response({ operation: "products", request_id: "x" });
  wrongError.data = null;
  wrongError.error = { code: "error", message: "redacted" };
  assert.throws(() => validateEnvelope(wrongError), /Invalid/);
  assert.throws(
    () =>
      validateEnvelope(
        response({ operation: "view", request_id: "x" }, "view", {
          handle: "binding:x",
          status: "published",
        }),
      ),
    /Invalid/,
  );
});
