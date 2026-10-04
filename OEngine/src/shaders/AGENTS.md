# Shader 所有权

- WGSL 与 CPU ABI 必须有单一事实源，禁止在多个调用点重复硬编码 offset/stride/bit layout。
- `oracle`、`generated` 和可读重写版本并存时，必须标明实际运行 source-of-truth。
- Shader 变更必须记录 workgroup size、资源访问模式、原子竞争和目标 WebGPU capability。
- 软光栅需与硬件路径共享 VisibilityKey、深度约定、边规则和材质解析结果。
- 编译通过只证明源码可构建。当前 SurfaceWork V3 按根 AGENTS 每阶段集中检查编译、必要数值/覆盖及真实 GPU producer→consumer，通过后推进；完整生命周期、连续画质与同条件历史性能仍留 Phase 7。其他模块按通用模块节奏；正式 evidence/claims 不由编译结果提升。
