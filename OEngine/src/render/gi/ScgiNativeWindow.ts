import { VSM_RECEIVER_DESCRIPTOR_REFERENCES } from "../../gpu/GpuVsmProjectionAbi.js";
import type { ShadeGPUCommandContext } from "../../framegraph/ShadeGPUCommandContext.js";
import type { ScgiFramePublication } from "./ScgiPublication.js";
import type { FinalPixelLightingFrame } from "../lighting/FinalPixelLightingPublication.js";
import type { NativeSurfaceGeometry } from "../surface/SurfaceV4.js";
import { scgiFieldCopies } from "./ScgiLightingWindow.js";
import { FINAL_PIXEL_SOLAR_BYTES } from "../../gpu/FinalPixelAbi.js";
import type { SurfaceCacheGiSettings } from "./SurfaceCacheGiSettings.js";
import type { ScgiGatherFrame } from "./ScgiGather.js";

export interface ScgiNativeWindowInput {
  readonly publication: ScgiFramePublication;
  readonly lighting: FinalPixelLightingFrame;
  readonly command: ShadeGPUCommandContext;
  readonly debug: SurfaceCacheGiSettings["debug"];
  readonly gather?: ScgiGatherFrame | null;
  readonly lightingChanged?: boolean;
}

/** Encoder-ordered copies and gathers, called between Native compute passes.
 * No new Native binding; source field segments retain their GI owner/fence. */
