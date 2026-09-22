const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const { tmpdir } = require("node:os");
const { createHash } = require("node:crypto");
const {
  harness,
  deferred,
  session,
  empty,
} = require("./controller-harness.cjs");
const hash = (text) => createHash("sha256").update(text).digest("hex");
const uri = (file) => ({ scheme: "file", fsPath: file, toString: () => file });
const result = () => ({
  product: structuredClone(require("./fixtures/trial.json").data.result),
});
async function setup(t) {
  const h = await harness(t);
  h.root = await fs.mkdtemp(path.join(tmpdir(), "dataraft-source-"));
  t.after(() => fs.rm(h.root, { recursive: true, force: true }));
  h.file = path.join(h.root, "rules.R");
  h.text = "# 😀 Unicode\npositive <- function(data) data$x > 0\n";
  await fs.writeFile(h.file, h.text);
  h.workspace.workspaceFolders = [{ uri: uri(h.root) }];
  h.location = {
    rule: "positive",
    status: "failed",
    severity: "error",
    path: h.file,
    file_hash: hash(h.text),
    start: { line: 1, character: 12 },
    end: { line: 1, character: 38 },
  };
  h.location.end.character = h.text.split("\n")[1].length;
  h.respond = (req) =>
    req.operation === "diagnostics"
      ? { items: [h.location], truncated: false }
      : empty;
  h.markers = h.diagnosticCollections.get("dataraft-r-rules");
  await h.command("selectSession");
  return h;
}
function document(file, text, dirty = false) {
  return {
    uri: uri(file),
    isDirty: dirty,
    getText: () => text,
    positionAt: (offset) => {
      const lines = text.slice(0, offset).split("\n");
      return { line: lines.length - 1, character: lines.at(-1).length };
    },
    offsetAt: (position) =>
      text
        .split("\n")
        .slice(0, position.line)
        .reduce((n, line) => n + line.length + 1, 0) + position.character,
  };
}

test("verified sources require matching bytes, canonical workspace containment and clean editor content", async (t) => {
  const h = await setup(t),
    { verifiedSource } = h.diagnostics;
  assert.equal(
    (await verifiedSource(h.file, hash(h.text), [h.root], [])).path,
    await fs.realpath(h.file),
  );
  assert.equal(
    await verifiedSource(h.file, "0".repeat(64), [h.root], []),
    undefined,
  );
  assert.equal(await verifiedSource(h.file, hash(h.text), [], []), undefined);
  assert.equal(
    await verifiedSource(
      h.file,
      hash(h.text),
      [h.root],
      [{ path: h.file, dirty: true, text: h.text }],
    ),
    undefined,
  );
  assert.equal(
    await verifiedSource(
      h.file,
      hash(h.text),
      [h.root],
      [{ path: h.file, dirty: false, text: h.text + "# stale" }],
    ),
    undefined,
  );
  assert.equal(await verifiedSource(h.root, hash(""), [h.root], []), undefined);
  assert.equal(
    await verifiedSource("rules.R", hash(h.text), [h.root], []),
    undefined,
  );
  const sibling = h.root + "-outside";
  await fs.mkdir(sibling);
  t.after(() => fs.rm(sibling, { recursive: true, force: true }));
  const outside = path.join(sibling, "private.R");
  await fs.writeFile(outside, h.text);
  const link = path.join(h.root, "escape.R");
  await fs.symlink(outside, link);
  assert.equal(
    await verifiedSource(outside, hash(h.text), [h.root], []),
    undefined,
  );
  assert.equal(
    await verifiedSource(link, hash(h.text), [h.root], []),
    undefined,
  );
  assert.equal(
    await verifiedSource(
      path.join(h.root, "..", path.basename(sibling), "private.R"),
      hash(h.text),
      [h.root],
      [],
    ),
    undefined,
  );
});

