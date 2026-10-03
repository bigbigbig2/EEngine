/** Finite producer/consumer binding contract shared by runtime and GPU fixtures.
 * Explicit layouts keep unused resources legal across compiler specializations.
 * Ordinary sources consume 11 storage bindings; Product sources consume 16. */
export function createSurfaceCellPipelineLayout(device: GPUDevice, product: boolean): GPUPipelineLayout {
  const storageCount = product ? 16 : 11;
  if (device.limits.maxStorageBuffersPerShaderStage < storageCount) {
    throw new RangeError(`Surface cell profile requires ${storageCount} storage bindings`);
  }
  const compute = GPUShaderStage.COMPUTE;
  const buffer = (binding: number, type: GPUBufferBindingType): GPUBindGroupLayoutEntry => ({
    binding, visibility: compute, buffer: { type }
  });
  const geometry: GPUBindGroupLayoutEntry[] = [
    buffer(0, 'uniform'), buffer(1, 'read-only-storage'),
    buffer(3, 'read-only-storage'), buffer(4, 'read-only-storage'),
    buffer(5, 'read-only-storage'), buffer(6, 'read-only-storage'),
    buffer(7, 'storage'), buffer(8, 'read-only-storage'), buffer(14, 'uniform')
  ];
  if (product) {
    for (let binding = 9; binding <= 13; binding++) {
      geometry.push(buffer(binding, 'read-only-storage'));
    }
  }
  const groups = [
    device.createBindGroupLayout({ label: 'Surface/cell work inputs', entries: [
      buffer(0, 'uniform'),
      { binding: 1, visibility: compute, texture: { sampleType: 'uint', viewDimension: '2d' } },
      buffer(2, 'storage')
    ] }),
    device.createBindGroupLayout({ label: 'Surface/cell geometry and appearance', entries: geometry }),
    device.createBindGroupLayout({ label: 'Surface/cell lighting providers', entries: [
      buffer(0, 'read-only-storage'), buffer(1, 'read-only-storage'),
      buffer(2, 'read-only-storage'), buffer(3, 'uniform')
    ] })
  ];
  return device.createPipelineLayout({ label: 'Surface/cell production layout', bindGroupLayouts: groups });
}
