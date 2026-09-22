import Ajv2020 from "ajv/dist/2020";
import addFormats from "ajv-formats";
import bridgeSchema from "../schemas/bridge-v1.json";
import diagnosticsSchema from "../schemas/bridge-v2.json";
export const CONTRACT = 1 as const;
export const OPERATIONS = [
  "contexts",
  "products",
  "product",
  "lineage",
  "quality",
  "releases",
  "runs",
  "freshness",
  "incidents",
  "reports",
  "view",
  "trial",
  "profile",
  "validate_contract",
  "sample_quality",
] as const;
export type Operation = (typeof OPERATIONS)[number] | "diagnostics";
export type Scalar = string | number | boolean | null;
export type RecordRow = Record<string, Scalar>;
export interface Product {
  handle: string;
  id: string;
  version: string | null;
  status: string;
  kind: string;
  owner: string | null;
  description: string | null;
  source_count: number;
  rule_count: number;
  can_trial: boolean;
  can_view: boolean;
}
export interface ProductDetail extends Product {
  contract: null | {
    id: string | null;
    version: string | null;
    columns: { name: string; type: string | null; required: boolean }[];
    key: string[];
  };
  sources: { name: string; kind: string; product_id: string | null }[];
  rules: {
    id: string;
    engine: string | null;
    action: string | null;
    dimension: string | null;
  }[];
}
export interface Context {
  handle: string;
  label: string;
  kind: "workspace" | "lake";
}
export interface Graph {
  nodes: { id: string; kind: string }[];
  edges: { from: string; to: string; relation: string }[];
  truncated: boolean;
}
export interface Envelope {
  contract: typeof CONTRACT | 2;
  generated: string;
  kind: Operation | "error";
  request_id: string | null;
  data: unknown;
  error: null | { code: string; message: string };
}
export interface Request {
  version: 1 | 2;
  request_id: string;
  response_path: string;
  operation: Operation;
  context?: string;
  handle?: string;
  limit?: number;
  row_limit?: number;
  file_path?: string;
}
const ajv = new Ajv2020({
  allErrors: false,
  strict: false,
  ownProperties: true,
});
addFormats(ajv);
const validateSchema = ajv.compile(bridgeSchema);
const validateDiagnosticsSchema = ajv.compile(diagnosticsSchema);
function reject(): never {
  throw new Error("Invalid or unsupported DataRaft metadata response.");
}
function enforceBounds(value: unknown): void {
  const pending: { value: unknown; depth: number }[] = [{ value, depth: 0 }];
  let visited = 0;
  while (pending.length) {
    const item = pending.pop()!;
    if (++visited > 100000 || item.depth > 32) reject();
    if (typeof item.value === "string" && item.value.length > 16384) reject();
    if (typeof item.value === "number" && !Number.isFinite(item.value))
      reject();
    if (Array.isArray(item.value) && item.value.length > 10000) reject();
    if (item.value && typeof item.value === "object") {
      for (const child of Object.values(item.value))
        pending.push({ value: child, depth: item.depth + 1 });
    }
  }
}
export function validateEnvelope(
  value: unknown,
  expected?: { requestId: string; operation: Operation; version?: 1 | 2 },
): Envelope {
  enforceBounds(value);
  const version = (value as { contract?: unknown } | null)?.contract;
  if (
    version === 2 ? !validateDiagnosticsSchema(value) : !validateSchema(value)
  )
    reject();
  const response = value as unknown as Envelope;
  if (!/^\d{4}-\d{2}-\d{2}T.*Z$/.test(response.generated)) reject();
  if (
    expected &&
    (response.request_id !== expected.requestId ||
      (response.kind !== expected.operation && response.kind !== "error"))
  ) {
    throw new Error("DataRaft response does not match the active request.");
  }
  if (expected && response.contract !== (expected.version ?? 1)) {
    if (expected.version === 2 && response.contract === 1 && response.error)
      throw new Error(
        "R rule diagnostics require dataraft.ide with protocol v2. Update the R bridge package and retry.",
      );
    throw new Error(
      "DataRaft response protocol does not match the active request.",
    );
  }
  if (response.kind === "lineage" && !response.error) {
    const graph = response.data as Graph;
    const ids = new Set(graph.nodes.map((node) => node.id));
    if (
      ids.size !== graph.nodes.length ||
      graph.edges.some((edge) => !ids.has(edge.from) || !ids.has(edge.to))
    )
      reject();
  }
  return response;
}
export function items<T>(response: Envelope): T[] {
  return (response.data as { items: T[] }).items;
}
export function rBridgeCode(request: Request): string {
  const text = JSON.stringify(request);
  if (Buffer.byteLength(text) > 16384)
    throw new Error("DataRaft request exceeds 16 KiB.");
  const encoded = Buffer.from(text, "utf8").toString("base64");
  return `dataraft.ide::ide_request("${encoded}")`;
}
