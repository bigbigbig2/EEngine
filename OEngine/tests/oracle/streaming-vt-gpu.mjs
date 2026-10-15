import { Renderer } from "../../.test-dist/render/pipeline/RendererCore.js";
import { Scene } from "../../.test-dist/scene/Scene.js";
import { Mesh } from "../../.test-dist/scene/Mesh.js";
import { BoxGeometry, buildBoxSourceGeometry } from "../../.test-dist/geometry/BoxGeometry.js";
import { cookGeometryAssetPackage } from "../../.test-dist/geometry/GeometryCooker.js";
import { createGeometryCookRecipe } from "../../.test-dist/assets/GeometryCookRecipe.js";
import { StandardShadeMaterial } from "../../.test-dist/material/StandardShadeMaterial.js";
import { ShadeTexture } from "../../.test-dist/texture/ShadeTexture.js";
import { PerspectiveCamera } from "../../.test-dist/camera/PerspectiveCamera.js";
import { TiledTextureSource } from "../../.test-dist/assets/TiledTextureSource.js";
import {
  validateTiledTextureMetadata,
  TILED_TEXTURE_RECIPE,
  TILED_TEXTURE_TAIL_ORIGINS
} from "../../.test-dist/assets/TiledTextureProduct.js";
import { textureProductHash } from "../../.test-dist/assets/TextureProduct.js";
import { nativeSurfaceDescriptor } from "../../.test-dist/shaders/native_surface.js";
const check = (value, message) => {
  if (!value) {
    throw new Error(message);
  }
};

/** Analytic, valid BC4 blocks: endpoints equal and indices zero. This fixture
 * does not encode/transcode at runtime and has an independent constant oracle.
 * Production continues using the actual TiledTextureSource/provider contract. */
async function sourceFixture() {
  const encoded = (bytes, value) => {
    const data = new Uint8Array(bytes);
    for (let block = 0; block < bytes; block += 8) {
      data[block] = data[block + 1] = value;
    }
    return data;
  };
  const mips = [];
  for (let level = 0; level < 9; level++) {
    const width = Math.max(1, 256 >> level),
      height = Math.max(1, 128 >> level);
    const physicalWidth = Math.ceil(width / 4) * 4,
      physicalHeight = Math.ceil(height / 4) * 4;
    const byteLength = (physicalWidth * physicalHeight) / 2;
    mips.push({
      level,
      width,
      height,
      physicalWidth,
      physicalHeight,
      byteLength,
      chunkId: `scalar-mip-${level}`,
      hash: await textureProductHash(encoded(byteLength, 200))
    });
  }
  const payloads = [224, 224, 128, 32].map((value) => encoded(10368, value));
  const records = await Promise.all(
    payloads.map(async (bytes, id) => ({
      id,
      offset: id * 10368,
      byteLength: 10368,
      hash: await textureProductHash(bytes),
      shard: `p${id}.bin`
    }))
  );
  const metadata = {
    schemaVersion: 1,
    recipe: TILED_TEXTURE_RECIPE,
    sourceIdentity: "a".repeat(64),
    source: {
      schemaVersion: 3,
      sourceWidth: 256,
      sourceHeight: 128,
      storageWidth: 256,
      storageHeight: 128,
      sourceBytes: 131072,
      sourceHash: "b".repeat(64),
      sourceUri: "oracle://analytic-bc4",
      semantic: "occlusion-linear",
      channel: 0,
      exactAlpha: false,
      uvScaleBias: [1, 1, 0, 0],
      recipe: {
        encoder: "analytic-constant-bc4",
        revision: "1",
        binaryHash: "c".repeat(64),
        filter: "provided",
        quality: "external-final"
      },
      planes: [{ role: "scalar", format: "bc4-r-unorm", mips }]
    },
    pack: { uri: "constant.vtpack", byteLength: 4 * 10368 },
    payloads: records,
    planes: [
      {
        sourcePlane: 0,
        mode: "virtual",
        address: "repeat",
        tailFirst: 2,
        mips: mips.map((mip) => ({
          level: mip.level,
          width: mip.width,
          height: mip.height,
          gridWidth: mip.level === 0 ? 2 : 1,
          gridHeight: 1,
          payloads: mip.level === 0 ? [0, 1] : mip.level === 1 ? [2] : [3],
          ...(mip.level >= 2 ? { tailOrigin: TILED_TEXTURE_TAIL_ORIGINS[mip.level - 2] } : {})
        }))
      }
    ]
  };
  const bytes = new TextEncoder().encode(JSON.stringify(metadata));
  const directory = validateTiledTextureMetadata(metadata, await textureProductHash(bytes), bytes.length);
  let retained = 0,
    reads = 0;
  const preparation = {
    evidence: () => ({ tiled: { retained, reads } }),
    async readTiledPayloads(_session, _directory, ids, signal) {
      signal?.throwIfAborted();
      reads += ids.length;
      retained++;
      let released = false;
      const values = ids.map((id) => ({ id, bytes: payloads[id].slice().buffer }));
      return {
        payloads: values,
        release() {
          check(!released, "duplicate payload release");
          released = true;
          retained--;
          for (const value of values) {
            structuredClone(value.bytes, { transfer: [value.bytes] });
          }
        }
      };
    }
  };
  return { source: new TiledTextureSource(preparation, "oracle", directory), preparation };
}

