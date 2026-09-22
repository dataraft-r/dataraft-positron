import * as vscode from "vscode";
import { Envelope, Product, ProductDetail, RecordRow, items } from "./protocol";
export class MetadataNode {
  parent?: MetadataNode;
  children?: MetadataNode[];
  constructor(
    public readonly id: string,
    public readonly label: string,
    public description = "",
    public product?: Product,
    public value?: unknown,
  ) {}
  add(children: MetadataNode[]): MetadataNode {
    this.children = children;
    for (const child of children) child.parent = this;
    return this;
  }
}
export class MetadataTree implements vscode.TreeDataProvider<MetadataNode> {
  private changed = new vscode.EventEmitter<MetadataNode | undefined>();
  readonly onDidChangeTreeData = this.changed.event;
  roots: MetadataNode[] = [];
  constructor(
    private load?: (product: Product) => Promise<ProductDetail | undefined>,
  ) {}
  refresh(): void {
    this.changed.fire(undefined);
  }
  dispose(): void {
    this.changed.dispose();
  }
  set(response: Envelope): void {
    if (response.kind === "products")
      this.roots = items<Product>(response).map(
        (p) =>
          new MetadataNode(
            p.handle,
            p.id,
            `${p.status}${p.version ? ` · ${p.version}` : ""}`,
            p,
            p,
          ),
      );
    else
      this.roots = items<RecordRow>(response).map((row, index) =>
        new MetadataNode(
          `${response.kind}:${index}`,
          String(row.asset ?? row.id ?? row.run_id ?? row.rule ?? "Record"),
          String(row.status ?? row.freshness ?? row.created_at ?? ""),
          undefined,
          row,
        ).add(
          Object.entries(row).map(
            ([key, value]) =>
              new MetadataNode(
                `${response.kind}:${index}:${key}`,
                key,
                value === null ? "Not available" : String(value),
                undefined,
                { [key]: value },
              ),
          ),
        ),
      );
    this.changed.fire(undefined);
  }
  clear(): void {
    this.roots = [];
    this.changed.fire(undefined);
  }
  async getChildren(node?: MetadataNode): Promise<MetadataNode[]> {
    if (!node) return this.roots;
    if (node.product && !node.children && this.load) {
      const detail = await this.load(node.product);
      if (detail) this.populate(node, detail);
      else
        node.add([
          new MetadataNode(
            `${node.id}:unavailable`,
            "Details unavailable in this snapshot",
          ),
        ]);
    }
    return node.children ?? [];
  }
  populate(node: MetadataNode, detail: ProductDetail): void {
    node.value = detail;
    const make = (group: string, rows: unknown[]) =>
      new MetadataNode(`${node.id}:${group}`, group).add(
        rows.map((row, i) => {
          const record = row as Record<string, unknown>;
          return new MetadataNode(
            `${node.id}:${group}:${i}`,
            String(record.id ?? record.name ?? i + 1),
            String(record.type ?? record.kind ?? record.engine ?? ""),
            undefined,
            row,
          );
        }),
      );
    const contract = new MetadataNode(
      `${node.id}:contract`,
      "Contract",
      detail.contract?.id ?? "Not defined",
      undefined,
      detail.contract,
    );
    if (detail.contract)
      contract.add([
        new MetadataNode(
          `${node.id}:contract:version`,
          "Version",
          detail.contract.version ?? "Not specified",
        ),
        ...detail.contract.columns.map(
          (c, i) =>
            new MetadataNode(
              `${node.id}:column:${i}`,
              c.name,
              `${c.type}${c.required ? " · required" : ""}`,
              undefined,
              c,
            ),
        ),
      ]);
    node.add([
      contract,
      make("Rules", detail.rules),
      make("Sources", detail.sources),
      new MetadataNode(
        `${node.id}:releases`,
        "Releases",
        "Use lake context to inspect release history",
      ),
    ]);
    this.changed.fire(node);
  }
  attachReleases(node: MetadataNode, rows: RecordRow[]): void {
    const group = node.children?.find((x) => x.id === `${node.id}:releases`);
    if (group) {
      group.description = `${rows.length} in snapshot`;
      group.add(
        rows.map(
          (r) =>
            new MetadataNode(
              `${node.id}:release:${r.release_id}`,
              String(r.release_id),
              String(r.published_at ?? ""),
              undefined,
              r,
            ),
        ),
      );
      this.changed.fire(group);
    }
  }
  getParent(node: MetadataNode): MetadataNode | undefined {
    return node.parent;
  }
  getTreeItem(node: MetadataNode): vscode.TreeItem {
    const expandable =
      !!node.product || (!!node.children && node.children.length > 0);
    const item = new vscode.TreeItem(
      node.label,
      expandable
        ? vscode.TreeItemCollapsibleState.Collapsed
        : vscode.TreeItemCollapsibleState.None,
    );
    item.id = node.id;
    item.description = node.description;
    item.tooltip = `${node.label}${node.description ? `\n${node.description}` : ""}`;
    item.contextValue = node.product
      ? node.product.kind === "result"
        ? "dataraft.result"
        : "dataraft.product"
      : "dataraft.metadata";
    const status = node.product?.status.toLowerCase();
    const appearance =
      status && ["blocked", "failed", "fail", "error"].includes(status)
        ? ["error", "testing.iconFailed"]
        : status && ["warn", "warning", "degraded"].includes(status)
          ? ["warning", "list.warningForeground"]
          : status &&
              [
                "pass",
                "passed",
                "available",
                "published",
                "cached",
                "success",
              ].includes(status)
            ? ["pass", "testing.iconPassed"]
            : undefined;
    item.iconPath = appearance
      ? new vscode.ThemeIcon(
          appearance[0]!,
          new vscode.ThemeColor(appearance[1]!),
        )
      : new vscode.ThemeIcon(
          node.product ? "database" : expandable ? "list-tree" : "symbol-field",
        );
    if (node.value !== undefined)
      item.command = {
        command: "dataraft.inspect",
        title: "Inspect metadata",
        arguments: [node],
      };
    return item;
  }
}
