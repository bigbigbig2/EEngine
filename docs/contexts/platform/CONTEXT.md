# WebGPU Platform Context

## 基线

主要性能 profile 是桌面浏览器 WebGPU 和桌面级独立 GPU；较低能力 adapter 先保证明确 capability 结果和正确 fallback。

## 约束

- Adapter/Device 创建必须先协商 feature/limit。
- 可选能力必须有正确 fallback 或明确拒绝启动。
- 64 位原子、multi-draw-indirect、mesh/task shader、buffer device address 不是 baseline。
- Canvas resize、DPR、page visibility、device lost 和 history 恢复属于平台契约。
- backend/cache 改动参考 PlayCanvas/Babylon，但不复制其多后端复杂度。
- capability adapter 共享主管线 ABI，不形成 Core/Quality/Experimental 三档管线。
- `rg16float` storage HZB 和同 texture 跨 mip compute dispatch 必须由 `examples/r1-compute-hzb` 在目标 adapter 验证；production build 不能替代设备 validation。
