/** Local mip/footprint bounds. Named local min/max hierarchy, not an upstream
 * shading port. Build from ACTUAL decoded variant/resident mip values: source
 * RGBA bounds alone do not certify a lossy compressed variant's output.
 * Device-independent texture math/codec; residency owns GPU allocation. */
export interface TextureVariationMipInput {
  readonly width: number;
  readonly height: number;
  readonly rgba: Float32Array;
}
export interface TextureVariationLevel {
  readonly width: number;
  readonly height: number;
  readonly span: number;
  /** low rgba + high rgba per spatial node, in decoded sampling space. */
  readonly bounds: Float32Array;
}
export interface TextureLocalVariationMip {
  readonly width: number;
  readonly height: number;
  readonly levels: readonly TextureVariationLevel[];
}
export interface TextureLocalVariation {
  readonly blockSize: number;
  readonly mips: readonly TextureLocalVariationMip[];
  readonly payloadBytes: number;
}
export interface TextureFootprintBounds {
  readonly minU: number;
  readonly minV: number;
  readonly maxU: number;
  readonly maxV: number;
  readonly lod: number;
  readonly filter: "nearest" | "linear";
  readonly mipFilter: "nearest" | "linear";
  readonly wrapU: "clamp-to-edge" | "repeat" | "mirror-repeat";
  readonly wrapV: "clamp-to-edge" | "repeat" | "mirror-repeat";
  /** Inclusive real resident range; unmapped mips cannot certify requests. */
  readonly residentMipRange?: readonly [number, number];
}
export interface TextureFootprintVariation {
  readonly known: boolean;
  readonly low: readonly number[];
  readonly high: readonly number[];
  readonly nodesRead: number;
  readonly mipsRead: readonly number[];
}
const empty = (): Float64Array => Float64Array.from([Infinity, Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity, -Infinity]);
const merge = (out: Float64Array | Float32Array, at: number, low: ArrayLike<number>, loAt: number,
  high: ArrayLike<number> = low, hiAt = loAt): void => {
  for (let c = 0; c < 4; c++) { out[at + c] = Math.min(out[at + c]!, low[loAt + c]!); out[at + 4 + c] = Math.max(out[at + 4 + c]!, high[hiAt + c]!); }
};

export function buildTextureLocalVariation(inputs: readonly TextureVariationMipInput[], blockSize = 4,
  maxPayloadBytes = 32 * 1024 * 1024): TextureLocalVariation {
  if (!Number.isSafeInteger(blockSize) || blockSize < 1 || (blockSize & (blockSize - 1)) !== 0 ||
    !Number.isSafeInteger(maxPayloadBytes) || maxPayloadBytes < 32 || inputs.length === 0) {
    throw new RangeError("Invalid local variation profile");
  }
  // Validate/preflight ALL nodes before allocating. No partial published tree.
  let payloadBytes = 0;
  for (let mip = 0; mip < inputs.length; mip++) {
    const input = inputs[mip]!;
    if (!Number.isSafeInteger(input.width) || !Number.isSafeInteger(input.height) || input.width < 1 || input.height < 1 ||
      input.rgba.length !== input.width * input.height * 4 || !Number.isSafeInteger(input.width * input.height * 4)) {
      throw new RangeError("Invalid decoded mip dimensions");
    }
    if (mip > 0 && (input.width !== Math.max(1, inputs[mip - 1]!.width >> 1) ||
      input.height !== Math.max(1, inputs[mip - 1]!.height >> 1))) throw new RangeError("Variation mips are not a contiguous texture chain");
    let w = Math.ceil(input.width / blockSize), h = Math.ceil(input.height / blockSize);
    while (true) {
      payloadBytes += w * h * 32;
      if (!Number.isSafeInteger(payloadBytes) || payloadBytes > maxPayloadBytes) throw new RangeError("Local variation payload exceeds publication budget");
      if (w === 1 && h === 1) break;
      w = Math.ceil(w / 2); h = Math.ceil(h / 2);
    }
    for (const value of input.rgba) if (!Number.isFinite(value)) throw new RangeError("Non-finite decoded variation input");
  }
  const mips: TextureLocalVariationMip[] = [];
  for (const input of inputs) {
    let width = Math.ceil(input.width / blockSize), height = Math.ceil(input.height / blockSize), span = blockSize;
    let bounds = new Float32Array(width * height * 8);
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
      const range = empty();
      for (let py = y * blockSize; py < Math.min(input.height, (y + 1) * blockSize); py++) {
        for (let px = x * blockSize; px < Math.min(input.width, (x + 1) * blockSize); px++) merge(range, 0, input.rgba, (py * input.width + px) * 4);
      }
      bounds.set(range, (y * width + x) * 8);
    }
    const levels: TextureVariationLevel[] = [Object.freeze({ width, height, span, bounds })];
    while (width !== 1 || height !== 1) {
      const nextWidth = Math.ceil(width / 2), nextHeight = Math.ceil(height / 2);
      const next = new Float32Array(nextWidth * nextHeight * 8);
      for (let y = 0; y < nextHeight; y++) for (let x = 0; x < nextWidth; x++) {
        const range = empty();
        for (let cy = y * 2; cy < Math.min(height, y * 2 + 2); cy++) for (let cx = x * 2; cx < Math.min(width, x * 2 + 2); cx++) {
          const at = (cy * width + cx) * 8; merge(range, 0, bounds, at, bounds, at + 4);
        }
        next.set(range, (y * nextWidth + x) * 8);
      }
      width = nextWidth; height = nextHeight; span *= 2; bounds = next;
      levels.push(Object.freeze({ width, height, span, bounds }));
    }
    mips.push(Object.freeze({ width: input.width, height: input.height, levels: Object.freeze(levels) }));
  }
  return Object.freeze({ blockSize, mips: Object.freeze(mips), payloadBytes });
}

