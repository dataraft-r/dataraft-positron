import { createHash } from "node:crypto";
import {
  parseDocument,
  isMap,
  isSeq,
  isScalar,
  isAlias,
  visit,
  Document,
} from "yaml";

export type Path = (string | number)[];
export interface Issue {
  message: string;
  start: number;
  end: number;
  severity?: "warning";
}
export interface Field {
  path: Path;
  label: string;
  value: string | number | boolean;
  kind: "text" | "boolean" | "number";
  choices?: string[];
}
export interface ContractForm {
  fields: Field[];
  columns: Field[][];
  rules: Field[][];
  issues: Issue[];
}
export type Operation =
  | { kind: "profileColumn"; name: string; type: string; required: boolean }
  | { kind: "set"; path: Path; value: string | number | boolean }
  | { kind: "addColumn" | "addRule" }
  | { kind: "removeColumn" | "removeRule"; index: number };
const TYPES = ["string", "integer", "number", "boolean", "date", "timestamp"];
const MAX_BYTES = 1024 * 1024;

export function contentHash(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}
export function assertSnapshot(
  expected: { version: number; text: string; diskHash: string },
  current: { version: number; text: string; diskHash: string },
): void {
  if (expected.version !== current.version || expected.text !== current.text)
    throw new Error(
      "The document changed after this preview. Preview your edit again.",
    );
  if (expected.diskHash !== current.diskHash)
    throw new Error(
      "The saved file changed outside this editor. Preserve unsaved work and review the external change, then close and reopen the contract editor before editing.",
    );
}
function read(text: string): { doc: Document.Parsed; issues: Issue[] } {
  if (Buffer.byteLength(text, "utf8") > MAX_BYTES)
    throw new Error(
      "Contract YAML exceeds the 1 MiB editor limit. Use the text editor.",
    );
  // R's yaml::write_yaml emits YAML 1.1 yes/no booleans. Match the existing
  // safe ODCS importer; explicit YAML directives still govern their document.
  const doc = parseDocument(text, {
    version: "1.1",
    strict: true,
    uniqueKeys: true,
    keepSourceTokens: true,
  });
  const issues: Issue[] = [...doc.errors, ...doc.warnings].map((e) => ({
    message: e.message,
    start: e.pos[0],
    end: Math.max(e.pos[0] + 1, e.pos[1]),
  }));
  let count = 0;
  visit(doc, (_key, node) => {
    if (++count > 20000)
      throw new Error(
        "Contract YAML contains too many nodes for the form editor.",
      );
    if (!node || typeof node !== "object") return;
    if (
      isAlias(node) ||
      ("tag" in node &&
        typeof node.tag === "string" &&
        !node.tag.startsWith("tag:yaml.org,2002:"))
    ) {
      const range = "range" in node ? node.range : undefined;
      issues.push({
        message:
          "Aliases and custom YAML tags are not supported by the form editor. Use plain ODCS values.",
        start: range?.[0] ?? 0,
        end: range?.[1] ?? 1,
      });
    }
  });
  return { doc, issues };
}
export function inspectContract(text: string): ContractForm {
  const { doc, issues } = read(text);
  const form: ContractForm = { fields: [], columns: [], rules: [], issues };
  function issue(path: Path, message: string): void {
    let node = doc.getIn(path, true);
    for (let n = path.length - 1; !node && n >= 0; n--)
      node = doc.getIn(path.slice(0, n), true);
    const range =
      node && typeof node === "object" && "range" in node
        ? (node.range as number[])
        : undefined;
    issues.push({ message, start: range?.[0] ?? 0, end: range?.[1] ?? 1 });
  }
  if (issues.length) return form;
  if (!isMap(doc.contents)) {
    issue([], "An ODCS contract must be a YAML mapping.");
    return form;
  }
  if (doc.get("apiVersion") !== "v3.2.0")
    issue(["apiVersion"], "Use ODCS apiVersion: v3.2.0.");
  if (doc.get("kind") !== "DataContract")
    issue(["kind"], "Use kind: DataContract.");
  const schema = doc.get("schema", true);
  if (!isSeq(schema) || schema.items.length !== 1 || !isMap(schema.items[0])) {
    issue(["schema"], "DataRaft imports exactly one table in schema.");
    return form;
  }
  const tableType = doc.getIn(["schema", 0, "logicalType"]);
  if (tableType !== undefined && tableType !== "object")
    issue(
      ["schema", 0, "logicalType"],
      "The table logicalType must be object.",
    );
  const description = doc.get("description", true);
  if (description !== undefined && !isMap(description))
    issue(
      ["description"],
      "Contract description must be a mapping, with an optional purpose.",
    );
  const field = (
    path: Path,
    label: string,
    kind: Field["kind"] = "text",
    choices?: string[],
    required = false,
  ): Field => {
    const node = doc.getIn(path, true);
    const value = isScalar(node) ? node.value : undefined;
    if (
      node !== undefined &&
      (!isScalar(node) || typeof value !== (kind === "text" ? "string" : kind))
    )
      issue(
        path,
        `${label} must be ${kind === "text" ? "a string" : `a ${kind}`}.`,
      );
    if (required && (typeof value !== "string" || !value.trim()))
      issue(path, `${label} is required.`);
    if (choices && value !== undefined && !choices.includes(String(value)))
      issue(path, `${label} must be one of: ${choices.join(", ")}.`);
    return {
      path,
      label,
      kind,
      value:
        typeof value === "string" ||
        typeof value === "boolean" ||
        typeof value === "number"
          ? value
          : kind === "boolean"
            ? false
            : kind === "number"
              ? 0
              : "",
      ...(choices ? { choices } : {}),
    };
  };
  form.fields = [
    field(["id"], "Contract id", "text", undefined, true),
    field(["name"], "Name"),
    field(["version"], "Version"),
    field(["description", "purpose"], "Purpose"),
    field(["schema", 0, "name"], "Table name", "text", undefined, true),
  ];
  const properties = doc.getIn(["schema", 0, "properties"], true);
  if (!isSeq(properties) || properties.items.length === 0) {
    issue(
      ["schema", 0, "properties"],
      "The table requires at least one property.",
    );
    return form;
  }
  const names = new Set<string>();
  properties.items.forEach((property, index) => {
    const base: Path = ["schema", 0, "properties", index];
    if (!isMap(property)) {
      issue(base, "Each property must be a mapping.");
      return;
    }
    const fields = [
      field([...base, "name"], "Column name", "text", undefined, true),
      field([...base, "logicalType"], "Logical type", "text", TYPES, true),
      field([...base, "required"], "Required", "boolean"),
      field([...base, "description"], "Description"),
    ];
    const name = String(fields[0]!.value);
    if (names.has(name))
      issue([...base, "name"], "Column names must be unique.");
    names.add(name);
    form.columns.push(fields);
  });
  const quality = doc.getIn(["schema", 0, "quality"], true);
  if (quality !== undefined && !isSeq(quality))
    issue(
      ["schema", 0, "quality"],
      "Table quality must be a sequence of rules.",
    );
  if (isSeq(quality))
    quality.items.forEach((rule, index) => {
      const base: Path = ["schema", 0, "quality", index];
      if (!isMap(rule)) {
        issue(base, "Each quality rule must be a mapping.");
        return;
      }
      const fields = [
        field([...base, "name"], "Rule name", "text", undefined, true),
        field([...base, "description"], "Description"),
      ];
      if (rule.get("type") === "custom" && rule.get("engine") === "dataraft") {
        fields.push(
          field(
            [...base, "implementation", "predicate"],
            "Predicate (validated by the R importer)",
            "text",
            undefined,
            true,
          ),
          field(
            [...base, "implementation", "threshold"],
            "Failure threshold",
            "number",
          ),
          field([...base, "implementation", "action"], "Action", "text", [
            "block",
            "warn",
            "quarantine",
          ]),
        );
        const threshold = doc.getIn([...base, "implementation", "threshold"]);
        if (
          typeof threshold === "number" &&
          (!Number.isFinite(threshold) || threshold < 0 || threshold > 1)
        )
          issue(
            [...base, "implementation", "threshold"],
            "Failure threshold must be between zero and one.",
          );
      }
      form.rules.push(fields);
    });
  return form;
}
export function editContract(text: string, operations: Operation[]): string {
  if (
    !Array.isArray(operations) ||
    !operations.length ||
    operations.length > 1000
  )
    throw new Error("Supply between one and 1000 form edits.");
  const form = inspectContract(text);
  if (form.issues.length)
    throw new Error(
      "Fix the YAML diagnostics in the text editor before using the form.",
    );
  const { doc } = read(text);
  const fields = [...form.fields, ...form.columns.flat(), ...form.rules.flat()];
  const allowed = new Map(
    fields.map((field) => [JSON.stringify(field.path), field]),
  );
  for (const operation of operations) {
    if (!operation || typeof operation !== "object")
      throw new Error("Invalid form edit.");
    if (operation.kind === "set") {
      const field = allowed.get(JSON.stringify(operation.path));
      if (
        !field ||
        typeof operation.value !==
          (field.kind === "text" ? "string" : field.kind)
      )
        throw new Error(
          "This field or value cannot be edited through the form.",
        );
      if (typeof operation.value === "string" && operation.value.length > 16384)
        throw new Error("Form field is too long.");
      if (operation.value === doc.getIn(operation.path)) continue;
      const previous = doc.getIn(operation.path, true);
      if (isScalar(previous)) previous.value = operation.value;
      else doc.setIn(operation.path, operation.value);
    } else if (operation.kind === "profileColumn") {
      const types: Record<string, string> = {
        character: "string",
        integer: "integer",
        integer64: "integer",
        numeric: "number",
        double: "number",
        logical: "boolean",
        Date: "date",
        POSIXct: "timestamp",
      };
      if (
        typeof operation.name !== "string" ||
        !operation.name.trim() ||
        operation.name.length > 16384 ||
        !Object.hasOwn(types, operation.type) ||
        typeof operation.required !== "boolean"
      )
        throw new Error("Invalid profile column proposal.");
      const properties = doc.getIn(["schema", 0, "properties"], true);
      if (!isSeq(properties)) throw new Error("Expected ODCS properties.");
      let column = properties.items.find(
        (item) => isMap(item) && item.get("name") === operation.name,
      );
      if (!column) {
        column = doc.createNode({ name: operation.name });
        properties.add(column);
      }
      if (!isMap(column)) throw new Error("Expected an ODCS column.");
      const newType = types[operation.type]!;
      const previousType = column.get("logicalType");
      const node = column.get("logicalType", true);
      if (isScalar(node)) node.value = newType;
      else column.set("logicalType", newType);
      const required = column.get("required", true);
      if (isScalar(required)) required.value = operation.required;
      else column.set("required", operation.required);
      if (operation.type === "integer64")
        column.setIn(["logicalTypeOptions", "format"], "i64");
      else if (
        isMap(column.get("logicalTypeOptions", true)) &&
        (previousType !== newType ||
          (operation.type === "integer" &&
            column.getIn(["logicalTypeOptions", "format"]) === "i64"))
      )
        column.deleteIn(["logicalTypeOptions", "format"]);
    } else if (operation.kind === "addColumn" || operation.kind === "addRule") {
      const columns = operation.kind === "addColumn";
      const path: Path = ["schema", 0, columns ? "properties" : "quality"];
      let sequence = doc.getIn(path, true);
      if (sequence === undefined) {
        doc.setIn(path, []);
        sequence = doc.getIn(path, true);
      }
      if (!isSeq(sequence)) throw new Error("Expected an ODCS sequence.");
      const existing = new Set(
        sequence.items.map((item) => (isMap(item) ? item.get("name") : "")),
      );
      let n = sequence.items.length + 1;
      while (existing.has(`${columns ? "column" : "rule"}_${n}`)) n++;
      sequence.add(
        doc.createNode(
          columns
            ? { name: `column_${n}`, logicalType: "string", required: false }
            : {
                name: `rule_${n}`,
                type: "custom",
                engine: "dataraft",
                implementation: {
                  predicate: "TRUE",
                  threshold: 0,
                  action: "block",
                },
              },
        ),
      );
    } else if (
      operation.kind === "removeColumn" ||
      operation.kind === "removeRule"
    ) {
      const sequence = doc.getIn(
        [
          "schema",
          0,
          operation.kind === "removeColumn" ? "properties" : "quality",
        ],
        true,
      );
      if (
        !isSeq(sequence) ||
        !Number.isInteger(operation.index) ||
        operation.index < 0 ||
        operation.index >= sequence.items.length
      )
        throw new Error("This item no longer exists.");
      sequence.delete(operation.index);
    } else throw new Error("Unknown form edit.");
  }
  const result = doc.toString();
  const issues = inspectContract(result).issues;
  if (issues.length) throw new Error(issues[0]!.message);
  return result;
}

