import type { FrameGraph } from "../../framegraph/FrameGraph.js";
import { resolveGpuEncoder } from "../../framegraph/FrameGraph.js";
import type { ResourceId } from "../../framegraph/ResourceHandle.js";
import {
  FINAL_PIXEL_SOLAR_WIDTH,
  FINAL_PIXEL_SOLAR_HEIGHT,
  type FinalPixelLightingDirectoryPlan,
} from "../../gpu/FinalPixelAbi.js";

/** PhysicalEnvironment retains LUT ownership. FrameGraph owns the destination
 * container and its fence. Publish only the fixed 128KiB provider, never copy
 * VSM descriptors/local capacity or allocate a per-pixel lighting packet. */
export function addFinalPixelSolarPublication(
  graph: FrameGraph,
  input: {
    readonly transmittance: ResourceId;
    readonly target: ResourceId;
    readonly plan: FinalPixelLightingDirectoryPlan;
  },
): ResourceId {
  let output = -1;
  const pass = graph.add("Physical Sun/final lighting publication", input, (data, resources, context) => {
    const texture = resources.get(data.transmittance) as GPUTexture;
    const buffer = resources.get(output) as GPUBuffer;
    const encoder = resolveGpuEncoder(context);
    if (
      !encoder ||
      texture.format !== "rgba16float" ||
      texture.dimension !== "2d" ||
      texture.width !== FINAL_PIXEL_SOLAR_WIDTH ||
      texture.height !== FINAL_PIXEL_SOLAR_HEIGHT ||
      texture.depthOrArrayLayers !== 1 ||
      texture.sampleCount !== 1 ||
      (texture.usage & GPUTextureUsage.COPY_SRC) === 0 ||
      (buffer.usage & GPUBufferUsage.COPY_DST) === 0 ||
      buffer.size < data.plan.bytes ||
      data.plan.solarOffset % 8 !== 0 ||
      data.plan.solarBytes !== FINAL_PIXEL_SOLAR_WIDTH * FINAL_PIXEL_SOLAR_HEIGHT * 8 ||
      data.plan.solarOffset !== data.plan.descriptorOffset + data.plan.descriptorBytes ||
      data.plan.lookupOffset < data.plan.solarOffset + data.plan.solarBytes
    ) {
      throw new RangeError("Final Pixel solar publication requires the complete unchanged LUT and container");
    }
    encoder.copyTextureToBuffer(
      { texture },
      {
        buffer,
        offset: data.plan.solarOffset,
        bytesPerRow: FINAL_PIXEL_SOLAR_WIDTH * 8,
        rowsPerImage: FINAL_PIXEL_SOLAR_HEIGHT,
      },
      [FINAL_PIXEL_SOLAR_WIDTH, FINAL_PIXEL_SOLAR_HEIGHT],
    );
  });
  pass.read(input.transmittance);
  output = pass.write(input.target);
  return output;
}
