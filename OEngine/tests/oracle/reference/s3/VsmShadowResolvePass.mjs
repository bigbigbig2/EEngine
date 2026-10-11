// Frozen S3/reference at 9f305c4128b0355614ececbe2be890582d6e8f2d.
// Test only; preserve numeric and quality reference independently of production cutover.
import { GpuBindGroupCache } from "../../../../.test-dist/gpu/GpuBindGroupResourceCache.js";
import { GPU_MESHLET_WORK_QUEUE_HEADER_OFFSETS } from "../../../../.test-dist/gpu/GpuMeshletRasterWorkAbi.js";
import { vsmShadowResolveWgsl } from "./vsm_shadow_resolve.mjs";
import { createNativeTextureView } from "../../../../.test-dist/gpu/GPUTextureDescriptors.js";
import { VSM_IDENTITY_BYTE_OFFSET } from "../../../../.test-dist/render/vsm/VsmProjection.js";
import { PACKED_CAMERA_TYPE } from "../../../../.test-dist/shaders/packed_camera.js";
const QUERY_KEYS = typeof __EENGINE_PERFORMANCE_DIAGNOSTICS__ !== "undefined" &&
    __EENGINE_PERFORMANCE_DIAGNOSTICS__ &&
    new URLSearchParams(globalThis.location.search).get("nativeCostSlice") === "K";
/** Frame-local projection owner. No history or CPU publication advances on
 * encode/abort: the FrameGraph pool owns/fences the fully rewritten mask.
 * The two geometry capability PSOs are immutable; no per-material specialization.
 * All buffer uploads and generation/mode copies use the existing frame encoder. */
