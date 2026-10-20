export interface ImageDecodeModule {
  readonly HEAPU8: Uint8Array<ArrayBuffer>;
  _malloc(size: number): number;
  _free(pointer: number): void;
  _image_decode(source: number, width: number, height: number, format: number, output: number): number;
}
export default function createImageDecodeModule(options: { wasmBinary: ArrayBuffer }): Promise<ImageDecodeModule>;
