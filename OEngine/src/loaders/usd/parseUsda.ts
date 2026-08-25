/**
 * parseUsda：解析 USD 数据并转换为引擎运行时对象。
 */

import type { UsdSpec, UsdSpecsByPath } from "./UsdExtensionRegistry.js";
import {
  parseUsdValue,
  parseXformOpOrder,
  stripQuotes
} from "./usdAttrs.js";

const PRIM_RE = /^(def|over|class)\s+(?:(\w+)\s+)?"([^"]+)"$/;
const ATTR_RE = /^(?:(uniform|custom)\s+)?(\w+(?:\[\])?)\s+(.+)$/;

export function stripLineComment(line: string): string {
  if (line.trim().startsWith("#usda")) return line;
  let inString = false;
  let quote: string | null = null;
  let escaped = false;
  for (let i = 0; i < line.length; i++) {
    const char = line[i]!;
    if (escaped) {
      escaped = false;
    } else if (char === "\\") {
      escaped = true;
    } else if (inString || (char !== '"' && char !== "'")) {
      if (inString && char === quote) {
        inString = false;
        quote = null;
      } else if (!inString && char === "#") {
        return line.slice(0, i).trimEnd();
      }
    } else {
      inString = true;
      quote = char;
    }
  }
  return line;
}

export const J_ = stripLineComment;

export function indexOfEqualsOutsideQuotes(line: string): number {
  let inString = false;
  let quote: string | null = null;
  let escaped = false;
  for (let i = 0; i < line.length; i++) {
    const char = line[i]!;
    if (escaped) {
      escaped = false;
    } else if (char === "\\") {
      escaped = true;
    } else if (inString || (char !== '"' && char !== "'")) {
      if (inString && char === quote) {
        inString = false;
      } else if (!inString && char === "=") {
        return i;
      }
    } else {
      inString = true;
      quote = char;
    }
  }
  return -1;
}

export const K_ = indexOfEqualsOutsideQuotes;

export function stripBlockComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, "");
}

export function flattenTripleQuotedStrings(text: string): string {
  const output: string[] = [];
  let cursor = 0;
  let chunkStart = 0;
  while (cursor < text.length) {
    if (cursor + 2 < text.length) {
      const delimiter = text.slice(cursor, cursor + 3);
      if (delimiter === "'''" || delimiter === '\"\"\"') {
        output.push(text.slice(chunkStart, cursor));
        output.push(delimiter);
        cursor += 3;
        const body: string[] = [];
        while (cursor < text.length) {
          if (
            cursor + 2 < text.length &&
            text.slice(cursor, cursor + 3) === delimiter
          ) {
            output.push(body.join(""));
            output.push(delimiter);
            cursor += 3;
            break;
          }
          if (text[cursor] === "\n") body.push("\\n");
          else if (text[cursor] !== "\r") body.push(text[cursor]!);
          cursor++;
        }
        chunkStart = cursor;
        continue;
      }
    }
    cursor++;
  }
  output.push(text.slice(chunkStart));
  return output.join("");
}

export function joinMultilineBracketValues(text: string): string {
  const lines = text.split("\n");
  const output: string[] = [];
  let joining = false;
  let bracketDepth = 0;
  let joined = "";
  for (let lineIndex = 0; lineIndex < lines.length; lineIndex++) {
    const line = stripLineComment(lines[lineIndex]!);
    const trimmed = line.trim();
    if (joining) {
      joined += " " + trimmed;
      for (let i = 0; i < trimmed.length; i++) {
        if (trimmed[i] === "[") bracketDepth++;
        else if (trimmed[i] === "]") bracketDepth--;
      }
      if (bracketDepth === 0) {
        output.push(joined);
        joined = "";
        joining = false;
      }
    } else {
      if (trimmed.includes("=")) {
        const equals = indexOfEqualsOutsideQuotes(trimmed);
        if (equals !== -1) {
          const value = trimmed.slice(equals + 1).trim();
          let opens = 0;
          let closes = 0;
          for (let i = 0; i < value.length; i++) {
            if (value[i] === "[") opens++;
            else if (value[i] === "]") closes++;
          }
          if (opens > closes) {
            joining = true;
            bracketDepth = opens - closes;
            joined = trimmed;
            continue;
          }
        }
      }
      output.push(trimmed);
    }
  }
  return output.join("\n");
}

export function preprocessUsdaText(text: string): string {
  return joinMultilineBracketValues(
    flattenTripleQuotedStrings(stripBlockComments(text))
  );
}

export interface BraceNode {
  [key: string]: BraceNode | string;
}

export function parseBraceTree(text: string): BraceNode {
  const root: BraceNode = {};
  const lines = text.split("\n");
  let pendingKey: string | null = null;
  let current = root;
  const stack: BraceNode[] = [root];

  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    if (trimmed.includes("=")) {
      const equals = indexOfEqualsOutsideQuotes(trimmed);
      if (equals === -1) {
        pendingKey = trimmed;
        continue;
      }
      const key = trimmed.slice(0, equals).trim();
      const value = trimmed.slice(equals + 1).trim();
      if (value.endsWith("{")) {
        const child: BraceNode = {};
        stack.push(child);
        current[key] = child;
        current = child;
      } else if (value.endsWith("(")) {
        current[key] = value.slice(0, -1);
        const child: BraceNode = {};
        stack.push(child);
        current = child;
      } else {
        current[key] = value;
      }
    } else if (trimmed.includes(":") && !trimmed.includes("=")) {
      const colon = trimmed.indexOf(":");
      const key = trimmed.slice(0, colon).trim();
      const value = trimmed.slice(colon + 1).trim();
      if (/^[\d.]+$/.test(key)) current[key] = value;
    } else if (trimmed.endsWith("{")) {
      const key = pendingKey as string;
      const child = (current[key] as BraceNode) || {};
      stack.push(child);
      current[key] = child;
      current = child;
    } else if (trimmed.endsWith("}")) {
      stack.pop();
      if (stack.length === 0) continue;
      current = stack[stack.length - 1]!;
    } else if (trimmed.endsWith("(")) {
      const child: BraceNode = {};
      stack.push(child);
      pendingKey = trimmed.split("(")[0]!.trim() || pendingKey;
      current[pendingKey as string] = child;
      current = child;
    } else if (trimmed.endsWith(")")) {
      stack.pop();
      current = stack[stack.length - 1]!;
    } else {
      pendingKey = trimmed;
    }
  }
  return root;
}

