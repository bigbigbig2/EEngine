export interface TiledZstdModule {
  HEAPU8: Uint8Array;
  _tiled_init(): number;
  _tiled_input(): number;
  _tiled_output(): number;
  _tiled_decode(encodedBytes: number, nativeBytes: number): number;
}
export default function createTiledZstdModule(options: { wasmBinary: ArrayBuffer }): Promise<TiledZstdModule>;
