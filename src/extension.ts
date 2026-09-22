import * as vscode from "vscode";
import {
  tryAcquirePositronApi,
  PositronApi,
  BaseLanguageRuntimeSession,
} from "@posit-dev/positron";
import { randomBytes } from "node:crypto";
import { BridgeTransport, RequestInput } from "./transport";
import {
  Context,
  Envelope,
  Graph,
  Operation,
  Product,
  ProductDetail,
  RecordRow,
  items,
  validateEnvelope,
} from "./protocol";
import { MetadataNode, MetadataTree } from "./tree";
import { lineageHtml } from "./render";
import { registerYamlEditor } from "./contract-editor";
export function activate(context: vscode.ExtensionContext): void {
  const api = tryAcquirePositronApi();
  const controller = new Controller(context, api);
  context.subscriptions.push(controller);
  registerYamlEditor(context);
}
export function deactivate(): void {}
class Controller implements vscode.Disposable {
  private generation = 0;
  private sessionId: string | undefined;
  private contextHandle = "workspace";
  private contextLabel = "Workspace";
  private offline: vscode.Uri | undefined;
  private snapshots = new Map<Operation, Envelope>();
  private details = new Map<string, ProductDetail>();
  private trees = new Map<string, MetadataTree>();
  private views = new Map<string, vscode.TreeView<MetadataNode>>();
  private transport: BridgeTransport;
  private disposables: vscode.Disposable[] = [];
  constructor(
    private context: vscode.ExtensionContext,
    private api: PositronApi | undefined,
  ) {
    this.transport = new BridgeTransport(
      async (code, id) => {
        const session = await this.session(id);
        const state = session.getRuntimeState?.();
        if (state && state !== "idle" && state !== "ready")
          throw new Error(
            "The selected R session is busy. Wait for it to become idle.",
          );
        return this.api!.runtime.executeCode(
          "r",
          code,
          false,
          false,
          undefined,
          undefined,
          undefined,
          id,
        );
      },
      vscode.workspace
        .getConfiguration("dataraft")
        .get<number>("requestTimeoutSeconds", 30) * 1000,
    );
    for (const kind of [
      "products",
      "quality",
      "runs",
      "freshness",
      "incidents",
    ]) {
      const tree = new MetadataTree(
        kind === "products" ? (p) => this.loadDetail(p) : undefined,
      );
      const view = vscode.window.createTreeView(`dataraft.${kind}`, {
        treeDataProvider: tree,
        showCollapseAll: true,
      });
      view.message = "Not refreshed. Metadata updates only when requested.";
      this.trees.set(kind, tree);
      this.views.set(kind, view);
      this.disposables.push(tree, view);
    }
    const command = (name: string, fn: (...args: any[]) => unknown) =>
      this.disposables.push(
        vscode.commands.registerCommand(
          `dataraft.${name}`,
          (...args: unknown[]) =>
            Promise.resolve()
              .then(() => fn(...args))
              .catch((e) =>
                vscode.window.showErrorMessage(
                  e instanceof Error ? e.message : "DataRaft command failed.",
                ),
              ),
        ),
      );
    command("selectSession", () => this.selectSession());
    command("selectContext", () => this.selectContext());
    command("refresh", () => this.refresh());
    command("openMetadata", () => this.openMetadata());
    command("inspect", (node?: MetadataNode) => this.inspect(node));
    command("trial", (node?: MetadataNode) => this.trial(node));
    command("view", (node?: MetadataNode) => this.viewRows(node));
    command("lineage", (node?: MetadataNode) => this.lineage(node));
    command("reports", () => this.reports());
    command("validateContract", (uri?: vscode.Uri) =>
      this.validateContract(uri),
    );
    command("profile", () => this.profile());
    command("sampleQuality", (uri?: vscode.Uri) => this.sampleQuality(uri));
    this.disposables.push(
      vscode.workspace.onDidGrantWorkspaceTrust(() =>
        vscode.commands.executeCommand("setContext", "dataraft.trusted", true),
      ),
    );
    void vscode.commands.executeCommand(
      "setContext",
      "dataraft.available",
      !!api,
    );
    void vscode.commands.executeCommand(
      "setContext",
      "dataraft.hasMetadata",
      false,
    );
  }
  dispose(): void {
    this.transport.dispose();
    for (const item of this.disposables) item.dispose();
  }
  private async session(
    id = this.sessionId,
  ): Promise<BaseLanguageRuntimeSession> {
    if (!vscode.workspace.isTrusted)
      throw new Error(
        "Trust this workspace before requesting R execution. Offline JSON and YAML remain available.",
      );
    if (
      !this.api ||
      typeof this.api.runtime.getActiveSessions !== "function" ||
      typeof this.api.runtime.executeCode !== "function"
    )
      throw new Error(
        "A compatible Positron R session is required. In VS Code, use Open Metadata JSON or the YAML editor.",
      );
    if (!id) throw new Error("Select an existing R console session first.");
    const found = (await this.api.runtime.getActiveSessions()).find(
      (s) =>
        s.metadata.sessionId === id &&
        s.runtimeMetadata.languageId.toLowerCase() === "r" &&
        s.metadata.sessionMode === "console",
    );
    if (!found)
      throw new Error(
        "The selected R console session is no longer available. Select another session.",
      );
    return found;
  }
  private async selectSession(): Promise<void> {
    if (!vscode.workspace.isTrusted)
      throw new Error("Trust this workspace before selecting an R session.");
    if (!this.api)
      throw new Error(
        "R session integration requires Positron. Open Metadata JSON for offline inspection.",
      );
    const sessions = (await this.api.runtime.getActiveSessions()).filter(
      (s) =>
        s.runtimeMetadata.languageId.toLowerCase() === "r" &&
        s.metadata.sessionMode === "console",
    );
    if (!sessions.length)
      throw new Error(
        "Start an R console in Positron first. DataRaft does not start sessions.",
      );
    const picked = await vscode.window.showQuickPick(
      sessions.map((s) => ({
        label: s.runtimeMetadata.runtimeName,
        description: s.metadata.sessionId,
        session: s,
      })),
      {
        placeHolder:
          "Select the existing R session whose workspace you want to inspect",
      },
    );
    if (!picked) return;
    this.sessionId = picked.session.metadata.sessionId;
    this.contextHandle = "workspace";
    this.contextLabel = "Workspace";
    this.offline = undefined;
    this.clear();
    for (const view of this.views.values())
      view.message = `${picked.label} selected. Refresh to request metadata.`;
  }
  private async selectContext(): Promise<void> {
    const response = await this.request({ operation: "contexts" });
    const contexts = items<Context>(response);
    const choice = await vscode.window.showQuickPick(
      contexts.map((c) => ({
        label: c.label,
        description: c.kind,
        context: c,
      })),
      {
        placeHolder:
          "Select workspace definitions or an explicitly connected lake",
      },
    );
    if (!choice) return;
    this.contextHandle = choice.context.handle;
    this.contextLabel = choice.label;
    this.offline = undefined;
    this.clear();
    await this.refresh();
  }
  private clear(): void {
    this.generation++;
    this.snapshots.clear();
    this.details.clear();
    for (const tree of this.trees.values()) tree.clear();
    void vscode.commands.executeCommand(
      "setContext",
      "dataraft.hasMetadata",
      false,
    );
  }
  private async request(input: RequestInput): Promise<Envelope> {
    const generation = this.generation;
    const contextHandle = this.contextHandle;
    const session = await this.session();
    const id = session.metadata.sessionId;
    const state = session.getRuntimeState?.();
    if (state && state !== "idle" && state !== "ready") {
      throw new Error(
        "The selected R session is busy. Wait for it to become idle.",
      );
    }
    const config = vscode.workspace.getConfiguration("dataraft");
    return vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: `DataRaft: ${input.operation}`,
        cancellable: true,
      },
      async (_progress, token) => {
        const abort = new AbortController();
        const cancel = token.onCancellationRequested(() => abort.abort());
        try {
          const response = await this.transport.request(
            id,
            {
              context: contextHandle,
              limit: config.get<number>("maximumItems", 100),
              ...input,
            },
            abort.signal,
          );
          if (response.error)
            throw new Error(
              `${response.error.message} (${response.error.code})`,
            );
          if (this.sessionId !== id || this.generation !== generation)
            throw new Error(
              "Session or context changed while the request was pending. Refresh in the selected session.",
            );
          return response;
        } finally {
          cancel.dispose();
        }
      },
    );
  }
  private apply(response: Envelope): void {
    this.snapshots.set(response.kind as Operation, response);
    const tree = this.trees.get(response.kind);
    if (tree) tree.set(response);
    const truncated = (response.data as { truncated?: boolean } | null)
      ?.truncated;
    const label = `${this.offline ? "Offline" : this.contextLabel} · ${response.generated}${truncated ? " · truncated" : ""}`;
    const view = this.views.get(response.kind);
    if (view) {
      view.description = response.generated;
      view.message = `${label}. Manual refresh only.`;
    }
    void vscode.commands.executeCommand(
      "setContext",
      "dataraft.hasMetadata",
      true,
    );
  }
  private async refresh(): Promise<void> {
    if (this.offline) {
      await this.loadOffline(this.offline);
      return;
    }
    const generation = this.generation;
    await this.session();
    this.details.clear();
    for (const operation of [
      "products",
      "quality",
      "runs",
      "freshness",
      "incidents",
    ] as const) {
      try {
        if (this.generation !== generation) return;
        this.apply(await this.request({ operation }));
      } catch (e) {
        if (this.generation !== generation) return;
        const view = this.views.get(operation);
        if (view)
          view.message = `Refresh failed; displayed metadata may be stale. ${e instanceof Error ? e.message : ""}`;
        if (operation === "products") throw e;
      }
    }
  }
  private async loadDetail(
    product: Product,
  ): Promise<ProductDetail | undefined> {
    const cached = this.details.get(product.handle);
    if (cached) return cached;
    if (this.offline) return undefined;
    const response = await this.request({
      operation: "product",
      handle: product.handle,
    });
    const detail = response.data as ProductDetail;
    this.details.set(product.handle, detail);
    return detail;
  }
  private async pickProduct(
    node?: MetadataNode,
  ): Promise<MetadataNode | undefined> {
    if (node?.product) return node;
    const roots = this.trees.get("products")!.roots;
    return (
      await vscode.window.showQuickPick(
        roots.map((node) => ({
          label: node.label,
          description: node.description,
          node,
        })),
        { placeHolder: "Select a product from the refreshed metadata" },
      )
    )?.node;
  }
  private async json(value: unknown, title?: string): Promise<void> {
    const document = await vscode.workspace.openTextDocument({
      language: "json",
      content: JSON.stringify(value, null, 2),
    });
    await vscode.window.showTextDocument(document, { preview: true });
    if (title) vscode.window.setStatusBarMessage(title, 4000);
  }
  private async inspect(node?: MetadataNode): Promise<void> {
    if (node && !node.product) {
      await this.json(
        node.value ?? { label: node.label, description: node.description },
      );
      return;
    }
    const selected = await this.pickProduct(node);
    if (!selected?.product) return;
    const detail = await this.loadDetail(selected.product);
    if (detail) {
      this.trees.get("products")!.populate(selected, detail);
      if (this.contextHandle !== "workspace" && !this.offline) {
        const releases = await this.request({
          operation: "releases",
          handle: selected.product.handle,
        });
        this.trees
          .get("products")!
          .attachReleases(selected, items<RecordRow>(releases));
      }
    }
    await this.json(detail ?? selected.product);
  }
  private async trial(node?: MetadataNode): Promise<void> {
    const selected = await this.pickProduct(node);
    if (!selected?.product) return;
    if (this.offline || !selected.product.can_trial)
      throw new Error(
        "This item cannot be trialled. Select a workspace product in a live R session.",
      );
    const response = await this.request({
      operation: "trial",
      handle: selected.product.handle,
    });
    const data = response.data as {
      handle: string;
      status: string;
      result: ProductDetail;
    };
    this.details.set(data.handle, data.result);
    const result = new MetadataNode(
      data.handle,
      data.result.id,
      `Trial: ${data.status}`,
      data.result,
      data.result,
    );
    this.trees.get("products")!.roots.push(result);
    this.trees.get("products")!.populate(result, data.result);
    this.trees.get("products")!.refresh();
    await this.json(
      response,
      "Trial completed. No configured target was published.",
    );
  }
  private async viewRows(node?: MetadataNode): Promise<void> {
    const selected = await this.pickProduct(node);
    if (!selected?.product) return;
    if (this.offline || !selected.product.can_view)
      throw new Error(
        "Rows are available only for an existing table or completed result in a live R session. Trial the product first if needed.",
      );
    await this.request({
      operation: "view",
      handle: selected.product.handle,
      row_limit: vscode.workspace
        .getConfiguration("dataraft")
        .get<number>("maximumRows", 100),
    });
    vscode.window.setStatusBarMessage(
      "DataRaft requested a bounded table in the R data viewer.",
      5000,
    );
  }
  private async lineage(node?: MetadataNode): Promise<void> {
    const cached = this.snapshots.get("lineage");
    const response = this.offline
      ? cached
      : await this.request({
          operation: "lineage",
          ...(node?.product ? { handle: node.product.handle } : {}),
        });
    if (!response)
      throw new Error(
        "This offline snapshot does not contain lineage. Open a lineage metadata JSON file.",
      );
    this.snapshots.set("lineage", response);
    const graph = response.data as Graph;
    const panel = vscode.window.createWebviewPanel(
      "dataraft.lineage",
      "DataRaft Lineage",
      vscode.ViewColumn.Beside,
      { enableScripts: true, localResourceRoots: [] },
    );
    panel.webview.html = lineageHtml(
      graph,
      response.generated,
      randomBytes(18).toString("base64"),
    );
    panel.webview.onDidReceiveMessage(
      async (message) => {
        if (
          !message ||
          message.type !== "focus" ||
          !Number.isInteger(message.index)
        )
          return;
        const item = graph.nodes[message.index];
        if (!item) return;
        const tree = this.trees.get("products")!;
        const found = tree.roots.find((n) => n.product?.id === item.id);
        if (found)
          await this.views
            .get("products")!
            .reveal(found, { select: true, focus: true, expand: true });
        else
          vscode.window.setStatusBarMessage(
            "This lineage node has no product in the current product snapshot.",
            5000,
          );
      },
      undefined,
      this.disposables,
    );
  }
  private async reports(): Promise<void> {
    const response = this.offline
      ? this.snapshots.get("reports")
      : await this.request({ operation: "reports" });
    if (!response)
      throw new Error(
        "Open a report metadata snapshot or select a live lake context.",
      );
    this.snapshots.set("reports", response);
    await this.json(response);
  }
  private async savedContract(
    uri?: vscode.Uri,
  ): Promise<vscode.Uri | undefined> {
    if (!uri) {
      uri = (
        await vscode.window.showOpenDialog({
          canSelectMany: false,
          filters: { "ODCS contract": ["yaml", "yml"] },
        })
      )?.[0];
    }
    if (!uri) return;
    if (uri.scheme !== "file")
      throw new Error(
        "Choose a contract on the R and extension host filesystem.",
      );
    const document = await vscode.workspace.openTextDocument(uri);
    if (document.isDirty)
      throw new Error(
        "Save the contract before validating its exact saved content.",
      );
    return uri;
  }
  private async validateContract(uri?: vscode.Uri): Promise<void> {
    const saved = await this.savedContract(uri);
    if (saved)
      await this.json(
        await this.request({
          operation: "validate_contract",
          file_path: saved.fsPath,
        }),
      );
  }
  private async profile(): Promise<Envelope | undefined> {
    const selected = await this.pickProduct();
    if (!selected?.product) return;
    if (this.offline || selected.product.kind !== "table")
      throw new Error(
        "Select an in-memory workspace table in a live R session.",
      );
    const response = await this.request({
      operation: "profile",
      handle: selected.product.handle,
    });
    await this.json(response);
    return response;
  }
  private async sampleQuality(uri?: vscode.Uri): Promise<Envelope | undefined> {
    const selected = await this.pickProduct();
    if (!selected?.product) return;
    if (this.offline || selected.product.kind !== "table")
      throw new Error(
        "Select an in-memory workspace table in a live R session.",
      );
    const saved = await this.savedContract(uri);
    if (saved) {
      const response = await this.request({
        operation: "sample_quality",
        handle: selected.product.handle,
        file_path: saved.fsPath,
        row_limit: vscode.workspace
          .getConfiguration("dataraft")
          .get<number>("maximumRows", 100),
      });
      await this.json(response);
      return response;
    }
  }
  private async openMetadata(): Promise<void> {
    const choice = await vscode.window.showOpenDialog({
      canSelectMany: false,
      filters: { "DataRaft metadata": ["json"] },
      openLabel: "Open metadata snapshot",
    });
    if (choice?.[0]) await this.loadOffline(choice[0]);
  }
  private async loadOffline(uri: vscode.Uri): Promise<void> {
    if (uri.scheme !== "file")
      throw new Error("Choose a JSON file on the extension host filesystem.");
    if ((await vscode.workspace.fs.stat(uri)).size > 1048576)
      throw new Error("Metadata file exceeds 1 MiB.");
    const bytes = await vscode.workspace.fs.readFile(uri);
    if (bytes.byteLength > 1048576)
      throw new Error("Metadata file exceeds 1 MiB.");
    let value: unknown;
    try {
      value = JSON.parse(Buffer.from(bytes).toString("utf8"));
    } catch {
      throw new Error("Metadata file is not valid JSON.");
    }
    const response = validateEnvelope(value);
    if (response.error) throw new Error(response.error.message);
    if (!this.offline) this.clear();
    this.offline = uri;
    if (response.kind === "product") {
      const detail = response.data as ProductDetail;
      this.details.set(detail.handle, detail);
      const node = new MetadataNode(
        detail.handle,
        detail.id,
        detail.status,
        detail,
        detail,
      );
      this.trees.get("products")!.roots = [node];
      this.trees.get("products")!.populate(node, detail);
      this.trees.get("products")!.refresh();
      this.views.get("products")!.description = response.generated;
      this.views.get("products")!.message =
        `Offline · ${response.generated}. Manual refresh only.`;
      void vscode.commands.executeCommand(
        "setContext",
        "dataraft.hasMetadata",
        true,
      );
    } else this.apply(response);
    if (response.kind === "lineage") await this.lineage();
    else if (!this.trees.has(response.kind)) await this.json(response);
  }
}
