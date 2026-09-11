export interface TextureFormatBlockLayout {
  readonly blockWidth: number;
  readonly blockHeight: number;
  readonly bytesPerBlock: number;
}

const LAYOUTS = new Map<GPUTextureFormat, TextureFormatBlockLayout>([
  ["rgba8unorm", { blockWidth: 1, blockHeight: 1, bytesPerBlock: 4 }],
  ["rgba8unorm-srgb", { blockWidth: 1, blockHeight: 1, bytesPerBlock: 4 }],
  ["bc1-rgba-unorm", { blockWidth: 4, blockHeight: 4, bytesPerBlock: 8 }],
  ["bc1-rgba-unorm-srgb", { blockWidth: 4, blockHeight: 4, bytesPerBlock: 8 }],
  ["bc3-rgba-unorm", { blockWidth: 4, blockHeight: 4, bytesPerBlock: 16 }],
  ["bc3-rgba-unorm-srgb", { blockWidth: 4, blockHeight: 4, bytesPerBlock: 16 }],
  ["bc4-r-unorm", { blockWidth: 4, blockHeight: 4, bytesPerBlock: 8 }],
  ["bc5-rg-unorm", { blockWidth: 4, blockHeight: 4, bytesPerBlock: 16 }],
  ["bc7-rgba-unorm", { blockWidth: 4, blockHeight: 4, bytesPerBlock: 16 }],
  ["bc7-rgba-unorm-srgb", { blockWidth: 4, blockHeight: 4, bytesPerBlock: 16 }],
  ["etc2-rgb8unorm", { blockWidth: 4, blockHeight: 4, bytesPerBlock: 8 }],
  ["etc2-rgb8unorm-srgb", { blockWidth: 4, blockHeight: 4, bytesPerBlock: 8 }],
  ["etc2-rgba8unorm", { blockWidth: 4, blockHeight: 4, bytesPerBlock: 16 }],
  ["etc2-rgba8unorm-srgb", { blockWidth: 4, blockHeight: 4, bytesPerBlock: 16 }],
  ["eac-r11unorm", { blockWidth: 4, blockHeight: 4, bytesPerBlock: 8 }],
  ["eac-rg11unorm", { blockWidth: 4, blockHeight: 4, bytesPerBlock: 16 }],
  ["astc-4x4-unorm", { blockWidth: 4, blockHeight: 4, bytesPerBlock: 16 }],
  ["astc-4x4-unorm-srgb", { blockWidth: 4, blockHeight: 4, bytesPerBlock: 16 }]
]);

export function textureFormatBlockLayout(format: GPUTextureFormat): TextureFormatBlockLayout {
  const layout = LAYOUTS.get(format);
  if (layout === undefined) throw new RangeError(`Texture format '${format}' has no codec block layout`);
  return layout;
}

export function encodedTextureMipByteLength(
  format: GPUTextureFormat,
  logicalWidth: number,
  logicalHeight: number
): number {
  const layout = textureFormatBlockLayout(format);
  return Math.ceil(logicalWidth / layout.blockWidth) *
    Math.ceil(logicalHeight / layout.blockHeight) * layout.bytesPerBlock;
}

export function physicalTextureExtent(
  format: GPUTextureFormat,
  logicalWidth: number,
  logicalHeight: number
): readonly [number, number] {
  const layout = textureFormatBlockLayout(format);
  return Object.freeze([
    alignUp(logicalWidth, layout.blockWidth),
    alignUp(logicalHeight, layout.blockHeight)
  ] as const);
}

function alignUp(value: number, alignment: number): number {
  return Math.ceil(value / alignment) * alignment;
}
