export interface KtxPcTexture {
  get(field: number): number;
  status(): number;
  message(): string;
  load(): number;
  transcode(target: number): number;
  image(level: number): Uint8Array<ArrayBuffer>;
  delete(): void;
}
export interface KtxPcModule {
  readonly HEAPU8: Uint8Array<ArrayBuffer>;
  readonly Texture: new (bytes: Uint8Array, metadataOnly: boolean) => KtxPcTexture;
}
export default function createKtxPcModule(options: {wasmBinary:ArrayBuffer;print?:(text:string)=>void;printErr?:(text:string)=>void}):Promise<KtxPcModule>;
