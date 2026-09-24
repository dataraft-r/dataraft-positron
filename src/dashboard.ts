import {
  Envelope,
  Port,
  Product,
  ProductDetail,
  RecordRow,
  items,
} from "./protocol";
import { escapeHtml, htmlDocument } from "./render";

const styles = `
body{max-width:1100px;margin:auto;padding:clamp(1rem,3vw,2.5rem)}
.eyebrow{font-size:.78rem;letter-spacing:.09em;text-transform:uppercase;color:var(--vscode-descriptionForeground)}
.heading{display:flex;align-items:flex-start;justify-content:space-between;gap:1rem;flex-wrap:wrap}
.heading h1{margin:.2rem 0;font-size:clamp(1.5rem,3vw,2.2rem);overflow-wrap:anywhere}
.actions{display:flex;gap:.65rem;flex-wrap:wrap;margin:1.3rem 0 2rem}
.actions button{min-height:36px;border-radius:5px}.actions .secondary{background:transparent;color:var(--vscode-foreground);border-color:var(--vscode-panel-border)}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,290px),1fr));gap:1rem}
.card{border:1px solid var(--vscode-panel-border);border-radius:8px;padding:1rem 1.2rem;background:var(--vscode-sideBar-background)}
.card h2{margin:0 0 .8rem;font-size:1.08rem}.card p{margin:.45rem 0}
.wide{grid-column:1/-1}.badge{display:inline-flex;border:1px solid var(--vscode-panel-border);border-radius:999px;padding:.15rem .65rem;font-weight:600}
.pairs{display:grid;grid-template-columns:minmax(90px,32%) 1fr;gap:.55rem 1rem;margin:0}.pairs dt{color:var(--vscode-descriptionForeground)}.pairs dd{margin:0;overflow-wrap:anywhere}
.item{border-top:1px solid var(--vscode-panel-border);padding:.75rem 0}.item:first-of-type{border-top:0}.item strong{overflow-wrap:anywhere}
.meta{font-size:.88rem;color:var(--vscode-descriptionForeground)}.notice{border-inline-start:3px solid var(--vscode-editorWarning-foreground);padding:.7rem 1rem;background:var(--vscode-editor-inactiveSelectionBackground)}
.scroll{overflow-x:auto}table{width:100%}th{white-space:nowrap}td{overflow-wrap:anywhere}caption{text-align:start;margin-bottom:.7rem;color:var(--vscode-descriptionForeground)}
@media(max-width:500px){.pairs{grid-template-columns:1fr;gap:.1rem}.pairs dd{margin-bottom:.7rem}}
`;
const value = (x: string | number | boolean | null | undefined): string =>
  x === null || x === undefined || x === "" ? "Not specified" : escapeHtml(x);
const pair = (key: string, x: string | number | boolean | null | undefined) =>
  `<dt>${escapeHtml(key)}</dt><dd>${value(x)}</dd>`;
const empty = (message: string) =>
  `<p class="muted">${escapeHtml(message)}</p>`;
const actionScript = `const api=acquireVsCodeApi();document.querySelectorAll('[data-action]').forEach(button=>button.addEventListener('click',()=>api.postMessage({action:button.dataset.action})));`;

function portCard(port: Port): string {
  const sla = port.sla;
  return `<div class="item"><strong>${escapeHtml(port.id)}</strong> <span class="meta">v${value(port.version)} · ${value(port.access)}</span>
  ${sla ? `<p>Due ${value(sla.available_by)} ${value(sla.timezone)} · ${value(sla.refresh)}${sla.freshness === null ? "" : ` · Freshness ${value(sla.freshness)} h`}</p>` : '<p class="meta">No delivery SLA defined</p>'}
  ${port.contract_version ? `<p class="meta">Contract version ${value(port.contract_version)}</p>` : ""}</div>`;
}

