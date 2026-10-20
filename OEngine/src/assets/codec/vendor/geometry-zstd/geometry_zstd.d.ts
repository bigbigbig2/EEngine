interface GeometryZstdModule {
  HEAPU8: Uint8Array<ArrayBuffer>;
  _malloc(bytes: number): number;
  _free(pointer: number): void;
  _geometry_zstd_decode(input: number, bytes: number, output: number, decoded: number): number;
}
export default function create(options: { wasmBinary: Uint8Array }): Promise<GeometryZstdModule>;
