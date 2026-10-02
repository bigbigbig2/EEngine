/** Continuity-Domain Signal Sampling publication builder (local algorithm).
 * Geometry is joined by oriented manifold position edges. UV/normal/tangent/
 * color continuity is independent: a seam never erases the geometry domain.
 * Publication-time only. No GPU resources or per-frame visibility control. */
export const SURFACE_CONTINUITY_DOMAINS = 6;
export const SURFACE_CONTINUITY_DOMAIN = Object.freeze({ geometry: 0, uv0: 1, uv1: 2, normal: 3, tangent: 4, color: 5 });
export const SURFACE_CONTINUITY_IDENTITY_RISK = Object.freeze({ degenerate: 1, nonManifold: 2, lodLocal: 4 });
export const SURFACE_CONTINUITY_FIELD_RISK = Object.freeze({ normal: 1, tangent: 2, uv0: 4, uv1: 8, color: 16 });

export interface SurfaceContinuityInput {
  readonly vertices: Float32Array;
  readonly indices: Uint32Array;
  readonly stride: number;
  readonly position: number;
  readonly normal: number;
  readonly tangent: number;
  readonly uv0: number;
  readonly uv1: number;
  readonly color: number;
  /** Separate field scopes; geometry can remain connected across material seams. */
  readonly materialIds?: Uint32Array;
  readonly domainBase?: number;
}
export interface SurfaceContinuityPublication {
  /** Six independent nonzero IDs per triangle, ordered by DOMAIN. */
  readonly domains: Uint32Array;
  readonly identityRisk: Uint32Array;
  readonly fieldRisk: Uint32Array;
  readonly normalVariation: Float32Array;
  readonly colorVariation: Float32Array;
  /** uv0 span xy, uv1 span xy. */
  readonly uvSpan: Float32Array;
}
interface Edge { readonly triangle: number; readonly begin: number; readonly end: number; readonly forward: boolean; }