/** Map inclusive integer texel support to bounded intervals of real texels. */
function wrappedIntervals(lo: number, hi: number, size: number,
  wrap: TextureFootprintBounds["wrapU"]): readonly (readonly [number, number])[] {
  if (wrap === "clamp-to-edge") return [[Math.max(0, Math.min(size - 1, lo)), Math.max(0, Math.min(size - 1, hi))]];
  const period = wrap === "repeat" ? size : size * 2;
  if (hi - lo + 1 >= period) return [[0, size - 1]];
  const normalized = ((lo % period) + period) % period;
  let remaining = hi - lo + 1, current = normalized;
  const result: [number, number][] = [];
  while (remaining > 0) {
    const boundary = current < size ? size : period;
    const count = Math.min(remaining, boundary - current);
    if (current < size) result.push([current, current + count - 1]);
    else result.push([period - (current + count), period - current - 1]);
    remaining -= count; current = (current + count) % period;
  }
  return result;
}

/** Conservative bounded query: caller encloses the complete anisotropic tap
 * support in min/max UV. Bilinear texel halo and trilinear second mip are added
 * here. Up to four hierarchy nodes per wrapped rectangle, not whole texture. */
export function queryTextureLocalVariation(tree: TextureLocalVariation, footprint: TextureFootprintBounds): TextureFootprintVariation {
  const unknown = (): TextureFootprintVariation => Object.freeze({ known: false, low: [], high: [], nodesRead: 0, mipsRead: [] });
  if (![footprint.minU, footprint.minV, footprint.maxU, footprint.maxV, footprint.lod].every(Number.isFinite) ||
    footprint.minU > footprint.maxU || footprint.minV > footprint.maxV || tree.mips.length === 0) return unknown();
  const range = empty(); let nodesRead = 0;
  const lod = Math.max(0, Math.min(tree.mips.length - 1, footprint.lod));
  const selected = footprint.mipFilter === "nearest" ? [Math.floor(lod + 0.5)] : [...new Set([Math.floor(lod), Math.ceil(lod)])];
  const resident = footprint.residentMipRange ?? [0, tree.mips.length - 1];
  if (selected.some(mip => mip < resident[0]! || mip > resident[1]!)) return unknown();
  for (const index of selected) {
    const mip = tree.mips[index]!;
    const texelRange = (minimum: number, maximum: number, size: number): readonly [number, number] => {
      const halo = footprint.filter === "linear" ? 0.5 : 0;
      // Oversize/astronomical coordinates cannot retain precise integer texel identity.
      return [Math.floor(minimum * size - halo), Math.floor(maximum * size - halo) + (footprint.filter === "linear" ? 1 : 0)];
    };
    const xr = texelRange(footprint.minU, footprint.maxU, mip.width), yr = texelRange(footprint.minV, footprint.maxV, mip.height);
    if (![...xr, ...yr].every(Number.isSafeInteger)) return unknown();
    for (const [loY, hiY] of wrappedIntervals(yr[0], yr[1], mip.height, footprint.wrapV)) {
      for (const [loX, hiX] of wrappedIntervals(xr[0], xr[1], mip.width, footprint.wrapU)) {
        let level = 0;
        while (level + 1 < mip.levels.length) {
          const span = mip.levels[level]!.span;
          if (Math.floor(hiX / span) - Math.floor(loX / span) < 2 && Math.floor(hiY / span) - Math.floor(loY / span) < 2) break;
          level++;
        }
        const selectedLevel = mip.levels[level]!;
        for (let y = Math.floor(loY / selectedLevel.span); y <= Math.floor(hiY / selectedLevel.span); y++) {
          for (let x = Math.floor(loX / selectedLevel.span); x <= Math.floor(hiX / selectedLevel.span); x++) {
            const at = (y * selectedLevel.width + x) * 8;
            merge(range, 0, selectedLevel.bounds, at, selectedLevel.bounds, at + 4); nodesRead++;
          }
        }
      }
    }
  }
  return Object.freeze({ known: true, low: Object.freeze([...range.subarray(0, 4)]),
    high: Object.freeze([...range.subarray(4, 8)]), nodesRead, mipsRead: Object.freeze(selected) });
}

