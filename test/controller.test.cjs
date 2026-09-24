const { test } = require("node:test");
const assert = require("node:assert/strict");
const {
  harness,
  deferred,
  session,
  empty,
} = require("./controller-harness.cjs");
const fixture = (name) =>
  structuredClone(require("./fixtures/" + name + ".json").data);

test("session picker includes only R consoles and cancelling preserves prior selection", async (t) => {
  const h = await harness(t);
  h.sessions = [
    session("Python", "python"),
    session("Notebook", "r", "notebook"),
    session("R-console", "R"),
  ];
  h.picks.push(() => undefined);
  await h.command("selectSession");
  assert.deepEqual(
    h.choices[0].map((x) => x.description),
    ["R-console"],
  );
  await h.command("refresh");
  assert.match(h.errors.at(-1), /Select an existing R console/);
  assert.equal(h.requests.length, 0);
  await h.command("selectSession");
  h.picks.push(() => undefined);
  await h.command("selectSession");
  await h.command("refresh");
  assert.equal(h.requests.length, 5);
  assert.ok(h.requests.every((req) => req.sessionId === "R-console"));
});

test("missing, busy and untrusted sessions never execute; ready session recovers", async (t) => {
  const h = await harness(t);
  await h.command("selectSession");
  h.sessions = [];
  await h.command("refresh");
  assert.match(h.errors.at(-1), /no longer available/);
  h.sessions = [session("R-1", "r", "console", "busy")];
  await h.command("refresh");
  assert.match(h.errors.at(-1), /busy/);
  h.trusted = false;
  await h.command("refresh");
  assert.match(h.errors.at(-1), /Trust this workspace/);
  assert.equal(h.requests.length, 0);
  h.trusted = true;
  h.sessions = [session("R-1", "r", "console", "ready")];
  await h.command("refresh");
  assert.equal(h.requests.length, 5);
});

test("refresh waits for Ark to become idle between completed metadata responses", async (t) => {
  const h = await harness(t);
  let busy = false;
  h.sessions = [{ ...session(), getRuntimeState: () => busy ? "busy" : "idle" }];
  h.respond = (req) => {
    if (req.operation === "products") {
      busy = true;
      setTimeout(() => { busy = false; }, 50);
    }
    return empty;
  };
  await h.command("selectSession");
  await h.command("refresh");
  assert.equal(h.requests.length, 5);
  assert.deepEqual(h.errors, []);
});

test("controller discards in-flight response after session selection changes", async (t) => {
  const h = await harness(t),
    started = deferred(),
    finish = deferred();
  await h.command("selectSession");
  h.respond = async () => {
    started.resolve();
    await finish.promise;
    return empty;
  };
  const request = h.command("refresh");
  await started.promise;
  h.sessions = [session("R-2")];
  await h.command("selectSession");
  finish.resolve();
  await request;
  assert.equal(h.requests.length, 1);
  assert.equal(h.views.get("dataraft.products").tree.roots.length, 0);
  assert.match(h.views.get("dataraft.products").message, /R-2 selected/);
});

test("cancelled context selection does not switch context or trigger refresh", async (t) => {
  const h = await harness(t);
  await h.command("selectSession");
  h.picks.push(() => undefined);
  await h.command("selectContext");
  assert.deepEqual(
    h.requests.map((r) => r.operation),
    ["contexts"],
  );
  await h.command("refresh");
  assert.ok(h.requests.every((r) => r.context === "workspace"));
  await h.command("selectContext");
  assert.ok(h.requests.slice(-5).every((r) => r.context === "lake"));
});

test("explicit trial adds retained result and View sends opaque handle with configured bound", async (t) => {
  const h = await harness(t);
  await h.command("selectSession");
  const trial = fixture("trial");
  trial.status = trial.result.status = "completed";
  trial.result.can_view = true;
  h.respond = (req) =>
    req.operation === "trial"
      ? trial
      : { handle: req.handle, status: "viewed" };
  const product = fixture("product");
  await h.command("trial", { product });
  assert.equal(h.requests[0].operation, "trial");
  assert.equal(h.requests[0].handle, product.handle);
  assert.equal(h.requests[0].limit, 9);
  assert.equal(
    h.views.get("dataraft.products").tree.roots[0].product.handle,
    trial.handle,
  );
  await h.command("view", { product: trial.result });
  assert.equal(h.requests[1].operation, "view");
  assert.equal(h.requests[1].handle, trial.handle);
  assert.equal(h.requests[1].row_limit, 7);
  assert.equal(
    h.documents.length,
    0,
    "trial and View never open raw JSON or transfer data rows",
  );
  assert.match(
    h.panels.at(-1).webview.html,
    /Trial result|Trial: completed|Data product/,
  );
});

