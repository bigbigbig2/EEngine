import type { ShadeGPUCommandContext } from "../framegraph/ShadeGPUCommandContext.js";
import type { ResourceAccounting, ResourceHandle } from "../debug/profiling/ResourceAccounting.js";
import type { TextureLocalVariation } from "../texture/TextureLocalVariation.js";

export const TEXTURE_LOCAL_VARIATION_BUDGET_BYTES = 32 * 1024 * 1024;
export const TEXTURE_LOCAL_VARIATION_DESCRIPTOR_WORDS = 8;
export const TEXTURE_LOCAL_VARIATION_STATIC_SLOTS = 4096;
export interface TextureStaticVariationPublication {readonly slot:number;readonly generation:number;readonly revision:number;}
export interface TextureVariationBuildInput {
  readonly slot: number;
  readonly generation: number;
  readonly revision: number;
  readonly texture: GPUTexture;
  readonly layer: number;
  readonly width: number;
  readonly height: number;
  readonly mipCount: number;
  readonly availableMip: number;
  readonly decodeSrgb: boolean;
}
interface Level { readonly width: number; readonly height: number; readonly span: number; readonly offset: number; }
interface Mip { readonly width: number; readonly height: number; readonly levels: readonly Level[]; }
interface Layout { readonly words: number; readonly blockSize: number; readonly mips: readonly Mip[]; readonly tables: Uint32Array; }
interface Entry { readonly start: number; readonly layout: Layout; readonly generation: number; readonly revision: number; }

const BUILD_WGSL = /* wgsl */ `
struct Settings {
 width:u32,height:u32,block:u32,layer:u32,
 mip:u32,source:u32,destination:u32,out_width:u32,
 out_height:u32,mode:u32,source_width:u32,source_height:u32,
 dispatch_width:u32,decode_srgb:u32,reserved0:u32,reserved1:u32,
}
@group(0) @binding(0) var<uniform> settings:Settings;
@group(0) @binding(1) var source_texture:texture_2d_array<f32>;
@group(0) @binding(2) var<storage,read_write> pool:array<u32>;
var<workgroup> minima:array<vec4f,64>;
var<workgroup> maxima:array<vec4f,64>;
fn decode_channel(x:f32)->f32 {return select(pow((x+0.055)/1.055,2.4),x/12.92,x<=0.04045);}
@compute @workgroup_size(64) fn build(@builtin(workgroup_id) group:vec3u,@builtin(local_invocation_index) lane:u32){
 let node=group.x+group.y*settings.dispatch_width;
 if node>=settings.out_width*settings.out_height{return;}
 let coordinate=vec2u(node%settings.out_width,node/settings.out_width);
 let maximum=3.402823466e38;
 var low=vec4f(maximum);var high=vec4f(-maximum);
 let size=select(2u,settings.block,settings.mode==0u);
 for(var i=lane;i<size*size;i+=64u){
  let pixel=coordinate*size+vec2u(i%size,i/size);
  if settings.mode==0u {
   if pixel.x<settings.width && pixel.y<settings.height {
    var value=textureLoad(source_texture,vec2i(pixel),i32(settings.layer),i32(settings.mip));
    if settings.decode_srgb!=0u{value=vec4f(decode_channel(value.x),decode_channel(value.y),decode_channel(value.z),value.w);}
    if all(value==value) && all(abs(value)<=vec4f(maximum)){low=min(low,value);high=max(high,value);}
    else{low=vec4f(-maximum);high=vec4f(maximum);}
   }
  }else if pixel.x<settings.source_width && pixel.y<settings.source_height {
   let at=settings.source+(pixel.y*settings.source_width+pixel.x)*8u;
   let child_low=vec4f(bitcast<f32>(pool[at]),bitcast<f32>(pool[at+1u]),bitcast<f32>(pool[at+2u]),bitcast<f32>(pool[at+3u]));
   let child_high=vec4f(bitcast<f32>(pool[at+4u]),bitcast<f32>(pool[at+5u]),bitcast<f32>(pool[at+6u]),bitcast<f32>(pool[at+7u]));
   low=min(low,child_low);high=max(high,child_high);
  }
 }
 minima[lane]=low;maxima[lane]=high;workgroupBarrier();
 for(var step=32u;step>0u;step>>=1u){
  if lane<step{minima[lane]=min(minima[lane],minima[lane+step]);maxima[lane]=max(maxima[lane],maxima[lane+step]);}
  workgroupBarrier();
 }
 if lane==0u {
  let at=settings.destination+node*8u;
  for(var c=0u;c<4u;c++){pool[at+c]=bitcast<u32>(minima[0][c]);pool[at+4u+c]=bitcast<u32>(maxima[0][c]);}
 }
}
`;

