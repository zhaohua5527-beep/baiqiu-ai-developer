"use strict";

const MAX_ROWS = 5000;
const MAX_COLUMNS = 100;
const MAX_OPERATIONS = 80;
const MAX_PATCHES = 1000;
const MAX_CELL_LENGTH = 2000;

function text(value, limit = MAX_CELL_LENGTH) {
  return String(value ?? "").replace(/\u0000/g, "").slice(0, limit);
}

function columnLabel(index) {
  let value = Math.max(0, Number(index) || 0) + 1;
  let label = "";
  while (value > 0) {
    value -= 1;
    label = String.fromCharCode(65 + (value % 26)) + label;
    value = Math.floor(value / 26);
  }
  return label;
}

function normalizeRows(rows = []) {
  const normalized = Array.isArray(rows) ? rows.slice(0, MAX_ROWS).map((row) => {
    const cells = Array.isArray(row) ? row.slice(0, MAX_COLUMNS) : [];
    return cells.map((value) => text(value));
  }) : [];
  const width = Math.max(1, ...normalized.map((row) => row.length));
  return normalized.length ? normalized.map((row) => row.concat(Array(Math.max(0, width - row.length)).fill(""))) : [Array(width).fill("")];
}

function numericValue(value) {
  const raw = text(value).trim();
  if (!raw || !/^-?[\d,]+(?:\.\d+)?%?$/.test(raw)) return null;
  const isPercent = raw.endsWith("%");
  const number = Number(raw.replace(/[,%]/g, ""));
  if (!Number.isFinite(number)) return null;
  return isPercent ? number / 100 : number;
}

function dateValue(value) {
  const raw = text(value).trim();
  return /^\d{4}[-/.]\d{1,2}[-/.]\d{1,2}(?:[ T]\d{1,2}:\d{2}(?::\d{2})?)?$/.test(raw);
}

function columnType(values = []) {
  const present = values.map((value) => text(value).trim()).filter(Boolean);
  if (!present.length) return "empty";
  const numericCount = present.filter((value) => numericValue(value) !== null).length;
  const dateCount = present.filter(dateValue).length;
  if (numericCount / present.length >= 0.85) return "number";
  if (dateCount / present.length >= 0.85) return "date";
  if (numericCount || dateCount) return "mixed";
  return "text";
}

function headerFor(rows, index) {
  const candidate = text(rows[0]?.[index]).trim();
  return candidate || `Column ${columnLabel(index)}`;
}

function buildSpreadsheetProfile(rows = [], options = {}) {
  const matrix = normalizeRows(rows);
  const width = Math.max(1, ...matrix.map((row) => row.length));
  const dataRows = matrix.slice(1);
  const duplicateRows = new Set();
  const seenRows = new Set();
  for (let rowIndex = 1; rowIndex < matrix.length; rowIndex += 1) {
    const signature = matrix[rowIndex].map((value) => text(value).trim()).join("\u001f");
    if (!signature.replace(/\u001f/g, "")) continue;
    if (seenRows.has(signature)) duplicateRows.add(rowIndex);
    else seenRows.add(signature);
  }
  const columns = Array.from({ length: width }, (_unused, index) => {
    const values = dataRows.map((row) => row[index] || "");
    const nonEmpty = values.filter((value) => text(value).trim()).length;
    const unique = new Set();
    for (const value of values) {
      const normalized = text(value).trim();
      if (normalized) unique.add(normalized);
      if (unique.size > 2000) break;
    }
    const numeric = values.map(numericValue).filter((value) => value !== null);
    const column = {
      index,
      label: columnLabel(index),
      name: headerFor(matrix, index),
      type: columnType(values),
      nonEmpty,
      missing: Math.max(0, dataRows.length - nonEmpty),
      unique: unique.size
    };
    if (numeric.length) {
      const total = numeric.reduce((sum, value) => sum + value, 0);
      column.numeric = {
        min: Math.min(...numeric),
        max: Math.max(...numeric),
        average: Number((total / numeric.length).toFixed(4))
      };
    }
    return column;
  });
  return {
    sourceEncoding: text(options.sourceEncoding, 32) || "unknown",
    rowCount: matrix.length,
    dataRowCount: dataRows.length,
    columnCount: width,
    duplicateRowCount: duplicateRows.size,
    columns
  };
}

