const assert = require("node:assert/strict");
const vscode = require("vscode");
exports.run = async () => {
  const extension = vscode.extensions.getExtension(
    "dataraft-r.dataraft-positron",
  );
  assert.ok(extension);
  await extension.activate();
  assert.equal(extension.isActive, true);
  const commands = await vscode.commands.getCommands(true);
  for (const name of [
    "selectSession",
    "refresh",
    "openMetadata",
    "editYaml",
    "yamlDiff",
    "validateContract",
    "sampleQuality",
  ])
    assert.ok(commands.includes("dataraft." + name));
  const doc = await vscode.workspace.openTextDocument({
    language: "yaml",
    content: "apiVersion: v3.2.0\nkind: DataContract\nschema: []\n",
  });
  await vscode.window.showTextDocument(doc);
};
