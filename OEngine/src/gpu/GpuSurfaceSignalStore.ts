import type { ResourceAccounting,ResourceHandle } from "../debug/profiling/ResourceAccounting.js";
import type { ShadeGPUCommandContext } from "../framegraph/ShadeGPUCommandContext.js";
import { planSurfaceSignalStoreCapacity,encodeSurfaceSignalStoreKey,SURFACE_SIGNAL_STORE_WGSL,SURFACE_SIGNAL_STORE_COMPUTE_WGSL,type SurfaceSignalStoreKey } from "./GpuSurfaceSignalStoreAbi.js";
export class GpuSurfaceSignalStore {
 readonly capacity:ReturnType<typeof planSurfaceSignalStoreCapacity>;readonly buffers:readonly GPUBuffer[];private destroyed=false;private generation=1;private readonly handle?:ResourceHandle;
 private publicationGeneration=0;private submittedEpoch=0;private readonly inFlight=new Set<number>();
 constructor(private readonly device:GPUDevice,budgetBytes=64*1024*1024,private readonly accounting?:ResourceAccounting){this.capacity=planSurfaceSignalStoreCapacity(device.limits,budgetBytes);if(this.capacity.segmentBytes.length!==1){throw new RangeError("Surface SignalStore requires one storage-buffer segment on the production profile");}this.buffers=Object.freeze(this.capacity.segmentBytes.map((size,i)=>device.createBuffer({label:`Surface/SignalStore segment ${i}`,size,usage:GPUBufferUsage.STORAGE|GPUBufferUsage.COPY_DST|GPUBufferUsage.COPY_SRC})));this.handle=accounting?.created({kind:"buffer",category:"resident",owner:"Surface/SignalStore",bytes:this.capacity.bytes,label:"Surface/SignalStore"});}
 nextGeneration():number{if(this.generation>=0xffffffff)throw new RangeError("SignalStore generation exhausted");return ++this.generation;}
 preparePublication(publicationGeneration:number):void {
  if (!Number.isSafeInteger(publicationGeneration) || publicationGeneration < 0 || publicationGeneration > 0xffffffff) {
   throw new RangeError("SignalStore publication generation must be uint32");
  }
  if (publicationGeneration !== this.publicationGeneration) {
   this.publicationGeneration = publicationGeneration;
   this.nextGeneration();
  }
 }
 trackSubmission(gpuDone:Promise<void>,publicationGeneration:number):number {
  if (this.destroyed) throw new Error("SignalStore submission after destroy");
  this.preparePublication(publicationGeneration);
  const epoch = ++this.submittedEpoch;
  this.inFlight.add(epoch);
  const retire = (): void => { this.inFlight.delete(epoch); };
  void gpuDone.then(retire, retire);
  return epoch;
 }
 reset(command:ShadeGPUCommandContext):void{if(this.destroyed||command.device!==this.device||command.closed)throw new Error("SignalStore reset requires an open command");for(const b of this.buffers)command.writeBuffer(b,0,new Uint32Array(b.size/4).buffer,0,b.size);}
 encodeKey(key:SurfaceSignalStoreKey):Uint32Array<ArrayBuffer>{return encodeSurfaceSignalStoreKey(key);}
 destroy():void{if(this.destroyed)return;this.destroyed=true;for(const b of this.buffers)b.destroy();if(this.handle)this.accounting!.destroyed(this.handle);}
 stats(){return Object.freeze({allocatedBytes:this.capacity.bytes,entries:this.capacity.entries,sets:this.capacity.sets,generation:this.generation,publicationGeneration:this.publicationGeneration,submittedEpoch:this.submittedEpoch,inFlightSubmissions:this.inFlight.size});}
}
export const SURFACE_SIGNAL_STORE_LIBRARY_WGSL=SURFACE_SIGNAL_STORE_WGSL;
export const SURFACE_SIGNAL_STORE_GPU_WGSL=SURFACE_SIGNAL_STORE_COMPUTE_WGSL;
