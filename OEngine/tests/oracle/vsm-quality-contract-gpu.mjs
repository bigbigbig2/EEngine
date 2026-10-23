import { SurfaceV4 } from "../../.test-dist/render/surface/SurfaceV4.js";
import { VSM_PAGE_COMMIT_WGSL } from "../../.test-dist/shaders/vsm_page_commit.js";
import { VSM_SAMPLING_PUBLICATION_WGSL } from "../../.test-dist/shaders/vsm_sampling_publication.js";
import { VsmReceiverDemandPass } from "../../.test-dist/render/vsm/VsmReceiverDemandPass.js";
import { VSM_DEFAULT_SETTINGS } from "../../.test-dist/render/vsm/VsmSettings.js";
import { VsmCasterRecordPass } from "../../.test-dist/render/vsm/VsmCasterRecordPass.js";
import { VsmAtlasRasterPass } from "../../.test-dist/render/vsm/VsmAtlasRasterPass.js";
import { VsmInvalidationPass } from "../../.test-dist/render/vsm/VsmInvalidationPass.js";
import { VsmDepthBoundsPass } from "../../.test-dist/render/vsm/VsmDepthBoundsPass.js";
import { ShadowTileDomain } from "../../.test-dist/render/ShadowTileDomain.js";
import { nativeVisibilityShader } from "../../.test-dist/shaders/native_visibility.js";
import { scgiLightingGatherWgsl } from "../../.test-dist/shaders/scgi_lighting_gather.js";
import { VSM_PROJECTION_CONSTANT_BYTES, VSM_DIMENSIONS_WORD, VSM_CONTROL_WORD,
  VSM_PARAMETERS_WORD, VSM_DEPTH_RANGE_BYTE_OFFSET, VSM_SELECTOR_WORD,
  } from "../../.test-dist/gpu/GpuVsmProjectionAbi.js";
import { packVsmProjection } from "../../.test-dist/render/vsm/VsmProjection.js";
import { VSM_ADMISSION_WGSL } from "../../.test-dist/shaders/vsm_admission.js";
import { VSM_SAMPLING_WGSL } from "../../.test-dist/shaders/vsm_sampling.js";
import {
  VsmAllocatePagesPass,
  packVsmResidencyConstants,
} from "../../.test-dist/render/vsm/VsmAllocatePagesPass.js";
import { VsmResources } from "../../.test-dist/render/vsm/VsmResources.js";
import { negotiateVsmCapabilities } from "../../.test-dist/render/vsm/VsmCapabilities.js";
import { GraphicsContext } from "../../.test-dist/gpu/GraphicsContext.js";
import { FrameGraph } from "../../.test-dist/framegraph/FrameGraph.js";
import { ShadeGPUCommandContext } from "../../.test-dist/framegraph/ShadeGPUCommandContext.js";

const check = (condition, message) => {
  if (!condition) throw new Error(message);
};
const perClip = 4112;
const identity = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];

