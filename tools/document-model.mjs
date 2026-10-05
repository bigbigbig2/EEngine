import { parseDocument } from "yaml";
import { fromMarkdown } from "mdast-util-from-markdown";
import { existsSync, readdirSync } from "node:fs";
import { dirname, relative, resolve, sep } from "node:path";

export function parseYamlObject(source, file = "YAML") {
  const document = parseDocument(source, { uniqueKeys: true, strict: true, prettyErrors: true });
  const problems = [...document.errors, ...document.warnings];
  if (problems.length) throw new Error(`${file}: ${problems.map((item) => item.message).join("; ")}`);
  const value = document.toJS({ maxAliasCount: 100 });
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${file}: expected a mapping`);
  }
  return value;
}

export function parseMarkdown(source, file = "Markdown", requireFrontmatter = true) {
  const block = source.match(/^\uFEFF?---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/u);
  if (!block && requireFrontmatter) throw new Error(`${file}: missing or unterminated frontmatter`);
  const fields = block ? parseYamlObject(block[1], file) : null;
  const body = block ? source.slice(block[0].length) : source;
  const tree = fromMarkdown(body);
  const nodes = [];
  function visit(node) {
    nodes.push(node);
    for (const child of node.children ?? []) visit(child);
  }
  visit(tree);
  const definitions = new Map();
  for (const node of nodes) {
    if (node.type === "definition" && !definitions.has(node.identifier))
      definitions.set(node.identifier, node);
  }
  const links = [];
  const offset = block ? block[0].split("\n").length - 1 : 0;
  for (const node of nodes) {
    if (!["link", "image", "linkReference", "imageReference"].includes(node.type)) continue;
    const target = node.url ?? definitions.get(node.identifier)?.url;
    if (target) links.push({ target, line: node.position.start.line + offset });
  }
  return { fields, body, links };
}

export function resolveLocalReference(root, from, target) {
  if (/^(?:[a-z][a-z\d+.-]*:|\/\/)/iu.test(target) || target.startsWith("#")) return null;
  const encoded = target.split(/[?#]/u, 1)[0];
  if (!encoded) return null;
  const path = decodeURIComponent(encoded).replaceAll("\\", "/");
  const absolute = path.startsWith("/") ? resolve(root, path.slice(1)) : resolve(dirname(from), path);
  const local = relative(root, absolute);
  if (local === ".." || local.startsWith(`..${sep}`) || resolve(root, local) !== absolute) {
    throw new Error(`reference escapes repository: ${target}`);
  }
  return absolute;
}

// Windows can open a wrongly-cased path, but Linux checkouts cannot.
export function exactPathExists(root, absolute) {
  if (!existsSync(absolute)) return false;
  let directory = resolve(root);
  for (const part of relative(root, absolute).split(sep).filter(Boolean)) {
    if (!readdirSync(directory).some((name) => name === part)) return false;
    directory = resolve(directory, part);
  }
  return true;
}
