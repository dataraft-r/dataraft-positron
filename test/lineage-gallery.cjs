// Synthetic visual-review fixtures rendered with the production HTML function.
const fs = require("node:fs/promises");
const path = require("node:path");
const { lineageHtml } = require("../dist/render");
const names = [
  "customers.raw",
  "policies.raw",
  "brokers.raw",
  "customers.clean",
  "policies.clean",
  "brokers.clean",
  "portfolio.joined",
  "portfolio.validated",
  "risk.exposure",
  "risk.lapses",
  "finance.reserves",
  "report.monthly",
];
const graphs = {
  products: {
    nodes: names.map((id) => ({ id, kind: "product" })),
    edges: [
      [0, 3],
      [1, 4],
      [2, 5],
      [3, 6],
      [4, 6],
      [5, 6],
      [6, 7],
      [7, 8],
      [7, 9],
      [7, 10],
      [8, 11],
      [9, 11],
      [10, 11],
    ].map(([a, b]) => ({ from: names[a], to: names[b], relation: "derived" })),
    truncated: false,
  },
  chain: {
    nodes: names.map((id) => ({ id, kind: "product" })),
    edges: names
      .slice(1)
      .map((id, i) => ({ from: names[i], to: id, relation: "derived" }))
      .reverse(),
    truncated: false,
  },
  cycle: {
    nodes: [
      "input",
      "cycle.a",
      "cycle.b",
      "cycle.c",
      "output",
      "unrelated",
    ].map((id) => ({ id, kind: "product" })),
    edges: [
      ["input", "cycle.a"],
      ["cycle.a", "cycle.b"],
      ["cycle.b", "cycle.c"],
      ["cycle.c", "cycle.a"],
      ["cycle.c", "output"],
    ].map(([from, to]) => ({ from, to, relation: "derived" })),
    truncated: false,
  },
};
exports.graphs = graphs;
exports.capture = async function (vscode, page, artifacts, until) {
  const panel = vscode.window.createWebviewPanel(
    "dataraft.visualReview",
    "DataRaft visual review: 12 products",
    vscode.ViewColumn.One,
    { enableScripts: true },
  );
  const settings = vscode.workspace.getConfiguration("workbench");
  const previous = settings.inspect("colorTheme");
  try {
    for (const [theme, label] of [
      ["Default Light Modern", "light"],
      ["Default Dark Modern", "dark"],
    ]) {
      await settings.update(
        "colorTheme",
        theme,
        vscode.ConfigurationTarget.Workspace,
      );
      panel.webview.html = lineageHtml(
        graphs.products,
        "2026-09-22T00:00:00Z",
        `review${label}`,
      );
      const frame = await until(async () => {
        for (const candidate of page.frames()) {
          if (
            (await candidate.locator(".graph .node").count()) === 12 &&
            (await candidate.locator(`body.vscode-${label}`).count())
          )
            return candidate;
        }
      }, `12 product lineage in native ${label} theme`);
      await frame.locator(".graph .node").first().focus();
      await page.screenshot({
        path: path.join(artifacts, `lineage-12-products-${label}.png`),
      });
    }
  } finally {
    panel.dispose();
    await settings.update(
      "colorTheme",
      previous?.workspaceValue,
      vscode.ConfigurationTarget.Workspace,
    );
  }
};
if (require.main === module)
  (async () => {
    const directory = process.argv[2];
    if (!directory) throw new Error("Supply a visual fixture output directory");
    await fs.mkdir(directory, { recursive: true });
    for (const [name, graph] of Object.entries(graphs))
      for (const dark of [false, true]) {
        const css = `:root{--vscode-font-size:14px;--vscode-font-family:Arial,sans-serif;--vscode-foreground:${dark ? "#ddd" : "#222"};--vscode-editor-background:${dark ? "#181818" : "#fff"};--vscode-focusBorder:#007acc;--vscode-panel-border:${dark ? "#555" : "#ccc"};--vscode-descriptionForeground:${dark ? "#aaa" : "#555"}}`;
        const html = lineageHtml(graph, "2026-09-22T00:00:00Z", "review")
          .replace('<style nonce="review">', `<style nonce="review">${css}`)
          .replace(
            "const vscode=acquireVsCodeApi();",
            "const vscode={postMessage:message=>document.title=JSON.stringify(message)};",
          );
        await fs.writeFile(
          path.join(directory, `${name}-${dark ? "dark" : "light"}.html`),
          html,
        );
      }
  })().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
