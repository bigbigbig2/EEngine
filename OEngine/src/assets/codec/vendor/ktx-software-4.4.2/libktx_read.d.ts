declare interface KtxEnumValue {}

declare interface KtxTexture {
  readonly baseWidth: number;
  readonly baseHeight: number;
  readonly dataSize: number;
  readonly needsTranscoding: boolean;
  readonly numComponents: number;
  readonly isSrgb: boolean;
  transcodeBasis(target: KtxEnumValue, flags: number): KtxEnumValue;
  getImage(level: number, layer: number, faceSlice: number): Uint8Array | null;
  delete(): void;
}

declare interface KtxReadModule {
  readonly texture: new (bytes: Uint8Array) => KtxTexture;
  readonly error_code: { readonly SUCCESS: KtxEnumValue };
  readonly transcode_fmt: Readonly<Record<string, KtxEnumValue>>;
}

declare function createKtxReadModule(options: {
  readonly wasmBinary: ArrayBuffer;
  readonly print?: (text: string) => void;
  readonly printErr?: (text: string) => void;
}): Promise<KtxReadModule>;

export default createKtxReadModule;
