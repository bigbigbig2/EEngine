export interface BasisBcModule {
  readonly HEAPU8: Uint8Array<ArrayBuffer>;
  _malloc(size: number): number;
  _free(pointer: number): void;
  _bc_encode(source: number, width: number, height: number, format: number, srgb: number, channel: number, output: number): number;
  _bc_decode(source: number, width: number, height: number, format: number, output: number): number;
  _bc_resample(source: number, width: number, height: number, output: number, outputWidth: number, outputHeight: number, srgb: number, normal: number): number;
}
export default function createBasisBcModule(options: { wasmBinary: ArrayBuffer; print?: (text:string) => void; printErr?: (text:string) => void }): Promise<BasisBcModule>;