/** Derive a normal cone from decoded channel bounds, with explicit RGB vs XY
 * reconstruct-Z semantics. A box containing the origin has no useful cone. */
export function textureVariationNormalCone(variation: TextureFootprintVariation, decode: "rgb" | "xy-positive-z"):
  Readonly<{ known: boolean; axis: readonly number[]; cosAngle: number }> {
  if (!variation.known) return Object.freeze({ known: false, axis: [0, 0, 1], cosAngle: -1 });
  const low = variation.low.slice(0, 3).map(v => 2 * v - 1), high = variation.high.slice(0, 3).map(v => 2 * v - 1);
  if (decode === "xy-positive-z") {
    const minimumAbs = (lo: number, hi: number): number => lo <= 0 && hi >= 0 ? 0 : Math.min(Math.abs(lo), Math.abs(hi));
    const minXY = minimumAbs(low[0]!, high[0]!) ** 2 + minimumAbs(low[1]!, high[1]!) ** 2;
    const maxXY = Math.max(Math.abs(low[0]!), Math.abs(high[0]!)) ** 2 + Math.max(Math.abs(low[1]!), Math.abs(high[1]!)) ** 2;
    low[2] = Math.sqrt(Math.max(0, 1 - maxXY)); high[2] = Math.sqrt(Math.max(0, 1 - minXY));
  }
  const center = low.map((value, c) => (value + high[c]!) * 0.5), half = low.map((value, c) => (high[c]! - value) * 0.5);
  const length = Math.hypot(...center), radius = Math.hypot(...half);
  if (!(length > radius)) return Object.freeze({ known: false, axis: [0, 0, 1], cosAngle: -1 });
  // The enclosing sphere's tangent cone encloses every normalized vector in the box.
  return Object.freeze({ known: true, axis: Object.freeze(center.map(v => v / length)),
    cosAngle: Math.max(-1, Math.sqrt(Math.max(0, 1 - (radius / length) ** 2)) - 1e-7) });
}

/** Local publication codec. Offsets are words; all bounds are decoded-space f32.
 * Both tables and payload are included in the serialized/GPUpool byte budget. */
export function encodeTextureLocalVariation(tree: TextureLocalVariation): Uint8Array<ArrayBuffer> {
  const levelCount = tree.mips.reduce((sum, mip) => sum + mip.levels.length, 0);
  const tableWords = 8 + tree.mips.length * 8 + levelCount * 4;
  const bytes = new Uint8Array(tableWords * 4 + tree.payloadBytes), view = new DataView(bytes.buffer);
  const word = (at: number, value: number): void => view.setUint32(at * 4, value, true);
  word(0, 0x31565254); word(1, 1); word(2, tree.blockSize); word(3, tree.mips.length); word(4, bytes.byteLength);
  let table = 8 + tree.mips.length * 8, data = tableWords;
  for (let mip = 0; mip < tree.mips.length; mip++) {
    const info = tree.mips[mip]!, row = 8 + mip * 8;
    word(row, info.width); word(row + 1, info.height); word(row + 2, info.levels.length); word(row + 3, table);
    for (const level of info.levels) {
      word(table, level.width); word(table + 1, level.height); word(table + 2, level.span); word(table + 3, data);
      for (const value of level.bounds) { view.setFloat32(data * 4, value, true); data++; }
      table += 4;
    }
  }
  return bytes;
}

