const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
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

// A Frame becomes invalid when VS Code replaces a webview document. Resolve
// its actual iframe chain once, then let Playwright re-resolve that chain for
// each action rather than retaining the transient renderer Frame object.
async function frameLocator(page, frame) {
  const chain = [];
  for (let child = frame; child.parentFrame(); child = child.parentFrame()) {
    const owner = await child.frameElement();
    const identity = await owner.evaluate((element) => {
      if (element.id)
        return { selector: `iframe[id=${JSON.stringify(element.id)}]` };
      if (element.name)
        return { selector: `iframe[name=${JSON.stringify(element.name)}]` };
      return {
        selector: "iframe",
        index: [...element.ownerDocument.querySelectorAll("iframe")].indexOf(
          element,
        ),
      };
    });
    if (identity.index === undefined) {
      assert.equal(
        await child.parentFrame().locator(identity.selector).count(),
        1,
        `Webview iframe identity must be unique: ${identity.selector}`,
      );
    } else {
      assert.ok(
        identity.index >= 0,
        "Webview iframe must belong to its parent DOM",
      );
    }
    chain.unshift(identity);
  }
  assert.ok(
    chain.length,
    "The production editor must be inside a real webview iframe",
  );
  let current = page;
  for (const { selector, index } of chain) {
    current =
      index === undefined
        ? current.frameLocator(selector)
        : current.frameLocator(selector).nth(index);
  }
  return current;
}

exports.exerciseWebview = async (document, existingBrowser) => {
  const port = Number(process.env.DATARAFT_HOST_CDP_PORT);
  assert.ok(Number.isInteger(port) && port > 0, "Host CDP port is required");
  // Native Positron already tracks the workbench and its out-of-process
  // webviews. Reuse that client rather than attaching a second target graph.
  const browser =
    existingBrowser ||
    (await chromium.connectOverCDP(`http://127.0.0.1:${port}`, {
      timeout: 15000,
    }));
  for (const context of browser.contexts()) context.setDefaultTimeout(15000);
  try {
    const visibleEditor = async () => {
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
                return await frameLocator(page, frame);
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
    const editor = async () => {
      await vscode.commands.executeCommand(
        "vscode.openWith",
        document.uri,
        "dataraft.contractYaml",
      );
      return visibleEditor();
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
          await visibleEditor()
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

    await until(async () => {
      const rendered = await visibleEditor();
      return (
        (await field(rendered).inputValue()) === "Applied form change" &&
        !(await rendered
          .getByRole("button", {
            name: "Apply preview to document",
            exact: true,
          })
          .count())
      );
    }, "applied YAML rendered with consumed preview");

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
          await visibleEditor()
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
  } catch (error) {
    const directory = path.resolve(__dirname, "../.vscode-test/host-webview");
    await fs.mkdir(directory, { recursive: true });
    let index = 0;
    for (const context of browser.contexts()) {
      for (const page of context.pages()) {
        const prefix = path.join(directory, String(index++));
        console.error(
          "Workbench failure notifications:",
          JSON.stringify(
            (
              await page
                .getByRole("alert")
                .allTextContents()
                .catch(() => [])
            )
              .slice(0, 5)
              .map((text) => text.slice(0, 500)),
          ),
        );
        await page
          .screenshot({ path: `${prefix}.png`, timeout: 5000 })
          .catch(() => {});
        for (const [frameIndex, frame] of page.frames().entries()) {
          if (
            await frame
              .locator("#contract-form")
              .count()
              .catch(() => 0)
          ) {
            console.error(
              "Webview failure state:",
              JSON.stringify({
                documentVersion: document.version,
                documentName: document.getText().match(/^name: (.+)$/m)?.[1],
                fieldName: await frame
                  .locator("[data-field='[\"name\"]']")
                  .inputValue()
                  .catch(() => "unavailable"),
                applyButtons: await frame
                  .getByRole("button", {
                    name: "Apply preview to document",
                    exact: true,
                  })
                  .count()
                  .catch(() => -1),
                visibleText: (
                  await frame
                    .locator("body")
                    .innerText()
                    .catch(() => "unavailable")
                ).slice(0, 400),
              }),
            );
          }
          const html = await frame.content().catch(() => "Frame unavailable");
          await fs.writeFile(`${prefix}-frame-${frameIndex}.html`, html);
        }
      }
    }
    throw error;
  } finally {
    // Disconnect this CDP client; the existing extension-host runner owns VS Code.
    if (!existingBrowser) await browser.close();
  }
};
