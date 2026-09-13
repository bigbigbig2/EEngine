/** Validation reflection of the actual compiled WGSL, not a second engine ABI. */
export function reflectWgslStruct(source: string, name: string) {
  const round = (value: number, alignment: number) => Math.ceil(value / alignment) * alignment;
  function members(body: string): string[] {
    const result: string[] = []; let depth = 0, start = 0;
    for (let index = 0; index < body.length; index++) {
      if (body[index] === "<") depth++;
      if (body[index] === ">") depth--;
      if (body[index] === "," && depth === 0) { result.push(body.slice(start, index).trim()); start = index + 1; }
    }
    if (body.slice(start).trim()) result.push(body.slice(start).trim());
    return result.filter(Boolean);
  }
  function type(typeName: string): { size: number; alignment: number } {
    if (/^(?:u32|i32|f32|atomic<(?:u32|i32)>)$/u.test(typeName)) return { size: 4, alignment: 4 };
    const vector = /^vec([234])(?:[fiu]|<(?:f32|i32|u32)>)$/u.exec(typeName);
    if (vector) return { size: Number(vector[1]) * 4, alignment: vector[1] === "2" ? 8 : 16 };
    const matrix = /^mat([234])x([234])f$/u.exec(typeName);
    if (matrix) { const column = type(`vec${matrix[2]}f`); return { size: Number(matrix[1]) * round(column.size, column.alignment), alignment: column.alignment }; }
    const array = /^array<(.+)>$/u.exec(typeName);
    if (array) { const parts = members(array[1]!); const element = type(parts[0]!); return { size: parts.length === 1 ? 0 : round(element.size, element.alignment) * Number(parts[1]), alignment: element.alignment }; }
    return structure(typeName);
  }
  function structure(structName: string) {
    const body = new RegExp(`struct\\s+${structName}\\s*\\{([^}]*)\\}`, "u").exec(source)?.[1];
    if (body === undefined) throw new Error(`Actual WGSL is missing ${structName}`);
    let size = 0, alignment = 1;
    const fields: Record<string, { offset: number; size: number; alignment: number }> = {};
    for (const member of members(body.replace(/\/\/[^\n]*/gu, ""))) {
      const field = /^(\w+)\s*:\s*(.+)$/u.exec(member);
      if (!field) throw new Error(`Unsupported reflected WGSL field: ${member}`);
      const layout = type(field[2]!.replace(/\s+/gu, ""));
      size = round(size, layout.alignment); alignment = Math.max(alignment, layout.alignment);
      fields[field[1]!] = { offset: size, ...layout }; size += layout.size;
    }
    return { size: round(size, alignment), alignment, fields };
  }
  return structure(name);
}
