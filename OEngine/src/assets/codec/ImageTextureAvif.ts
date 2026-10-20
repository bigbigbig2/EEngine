import { imageCicp, type ImageTextureItem, type ImageTextureSemantic } from "../ImageTextureProduct.js";

interface Box {
  readonly type: string;
  readonly start: number;
  readonly end: number;
}

/** Restricted libavif static profile. Reject grids, animation, transforms and unknown auxiliaries
 * before browser decode. This is admission, not an AV1 decoder. */
export function validateImageAvif(
  bytes: Uint8Array,
  item: ImageTextureItem,
  semantic: ImageTextureSemantic
): void {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const text = (start: number, length: number) =>
    new TextDecoder().decode(bytes.subarray(start, start + length));
  let boxCount = 0;
  const boxes = (start: number, end: number): Box[] => {
    const result: Box[] = [];
    for (let cursor = start; cursor < end;) {
      if (cursor + 8 > end || ++boxCount > 256) {
        throw new Error("AVIF box domain exceeds static profile");
      }
      const size = view.getUint32(cursor);
      if (size < 8 || cursor + size > end) {
        throw new Error("AVIF truncated/extended box is outside selected profile");
      }
      result.push({ type: text(cursor + 4, 4), start: cursor + 8, end: cursor + size });
      cursor += size;
    }
    return result;
  };
  const top = boxes(0, bytes.length);
  const one = (list: Box[], type: string) => {
    const found = list.filter((box) => box.type === type);
    if (found.length !== 1) {
      throw new Error(`AVIF requires exactly one ${type}`);
    }
    return found[0]!;
  };
  const ftyp = one(top, "ftyp");
  if (
    ftyp.end - ftyp.start < 12 ||
    text(ftyp.start, 4) !== "avif" ||
    top.some((box) => !["ftyp", "meta", "mdat", "free"].includes(box.type))
  ) {
    throw new Error("AVIF is not a selected static single-image container");
  }
  one(top, "mdat");
  const meta = one(top, "meta");
  const children = boxes(meta.start + 4, meta.end);
  if (children.some((box) => !["hdlr", "pitm", "iloc", "iinf", "iref", "iprp"].includes(box.type))) {
    throw new Error("Unsupported AVIF metadata/transform");
  }
  const pitm = one(children, "pitm");
  if (view.getUint32(pitm.start) !== 0 || pitm.end - pitm.start !== 6) {
    throw new Error("Unsupported AVIF primary ID width");
  }
  const primary = view.getUint16(pitm.start + 4);
  const iloc = one(children, "iloc");
  if (
    iloc.end - iloc.start < 8 ||
    view.getUint32(iloc.start) !== 0 ||
    bytes[iloc.start + 4] !== 0x44 ||
    bytes[iloc.start + 5] !== 0
  ) {
    throw new Error("AVIF requires bounded direct file extents");
  }
  const locations = view.getUint16(iloc.start + 6);
  if (locations < 1 || locations > 2 || iloc.end - iloc.start !== 8 + locations * 14) {
    throw new Error("AVIF direct extent count mismatch");
  }
  const located = new Set<number>();
  const payload = one(top, "mdat");
  for (let location = iloc.start + 8; location < iloc.end; location += 14) {
    const id = view.getUint16(location);
    const offset = view.getUint32(location + 6);
    const length = view.getUint32(location + 10);
    if (
      located.has(id) ||
      view.getUint16(location + 2) !== 0 ||
      view.getUint16(location + 4) !== 1 ||
      length < 1 ||
      offset < payload.start ||
      offset + length > payload.end
    ) {
      throw new Error("AVIF external/out-of-range/ambiguous data extent rejected");
    }
    located.add(id);
  }
  const iinf = one(children, "iinf");
  if (view.getUint32(iinf.start) !== 0) {
    throw new Error("Unsupported AVIF item table");
  }
  const entries = boxes(iinf.start + 6, iinf.end);
  const count = view.getUint16(iinf.start + 4);
  if (entries.length !== count || count < 1 || count > 2) {
    throw new Error("AVIF item count is outside static RGB/alpha profile");
  }
  const ids = new Set<number>();
  for (const entry of entries) {
    if (
      entry.type !== "infe" ||
      entry.end - entry.start < 13 ||
      bytes[entry.start] !== 2 ||
      view.getUint16(entry.start + 6) !== 0 ||
      text(entry.start + 8, 4) !== "av01"
    ) {
      throw new Error("AVIF derived/protected/non-AV1 item rejected");
    }
    ids.add(view.getUint16(entry.start + 4));
  }
  if (
    ids.size !== count ||
    !ids.has(primary) ||
    located.size !== count ||
    [...ids].some((id) => !located.has(id))
  ) {
    throw new Error("AVIF primary item is missing or ambiguous");
  }
  const iprp = one(children, "iprp");
  const properties = boxes(iprp.start, iprp.end);
  const ipco = one(properties, "ipco");
  const props = boxes(ipco.start, ipco.end);
  if (props.some((box) => !["ispe", "pixi", "av1C", "colr", "auxC"].includes(box.type))) {
    throw new Error("AVIF orientation/crop/unknown property rejected");
  }
  const sizes = props.filter((box) => box.type === "ispe");
  if (
    sizes.length !== 1 ||
    sizes[0]!.end - sizes[0]!.start !== 12 ||
    view.getUint32(sizes[0]!.start + 4) !== item.width ||
    view.getUint32(sizes[0]!.start + 8) !== item.height
  ) {
    throw new Error("AVIF dimensions differ from admitted image owner");
  }
  for (const property of props.filter((box) => box.type === "pixi")) {
    const channels = bytes[property.start + 4]!;
    if (
      ![1, 3].includes(channels) ||
      property.end - property.start !== 5 + channels ||
      bytes.subarray(property.start + 5, property.end).some((value) => value !== 10)
    ) {
      throw new Error("AVIF profile requires 10-bit components");
    }
  }
  const colr = one(props, "colr");
  const cicp = imageCicp(semantic);
  if (
    colr.end - colr.start !== 11 ||
    text(colr.start, 4) !== "nclx" ||
    view.getUint16(colr.start + 4) !== cicp[0] ||
    view.getUint16(colr.start + 6) !== cicp[1] ||
    view.getUint16(colr.start + 8) !== cicp[2] ||
    bytes[colr.start + 10] !== 128
  ) {
    throw new Error("AVIF CICP/range differs from canonical recipe");
  }
  const auxiliary = props.filter((box) => box.type === "auxC");
  if (
    count === 2 &&
    (auxiliary.length !== 1 ||
      text(auxiliary[0]!.start + 4, auxiliary[0]!.end - auxiliary[0]!.start - 4) !==
        "urn:mpeg:mpegB:cicp:systems:auxiliary:alpha\0")
  ) {
    throw new Error("AVIF auxiliary is not the selected alpha profile");
  }
  const references = children.filter((box) => box.type === "iref");
  if (count === 2) {
    if (references.length !== 1 || view.getUint32(references[0]!.start) !== 0) {
      throw new Error("AVIF alpha requires direct auxiliary references");
    }
    const refs = boxes(references[0]!.start + 4, references[0]!.end);
    if (
      refs.length !== 1 ||
      refs[0]!.type !== "auxl" ||
      refs[0]!.end - refs[0]!.start !== 6 ||
      !ids.has(view.getUint16(refs[0]!.start)) ||
      view.getUint16(refs[0]!.start) === primary ||
      view.getUint16(refs[0]!.start + 2) !== 1 ||
      view.getUint16(refs[0]!.start + 4) !== primary
    ) {
      throw new Error("AVIF alpha reference does not point to the primary image");
    }
  } else if (references.length || auxiliary.length) {
    throw new Error("AVIF single image cannot contain auxiliary references");
  }
  const ipma = one(properties, "ipma");
  if (view.getUint32(ipma.start) !== 0 || view.getUint32(ipma.start + 4) !== count) {
    throw new Error("Unsupported AVIF property association table");
  }
  let cursor = ipma.start + 8;
  const associated = new Set<number>();
  for (let index = 0; index < count; index++) {
    if (cursor + 3 > ipma.end) {
      throw new Error("Truncated AVIF association");
    }
    const id = view.getUint16(cursor);
    const n = bytes[cursor + 2]!;
    cursor += 3;
    if (!ids.has(id) || associated.has(id) || cursor + n > ipma.end) {
      throw new Error("Invalid AVIF property item reference");
    }
    associated.add(id);
    const types: string[] = [];
    let configuration: Box | undefined;
    for (let property = 0; property < n; property++) {
      const reference = bytes[cursor++]! & 127;
      if (reference < 1 || reference > props.length) {
        throw new Error("AVIF property reference is out of bounds");
      }
      types.push(props[reference - 1]!.type);
      if (props[reference - 1]!.type === "av1C") {
        configuration = props[reference - 1];
      }
    }
    if (
      !["ispe", "pixi", "av1C"].every((type) => types.includes(type)) ||
      (id === primary ? !types.includes("colr") : !types.includes("auxC"))
    ) {
      throw new Error("AVIF required property is not associated with its image");
    }
    const monochrome = id !== primary || semantic === "scalar-r";
    if (
      !configuration ||
      configuration.end - configuration.start !== 4 ||
      bytes[configuration.start] !== 0x81 ||
      (bytes[configuration.start + 1]! & 0xe0) !== (monochrome ? 0 : 0x20) ||
      (bytes[configuration.start + 1]! & 31) > 23 ||
      bytes[configuration.start + 2] !== (monochrome ? 0x5c : 0x40) ||
      bytes[configuration.start + 3] !== 0
    ) {
      throw new Error("AVIF AV1 profile/depth/chroma differs from selected 444/400 recipe");
    }
  }
  if (cursor !== ipma.end) {
    throw new Error("AVIF association has trailing bytes");
  }
}
