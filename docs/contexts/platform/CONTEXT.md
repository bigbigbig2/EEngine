# WebGPU Platform Context

## 基线

浏览器 WebGPU、WGSL、单 graphics/compute queue 心智和标准 limits/features。

## 约束

- Adapter/Device 创建必须先协商 feature/limit。
- 可选能力必须有正确 fallback 或明确拒绝启动。
- 64 位原子、multi-draw-indirect、mesh/task shader、buffer device address 不是 baseline。
- Canvas resize、DPR、page visibility、device lost 和 history 恢复属于平台契约。
- backend/cache 改动参考 PlayCanvas/Babylon，但不复制其多后端复杂度。
- `rg16float` storage HZB 和同 texture 跨 mip compute dispatch 必须由 `examples/r1-compute-hzb` 在目标 adapter 验证；production build 不能替代设备 validation。