/** Small VT-2 production wiring check. The complete boundary/pressure/source
 * differential and full Bistro/Dungeon acceptance remain VT-3. */
export async function runStreamingVtGpuOracle() {
  const renderer = new Renderer({
    enablePhysicalEnvironment: false,
    enableVsm: false,
    autoExposure: false,
    fixedExposure: 1
  });
  const errors = [],
    reports = [];
  const onError = (event) => errors.push(event.error.message);
  const fixture = await sourceFixture();
  const scene = new Scene(),
    geometry = new BoxGeometry(),
    material = new StandardShadeMaterial();
  material.texture_occlusion = ShadeTexture.fromTiled(fixture.source);
  scene.add(Mesh.from(geometry, material));
  const context = new OffscreenCanvas(128, 96).getContext("webgpu"),
    camera = new PerspectiveCamera();
  let device;
  let lastCommand, captured;
  try {
    await renderer.initialize({ context });
    device = renderer._graphics.device;
    device.addEventListener("uncapturederror", onError);
    renderer.pixel_ratio = 1;
    renderer.resize(128, 96);
    camera.aspect = 32 / 24;
    camera.near = 0.1;
    camera.far = 100;
    camera.transform.position.set(0, 0, 2);
    camera.transform.lookAt({ x: 0, y: 0, z: 0 });
    camera.update();
    const cooked = await cookGeometryAssetPackage(buildBoxSourceGeometry(), createGeometryCookRecipe());
    await renderer.uploadScene(scene, [{ geometry, asset: cooked.asset }]);
    const vt = renderer._graphics.texture_residency.virtualTextures;
    check(vt && vt.evidence().resident === 1, "bootstrap uploads only the protected tail");
    const prepare = renderer._surface.prepareFrameNow.bind(renderer._surface);
    renderer._surface.prepareFrameNow = (frame) => {
      captured = frame;
      return prepare(frame);
    };
    const prepareVt = vt.prepareFrame.bind(vt);
    vt.prepareFrame = (command, ...args) => {
      lastCommand = command;
      return prepareVt(command, ...args);
    };
    for (let frame = 0; frame < 24 && !vt.state().complete; frame++) {
      renderer.render(camera, scene);
      if (lastCommand?.wasSubmitted) {
        await lastCommand.gpuDone;
      }
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    check(captured?.virtualFeedback, "real Native Surface receives the VT feedback owner");
    check(vt.evidence().demand.wanted > 0, "real Native invocation records target mip demand");
    check(vt.evidence().resident > 1 && vt.state().complete, "normal frames refine current-view pages");
    const program = captured.publication.entries.find((entry) => entry.program.virtualTextures).program;
    const materialLayout = captured.publication.descriptor(0).groups[3];
    // Compile the actual bound material in the widest Surface profile. No
    // shortened shader, SSBO substitute, or reduced reflection output.
    const descriptor = nativeSurfaceDescriptor(program, materialLayout, {
      compact: true,
      productGeometry: true,
      unlit: false,
      physicalSun: true,
      reactive: true,
      finalPixel: true,
      reflections: "sssr-base-coat"
    });
    const storage = descriptor.groups.flat().filter((entry) => entry.buffer?.type.includes("storage")).length;
    check(storage === 16, `widest profile has ${storage} SSBO bindings`);
    const lease = renderer._graphics.appearance_programs.acquire(descriptor);
    await lease.ready;
    lease.release();
    reports.push({ name: "native-vt-current-view", ...vt.evidence(), storage });
    check(fixture.preparation.evidence().tiled.retained === 0, "all consumed leases released");
    check(errors.length === 0, errors.join("\n"));
    return { ok: true, reports };
  } finally {
    renderer.destroy();
    device?.removeEventListener("uncapturederror", onError);
  }
}