export function productHtml(
  detail: ProductDetail,
  generated: string,
  nonce: string,
): string {
  const g = detail.guarantees;
  const columns = detail.contract?.columns ?? [];
  const actions = [
    detail.can_trial
      ? '<button data-action="trial">Trial without publishing</button>'
      : "",
    detail.can_view
      ? '<button class="secondary" data-action="view">View bounded rows in R</button>'
      : "",
    '<button class="secondary" data-action="lineage">View lineage</button>',
    '<button class="secondary" data-action="refresh">Refresh details</button>',
  ].join("");
  const ports = (direction: "inputs" | "outputs") => {
    const list = g?.[direction] ?? [];
    return `<section class="card"><h2>${direction === "inputs" ? "Input" : "Output"} ports <span class="meta">${list.length}</span></h2>${list.map(portCard).join("") || empty("No ports declared.")}</section>`;
  };
  const body = `<header class="heading"><div><div class="eyebrow">Data product · ${escapeHtml(detail.kind)}</div><h1>${escapeHtml(detail.id)}</h1><p>${value(detail.description)}</p></div><span class="badge">${value(g?.lifecycle ?? detail.status)}</span></header>
  <p class="meta">Snapshot ${escapeHtml(generated)} · Refresh to load current R metadata</p>
  <div class="actions">${actions}</div>
  ${!g ? '<p class="notice">This R bridge does not expose lifecycle and port details. Update dataraft.ide to see these guarantees.</p>' : ""}
  <main class="grid">
    <section class="card"><h2>Identity and governance</h2><dl class="pairs">${pair("Owner", detail.owner)}${pair("Version", detail.version)}${pair("Lifecycle", g?.lifecycle)}${pair("Configured policies", g?.policy_count)}${pair("Status", detail.status)}</dl>${g?.lifecycle === "draft" ? '<p class="meta">A draft can still publish unless your organization enforces an active-only policy.</p>' : ""}</section>
    <section class="card"><h2>Contract</h2><dl class="pairs">${pair("ID", detail.contract?.id)}${pair("Version", detail.contract?.version)}${pair("Key", detail.contract?.key.join(", "))}${pair("Columns", columns.length)}</dl>${!detail.contract ? empty("No contract declared. A trial without a declared contract does not independently validate its inferred schema.") : ""}</section>
    ${ports("inputs")}${ports("outputs")}
    <section class="card wide"><h2>Columns</h2>${columns.length ? `<div class="scroll"><table><thead><tr><th scope="col">Column</th><th scope="col">Type</th><th scope="col">Required</th></tr></thead><tbody>${columns.map((c) => `<tr><th scope="row">${escapeHtml(c.name)}</th><td>${value(c.type)}</td><td>${c.required ? "Yes" : "No"}</td></tr>`).join("")}</tbody></table></div>` : empty("No columns in this snapshot.")}</section>
    <section class="card"><h2>Quality rules <span class="meta">${detail.rules.length}</span></h2>${detail.rules.map((r) => `<div class="item"><strong>${escapeHtml(r.id)}</strong><p class="meta">${value(r.action)} · ${value(r.engine)}${r.dimension ? ` · ${escapeHtml(r.dimension)}` : ""}</p></div>`).join("") || empty("No quality rules declared.")}</section>
    <section class="card"><h2>Sources <span class="meta">${detail.sources.length}</span></h2>${detail.sources.map((s) => `<div class="item"><strong>${escapeHtml(s.name)}</strong><p class="meta">${value(s.kind)}${s.product_id ? ` · ${escapeHtml(s.product_id)}` : ""}</p></div>`).join("") || empty("No sources declared.")}</section>
  </main>`;
  return htmlDocument(
    `DataRaft · ${detail.id}`,
    body,
    nonce,
    actionScript,
    styles,
  );
}

const columnsFor: Record<string, [string, string][]> = {
  reports: [
    ["Report", "id"],
    ["Created", "created_at"],
  ],
  quality: [
    ["Product", "asset"],
    ["Rule", "rule"],
    ["Status", "status"],
    ["Failed", "n_failed"],
    ["Checked", "n_total"],
  ],
  sample_quality: [
    ["Rule", "rule"],
    ["Status", "status"],
    ["Failed", "n_failed"],
    ["Checked", "n_total"],
  ],
  incidents: [
    ["Product", "asset"],
    ["Rule", "rule"],
    ["Status", "status"],
    ["Failed", "n_failed"],
  ],
  runs: [
    ["Product", "asset"],
    ["Status", "status"],
    ["Started", "started_at"],
    ["Finished", "finished_at"],
  ],
  freshness: [
    ["Product", "asset"],
    ["Status", "freshness"],
    ["Latest release", "published_at"],
    ["Age (hours)", "age_hours"],
  ],
  releases: [
    ["Product", "asset"],
    ["Release", "release_id"],
    ["Published", "published_at"],
    ["Quality", "quality"],
  ],
};

