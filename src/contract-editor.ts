import * as vscode from "vscode";
import { randomBytes } from "node:crypto";
import {
  inspectContract,
  editContract,
  assertSnapshot,
  contentHash,
  Field,
  Operation,
  profileColumnProposals,
  sampleRuleIssues,
  Issue,
} from "./contract-document";
import { Envelope } from "./protocol";
import { escapeHtml, htmlDocument } from "./render";

const snapshots = new Map<string, string>();
let snapshotId = 0;
function snapshot(text: string, name: string): vscode.Uri {
  const uri = vscode.Uri.from({
    scheme: "dataraft-contract-preview",
    path: `/${++snapshotId}/${name}.yaml`,
  });
  snapshots.set(uri.toString(), text);
  return uri;
}
async function diskText(uri: vscode.Uri): Promise<string> {
  if (uri.scheme === "untitled") return "";
  return Buffer.from(await vscode.workspace.fs.readFile(uri)).toString("utf8");
}
function input(field: Field): string {
  const path = escapeHtml(JSON.stringify(field.path));
  const attrs = `data-field="${path}" data-kind="${field.kind}"`;
  const control = field.choices
    ? `<select ${attrs}>${field.choices.map((choice) => `<option${choice === field.value ? " selected" : ""}>${escapeHtml(choice)}</option>`).join("")}</select>`
    : field.kind === "boolean"
      ? `<input ${attrs} type="checkbox"${field.value ? " checked" : ""}>`
      : `<input ${attrs} type="${field.kind === "number" ? "number" : "text"}"${field.kind === "number" ? ' step="any"' : ""} value="${escapeHtml(field.value)}">`;
  return `<label>${escapeHtml(field.label)} ${control}</label>`;
}
export function registerYamlEditor(context: vscode.ExtensionContext): void {
  const diagnostics =
    vscode.languages.createDiagnosticCollection("dataraft-odcs");
  context.subscriptions.push(
    diagnostics,
    vscode.workspace.registerTextDocumentContentProvider(
      "dataraft-contract-preview",
      {
        provideTextDocumentContent: (uri) =>
          snapshots.get(uri.toString()) ?? "",
      },
    ),
  );
  context.subscriptions.push(
    vscode.workspace.onDidCloseTextDocument((doc) => {
      if (doc.uri.scheme === "dataraft-contract-preview")
        snapshots.delete(doc.uri.toString());
    }),
  );
  const provider: vscode.CustomTextEditorProvider = {
    async resolveCustomTextEditor(document, panel) {
      panel.webview.options = { enableScripts: true, localResourceRoots: [] };
      let diskBaseline = contentHash(await diskText(document.uri));
      let proposal:
        | { text: string; version: number; diskHash: string; edited: string }
        | undefined;
      let commands = Promise.resolve();
      let pendingCommands = 0;
      let disposed = false;
      let rendered: { body: string; script: string } | undefined;
      let sampleIssues: Issue[] = [];
      const update = (): void => {
        if (disposed) return;
        let body: string;
        try {
          const form = inspectContract(document.getText());
          diagnostics.set(
            document.uri,
            [...form.issues, ...sampleIssues].map(
              (issue) =>
                new vscode.Diagnostic(
                  new vscode.Range(
                    document.positionAt(issue.start),
                    document.positionAt(issue.end),
                  ),
                  issue.message,
                  issue.severity === "warning"
                    ? vscode.DiagnosticSeverity.Warning
                    : vscode.DiagnosticSeverity.Error,
                ),
            ),
          );
          body = `<h1>ODCS contract</h1><p>The YAML document is authoritative. Preview edits, then apply them to the unsaved document. Saving remains explicit.</p><p class="muted">This editor checks YAML and field types. Predicate execution and full import compatibility are validated by DataRaft in R.</p><button data-command="text">Open YAML text</button> <button data-command="diff">Compare with saved file</button> <button data-command="validate">Validate saved contract in R</button> <button data-command="profile">Propose columns from R sample</button> <button data-command="sample">Check selected R sample</button>`;
          if (form.issues.length)
            body += `<h2>Fix YAML diagnostics</h2><ul>${form.issues.map((issue) => `<li>${escapeHtml(issue.message)}</li>`).join("")}</ul>`;
          else {
            body += `<form id="contract-form"><h2>Contract</h2>${form.fields.map(input).join("")}<h2>Columns</h2>${form.columns.map((fields, index) => `<fieldset><legend>Column ${index + 1}</legend>${fields.map(input).join("")}<button type="button" data-operation="removeColumn" data-index="${index}">Preview removing column</button></fieldset>`).join("")}<button type="button" data-operation="addColumn">Preview new column</button><h2>Quality rules</h2>${form.rules.map((fields, index) => `<fieldset><legend>Rule ${index + 1}</legend>${fields.map(input).join("")}<button type="button" data-operation="removeRule" data-index="${index}">Preview removing rule</button></fieldset>`).join("")}<button type="button" data-operation="addRule">Preview new rule</button><p><button type="submit">Preview field edits</button></p></form>`;
          }
          if (proposal)
            body +=
              '<p role="status">A proposed edit is open in the diff viewer. Apply only after reviewing it.</p><button data-command="apply">Apply preview to document</button> <button data-command="discard">Discard preview</button>';
        } catch (error) {
          body = `<h1>Contract editor</h1><p role="alert">${escapeHtml(error instanceof Error ? error.message : "Unable to read YAML.")}</p><button data-command="text">Open YAML text</button>`;
        }
        const script = `const api=acquireVsCodeApi();const version=${document.version};for(const el of document.querySelectorAll('[data-command]'))el.addEventListener('click',()=>api.postMessage({type:el.dataset.command,version}));for(const el of document.querySelectorAll('[data-operation]'))el.addEventListener('click',()=>api.postMessage({type:'preview',version,operations:[{kind:el.dataset.operation,...(el.dataset.index===undefined?{}:{index:Number(el.dataset.index)})}]}));const original=new Map([...document.querySelectorAll('[data-field]')].map(el=>[el,el.type==='checkbox'?el.checked:el.value]));document.getElementById('contract-form')?.addEventListener('submit',event=>{event.preventDefault();const operations=[];for(const [el,old] of original){const value=el.type==='checkbox'?el.checked:el.value;if(value!==old)operations.push({kind:'set',path:JSON.parse(el.dataset.field),value:el.dataset.kind==='number'?Number(value):value});}api.postMessage({type:'preview',version,operations});});`;
        // An applyEdit change event and its completion can request the same
        // render. Reloading an unchanged webview would discard in-flight typing.
        if (rendered?.body === body && rendered.script === script) return;
        rendered = { body, script };
        panel.webview.html = htmlDocument(
          "DataRaft ODCS Contract",
          body,
          randomBytes(16).toString("hex"),
          script,
        );
      };
      const disposables = [
        vscode.workspace.onDidChangeTextDocument((event) => {
          if (event.document.uri.toString() === document.uri.toString()) {
            // Change events may precede the dirty flag becoming true. Only an
            // explicit save can advance the initial authoritative disk baseline.
            proposal = undefined;
            sampleIssues = [];
            update();
          }
        }),
        vscode.workspace.onDidSaveTextDocument((saved) => {
          if (saved.uri.toString() === document.uri.toString()) {
            diskBaseline = contentHash(saved.getText());
            proposal = undefined;
            sampleIssues = [];
            update();
          }
        }),
        panel.webview.onDidReceiveMessage((message) => {
          if (disposed) return;
          if (pendingCommands >= 8) {
            void vscode.window.showErrorMessage(
              "Too many pending editor actions. Wait for the current action to finish and try again.",
            );
            return;
          }
          pendingCommands++;
          // A refreshed iframe can submit the new document version before an
          // applyEdit promise settles. Serialize actions instead of losing clicks.
          const next = commands.then(async () => {
            try {
              if (disposed) return;
              if (
                !message ||
                typeof message !== "object" ||
                message.version !== document.version
              )
                throw new Error(
                  "The document changed. Use the refreshed editor.",
                );
              if (message.type === "text") {
                await vscode.commands.executeCommand(
                  "vscode.openWith",
                  document.uri,
                  "default",
                );
                return;
              }
              if (message.type === "diff") {
                await showSavedDiff(document);
                return;
              }
              if (message.type === "profile") {
                const captured = {
                  text: document.getText(),
                  version: document.version,
                  diskHash: diskBaseline,
                };
                const response = await vscode.commands.executeCommand<
                  Envelope | undefined
                >("dataraft.profile");
                if (!response || response.error || response.kind !== "profile")
                  return;
                const choices = profileColumnProposals(
                  captured.text,
                  response.data,
                ).map((item) => ({
                  label: item.name,
                  description: item.detail,
                  operation: item.operation,
                  picked: false,
                }));
                if (!choices.length) {
                  void vscode.window.showInformationMessage(
                    "No supported column changes were found in this sample.",
                  );
                  return;
                }
                const selected = await vscode.window.showQuickPick(choices, {
                  canPickMany: true,
                  title: "Select inferred columns to preview",
                  placeHolder:
                    "Choose explicitly; required flags reflect this sample only.",
                });
                if (!selected?.length) return;
                const currentDisk = contentHash(await diskText(document.uri));
                assertSnapshot(captured, {
                  text: document.getText(),
                  version: document.version,
                  diskHash: currentDisk,
                });
                const edited = editContract(
                  captured.text,
                  selected.map((item) => item.operation),
                );
                proposal = { ...captured, edited };
                update();
                // Displaying immutable snapshots must not lock enabled Apply/Discard
                // controls while the editor host is still opening the diff tab.
                const displayedProposal = proposal;
                void vscode.commands
                  .executeCommand(
                    "vscode.diff",
                    snapshot(captured.text, "current"),
                    snapshot(edited, "profile-proposal"),
                    "DataRaft: proposed sample columns",
                  )
                  .then(undefined, (error: unknown) => {
                    if (proposal === displayedProposal) {
                      proposal = undefined;
                      update();
                    }
                    void vscode.window.showErrorMessage(
                      error instanceof Error
                        ? error.message
                        : "Could not open the preview diff.",
                    );
                  });
                return;
              }
              if (message.type === "validate" || message.type === "sample") {
                if (document.isDirty || document.uri.scheme !== "file")
                  throw new Error(
                    "Save the YAML document explicitly before requesting R validation.",
                  );
                const captured = {
                  text: document.getText(),
                  version: document.version,
                  diskHash: diskBaseline,
                };
                const before = contentHash(await diskText(document.uri));
                assertSnapshot(captured, {
                  text: document.getText(),
                  version: document.version,
                  diskHash: before,
                });
                if (before !== contentHash(captured.text))
                  throw new Error(
                    "The saved file differs from this document. Reconcile it before checking a sample.",
                  );
                const response = await vscode.commands.executeCommand<
                  Envelope | undefined
                >(
                  message.type === "validate"
                    ? "dataraft.validateContract"
                    : "dataraft.sampleQuality",
                  document.uri,
                );
                if (
                  message.type === "sample" &&
                  response &&
                  !response.error &&
                  response.kind === "sample_quality"
                ) {
                  const after = contentHash(await diskText(document.uri));
                  assertSnapshot(captured, {
                    text: document.getText(),
                    version: document.version,
                    diskHash: after,
                  });
                  sampleIssues = sampleRuleIssues(captured.text, response.data);
                  update();
                  if (!sampleIssues.length)
                    void vscode.window.showInformationMessage(
                      "No failed sample checks could be mapped to unique explicit YAML rule names. Review the quality response for all results.",
                    );
                }
                return;
              }
              if (message.type === "discard") {
                proposal = undefined;
                update();
                return;
              }
              if (message.type === "preview") {
                const text = document.getText(),
                  version = document.version;
                const edited = editContract(
                  text,
                  message.operations as Operation[],
                );
                const currentDisk = contentHash(await diskText(document.uri));
                assertSnapshot(
                  { text, version, diskHash: diskBaseline },
                  {
                    text: document.getText(),
                    version: document.version,
                    diskHash: currentDisk,
                  },
                );
                proposal = { text, version, diskHash: currentDisk, edited };
                update();
                // The proposal is complete; opening its immutable diff is not a
                // document mutation and must not block subsequent button actions.
                const displayedProposal = proposal;
                void vscode.commands
                  .executeCommand(
                    "vscode.diff",
                    snapshot(text, "current"),
                    snapshot(edited, "proposed"),
                    "DataRaft: proposed YAML edit",
                  )
                  .then(undefined, (error: unknown) => {
                    if (proposal === displayedProposal) {
                      proposal = undefined;
                      update();
                    }
                    void vscode.window.showErrorMessage(
                      error instanceof Error
                        ? error.message
                        : "Could not open the preview diff.",
                    );
                  });
              } else if (message.type === "apply") {
                if (!proposal)
                  throw new Error("Preview an edit before applying it.");
                const pending = proposal;
                const currentDisk = contentHash(await diskText(document.uri));
                assertSnapshot(pending, {
                  text: document.getText(),
                  version: document.version,
                  diskHash: currentDisk,
                });
                const edit = new vscode.WorkspaceEdit();
                edit.replace(
                  document.uri,
                  new vscode.Range(
                    document.positionAt(0),
                    document.positionAt(pending.text.length),
                  ),
                  pending.edited,
                );
                // Do not await between the final version check and submitting the edit.
                // applyEdit captures the open document version and refuses stale edits.
                if (!(await vscode.workspace.applyEdit(edit)))
                  throw new Error(
                    "The editor refused the edit because the document changed. Preview again.",
                  );
                proposal = undefined;
                update();
              }
            } catch (error) {
              void vscode.window.showErrorMessage(
                error instanceof Error
                  ? error.message
                  : "The YAML edit could not be completed.",
              );
            } finally {
              pendingCommands--;
            }
          });
          // Keep the queue usable even if an unexpected host callback rejects.
          commands = next.catch(() => {});
          return next;
        }),
      ];
      panel.onDidDispose(() => {
        disposed = true;
        proposal = undefined;
        disposables.forEach((disposable) => disposable.dispose());
        diagnostics.delete(document.uri);
      });
      update();
    },
  };
  context.subscriptions.push(
    vscode.window.registerCustomEditorProvider(
      "dataraft.contractYaml",
      provider,
      { supportsMultipleEditorsPerDocument: false },
    ),
  );
  context.subscriptions.push(
    vscode.commands.registerCommand(
      "dataraft.editYaml",
      async (uri?: vscode.Uri) => {
        uri ??= vscode.window.activeTextEditor?.document.uri;
        if (!uri)
          uri = (
            await vscode.window.showOpenDialog({
              canSelectMany: false,
              filters: { YAML: ["yaml", "yml"] },
            })
          )?.[0];
        if (uri)
          await vscode.commands.executeCommand(
            "vscode.openWith",
            uri,
            "dataraft.contractYaml",
          );
      },
    ),
  );
  context.subscriptions.push(
    vscode.commands.registerCommand(
      "dataraft.yamlDiff",
      async (uri?: vscode.Uri) => {
        const document = uri
          ? await vscode.workspace.openTextDocument(uri)
          : vscode.window.activeTextEditor?.document;
        if (!document) {
          void vscode.window.showInformationMessage(
            "Open a YAML text document or use Compare with saved file in the contract editor.",
          );
          return;
        }
        await showSavedDiff(document);
      },
    ),
  );
}
async function showSavedDiff(document: vscode.TextDocument): Promise<void> {
  await vscode.commands.executeCommand(
    "vscode.diff",
    snapshot(await diskText(document.uri), "saved"),
    snapshot(document.getText(), "current"),
    "DataRaft: saved and current YAML",
  );
}
