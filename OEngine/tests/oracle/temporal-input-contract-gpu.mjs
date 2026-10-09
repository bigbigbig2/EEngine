import assert from "node:assert/strict";
import { NATIVE_TEMPORAL_FACTS_WGSL } from "../../.test-dist/shaders/native_surface_aux.js";
import { HIERARCHY_LOD_WGSL } from "../../.test-dist/shaders/hierarchy_lod.js";
import { GPU_INSTANCE_RECORD_WGSL, packGpuInstanceRecord } from "../../.test-dist/gpu/GpuInstanceAbi.js";
import { GPUCameraState } from "../../.test-dist/render/GPUCameraState.js";
import { GPUViewContext } from "../../.test-dist/render/ViewContext.js";
import { PerspectiveCamera } from "../../.test-dist/camera/PerspectiveCamera.js";
import { packHierarchyViewUniform } from "../../.test-dist/render/HierarchicalWorkGenerator.js";

/** Small numeric oracle for the actual production shaders, not a second temporal path. */
export async function runTemporalInputContractGpuOracle(device) {
  const resources = [];
  const buffer = (data, usage = GPUBufferUsage.STORAGE) => {
    const b = device.createBuffer({
      size: typeof data === "number" ? data : data.byteLength,
      usage:
        usage | GPUBufferUsage.COPY_DST | (usage === GPUBufferUsage.MAP_READ ? 0 : GPUBufferUsage.COPY_SRC)
    });
    resources.push(b);
    if (typeof data !== "number") device.queue.writeBuffer(b, 0, data);
    return b;
  };
  const texture = (format, usage) => {
    const t = device.createTexture({ size: [8, 8], format, usage: usage | GPUTextureUsage.TEXTURE_BINDING });
    resources.push(t);
    return t;
  };
  const identity = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
  const instanceRecord = (generation = 1) =>
    packGpuInstanceRecord({
      geometryRecordIndex: 0,
      geometryGeneration: generation,
      instanceSetGeneration: 1,
      materialHandle: 0,
      flags: 1,
      debugId: 0,
      boundsSphere: [0, 0, 0, 1],
      boundsMin: [-1, -1, -1],
      boundsMax: [1, 1, 1],
      currentObjectToWorld: identity,
      previousObjectToWorld: identity
    });
  const currentCamera = new GPUCameraState(device, new PerspectiveCamera());
  const previousCamera = new GPUCameraState(device, new PerspectiveCamera());
  resources.push(currentCamera, previousCamera);
  const command = { writeBuffer: (...args) => device.queue.writeBuffer(...args) };
  const setCamera = (state, jitter) => {
    GPUViewContext.prototype.setJitter.call(
      { camera: state, jitter: new Float32Array(2), width: 8, height: 8 },
      ...jitter
    );
    state.update(command);
  };
  try {
    const visibility = texture("r32uint", GPUTextureUsage.COPY_DST);
    const depth = texture("depth32float", GPUTextureUsage.RENDER_ATTACHMENT);
    const opaque = texture("rgba8unorm", GPUTextureUsage.COPY_DST);
    const previous = texture("rgba32uint", GPUTextureUsage.COPY_DST);
    const outputIdentity = texture("rgba32uint", GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.COPY_SRC);
    const motion = texture("rg32float", GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.COPY_SRC);
    const mask = texture("rgba8unorm", GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.COPY_SRC);
    const instance = buffer(instanceRecord());
    const versions = buffer(new Uint32Array([11, 1]));
    const work = buffer(new Uint32Array([1, 1, 0, 1, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0]));
    const constants = buffer(new Uint32Array([8, 8, 1, 1, 0, 0, 0, 0]), GPUBufferUsage.UNIFORM);
    const pipeline = device.createComputePipeline({
      layout: "auto",
      compute: { module: device.createShaderModule({ code: NATIVE_TEMPORAL_FACTS_WGSL }), entryPoint: "main" }
    });
    const group = device.createBindGroup({
      layout: pipeline.getBindGroupLayout(0),
      entries: [
        ...[
          [0, visibility],
          [2, depth],
          [3, previous],
          [10, motion],
          [11, mask],
          [12, outputIdentity],
          [18, opaque]
        ].map(([binding, t]) => ({ binding, resource: t.createView() })),
        ...[
          [4, work],
          [5, instance],
          [7, currentCamera.buffer],
          [8, previousCamera.buffer],
          [9, constants],
          [17, versions]
        ].map(([binding, b]) => ({ binding, resource: { buffer: b } }))
      ]
    });
    const read = buffer(8 * 256, GPUBufferUsage.MAP_READ);
    const motionRead = buffer(8 * 256, GPUBufferUsage.MAP_READ);
    const rows = [];
    let previousJitter = [0, 0];
    const cases = [
      "seed",
      "primitive",
      "meshlet-lod",
      "coverage-interior",
      "coverage-edge",
      "replacement",
      "material-replacement",
      "far-reverse-z",
      "invalid-motion"
    ];
    for (const [index, name] of cases.entries()) {
      const jitter = index % 2 ? [0.25, -0.25] : [-0.25, 0.25];
      setCamera(currentCamera, jitter);
      setCamera(previousCamera, previousJitter);
      device.queue.writeTexture(
        { texture: visibility },
        new Uint32Array(64).fill(name === "primitive" ? 1 << 24 : 0),
        { bytesPerRow: 32 },
        [8, 8]
      );
      if (name === "meshlet-lod") device.queue.writeBuffer(work, 40, new Uint32Array([71, 0, 0, 3 << 8]));
      const coverage = new Uint8Array(256);
      if (name.startsWith("coverage")) for (let p = 0; p < 64; p++) coverage[p * 4 + 1] = 255;
      device.queue.writeTexture({ texture: opaque }, coverage, { bytesPerRow: 32 }, [8, 8]);
      if (name === "coverage-edge")
        device.queue.writeTexture(
          { texture: visibility, origin: [3, 4] },
          new Uint32Array([0xffffffff]),
          { bytesPerRow: 4 },
          [1, 1]
        );
      if (name === "replacement") device.queue.writeBuffer(instance, 0, instanceRecord(2));
      if (name === "material-replacement") device.queue.writeBuffer(versions, 0, new Uint32Array([12, 2]));
      if (name === "invalid-motion") device.queue.writeBuffer(constants, 8, new Uint32Array([0]));
      const encoder = device.createCommandEncoder();
      const clear = encoder.beginRenderPass({
        colorAttachments: [],
        depthStencilAttachment: {
          view: depth.createView(),
          depthClearValue: name === "far-reverse-z" ? 0.00001 : 0.05,
          depthLoadOp: "clear",
          depthStoreOp: "store"
        }
      });
      clear.end();
      const pass = encoder.beginComputePass();
      pass.setPipeline(pipeline);
      pass.setBindGroup(0, group);
      pass.dispatchWorkgroups(1);
      pass.end();
      encoder.copyTextureToBuffer({ texture: mask }, { buffer: read, bytesPerRow: 256 }, [8, 8]);
      encoder.copyTextureToBuffer({ texture: motion }, { buffer: motionRead, bytesPerRow: 256 }, [8, 8]);
      encoder.copyTextureToTexture({ texture: outputIdentity }, { texture: previous }, [8, 8]);
      device.queue.submit([encoder.finish()]);
      await read.mapAsync(GPUMapMode.READ);
      const values = new Uint8Array(read.getMappedRange());
      const center = [...values.subarray(4 * 256 + 4 * 4, 4 * 256 + 5 * 4)];
      read.unmap();
      await motionRead.mapAsync(GPUMapMode.READ);
      const measuredMotion = [...new Float32Array(motionRead.getMappedRange(), 4 * 256 + 4 * 8, 2)];
      motionRead.unmap();
      rows.push({ name, reactive: center[0] / 255, valid: center[1], hard: center[2], measuredMotion });
      if (center[1] === 255)
        for (let axis = 0; axis < 2; axis++) {
          assert.ok(
            Math.abs(measuredMotion[axis] * 8 - (jitter[axis] - previousJitter[axis])) < 1e-5,
            "jittered native motion sign/units"
          );
          const fsrMotion = -measuredMotion[axis] - (previousJitter[axis] - jitter[axis]) / 8;
          assert.ok(Math.abs(fsrMotion) < 1e-6, "FSR cancellation leaves zero static camera motion");
        }
      if (["primitive", "meshlet-lod", "coverage-interior", "far-reverse-z"].includes(name)) {
        assert.equal(center[0], 0, `${name} stays accumulatable`);
        assert.equal(center[1], 255);
        assert.equal(center[2], 0, `${name} is not a replacement`);
      }
      if (name === "coverage-edge") assert.ok(center[0] > 0 && center[0] < 64, "bounded exact coverage hint");
      if (name.endsWith("replacement")) {
        assert.equal(center[2], 255);
        assert.equal(center[0], 0);
      }
      if (name === "invalid-motion") {
        assert.equal(center[1], 0);
        assert.equal(center[0], 0);
      }
      previousJitter = jitter;
    }

    // Same shared anchor algebra executed on GPU. Probe both sides of an SSE
    // boundary; the anchor must stay identical inside its deadband and reset outside.
    const lodShader = `${GPU_INSTANCE_RECORD_WGSL}\n${HIERARCHY_LOD_WGSL}
@group(0) @binding(0) var<uniform> view: OEngineHierarchyView;
@group(0) @binding(1) var<storage, read> instances: array<OEngineInstanceRecord>;
@group(0) @binding(2) var<storage, read_write> anchors: array<OEngineLodAnchor>;
@group(0) @binding(3) var<storage, read_write> result: array<vec4f>;
@compute @workgroup_size(1) fn main() {
 let sphere = OEngineWorldSphere(vec3f(0.0), 1.0);
 let anchor = hierarchy_update_lod_anchor(anchors[0], instances[0], sphere, &view);
 anchors[0] = anchor;
 result[0] = vec4f(anchor.camera.z, anchor.camera.w,
  hierarchy_projected_error_at_anchor(0.72, sphere, 1.0, anchor, &view),
  hierarchy_projected_error_pixels(0.72, sphere, 1.0, &view));
}`;
    const lodPipeline = device.createComputePipeline({
      layout: "auto",
      compute: {
        module: device.createShaderModule({ code: lodShader }),
        entryPoint: "main"
      }
    });
    const view = buffer(256, GPUBufferUsage.UNIFORM),
      anchors = buffer(32),
      result = buffer(16);
    const lodRead = buffer(16, GPUBufferUsage.MAP_READ);
    const lodGroup = device.createBindGroup({
      layout: lodPipeline.getBindGroupLayout(0),
      entries: [view, instance, anchors, result].map((b, binding) => ({ binding, resource: { buffer: b } }))
    });
    const lod = [];
    for (const z of [10, 10.02, 9.98, 10.6]) {
      device.queue.writeBuffer(
        view,
        0,
        packHierarchyViewUniform(
          {
            kind: "perspective",
            cameraPosition: [0, 0, z],
            verticalFovRadians: Math.PI / 2,
            nearPlane: 0.1,
            viewportHeight: 100,
            frustumPlanes: Array.from({ length: 6 }, () => [0, 0, 0, 1])
          },
          4,
          0,
          1,
          1,
          false,
          65535
        )
      );
      const encoder = device.createCommandEncoder(),
        pass = encoder.beginComputePass();
      pass.setPipeline(lodPipeline);
      pass.setBindGroup(0, lodGroup);
      pass.dispatchWorkgroups(1);
      pass.end();
      encoder.copyBufferToBuffer(result, 0, lodRead, 0, 16);
      device.queue.submit([encoder.finish()]);
      await lodRead.mapAsync(GPUMapMode.READ);
      lod.push([...new Float32Array(lodRead.getMappedRange())]);
      lodRead.unmap();
    }
    assert.equal(lod[0][0], lod[1][0]);
    assert.equal(lod[0][2], lod[1][2]);
    assert.equal(lod[0][0], lod[2][0]);
    assert.equal(lod[0][2], lod[2][2]);
    assert.ok(lod[1][3] < 4 && lod[2][3] > 4, "ordinary SSE crosses threshold");
    for (const values of lod)
      assert.ok(values[2] >= values[3], "stable error conservatively bounds true error");
    assert.ok(lod[3][0] > 10.5, "anchor updates outside deadband");
    return { rows, lod };
  } finally {
    await device.queue.onSubmittedWorkDone();
    for (const resource of resources) resource.destroy();
  }
}