test("source size, UTF8 validity and UTF16 positions fail closed", async (t) => {
  const h = await setup(t),
    { verifiedSource, validSourceRange } = h.diagnostics;
  await fs.writeFile(h.file, Buffer.alloc(1048577, 120));
  assert.equal(
    await verifiedSource(
      h.file,
      hash(Buffer.alloc(1048577, 120)),
      [h.root],
      [],
    ),
    undefined,
  );
  await fs.writeFile(h.file, Buffer.from([0xff]));
  assert.equal(
    await verifiedSource(h.file, hash(Buffer.from([0xff])), [h.root], []),
    undefined,
  );
  const text = "a😀b\r\nnext";
  assert.equal(
    validSourceRange(
      text,
      { line: 0, character: 1 },
      { line: 0, character: 3 },
    ),
    true,
  );
  for (const [start, end] of [
    [
      { line: 0, character: 2 },
      { line: 0, character: 3 },
    ],
    [
      { line: 0, character: 1 },
      { line: 0, character: 2 },
    ],
    [
      { line: 0, character: 3 },
      { line: 0, character: 1 },
    ],
    [
      { line: 0, character: 0 },
      { line: 2, character: 0 },
    ],
    [
      { line: -1, character: 0 },
      { line: 0, character: 0 },
    ],
    [
      { line: 0, character: 0 },
      { line: 0, character: 5 },
    ],
  ])
    assert.equal(validSourceRange(text, start, end), false);
});

test("explicit result diagnostics opt into v2, map severity and clear on source edits", async (t) => {
  const h = await setup(t);
  await h.command("showRuleDiagnostics", result());
  const request = h.requests.at(-1);
  assert.equal(request.version, 2);
  assert.equal(request.operation, "diagnostics");
  assert.equal(request.handle, result().product.handle);
  assert.equal("context" in request, false, "v2 accepts no v1 context field");
  assert.equal("row_limit" in request, false);
  const diagnostic = h.markers.get(await fs.realpath(h.file))[0];
  assert.deepEqual(diagnostic.range.start, h.location.start);
  assert.equal(diagnostic.severity, 0);
  assert.equal(diagnostic.message, "DataRaft rule positive: failed.");
  h.documentChanges.forEach((fn) =>
    fn({ document: document(h.file, h.text, true) }),
  );
  assert.equal(h.markers.size, 0);
  h.location.severity = "warning";
  h.location.status = "warning";
  await h.command("showRuleDiagnostics", result());
  assert.equal(h.markers.get(await fs.realpath(h.file))[0].severity, 1);
  h.watchers.at(-1).change();
  assert.equal(h.markers.size, 0);
});

test("dirty buffers, edited files and unretained results never receive markers", async (t) => {
  const h = await setup(t);
  h.workspace.textDocuments = [document(h.file, h.text, true)];
  await h.command("showRuleDiagnostics", result());
  assert.equal(h.markers.size, 0);
  assert.match(h.information.at(-1), /1 location\(s\) omitted/);
  h.workspace.textDocuments = [];
  await fs.writeFile(h.file, h.text + "# modified");
  await h.command("showRuleDiagnostics", result());
  assert.equal(h.markers.size, 0);
  const previous = h.requests.length;
  const unretained = result();
  unretained.product.handle = "binding:result";
  await h.command("showRuleDiagnostics", unretained);
  assert.equal(h.requests.length, previous);
  assert.match(h.errors.at(-1), /retained trial result/);
});

test("refresh and session switches clear diagnostics and discard pending responses", async (t) => {
  const h = await setup(t);
  await h.command("showRuleDiagnostics", result());
  assert.equal(h.markers.size, 1);
  await h.command("refresh");
  assert.equal(h.markers.size, 0);
  const started = deferred(),
    finish = deferred();
  h.respond = async () => {
    started.resolve();
    await finish.promise;
    return { items: [h.location], truncated: false };
  };
  const showing = h.command("showRuleDiagnostics", result());
  await started.promise;
  h.sessions = [session("R-2")];
  await h.command("selectSession");
  finish.resolve();
  await showing;
  assert.equal(h.markers.size, 0);
});

test("older bridge diagnostics errors explain upgrade while v1 refresh remains usable", async (t) => {
  const h = await setup(t);
  h.envelope = (req, data) => ({
    contract: 1,
    generated: "2026-09-22T00:00:00Z",
    request_id: req.request_id,
    kind: req.operation === "diagnostics" ? "error" : req.operation,
    data: req.operation === "diagnostics" ? null : data,
    error:
      req.operation === "diagnostics"
        ? { code: "invalid_request", message: "Invalid IDE request." }
        : null,
  });
  await h.command("showRuleDiagnostics", result());
  assert.match(h.errors.at(-1), /protocol v2.*Update/);
  await h.command("refresh");
  assert.ok(h.requests.slice(-5).every((req) => req.version === 1));
  assert.equal(h.errors.length, 1);
});
