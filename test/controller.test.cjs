const { test } = require("node:test");
const assert = require("node:assert/strict");
const Module = require("node:module");
const fs = require("node:fs/promises");
const originalLoad = Module._load;
const disposable = { dispose() {} };
const deferred = () => {
  let resolve;
  const promise = new Promise((r) => (resolve = r));
  return { promise, resolve };
};
test("real controller discards old context responses and does not execute busy or untrusted R", async () => {
  const commands = new Map(),
    views = new Map(),
    errors = [],
    picked = [];
  let busy = false,
    trusted = true,
    dispatches = 0,
    blocked;
  const mock = {
    EventEmitter: class {
      event = () => disposable;
      fire() {}
      dispose() {}
    },
    ThemeIcon: class {},
    ThemeColor: class {},
    TreeItem: class {},
    TreeItemCollapsibleState: { Collapsed: 1, None: 0 },
    ProgressLocation: { Notification: 15 },
    Uri: { from: (o) => o },
    languages: {
      createDiagnosticCollection: () => ({
        set() {},
        delete() {},
        dispose() {},
      }),
    },
    workspace: {
      get isTrusted() {
        return trusted;
      },
      getConfiguration: () => ({ get: (_k, d) => d }),
      onDidGrantWorkspaceTrust: () => disposable,
      registerTextDocumentContentProvider: () => disposable,
      onDidCloseTextDocument: () => disposable,
      onDidChangeTextDocument: () => disposable,
      onDidSaveTextDocument: () => disposable,
    },
    window: {
      createTreeView: (id, opt) => {
        const v = { ...disposable, tree: opt.treeDataProvider };
        views.set(id, v);
        return v;
      },
      registerCustomEditorProvider: () => disposable,
      showQuickPick: async (choices) => picked.shift()?.(choices) ?? choices[0],
      showErrorMessage: (e) => {
        errors.push(e);
      },
      withProgress: (_o, fn) =>
        fn({}, { onCancellationRequested: () => disposable }),
    },
    commands: {
      registerCommand: (name, fn) => {
        commands.set(name, fn);
        return disposable;
      },
      executeCommand: async () => {},
    },
  };
  const session = {
    metadata: { sessionId: "R-1", sessionMode: "console" },
    runtimeMetadata: { languageId: "r", runtimeName: "R" },
    getRuntimeState: () => (busy ? "busy" : "idle"),
  };
  global.acquirePositronApi = () => ({
    runtime: {
      getActiveSessions: async () => [session],
      executeCode: async (...args) => {
        dispatches++;
        assert.equal(args[7], "R-1");
        const req = JSON.parse(
          Buffer.from(args[1].match(/"([^"]+)"/)[1], "base64"),
        );
        if (blocked) {
          const gate = blocked;
          blocked = null;
          gate.started.resolve();
          await gate.finish.promise;
        }
        const value = {
          contract: 1,
          generated: "2026-09-22T00:00:00Z",
          request_id: req.request_id,
          kind: req.operation,
          error: null,
          data: {
            items:
              req.operation === "contexts"
                ? [{ handle: "lake:two", label: "Second lake", kind: "lake" }]
                : [],
            truncated: false,
          },
        };
        await fs.writeFile(req.response_path + ".tmp", JSON.stringify(value));
        await fs.rename(req.response_path + ".tmp", req.response_path);
      },
    },
  });
  Module._load = function (name, ...args) {
    return name === "vscode" ? mock : originalLoad.call(this, name, ...args);
  };
  let activate;
  try {
    ({ activate } = require("../dist/extension"));
  } finally {
    Module._load = originalLoad;
  }
  const context = { subscriptions: [] };
  activate(context);
  try {
    await commands.get("dataraft.selectSession")();
    busy = true;
    await commands.get("dataraft.refresh")();
    assert.equal(dispatches, 0);
    assert.ok(errors.length);
    busy = false;
    trusted = false;
    await commands.get("dataraft.refresh")();
    assert.equal(dispatches, 0);
    trusted = true;
    const gate = { started: deferred(), finish: deferred() };
    blocked = gate;
    const refresh = commands.get("dataraft.refresh")();
    await gate.started.promise;
    await commands.get("dataraft.selectSession")();
    gate.finish.resolve();
    await refresh;
    assert.equal(dispatches, 1);
    assert.equal(views.get("dataraft.products").tree.roots.length, 0);
    assert.match(views.get("dataraft.products").message, /selected/);
    await commands.get("dataraft.selectContext")();
    assert.equal(dispatches, 7);
    assert.match(views.get("dataraft.products").message, /Second lake/);
  } finally {
    for (const item of context.subscriptions) item.dispose();
    delete global.acquirePositronApi;
  }
});