function snapshotRows(rows = [], options = {}) {
  const matrix = normalizeRows(rows);
  const maxRows = Math.max(1, Math.min(400, Number(options.maxRows) || 100));
  const maxColumns = Math.max(1, Math.min(40, Number(options.maxColumns) || 20));
  return matrix.slice(0, maxRows).map((row) => row.slice(0, maxColumns).map((value) => text(value, 120)));
}

function buildSpreadsheetAiPrompt({ request = "", rows = [], profile = null } = {}) {
  const task = text(request, 1200).trim();
  if (!task) throw new Error("Please provide an adjustment request.");
  const matrix = normalizeRows(rows);
  const shape = buildSpreadsheetProfile(matrix);
  const summary = profile && typeof profile === "object" ? profile : shape;
  const schema = {
    summary: "一句话（不超过30字）说明你将做的改动，如'将第2行备注改为已验收'。只描述改动本身，不写分析、不用表格、不解释数据、不反问用户、不输出'建议'或'确认'。",
    operations: [
      { type: "set_cell", row: 1, column: 0, value: "new value" },
      { type: "replace_text", column: 2, find: "old", replace: "new" },
      { type: "trim_cells", column: 1 },
      { type: "fill_empty", column: 3, value: "unknown" },
      { type: "rename_column", column: 4, value: "new header" }
    ]
  };
  return [
    "You are preparing a spreadsheet edit plan inside Baiqiu AI.",
    "Return one JSON object only. Do not use Markdown, tools, code fences, or prose outside JSON.",
    "Rows and columns are zero-based. Row 0 is the header row. Only use supported operations in the schema.",
    "Do not delete rows, create files, use formulas, or write to disk. Make a conservative plan that is reversible in the UI.",
    "Use replace_text, trim_cells, or fill_empty for repeated edits instead of listing hundreds of cells.",
    "summary must be a single short Chinese sentence describing the change (max 30 chars). No analysis, no tables, no questions to the user, no '建议' or '确认' prose.",
    "User request:",
    task,
    "Spreadsheet profile:",
    JSON.stringify(summary),
    "Visible worksheet snapshot:",
    JSON.stringify(snapshotRows(matrix)),
    "Required JSON shape:",
    JSON.stringify(schema)
  ].join("\n");
}

function extractJsonObject(value = "") {
  const raw = text(value, 200000).trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  try { return JSON.parse(raw); } catch {}
  const start = raw.indexOf("{");
  if (start < 0) throw new Error("AI did not return a JSON edit plan.");
  let depth = 0;
  let quoted = false;
  let escaped = false;
  for (let index = start; index < raw.length; index += 1) {
    const char = raw[index];
    if (quoted) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') quoted = false;
      continue;
    }
    if (char === '"') quoted = true;
    else if (char === "{") depth += 1;
    else if (char === "}") {
      depth -= 1;
      if (depth === 0) return JSON.parse(raw.slice(start, index + 1));
    }
  }
  throw new Error("AI returned an incomplete JSON edit plan.");
}

function boundedIndex(value, maximum, name) {
  const index = Number(value);
  if (!Number.isInteger(index) || index < 0 || index >= maximum) throw new Error(`${name} is outside the worksheet.`);
  return index;
}

function appendPatch(patches, byCell, row, column, before, after) {
  if (before === after) return;
  const key = `${row}:${column}`;
  const existing = byCell.get(key);
  if (existing) {
    existing.after = after;
    return;
  }
  if (patches.length >= MAX_PATCHES) throw new Error(`The plan exceeds the ${MAX_PATCHES} cell safety limit.`);
  const patch = { row, column, before, after };
  byCell.set(key, patch);
  patches.push(patch);
}

