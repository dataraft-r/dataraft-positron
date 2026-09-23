// Native Positron extension-host acceptance. Must run inside the pinned app,
// with its bundled R extension and Ark. There is deliberately no runtime mock.
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const vscode = require("vscode");
const { chromium } = require("playwright-core");
const { tryAcquirePositronApi } = require("@posit-dev/positron");

async function until(read, label, timeout = 60000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const value = await read();
    if (value) return value;
    // Bounded condition polling, never a sleep that assumes completion.
    await new Promise((resolve) => setTimeout(resolve, 75));
  }
  throw new Error(`Timed out waiting for ${label}`);
}
async function jsonFile(file) {
  try {
    return JSON.parse(await fs.readFile(file, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return undefined;
    throw error;
  }
}
async function currentJson(predicate) {
  const editor = vscode.window.activeTextEditor;
  if (!editor || editor.document.languageId !== "json") return undefined;
  let value;
  try {
    value = JSON.parse(editor.document.getText());
  } catch {
    return undefined;
  }
  return predicate(value) ? value : undefined;
}
exports.run = async () => {
  const workspace = process.env.DATARAFT_POSITRON_WORKSPACE;
  const artifacts = process.env.DATARAFT_POSITRON_ARTIFACTS;
  assert.ok(workspace && path.isAbsolute(workspace));
  assert.ok(artifacts && path.isAbsolute(artifacts));
  await fs.mkdir(artifacts, { recursive: true });
  assert.match(vscode.env.appName, /Positron/i);
  assert.equal(vscode.workspace.isTrusted, true);
  const api = tryAcquirePositronApi();
  assert.ok(api, "This suite requires the real Positron API");
  const rExtension = vscode.extensions.getExtension("positron.positron-r");
  assert.ok(rExtension, "Bundled Positron R extension must exist");
  await rExtension.activate();
  const extension = vscode.extensions.getExtension(
    "dataraft-r.dataraft-positron",
  );
  assert.ok(extension);
  await extension.activate();
  await vscode.workspace
    .getConfiguration("dataraft")
    .update("maximumRows", 3, vscode.ConfigurationTarget.Workspace);
  const expectedR = process.env.DATARAFT_EXPECT_R_VERSION || "4.5.1";
  const expectedPath = await fs.realpath(process.env.POSITRON_R_PATH);
  const metadata = await until(
    async () => {
      for (const item of await api.runtime.getRegisteredRuntimes()) {
        if (item.languageId !== "r" || item.languageVersion !== expectedR)
          continue;
        if ((await fs.realpath(item.runtimePath)) === expectedPath) return item;
      }
    },
    `registered R ${expectedR} at ${expectedPath}`,
    120000,
  );
  const session = await api.runtime.startLanguageRuntime(
    metadata.runtimeId,
    "DataRaft native acceptance",
  );
  const sessionId = session.metadata.sessionId;
  assert.equal(session.metadata.sessionMode, "console");
  const idle = () =>
    until(
      async () => {
        const current = await api.runtime.getSession(sessionId);
        assert.ok(current, "Native R session disappeared");
        return ["idle", "ready"].includes(await current.getRuntimeState());
      },
      "actual Ark session idle",
      120000,
    );
  await idle();
  const ruleFile = path.join(workspace, "native-rule.R");
  const fixture = path.join(workspace, "native-workspace.R");
  await fs.copyFile(path.join(__dirname, "fixtures/positron-rule.R"), ruleFile);
  await fs.copyFile(
    path.join(__dirname, "fixtures/positron-workspace.R"),
    fixture,
  );
  const ack = path.join(workspace, "native-ready.json");
  const code = `local({
    native_root <- ${JSON.stringify(workspace)}
    assign("native_root", native_root, .GlobalEnv)
    result <- tryCatch({
      source(${JSON.stringify(fixture)}, local=.GlobalEnv, keep.source=TRUE, encoding="UTF-8")
      list(ok=TRUE, r=as.character(getRversion()), pid=Sys.getpid(),
        packages=lapply(c("dataraft.core", "dataraft.lake", "dataraft.adapters", "dataraft.catalog", "dataraft.ide", "duckdb"), function(p) list(name=p, version=as.character(packageVersion(p)))))
    }, error=function(e) list(ok=FALSE, message=conditionMessage(e)))
    temporary <- paste0(${JSON.stringify(ack)}, ".tmp")
    jsonlite::write_json(result, temporary, auto_unbox=TRUE)
    stopifnot(file.rename(temporary, ${JSON.stringify(ack)}))
  })`;
  await api.runtime.executeCode(
    "r",
    code,
    false,
    false,
    undefined,
    undefined,
    undefined,
    sessionId,
  );
  const ready = await until(
    () => jsonFile(ack),
    "fixture acknowledgement from Ark",
  );
  assert.equal(ready.ok, true, ready.message);
  assert.equal(ready.r, expectedR);
  await idle();
  const versions = {
    app: vscode.env.appName,
    vscode: vscode.version,
    positron: process.env.DATARAFT_POSITRON_VERSION,
    runtime: metadata,
    sessionId,
    ...ready,
  };
  await fs.writeFile(
    path.join(artifacts, "versions.json"),
    JSON.stringify(versions, null, 2),
  );

  const browser = await chromium.connectOverCDP(
    `http://127.0.0.1:${Number(process.env.DATARAFT_HOST_CDP_PORT)}`,
    { timeout: 30000 },
  );
  let page;
  let context;
  const completed = [];
  const checkpoint = (journey) => {
    completed.push(journey);
    console.log("Native Positron PASS:", journey);
  };
  try {
    page = await until(async () => {
      for (const candidate of browser
        .contexts()
        .flatMap((item) => item.pages()))
        if (
          await candidate
            .locator(".monaco-workbench")
            .isVisible()
            .catch(() => false)
        )
          return candidate;
    }, "actual Positron workbench");
    await page.setViewportSize({ width: 1600, height: 1000 });
    await vscode.commands.executeCommand("workbench.action.closePanel");
    const captureFeature = async (name, frame) => {
      if (frame) {
        if (name === "yaml-preview") await frame.getByRole("button", {name: "Apply preview to document", exact: true}).scrollIntoViewIfNeeded();
        else await frame.locator("[data-field='[\"name\"]']").scrollIntoViewIfNeeded();
      }
      await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      await page.screenshot({ path: path.join(artifacts, `feature-${name}.png`) });
    };
    context = page.context();
    context.setDefaultTimeout(30000);
    await context.tracing.start({ screenshots: true, snapshots: true });
    const quickInput = page.locator(
      ".quick-input-widget .quick-input-box input",
    );
    const quickRows = page.locator(
      ".quick-input-widget .quick-input-list .monaco-list-row",
    );
    const command = async (title) => {
      await page.keyboard.press("Escape");
      await page.keyboard.press("Control+Shift+P");
      await quickInput.fill(`>DataRaft: ${title}`);
      await quickRows
        .filter({ hasText: `DataRaft: ${title}` })
        .first()
        .click();
    };
    const pick = async (id, status) => {
      await page
        .getByPlaceholder("Select a product from the refreshed metadata", {
          exact: true,
        })
        .waitFor();
      await quickInput.fill(id);
      let row = quickRows.filter({ hasText: id });
      row = status
        ? row.filter({ hasText: status })
        : row.filter({ hasNotText: /Trial:|completed|blocked/ });
      assert.equal(
        await row.count(),
        1,
        `Unambiguous product choice ${id} ${status || "definition"}`,
      );
      await row.click();
    };
    const refresh = async () => {
      const messages = page.getByText(/^Workspace · .*Manual refresh only\.$/);
      const before = await messages.allTextContents();
      await command("Refresh Metadata");
      await until(async () => {
        const after = await messages.allTextContents();
        return (
          after.length === 5 &&
          after.every((text, index) => text !== before[index])
        );
      }, "all five metadata views refreshed, including final incidents response");
      await idle();
    };
    await command("Select R Session");
    await page
      .getByPlaceholder(
        "Select the existing R session whose workspace you want to inspect",
        { exact: true },
      )
      .waitFor();
    await captureFeature("select-session");
    await quickRows.filter({ hasText: sessionId }).click();
    // Reveal the view container through the workbench command. All tested
    // DataRaft actions below still use actual command-palette and tree clicks.
    await vscode.commands.executeCommand("workbench.view.extension.dataraft");
    for (const kind of [
      "incidents",
      "freshness",
      "runs",
      "quality",
      "products",
    ])
      await vscode.commands.executeCommand(`dataraft.${kind}.focus`);
    await refresh();
    await page
      .getByRole("treeitem")
      .filter({ hasText: "passing.orders" })
      .first()
      .waitFor();
    await idle();
    // Click an actual product tree row, and inspect the document it opens.
    await page
      .getByRole("treeitem")
      .filter({ hasText: "passing.orders" })
      .first()
      .click();
    await until(
      () =>
        currentJson(
          (value) => value.id === "passing.orders" && value.kind === "product",
        ),
      "product tree inspection JSON",
    );
    await captureFeature("inspect-product");
    checkpoint("session selection, refresh and product tree inspection");

    for (const [id, status] of [
      ["passing.orders", "completed"],
      ["failing.orders", "blocked"],
    ]) {
      await idle();
      await command("Trial Product");
      await pick(id);
      const result = await until(
        () =>
          currentJson(
            (value) => value.kind === "trial" && value.data?.result?.id === id,
          ),
        `${id} real trial response`,
      );
      assert.equal(result.data.status, status);
      assert.match(result.data.handle, /^result:/);
      await captureFeature(`trial-${status}`);
      checkpoint(`${id}: ${status}`);
    }
    await idle();
    await refresh();
    await vscode.commands.executeCommand("dataraft.quality.focus");
    // The real quality tree renders evidence retained by those two R trials.
    const failedRow = page
      .getByRole("treeitem")
      .filter({ hasText: "failing.orders" })
      .filter({ hasText: /failed/ });
    await failedRow.first().waitFor();
    await failedRow.first().click();
    const quality = await until(
      () =>
        currentJson(
          (value) =>
            value.asset === "failing.orders" && value.status === "failed",
        ),
      "failed quality evidence from tree click",
    );
    assert.equal(quality.n_failed, 1);
    assert.equal(quality.n_total, 2);
    await captureFeature("quality-evidence");
    checkpoint("quality tree reports one failure in two rows");

    await idle();
    await command("Show R Rule Diagnostics");
    await pick("failing.orders", /blocked/);
    const ruleUri = vscode.Uri.file(ruleFile);
    const diagnostic = await until(
      () =>
        vscode.languages
          .getDiagnostics(ruleUri)
          .find((item) => item.source === "DataRaft R"),
      "real source-reference diagnostic",
    );
    assert.match(diagnostic.message, /nonnegative/);
    assert.equal(diagnostic.range.start.line, 1);
    assert.equal(diagnostic.severity, vscode.DiagnosticSeverity.Error);
    await vscode.window.showTextDocument(ruleUri);
    await page.screenshot({
      path: path.join(artifacts, "rule-diagnostic.png"),
    });
    checkpoint(
      "function srcref diagnostic maps to actual workspace R file",
    );

    await idle();
    await command("View Bounded Rows in R");
    await pick("passing.orders", /completed/);
    const statusBar = page.locator(".positron-data-explorer .status-bar");
    await until(async () => {
      for (const text of await statusBar.allTextContents()) {
        const rows = text.match(/(\d+(?:,\d+)*)\s+rows?/i);
        if (rows && Number(rows[1].replaceAll(",", "")) === 3) return true;
      }
    }, "native Positron Data Explorer with exactly three rows");
    assert.ok(
      (
        await page.locator(".data-grid-column-header .title").allTextContents()
      ).includes("amount"),
    );
    await page.screenshot({
      path: path.join(artifacts, "bounded-data-explorer.png"),
    });
    checkpoint("Ark View opens native Data Explorer with 3 of 20 rows");

    await idle();
    await command("Show Directed Lineage");
    const lineageButton = await until(async () => {
      for (const frame of page.frames()) {
        const button = frame.getByRole("button", {
          name: "Focus product passing.orders",
          exact: true,
        });
        if (
          await button
            .first()
            .isVisible()
            .catch(() => false)
        )
          return button.first();
      }
    }, "real directed lineage webview node");
    await captureFeature("directed-lineage");
    await lineageButton.click();
    await page
      .getByRole("treeitem", { selected: true })
      .filter({ hasText: "passing.orders" })
      .first()
      .waitFor();
    checkpoint(
      "lineage node click reveals corresponding product tree item",
    );

    // Revealing/expanding the lineage target loads detail asynchronously.
    // An explicit user inspection provides a completion boundary before the
    // next editor journey, rather than treating selection as request completion.
    const previousDocument =
      vscode.window.activeTextEditor?.document.uri.toString();
    await page
      .getByRole("treeitem", { selected: true })
      .filter({ hasText: "passing.orders" })
      .first()
      .click();
    await until(async () => {
      if (
        vscode.window.activeTextEditor?.document.uri.toString() ===
        previousDocument
      )
        return false;
      return currentJson(
        (value) => value.id === "passing.orders" && value.kind === "product",
      );
    }, "lineage target inspection completed in a new JSON document");
    await idle();

    const yamlUri = vscode.Uri.file(
      path.join(workspace, "native.contract.yaml"),
    );
    await fs.copyFile(
      path.join(__dirname, "fixtures/host-contract.yaml"),
      yamlUri.fsPath,
    );
    const document = await vscode.workspace.openTextDocument(yamlUri);
    await vscode.window.showTextDocument(document);
    await command("Open Contract YAML Editor");
    await until(
      () =>
        vscode.window.tabGroups.all
          .flatMap((group) => group.tabs)
          .some(
            (tab) =>
              tab.isActive &&
              tab.input instanceof vscode.TabInputCustom &&
              tab.input.viewType === "dataraft.contractYaml" &&
              tab.input.uri.toString() === yamlUri.toString(),
          ),
      "active production custom-editor tab for the exact YAML document",
    );
    await require("./host-webview.cjs").exerciseWebview(document, browser, captureFeature);
    checkpoint(
      "native webview buttons preview, discard, apply and reject stale YAML edits",
    );
    assert.ok(
      (await api.runtime.getActiveSessions()).some(
        (item) => item.metadata.sessionId === sessionId,
      ),
    );
    await require("./lineage-gallery.cjs").capture(vscode, page, artifacts, until);
    checkpoint("12 product lineage screenshots in native light and dark themes");
    await fs.writeFile(
      path.join(artifacts, "acceptance.json"),
      JSON.stringify({ sessionId, completed }, null, 2),
    );
  } catch (error) {
    console.error(
      "Native Positron completed journeys:",
      JSON.stringify(completed),
    );
    console.error("Native Positron failure:", String(error.stack || error));
    console.error(
      "Native Positron editor tabs:",
      JSON.stringify(
        vscode.window.tabGroups.all
          .flatMap((group) => group.tabs)
          .slice(0, 30)
          .map((tab) => ({
            label: tab.label,
            active: tab.isActive,
            viewType: tab.input?.viewType,
            uri: tab.input?.uri?.toString(),
          })),
      ),
    );
    if (page) {
      // This runner owns an isolated synthetic workspace. Keep CI diagnostics
      // bounded so a failed selector is debuggable without downloading a trace.
      const visibleState = await page
        .evaluate(() => ({
          alerts: [
            ...document.querySelectorAll(
              '[role="alert"], .notifications-toasts .notification-list-item',
            ),
          ]
            .slice(0, 12)
            .map((element) => (element.innerText || "").slice(0, 500)),
          workbench: (
            document.querySelector(".monaco-workbench")?.innerText || ""
          ).slice(-10000),
        }))
        .catch((captureError) => ({
          unavailable: String(captureError.message).slice(0, 500),
        }));
      console.error(
        "Native Positron visible state:",
        JSON.stringify(visibleState),
      );
      await page
        .screenshot({
          path: path.join(artifacts, "failure.png"),
          fullPage: true,
        })
        .catch(() => {});
      await fs
        .writeFile(path.join(artifacts, "failure.html"), await page.content())
        .catch(() => {});
    }
    await fs.writeFile(
      path.join(artifacts, "failure.txt"),
      String(error.stack || error),
    );
    throw error;
  } finally {
    if (context)
      await context.tracing.stop({
        path: path.join(artifacts, "native-positron-trace.zip"),
      });
    await browser.close();
  }
};