export function snapshotHtml(response: Envelope, nonce: string): string {
  const labels = columnsFor[response.kind];
  if (!labels) throw new Error(`No structured view for ${response.kind}.`);
  const data = response.data as { items: RecordRow[]; truncated: boolean };
  const rows = items<RecordRow>(response);
  const body = `<header><div class="eyebrow">DataRaft · ${escapeHtml(response.kind.replaceAll("_", " "))}</div><h1>${escapeHtml(response.kind.replaceAll("_", " "))}</h1><p class="meta">Snapshot ${escapeHtml(response.generated)} · Updates only when requested</p></header>
  ${data.truncated ? '<p class="notice">The snapshot is limited. Increase the metadata limit to see more records.</p>' : ""}
  <main class="card scroll">${rows.length ? `<table><caption>${rows.length} records in this snapshot</caption><thead><tr>${labels.map(([label]) => `<th scope="col">${escapeHtml(label)}</th>`).join("")}</tr></thead><tbody>${rows.map((row) => `<tr>${labels.map(([, key], i) => (i === 0 ? `<th scope="row">${value(row[key])}</th>` : `<td>${value(row[key])}</td>`)).join("")}</tr>`).join("")}</tbody></table>` : empty("No records in this snapshot.")}</main>`;
  return htmlDocument(`DataRaft · ${response.kind}`, body, nonce, "", styles);
}

export function recordHtml(
  title: string,
  record: unknown,
  nonce: string,
): string {
  const fields =
    record && typeof record === "object" && !Array.isArray(record)
      ? Object.entries(record as Record<string, unknown>).filter(
          ([, v]) =>
            v === null || ["string", "number", "boolean"].includes(typeof v),
        )
      : [["Value", record]];
  const body = `<div class="eyebrow">DataRaft · detail</div><h1>${escapeHtml(title)}</h1><main class="card"><dl class="pairs">${fields.map(([key, val]) => pair(String(key).replaceAll("_", " "), val === null || ["string", "number"].includes(typeof val) ? (val as string | number | null) : String(val))).join("")}</dl>${!fields.length ? empty("No scalar metadata in this item. Open its product for the full overview.") : ""}</main>`;
  return htmlDocument(`DataRaft · ${title}`, body, nonce, "", styles);
}

export function contractHtml(
  title: string,
  contract: ProductDetail["contract"],
  nonce: string,
): string {
  if (!contract) return recordHtml(title, {}, nonce);
  const body = `<div class="eyebrow">DataRaft · contract</div><h1>${escapeHtml(title)}</h1>
    <p class="meta">This is a metadata view. Review the saved YAML before making changes.</p>
    <main class="grid"><section class="card"><h2>Contract</h2><dl class="pairs">${pair("ID", contract.id)}${pair("Version", contract.version)}${pair("Key", contract.key.join(", "))}${pair("Columns", contract.columns.length)}</dl></section>
    <section class="card wide"><h2>Columns</h2>${contract.columns.length ? `<div class="scroll"><table><thead><tr><th scope="col">Name</th><th scope="col">Type</th><th scope="col">Required</th></tr></thead><tbody>${contract.columns.map((c) => `<tr><th scope="row">${escapeHtml(c.name)}</th><td>${value(c.type)}</td><td>${c.required ? "Yes" : "No"}</td></tr>`).join("")}</tbody></table></div>` : empty("No columns in this contract.")}</section></main>`;
  return htmlDocument(`DataRaft · ${title}`, body, nonce, "", styles);
}

export function overviewHtml(
  products: Product[],
  quality: RecordRow[],
  runs: RecordRow[],
  generated: string,
  nonce: string,
): string {
  const issues = quality.filter((row) =>
    ["failed", "blocked", "warning", "error"].includes(
      String(row.status).toLowerCase(),
    ),
  );
  const body = `<div class="eyebrow">DataRaft · workspace</div><h1>Data products</h1>
    <p class="meta">Snapshot ${escapeHtml(generated)} · Refresh metadata to see changes in R</p>
    <div class="grid" aria-label="Workspace summary">
      <section class="card"><h2>Products</h2><p><strong>${products.filter((p) => p.kind === "product" || p.kind === "asset").length}</strong> defined or registered</p></section>
      <section class="card"><h2>Quality</h2><p><strong>${issues.length}</strong> warning or failed rules in this snapshot</p></section>
      <section class="card"><h2>Runs</h2><p><strong>${runs.length}</strong> recent records in this snapshot</p></section>
      <section class="card wide"><h2>Explore products</h2>${products.length ? products.map((p, index) => `<div class="item heading"><div><strong>${escapeHtml(p.id)}</strong><p class="meta">${escapeHtml(p.kind)} · ${escapeHtml(p.status)} · ${p.rule_count} rules</p></div><button data-product="${index}">Inspect product</button></div>`).join("") : empty("No products in this snapshot. Select an R session and refresh metadata.")}</section>
    </div>`;
  const script = `const api=acquireVsCodeApi();document.querySelectorAll('[data-product]').forEach(button=>button.addEventListener('click',()=>api.postMessage({type:'product',index:Number(button.dataset.product)})));`;
  return htmlDocument("DataRaft overview", body, nonce, script, styles);
}