export function decodeTextureLocalVariation(bytes: Uint8Array, maxBytes = 32 * 1024 * 1024): TextureLocalVariation {
  if (bytes.byteLength < 64 || bytes.byteLength > maxBytes || bytes.byteLength % 4 !== 0) throw new RangeError("Invalid variation chunk size");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const word = (at: number): number => {
    if (at < 0 || at * 4 + 4 > bytes.byteLength) throw new RangeError("Variation chunk offset out of range");
    return view.getUint32(at * 4, true);
  };
  const mipCount = word(3), blockSize = word(2);
  if (word(0) !== 0x31565254 || word(1) !== 1 || word(4) !== bytes.byteLength || word(5) !== 0 || word(6) !== 0 || word(7) !== 0 ||
    mipCount < 1 || mipCount > 32 || blockSize < 1 || blockSize > 64 || (blockSize & (blockSize - 1)) !== 0) throw new RangeError("Invalid variation chunk header");
  let table = 8 + mipCount * 8;
  const shapes: { width: number; height: number; levels: { width: number; height: number; span: number; offset: number }[] }[] = [];
  for (let mip = 0; mip < mipCount; mip++) {
    const row = 8 + mip * 8, width = word(row), height = word(row + 1), count = word(row + 2);
    if (width < 1 || height < 1 || width > 32768 || height > 32768 || word(row + 3) !== table ||
      [4,5,6,7].some(c => word(row + c) !== 0)) throw new RangeError("Invalid variation mip header");
    if (mip > 0 && (width !== Math.max(1, shapes[mip - 1]!.width >> 1) || height !== Math.max(1, shapes[mip - 1]!.height >> 1))) {
      throw new RangeError("Invalid variation mip chain");
    }
    let w = Math.ceil(width / blockSize), h = Math.ceil(height / blockSize), span = blockSize;
    const levels: { width: number; height: number; span: number; offset: number }[] = [];
    for (let level = 0; level < count; level++) {
      if (word(table) !== w || word(table + 1) !== h || word(table + 2) !== span) throw new RangeError("Invalid variation level shape");
      levels.push({ width: w, height: h, span, offset: word(table + 3) }); table += 4;
      if (w === 1 && h === 1) { if (level !== count - 1) throw new RangeError("Duplicate variation root"); break; }
      w = Math.ceil(w / 2); h = Math.ceil(h / 2); span *= 2;
    }
    if (count < 1 || count > 16 || levels.at(-1)!.width !== 1 || levels.at(-1)!.height !== 1) throw new RangeError("Incomplete variation tree");
    shapes.push({ width, height, levels });
  }
  let data = table, payloadBytes = 0;
  const mips: TextureLocalVariationMip[] = [];
  for (const shape of shapes) {
    const levels: TextureVariationLevel[] = [];
    for (const level of shape.levels) {
      const count = level.width * level.height * 8;
      if (level.offset !== data || count > bytes.byteLength / 4 - data) throw new RangeError("Invalid variation payload range");
      const bounds = new Float32Array(count);
      for (let i = 0; i < count; i++) { bounds[i] = view.getFloat32((data + i) * 4, true); if (!Number.isFinite(bounds[i])) throw new RangeError("Non-finite variation bound"); }
      for (let i = 0; i < count; i += 8) for (let c = 0; c < 4; c++) if (bounds[i + c]! > bounds[i + c + 4]!) throw new RangeError("Reversed variation bounds");
      levels.push(Object.freeze({ width: level.width, height: level.height, span: level.span, bounds })); data += count; payloadBytes += count * 4;
    }
    mips.push(Object.freeze({ width: shape.width, height: shape.height, levels: Object.freeze(levels) }));
    for (let level = 1; level < levels.length; level++) {
      const parent = levels[level]!, child = levels[level - 1]!;
      for (let y = 0; y < child.height; y++) for (let x = 0; x < child.width; x++) {
        const a = (y * child.width + x) * 8, b = (Math.floor(y / 2) * parent.width + Math.floor(x / 2)) * 8;
        for (let c = 0; c < 4; c++) if (parent.bounds[b + c]! > child.bounds[a + c]! || parent.bounds[b + 4 + c]! < child.bounds[a + 4 + c]!) {
          throw new RangeError("Variation parent does not enclose its children");
        }
      }
    }
  }
  if (data * 4 !== bytes.byteLength) throw new RangeError("Unreferenced variation payload");
  return Object.freeze({ blockSize, mips: Object.freeze(mips), payloadBytes });
}
