import type { ResourceAccounting, ResourceHandle } from "../debug/profiling/ResourceAccounting.js";
import type { ShadeGPUCommandContext } from "../framegraph/ShadeGPUCommandContext.js";
import { planSurfaceFieldStoreCapacity, SURFACE_FIELD_STORE_ENTRY_BYTES, SURFACE_FIELD_STORE_WAYS, SURFACE_FIELD_STORE_WGSL, type SurfaceFieldStoreCapacity } from "./GpuSurfaceFieldStoreAbi.js";
import { SURFACE_FIELD_DEPENDENCY_BUDGET_BYTES } from "./GpuSurfaceFieldIdentityAbi.js";

export interface SurfaceFieldStoreStats { readonly capacity:SurfaceFieldStoreCapacity; readonly allocatedBytes:number; readonly lookupRequests:number; readonly hits:number; readonly misses:number; readonly admissions:number; readonly overflows:number; }
/** Long-lived owner for canonical field cells. Request/evaluate/publish are
 * encoded by the caller's one frame command; no readback and no CPU-visible
 * current-frame admission. The owner only manages storage/generation/fences. */
export class GpuSurfaceFieldStore {
 readonly capacity:SurfaceFieldStoreCapacity;
 readonly buffers:readonly GPUBuffer[];
 readonly dependencyBuffer:GPUBuffer;
 get buffer():GPUBuffer{return this.buffers[0]!;}
 private readonly handle?:ResourceHandle;
 private destroyed=false;
 private generation=1;
 private publicationGeneration=0;
 private submittedEpoch=0;
 private readonly inFlight=new Set<string>();
 private counters={lookupRequests:0,hits:0,misses:0,admissions:0,overflows:0};
 constructor(private readonly device:GPUDevice,budgetBytes=128*1024*1024,private readonly accounting?:ResourceAccounting){
  const dependencyBytes=SURFACE_FIELD_DEPENDENCY_BUDGET_BYTES;
  if(dependencyBytes>Math.min(Number(device.limits.maxBufferSize),Number(device.limits.maxStorageBufferBindingSize))){
   throw new RangeError("FieldStore dependency witness profile exceeds the negotiated binding");
  }
  this.capacity=planSurfaceFieldStoreCapacity(device.limits,budgetBytes-dependencyBytes);
  if(this.capacity.segmentBytes.length!==1){
   throw new RangeError("Surface FieldStore requires one storage-buffer segment on the production profile");
  }
  if(this.capacity.entries>=0x80000000) { throw new RangeError("FieldStore slot namespace exceeds the tagged reference proof"); }
  this.buffers=Object.freeze(this.capacity.segmentBytes.map((size,index)=>device.createBuffer({label:`Surface/FieldStore segment ${index}`,size,usage:GPUBufferUsage.STORAGE|GPUBufferUsage.COPY_DST|GPUBufferUsage.COPY_SRC})));
  this.dependencyBuffer=device.createBuffer({label:"Surface/field dependency witnesses",size:dependencyBytes,usage:GPUBufferUsage.STORAGE|GPUBufferUsage.COPY_DST|GPUBufferUsage.COPY_SRC});
  this.handle=accounting?.created({kind:"buffer",category:"resident",owner:"Surface/FieldStore",bytes:this.capacity.bytes+dependencyBytes,label:"Surface/FieldStore and dependency witnesses"});
 }
 private namespace = 1;
 private namespaceRestartPending = false;
 private dependencyReservations = 0;

 get nextSubmissionEpoch(): number {
  return this.namespaceRestartPending || this.submittedEpoch >= 0xfffffffe ? 1 : this.submittedEpoch + 1;
 }

 needsNamespaceRestart(dependencies = 0): boolean {
  return this.namespaceRestartPending || this.submittedEpoch >= 0xfffffffe ||
    this.dependencyReservations + dependencies >= 0xfffffff0;
 }

 requestNamespaceRestart(): void {
  if (this.namespace >= Number.MAX_SAFE_INTEGER) {
   throw new RangeError("Surface cache namespace exhausted; recreate the GPU owner");
  }
  this.namespaceRestartPending = true;
 }