export interface ColumnProposal {
  name: string;
  detail: string;
  operation: Operation;
}
export function profileColumnProposals(
  text: string,
  profile: unknown,
): ColumnProposal[] {
  if (
    !profile ||
    typeof profile !== "object" ||
    !("columns" in profile) ||
    !Array.isArray(profile.columns)
  )
    throw new Error("The R profile did not contain column metadata.");
  if (inspectContract(text).issues.length)
    throw new Error("Fix the YAML diagnostics before proposing columns.");
  const { doc } = read(text);
  const properties = doc.getIn(["schema", 0, "properties"], true);
  if (!isSeq(properties)) throw new Error("Expected ODCS properties.");
  const proposals: ColumnProposal[] = [];
  const seen = new Set<string>();
  const types: Record<string, string> = {
    character: "string",
    integer: "integer",
    integer64: "integer",
    numeric: "number",
    double: "number",
    logical: "boolean",
    Date: "date",
    POSIXct: "timestamp",
  };
  for (const column of profile.columns) {
    if (
      !column ||
      typeof column !== "object" ||
      typeof column.name !== "string" ||
      typeof column.required !== "boolean" ||
      !(column.type === null || typeof column.type === "string")
    )
      throw new Error("Invalid R profile column.");
    if (!column.name.trim() || seen.has(column.name))
      throw new Error("Profile column names must be nonempty and unique.");
    seen.add(column.name);
    const type =
      column.type === null || !Object.hasOwn(types, column.type)
        ? undefined
        : types[column.type];
    if (!type) continue; // Never guess an ODCS type for unsupported R classes.
    const existing = properties.items.find(
      (item) => isMap(item) && item.get("name") === column.name,
    );
    if (
      isMap(existing) &&
      existing.get("logicalType") === type &&
      existing.get("required") === column.required &&
      (column.type === "integer64"
        ? existing.getIn(["logicalTypeOptions", "format"]) === "i64"
        : !(
            column.type === "integer" &&
            existing.getIn(["logicalTypeOptions", "format"]) === "i64"
          ))
    )
      continue;
    proposals.push({
      name: column.name,
      detail: `${isMap(existing) ? `Update ${String(existing.get("logicalType"))} →` : "Add"} ${type}${column.type === "integer64" ? " (i64)" : ""}; required: ${column.required}. Inferred from this sample only.`,
      operation: {
        kind: "profileColumn",
        name: column.name,
        type: column.type as string,
        required: column.required,
      },
    });
  }
  return proposals;
}