export function buildSurfaceContinuity(input: SurfaceContinuityInput): SurfaceContinuityPublication {
  const { vertices, indices, stride } = input;
  if (!Number.isSafeInteger(stride) || stride < 3 || vertices.length % stride !== 0 || indices.length % 3 !== 0) {
    throw new RangeError("Invalid Surface continuity vertex/index shape");
  }
  const fields = [[input.position, 3], [input.normal, 3], [input.tangent, 4],
    [input.uv0, 2], [input.uv1, 2], [input.color, 4]] as const;
  for (const [at, size] of fields) if (!Number.isSafeInteger(at) || at < 0 || at + size > stride) {
    throw new RangeError("Surface continuity field exceeds vertex stride");
  }
  const triangleCount = indices.length / 3, vertexCount = vertices.length / stride;
  const domainBase = input.domainBase ?? 0;
  if (!Number.isSafeInteger(domainBase) || domainBase < 0 || domainBase + triangleCount >= 0xffffffff ||
    input.materialIds !== undefined && input.materialIds.length !== triangleCount) {
    throw new RangeError("Invalid Surface continuity domain scope");
  }
  for (const index of indices) if (index >= vertexCount) throw new RangeError("Surface continuity vertex index out of range");
  const words = new Uint32Array(vertices.buffer, vertices.byteOffset, vertices.length);
  const at = (vertex: number, field: number): number => vertex * stride + field;
  const value = (vertex: number, field: number): number => vertices[at(vertex, field)]!;
  const componentKey = (vertex: number, field: number): number => {
    const number = value(vertex, field);
    if (!Number.isFinite(number)) throw new RangeError("Surface continuity requires finite published attributes");
    return number === 0 ? 0 : words[at(vertex, field)]!; // +0 and -0 are the same surface position/field.
  };
  const positionKeys = Array.from({ length: vertexCount }, (_, vertex) =>
    `${componentKey(vertex, input.position)}:${componentKey(vertex, input.position + 1)}:${componentKey(vertex, input.position + 2)}`);
  const equal = (a: number, b: number, offset: number, size: number): boolean => {
    for (let axis = 0; axis < size; axis++) if (componentKey(a, offset + axis) !== componentKey(b, offset + axis)) return false;
    return true;
  };
  const parents = Array.from({ length: SURFACE_CONTINUITY_DOMAINS }, () => Uint32Array.from({ length: triangleCount }, (_, i) => i));
  const find = (parent: Uint32Array, vertex: number): number => {
    let root = vertex;
    while (parent[root] !== root) root = parent[root]!;
    while (parent[vertex] !== vertex) { const next = parent[vertex]!; parent[vertex] = root; vertex = next; }
    return root;
  };
  const join = (field: number, a: number, b: number): void => {
    const parent = parents[field]!, ar = find(parent, a), br = find(parent, b);
    parent[Math.max(ar, br)] = Math.min(ar, br);
  };
  const identityRisk = new Uint32Array(triangleCount), fieldRisk = new Uint32Array(triangleCount);
  const normalVariation = new Float32Array(triangleCount), colorVariation = new Float32Array(triangleCount);
  const uvSpan = new Float32Array(triangleCount * 4);
  const orientations = [new Int8Array(triangleCount), new Int8Array(triangleCount)];
  const edges = new Map<string, Edge[]>();
  const normals = new Float64Array(vertexCount * 3), tangentLengths = new Float64Array(vertexCount);
  for (let vertex = 0; vertex < vertexCount; vertex++) {
    for (const [offset, size] of fields) for (let c = 0; c < size; c++) componentKey(vertex, offset + c);
    const length = Math.hypot(value(vertex, input.normal), value(vertex, input.normal + 1), value(vertex, input.normal + 2));
    if (length > 0) for (let c = 0; c < 3; c++) normals[vertex * 3 + c] = value(vertex, input.normal + c) / length;
    tangentLengths[vertex] = Math.hypot(value(vertex, input.tangent), value(vertex, input.tangent + 1), value(vertex, input.tangent + 2));
  }
  const roundUp = (number: number): number => {
    const storage = new Float32Array([number]);
    if (storage[0]! < number) new Uint32Array(storage.buffer)[0]!++;
    return storage[0]!;
  };
  for (let triangle = 0; triangle < triangleCount; triangle++) {
    const corners = [indices[triangle * 3]!, indices[triangle * 3 + 1]!, indices[triangle * 3 + 2]!];
    const p = corners.map(vertex => [0, 1, 2].map(c => value(vertex, input.position + c)));
    const ab = p[1]!.map((v, c) => v - p[0]![c]!), ac = p[2]!.map((v, c) => v - p[0]![c]!);
    const cross = [ab[1]! * ac[2]! - ab[2]! * ac[1]!, ab[2]! * ac[0]! - ab[0]! * ac[2]!, ab[0]! * ac[1]! - ab[1]! * ac[0]!];
    if (!(Math.hypot(...cross) > 0)) identityRisk[triangle] = SURFACE_CONTINUITY_IDENTITY_RISK.degenerate;
    let normalRisk = 0, colorRisk = 0, tangentAngle = 0;
    for (let corner = 0; corner < 3; corner++) {
      const a = corners[corner]!, b = corners[(corner + 1) % 3]!;
      const length = Math.hypot(...normals.subarray(a * 3, a * 3 + 3));
      if (!(length > 0)) fieldRisk[triangle]! |= SURFACE_CONTINUITY_FIELD_RISK.normal;
      if (!(tangentLengths[a]! > 0) || Math.abs(value(a, input.tangent + 3)) !== 1) fieldRisk[triangle]! |= SURFACE_CONTINUITY_FIELD_RISK.tangent;
      if (value(a, input.tangent + 3) !== value(b, input.tangent + 3)) fieldRisk[triangle]! |= SURFACE_CONTINUITY_FIELD_RISK.tangent;
      if (tangentLengths[a]! > 0 && tangentLengths[b]! > 0) {
        let tangentDot = 0;
        for (let c = 0; c < 3; c++) tangentDot += value(a, input.tangent + c) * value(b, input.tangent + c);
        tangentAngle = Math.max(tangentAngle, Math.acos(Math.max(-1, Math.min(1, tangentDot / (tangentLengths[a]! * tangentLengths[b]!)))));
      }
      let dot = 0;
      for (let c = 0; c < 3; c++) dot += normals[a * 3 + c]! * normals[b * 3 + c]!;
      normalRisk = Math.max(normalRisk, 1 - Math.max(-1, Math.min(1, dot)));
      for (let c = 0; c < 4; c++) colorRisk = Math.max(colorRisk, Math.abs(value(a, input.color + c) - value(b, input.color + c)));
      const begin = positionKeys[a]!, end = positionKeys[b]!;
      if (begin !== end) {
        const forward = begin < end, key = forward ? `${begin}/${end}` : `${end}/${begin}`;
        const list = edges.get(key) ?? []; list.push({ triangle, begin: a, end: b, forward }); edges.set(key, list);
      }
    }
    normalVariation[triangle] = roundUp(normalRisk); colorVariation[triangle] = roundUp(colorRisk);
    // Upper-rounded angular cone, 0..pi in 8 bits, independent of low risk bits
    // and the six LOD-local correspondence bits at 16..21.
    fieldRisk[triangle]! |= Math.ceil(tangentAngle / Math.PI * 255) << 24;
    for (let uv = 0; uv < 2; uv++) {
      const offset = uv === 0 ? input.uv0 : input.uv1;
      const det = (value(corners[1]!, offset) - value(corners[0]!, offset)) * (value(corners[2]!, offset + 1) - value(corners[0]!, offset + 1))
        - (value(corners[1]!, offset + 1) - value(corners[0]!, offset + 1)) * (value(corners[2]!, offset) - value(corners[0]!, offset));
      orientations[uv]![triangle] = det > 0 ? 1 : det < 0 ? -1 : 0;
      if (det === 0) fieldRisk[triangle]! |= uv === 0 ? SURFACE_CONTINUITY_FIELD_RISK.uv0 : SURFACE_CONTINUITY_FIELD_RISK.uv1;
      for (let c = 0; c < 2; c++) {
        const values = corners.map(vertex => value(vertex, offset + c));
        uvSpan[triangle * 4 + uv * 2 + c] = roundUp(Math.max(...values) - Math.min(...values));
      }
    }
  }
  for (const list of edges.values()) {
    if (list.length !== 2 || list[0]!.forward === list[1]!.forward) {
      if (list.length > 1) for (const edge of list) identityRisk[edge.triangle]! |= SURFACE_CONTINUITY_IDENTITY_RISK.nonManifold;
      continue;
    }
    const a = list[0]!, b = list[1]!;
    if ((identityRisk[a.triangle]! | identityRisk[b.triangle]!) & SURFACE_CONTINUITY_IDENTITY_RISK.degenerate) continue;
    join(SURFACE_CONTINUITY_DOMAIN.geometry, a.triangle, b.triangle);
    if (input.materialIds !== undefined && input.materialIds[a.triangle] !== input.materialIds[b.triangle]) continue;
    const continuous = (offset: number, size: number): boolean => equal(a.begin, b.end, offset, size) && equal(a.end, b.begin, offset, size);
    for (let uv = 0; uv < 2; uv++) {
      const orientation = orientations[uv]!;
      if (orientation[a.triangle] !== 0 && orientation[a.triangle] === orientation[b.triangle] && continuous(uv === 0 ? input.uv0 : input.uv1, 2)) {
        join(uv + 1, a.triangle, b.triangle);
      }
    }
    if (!((fieldRisk[a.triangle]! | fieldRisk[b.triangle]!) & SURFACE_CONTINUITY_FIELD_RISK.normal) && continuous(input.normal, 3)) {
      join(SURFACE_CONTINUITY_DOMAIN.normal, a.triangle, b.triangle);
    }
    if (!((fieldRisk[a.triangle]! | fieldRisk[b.triangle]!) & SURFACE_CONTINUITY_FIELD_RISK.tangent) && continuous(input.tangent, 4)) {
      join(SURFACE_CONTINUITY_DOMAIN.tangent, a.triangle, b.triangle);
    }
    if (continuous(input.color, 4)) join(SURFACE_CONTINUITY_DOMAIN.color, a.triangle, b.triangle);
  }
  const domains = new Uint32Array(triangleCount * SURFACE_CONTINUITY_DOMAINS);
  for (let triangle = 0; triangle < triangleCount; triangle++) for (let field = 0; field < SURFACE_CONTINUITY_DOMAINS; field++) {
    domains[triangle * SURFACE_CONTINUITY_DOMAINS + field] = domainBase + find(parents[field]!, triangle) + 1;
  }
  return Object.freeze({ domains, identityRisk, fieldRisk, normalVariation, colorVariation, uvSpan });
}