 /** Queue order places this rare clear after every older frame consumer and
  * before the new namespace's first lookup. Runtime restarts Field and Signal
  * together. Abort retains the request and advances no CPU identity. */
 encodeNamespaceRestart(command: ShadeGPUCommandContext): void {
  if (!this.namespaceRestartPending) { return; }
  if (this.destroyed || command.device !== this.device || command.closed) {
   throw new Error("Surface namespace restart requires an open same-device command");
  }
  for (const buffer of this.buffers) { command.gpu_encoder.clearBuffer(buffer); }
  command.gpu_encoder.clearBuffer(this.dependencyBuffer);
  const namespace = this.namespace;
  command.onFinished.addOne(() => {
   if (this.namespace !== namespace) { return; }
   this.namespace++;
   this.submittedEpoch = 0;
   this.generation = 1;
   this.dependencyReservations = 0;
   this.namespaceRestartPending = false;
  });
 }

 reserveDependencyNamespace(command: ShadeGPUCommandContext, fields: number): void {
  // At most one dependency version is allocated per submitted descriptor.
  // This CPU upper bound avoids reading the current GPU allocator counter.
  command.onFinished.addOne(() => { this.dependencyReservations += fields; });
 }

 nextGeneration(): number {
  if (this.generation >= 0xfffffffe) {
   this.requestNamespaceRestart();
   return this.generation;
  }
  return ++this.generation;
 }
 /** Advances the GPU cache generation at a publication boundary. A scene
  * revision is a witness, never a CPU frame number. */
 preparePublication(publicationGeneration:number):void{
  if (!Number.isSafeInteger(publicationGeneration) || publicationGeneration < 0 || publicationGeneration > 0xffffffff) {
   throw new RangeError("FieldStore publication generation must be uint32");
  }
  if (publicationGeneration !== this.publicationGeneration) {
   this.publicationGeneration = publicationGeneration;
   this.nextGeneration();
  }
 }
 trackSubmission(gpuDone:Promise<void>,publicationGeneration:number):number{
  if (this.destroyed) throw new Error("FieldStore submission after destroy");
  this.preparePublication(publicationGeneration);
  if (this.needsNamespaceRestart()) {
   throw new Error("Surface cache namespace restart was not committed before submission tracking");
  }
  const epoch = ++this.submittedEpoch;
  const submission = `${this.namespace}:${epoch}`;
  this.inFlight.add(submission);
  const retire = (): void => { this.inFlight.delete(submission); };
  void gpuDone.then(retire, retire);
  return epoch;
 }
 /** Write only initialization/control words. Field values are published by the
  * GPU evaluate stage after its miss owner is compacted. */
 reset(command:ShadeGPUCommandContext):void{
  if(this.destroyed||command.device!==this.device||command.closed)throw new Error("FieldStore reset requires an open same-device command");
  let offset=0;for(const buffer of this.buffers){const size=buffer.size;command.writeBuffer(buffer,0,new Uint32Array(size/4).buffer,0,size);offset+=size;}
 }
 recordLookup(requests:number,hits:number,misses:number,admissions=0,overflows=0):void{this.counters.lookupRequests+=requests;this.counters.hits+=hits;this.counters.misses+=misses;this.counters.admissions+=admissions;this.counters.overflows+=overflows;}
 stats():SurfaceFieldStoreStats & { readonly generation:number; readonly publicationGeneration:number; readonly submittedEpoch:number; readonly inFlightSubmissions:number } {return Object.freeze({capacity:this.capacity,allocatedBytes:this.capacity.bytes+this.dependencyBuffer.size,generation:this.generation,publicationGeneration:this.publicationGeneration,submittedEpoch:this.submittedEpoch,namespace:this.namespace,dependencyReservations:this.dependencyReservations,inFlightSubmissions:this.inFlight.size,...this.counters});}
 destroy():void{if(this.destroyed)return;this.destroyed=true;for(const buffer of this.buffers)buffer.destroy();this.dependencyBuffer.destroy();if(this.handle)this.accounting!.destroyed(this.handle);}
}

export const SURFACE_FIELD_STORE_LIBRARY_WGSL=SURFACE_FIELD_STORE_WGSL;