function operationLabel(type) {
  return ({
    set_cell: "Set cell",
    replace_text: "Replace text",
    trim_cells: "Trim whitespace",
    fill_empty: "Fill empty cells",
    rename_column: "Rename header"
  })[type] || type;
}

function normalizeOperation(raw, rowCount, columnCount) {
  if (!raw || typeof raw !== "object") throw new Error("The edit plan contains an invalid operation.");
  const type = text(raw.type, 48).trim().toLowerCase();
  if (!["set_cell", "replace_text", "trim_cells", "fill_empty", "rename_column"].includes(type)) throw new Error(`Unsupported spreadsheet operation: ${type || "unknown"}.`);
  const column = boundedIndex(raw.column ?? raw.columnIndex, columnCount, "Column");
  if (type === "set_cell") {
    return { type, row: boundedIndex(raw.row ?? raw.rowIndex, rowCount, "Row"), column, value: text(raw.value ?? raw.newValue) };
  }
  if (type === "replace_text") {
    const find = text(raw.find, 400);
    if (!find) throw new Error("replace_text requires a non-empty find value.");
    return { type, column, find, replace: text(raw.replace ?? raw.value, 800) };
  }
  if (type === "trim_cells") return { type, column };
  if (type === "fill_empty") return { type, column, value: text(raw.value ?? raw.fillValue, 800) };
  return { type, column, value: text(raw.value ?? raw.name, 800) };
}

function validateSpreadsheetAiPlan(rows = [], modelResponse = "") {
  const matrix = normalizeRows(rows);
  const rowCount = matrix.length;
  const columnCount = Math.max(1, ...matrix.map((row) => row.length));
  const parsed = typeof modelResponse === "string" ? extractJsonObject(modelResponse) : modelResponse;
  if (!parsed || typeof parsed !== "object") throw new Error("AI did not provide an edit plan.");
  const rawOperations = Array.isArray(parsed.operations) ? parsed.operations.slice(0, MAX_OPERATIONS) : [];
  if (!rawOperations.length) throw new Error("AI did not provide any supported spreadsheet edits.");
  const working = matrix.map((row) => row.slice());
  const patches = [];
  const byCell = new Map();
  const operations = [];
  for (const rawOperation of rawOperations) {
    const operation = normalizeOperation(rawOperation, rowCount, columnCount);
    const beforeCount = patches.length;
    if (operation.type === "set_cell" || operation.type === "rename_column") {
      const row = operation.type === "rename_column" ? 0 : operation.row;
      const before = working[row][operation.column] || "";
      const after = operation.value;
      appendPatch(patches, byCell, row, operation.column, before, after);
      working[row][operation.column] = after;
    } else {
      for (let row = 1; row < rowCount; row += 1) {
        const before = working[row][operation.column] || "";
        let after = before;
        if (operation.type === "replace_text") after = before.split(operation.find).join(operation.replace);
        if (operation.type === "trim_cells") after = before.trim();
        if (operation.type === "fill_empty" && !before.trim()) after = operation.value;
        appendPatch(patches, byCell, row, operation.column, before, after);
        working[row][operation.column] = after;
      }
    }
    const affectedCells = patches.length - beforeCount;
    if (affectedCells) {
      operations.push({
        type: operation.type,
        label: operationLabel(operation.type),
        column: operation.column,
        affectedCells
      });
    }
  }
  if (!patches.length) throw new Error("The AI plan does not change any cells.");
  return {
    summary: text(parsed.summary || "AI prepared a spreadsheet edit plan.", 500),
    affectedCells: patches.length,
    profile: buildSpreadsheetProfile(matrix),
    resultingProfile: buildSpreadsheetProfile(working),
    operations,
    patches
  };
}

module.exports = {
  MAX_PATCHES,
  buildSpreadsheetAiPrompt,
  buildSpreadsheetProfile,
  columnLabel,
  extractJsonObject,
  normalizeRows,
  snapshotRows,
  validateSpreadsheetAiPlan
};
