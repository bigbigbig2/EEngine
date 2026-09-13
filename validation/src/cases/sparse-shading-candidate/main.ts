import {
  captureGpuSparseShadingCapabilityRecord,
  createGpuSparseShadingCapabilityPlan,
  UnsupportedGpuPerformanceBaselineError
} from "../../../../OEngine/src/gpu/GpuSparseShadingCapability.js";
import { createValidationController } from "../../host/protocol.ts";
import { attachGpuErrorCollection, snapshotAdapterInfo, snapshotGpuFeatures, snapshotGpuLimits } from "../../host/webgpu.ts";
import { SparseShadingCandidateFixture } from "./fixture.ts";

const canvas=document.querySelector<HTMLCanvasElement>("#output"),status=document.querySelector<HTMLElement>("#status");
let device:GPUDevice|undefined,fixture:SparseShadingCandidateFixture|undefined;
let errors:ReturnType<typeof attachGpuErrorCollection>|undefined,intentionalLoss=false;

const controller=createValidationController({caseId:"sparse-shading-candidate",workloadId:"sparse-shading-candidate-correctness-v3"},async()=>{
  fixture?.destroy();errors?.remove();intentionalLoss=true;device?.destroy();
  const lost=errors===undefined?null:await Promise.race([errors.lost,new Promise<null>((resolve)=>setTimeout(()=>resolve(null),3000))]);
  return {...fixture?.resourceCounts(),devices:0,listeners:0,intentionalDeviceDestroy:intentionalLoss,
    deviceLost:lost===null?null:{reason:lost.reason,message:lost.message}};
});

try {
  controller.transition("negotiating");
  if(canvas===null||!window.isSecureContext||!navigator.gpu)controller.unsupported("WebGPU secure context or validation canvas is unavailable");
  else {
    const adapter=await navigator.gpu.requestAdapter({featureLevel:"core",powerPreference:"high-performance"});
    if(adapter===null)controller.unsupported("No WebGPU core adapter is available");
    else {
      const adapterLimits=snapshotGpuLimits(adapter.limits),adapterInfo=adapter.info as GPUAdapterInfo&{
        readonly subgroupMinSize?:number;readonly subgroupMaxSize?:number};let plan;
      try {plan=createGpuSparseShadingCapabilityPlan({features:adapter.features,limits:adapterLimits,
        info:{subgroupMinSize:adapterInfo.subgroupMinSize,subgroupMaxSize:adapterInfo.subgroupMaxSize}},
        {requiredLimits:{maxStorageBuffersPerShaderStage:12}});
      } catch(error) {if(error instanceof UnsupportedGpuPerformanceBaselineError){controller.unsupported(error.message);plan=undefined;}else throw error;}
      if(plan!==undefined){
        controller.addEvidence("adapter",{info:snapshotAdapterInfo(adapter.info),features:snapshotGpuFeatures(adapter.features),limits:adapterLimits});
        device=await adapter.requestDevice({requiredFeatures:plan.requiredFeatures,requiredLimits:plan.requiredLimits});
        errors=attachGpuErrorCollection(device,controller,()=>intentionalLoss);
        const capability=captureGpuSparseShadingCapabilityRecord(plan,{features:device.features,limits:snapshotGpuLimits(device.limits),
          textureFormatFeatures:["rgba16float-storage","rgba16uint-storage","rg32uint-storage","rg16float-storage"],
          formatProfile:"adr-0013-step-6-correctness-l4-v3"});
        controller.addEvidence("capability",capability);const format=navigator.gpu.getPreferredCanvasFormat();
        const context=canvas.getContext("webgpu");if(context===null)throw new Error("Unable to create WebGPU canvas context");
        context.configure({device,format,alphaMode:"opaque",usage:GPUTextureUsage.RENDER_ATTACHMENT|GPUTextureUsage.COPY_SRC});
        controller.transition("ready");fixture=await SparseShadingCandidateFixture.create(device,context,format,capability,"mixed-bins");
        controller.transition("warming");await new Promise((resolve)=>requestAnimationFrame(()=>resolve(undefined)));
        controller.transition("sampling");const mixedBins=await fixture.runMixedBins();fixture.destroy();
        const mixedBinsDisposal=fixture.resourceCounts();
        fixture=await SparseShadingCandidateFixture.create(device,context,format,capability,"basic-cube");
        const basicCube=await fixture.runBasicCubeNearFar();fixture.destroy();const basicCubeDisposal=fixture.resourceCounts();
        fixture=await SparseShadingCandidateFixture.create(device,context,format,capability,"unlit-vertex-color");
        const unlitVertexColor=await fixture.runUnlitVertexColor();controller.transition("draining");
        controller.addEvidence("readback",{schemaVersion:3,phase:"candidate-pipeline-gpu-execution-oracle",
          scenarios:{mixedBins,basicCube,unlitVertexColor},intermediateDisposal:{mixedBins:mixedBinsDisposal,basicCube:basicCubeDisposal}});
        controller.addEvidence("submit",{main:4,private:0});if(status)status.textContent=
          "passed ADR-0013 Step 6 MixedBins + BasicCubeNear/Far + UnlitVertexColor candidate";
        controller.pass();
      }
    }
  }
} catch(error) {controller.fail(error instanceof Error?error.message:String(error));}
