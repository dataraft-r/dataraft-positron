const assert = require("node:assert/strict");
const Module = require("node:module");
const fs = require("node:fs/promises");
const path = require("node:path");
const disposable = { dispose() {} };
const deferred = () => {
  let resolve;
  const promise = new Promise((r) => {
    resolve = r;
  });
  return { promise, resolve };
};
const session = (
  id = "R-1",
  language = "r",
  mode = "console",
  state = "idle",
) => ({
  metadata: { sessionId: id, sessionMode: mode },
  runtimeMetadata: { languageId: language, runtimeName: id },
  getRuntimeState: () => state,
});
const empty = { items: [], truncated: false };
async function harness(t) {
  const originalLoad = Module._load;
  const originalApi = Object.getOwnPropertyDescriptor(
    global,
    "acquirePositronApi",
  );
  const local = (filename) =>
    filename.startsWith(path.resolve(__dirname, "../dist") + path.sep);
  const savedModules = Object.entries(require.cache).filter(([name]) =>
    local(name),
  );
  for (const [name] of savedModules) delete require.cache[name];
  const h = {
    panels: [],
    diagnosticCollections: new Map(),
    documentChanges: [],
    watchers: [],
    information: [],
    commands: new Map(),
    views: new Map(),
    errors: [],
    picks: [],
    requests: [],
    documents: [],
    choices: [],
    sessions: [session()],
    trusted: true,
    config: { maximumRows: 7, maximumItems: 9 },
    respond: (req) =>
      req.operation === "contexts"
        ? {
            items: [{ handle: "lake", label: "Lake", kind: "lake" }],
            truncated: false,
          }
        : empty,
  };
  const mock = {
    EventEmitter: class {
      event = () => disposable;
      fire() {}
      dispose() {}
    },
    ThemeIcon: class {
      constructor(id, color) {
        this.id = id;
        this.color = color;
      }
    },
    ThemeColor: class {
      constructor(id) {
        this.id = id;
      }
    },
    TreeItem: class {},
    TreeItemCollapsibleState: { Collapsed: 1, None: 0 },
    ProgressLocation: { Notification: 15 },
    ViewColumn: { Beside: 2 },
    Uri: {
      from: (value) => value,
      file: (value) => ({
        scheme: "file",
        fsPath: value,
        toString: () => value,
      }),
    },
    Range: class {
      constructor(startLine, startCharacter, endLine, endCharacter) {
        this.start = { line: startLine, character: startCharacter };
        this.end = { line: endLine, character: endCharacter };
      }
    },
    Diagnostic: class {
      constructor(range, message, severity) {
        Object.assign(this, { range, message, severity });
      }
    },
    DiagnosticSeverity: { Error: 0, Warning: 1 },
    RelativePattern: class {
      constructor(base, pattern) {
        Object.assign(this, { base, pattern });
      }
    },
    languages: {
      createDiagnosticCollection: (name) => {
        const values = new Map();
        h.diagnosticCollections.set(name, values);
        return {
          set(uri, items) {
            values.set(uri.fsPath, items);
          },
          delete(uri) {
            values.delete(uri.fsPath);
          },
          clear() {
            values.clear();
          },
          dispose() {
            values.clear();
          },
        };
      },
    },
    workspace: {
      workspaceFolders: [],
      textDocuments: [],
      createFileSystemWatcher: (pattern) => {
        const watcher = {
          pattern,
          dispose() {},
          onDidChange(fn) {
            this.change = fn;
            return disposable;
          },
          onDidCreate(fn) {
            this.create = fn;
            return disposable;
          },
          onDidDelete(fn) {
            this.delete = fn;
            return disposable;
          },
        };
        h.watchers.push(watcher);
        return watcher;
      },
      get isTrusted() {
        return h.trusted;
      },
      getConfiguration: () => ({
        get: (key, fallback) => h.config[key] ?? fallback,
      }),
      onDidGrantWorkspaceTrust: () => disposable,
      registerTextDocumentContentProvider: () => disposable,
      onDidCloseTextDocument: () => disposable,
      onDidChangeTextDocument: (fn) => {
        h.documentChanges.push(fn);
        return disposable;
      },
      onDidSaveTextDocument: () => disposable,
      openTextDocument: async (value) => {
        h.documents.push(value);
        return value;
      },
    },
    window: {
      createWebviewPanel: () => {
        const messages = new Set(),
          closed = new Set();
        const panel = {
          messages,
          closed,
          disposed: false,
          webview: {
            html: "",
            onDidReceiveMessage: (fn) => {
              messages.add(fn);
              return { dispose: () => messages.delete(fn) };
            },
          },
          onDidDispose: (fn) => {
            closed.add(fn);
            return { dispose: () => closed.delete(fn) };
          },
          dispose() {
            if (this.disposed) return;
            this.disposed = true;
            for (const fn of [...closed]) fn();
          },
        };
        h.panels.push(panel);
        return panel;
      },
      createTreeView: (id, options) => {
        const view = { ...disposable, tree: options.treeDataProvider };
        h.views.set(id, view);
        return view;
      },
      registerCustomEditorProvider: () => disposable,
      showQuickPick: async (choices) => {
        h.choices.push(choices);
        return h.picks.length ? h.picks.shift()(choices) : choices[0];
      },
      showInformationMessage: (message) => {
        h.information.push(message);
      },
      showErrorMessage: (error) => {
        h.errors.push(error);
      },
      withProgress: async (options, fn) => {
        h.onProgress?.(options.title);
        if (h.progressGate) await h.progressGate.promise;
        return fn(
          {},
          {
            onCancellationRequested: (listener) => {
              h.cancel = listener;
              return {
                dispose() {
                  h.cancel = undefined;
                },
              };
            },
          },
        );
      },
      showTextDocument: async () => {},
      setStatusBarMessage() {},
    },
    commands: {
      registerCommand: (name, fn) => {
        h.commands.set(name, fn);
        return disposable;
      },
      executeCommand: async () => {},
    },
  };
  global.acquirePositronApi = () => ({
    runtime: {
      getActiveSessions: async () =>
        h.getSessions ? h.getSessions() : h.sessions,
      executeCode: async (...args) => {
        assert.equal(args[0], "r");
        const req = JSON.parse(
          Buffer.from(args[1].match(/"([^"]+)"/)[1], "base64"),
        );
        h.requests.push({ ...req, sessionId: args[7] });
        const data = await h.respond(req);
        const envelope = {
          contract: req.version,
          generated: "2026-09-22T00:00:00Z",
          request_id: req.request_id,
          kind: req.operation,
          data,
          error: null,
        };
        await fs.writeFile(
          req.response_path + ".tmp",
          JSON.stringify(h.envelope ? h.envelope(req, data) : envelope),
        );
        await fs.rename(req.response_path + ".tmp", req.response_path);
      },
    },
  });
  Module._load = function (name, ...args) {
    return name === "vscode" ? mock : originalLoad.call(this, name, ...args);
  };
  const context = { subscriptions: [] };
  try {
    require("../dist/extension").activate(context);
    h.diagnostics = require("../dist/rule-diagnostics");
  } finally {
    Module._load = originalLoad;
  }
  h.dispose = () => {
    for (const item of context.subscriptions) item.dispose();
  };
  h.workspace = mock.workspace;
  h.command = (name, ...args) => h.commands.get("dataraft." + name)(...args);
  t.after(async () => {
    for (const item of context.subscriptions) item.dispose();
    Module._load = originalLoad;
    if (originalApi)
      Object.defineProperty(global, "acquirePositronApi", originalApi);
    else delete global.acquirePositronApi;
    for (const name of Object.keys(require.cache))
      if (local(name)) delete require.cache[name];
    for (const [name, value] of savedModules) require.cache[name] = value;
    for (const req of h.requests)
      await assert.rejects(fs.stat(path.dirname(req.response_path)), {
        code: "ENOENT",
      });
  });
  return h;
}
module.exports = { harness, deferred, session, empty };
