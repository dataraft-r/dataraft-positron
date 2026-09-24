import type { Graph } from "./protocol";
export function escapeHtml(value: unknown): string {
  return String(value ?? "").replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ]!,
  );
}
export function htmlDocument(
  title: string,
  body: string,
  nonce: string,
  script = "",
  styles = "",
): string {
  return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}';"><title>${escapeHtml(title)}</title><style nonce="${nonce}">
 :root {color-scheme:light dark} body{font:var(--vscode-font-size) var(--vscode-font-family);color:var(--vscode-foreground);background:var(--vscode-editor-background);padding:1.25rem;line-height:1.5}h1{font-size:1.5rem}h2{font-size:1.1rem}button,input,select,textarea{font:inherit;color:var(--vscode-input-foreground);background:var(--vscode-input-background);border:1px solid var(--vscode-input-border);padding:.4rem .65rem}button{cursor:pointer;color:var(--vscode-button-foreground);background:var(--vscode-button-background);border-color:var(--vscode-button-border)}button:hover{background:var(--vscode-button-hoverBackground)}button:focus-visible,input:focus-visible,select:focus-visible,textarea:focus-visible{outline:2px solid var(--vscode-focusBorder);outline-offset:2px}.muted{color:var(--vscode-descriptionForeground)}table{border-collapse:collapse}td,th{text-align:left;vertical-align:top;padding:.5rem;border-bottom:1px solid var(--vscode-panel-border)}label{display:block;margin:.7rem 0}.graph{position:relative;overflow:auto;border:1px solid var(--vscode-panel-border)}.graph svg{display:block}.edge{stroke:var(--vscode-foreground);fill:none;stroke-width:1.5}.edge-arrow{fill:var(--vscode-foreground)}.node rect{fill:var(--vscode-editor-background);stroke:var(--vscode-focusBorder);stroke-width:1.5}.node text{fill:var(--vscode-foreground);font-size:13px}.node{cursor:pointer}.node:focus{outline:none}.node:focus rect{stroke-width:3}.warning{border-left:3px solid var(--vscode-editorWarning-foreground);padding-left:1rem}pre{white-space:pre-wrap;word-break:break-word}a{color:var(--vscode-textLink-foreground)}
 ${styles}</style></head><body>${body}${script ? `<script nonce="${nonce}">${script}</script>` : ""}</body></html>`;
}
/** Rank strongly connected components, then their condensation DAG.
 * Sorting makes positions independent of registry row/edge ordering. Cycles
 * share a column, while every inter-component edge points strictly right.
 */
export function lineageRanks(graph: Graph): Map<string, number> {
  const ids = graph.nodes.map((node) => node.id).sort();
  const adjacency = new Map(ids.map((id) => [id, new Set<string>()]));
  for (const edge of graph.edges) {
    if (adjacency.has(edge.to)) adjacency.get(edge.from)?.add(edge.to);
  }
  let next = 0;
  const indices = new Map<string, number>();
  const low = new Map<string, number>();
  const stack: string[] = [];
  const active = new Set<string>();
  const components: string[][] = [];
  // Explicit DFS frames keep even adversarially deep offline graphs stack safe.
  type Frame = { id: string; targets: string[]; cursor: number };
  const enter = (id: string): Frame => {
    indices.set(id, next);
    low.set(id, next++);
    stack.push(id);
    active.add(id);
    return { id, targets: [...adjacency.get(id)!].sort(), cursor: 0 };
  };
  for (const root of ids) {
    if (indices.has(root)) continue;
    const frames = [enter(root)];
    while (frames.length) {
      const frame = frames[frames.length - 1]!;
      const id = frame.id;
      if (frame.cursor < frame.targets.length) {
        const target = frame.targets[frame.cursor++]!;
        if (!indices.has(target)) frames.push(enter(target));
        else if (active.has(target))
          low.set(id, Math.min(low.get(id)!, indices.get(target)!));
        continue;
      }
      if (low.get(id) === indices.get(id)) {
        const component: string[] = [];
        let member: string;
        do {
          member = stack.pop()!;
          active.delete(member);
          component.push(member);
        } while (member !== id);
        components.push(component.sort());
      }
      frames.pop();
      const parent = frames[frames.length - 1];
      if (parent)
        low.set(parent.id, Math.min(low.get(parent.id)!, low.get(id)!));
    }
  }
  const membership = new Map<string, number>();
  components.forEach((members, index) =>
    members.forEach((id) => membership.set(id, index)),
  );
  const successors = components.map(() => new Set<number>());
  const incoming = components.map(() => 0);
  for (const [from, targets] of adjacency)
    for (const to of targets) {
      const a = membership.get(from)!,
        b = membership.get(to)!;
      if (a !== b && !successors[a]!.has(b)) {
        successors[a]!.add(b);
        incoming[b] = incoming[b]! + 1;
      }
    }
  const ranks = components.map(() => 0);
  const ready = incoming.flatMap((count, index) =>
    count === 0 ? [index] : [],
  );
  for (let cursor = 0; cursor < ready.length; cursor++) {
    const source = ready[cursor]!;
    for (const target of successors[source]!) {
      ranks[target] = Math.max(ranks[target]!, ranks[source]! + 1);
      incoming[target] = incoming[target]! - 1;
      if (incoming[target] === 0) ready.push(target);
    }
  }
  return new Map(ids.map((id) => [id, ranks[membership.get(id)!]!]));
}
export function lineageHtml(
  graph: Graph,
  generated: string,
  nonce: string,
): string {
  if (graph.nodes.length > 500 || graph.edges.length > 500)
    throw new Error(
      "DataRaft lineage supports at most 500 nodes and 500 edges. Request a smaller snapshot.",
    );
  const rank = lineageRanks(graph);
  const counts = new Map<number, number>();
  const locations = new Map<string, { x: number; y: number }>();
  for (const node of [...graph.nodes].sort((a, b) =>
    a.id < b.id ? -1 : a.id > b.id ? 1 : 0,
  )) {
    const column = rank.get(node.id) ?? 0,
      row = counts.get(column) ?? 0;
    counts.set(column, row + 1);
    locations.set(node.id, { x: 20 + column * 220, y: 20 + row * 82 });
  }
  const width = Math.max(300, ...[...locations.values()].map((p) => p.x + 230));
  const height = Math.max(100, ...[...locations.values()].map((p) => p.y + 68));
  const lines = graph.edges
    .map((edge) => {
      const a = locations.get(edge.from),
        b = locations.get(edge.to);
      if (!a || !b) return "";
      const sx = a.x + 180,
        sy = a.y + 25,
        ex = b.x - 6,
        ey = b.y + 25;
      const curve =
        a.x === b.x
          ? `M${sx},${sy} C${sx + 32},${sy - 30} ${sx + 32},${ey + 30} ${b.x + 186},${ey}`
          : `M${sx},${sy} C${sx + 35},${sy} ${ex - 35},${ey} ${ex},${ey}`;
      return `<path class="edge" d="${curve}" marker-end="url(#arrow)"><title>${escapeHtml(edge.from)} to ${escapeHtml(edge.to)}: ${escapeHtml(edge.relation)}</title></path>`;
    })
    .join("");
  const nodes = graph.nodes
    .map((node, index) => {
      const p = locations.get(node.id)!;
      return `<g class="node" role="button" tabindex="0" data-node="${index}" aria-label="Focus product ${escapeHtml(node.id)}" transform="translate(${p.x} ${p.y})"><rect width="180" height="50" rx="5"/><text x="10" y="22">${escapeHtml(node.id.slice(0, 22))}</text><text x="10" y="40">${escapeHtml(node.kind.slice(0, 22))}</text><title>${escapeHtml(node.id)}</title></g>`;
    })
    .join("");
  const list = graph.edges
    .map(
      (edge) =>
        `<li>${escapeHtml(edge.from)} → ${escapeHtml(edge.to)} <span class="muted">(${escapeHtml(edge.relation)})</span></li>`,
    )
    .join("");
  const script = `const vscode=acquireVsCodeApi();for(const node of document.querySelectorAll('[data-node]')){const focus=()=>vscode.postMessage({type:'focus',index:Number(node.dataset.node)});node.addEventListener('click',focus);node.addEventListener('keydown',e=>{if(e.key==='Enter'||e.key===' '){e.preventDefault();focus();}});}`;
  return htmlDocument(
    "DataRaft Lineage",
    `<h1>Directed lineage</h1><p class="muted">Snapshot: ${escapeHtml(generated)}. Updates only when requested.</p>${graph.truncated ? '<p class="warning">This graph is truncated. Increase the metadata limit to inspect more records.</p>' : ""}<div class="graph"><svg width="${width}" height="${height}" role="group" aria-label="Directed lineage graph"><defs><marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path class="edge-arrow" d="M 0 0 L 10 5 L 0 10 z"/></marker></defs>${lines}${nodes}</svg></div><h2>Relationships</h2><ul>${list || "<li>No relationships in this snapshot.</li>"}</ul>`,
    nonce,
    script,
  );
}
