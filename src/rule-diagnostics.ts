import * as vscode from "vscode";
import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { createHash } from "node:crypto";
import { basename, dirname, isAbsolute, relative, sep } from "node:path";
export interface SourcePosition {
  line: number;
  character: number;
}
export interface RuleLocation {
  rule: string;
  status: "failed" | "error" | "warning";
  severity: "error" | "warning";
  path: string;
  file_hash: string;
  start: SourcePosition;
  end: SourcePosition;
}
export interface SourceDocument {
  path: string;
  dirty: boolean;
  text: string;
}
interface VerifiedSource {
  path: string;
  text: string;
}
const MAX_BYTES = 1048576;
const hash = (bytes: Uint8Array | string) =>
  createHash("sha256").update(bytes).digest("hex");

export function validSourceRange(
  text: string,
  start: SourcePosition,
  end: SourcePosition,
): boolean {
  const lines = text.split(/\r\n|\n|\r/);
  const valid = (position: SourcePosition) => {
    if (
      !Number.isSafeInteger(position.line) ||
      !Number.isSafeInteger(position.character) ||
      position.line < 0 ||
      position.character < 0
    )
      return false;
    const line = lines[position.line];
    if (line === undefined || position.character > line.length) return false;
    // A UTF-16 range must not split a surrogate pair.
    const before = line.charCodeAt(position.character - 1),
      after = line.charCodeAt(position.character);
    return !(
      before >= 0xd800 &&
      before <= 0xdbff &&
      after >= 0xdc00 &&
      after <= 0xdfff
    );
  };
  return (
    valid(start) &&
    valid(end) &&
    (start.line < end.line ||
      (start.line === end.line && start.character < end.character))
  );
}

export async function verifiedSource(
  path: string,
  expectedHash: string,
  roots: readonly string[],
  documents: readonly SourceDocument[],
): Promise<VerifiedSource | undefined> {
  if (!isAbsolute(path) || !/^[a-f0-9]{64}$/.test(expectedHash)) return;
  try {
    const canonical = await realpath(path);
    const allowed = await Promise.all(
      roots.map(async (root) => {
        try {
          const rel = relative(await realpath(root), canonical);
          return (
            rel !== "" &&
            rel !== ".." &&
            !rel.startsWith(`..${sep}`) &&
            !isAbsolute(rel)
          );
        } catch {
          return false;
        }
      }),
    );
    if (!allowed.some(Boolean)) return;
    const before = await lstat(canonical);
    if (!before.isFile() || before.size > MAX_BYTES) return;
    const file = await open(
      canonical,
      constants.O_RDONLY |
        (constants.O_NOFOLLOW ?? 0) |
        (constants.O_NONBLOCK ?? 0),
    );
    let bytes: Buffer;
    try {
      const stat = await file.stat();
      if (!stat.isFile() || stat.size > MAX_BYTES) return;
      const buffer = Buffer.alloc(MAX_BYTES + 1);
      const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
      if (bytesRead > MAX_BYTES) return;
      bytes = buffer.subarray(0, bytesRead);
    } finally {
      await file.close();
    }
    if (hash(bytes) !== expectedHash || (await realpath(path)) !== canonical)
      return;
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    for (const document of documents) {
      let documentPath: string;
      try {
        documentPath = await realpath(document.path);
      } catch {
        continue;
      }
      if (
        documentPath === canonical &&
        (document.dirty || hash(document.text) !== expectedHash)
      )
        return;
    }
    return { path: canonical, text };
  } catch {
    return;
  }
}

export class RuleDiagnostics implements vscode.Disposable {
  private collection =
    vscode.languages.createDiagnosticCollection("dataraft-r-rules");
  private generation = 0;
  private watchers: vscode.Disposable[] = [];
  private changes = vscode.workspace.onDidChangeTextDocument(() =>
    this.clear(),
  );
  clear(): void {
    this.generation++;
    this.collection.clear();
    for (const watcher of this.watchers) watcher.dispose();
    this.watchers = [];
  }
  dispose(): void {
    this.clear();
    this.changes.dispose();
    this.collection.dispose();
  }
  private async documents(path: string): Promise<SourceDocument[]> {
    const result: SourceDocument[] = [];
    let canonical: string;
    try {
      canonical = await realpath(path);
    } catch {
      return result;
    }
    for (const doc of vscode.workspace.textDocuments) {
      if (doc.uri.scheme !== "file") continue;
      try {
        if ((await realpath(doc.uri.fsPath)) !== canonical) continue;
      } catch {
        continue;
      }
      const tooLarge = doc.offsetAt(doc.positionAt(MAX_BYTES + 1)) > MAX_BYTES;
      result.push({
        path: doc.uri.fsPath,
        dirty: doc.isDirty || tooLarge,
        text: tooLarge ? "" : doc.getText(),
      });
    }
    return result;
  }
  async show(
    items: readonly RuleLocation[],
    current: () => boolean,
  ): Promise<{ shown: number; omitted: number }> {
    this.clear();
    const generation = this.generation;
    const roots = (vscode.workspace.workspaceFolders ?? [])
      .filter((folder) => folder.uri.scheme === "file")
      .map((folder) => folder.uri.fsPath);
    const sources = new Map<string, VerifiedSource | undefined>();
    const grouped = new Map<
      string,
      { source: VerifiedSource; hash: string; diagnostics: vscode.Diagnostic[] }
    >();
    for (const item of items.slice(0, 500)) {
      const key = `${item.path}\0${item.file_hash}`;
      if (!sources.has(key)) {
        if (sources.size >= 32) continue;
        sources.set(
          key,
          await verifiedSource(
            item.path,
            item.file_hash,
            roots,
            await this.documents(item.path),
          ),
        );
      }
      const source = sources.get(key);
      if (!source || !validSourceRange(source.text, item.start, item.end))
        continue;
      const diagnostic = new vscode.Diagnostic(
        new vscode.Range(
          item.start.line,
          item.start.character,
          item.end.line,
          item.end.character,
        ),
        `DataRaft rule ${item.rule.replace(/[\x00-\x1f\x7f]/g, " ").slice(0, 200)}: ${item.status}.`,
        item.severity === "warning"
          ? vscode.DiagnosticSeverity.Warning
          : vscode.DiagnosticSeverity.Error,
      );
      diagnostic.source = "DataRaft R";
      const group = grouped.get(source.path) ?? {
        source,
        hash: item.file_hash,
        diagnostics: [],
      };
      group.diagnostics.push(diagnostic);
      grouped.set(source.path, group);
    }
    if (generation !== this.generation || !current())
      return { shown: 0, omitted: items.length };
    // Subscribe before the final content check so external changes cannot leave old markers.
    for (const path of grouped.keys()) {
      const watcher = vscode.workspace.createFileSystemWatcher(
        new vscode.RelativePattern(dirname(path), basename(path)),
      );
      this.watchers.push(
        watcher,
        watcher.onDidChange(() => this.clear()),
        watcher.onDidDelete(() => this.clear()),
        watcher.onDidCreate(() => this.clear()),
      );
    }
    for (const [path, group] of grouped) {
      if (
        !(await verifiedSource(
          path,
          group.hash,
          roots,
          await this.documents(path),
        ))
      )
        grouped.delete(path);
    }
    if (generation !== this.generation || !current())
      return { shown: 0, omitted: items.length };
    let shown = 0;
    for (const [path, group] of grouped) {
      this.collection.set(vscode.Uri.file(path), group.diagnostics);
      shown += group.diagnostics.length;
    }
    return { shown, omitted: items.length - shown };
  }
}
