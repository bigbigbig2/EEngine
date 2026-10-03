import type { ResourceAccounting,ResourceHandle } from "../debug/profiling/ResourceAccounting.js";
import type { ShadeGPUCommandContext } from "../framegraph/ShadeGPUCommandContext.js";
import { planSurfaceSignalStoreCapacity,SURFACE_SIGNAL_STORE_WGSL,SURFACE_SIGNAL_STORE_COMPUTE_WGSL,type SurfaceSignalStoreKey } from "./GpuSurfaceSignalStoreAbi.js";
export class GpuSurfaceSignalStore {
 readonly capacity:ReturnType<typeof planSurfaceSignalStoreCapacity>;readonly buffers:readonly GPUBuffer[];private destroyed=false;private generation=1;private readonly handle?:ResourceHandle;
 constructor(private readonly device:GPUDevice,budgetBytes=64*1024*1024,private readonly accounting?:ResourceAccounting){this.capacity=planSurfaceSignalStoreCapacity(device.limits,budgetBytes);this.buffers=Object.freeze(this.capacity.segmentBytes.map((size,i)=>device.createBuffer({label:`Surface/SignalStore segment ${i}`,size,usage:GPUBufferUsage.STORAGE|GPUBufferUsage.COPY_DST|GPUBufferUsage.COPY_SRC})));this.handle=accounting?.created({kind:"buffer",category:"resident",owner:"Surface/SignalStore",bytes:this.capacity.bytes,label:"Surface/SignalStore"});}
 nextGeneration():number{if(this.generation>=0xffffffff)throw new RangeError("SignalStore generation exhausted");return ++this.generation;}
 reset(command:ShadeGPUCommandContext):void{if(this.destroyed||command.device!==this.device||command.closed)throw new Error("SignalStore reset requires an open command");for(const b of this.buffers)command.writeBuffer(b,0,new Uint32Array(b.size/4).buffer,0,b.size);}
 encodeKey(key:SurfaceSignalStoreKey):Uint32Array<ArrayBuffer>{return Uint32Array.from(Object.values(key).map(v=>v>>>0));}
 destroy():void{if(this.destroyed)return;this.destroyed=true;for(const b of this.buffers)b.destroy();if(this.handle)this.accounting!.destroyed(this.handle);}
 stats(){return Object.freeze({allocatedBytes:this.capacity.bytes,entries:this.capacity.entries,sets:this.capacity.sets,generation:this.generation});}
}
export const SURFACE_SIGNAL_STORE_LIBRARY_WGSL=SURFACE_SIGNAL_STORE_WGSL;
export const SURFACE_SIGNAL_STORE_GPU_WGSL=SURFACE_SIGNAL_STORE_COMPUTE_WGSL;
