import { GPUTimer } from '../../../OEngine/src/framegraph/GPUTimer.ts';

let device, timer;
const apiErrors = [];
try {
  const adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' });
  device = await adapter.requestDevice({ requiredFeatures: ['timestamp-query'] });
  device.addEventListener('uncapturederror', event => apiErrors.push(event.error.message));
  device.pushErrorScope('validation');
  const module = device.createShaderModule({ code: '@compute @workgroup_size(1) fn main() {}' });
  const pipeline = await device.createComputePipelineAsync({ layout: 'auto', compute: { module } });
  timer = new GPUTimer(device);
  const encoder = device.createCommandEncoder();
  for (let index = 0; index < 2050; index++) {
    const pass = encoder.beginComputePass({ timestampWrites: timer.getComputeWrites(`pass ${index}`) });
    pass.setPipeline(pipeline);
    pass.dispatchWorkgroups(1);
    pass.end();
  }
  timer.resolve(encoder);
  device.queue.submit([encoder.finish()]);
  await timer.download_results();
  const results = timer.results_to_console_table();
  const error = await device.popErrorScope();
  if (error) apiErrors.push(error.message);
  const complete = results.length === 2050 && results.every((result, index) =>
    result.label === `pass ${index}` && result.start > 0n && result.end >= result.start);
  window.cellOracleResult = { evidenceRole: 'diagnostic', passed: complete && apiErrors.length === 0,
    apiErrors, intervals: results.length, capacity: timer.capacity, adapter: adapter.info,
    queryPages: 3, submits: 1, bytes: timer.readbackByteLength };
} catch (error) {
  window.cellOracleResult = { evidenceRole: 'diagnostic', passed: false, failure: String(error), apiErrors };
} finally {
  timer?.destroy();
  device?.destroy();
}