export class VsmShadowResolvePass {
    device;
    mode;
    settings;
    settingWords = new Uint32Array(16);
    settingFloats = new Float32Array(this.settingWords.buffer);
    pipelines = new Map();
    groups = new GpuBindGroupCache();
    atlasSampler;
    queryKeys = null;
    queryKeysView = null;
    destroyed = false;
    constructor(device) {
        this.device = device;
        if (device.limits.maxComputeInvocationsPerWorkgroup < 64 ||
            device.limits.maxComputeWorkgroupSizeX < 8 ||
            device.limits.maxComputeWorkgroupSizeY < 8 ||
            device.limits.maxComputeWorkgroupStorageSize < 288 ||
            device.limits.maxStorageBuffersPerShaderStage < 10 ||
            device.limits.maxSampledTexturesPerShaderStage < 3 ||
            device.limits.maxSamplersPerShaderStage < 1 ||
            device.limits.maxStorageTexturesPerShaderStage < (QUERY_KEYS ? 2 : 1) ||
            device.limits.maxUniformBuffersPerShaderStage < 4 ||
            device.limits.maxBindGroups < 2) {
            throw new RangeError("VSM Shadow Resolve exceeds negotiated shader limits");
        }
        this.settings = device.createBuffer({
            label: "VSM/Shadow Resolve settings",
            size: 64,
            usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
        });
        try {
            this.mode = device.createBuffer({
                label: "VSM/Shadow Visibility mode",
                size: 16,
                usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
            });
        }
        catch (error) {
            this.settings.destroy();
            throw error;
        }
        this.atlasSampler = device.createSampler({
            label: "VSM/Exact point footprint gather",
            minFilter: "nearest",
            magFilter: "nearest",
            mipmapFilter: "nearest",
            addressModeU: "clamp-to-edge",
            addressModeV: "clamp-to-edge",
        });
        void device.lost.then(() => this.destroy());
    }
    pipeline(product) {
        const existing = this.pipelines.get(product);
        if (existing !== undefined) {
            return existing;
        }
        const read = (binding) => ({
            binding,
            visibility: GPUShaderStage.COMPUTE,
            buffer: { type: "read-only-storage" },
        });
        const geometry = [
            { binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: "uniform", minBindingSize: 64 } },
            read(1),
            read(2),
            read(3),
            read(4),
            { binding: 5, visibility: GPUShaderStage.COMPUTE, texture: { sampleType: "uint" } },
            { binding: 6, visibility: GPUShaderStage.COMPUTE, texture: { sampleType: "depth" } },
            {
                binding: 7,
                visibility: GPUShaderStage.COMPUTE,
                storageTexture: { format: "r32uint", access: "write-only" },
            },
            {
                binding: 8,
                visibility: GPUShaderStage.COMPUTE,
                buffer: { type: "uniform", minBindingSize: PACKED_CAMERA_TYPE.size },
            },
        ];
        if (product) {
            for (let binding = 10; binding < 15; binding++) {
                geometry.push(read(binding));
            }
        }
        if (QUERY_KEYS) {
            geometry.push({
                binding: 15,
                visibility: GPUShaderStage.COMPUTE,
                storageTexture: { format: "rgba32uint", access: "write-only", viewDimension: "2d-array" },
            });
        }
        const layouts = [
            this.device.createBindGroupLayout({ entries: geometry }),
            this.device.createBindGroupLayout({
                entries: [
                    {
                        binding: 0,
                        visibility: GPUShaderStage.COMPUTE,
                        buffer: { type: "uniform", minBindingSize: 256 },
                    },
                    read(1),
                    { binding: 2, visibility: GPUShaderStage.COMPUTE, texture: { sampleType: "depth" } },
                    { binding: 3, visibility: GPUShaderStage.COMPUTE, buffer: { type: "uniform", minBindingSize: 16 } },
                    { binding: 4, visibility: GPUShaderStage.COMPUTE, sampler: { type: "non-filtering" } },
                ],
            }),
        ];
        const result = {
            layouts,
            pipeline: this.device.createComputePipeline({
                label: "VSM/Directional Shadow Resolve",
                layout: this.device.createPipelineLayout({ bindGroupLayouts: layouts }),
                compute: {
                    module: this.device.createShaderModule({
                        label: "VSM/Directional Shadow Resolve",
                        code: vsmShadowResolveWgsl(product, QUERY_KEYS),
                    }),
                    entryPoint: "main",
                },
            }),
        };
        this.pipelines.set(product, result);
        return result;
    }
    encode(command, frame) {
        if (this.destroyed) {
            throw new Error("VSM Shadow Resolve has been destroyed");
        }
        if (!Number.isSafeInteger(frame.width) ||
            !Number.isSafeInteger(frame.height) ||
            frame.width < 1 ||
            frame.height < 1 ||
            frame.width > this.device.limits.maxTextureDimension2D ||
            frame.height > this.device.limits.maxTextureDimension2D ||
            Math.ceil(frame.width / 8) > this.device.limits.maxComputeWorkgroupsPerDimension ||
            Math.ceil(frame.height / 8) > this.device.limits.maxComputeWorkgroupsPerDimension ||
            frame.output.width !== Math.ceil(frame.width / 4) ||
            frame.output.height !== frame.height ||
            frame.output.format !== "r32uint" ||
            frame.visibility.width !== frame.width ||
            frame.visibility.height !== frame.height ||
            frame.visibility.format !== "r32uint" ||
            frame.depth.width !== frame.width ||
            frame.depth.height !== frame.height ||
            frame.depth.format !== "depth32float" ||
            frame.camera.size < PACKED_CAMERA_TYPE.size ||
            !frame.cameraPosition.every(Number.isFinite)) {
            throw new RangeError("VSM Shadow Resolve requires its complete packed internal-resolution domain");
        }
        const geometry = frame.geometry;
        if ((geometry.productHeap === undefined) !== (geometry.productBanks === undefined) ||
            (geometry.productBanks !== undefined && geometry.productBanks.length !== 4)) {
            throw new Error("VSM Shadow Resolve requires a complete geometry publication");
        }
        this.settingWords.set(geometry.source, 0);
        this.settingWords.set(geometry.sourcePayload, 4);
        this.settingWords.set([frame.width, frame.height, 0, 0], 8);
        this.settingFloats.set(frame.cameraPosition, 12);
        command.writeBuffer(this.settings, 0, this.settingWords.buffer, 0, this.settingWords.byteLength);
        command.copyBufferToBuffer(geometry.meshletWork, GPU_MESHLET_WORK_QUEUE_HEADER_OFFSETS.generation, this.settings, 44, 4);
        command.copyBufferToBuffer(frame.constants, VSM_IDENTITY_BYTE_OFFSET + 8, this.mode, 0, 4);
        const pipeline = this.pipeline(geometry.productHeap !== undefined);
        if (QUERY_KEYS &&
            (this.queryKeys === null ||
                this.queryKeys.width !== frame.width ||
                this.queryKeys.height !== frame.height)) {
            const previous = this.queryKeys;
            this.queryKeys = this.device.createTexture({
                label: "Diagnostic/Native VSM query keys",
                size: [frame.width, frame.height, 3],
                format: "rgba32uint",
                usage: GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.COPY_SRC,
            });
            this.queryKeysView = this.queryKeys.createView({ dimension: "2d-array" });
            if (previous !== null) {
                void this.device.queue.onSubmittedWorkDone().then(() => previous.destroy(), () => previous.destroy());
            }
        }
        const geometryEntries = [
            { binding: 0, resource: { buffer: this.settings } },
            { binding: 1, resource: { buffer: geometry.meshletWork } },
            { binding: 2, resource: { buffer: geometry.arena } },
            { binding: 3, resource: { buffer: geometry.vertexPayload } },
            { binding: 4, resource: { buffer: geometry.instances } },
            { binding: 5, resource: createNativeTextureView(frame.visibility) },
            { binding: 6, resource: createNativeTextureView(frame.depth) },
            { binding: 7, resource: createNativeTextureView(frame.output) },
            { binding: 8, resource: { buffer: frame.camera } },
        ];
        if (geometry.productHeap !== undefined) {
            geometryEntries.push({ binding: 10, resource: { buffer: geometry.productHeap } });
            geometry.productBanks.forEach((buffer, index) => geometryEntries.push({ binding: 11 + index, resource: { buffer } }));
        }
        if (this.queryKeysView !== null) {
            geometryEntries.push({ binding: 15, resource: this.queryKeysView });
        }
        const groups = [
            this.groups.create(this.device, { layout: pipeline.layouts[0], entries: geometryEntries }),
            this.groups.create(this.device, {
                layout: pipeline.layouts[1],
                entries: [
                    { binding: 0, resource: { buffer: frame.constants } },
                    { binding: 1, resource: { buffer: frame.descriptors } },
                    { binding: 2, resource: frame.atlas },
                    { binding: 3, resource: { buffer: frame.sun } },
                    { binding: 4, resource: this.atlasSampler },
                ],
            }),
        ];
        const pass = command.beginComputePass({ label: "VSM/Directional Shadow Resolve" });
        pass.setPipeline(pipeline.pipeline);
        groups.forEach((group, index) => pass.setBindGroup(index, group));
        pass.dispatchWorkgroups(Math.ceil(frame.width / 8), Math.ceil(frame.height / 8));
        pass.end();
    }
    destroy() {
        if (this.destroyed) {
            return;
        }
        this.destroyed = true;
        this.groups.clear();
        this.pipelines.clear();
        const resources = [this.settings, this.mode];
        if (this.queryKeys !== null) {
            resources.push(this.queryKeys);
        }
        this.queryKeys = null;
        this.queryKeysView = null;
        // Already-submitted frames may still reference these bindings. Device loss
        // also settles the fence through rejection; both paths release once.
        const release = () => resources.forEach((resource) => resource.destroy());
        void this.device.queue.onSubmittedWorkDone().then(release, release);
    }
}