export function encodeScgiNativeWindow(
  input: ScgiNativeWindowInput,
  window: number,
  geometry: NativeSurfaceGeometry,
  visibility: GPUTexture,
  entries: readonly GPUBindGroupEntry[],
  surfaceSettings: GPUBuffer,
  gather?: GPUComputePipeline,
): readonly [number, number, number, number] {
  const { lighting, publication, command } = input;
  const { plan } = lighting;
  const [width, height] = publication.extent;
  const [halfWidth, halfHeight] = publication.halfExtent;
  const columns = Math.ceil(width / plan.windowWidth);
  const x = (window % columns) * plan.windowWidth;
  const y = Math.floor(window / columns) * plan.windowRows;
  const w = Math.min(plan.windowWidth, width - x);
  const h = Math.min(plan.windowRows, height - y);
  const firstX = Math.max(0, Math.floor(x / 2) - 2);
  const firstY = Math.max(0, Math.floor(y / 2) - 2);
  const endX = Math.min(halfWidth, Math.ceil((x + w) / 2) + 2);
  const endY = Math.min(halfHeight, Math.ceil((y + h) / 2) + 2);
  const fieldWidth = endX - firstX;
  const fieldHeight = endY - firstY;
  const align = (bytes: number) =>
    Math.ceil(bytes / command.device.limits.minStorageBufferOffsetAlignment) *
    command.device.limits.minStorageBufferOffsetAlignment;
  const solarOffset = plan.remapped ? 0 : plan.solarOffset;
  const noiseOffset = plan.remapped ? FINAL_PIXEL_SOLAR_BYTES : plan.filterNoiseOffset;
  const lookupOffset = plan.remapped ? align(noiseOffset + plan.filterNoiseBytes) : plan.lookupOffset;
  const descriptorOffset = plan.remapped ? align(lookupOffset + w * h * 8) : plan.descriptorOffset;
  const fieldOffset = plan.remapped ? align(descriptorOffset + w * h * VSM_RECEIVER_DESCRIPTOR_REFERENCES * 20) : plan.giOffset;
  const fieldBytes = fieldWidth * fieldHeight * 112;
  const residualOffset = fieldOffset + fieldBytes;
  const residualBytes = input.gather == null ? 0 : fieldWidth * fieldHeight * 32;
  const requestOffset = residualOffset + residualBytes;
  const preparationOffset = requestOffset + (input.gather == null ? 0 : fieldWidth * fieldHeight * 8);
  const preparationBytes = input.gather == null ? 0 : fieldWidth * fieldHeight * 48;
  const prepareSource =
    input.gather != null &&
    input.gather.updateTransport &&
    !(input.gather.settings.gatherFreeze && input.gather.previousValid);
  if (preparationOffset + preparationBytes > lighting.nativeBuffer.size) {
    throw new RangeError("SCGI window does not fit its admitted complete directory");
  }
  const ranges = new Uint32Array([
    lookupOffset / 4,
    plan.lookupCount,
    descriptorOffset / 4,
    plan.descriptorCount,
    solarOffset / 4,
    noiseOffset / 4,
    fieldOffset / 4,
    fieldBytes / 4,
    halfWidth,
    halfHeight,
    firstY,
    1,
    x,
    w,
    h,
    y,
    width,
    height,
    [
      "off",
      "irradiance",
      "confidence",
      "world-only",
      "residual",
      "gather-confidence",
      "gather-source",
      "appearance-world-only",
    ].indexOf(input.debug),
    0,
    Number(plan.remapped),
    firstX,
    firstY,
    fieldWidth,
    residualOffset / 4,
    residualBytes / 4,
    Number(input.gather != null),
    0,
    requestOffset / 4,
    preparationOffset / 4,
    fieldWidth * fieldHeight,
    Number(prepareSource),
  ]);
  ranges[19] = Number(input.publication.activeWorld === null || input.lightingChanged === true);
  command.writeBuffer(lighting.ranges, 0, ranges.buffer, 0, ranges.byteLength);
  if (prepareSource && preparationBytes !== 0) {
    command.clearBuffer(lighting.nativeBuffer, preparationOffset, preparationBytes);
  }
  if (plan.remapped) {
    if (gather === undefined) {
      throw new Error("SCGI remapping requires its prepared geometry gather");
    }
    command.copyBufferToBuffer(
      lighting.buffer,
      plan.solarOffset,
      lighting.nativeBuffer,
      solarOffset,
      plan.solarBytes,
    );
    if (plan.filterNoiseBytes !== 0) {
      command.copyBufferToBuffer(
        lighting.buffer,
        plan.filterNoiseOffset,
        lighting.nativeBuffer,
        noiseOffset,
        plan.filterNoiseBytes,
      );
    }
    const values = new ArrayBuffer(256);
    const u = new Uint32Array(values);
    u.set(geometry.source);
    u.set(geometry.sourcePayload, 4);
    u.set([width, height, 0, 0], 8);
    // Camera/view data comes from the exact Surface settings publication. The
    // copy happens after Surface's current camera inverse-VP copy.
    u.set([x, w, h, y], 52);
    u.set([plan.lookupOffset / 4, plan.lookupCount, plan.descriptorOffset / 4, plan.descriptorCount], 56);
    u.set([lookupOffset / 4, descriptorOffset / 4, 0, 0], 60);
    const settings = command.allocateTransientBufferAndLoad(values);
    command.copyBufferToBuffer(surfaceSettings, 48, settings, 48, 160);
    const bufferEntry = (binding: number) => entries.find((entry) => entry.binding === binding)!.resource;
    const groups = [
      command.device.createBindGroup({
        layout: gather.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: { buffer: settings, size: 256 } },
          { binding: 1, resource: { buffer: geometry.meshletWork } },
          { binding: 2, resource: { buffer: geometry.arena } },
          { binding: 3, resource: { buffer: geometry.vertexPayload } },
          { binding: 4, resource: { buffer: geometry.instances } },
          { binding: 5, resource: visibility.createView() },
          { binding: 6, resource: { buffer: lighting.buffer } },
          { binding: 7, resource: { buffer: lighting.nativeBuffer } },
          { binding: 8, resource: bufferEntry(1) },
          { binding: 9, resource: bufferEntry(8) },
        ],
      }),
    ];
    if (geometry.productHeap !== undefined) {
      groups.push(
        command.device.createBindGroup({
          layout: gather.getBindGroupLayout(1),
          entries: [geometry.productHeap, ...geometry.productBanks!].map((buffer, binding) => ({
            binding,
            resource: { buffer },
          })),
        }),
      );
    }
    const pass = command.beginComputePass({ label: "SCGI/complete local VSM window gather" });
    pass.setPipeline(gather);
    groups.forEach((group, index) => pass.setBindGroup(index, group));
    pass.dispatchWorkgroups(Math.ceil((w * h) / 64));
    pass.end();
  }
  // A tile window may clip columns. Copy rows independently across arbitrary
  // physical field segment boundaries without manufacturing a full texture.
  for (let row = 0; row < fieldHeight; row++) {
    for (const copy of scgiFieldCopies(
      publication,
      (firstY + row) * halfWidth + firstX,
      fieldWidth,
      fieldOffset + row * fieldWidth * 112,
    )) {
      command.copyBufferToBuffer(
        copy.source,
        copy.sourceOffset,
        lighting.nativeBuffer,
        copy.destinationOffset,
        copy.bytes,
      );
    }
    if (input.gather != null) {
      if (prepareSource) {
        command.copyBufferToBuffer(
          input.gather.owner.work,
          (input.gather.owner.plan.work.requests + ((firstY + row) * halfWidth + firstX) * 2) * 4,
          lighting.nativeBuffer,
          requestOffset + row * fieldWidth * 8,
          fieldWidth * 8,
        );
      }
      let index = (firstY + row) * halfWidth + firstX;
      let remaining = fieldWidth;
      let destination = residualOffset + row * fieldWidth * 32;
      let segmentFirst = 0;
      for (let segment = 0; segment < publication.anchors.length && remaining > 0; segment++) {
        const count = publication.anchors[segment]!.plan.ranges.anchors!.count;
        if (index >= segmentFirst && index < segmentFirst + count) {
          const copied = Math.min(remaining, segmentFirst + count - index);
          command.copyBufferToBuffer(
            input.gather.residual[segment]!,
            (index - segmentFirst) * 32,
            lighting.nativeBuffer,
            destination,
            copied * 32,
          );
          index += copied;
          destination += copied * 32;
          remaining -= copied;
        }
        segmentFirst += count;
      }
      if (remaining !== 0) {
        throw new Error("SCGI residual does not cover its complete Native window");
      }
    }
  }
  return [x, y, w, h];
}
