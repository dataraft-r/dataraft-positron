const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const { tmpdir } = require("node:os");
const vscode = require("vscode");

function diagnosticsAfter(uri, predicate, action) {
  return new Promise((resolve, reject) => {
    let disposed = false;
    const finish = (error) => {
      if (disposed) return;
      disposed = true;
      listener.dispose();
      clearTimeout(timeout);
      error ? reject(error) : resolve();
    };
    const check = () => {
      if (predicate(vscode.languages.getDiagnostics(uri))) finish();
    };
    const listener = vscode.languages.onDidChangeDiagnostics((event) => {
      if (event.uris.some((changed) => changed.toString() === uri.toString()))
        check();
    });
    const timeout = setTimeout(
      () => finish(new Error("Timed out waiting for contract diagnostics")),
      10000,
    );
    Promise.resolve().then(action).then(check, finish);
  });
}
function tabAfter(predicate, action) {
  return new Promise((resolve, reject) => {
    let disposed = false;
    const finish = (error, tab) => {
      if (disposed) return;
      disposed = true;
      listener.dispose();
      clearTimeout(timeout);
      error ? reject(error) : resolve(tab);
    };
    const check = () => {
      const tab = vscode.window.tabGroups.all
        .flatMap((group) => group.tabs)
        .find(predicate);
      if (tab) finish(null, tab);
    };
    const listener = vscode.window.tabGroups.onDidChangeTabs(check);
    const timeout = setTimeout(
      () => finish(new Error("Timed out waiting for contract editor tab")),
      10000,
    );
    Promise.resolve()
      .then(action)
      .then(check, (error) => finish(error));
  });
}
exports.run = async () => {
  const extension = vscode.extensions.getExtension(
    "dataraft-r.dataraft-positron",
  );
  assert.ok(extension);
  await extension.activate();
  assert.equal(extension.isActive, true);
  const commands = await vscode.commands.getCommands(true);
  const manifest = require("../package.json");
  for (const contribution of manifest.contributes.commands)
    assert.ok(
      commands.includes(contribution.command),
      `Missing declared command ${contribution.command}`,
    );

  const directory = await fs.mkdtemp(path.join(tmpdir(), "dataraft-host-"));
  const uri = vscode.Uri.file(path.join(directory, "contract.yaml"));
  const original = await fs.readFile(
    path.join(__dirname, "fixtures", "host-contract.yaml"),
    "utf8",
  );
  try {
    await fs.writeFile(uri.fsPath, original);
    const document = await vscode.workspace.openTextDocument(uri);
    await tabAfter(
      (tab) =>
        tab.input instanceof vscode.TabInputCustom &&
        tab.input.viewType === "dataraft.contractYaml",
      () => vscode.commands.executeCommand("dataraft.editYaml", uri),
    );
    const replace = async (text) => {
      const edit = new vscode.WorkspaceEdit();
      edit.replace(
        uri,
        new vscode.Range(
          document.positionAt(0),
          document.positionAt(document.getText().length),
        ),
        text,
      );
      assert.equal(await vscode.workspace.applyEdit(edit), true);
    };
    const changed = original.replace("name: Orders", "name: Revised orders");
    const invalid = changed.replace('version: "1"', "version: false");
    await diagnosticsAfter(
      uri,
      (issues) =>
        issues.some(
          (issue) => issue.severity === vscode.DiagnosticSeverity.Error,
        ),
      () => replace(invalid),
    );
    assert.equal(document.isDirty, true);
    assert.equal(
      await fs.readFile(uri.fsPath, "utf8"),
      original,
      "editing must not implicitly save",
    );
    const issues = vscode.languages.getDiagnostics(uri);
    assert.ok(
      issues.some((issue) => document.getText(issue.range) === "false"),
      "diagnostic points to actual YAML value",
    );
    await diagnosticsAfter(
      uri,
      (issues) => issues.length === 0,
      () => replace(changed),
    );
    const diff = await tabAfter(
      (tab) =>
        tab.input instanceof vscode.TabInputTextDiff &&
        tab.input.original.scheme === "dataraft-contract-preview",
      () => vscode.commands.executeCommand("dataraft.yamlDiff", uri),
    );
    assert.equal(
      (await vscode.workspace.openTextDocument(diff.input.original)).getText(),
      original,
    );
    assert.equal(
      (await vscode.workspace.openTextDocument(diff.input.modified)).getText(),
      changed,
    );
    assert.equal(
      document.isDirty,
      true,
      "opening the diff must not save the document",
    );
    assert.equal(await document.save(), true);
    assert.equal(await fs.readFile(uri.fsPath, "utf8"), changed);
  } finally {
    await vscode.commands.executeCommand("workbench.action.closeAllEditors");
    await fs.rm(directory, { recursive: true, force: true });
  }
};
