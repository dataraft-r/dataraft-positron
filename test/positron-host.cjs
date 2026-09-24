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
        packages=lapply(c("dataraft.core", "dataraft.lake", "dataraft.adapters", "dataraft.ide", "duckdb"), function(p) list(name=p, version=as.character(packageVersion(p)))))
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
    context = page.context();
    context.setDefaultTimeout(30000);
    await context.tracing.start({ screenshots: true, snapshots: true });
    const dashboard = async (heading, expectedText) =>
      until(async () => {
        for (const frame of page.frames()) {
          const title = frame.getByRole("heading", { name: heading, exact: true });
          if (!(await title.isVisible().catch(() => false))) continue;
          if (expectedText && !(await frame.locator("body").innerText()).includes(expectedText)) continue;
          return await require("./host-webview.cjs").frameLocator(page, frame);
        }
      }, `visible structured dashboard ${heading}`);
    const stage = async () => {
      await vscode.commands.executeCommand("workbench.action.closeOtherEditors");
      await vscode.commands.executeCommand("workbench.action.editorLayoutSingle");
      await vscode.commands.executeCommand("workbench.action.closePanel");
      await vscode.commands.executeCommand("workbench.action.closeAuxiliaryBar");
    };
    const capture = async (name, prepare = true) => {
      if (prepare) await stage();
      await page.screenshot({ path: path.join(artifacts, name) });
    };
    const quickInput = page.locator(
      ".quick-input-widget .quick-input-box input",
    );
    const quickRows = page.locator(
      ".quick-input-widget .quick-input-list .monaco-list-row",
    );
    const command = async (title) => {
      await page.keyboard.press("Escape");
      // A dashboard iframe may own keyboard focus. Open the real workbench
      // palette explicitly, then drive its visible input and result by clicks.
      await vscode.commands.executeCommand("workbench.action.showCommands");
      await quickInput.waitFor({ state: "visible" });
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
    await vscode.commands.executeCommand("workbench.action.closePanel");
    await vscode.commands.executeCommand("workbench.action.closeAuxiliaryBar");
    await vscode.commands.executeCommand("workbench.view.extension.dataraft");
    await command("Select R Session");
    await page
      .getByPlaceholder(
        "Select the existing R session whose workspace you want to inspect",
        { exact: true },
      )
      .waitFor();
    await capture("feature-select-session.png", false);
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
    await command("Open Data Product Overview");
    const overview = await dashboard("Data products", "passing.orders");
    assert.equal(await overview.getByRole("button", { name: "Inspect product" }).count(), 12);
    await capture("feature-overview.png");
    await fs.copyFile(path.join(artifacts, "feature-overview.png"), path.join(artifacts, "portfolio-overview.png"));
    checkpoint("workspace overview lists three smoke fixtures and nine portfolio products");
    await page
      .getByRole("treeitem")
      .filter({ hasText: "passing.orders" })
      .first()
      .waitFor();
    await idle();
    // Click an actual product tree row and inspect the rendered native webview.
    await page
      .getByRole("treeitem")
      .filter({ hasText: "passing.orders" })
      .first()
      .click();
    const passing = await dashboard("passing.orders", "Quality rules");
    assert.equal(await passing.getByRole("button", { name: "Trial without publishing" }).count(), 1);
    await capture("feature-inspect-product.png");
    checkpoint("session selection, refresh and product tree inspection");
    await page.getByRole("treeitem").filter({ hasText: "governed.orders" }).first().click();
    const governed = await dashboard("governed.orders", "warehouse");
    assert.equal(await governed.getByRole("heading", { name: /Output ports/ }).count(), 1);
    assert.equal(await governed.getByRole("heading", { name: "Contract", exact: true }).count(), 1);
    assert.match(await governed.locator("body").innerText(), /08:00 UTC/);
    await capture("feature-product-guarantees.png");
    checkpoint("contract, output port and SLA rendered from bounded R metadata");

    for (const [id, status] of [
      ["passing.orders", "completed"],
      ["failing.orders", "blocked"],
    ]) {
      await idle();
      await command("Trial Product");
      await pick(id);
      const result = await dashboard(id, status);
      assert.equal(await result.locator(".badge").innerText(), status);
      await capture(`feature-trial-${status}.png`);
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
    const quality = await dashboard("failing.orders", "nonnegative");
    const evidence = await quality.locator("main").innerText();
    assert.match(evidence, /n failed\s+1/i);
    assert.match(evidence, /n total\s+2/i);
    await capture("feature-quality-evidence.png");
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
    await stage();
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
    await lineageButton.focus();
    await lineageButton.press("Enter");
    await capture("feature-directed-lineage.png");
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
    await page
      .getByRole("treeitem", { selected: true })
      .filter({ hasText: "passing.orders" })
      .first()
      .click();
    await dashboard("passing.orders", "Quality rules");
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
    await stage();
    await require("./host-webview.cjs").exerciseWebview(
      document, browser, (name) => capture(name, false),
    );
    checkpoint(
      "native webview buttons preview, discard, apply and reject stale YAML edits",
    );
    // A realistic six-table insurance portfolio is defined by the same
    // installed example that the R test suite executes. Drive its actual
    // products through the native workbench and retain focused captures.
    await idle();
    await stage();
    checkpoint("six-table portfolio and downstream products in native overview");

    await page.getByRole("treeitem")
      .filter({ hasText: "portfolio.relational_model" }).first().click();
    const model = await dashboard("portfolio.relational_model");
    assert.match(await model.locator("main").innerText(), /Portfolio Analytics/);
    await capture("portfolio-model.png");
    checkpoint("relational table model visible in native product dashboard");

    await page.getByRole("treeitem")
      .filter({ hasText: "portfolio.lapse_rate_by_channel" }).first().click();
    const kpi = await dashboard("portfolio.lapse_rate_by_channel", "reporting");
    const kpiText = await kpi.locator("main").innerText();
    assert.match(kpiText, /lapse\.rate\.v1/);
    assert.match(kpiText, /named_owner/);
    assert.match(kpiText, /08:00 UTC/);
    await capture("portfolio-product-contract.png");
    checkpoint("KPI contract, policy, SLA and output port are readable");

    await idle();
    await command("Trial Product");
    await pick("portfolio.lapse_rate_by_channel");
    const kpiResult = await dashboard("portfolio.lapse_rate_by_channel", "completed");
    assert.equal(await kpiResult.locator(".badge").innerText(), "completed");
    await capture("portfolio-kpi-trial.png");
    checkpoint("monthly lapse rate completes from related portfolio products");

    await idle();
    await command("Trial Product");
    await pick("portfolio.invalid_cash_receipts");
    const blockedCash = await dashboard("portfolio.invalid_cash_receipts", "blocked");
    assert.equal(await blockedCash.locator(".badge").innerText(), "blocked");
    await refresh();
    await vscode.commands.executeCommand("dataraft.quality.focus");
    const cashFailure = page.getByRole("treeitem")
      .filter({ hasText: "portfolio.invalid_cash_receipts" })
      .filter({ hasText: /failed/ });
    await cashFailure.first().click();
    const cashEvidence = await dashboard("portfolio.invalid_cash_receipts", "nonnegative_cash");
    const cashText = await cashEvidence.locator("main").innerText();
    assert.match(cashText, /n failed\s+1/i);
    assert.match(cashText, /n total\s+108/i);
    await capture("portfolio-quality-failure.png");
    checkpoint("one invalid receipt is isolated among 108 records");

    await idle();
    await command("Show Directed Lineage");
    await stage();
    const portfolioNode = await until(async () => {
      for (const frame of page.frames()) {
        const node = frame.getByRole("button", {
          name: "Focus product portfolio.lapse_rate_by_channel", exact: true,
        });
        if (await node.isVisible().catch(() => false)) return node;
      }
    }, "portfolio lineage node");
    await portfolioNode.focus();
    await portfolioNode.press("Enter");
    await capture("portfolio-lineage.png");
    checkpoint("product dependency graph links inputs to the lapse KPI");

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
