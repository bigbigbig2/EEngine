import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { mkdir, writeFile } from 'node:fs/promises';
import { runFrameVerticesFixture } from './frame-vertices-fixture.mjs';
if (!process.argv[2]) throw new Error('Pass external webgpu runtime directory');
const { create, globals } = createRequire(resolve(process.argv[2], 'package.json'))('webgpu');Object.assign(globalThis,globals);
const gpu=create(['backend=d3d12']), adapter=await gpu.requestAdapter({powerPreference:'high-performance'});
assert.ok(adapter&&!adapter.info.isFallbackAdapter);
const device=await adapter.requestDevice({requiredLimits:{maxStorageBuffersPerShaderStage:16}}), errors=[];
const keepAlive=setInterval(()=>{},1000);let disposing=false,lost=null;
device.addEventListener('uncapturederror',e=>errors.push(e.error.message));
void device.lost.then(info=>{if(!disposing)lost={reason:info.reason,message:info.message};});
const dir=resolve('.local/validation/surface-geometry');await mkdir(dir,{recursive:true});
const report={evidenceRole:'diagnostic',passed:false,adapter:{vendor:adapter.info.vendor,architecture:adapter.info.architecture,device:adapter.info.device,description:adapter.info.description}};
try {Object.assign(report,await runFrameVerticesFixture(device));assert.deepEqual(errors,[]);assert.equal(lost,null);}
catch(error){report.passed=false;report.error=String(error.stack??error);throw error;}
finally{Object.assign(report,{apiErrors:errors,deviceLost:lost});await writeFile(resolve(dir,'frame-vertices-native.json'),JSON.stringify(report,null,2));disposing=true;device.destroy();clearInterval(keepAlive);}
console.log(JSON.stringify(report,null,2));