function collectFields(
  body: BraceNode,
  path: string,
  primFields: Record<string, unknown>,
  specs: UsdSpecsByPath
): void {
  if (!body || typeof body !== "object") return;
  for (const key in body) {
    if (
      key.startsWith("def ") ||
      key.startsWith("over ") ||
      key.startsWith("class ")
    ) {
      continue;
    }
    if (key === "prepend references" || key === "references") {
      console.warn(
        `[USD] Composition arc "references" at ${path} is not supported, skipping`
      );
      continue;
    }
    if (key === "payload") {
      console.warn(
        `[USD] Composition arc "payload" at ${path} is not supported, skipping`
      );
      continue;
    }
    if (key.startsWith("rel ")) {
      const specPath = path + "." + key.slice(4);
      const target = String(body[key]).replace(/[<>]/g, "");
      specs[specPath] = {
        specType: 8,
        fields: { targetPaths: [target] }
      };
      continue;
    }
    if (key.includes("xformOpOrder")) {
      primFields.xformOpOrder = parseXformOpOrder(body[key]);
      continue;
    }
    const match = key.match(ATTR_RE);
    if (!match) continue;
    const typeName = match[2]!;
    const attrName = match[3]!;
    const raw = body[key];
    if (attrName.endsWith(".connect")) {
      const specPath = path + "." + attrName.slice(0, -8);
      let target = String(raw).trim();
      if (target.startsWith("<")) target = target.slice(1);
      if (target.endsWith(">")) target = target.slice(0, -1);
      if (!specs[specPath]) {
        specs[specPath] = { specType: 1, fields: { typeName } };
      }
      specs[specPath]!.fields.connectionPaths = [target];
      continue;
    }
    if (
      attrName.endsWith(".timeSamples") &&
      typeof raw === "object"
    ) {
      const specPath = path + "." + attrName.slice(0, -12);
      const times: number[] = [];
      const values: unknown[] = [];
      for (const sample in raw) {
        const time = parseFloat(sample);
        if (!Number.isNaN(time)) {
          times.push(time);
          values.push(parseUsdValue(typeName, raw[sample]));
        }
      }
      const sorted = times
        .map((time, index) => ({ time, value: values[index] }))
        .sort((a, b) => a.time - b.time);
      specs[specPath] = {
        specType: 1,
        fields: {
          timeSamples: {
            times: sorted.map((sample) => sample.time),
            values: sorted.map((sample) => sample.value)
          },
          typeName
        }
      };
      continue;
    }
    specs[path + "." + attrName] = {
      specType: 1,
      fields: { default: parseUsdValue(typeName, raw), typeName }
    };
  }
}

function visitPrims(
  node: BraceNode,
  path: string,
  specs: UsdSpecsByPath
): void {
  const children: string[] = [];
  for (const key in node) {
    if (key === "#usda 1.0" || key === "variants") continue;
    const match = key.match(PRIM_RE);
    if (!match) continue;
    const specifier = match[1]!;
    const typeName = match[2] || "";
    const name = match[3]!;
    const childPath = path === "/" ? "/" + name : path + "/" + name;
    children.push(name);
    const fields: Record<string, unknown> = { typeName, specifier };
    const body = node[key] as BraceNode;
    collectFields(body, childPath, fields, specs);
    specs[childPath] = { specType: 6, fields };
    visitPrims(body, childPath, specs);
  }
  if (children.length > 0 && specs[path]) {
    specs[path]!.fields.primChildren = children;
  }
}

function extractLayerMeta(tree: BraceNode): Record<string, unknown> {
  const fields: Record<string, unknown> = {};
  const layer = tree["#usda 1.0"] as BraceNode | undefined;
  if (!layer) return fields;
  if (layer.upAxis) fields.upAxis = stripQuotes(String(layer.upAxis));
  if (layer.defaultPrim) {
    fields.defaultPrim = stripQuotes(String(layer.defaultPrim));
  }
  if (layer.metersPerUnit !== undefined) {
    fields.metersPerUnit = parseFloat(String(layer.metersPerUnit));
  }
  if (layer.doc) fields.doc = stripQuotes(String(layer.doc));
  return fields;
}

export interface UsdaParseResult {
  specsByPath: UsdSpecsByPath;
}

export function parseUsda(text: string): UsdaParseResult {
  const preprocessed = preprocessUsdaText(text);
  const tree = parseBraceTree(preprocessed);
  const specsByPath: UsdSpecsByPath = {};
  specsByPath["/"] = { specType: 6, fields: extractLayerMeta(tree) };
  visitPrims(tree, "/", specsByPath);
  return { specsByPath };
}

export const X_ = parseUsda;

export function decodeUtf8(buffer: ArrayBuffer): string {
  return new TextDecoder("utf-8").decode(new Uint8Array(buffer));
}

export function isPrimSpec(spec: UsdSpec | undefined): spec is UsdSpec {
  return spec !== undefined && spec.specType === 6;
}