export function sampleRuleIssues(text: string, quality: unknown): Issue[] {
  if (inspectContract(text).issues.length) return [];
  if (
    !quality ||
    typeof quality !== "object" ||
    !("items" in quality) ||
    !Array.isArray(quality.items)
  )
    throw new Error("The sample check did not return quality records.");
  const { doc } = read(text);
  const rules = new Map<string, { start: number; end: number }[]>();
  const addRules = (value: unknown): void => {
    if (!isSeq(value)) return;
    for (const rule of value.items) {
      if (!isMap(rule)) continue;
      const name = rule.get("name", true);
      if (
        !isScalar(name) ||
        typeof name.value !== "string" ||
        !name.range ||
        /^rule-\d+$/.test(name.value)
      )
        continue;
      const ranges = rules.get(name.value) ?? [];
      ranges.push({ start: name.range[0], end: name.range[1] });
      rules.set(name.value, ranges);
    }
  };
  addRules(doc.getIn(["schema", 0, "quality"], true));
  const properties = doc.getIn(["schema", 0, "properties"], true);
  if (isSeq(properties))
    for (const property of properties.items)
      if (isMap(property)) addRules(property.get("quality", true));
  const issues: Issue[] = [];
  for (const record of quality.items) {
    if (
      !record ||
      typeof record !== "object" ||
      typeof record.rule !== "string" ||
      !["failed", "error", "warning"].includes(record.status)
    )
      continue;
    const matches = rules.get(record.rule);
    if (matches?.length !== 1) continue;
    issues.push({
      ...matches[0]!,
      ...(record.status === "warning" || record.severity === "warning"
        ? { severity: "warning" as const }
        : {}),
      message: `R sample check ${record.status}: ${record.rule}${typeof record.n_failed === "number" ? ` (${record.n_failed} failed rows)` : ""}. This describes the selected sample, not a governed run.`,
    });
  }
  return issues;
}
