// Separate process: install the filesystem fault before Node lazily loads rimraf.
const assert = require("node:assert/strict");
const native = require("node:fs");
const fs = require("node:fs/promises");
const { dirname } = require("node:path");
const original = native.rmdir;
let attempts = 0,
  responsePath;
native.rmdir = function (path, ...args) {
  const callback = args.at(-1);
  if (String(path).includes("dataraft-ide-") && ++attempts <= 2) {
    // Model a late writer making the directory nonempty on both the initial
    // removal and rimraf's first child cleanup, without timing dependencies.
    const error = Object.assign(new Error("late atomic writer"), {
      code: "ENOTEMPTY",
    });
    queueMicrotask(() => callback(error));
    return;
  }
  return original.call(this, path, ...args);
};
const { BridgeTransport } = require("../dist/transport");
const bridge = new BridgeTransport(async (code) => {
  const req = JSON.parse(Buffer.from(code.match(/"([^"]+)"/)[1], "base64"));
  responsePath = req.response_path;
  await fs.writeFile(
    req.response_path + ".tmp",
    JSON.stringify({
      contract: 1,
      generated: "2026-09-22T00:00:00Z",
      kind: req.operation,
      request_id: req.request_id,
      data: { items: [], truncated: false },
      error: null,
    }),
  );
  await fs.rename(req.response_path + ".tmp", req.response_path);
}, 1000);
(async () => {
  try {
    assert.equal(
      (await bridge.request("R", { operation: "products" })).kind,
      "products",
    );
    assert.ok(
      attempts >= 3,
      "cleanup must recover from both transient directory failures",
    );
    await assert.rejects(fs.stat(dirname(responsePath)), { code: "ENOENT" });
  } finally {
    bridge.dispose();
    native.rmdir = original;
    if (responsePath)
      await fs.rm(dirname(responsePath), { recursive: true, force: true });
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