test("ineligible and cancelled product selections do not run trial or View", async (t) => {
  const h = await harness(t);
  await h.command("selectSession");
  h.picks.push(
    () => undefined,
    () => undefined,
  );
  await h.command("trial");
  await h.command("view");
  const product = { ...fixture("product"), can_trial: false, can_view: false };
  await h.command("trial", { product });
  await h.command("view", { product });
  assert.equal(h.requests.length, 0);
  assert.equal(h.errors.length, 2);
});

test("failed refresh is reported and later refresh replaces stale metadata", async (t) => {
  const h = await harness(t);
  await h.command("selectSession");
  h.respond = () => {
    throw new Error("private runtime failure");
  };
  await h.command("refresh");
  assert.match(h.errors.at(-1), /Positron rejected/);
  assert.ok(!h.errors.at(-1).includes("private runtime failure"));
  assert.match(h.views.get("dataraft.products").message, /may be stale/);
  h.respond = (req) =>
    req.operation === "products" ? fixture("products") : empty;
  await h.command("refresh");
  assert.ok(h.views.get("dataraft.products").tree.roots.length > 0);
  assert.match(h.views.get("dataraft.products").message, /Manual refresh only/);
});

test("session switch prevents already queued Trial from executing in the previous session", async (t) => {
  const h = await harness(t),
    started = deferred(),
    finish = deferred(),
    queued = deferred();
  await h.command("selectSession");
  h.respond = async (req) => {
    if (req.operation === "products") {
      started.resolve();
      await finish.promise;
      return empty;
    }
    return fixture("trial");
  };
  const refreshing = h.command("refresh");
  await started.promise;
  h.onProgress = (title) => {
    if (title === "DataRaft: trial") queued.resolve();
  };
  const trial = h.command("trial", { product: fixture("product") });
  await queued.promise;
  h.sessions = [session("R-1"), session("R-2")];
  h.picks.push((choices) => choices.find((x) => x.description === "R-2"));
  await h.command("selectSession");
  finish.resolve();
  await Promise.all([refreshing, trial]);
  assert.deepEqual(
    h.requests.map((req) => req.operation),
    ["products"],
  );
  assert.equal(h.views.get("dataraft.products").tree.roots.length, 0);
});

test("session switch during runtime lookup rejects the old Trial before dispatch", async (t) => {
  const h = await harness(t),
    started = deferred(),
    finish = deferred();
  await h.command("selectSession");
  h.getSessions = async () => {
    started.resolve();
    await finish.promise;
    return [session("R-1")];
  };
  const trial = h.command("trial", { product: fixture("product") });
  await started.promise;
  h.getSessions = undefined;
  h.sessions = [session("R-2")];
  await h.command("selectSession");
  finish.resolve();
  await trial;
  assert.equal(h.requests.length, 0);
  assert.match(h.errors.at(-1), /Session or context changed/);
});

test("session switch before progress callback starts rejects the old Trial", async (t) => {
  const h = await harness(t),
    started = deferred(),
    finish = deferred();
  await h.command("selectSession");
  h.progressGate = finish;
  h.onProgress = () => started.resolve();
  const trial = h.command("trial", { product: fixture("product") });
  await started.promise;
  h.sessions = [session("R-2")];
  await h.command("selectSession");
  finish.resolve();
  await trial;
  assert.equal(h.requests.length, 0);
  assert.match(h.errors.at(-1), /Session or context changed/);
});

test("lineage panels release listeners on close and all remaining panels on deactivation", async (t) => {
  const h = await harness(t);
  await h.command("selectSession");
  const originalRespond = h.respond;
  h.respond = (req) =>
    req.operation === "lineage" ? fixture("lineage") : originalRespond(req);
  for (let i = 0; i < 10; i++) {
    await h.command("lineage");
    const panel = h.panels.at(-1);
    assert.equal(panel.messages.size, 1);
    panel.dispose();
    assert.equal(panel.messages.size, 0);
    assert.equal(panel.closed.size, 0);
  }
  await h.command("lineage");
  await h.command("lineage");
  assert.equal(h.errors.length, 0);
  h.dispose();
  for (const panel of h.panels) {
    assert.equal(panel.disposed, true);
    assert.equal(panel.messages.size, 0);
    assert.equal(panel.closed.size, 0);
  }
});

test("deactivation while lineage is pending never opens a late panel", async (t) => {
  const h = await harness(t);
  await h.command("selectSession");
  const started = deferred(),
    finish = deferred(),
    originalRespond = h.respond;
  h.respond = async (req) => {
    if (req.operation !== "lineage") return originalRespond(req);
    started.resolve();
    await finish.promise;
    return fixture("lineage");
  };
  const command = h.command("lineage");
  await started.promise;
  h.dispose();
  finish.resolve();
  await command;
  assert.equal(h.panels.length, 0);
});
