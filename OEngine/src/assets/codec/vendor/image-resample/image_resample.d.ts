export interface ImageResampleModule {
  readonly HEAPU8: Uint8Array<ArrayBuffer>;
  _malloc(size: number): number;
  _free(pointer: number): void;
  _image_resample(source: number, width: number, height: number, output: number,
    outputWidth: number, outputHeight: number, srgb: number, normal: number): number;
}
export default function createImageResampleModule(options: {
  wasmBinary: ArrayBuffer;
}): Promise<ImageResampleModule>;
