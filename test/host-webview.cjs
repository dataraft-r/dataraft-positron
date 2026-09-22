const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const { chromium } = require("playwright-core");
const vscode = require("vscode");

async function until(get, label) {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    try {
      const value = await get();
      if (value) return value;
    } catch (error) {
      if (!/detached|destroyed|Cannot find context/i.test(error.message))
        throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Timed out waiting for ${label}`);
}

exports.exerciseWebview = async (document) => {
  const port = Number(process.env.DATARAFT_HOST_CDP_PORT);
  assert.ok(Number.isInteger(port) && port > 0, "Host CDP port is required");
  const browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`, {
    timeout: 15000,
  });
  for (const context of browser.contexts()) context.setDefaultTimeout(15000);
  try {
    const editor = async () => {
      await vscode.commands.executeCommand(
        "vscode.openWith",
        document.uri,
        "dataraft.contractYaml",
      );
      return until(async () => {
        for (const context of browser.contexts())
          for (const page of context.pages())
            for (const frame of page.frames()) {
              if (
                await frame
                  .locator("#contract-form")
                  .isVisible()
                  .catch(() => false)
              )
                return frame;
            }
      }, "visible production contract form").catch((error) => {
        const targets = browser.contexts().flatMap((context) =>
          context.pages().map((page) => ({
            page: page.url(),
            frames: page.frames().map((frame) => frame.url()),
          })),
        );
        throw new Error(
          `${error.message}; CDP pages/frames: ${JSON.stringify(targets)}`,
        );
      });
    };
    const field = (frame) => frame.locator("[data-field='[\"name\"]']");
    const preview = async (name) => {
      const frame = await editor();
      await field(frame).fill(name);
      await frame
        .getByRole("button", { name: "Preview field edits", exact: true })
        .click();
      await until(async () => {
        for (const tab of vscode.window.tabGroups.all.flatMap((g) => g.tabs)) {
          if (
            tab.input instanceof vscode.TabInputTextDiff &&
            tab.input.modified.scheme === "dataraft-contract-preview"
          ) {
            const proposed = await vscode.workspace.openTextDocument(
              tab.input.modified,
            );
            if (proposed.getText().includes(`name: ${name}`)) return true;
          }
        }
      }, "actual proposed-edit diff with form value");
      const updated = await editor();
      await updated
        .getByRole("button", { name: "Apply preview to document", exact: true })
        .waitFor();
      return updated;
    };
    const baseline = document.getText();
    assert.equal(document.isDirty, false);
    let frame = await preview("Discarded form change");
    assert.equal(document.getText(), baseline, "preview must not edit YAML");
    await frame
      .getByRole("button", { name: "Discard preview", exact: true })
      .click();
    await until(
      async () =>
        !(await (
          await editor()
        )
          .getByRole("button", {
            name: "Apply preview to document",
            exact: true,
          })
          .count()),
      "discarded preview",
    );
    assert.equal(document.getText(), baseline);
    assert.equal(await fs.readFile(document.uri.fsPath, "utf8"), baseline);

    frame = await preview("Applied form change");
    await frame
      .getByRole("button", { name: "Apply preview to document", exact: true })
      .click();
    await until(
      () => document.getText().includes("name: Applied form change"),
      "form edit applied to real document",
    );
    assert.equal(document.isDirty, true);
    assert.equal(
      await fs.readFile(document.uri.fsPath, "utf8"),
      baseline,
      "Apply must not save",
    );

    await preview("Stale form change");
    const current = document.getText();
    const externalEdit = new vscode.WorkspaceEdit();
    externalEdit.insert(
      document.uri,
      new vscode.Position(0, 0),
      "# concurrent text edit\n",
    );
    assert.equal(await vscode.workspace.applyEdit(externalEdit), true);
    await until(
      async () =>
        !(await (
          await editor()
        )
          .getByRole("button", {
            name: "Apply preview to document",
            exact: true,
          })
          .count()),
      "stale preview invalidation",
    );
    assert.equal(document.getText(), "# concurrent text edit\n" + current);
    assert.equal(document.getText().includes("Stale form change"), false);
    assert.equal(await fs.readFile(document.uri.fsPath, "utf8"), baseline);
    await document.save();
    assert.equal(
      await fs.readFile(document.uri.fsPath, "utf8"),
      document.getText(),
    );
  } finally {
    // Disconnect this CDP client; the existing extension-host runner owns VS Code.
    await browser.close();
  }
};
