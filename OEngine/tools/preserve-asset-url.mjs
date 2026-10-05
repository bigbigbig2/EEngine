import ts from "typescript";

// Formatting is not part of the consumer asset URL contract.
export function preserveAssetUrl(source, expectedPath, placeholder) {
  const tree = ts.createSourceFile("asset.ts", source, ts.ScriptTarget.Latest, true);
  const matches = [];
  function visit(node) {
    if (ts.isNewExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "URL") {
      const [path, base] = node.arguments ?? [];
      if (
        path &&
        ts.isStringLiteral(path) &&
        path.text === expectedPath &&
        base &&
        ts.isPropertyAccessExpression(base) &&
        base.name.text === "url" &&
        ts.isMetaProperty(base.expression) &&
        base.expression.keywordToken === ts.SyntaxKind.ImportKeyword
      ) {
        matches.push(node);
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(tree);
  if (matches.length !== 1)
    throw new Error(
      `${expectedPath} URL contract requires one actual new URL expression; found ${matches.length}`
    );
  const node = matches[0];
  return source.slice(0, node.getStart(tree)) + placeholder + source.slice(node.end);
}
