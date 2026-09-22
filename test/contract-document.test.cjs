const { test } = require("node:test");
const assert = require("node:assert/strict");
const {
  inspectContract,
  editContract,
  assertSnapshot,
  contentHash,
  profileColumnProposals,
  sampleRuleIssues,
} = require("../dist/contract-document.js");
const yaml = `# Insurance contract, maintained by the team
apiVersion: v3.2.0
kind: DataContract
id: orders
name: 'Order contract' # retain the quote and comment
version: '1.0.0'
description:
  purpose: |
    Review amounts.
    Preserve evidence.
x-owner:
  region: EU # extension metadata survives
schema:
  - name: orders
    logicalType: object
    properties:
      - name: amount # column comment
        logicalType: number
        required: true
        description: Amount in EUR
    quality:
      - name: nonnegative
        type: custom
        engine: dataraft
        severity: error
        implementation:
          predicate: 'amount >= 0' # predicate comment
          threshold: 0
          action: block
`;
test("round trip modifies AST scalars and preserves comments, styles and unknown metadata", () => {
  assert.deepEqual(inspectContract(yaml).issues, []);
  const edited = editContract(yaml, [
    { kind: "set", path: ["name"], value: "Reviewed orders" },
    {
      kind: "set",
      path: ["schema", 0, "quality", 0, "implementation", "predicate"],
      value: "amount > 0",
    },
  ]);
  assert.match(
    edited,
    /name: 'Reviewed orders' # retain the quote and comment/,
  );
  assert.match(edited, /predicate: 'amount > 0' # predicate comment/);
  for (const text of [
    "# Insurance contract",
    "# column comment",
    "region: EU # extension metadata survives",
    "purpose: |",
    "    Preserve evidence.",
  ])
    assert.ok(edited.includes(text), text);
  assert.deepEqual(inspectContract(edited).issues, []);
});
test("accepts YAML 1.1 booleans emitted by the existing R ODCS exporter", () => {
  const exported = yaml.replace(
    "required: true",
    "required: yes\n        primaryKey: no",
  );
  assert.deepEqual(inspectContract(exported).issues, []);
  assert.equal(inspectContract(exported).columns[0][2].value, true);
  const edited = editContract(exported, [
    {
      kind: "set",
      path: ["schema", 0, "properties", 0, "required"],
      value: false,
    },
  ]);
  assert.equal(inspectContract(edited).columns[0][2].value, false);
});
test("adds and removes ODCS columns and rules without introducing another schema", () => {
  let edited = editContract(yaml, [{ kind: "addColumn" }, { kind: "addRule" }]);
  let form = inspectContract(edited);
  assert.equal(form.columns.length, 2);
  assert.equal(form.rules.length, 2);
  assert.equal(form.columns[1][0].value, "column_2");
  assert.equal(form.rules[1][0].value, "rule_2");
  edited = editContract(edited, [
    { kind: "removeColumn", index: 1 },
    { kind: "removeRule", index: 1 },
  ]);
  form = inspectContract(edited);
  assert.equal(form.columns.length, 1);
  assert.equal(form.rules.length, 1);
  assert.ok(edited.includes("# predicate comment"));
  assert.throws(
    () => editContract(yaml, [{ kind: "removeColumn", index: 0 }]),
    /at least one property/,
  );
});
test("typed diagnostics refer to actual scalar ranges", () => {
  const invalid = yaml.replace("logicalType: number", "logicalType: banana");
  const issue = inspectContract(invalid).issues.find((x) =>
    x.message.includes("Logical type must be one of"),
  );
  assert.ok(issue);
  assert.equal(invalid.slice(issue.start, issue.end), "banana");
  const wrong = yaml.replace("required: true", 'required: "true"');
  assert.ok(
    inspectContract(wrong).issues.some((x) =>
      x.message.includes("Required must be a boolean"),
    ),
  );
  assert.throws(
    () =>
      editContract(yaml, [
        {
          kind: "set",
          path: ["schema", 0, "quality", 0, "implementation", "threshold"],
          value: 2,
        },
      ]),
    /between zero and one/,
  );
});
test("fails closed for malformed documents, duplicate keys, aliases and custom tags without evaluating content", () => {
  for (const text of [
    yaml + "id: duplicate\n",
    "schema: [\n",
    yaml.replace("id: orders", 'id: !expr system("unsafe")'),
    yaml.replace("id: orders", "id: &id orders\nnameAlias: *id"),
  ]) {
    assert.ok(inspectContract(text).issues.length > 0);
    assert.throws(
      () => editContract(text, [{ kind: "set", path: ["name"], value: "x" }]),
      /Fix the YAML diagnostics/,
    );
  }
  assert.throws(() => inspectContract("x".repeat(1024 * 1024 + 1)), /1 MiB/);
});
test("form messages cannot edit arbitrary metadata, prototype paths or invalid indexes", () => {
  for (const operation of [
    { kind: "set", path: ["__proto__", "polluted"], value: "yes" },
    { kind: "set", path: ["x-owner", "region"], value: "US" },
    { kind: "set", path: ["id"], value: 3 },
    { kind: "removeColumn", index: -1 },
    { kind: "removeRule", index: 99 },
    { kind: "execute" },
  ])
    assert.throws(() => editContract(yaml, [operation]));
  assert.equal({}.polluted, undefined);
  assert.throws(() => editContract(yaml, []), /between one and 1000/);
});
test("snapshot validation protects dirty buffers and external file changes independently", () => {
  const baseline = {
    version: 4,
    text: "dirty editor text",
    diskHash: contentHash("saved file"),
  };
  assert.doesNotThrow(() => assertSnapshot(baseline, { ...baseline }));
  assert.throws(
    () => assertSnapshot(baseline, { ...baseline, version: 5 }),
    /document changed/,
  );
  assert.throws(
    () =>
      assertSnapshot(baseline, { ...baseline, text: "another unsaved edit" }),
    /document changed/,
  );
  assert.throws(
    () =>
      assertSnapshot(baseline, {
        ...baseline,
        diskHash: contentHash("external writer"),
      }),
    /saved file changed/,
  );
});

// Exercise the custom editor's actual preview/apply path with a minimal host.
test(
  "custom editor applies only a reviewed current snapshot via WorkspaceEdit, without saving",
  { timeout: 10000 },
  async () => {
    const Module = require("node:module");
    const originalLoad = Module._load;
    let provider,
      receive,
      current = yaml + "# unsaved before opening\n",
      disk = yaml,
      version = 1,
      applied = 0,
      saveCalls = 0,
      dirty = true;
    const errors = [],
      diffs = [];
    let pendingDiff, diffStarted;
    const disposable = { dispose() {} };
    const uri = {
      scheme: "file",
      toString: () => "file:///orders.contract.yaml",
    };
    const doc = {
      uri,
      get version() {
        return version;
      },
      get isDirty() {
        return dirty;
      },
      getText: () => current,
      positionAt: (n) => n,
      save() {
        saveCalls++;
      },
    };
    const mock = {
      Uri: { from: (o) => ({ ...o, toString: () => `${o.scheme}:${o.path}` }) },
      Diagnostic: class {
        constructor(range, message) {
          this.range = range;
          this.message = message;
        }
      },
      DiagnosticSeverity: { Error: 0 },
      Range: class {
        constructor(start, end) {
          this.start = start;
          this.end = end;
        }
      },
      WorkspaceEdit: class {
        replace(uri, range, text) {
          this.text = text;
        }
      },
      languages: {
        createDiagnosticCollection: () => ({
          set() {},
          delete() {},
          dispose() {},
        }),
      },
      workspace: {
        fs: { readFile: async () => Buffer.from(disk) },
        registerTextDocumentContentProvider: () => disposable,
        onDidCloseTextDocument: () => disposable,
        onDidChangeTextDocument: () => disposable,
        onDidSaveTextDocument: () => disposable,
        applyEdit: async (edit) => {
          applied++;
          current = edit.text;
          version++;
          return true;
        },
      },
      window: {
        registerCustomEditorProvider: (_id, p) => {
          provider = p;
          return disposable;
        },
        showErrorMessage: (message) => errors.push(message),
      },
      commands: {
        registerCommand: () => disposable,
        executeCommand: async (...args) => {
          diffs.push(args);
          if (args[0] === "vscode.diff") {
            diffStarted?.();
            diffStarted = undefined;
          }
          if (pendingDiff && args[0] === "vscode.diff") await pendingDiff;
        },
      },
    };
    Module._load = function (name, ...args) {
      return name === "vscode" ? mock : originalLoad.call(this, name, ...args);
    };
    let registerYamlEditor;
    try {
      ({ registerYamlEditor } = require("../dist/contract-editor.js"));
    } finally {
      Module._load = originalLoad;
    }
    registerYamlEditor({ subscriptions: [] });
    const panel = {
      webview: {
        options: {},
        html: "",
        onDidReceiveMessage: (fn) => {
          receive = fn;
          return disposable;
        },
      },
      onDidDispose: () => disposable,
    };
    await provider.resolveCustomTextEditor(doc, panel);
    await receive({ type: "validate", version });
    assert.match(errors.at(-1), /Save the YAML document explicitly/);
    assert.equal(diffs.length, 0);

    const preview = () =>
      receive({
        type: "preview",
        version,
        operations: [{ kind: "set", path: ["name"], value: "Reviewed" }],
      });
    // Reproduce a slow host opening the immutable diff: the enabled controls
    // must still accept one click, without waiting for the display promise.
    let finishDiff;
    pendingDiff = new Promise((resolve) => {
      finishDiff = resolve;
    });
    const enteredDiff = new Promise((resolve) => {
      diffStarted = resolve;
    });
    const opening = preview();
    await enteredDiff;
    assert.match(panel.webview.html, /Apply preview to document/);
    await receive({ type: "discard", version });
    assert.ok(!panel.webview.html.includes("Apply preview to document"));
    assert.equal(applied, 0);
    finishDiff();
    await opening;
    let failDiff;
    pendingDiff = new Promise((resolve, reject) => {
      failDiff = reject;
    });
    await preview();
    failDiff(new Error("Diff could not open"));
    await new Promise((resolve) => setImmediate(resolve));
    assert.ok(!panel.webview.html.includes("Apply preview to document"));
    assert.match(errors.at(-1), /Diff could not open/);

    pendingDiff = new Promise((resolve, reject) => {
      failDiff = reject;
    });
    await preview();
    pendingDiff = undefined;
    await preview();
    failDiff(new Error("An older diff failed"));
    await new Promise((resolve) => setImmediate(resolve));
    assert.match(panel.webview.html, /Apply preview to document/);
    assert.equal(applied, 0);
    assert.equal(diffs.at(-1)[0], "vscode.diff");
    assert.match(panel.webview.html, /Apply preview to document/);
    disk = yaml + "# concurrent external edit\n";
    await receive({ type: "apply", version });
    assert.equal(applied, 0);
    assert.match(errors.at(-1), /saved file changed/);
    disk = yaml;
    await preview();
    version++;
    await receive({ type: "apply", version });
    assert.equal(applied, 0);
    assert.match(errors.at(-1), /document changed/);
    pendingDiff = new Promise((resolve) => {
      finishDiff = resolve;
    });
    const enteredSecondDiff = new Promise((resolve) => {
      diffStarted = resolve;
    });
    const secondOpening = preview();
    await enteredSecondDiff;
    await receive({ type: "apply", version });
    finishDiff();
    await secondOpening;
    assert.equal(applied, 1);
    assert.match(current, /name: 'Reviewed'/);
    assert.match(current, /# unsaved before opening/);
    assert.equal(saveCalls, 0);
  },
);

test("sample profile proposes explicit column changes and preserves unselected YAML metadata", () => {
  const profile = {
    columns: [
      { name: "amount", type: "integer64", required: false },
      { name: "policy", type: "character", required: true },
      { name: "complex", type: null, required: false },
    ],
  };
  const proposals = profileColumnProposals(yaml, profile);
  assert.equal(proposals.length, 2);
  assert.match(proposals[0].detail, /sample only/);
  const edited = editContract(yaml, [proposals[0].operation]);
  assert.equal(inspectContract(edited).columns.length, 1);
  assert.equal(inspectContract(edited).columns[0][1].value, "integer");
  assert.match(edited, /format: i64/);
  assert.match(edited, /# column comment/);
  assert.match(edited, /description: Amount in EUR/);
  assert.ok(!edited.includes("name: policy"));
  const added = editContract(yaml, [proposals[1].operation]);
  assert.equal(inspectContract(added).columns.length, 2);
  assert.equal(inspectContract(added).columns[1][0].value, "policy");
  assert.throws(
    () =>
      profileColumnProposals(yaml, {
        columns: [
          { name: "x", type: "integer", required: true },
          { name: "x", type: "integer", required: true },
        ],
      }),
    /unique/,
  );
  assert.deepEqual(
    profileColumnProposals(yaml, {
      columns: [{ name: "x", type: "constructor", required: true }],
    }),
    [],
  );
  assert.throws(
    () =>
      editContract(yaml, [
        {
          kind: "profileColumn",
          name: "x",
          type: "constructor",
          required: true,
        },
      ]),
    /Invalid profile/,
  );
});
test("failed sample rules map only exact unique explicit YAML names to real source ranges", () => {
  const quality = {
    items: [
      { rule: "nonnegative", status: "failed", n_failed: 2 },
      { rule: "missing_column", status: "failed" },
      { rule: "nonnegative-extra", status: "failed" },
      { rule: "nonnegative", status: "passed" },
    ],
  };
  const issues = sampleRuleIssues(yaml, quality);
  assert.equal(issues.length, 1);
  assert.equal(yaml.slice(issues[0].start, issues[0].end), "nonnegative");
  assert.match(issues[0].message, /2 failed rows/);
  const generated = yaml.replace("name: nonnegative", "name: rule-1");
  assert.deepEqual(
    sampleRuleIssues(generated, {
      items: [{ rule: "rule-1", status: "failed" }],
    }),
    [],
  );
  const ambiguous = yaml.replace(
    "    quality:",
    "        quality:\n          - name: nonnegative\n            type: library\n    quality:",
  );
  assert.deepEqual(inspectContract(ambiguous).issues, []);
  assert.deepEqual(sampleRuleIssues(ambiguous, quality), []);
});
test("profile and sample integration require explicit selection and discard stale diagnostics", async () => {
  const Module = require("node:module"),
    originalLoad = Module._load;
  let provider,
    receive,
    change,
    current = yaml,
    disk = yaml,
    version = 1,
    applied = 0,
    diagnostics = [];
  let pick = "cancel",
    race = false;
  const errors = [],
    calls = [];
  const disposable = { dispose() {} };
  const uri = {
    scheme: "file",
    toString: () => "file:///sample.contract.yaml",
  };
  const doc = {
    uri,
    get version() {
      return version;
    },
    get isDirty() {
      return current !== disk;
    },
    getText: () => current,
    positionAt: (n) => n,
  };
  const mock = {
    Uri: { from: (o) => ({ ...o, toString: () => `${o.scheme}:${o.path}` }) },
    Diagnostic: class {
      constructor(range, message) {
        this.range = range;
        this.message = message;
      }
    },
    DiagnosticSeverity: { Error: 0 },
    Range: class {
      constructor(start, end) {
        this.start = start;
        this.end = end;
      }
    },
    WorkspaceEdit: class {
      replace(uri, range, text) {
        this.text = text;
      }
    },
    languages: {
      createDiagnosticCollection: () => ({
        set(_uri, value) {
          diagnostics = value;
        },
        delete() {},
        dispose() {},
      }),
    },
    workspace: {
      fs: { readFile: async () => Buffer.from(disk) },
      registerTextDocumentContentProvider: () => disposable,
      onDidCloseTextDocument: () => disposable,
      onDidChangeTextDocument: (fn) => {
        change = fn;
        return disposable;
      },
      onDidSaveTextDocument: () => disposable,
      applyEdit: async (edit) => {
        current = edit.text;
        version++;
        applied++;
        change({ document: doc });
        return true;
      },
    },
    window: {
      registerCustomEditorProvider: (_id, p) => {
        provider = p;
        return disposable;
      },
      showErrorMessage: (message) => errors.push(message),
      showInformationMessage() {},
      showQuickPick: async (choices) =>
        pick === "cancel" ? undefined : [choices[0]],
    },
    commands: {
      registerCommand: () => disposable,
      executeCommand: async (command, ...args) => {
        calls.push(command);
        if (command === "dataraft.profile")
          return {
            kind: "profile",
            error: null,
            data: {
              columns: [
                { name: "policy", type: "character", required: true },
                { name: "other", type: "integer", required: false },
              ],
            },
          };
        if (command === "dataraft.sampleQuality") {
          if (race) {
            version++;
            current += "\n# concurrent edit";
            change({ document: doc });
          }
          return {
            kind: "sample_quality",
            error: null,
            data: {
              items: [{ rule: "nonnegative", status: "failed", n_failed: 1 }],
            },
          };
        }
      },
    },
  };
  Module._load = function (name, ...args) {
    return name === "vscode" ? mock : originalLoad.call(this, name, ...args);
  };
  let registerYamlEditor;
  try {
    delete require.cache[require.resolve("../dist/contract-editor.js")];
    ({ registerYamlEditor } = require("../dist/contract-editor.js"));
  } finally {
    Module._load = originalLoad;
  }
  registerYamlEditor({ subscriptions: [] });
  const panel = {
    webview: {
      options: {},
      html: "",
      onDidReceiveMessage: (fn) => {
        receive = fn;
        return disposable;
      },
    },
    onDidDispose: () => disposable,
  };
  await provider.resolveCustomTextEditor(doc, panel);
  await receive({ type: "profile", version });
  assert.equal(applied, 0);
  assert.ok(!panel.webview.html.includes("Apply preview to document"));
  pick = "first";
  await receive({ type: "profile", version });
  assert.equal(applied, 0);
  assert.match(panel.webview.html, /Apply preview to document/);
  await receive({ type: "apply", version });
  assert.equal(applied, 1);
  assert.ok(current.includes("name: policy"));
  assert.ok(!current.includes("name: other"));
  // Restore a saved original document, then request actual sample diagnostics.
  current = yaml;
  disk = yaml;
  version++;
  change({ document: doc });
  await receive({ type: "sample", version });
  assert.equal(diagnostics.length, 1);
  assert.equal(
    current.slice(diagnostics[0].range.start, diagnostics[0].range.end),
    "nonnegative",
  );
  race = true;
  await receive({ type: "sample", version });
  assert.equal(diagnostics.length, 0);
  assert.match(errors.at(-1), /document changed/);
});
