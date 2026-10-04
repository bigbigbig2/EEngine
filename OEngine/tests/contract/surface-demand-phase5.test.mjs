import test from 'node:test';
import assert from 'node:assert/strict';
import '../webgpu-test-globals.mjs';
import {surfaceDemandLayout} from '../../.test-dist/gpu/GpuSurfaceDemandAbi.js';
import {GpuSurfaceFieldStore} from '../../.test-dist/gpu/GpuSurfaceFieldStore.js';
import {GpuSurfaceSignalStore} from '../../.test-dist/gpu/GpuSurfaceSignalStore.js';

globalThis.GPUBufferUsage ??= {STORAGE:128,COPY_SRC:4,COPY_DST:8};

test('optional admission capacity is independent of all mandatory fine values',()=>{
  for(const targets of [64,128,25536]) {
    const layout=surfaceDemandLayout(targets,4);
    assert.equal(layout.fieldCapacity,targets*15);
    assert.equal(layout.signalCapacity,targets*6);
    assert.equal(layout.fieldAdmissionCapacity,targets*2);
    assert.equal(layout.signalAdmissionCapacity,targets);
    assert.equal(layout.offsets.field_destinations,undefined);
    assert.equal(layout.offsets.signal_destinations,undefined);
    assert.ok(layout.bytes<targets*300+2048);
  }
});

for(const [label,Owner,budget] of [['Field',GpuSurfaceFieldStore,8*1024**2+4096],['Signal',GpuSurfaceSignalStore,4096]]) {
  test(`${label} namespace restart is queue-ordered, abortable and does not wrap epoch identity`,()=>{
    const device={limits:{maxBufferSize:1<<28,maxStorageBufferBindingSize:1<<27},
      createBuffer:descriptor=>({...descriptor,destroy(){}})};
    const store=new Owner(device,budget);
    const clears=[],finished=[];
    const command={device,closed:false,gpu_encoder:{clearBuffer(buffer){clears.push(buffer);}},
      onFinished:{addOne(callback){finished.push(callback);}}};
    store.submittedEpoch=0xfffffffe;
    assert.equal(store.needsNamespaceRestart(),true);
    assert.equal(store.nextSubmissionEpoch,1);
    store.requestNamespaceRestart();
    store.encodeNamespaceRestart(command);
    assert.equal(clears.length,label==='Field'?2:1);
    assert.equal(store.stats().namespace,1,'Encoding does not commit identity');
    assert.equal(store.needsNamespaceRestart(),true,'Abort retains pending restart');
    const retryFinished=[];
    store.encodeNamespaceRestart({...command,onFinished:{addOne(callback){retryFinished.push(callback);}}});
    retryFinished.forEach(callback=>callback());
    assert.equal(store.stats().namespace,2);
    assert.equal(store.stats().submittedEpoch,0);
    assert.equal(store.needsNamespaceRestart(),false);
    assert.equal(store.trackSubmission(Promise.resolve(),0),1);
    assert.equal(store.nextSubmissionEpoch,2);
    store.destroy();
  });
}

test('dependency allocator uses a submitted upper bound and coordinated restart before u32 exhaustion',()=>{
  const device={limits:{maxBufferSize:1<<28,maxStorageBufferBindingSize:1<<27},
    createBuffer:descriptor=>({...descriptor,destroy(){}})};
  const store=new GpuSurfaceFieldStore(device,8*1024**2+4096),finished=[];
  store.reserveDependencyNamespace({onFinished:{addOne(callback){finished.push(callback);}}},1500);
  assert.equal(store.stats().dependencyReservations,0,'Unsubmitted allocations do not advance identity');
  finished.forEach(callback=>callback());assert.equal(store.stats().dependencyReservations,1500);
  assert.equal(store.needsNamespaceRestart(0xfffffff0-1500),true);
  store.destroy();
});
