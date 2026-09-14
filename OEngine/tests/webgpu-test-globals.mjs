globalThis.GPUShaderStage ??= Object.freeze({
  VERTEX: 1,
  FRAGMENT: 2,
  COMPUTE: 4
});

globalThis.GPUTextureUsage ??= Object.freeze({
  COPY_SRC: 1,
  COPY_DST: 2,
  TEXTURE_BINDING: 4,
  STORAGE_BINDING: 8,
  RENDER_ATTACHMENT: 16
});