/** Fixed-size pool for metadata AND actual decoded mip bounds. Reduction reads
 * compressed textures through WebGPU textureLoad; no CPU decompressor approximation.
 * TextureResidency stages builds on its caller encoder and owns this resource. */
export class TextureVariationResidency {
  readonly buffer: GPUBuffer;
  readonly bytes: number;
  private readonly layout: GPUBindGroupLayout;
  private readonly pipeline: GPUComputePipeline;
  private readonly handle?: ResourceHandle;
  private readonly entries = new Map<number, Entry>();
  private readonly pending = new Set<number>();
  private readonly staticSlots:number[]=[];
  private staticGeneration=0;
  private readonly staticLeases=new Map<number,number>();
  private readonly free: { start: number; words: number }[] = [];
  private destroyed = false;
  private readonly counters = { builds: 0, nodes: 0, degraded: 0, rejected: 0, offlineBuilds: 0 };
  constructor(private readonly device: GPUDevice, readonly capacity: number, private readonly accounting?: ResourceAccounting, readonly staticCapacity=0) {
    if (!Number.isSafeInteger(capacity) || capacity < 1) throw new RangeError("Invalid variation descriptor capacity");
    this.bytes = Math.floor(Math.min(TEXTURE_LOCAL_VARIATION_BUDGET_BYTES,
      Number(device.limits.maxBufferSize), Number(device.limits.maxStorageBufferBindingSize)) / 256) * 256;
    if(!Number.isSafeInteger(staticCapacity)||staticCapacity<0)throw new RangeError("Invalid static variation descriptor capacity");
    const begin = Math.ceil((capacity + staticCapacity + 1) * TEXTURE_LOCAL_VARIATION_DESCRIPTOR_WORDS / 64) * 64;
    if (this.bytes / 4 - begin < 256) throw new RangeError("Variation pool cannot contain descriptor table and a valid mip tree");
    this.buffer = device.createBuffer({ label: "Surface/local texture variation pool", size: this.bytes,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC });
    this.handle = accounting?.created({ kind: "buffer", category: "resident", owner: "Surface/variation (TextureResidency)",
      bytes: this.bytes, label: "Surface/local texture variation pool" });
    this.free.push({ start: begin, words: this.bytes / 4 - begin });
    for(let slot=capacity+staticCapacity;slot>capacity;slot--)this.staticSlots.push(slot);
    try {
      this.layout = device.createBindGroupLayout({ entries: [
        { binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: "uniform" } },
        { binding: 1, visibility: GPUShaderStage.COMPUTE, texture: { sampleType: "unfilterable-float", viewDimension: "2d-array" } },
        { binding: 2, visibility: GPUShaderStage.COMPUTE, buffer: { type: "storage" } }
      ] });
      this.pipeline = device.createComputePipeline({ label: "Surface/local decoded texture bounds",
        layout: device.createPipelineLayout({ bindGroupLayouts: [this.layout] }),
        compute: { module: device.createShaderModule({ code: BUILD_WGSL }), entryPoint: "build" } });
    } catch (error) {
      this.buffer.destroy(); if (this.handle) this.accounting!.destroyed(this.handle); throw error;
    }
  }

  stage(command: ShadeGPUCommandContext, input: TextureVariationBuildInput, precomputed?: TextureLocalVariation): boolean {
    if (this.destroyed || command.closed || command.device !== this.device) throw new Error("Invalid variation publication command");
    if (![input.slot, input.generation, input.revision, input.width, input.height, input.mipCount].every(v => Number.isSafeInteger(v) && v > 0 && v <= 0xffffffff) ||
      input.slot > this.capacity+this.staticCapacity || (input.slot>this.capacity&&this.staticLeases.get(input.slot)!==input.generation) ||
      !Number.isInteger(input.availableMip) || input.availableMip < 0 || input.availableMip >= input.mipCount ||
      !Number.isInteger(input.layer) || input.layer < 0 || input.layer >= input.texture.depthOrArrayLayers ||
      input.width > input.texture.width || input.height > input.texture.height || input.mipCount > input.texture.mipLevelCount) {
      throw new RangeError("Invalid actual texture variation publication");
    }
    if (this.pending.has(input.slot)) throw new Error("Variation slot has two unsubmitted producers");
    const old = this.entries.get(input.slot);
    const offline = precomputed?.mips.length === input.mipCount && precomputed.mips[0]!.width === input.width &&
      precomputed.mips[0]!.height === input.height ? precomputed : undefined;
    if (old && old.generation !== input.generation) throw new Error("Variation slot recycled before retirement");
    let next = old;
    let newAllocation = false;
    if (!next) {
      // Bound per-workgroup source work even under pool pressure. Do not turn
      // a whole 8K texture into a single multi-million-texel workgroup.
      for (let block = offline?.blockSize ?? 4; block <= 64; block *= 2) {
        const layout = this.makeLayout(input, block);
        const region = this.free.find(range => range.words >= layout.words);
        if (!region) continue;
        next = { start: region.start, layout, generation: input.generation, revision: input.revision };
        region.start += layout.words; region.words -= layout.words;
        if (region.words === 0) this.free.splice(this.free.indexOf(region), 1);
        newAllocation = true;
        if (block !== 4) this.counters.degraded++;
        break;
      }
    }
    if (!next) {
      this.counters.rejected++;
      const invalid = new Uint32Array(8); invalid[4] = input.generation; invalid[5] = input.revision;
      command.writeBuffer(this.buffer, input.slot * 32, invalid.buffer, 0, 32);
      return false; // Local unknown causes field refinement, never missing shading.
    }
    if (next.layout.mips.length !== input.mipCount || next.layout.mips[0]!.width !== input.width ||
      next.layout.mips[0]!.height !== input.height) throw new Error("Variation texture shape changed without a new generation");
    const entry = next;
    const useOffline = offline !== undefined && offline.blockSize === entry.layout.blockSize;
    this.pending.add(input.slot);
    let settled = false;
    const rollback = (): void => {
      if (settled) return;
      settled = true; this.pending.delete(input.slot);
      if (newAllocation && !this.destroyed) this.releaseRange(entry.start, entry.layout.words);
    };
    command.onAborted.addOne(rollback);
    try {
      const settings = useOffline ? undefined : command.allocateTransientBuffer(GPUBufferUsage.UNIFORM, 64);
      const group = settings === undefined ? undefined : this.device.createBindGroup({ layout: this.layout, entries: [
        { binding: 0, resource: { buffer: settings } },
        { binding: 1, resource: input.texture.createView({ dimension: "2d-array", baseArrayLayer: input.layer, arrayLayerCount: 1 }) },
        { binding: 2, resource: { buffer: this.buffer } }
      ] });
      const tables = entry.layout.tables.slice();
      // Row offsets become absolute only when this immutable layout is admitted.
      for (let mip = 0; mip < entry.layout.mips.length; mip++) {
        const at = mip * 8; const levelTable = tables[at + 3]!;
        tables[at + 3] = entry.start + levelTable;
        tables[at + 4] = mip >= input.availableMip ? 1 : 0;
        for (let level = 0; level < entry.layout.mips[mip]!.levels.length; level++) {
          const row = levelTable + level * 4; tables[row + 3] = entry.start + tables[row + 3]!;
        }
      }
      command.writeBuffer(this.buffer, entry.start * 4, tables.buffer, 0, tables.byteLength);
      let built = 0;
      for (let mip = input.availableMip; mip < input.mipCount; mip++) {
        const info = entry.layout.mips[mip]!;
        for (let level = 0; level < info.levels.length; level++) {
          const destination = info.levels[level]!, source = level === 0 ? destination : info.levels[level - 1]!;
          const nodes = destination.width * destination.height;
          if (useOffline) {
            const values = offline!.mips[mip]!.levels[level]!;
            if (values.width !== destination.width || values.height !== destination.height || values.span !== destination.span) {
              throw new RangeError("Offline variation does not match actual resident mip layout");
            }
            const payload = Float32Array.from(values.bounds);
            command.writeBuffer(this.buffer, (entry.start + destination.offset) * 4, payload.buffer, 0, payload.byteLength);
            built += nodes; continue;
          }
          const dx = Math.min(nodes, this.device.limits.maxComputeWorkgroupsPerDimension), dy = Math.ceil(nodes / dx);
          if (dy > this.device.limits.maxComputeWorkgroupsPerDimension) throw new RangeError("Variation dispatch exceeds device limits");
          const values = new Uint32Array([info.width, info.height, entry.layout.blockSize, 0,
            mip, entry.start + source.offset, entry.start + destination.offset, destination.width,
            destination.height, level === 0 ? 0 : 1, source.width, source.height,
            dx, input.decodeSrgb ? 1 : 0, 0, 0]);
          command.writeBuffer(settings!, 0, values.buffer, 0, 64);
          const pass = command.beginComputePass({ label: `Surface/variation mip ${mip} level ${level}` });
          pass.setPipeline(this.pipeline); pass.setBindGroup(0, group!); pass.dispatchWorkgroups(dx, dy); pass.end(); built += nodes;
        }
      }
      // Publish descriptor after all data: generation/revision are checked by consumers.
      const descriptor = new Uint32Array([input.width, input.height, input.mipCount, entry.start,
        input.generation, input.revision, entry.layout.blockSize, input.availableMip]);
      command.writeBuffer(this.buffer, input.slot * 32, descriptor.buffer, 0, 32);
      command.onFinished.addOne(() => {
        if (settled) return;
        settled = true; this.pending.delete(input.slot);
        if (!this.destroyed) { this.entries.set(input.slot, { ...entry, revision: input.revision }); this.counters.builds++; this.counters.nodes += built;
          if (useOffline) this.counters.offlineBuilds++; }
      });
      return true;
    } catch (error) { rollback(); throw error; }
  }

  retire(slot: number, generation: number): void {
    if (this.destroyed) return;
    if (this.pending.has(slot)) throw new Error("Cannot retire an unsubmitted variation producer");
    const entry = this.entries.get(slot);
    if (entry&&entry.generation === generation){this.entries.delete(slot); this.releaseRange(entry.start, entry.layout.words);}
    if(slot>this.capacity&&this.staticLeases.get(slot)===generation){this.staticLeases.delete(slot);this.staticSlots.push(slot);}
  }
  /** Static owner stages decoded bounds on the caller encoder. Descriptor and
   * payload share the existing 32 MiB pool; admission failure is local unknown. */
  stageStatic(command:ShadeGPUCommandContext,input:Omit<TextureVariationBuildInput,"slot"|"generation"|"revision">):TextureStaticVariationPublication {
    if(this.destroyed||command.closed||command.device!==this.device)throw new Error("Invalid static variation publication command");
    const slot=this.staticSlots.pop();if(slot===undefined)return Object.freeze({slot:0,generation:0,revision:0});
    if(this.staticGeneration>=0xffffffff){this.staticSlots.push(slot);throw new RangeError("Static variation generation exhausted");}
    const generation=++this.staticGeneration;this.staticLeases.set(slot,generation);
    let settled=false;
    const release=()=>{if(settled)return;settled=true;this.staticLeases.delete(slot);this.staticSlots.push(slot);};
    command.onAborted.addOne(release);
    try {
      if(!this.stage(command,{...input,slot,generation,revision:1})){release();return Object.freeze({slot:0,generation:0,revision:0});}
      command.onFinished.addOne(()=>{settled=true;});
      return Object.freeze({slot,generation,revision:1});
    }catch(error){release();throw error;}
  }
  stats(): Readonly<{ bytes: number; residentTextures: number; freeBytes: number; builds: number; nodes: number; degraded: number; rejected: number; offlineBuilds: number }> {
    return Object.freeze({ bytes: this.bytes, residentTextures: this.entries.size,
      freeBytes: this.free.reduce((sum, range) => sum + range.words * 4, 0), ...this.counters });
  }
  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true; this.buffer.destroy(); if (this.handle) this.accounting!.destroyed(this.handle);
    this.entries.clear(); this.pending.clear(); this.free.length = 0;this.staticSlots.length=0;this.staticLeases.clear();
  }
  private makeLayout(input: TextureVariationBuildInput, blockSize: number): Layout {
    const shapes: { width: number; height: number; levels: { width: number; height: number; span: number; offset: number }[] }[] = [];
    let words = input.mipCount * 8;
    for (let mip = 0; mip < input.mipCount; mip++) {
      const width = Math.max(1, Math.floor(input.width / 2 ** mip)), height = Math.max(1, Math.floor(input.height / 2 ** mip));
      let w = Math.ceil(width / blockSize), h = Math.ceil(height / blockSize), span = blockSize;
      const levels: { width: number; height: number; span: number; offset: number }[] = [];
      while (true) { levels.push({ width: w, height: h, span, offset: 0 }); words += 4;
        if (w === 1 && h === 1) break; w = Math.ceil(w / 2); h = Math.ceil(h / 2); span *= 2; }
      shapes.push({ width, height, levels });
    }
    const tables = new Uint32Array(words); let table = input.mipCount * 8;
    for (let mip = 0; mip < shapes.length; mip++) {
      const info = shapes[mip]!; tables.set([info.width, info.height, info.levels.length, table, 0, 0, 0, 0], mip * 8);
      for (const level of info.levels) {
        level.offset = words; words += level.width * level.height * 8;
        tables.set([level.width, level.height, level.span, level.offset], table); table += 4;
      }
    }
    return { words: Math.ceil(words / 64) * 64, blockSize, mips: shapes, tables };
  }
  private releaseRange(start: number, words: number): void {
    this.free.push({ start, words }); this.free.sort((a, b) => a.start - b.start);
    for (let i = 1; i < this.free.length;) {
      const previous = this.free[i - 1]!, next = this.free[i]!;
      if (previous.start + previous.words === next.start) { previous.words += next.words; this.free.splice(i, 1); }
      else i++;
    }
  }
}
