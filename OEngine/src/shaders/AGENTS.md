# Shader 所有权

- WGSL 与 CPU ABI 必须有单一事实源，禁止在多个调用点重复硬编码 offset/stride/bit layout。
- `oracle`、`generated` 和可读重写版本并存时，必须标明实际运行 source-of-truth。
- Shader 变更必须记录 workgroup size、资源访问模式、原子竞争和目标 WebGPU capability。
- 软光栅需与硬件路径共享 VisibilityKey、深度约定、边规则和材质解析结果。
- 仅编译成功不算验证；需要数值、截图、debug view 或 GPU benchmark。
