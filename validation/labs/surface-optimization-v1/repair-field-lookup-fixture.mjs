import { surfaceCellWorkspaceLayout, surfaceCellWorkspaceWgsl } from '../../../OEngine/.test-dist/gpu/GpuSurfaceCellPlanAbi.js';
import { SURFACE_CELL_ADDRESS_WORDS } from '../../../OEngine/.test-dist/gpu/GpuSurfaceReferenceAbi.js';
import { SURFACE_FIELD_LOOKUP_WGSL } from '../../../OEngine/.test-dist/shaders/surface_field_lookup.js';
import { SURFACE_FIELD_DEPENDENCY_EPOCH_WGSL } from '../../../OEngine/.test-dist/shaders/surface_field_dependency_epoch.js';
import { SURFACE_FIELD_DEPENDENCY_HEADER_WORDS, SURFACE_FIELD_DEPENDENCY_ENTRY_WORDS } from '../../../OEngine/.test-dist/gpu/GpuSurfaceFieldIdentityAbi.js';
import { SURFACE_FIELD_STORE_COMPUTE_WGSL, SURFACE_FIELD_STORE_ENTRY_WORDS, SURFACE_FIELD_STORE_KEY_WORDS,
  SURFACE_FIELD_STORE_VALUE_WORD, SURFACE_FIELD_STORE_BOUNDS_WORD, SURFACE_FIELD_STORE_DOMAIN_WORD,
  SURFACE_FIELD_STORE_GRADIENT_WORD, SURFACE_FIELD_STORE_FLAGS_WORD, SURFACE_FIELD_STORE_STATE_WORD,
  SURFACE_FIELD_STORE_GENERATION_WORD, encodeSurfaceFieldStoreKey } from '../../../OEngine/.test-dist/gpu/GpuSurfaceFieldStoreAbi.js';

/** Independent fixtures publish known numeric values/intervals, then run the
 * actual production lookup. The simulated heavy worker is driven exclusively
 * by production unresolved masks; its invocation count proves bypass directly. */