export async function runVsmQualityContractGpuOracle(device) {
  const retained = [];
  const make = (size, usage, initial) => {
    const buffer = device.createBuffer({
      label: "Quality contract fixture",
      size,
      usage,
      mappedAtCreation: !!initial,
    });
    retained.push(buffer);
    if (initial) {
      new Uint8Array(buffer.getMappedRange()).set(
        new Uint8Array(initial.buffer ?? initial, initial.byteOffset ?? 0, initial.byteLength),
      );
      buffer.unmap();
    }
    return buffer;
  };
  const inspect = async (buffer) => {
    const staging = make(buffer.size, GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ);
    const encoder = device.createCommandEncoder();
    encoder.copyBufferToBuffer(buffer, 0, staging, 0, buffer.size);
    device.queue.submit([encoder.finish()]);
    await staging.mapAsync(GPUMapMode.READ);
    const result = staging.getMappedRange().slice(0);
    staging.unmap();
    return result;
  };
  const compile = async (code, entryPoint = "main") => {
    const module = device.createShaderModule({ label: `Quality contract/${entryPoint}`, code });
    const errors = (await module.getCompilationInfo()).messages.filter((m) => m.type === "error");
    check(!errors.length, JSON.stringify(errors));
    return device.createComputePipelineAsync({ layout: "auto", compute: { module, entryPoint } });
  };
  const storage = GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST;
  const graphics = new GraphicsContext(device);
  const resources = VsmResources.create(device, negotiateVsmCapabilities(device, {clipLevels:16}));
  const allocate = new VsmAllocatePagesPass(device);
  const frame = {
    cameraPosition: [0, 0, 0],
    generation: 7,
    projectionEpoch: 7,
    namespace: resources.namespace,
    lightView: identity,
    clipOriginExtent: Array.from({ length: 16 }, (_, level) => {
      const extent = 128 * 2 ** level;
      return [-extent / 2, -extent / 2, extent, extent / 4096];
    }),
  };
  const profile = resources.capabilities;
  const fineCapacity = profile.residentSlots - profile.coarseReservedSlots;
  const raw = new Uint32Array(profile.requestedPagesBytes / 4);
  const scores = new Uint32Array(profile.virtualEntryCount);
  const coarse = perClip - 16;
  const request = (page, score) => {
    raw[page >>> 5] |= 1 << (page & 31);
    scores[page] = score;
  };
  // Old residents occupy the lowest keys, but the new high-benefit requests
  // have larger keys. This detects cache-hit/arrival-order priority.
  for (let page = 0; page < fineCapacity + 300; page++) request(page, page < fineCapacity ? 2 : 1024);
  request(coarse, 0);
  const expected = Array.from({ length: fineCapacity + 300 }, (_, i) => i)
    .sort((a, b) => Math.floor(Math.log2(scores[b])) - Math.floor(Math.log2(scores[a])) || a - b)
    .slice(0, fineCapacity)
    .sort((a, b) => a - b);
  const selectedPages = (words) => {
    const result = [];
    for (let page = 0; page < profile.virtualEntryCount; page++)
      if ((words[page >>> 5] & (1 << (page & 31))) !== 0) result.push(page);
    return result;
  };
  try {
    const surface = new SurfaceV4(device);
    try {
      const neutral = surface.neutralLightingEntries.find(e=>e.binding===8).resource.buffer;
      check(neutral.size===VSM_PROJECTION_CONSTANT_BYTES,"Disabled VSM binding retained old ABI");
    } finally { surface.destroy(); }
    // Compile all direct changed consumers once at the architecture boundary.
    for (const owner of [new VsmCasterRecordPass(device), new VsmAtlasRasterPass(graphics),
      new VsmInvalidationPass(device), new VsmDepthBoundsPass(device), new ShadowTileDomain(device)]) {
      try { await owner.preparePipelines(); } finally { owner.destroy(); }
    }
    for (const code of [nativeVisibilityShader(null, [], { shadow: true, vsmAtlas: true, partitioned: true }).source,
      scgiLightingGatherWgsl(false)]) {
      const info = await device.createShaderModule({ code }).getCompilationInfo();
      check(!info.messages.some(m => m.type === "error"), JSON.stringify(info.messages));
    }
    await allocate.preparePipelines();
    device.queue.writeBuffer(resources.requestedPages, 0, raw);
    device.queue.writeBuffer(resources.getBuffer("receiverPriority"), 0, scores);
    const table = new Uint32Array(profile.virtualEntryCount * 12);
    const metas = new Uint32Array(profile.residentSlots * 8);
    for (let page = 0; page < fineCapacity; page++) {
      const slot = profile.coarseReservedSlots + page;
      const x = page % 64,
        y = Math.floor(page / 64);
      const wx = x >= 32 ? x - 64 : x,
        wy = y >= 32 ? y - 64 : y;
      // Failed previous-frame work retains dirty/in-flight. It must not pin
      // nonadmitted slots against the new higher-benefit demand.
      const flags = page % 2 ? 15 : 9;
      table.set(
        [
          slot % profile.atlasPagesPerAxis,
          Math.floor(slot / profile.atlasPagesPerAxis),
          0,
          flags,
          7,
          5,
          1,
          7,
          wx >>> 0,
          wy >>> 0,
          resources.namespace,
          0,
        ],
        page * 12,
      );
      metas.set([page, 0, 1, flags, 7, slot, 1, 0], slot * 8);
    }
    device.queue.writeBuffer(resources.pageTable, 0, table);
    device.queue.writeBuffer(resources.metaTable, 0, metas);
    const encode = async (serial, abort = false, owner = resources, projection = frame) => {
      const graph = new FrameGraph("VSM quality contract/production admission");
      const command = ShadeGPUCommandContext.create(graphics, "Renderer/visibility-frame");
      const imported = (name, buffer) => graph.import_resource(name, { kind: "imported" }, buffer);
      allocate.addToGraph(graph, {
        demand: imported("raw demand", owner.requestedPages),
        priority: imported("benefit", owner.getBuffer("receiverPriority")),
        contentVersion: imported("content", owner.contentVersion),
        resources: owner,
        generation: 7,
        frameSerial: serial,
        frame: projection,
      });
      command.encodeGraph(graph);
      if (abort) {
        const rejected = command.gpuDone.catch((error) =>
          check(String(error).includes("quality abort"), String(error)),
        );
        command.abort(new Error("quality abort"));
        await rejected;
      } else {
        command.finish();
        await command.gpuDone;
      }
    };
    const before = new Uint32Array(await inspect(resources.pageTable));
    await encode(2, true);
    check(
      new Uint32Array(await inspect(resources.pageTable)).every((v, i) => v === before[i]),
      "Abort changed page ownership",
    );
    await encode(2);
    const admitted = new Uint32Array(await inspect(resources.getBuffer("admittedPages")));
    check(
      JSON.stringify(selectedPages(admitted)) === JSON.stringify([...expected, coarse]),
      "Production admission differs from CPU ranking",
    );
    check(
      new Uint32Array(await inspect(resources.requestedPages)).every((v, i) => v === raw[i]),
      "Admission overwrote raw demand",
    );
    const actualTable = new Uint32Array(await inspect(resources.pageTable));
    for (const page of expected)
      check((actualTable[page * 12 + 3] & 9) === 9, `Admitted page ${page} not allocated`);
    const stats = new Uint32Array(await inspect(resources.getBuffer("admissionStatistics")));
    check(stats[34] === fineCapacity + 300 && stats[35] === fineCapacity, "Missing explicit pressure counts");
    await encode(3);
    check(
      new Uint32Array(await inspect(resources.getBuffer("admittedPages"))).every((v, i) => v === admitted[i]),
      "Stable view changed admission",
    );

    // Ready publication still requires reverse ownership and complete native
    // page work. Invalid completion never turns a selected dirty page ready.
    const workWords = new Uint32Array(await inspect(resources.allocation));
    const commitUniform = make(16,GPUBufferUsage.UNIFORM,new Uint32Array([7,7,resources.namespace,profile.atlasPagesPerAxis]));
    const casterHeader = make(32,storage,new Uint32Array([0,0,0,7,0,0,workWords[1],7]));
    const completion = make(16,storage,new Uint32Array([0,1,0,0]));
    const commitPipeline = await compile(VSM_PAGE_COMMIT_WGSL);
    const commitGroup = device.createBindGroup({layout:commitPipeline.getBindGroupLayout(0),entries:
      [commitUniform,casterHeader,resources.pageTable,resources.metaTable,completion,resources.contentVersion,resources.allocation]
        .map((buffer,binding)=>({binding,resource:{buffer}}))});
    const commitOnce = async () => {
      const encoder=device.createCommandEncoder(),pass=encoder.beginComputePass();
      pass.setPipeline(commitPipeline);pass.setBindGroup(0,commitGroup);pass.dispatchWorkgroups(Math.ceil(profile.residentSlots/64));
      pass.end();device.queue.submit([encoder.finish()]);return new Uint32Array(await inspect(resources.pageTable));
    };
    const dirtyBefore=new Uint32Array(await inspect(resources.pageTable));
    check((await commitOnce()).every((v,i)=>v===dirtyBefore[i]),"Incomplete Native work published ready");
    device.queue.writeBuffer(completion,4,new Uint32Array([0]));
    device.queue.writeBuffer(casterHeader,8,new Uint32Array([1]));
    check((await commitOnce()).every((v,i)=>v===dirtyBefore[i]),"Failed Geometry published ready");
    device.queue.writeBuffer(casterHeader,8,new Uint32Array([0]));
    const victimPage=workWords[4],victimSlot=workWords[5];
    device.queue.writeBuffer(resources.metaTable,victimSlot*32+20,new Uint32Array([0xffffffff]));
    const rejectedOwner=await commitOnce();
    check((rejectedOwner[victimPage*12+3]&2)!==0,"Revoked reverse owner published ready");
    device.queue.writeBuffer(resources.metaTable,victimSlot*32+20,new Uint32Array([victimSlot]));
    const complete=await commitOnce();
    for(let i=0;i<workWords[1];i++)check((complete[workWords[4+i*8]*12+3]&6)===0,"Complete page stayed dirty");
    check((await commitOnce()).every((v,i)=>v===complete[i]),"Repeated commit changed page version");

    // A one-fine-page roll revokes departed identities, not retained pages.
    const invalidation = new VsmInvalidationPass(device);
    try {
      await invalidation.preparePipelines();
      const rolledFrame = { ...frame, clipOriginExtent: frame.clipOriginExtent.map(([x,y,e,t])=>[x+e/64,y+e/64,e,t]) };
      const graph = new FrameGraph("quality/roll");
      const command = ShadeGPUCommandContext.create(graphics,"Renderer/visibility-frame");
      invalidation.addToGraph(graph,{resources,frame:rolledFrame,state:{generation:7,projectionEpoch:7,
        frameSerial:4,deviceEpoch:1,sceneRevision:1,casterRevision:1,reason:"page-quantum",reasonMask:128,
        fullInvalidate:false,temporalInvalidate:false,pageQuantumChanged:true,resized:false}});
      command.encodeGraph(graph);command.finish();await command.gpuDone;
      const rolled = new Uint32Array(await inspect(resources.pageTable));
      for(let page=0;page<profile.virtualEntryCount;page++) {
        const p=page*12;if((actualTable[p+3]&9)!==9)continue;
        const wx=actualTable[p+8]|0,wy=actualTable[p+9]|0;
        const minimum=page%perClip<4096?-31:-1, maximum=page%perClip<4096?33:2;
        const remains=wx>=minimum&&wx<maximum&&wy>=minimum&&wy<maximum;
        check((rolled[p+3]!==0)===remains,`Roll identity ${page}`);
      }
    } finally { invalidation.destroy(); }

    // Negotiate the real bounded layout, not only a reduced high-profile budget.
    const boundedProfile = negotiateVsmCapabilities({
      limits: { ...profile.limits, maxTextureDimension2D: 2048 },
    }, {clipLevels:16});
    check(boundedProfile.profile === "vsm-directional-bounded", "Bounded negotiation fixture failed");
    const bounded = VsmResources.create(device, boundedProfile);
    try {
      const capacity = boundedProfile.residentSlots - boundedProfile.coarseReservedSlots;
      const bits = new Uint32Array(boundedProfile.requestedPagesBytes / 4);
      const weights = new Uint32Array(boundedProfile.virtualEntryCount);
      const set = (page) => {
        bits[page >>> 5] |= 1 << (page & 31);
      };
      for (let page = 0; page < capacity + 257; page++) {
        set(page);
        weights[page] = page + 1;
      }
      const coarsePages = [];
      for (let level = 0; level < boundedProfile.clipLevels; level++) {
        for (let y = -1; y <= 1; y++)
          for (let x = -1; x <= 1; x++) {
            const page = (level + 1) * perClip - 16 + ((y + 4) % 4) * 4 + ((x + 4) % 4);
            set(page);
            coarsePages.push(page);
          }
      }
      device.queue.writeBuffer(bounded.requestedPages, 0, bits);
      device.queue.writeBuffer(bounded.getBuffer("receiverPriority"), 0, weights);
      const rolledFrame = { ...frame, namespace: bounded.namespace,
        clipOriginExtent: frame.clipOriginExtent.map(([x, y, e, t]) => [x + e/64, y + e/64, e, t]) };
      await encode(1, false, bounded, rolledFrame);
      const chosen = Array.from({ length: capacity + 257 }, (_, i) => i)
        .sort((a, b) => Math.floor(Math.log2(weights[b])) - Math.floor(Math.log2(weights[a])) || a - b)
        .slice(0, capacity);
      const table = new Uint32Array(await inspect(bounded.pageTable));
      for (const page of [...chosen, ...coarsePages]) {
        check((table[page * 12 + 3] & 9) === 9, `Bounded layout failed page ${page}`);
      }
      const statistics = new Uint32Array(await inspect(bounded.getBuffer("admissionStatistics")));
      check(statistics[34] === capacity + 257 && statistics[35] === capacity, "Bounded pressure was hidden");
    } finally {
      bounded.destroy();
    }

    // Exercise both capacity profiles and empty/under/full-pressure histogram
    // cutoffs independently, including two levels with overlapping receivers.
    const admissionPipelines = {};
    for (const entry of ["histogram", "cutoff", "admit"])
      admissionPipelines[entry] = await compile(VSM_ADMISSION_WGSL, entry);
    for (const capacity of [125, 750])
      for (const count of [0, 7, capacity, capacity + 257]) {
        const constants = packVsmResidencyConstants({ resources, frame, generation: 7, frameSerial: 1 });
        new Uint32Array(constants)[2] = profile.coarseReservedSlots + capacity;
        const bits = new Uint32Array(raw.length),
          weights = new Uint32Array(scores.length);
        const pages = Array.from({ length: count }, (_, i) => (i % 2 ? perClip + i : i));
        for (let i = 0; i < pages.length; i++) {
          const page = pages[i];
          bits[page >>> 5] |= 1 << (page & 31);
          weights[page] = i % 13 === 0 ? 0x80000000 : ((i * 73) % 4096) + 1;
        }
        bits[coarse >>> 5] |= 1 << (coarse & 31);
        const uniform = make(constants.byteLength, GPUBufferUsage.UNIFORM, constants);
        const inputBits = make(bits.byteLength, storage, bits),
          inputScores = make(weights.byteLength, storage, weights);
        const output = make(bits.byteLength, storage),
          statsBuffer = make(144, storage);
        const bindings = [uniform, inputBits, inputScores, output, statsBuffer];
        const encoder = device.createCommandEncoder();
        const pass = encoder.beginComputePass();
        for (const entry of ["histogram", "cutoff", "admit"]) {
          const pipeline = admissionPipelines[entry];
          const indices =
            entry === "cutoff" ? [0, 4] : entry === "histogram" ? [0, 1, 2, 4] : [0, 1, 2, 3, 4];
          pass.setPipeline(pipeline);
          pass.setBindGroup(
            0,
            device.createBindGroup({
              layout: pipeline.getBindGroupLayout(0),
              entries: indices.map((binding) => ({ binding, resource: { buffer: bindings[binding] } })),
            }),
          );
          pass.dispatchWorkgroups(entry === "histogram" ? Math.ceil(bits.length / 64) : 1);
        }
        pass.end();
        device.queue.submit([encoder.finish()]);
        const actual = selectedPages(new Uint32Array(await inspect(output)));
        const wanted = pages
          .sort((a, b) => Math.floor(Math.log2(weights[b])) - Math.floor(Math.log2(weights[a])) || a - b)
          .slice(0, capacity)
          .concat(coarse)
          .sort((a, b) => a - b);
        check(JSON.stringify(actual) === JSON.stringify(wanted), `Admission ${capacity}/${count} differs`);
      }

    // Real receiver producer, not a reimplementation of its predicate. The
    // independent CPU set includes small positive reverse depth and max footprint.
    const receiver = new VsmReceiverDemandPass(device);
    try {
      await receiver.preparePipelines();
      const camera = new Float32Array(156);
      camera.set([20,0,0,0, 0,4,0,0, 0,0,1,0, 60,0,0,1], 112);
      const instance = new Uint32Array(44);
      instance[2] = 7 | (4 << 8);
      const work = new Uint32Array(14);
      work.set([1,1,1,1,0,7,0,0]);
      const cameraBuffer = make(624, GPUBufferUsage.UNIFORM, camera);
      const instanceBuffer = make(176, storage, instance);
      const workBuffer = make(work.byteLength, storage, work);
      const depthRange = make(16, storage, new Float32Array([0,1,1,1]));
      const depth = device.createTexture({ size:[8,8], format:"depth32float",
        usage:GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING });
      const keys = device.createTexture({ size:[8,8], format:"r32uint",
        usage:GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST });
      retained.push(depth, keys);
      device.queue.writeTexture({texture:keys}, new Uint32Array(64), {bytesPerRow:32}, [8,8]);
      const receiverFrame = { ...frame, settings: { ...VSM_DEFAULT_SETTINGS, filterMode:"point" },
        clipOriginExtent: frame.clipOriginExtent.map((_, l) => {
          const extent = 64 * 2 ** l; return [-extent/2,-extent/2,extent,extent/4096];
        }) };
      const mod = (n, a) => ((n % a) + a) % a;
      for (const [depthValue, radius] of [[0.00005,0],[0.00005,64],[0,0]]) {
        const clear = device.createCommandEncoder();
        clear.beginRenderPass({ colorAttachments:[], depthStencilAttachment:{ view:depth.createView(),
          depthClearValue:depthValue,depthLoadOp:"clear",depthStoreOp:"store" } }).end();
        device.queue.submit([clear.finish()]);
        const graph = new FrameGraph("quality/receiver");
        const command = ShadeGPUCommandContext.create(graphics,"Renderer/visibility-frame");
        const imported = (name,b) => graph.import_resource(name,{kind:"imported"},b);
        receiver.addToGraph(graph,{width:8,height:8,camera:imported("camera",cameraBuffer),
          instances:imported("instances",instanceBuffer),meshletWork:imported("work",workBuffer),
          depthRange:imported("z",depthRange),depth:imported("depth",depth),visibilityKey:imported("keys",keys),
          resources,frame:receiverFrame,generation:7,boundedFilterFootprintRadiusTexels:radius});
        command.encodeGraph(graph); command.finish(); await command.gpuDone;
        const bits = new Uint32Array(await inspect(resources.requestedPages));
        const weights = new Uint32Array(await inspect(resources.getBuffer("receiverPriority")));
        const expectedBits = new Uint32Array(bits.length), expectedScores = new Uint32Array(weights.length);
        const set = (page,score) => { expectedBits[page>>>5] |= 1<<(page&31); expectedScores[page] += score; };
        for(let l=0;l<16;l++) for(let y=-1;y<=0;y++) for(let x=-1;x<=0;x++)
          set(l*perClip+4096+mod(y,4)*4+mod(x,4),0);
        if(depthValue>0) for(let y=0;y<8;y++) for(let x=0;x<8;x++) {
          const wx=60+20*((x+.5)/8*2-1), wy=4*(1-(y+.5)/8*2);
          const selected=Math.max(1,Math.min(15,Math.ceil(Math.log2(Math.hypot(wx,wy,Math.fround(depthValue))/31))));
          for(let endpoint=0;endpoint<2;endpoint++) {
            const l=selected+endpoint, step=2**l, r=radius>4?radius/64*step:0;
            for(let py=Math.floor((wy-r)/step);py<=Math.floor((wy+r)/step);py++)
              for(let px=Math.floor((wx-r)/step);px<=Math.floor((wx+r)/step);px++)
                if(px>=-32&&px<32&&py>=-32&&py<32)
                  set(l*perClip+mod(py,64)*64+mod(px,64), endpoint===0?2:1);
          }
        }
        check(bits.every((v,i)=>v===expectedBits[i]),`Receiver exact set depth=${depthValue} radius=${radius}`);
        check(weights.every((v,i)=>v===expectedScores[i]),`Receiver exact scores radius=${radius}`);
      }
    } finally { receiver.destroy(); }

    // Independent expected status for every descriptor, including poisoned
    // outside ring addresses and each identity/ready rejection reason.
    const publicationConstants = packVsmProjection(frame);
    new Uint32Array(publicationConstants).set([64,64,4,profile.atlasPagesPerAxis,16,7,0,0],VSM_DIMENSIONS_WORD);
    const publicationUniform = make(publicationConstants.byteLength,GPUBufferUsage.UNIFORM,publicationConstants);
    const publicationTable = new Uint32Array(profile.virtualEntryCount*12);
    const expectedStatus = new Uint32Array(profile.virtualEntryCount);
    for(let page=0;page<profile.virtualEntryCount;page++) {
      const l=Math.floor(page/perClip), local=page%perClip, coarse=local>=4096;
      const axis=coarse?4:64,cell=local-(coarse?4096:0);
      const minimum=coarse?-1:-32;
      const x=minimum+((cell%axis-minimum+axis)%axis),y=minimum+((Math.floor(cell/axis)-minimum+axis)%axis);
      const outside=coarse&&(x>0||y>0),code=page%8;
      const flags=code===0?0:code===2?11:code===3?13:9;
      publicationTable.set([0,0,code===4?1:coarse?5:0,flags,code===5?6:7,5,0,code===6?6:7,
        x>>>0,y>>>0,code===7?0:resources.namespace,0],page*12);
      expectedStatus[page]=outside?5:code===0?2:code>=4?3:code===2||code===3?4:coarse?1:0;
    }
    const pubTable=make(publicationTable.byteLength,storage,publicationTable);
    const pubDescriptors=make(profile.virtualEntryCount*16,storage,new Uint32Array(profile.virtualEntryCount*4).fill(0xffffffff));
    const pubPipeline=await compile(VSM_SAMPLING_PUBLICATION_WGSL);
    const pubEncoder=device.createCommandEncoder(),pubPass=pubEncoder.beginComputePass();
    pubPass.setPipeline(pubPipeline);pubPass.setBindGroup(0,device.createBindGroup({layout:pubPipeline.getBindGroupLayout(0),entries:[
      {binding:0,resource:{buffer:publicationUniform}},{binding:1,resource:{buffer:pubTable}},{binding:2,resource:{buffer:pubDescriptors}}]}));
    pubPass.dispatchWorkgroups(Math.ceil(profile.virtualEntryCount/64));pubPass.end();device.queue.submit([pubEncoder.finish()]);
    const published=new Uint32Array(await inspect(pubDescriptors));
    check(expectedStatus.every((v,i)=>published[i*4+2]===v&&published[i*4+3]===0),"Publication identity or full write domain");

    const constants = new Float32Array(VSM_PROJECTION_CONSTANT_BYTES / 4),
      u = new Uint32Array(constants.buffer);
    constants.set(identity);
    for (let level = 0; level < 3; level++) {
      const e = 64 * 2 ** level;
      constants.set([-e/2, -e/2, e, e/4096], 16 + level * 4);
    }
    u.set([64, 64, 4, 2, 3, 7, 0, 0], VSM_DIMENSIONS_WORD);
    constants.set([0, 0, 0.16, 0], VSM_PARAMETERS_WORD);
    constants.set([0, 1, 1, 1], VSM_DEPTH_RANGE_BYTE_OFFSET / 4);
    constants.set([0, 0, 0, 1], VSM_SELECTOR_WORD);
    const uniform = make(constants.byteLength, GPUBufferUsage.UNIFORM, constants);
    const descriptorWords = new Uint32Array(perClip * 3 * 4);
    for (let level = 0; level < 3; level++)
      for (let page = 0; page < perClip; page++) {
        const fine = page < 4096;
        descriptorWords.set([fine && level === 2 ? 1 : 0, 0, fine ? 0 : 1, 0], (level * perClip + page) * 4);
      }
    const descriptors = make(descriptorWords.byteLength, storage, descriptorWords);
    const points = [-62.001, -61.999, -61.5, -60, -50, 0, 50, 60, 61.5, 61.999, 62.001];
    const positions = make(points.length * 4, storage, new Float32Array(points));
    const output = make(points.length * 16, storage);
    const atlas = device.createTexture({
      size: [144, 72],
      format: "depth32float",
      usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
    });
    retained.push(atlas);
    const depthModule = device.createShaderModule({
      code: `
@vertex fn vs(@builtin(vertex_index) i:u32) -> @builtin(position) vec4f {
  let p = array<vec2f,3>(vec2f(-1,-1),vec2f(3,-1),vec2f(-1,3)); return vec4f(p[i],0,1);
}
@fragment fn fs(@builtin(position) p:vec4f) -> @builtin(frag_depth) f32 { return select(0.0,0.75,p.x<72.0); }`,
    });
    const raster = await device.createRenderPipelineAsync({
      layout: "auto",
      vertex: { module: depthModule, entryPoint: "vs" },
      fragment: { module: depthModule, entryPoint: "fs", targets: [] },
      depthStencil: { format: "depth32float", depthWriteEnabled: true, depthCompare: "always" },
    });
    const sample = await compile(`
struct GpuPrimitiveTypeTable { direction:vec3f, color:vec3f, }
${VSM_SAMPLING_WGSL}
@group(0) @binding(0) var<uniform> vsm_constants: VsmSamplingConstants;
@group(0) @binding(1) var<storage,read> vsm_sampling_descriptors: array<VsmSamplingDescriptor>;
@group(0) @binding(2) var vsm_atlas_depth: texture_depth_2d;
@group(0) @binding(3) var vsm_atlas_sampler: sampler;
@group(0) @binding(4) var<storage,read> positions: array<f32>;
@group(0) @binding(5) var<storage,read_write> output: array<vec4f>;
@compute @workgroup_size(64) fn main(@builtin(global_invocation_id) id:vec3u) {
  if(id.x>=arrayLength(&positions)){return;}
  let x=positions[id.x]; let q=vsm_query_directional(vec2f(x,0),length(vec3f(x,0,.5)));
  let incident=GpuPrimitiveTypeTable(vec3f(0,0,1),vec3f(1));
  output[id.x]=vec4f(vsm_sample_directional(vec3f(x,0,.5),vec3f(0,0,1),incident,vec2f(1,0)), f32(q.level),f32(q.entry.mip),f32(q.status));
}`);
    const group = device.createBindGroup({
      layout: sample.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: uniform } },
        { binding: 1, resource: { buffer: descriptors } },
        { binding: 2, resource: atlas.createView() },
        { binding: 3, resource: device.createSampler() },
        { binding: 4, resource: { buffer: positions } },
        { binding: 5, resource: { buffer: output } },
      ],
    });
    const runSample = async () => {
      const encoder = device.createCommandEncoder();
      const pass = encoder.beginComputePass();
      pass.setPipeline(sample);
      pass.setBindGroup(0, group);
      pass.dispatchWorkgroups(1);
      pass.end();
      device.queue.submit([encoder.finish()]);
      return new Float32Array(await inspect(output));
    };
    const encoder = device.createCommandEncoder();
    const pass = encoder.beginRenderPass({
      colorAttachments: [],
      depthStencilAttachment: {
        view: atlas.createView(),
        depthClearValue: 0,
        depthLoadOp: "clear",
        depthStoreOp: "store",
      },
    });
    pass.setPipeline(raster);
    pass.draw(3);
    pass.end();
    device.queue.submit([encoder.finish()]);
    const transition = await runSample();
    for (let i = 0; i < points.length; i++) {
      const distance = Math.hypot(Math.fround(points[i]), 0.5);
      const t = Math.min(1, Math.max(0, (distance - 62 * (1 - Math.fround(0.16))) / (62 * Math.fround(0.16))));
      const expectedVisibility = t * t * (3 - 2 * t);
      check(
        Math.abs(transition[i * 4] - expectedVisibility) < 2e-6,
        `Fine transition at ${points[i]}: ${transition[i * 4]} != ${expectedVisibility}`,
      );
      check(transition[i * 4 + 2] === 0, "Transition used emergency coarse mip");
    }
    for (let i = 0; i < 4096; i++) descriptorWords[(perClip + i) * 4 + 2] = 2;
    device.queue.writeBuffer(descriptors, 0, descriptorWords);
    const fallback = await runSample();
    for (let i = 0; i < points.length; i++)
      check(
        fallback[i * 4] === 1 && fallback[i * 4 + 1] === 2 && fallback[i * 4 + 2] === 0,
        "Missing fine skipped ready adjacent fine",
      );
    for (let i = 0; i < 4096; i++) descriptorWords[(perClip * 2 + i) * 4 + 2] = 4;
    device.queue.writeBuffer(descriptors, 0, descriptorWords);
    const emergency = await runSample();
    for (let i = 0; i < points.length; i++)
      check(emergency[i * 4] === 0 && emergency[i * 4 + 2] === 5, "No-fine case lost coarse safety coverage");
    return {
      productionFrameGraph: true,
      productionReceiverDepthFootprintEmpty: true,
      directConsumerShaderCompile: true,
      rollRetainedAndDepartedIdentity: true,
      completeDescriptorPublication: true,
      completePageCommitAndRetry: true,
      abortRetry: true,
      rawDemandPreserved: true,
      stableAdmission: true,
      fineCapacity,
      boundedProductionProfile: true,
      pressureFineRequests: fineCapacity + 300,
      admissionCases: 8,
      transitionSamples: points.length,
      adjacentFineBeforeCoarse: true,
      emergencyCoarse: true,
    };
  } finally {
    allocate.destroy();
    resources.destroy();
    retained.forEach((r) => r.destroy());
    graphics.destroy();
  }
}
