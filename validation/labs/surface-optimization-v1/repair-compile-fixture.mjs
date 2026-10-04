const entries = ['publish_cell_parameter_certificates', 'publish_cell_field_certificates'];
let device;
try {
  const adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' });
  device = await adapter.requestDevice({ requiredLimits: { maxStorageBuffersPerShaderStage: 16 } });
  const compilation = [];
  for (let index = 0; index < entries.length; index++) {
    const file = `${String(index + 8).padStart(3, '0')}.wgsl`;
    const response = await fetch(`/.local/surface-repair-compile/${file}`);
    if (!response.ok) throw new Error('Missing archived shader diagnostic input');
    const code = await response.text();
    const module = device.createShaderModule({ label: file, code });
    const errors = (await module.getCompilationInfo()).messages.filter(message => message.type === 'error');
    if (errors.length) throw new Error(JSON.stringify(errors));
    window.cellOracleStage = `Compiling archived production ${entries[index]}`;
    const begin = performance.now();
    await device.createComputePipelineAsync({ label: file, layout: 'auto', compute: { module, entryPoint: entries[index] } });
    compilation.push({ file, entryPoint: entries[index], milliseconds: performance.now() - begin });
    console.info(JSON.stringify(compilation.at(-1)));
  }
  window.cellOracleResult = { passed: true, evidenceRole: 'diagnostic', compilation,
    scope: 'Archived Dungeon family 1 with the production generator selector coalescing; no execution/performance acceptance' };
} catch (error) {
  window.cellOracleResult = { passed: false, evidenceRole: 'diagnostic', failure: String(error) };
} finally {
  device?.destroy();
}