export async function runFieldLookupRepair(gpu, assert, onStage = () => {}) {
  const report = { evidenceRole: 'diagnostic', passed: false, cases: [], apiErrors: [] };
  const adapter = await gpu.requestAdapter({ powerPreference: 'high-performance' });
  assert.ok(adapter && !adapter.info.isFallbackAdapter);
  const device = await adapter.requestDevice();
  device.addEventListener('uncapturederror', e => report.apiErrors.push(e.error.message));
  const retained = [];
  const wordsOf = floats => new Uint32Array(new Float32Array(floats).buffer);
  const buffer = (data, usage = GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC) => {
    const b = device.createBuffer({ size: data.byteLength, usage });
    device.queue.writeBuffer(b, 0, data); retained.push(b); return b;
  };
  const read = async b => {
    const staging = device.createBuffer({ size: b.size, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
    const encoder = device.createCommandEncoder();encoder.copyBufferToBuffer(b, 0, staging, 0, b.size);device.queue.submit([encoder.finish()]);
    await staging.mapAsync(GPUMapMode.READ);const words = new Uint32Array(staging.getMappedRange()).slice();staging.unmap();staging.destroy();return words;
  };
  try {
    device.pushErrorScope('validation');
    const layout = surfaceCellWorkspaceLayout(1);
    const workspaceWords = new Uint32Array(layout.bytes / 4);
    const a = layout.addresses / 4;
    workspaceWords.set([3, 7, 11, 13, 17, 19, 23, 29, 1, 31, 37, 41, 43, 2, 0, 1], a);
    workspaceWords.set(wordsOf([.2, .3, .001, .002, .003, .004]), a + 16);
    workspaceWords.set(wordsOf([.19, .29, .21, .31]), a + 46);
    workspaceWords.set(wordsOf([.001, .002, .003, .004, .001, .002, .003, .004]), a + 58);
    workspaceWords[a + 93] = 7;
    workspaceWords.set([1, 0, 0, 0], layout.facts / 4);
    const workspace = buffer(workspaceWords);
    const metadataWords = new Uint32Array(15 * 8 + 64);
    const constants = 15 * 8;
    metadataWords[constants] = 0x7fff & ~((1 << 0) | (1 << 3) | (1 << 4));
    for (let field = 0; field < 15; field++) metadataWords.set([field + 1, 0xffffffff, 0, 0, 0, 0, 0, 0], field * 8);
    for (const field of [0, 3, 4]) metadataWords.set([101 + field, field, 0, 1 | (1 << 9), 0, 0, 1, 47], field * 8);
    const metadata = buffer(metadataWords);
    const versionsWords = new Uint32Array(15 * 4);
    for (const field of [0, 3, 4]) versionsWords[field * 4] = 53 + field;
    const versions = buffer(versionsWords);
    const entries = 16;
    const store = buffer(new Uint32Array(entries * SURFACE_FIELD_STORE_ENTRY_WORDS));
    const lookupSettings = buffer(new Uint32Array([0, constants, 1, entries, 1, 59, 1, 1]), GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST);
    const source = `${surfaceCellWorkspaceWgsl(1)}\n${SURFACE_FIELD_LOOKUP_WGSL}`;
    const module = device.createShaderModule({ code: source });
    assert.deepEqual((await module.getCompilationInfo()).messages.filter(m => m.type === 'error').map(m => m.message), []);
    onStage('Compiling actual field lookup');
    const lookup = await device.createComputePipelineAsync({ layout: 'auto', compute: { module, entryPoint: 'lookup_surface_fields' } });
    const lookupGroup = device.createBindGroup({ layout: lookup.getBindGroupLayout(0), entries: [
      { binding: 0, resource: { buffer: lookupSettings } }, { binding: 1, resource: { buffer: workspace } },
      { binding: 2, resource: { buffer: metadata } }, { binding: 3, resource: { buffer: versions } }, { binding: 4, resource: { buffer: store } }
    ] });
    const workerModule = device.createShaderModule({ code: `${surfaceCellWorkspaceWgsl(1)}
      @group(0) @binding(0) var<storage,read_write> w:SurfaceCellWorkspace;
      @compute @workgroup_size(1) fn unresolved_worker() {
        atomicAdd(&w.counters[117u],countOneBits(w.demands[0u]));
        atomicAdd(&w.counters[118u],countOneBits(w.demands[1u]));
      }` });
    const worker = await device.createComputePipelineAsync({ layout: 'auto', compute: { module: workerModule, entryPoint: 'unresolved_worker' } });
    const workerGroup = device.createBindGroup({ layout: worker.getBindGroupLayout(0), entries: [{ binding: 0, resource: { buffer: workspace } }] });
    const sample = async (name, valueMisses, certificateMisses, epoch = 1, view = 59) => {
      onStage(name);
      device.queue.writeBuffer(lookupSettings, 0, new Uint32Array([0, constants, 1, entries, epoch, view, 1, 1]));
      const encoder = device.createCommandEncoder();encoder.clearBuffer(workspace, 0, 128 * 4);
      for (const [pipeline, group] of [[lookup, lookupGroup], [worker, workerGroup]]) {
        const pass = encoder.beginComputePass();pass.setPipeline(pipeline);pass.setBindGroup(0, group);pass.dispatchWorkgroups(1);pass.end();
      }
      device.queue.submit([encoder.finish()]);
      const words = await read(workspace);
      assert.equal(words[117], valueMisses, `${name}: value worker`);
      assert.equal(words[118], certificateMisses, `${name}: expensive bound worker`);
      report.cases.push({ name, valuesEvaluated: words[117], boundsEvaluated: words[118], valueHits: words[113], certificateHits: words[114] });
      return words;
    };
    await sample('cold miss', 3, 3);
    const requestWords = new Uint32Array(3 * SURFACE_FIELD_STORE_ENTRY_WORDS);
    for (const [request, field] of [0, 3, 4].entries()) {
      const point = new Uint32Array(SURFACE_FIELD_STORE_KEY_WORDS - 20);
      point.set(workspaceWords.subarray(a + 16, a + 22));
      const exponent = maximum => ((wordsOf([maximum])[0] >>> 23) & 255) + 1;
      const key = encodeSurfaceFieldStoreKey({ producer: 101 + field, version: 53 + field, dependencyEpoch: 47,
        material: 17, instance: 3, instanceGeneration: 7, geometry: 11, geometryGeneration: 13,
        sourceMeshlet: 19, sourcePrimitive: 23, lod: 29, chart: 31, side: 1, scope: 1,
        cellX: 6, cellY: 9, gradientX: exponent(.003), gradientY: exponent(.004), geometryRevision: 43, viewRevision: 0,
        pointWitness: [...point] });
      const at = request * SURFACE_FIELD_STORE_ENTRY_WORDS;
      requestWords.set(key, at);
      requestWords.set(wordsOf([.5, .5, .5, 0]), at + SURFACE_FIELD_STORE_VALUE_WORD);
      requestWords.set(wordsOf([.495, .495, .495, 0, .505, .505, .505, 0]), at + SURFACE_FIELD_STORE_BOUNDS_WORD);
      requestWords.set(wordsOf([.18, .28, .22, .32]), at + SURFACE_FIELD_STORE_DOMAIN_WORD);
      requestWords.set(wordsOf([0, 0, 0, 0, .01, .01, .01, .01]), at + SURFACE_FIELD_STORE_GRADIENT_WORD);
      requestWords[at + SURFACE_FIELD_STORE_FLAGS_WORD] = 7;
    }
    const requests = buffer(requestWords);
    const publicationSettings = buffer(new Uint32Array([3, entries, 1, 1]), GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST);
    const owners = buffer(new Uint32Array(12));
    const counters = buffer(new Uint32Array(8));
    const publicationModule = device.createShaderModule({ code: SURFACE_FIELD_STORE_COMPUTE_WGSL });
    const publication = [];
    for (const entryPoint of ['surface_field_store_publish', 'surface_field_store_commit']) {
      const pipeline = await device.createComputePipelineAsync({ layout: 'auto', compute: { module: publicationModule, entryPoint } });
      const bindings = entryPoint.endsWith('commit') ? [0, 2, 3] : [0, 1, 2, 3, 4];
      const buffers = [publicationSettings, requests, store, owners, counters];
      const group = device.createBindGroup({ layout: pipeline.getBindGroupLayout(0), entries: bindings.map(binding => ({ binding, resource: { buffer: buffers[binding] } })) });
      publication.push([pipeline, group]);
    }
    const encoder = device.createCommandEncoder();
    { const [pipeline, group] = publication[0];const pass = encoder.beginComputePass();pass.setPipeline(pipeline);pass.setBindGroup(0, group);pass.dispatchWorkgroups(1);pass.end(); }
    device.queue.submit([encoder.finish()]);
    let storeWords = await read(store);
    const reserved = [...storeWords].filter((_, i) => i % SURFACE_FIELD_STORE_ENTRY_WORDS === SURFACE_FIELD_STORE_STATE_WORD && storeWords[i] === 1).length;
    assert.equal(reserved, 3);
    await sample('reserved payload rejected', 3, 3);
    const commitEncoder = device.createCommandEncoder();
    { const [pipeline, group] = publication[1];const pass = commitEncoder.beginComputePass();pass.setPipeline(pipeline);pass.setBindGroup(0, group);pass.dispatchWorkgroups(1);pass.end(); }
    device.queue.submit([commitEncoder.finish()]);
    await sample('warm value and certificate bypass', 0, 0);
    await sample('UV local camera movement survives', 0, 0, 2, 61);
    // Only one actual texture dependency changes; A/B remain published hits.
    device.queue.writeBuffer(metadata, (4 * 8 + 7) * 4, new Uint32Array([67]));
    await sample('partial texture change', 1, 1, 3);
    device.queue.writeBuffer(metadata, (4 * 8 + 7) * 4, new Uint32Array([47]));
    device.queue.writeBuffer(workspace, (a + 48) * 4, wordsOf([.25]));
    await sample('exact point value hit with certificate outside domain', 0, 3, 4);
    device.queue.writeBuffer(workspace, (a + 48) * 4, wordsOf([.21]));
    device.queue.writeBuffer(workspace, (a + 16) * 4, wordsOf([.201]));
    await sample('certified value covers another point', 0, 0, 5);
    device.queue.writeBuffer(workspace, (a + 8) * 4, new Uint32Array([0]));
    await sample('side identity rejects reuse', 3, 3, 6);
    onStage('Actual selective dependency epoch producer');
    const dependencyWords=new Uint32Array(3*8+3);
    dependencyWords.set([101,0,0,1,0,1,1,0],0);
    dependencyWords.set([103,0,0,1,1,1,1,0],8);
    dependencyWords.set([104,0,0,1,2,1,1,0],16);
    dependencyWords.set([1,1,2],24);
    const dependencyMetadata=buffer(dependencyWords);
    const dependencyVersions=buffer(new Uint32Array([0,7,9,11]));
    const dependencyCache=buffer(new Uint32Array(SURFACE_FIELD_DEPENDENCY_HEADER_WORDS+16*SURFACE_FIELD_DEPENDENCY_ENTRY_WORDS));
    const dependencyOwners=buffer(new Uint32Array(3));
    const dependencySettings=buffer(new Uint32Array([3,0,24,1,4,1,0,0]),GPUBufferUsage.UNIFORM|GPUBufferUsage.COPY_DST);
    const dependencyModule=device.createShaderModule({code:SURFACE_FIELD_DEPENDENCY_EPOCH_WGSL});
    assert.deepEqual((await dependencyModule.getCompilationInfo()).messages.filter(m=>m.type==='error').map(m=>m.message),[]);
    const dependencyPipelines=[];
    for(const [index,entryPoint] of ['lookup_field_dependency_versions','reserve_field_dependency_versions','commit_field_dependency_versions','resolve_field_dependency_versions'].entries()) {
      const pipeline=await device.createComputePipelineAsync({layout:'auto',compute:{module:dependencyModule,entryPoint}});
      const data=[dependencySettings,dependencyMetadata,dependencyVersions,dependencyCache,dependencyOwners];
      const bindings=index===2?[0,3,4]:index===3?[0,1,2,3]:[0,1,2,3,4];
      const group=device.createBindGroup({layout:pipeline.getBindGroupLayout(0),entries:bindings.map(binding=>({binding,resource:{buffer:data[binding]}}))});
      dependencyPipelines.push([pipeline,group]);
    }
    const dependencies=async(epoch,publish=true)=>{
      device.queue.writeBuffer(dependencySettings,0,new Uint32Array([3,0,24,epoch,4,1,0,0]));
      const encoder=device.createCommandEncoder();
      for(const [pipeline,group] of dependencyPipelines.slice(0,publish?4:1)) {
        const pass=encoder.beginComputePass();pass.setPipeline(pipeline);pass.setBindGroup(0,group);pass.dispatchWorkgroups(1);pass.end();
      }
      device.queue.submit([encoder.finish()]);
      const words=await read(dependencyMetadata);return [words[7],words[15],words[23]];
    };
    const coldDependencies=await dependencies(1);
    assert.ok(coldDependencies.every(version=>version!==0&&version!==0xffffffff));
    assert.deepEqual(await dependencies(2),coldDependencies,'same exact texture revisions preserve each version proof');
    device.queue.writeBuffer(dependencyVersions,3*4,new Uint32Array([13]));
    assert.deepEqual(await dependencies(3),coldDependencies,'unreferenced residency version is irrelevant');
    device.queue.writeBuffer(dependencyVersions,1*4,new Uint32Array([17]));
    const dirtyDependencies=await dependencies(4);
    assert.ok(dirtyDependencies[0]!==coldDependencies[0]&&dirtyDependencies[1]!==coldDependencies[1]);
    assert.equal(dirtyDependencies[2],coldDependencies[2]);
    const snapshot=await read(dependencyCache);
    const reservedBase=SURFACE_FIELD_DEPENDENCY_HEADER_WORDS;
    // A complete matching payload must still be rejected while RESERVED.
    const matchingEntry=Array.from({length:16},(_,entry)=>entry).find(entry=>snapshot[reservedBase+entry*SURFACE_FIELD_DEPENDENCY_ENTRY_WORDS+3]===dirtyDependencies[0]);
    assert.ok(matchingEntry!==undefined);
    device.queue.writeBuffer(dependencyCache,(reservedBase+matchingEntry*SURFACE_FIELD_DEPENDENCY_ENTRY_WORDS)*4,new Uint32Array([1]));
    const unpublished=await dependencies(5,false);
    assert.equal(unpublished[0],0xffffffff);
    assert.equal(unpublished[2],dirtyDependencies[2]);
    report.dependencyEpochs={cold:coldDependencies,dirty:dirtyDependencies,reservedRejected:unpublished};
    const error = await device.popErrorScope();report.validationError = error?.message ?? null;assert.equal(error, null, error?.message);
    assert.deepEqual(report.apiErrors, []);report.passed = true;
  } catch (error) { report.failure = error?.stack ?? String(error); }
  finally { for (const b of retained) b.destroy();device.destroy(); }
  return report;
}
