/**
 * NssModel：负责渲染管线编排、视图状态或渲染目标管理。
 */

import { NSS_MODEL_BASE64 } from "./nss_model.generated.js";

export type NssActivation = "identity" | "relu" | "leaky_relu";

export type NssLayer = {
  inChannels: number;
  outChannels: number;
  kernelSize: number;
  weights: Uint8Array;
  bias: Float32Array | null;
  activation: NssActivation;
  rescales: Float32Array;
  lut: Uint8Array | null;
  outputZeroPoint: number;
};

export type NssLayerLayout = {
  inChannels: number;
  outChannels: number;
  kernelSize: number;
  weightsOffsetU32: number;
  biasOffsetF32: number;
  rescaleOffsetF32: number;
  lutOffsetU32: number;
  activation: NssActivation;
  hasBias: boolean;
  hasLut: boolean;
  outputZeroPoint: number;
};

export class NssModel {
  constructor(readonly layers: readonly NssLayer[]) {}

  packWeights(): Uint8Array {
    return concatUint8(this.layers.map((layer) => layer.weights));
  }

  packBiases(): Float32Array {
    return concatFloat32(
      this.layers.flatMap((layer) => layer.bias === null ? [] : [layer.bias])
    );
  }

  packRescales(): Float32Array {
    return concatFloat32(this.layers.map((layer) => layer.rescales));
  }

  packLuts(): Uint8Array {
    return concatUint8(
      this.layers.flatMap((layer) => layer.lut === null ? [] : [layer.lut])
    );
  }

  getLayout(): NssLayerLayout[] {
    const result: NssLayerLayout[] = [];
    let weightsOffset = 0;
    let biasOffset = 0;
    let rescaleOffset = 0;
    let lutOffset = 0;
    for (const layer of this.layers) {
      result.push({
        inChannels: layer.inChannels,
        outChannels: layer.outChannels,
        kernelSize: layer.kernelSize,
        weightsOffsetU32: weightsOffset / 4,
        biasOffsetF32: layer.bias === null ? 0 : biasOffset,
        rescaleOffsetF32: rescaleOffset,
        lutOffsetU32: lutOffset / 4,
        activation: layer.activation,
        hasBias: layer.bias !== null,
        hasLut: layer.lut !== null,
        outputZeroPoint: layer.outputZeroPoint
      });
      weightsOffset += layer.weights.length;
      if (layer.bias !== null) biasOffset += layer.bias.length;
      rescaleOffset += layer.rescales.length;
      if (layer.lut !== null) lutOffset += layer.lut.length;
    }
    return result;
  }
}

let cachedModel: NssModel | null = null;

export function obtainBuiltInNssModel(): NssModel {
  cachedModel ??= parseNssModel(decodeBase64(NSS_MODEL_BASE64));
  return cachedModel;
}

function parseNssModel(bytes: Uint8Array): NssModel {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let offset = 0;
  const readUint32 = (): number => {
    const value = view.getUint32(offset, true);
    offset += 4;
    return value;
  };
  const readInt32 = (): number => {
    const value = view.getInt32(offset, true);
    offset += 4;
    return value;
  };
  const readUint8 = (): number => bytes[offset++]!;

  const layerCount = readUint32();
  const weightsLength = readUint32();
  const biasesLength = readUint32();
  const rescalesLength = readUint32();
  const lutsLength = readUint32();
  const metadata: Array<{
    inChannels: number;
    outChannels: number;
    kernelSize: number;
    outputZeroPoint: number;
    activation: NssActivation;
    hasBias: boolean;
    hasLut: boolean;
  }> = [];
  const activations: readonly NssActivation[] = [
    "identity",
    "relu",
    "leaky_relu"
  ];
  for (let index = 0; index < layerCount; index++) {
    const inChannels = readUint32();
    const outChannels = readUint32();
    const kernelSize = readUint32();
    const outputZeroPoint = readInt32();
    const activation = activations[readUint8()];
    const hasBias = readUint8() !== 0;
    const hasLut = readUint8() !== 0;
    readUint8();
    if (activation === undefined) {
      throw new Error(`Unsupported NSS activation index at layer ${index}`);
    }
    metadata.push({
      inChannels,
      outChannels,
      kernelSize,
      outputZeroPoint,
      activation,
      hasBias,
      hasLut
    });
  }

  const packedWeights = bytes.slice(offset, offset + weightsLength);
  offset += weightsLength;
  const packedBiases = copyFloat32(view, offset, biasesLength);
  offset += biasesLength * 4;
  const packedRescales = copyFloat32(view, offset, rescalesLength);
  offset += rescalesLength * 4;
  const packedLuts = bytes.slice(offset, offset + lutsLength);

  const layers: NssLayer[] = [];
  let weightsOffset = 0;
  let biasOffset = 0;
  let rescaleOffset = 0;
  let lutOffset = 0;
  for (const item of metadata) {
    const layerWeightLength =
      item.outChannels * item.kernelSize * item.kernelSize * item.inChannels;
    const weights = packedWeights.slice(
      weightsOffset,
      weightsOffset + layerWeightLength
    );
    weightsOffset += layerWeightLength;
    const bias = item.hasBias
      ? packedBiases.slice(biasOffset, biasOffset + item.outChannels)
      : null;
    if (bias !== null) biasOffset += item.outChannels;
    const rescales = packedRescales.slice(
      rescaleOffset,
      rescaleOffset + item.outChannels
    );
    rescaleOffset += item.outChannels;
    const lut = item.hasLut ? packedLuts.slice(lutOffset, lutOffset + 256) : null;
    if (lut !== null) lutOffset += 256;
    layers.push({
      ...item,
      weights,
      bias,
      rescales,
      lut
    });
  }
  return new NssModel(layers);
}

function decodeBase64(value: string): Uint8Array {
  const decoded = atob(value);
  const bytes = new Uint8Array(decoded.length);
  for (let index = 0; index < decoded.length; index++) {
    bytes[index] = decoded.charCodeAt(index);
  }
  return bytes;
}

function copyFloat32(view: DataView, byteOffset: number, length: number): Float32Array {
  const values = new Float32Array(length);
  for (let index = 0; index < length; index++) {
    values[index] = view.getFloat32(byteOffset + index * 4, true);
  }
  return values;
}

function concatUint8(parts: readonly Uint8Array[]): Uint8Array {
  const result = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    result.set(part, offset);
    offset += part.length;
  }
  return result;
}

function concatFloat32(parts: readonly Float32Array[]): Float32Array {
  const result = new Float32Array(parts.reduce((sum, part) => sum + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    result.set(part, offset);
    offset += part.length;
  }
  return result;
}
