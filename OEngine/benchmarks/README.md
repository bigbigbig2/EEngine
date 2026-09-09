# OEngine 性能证据

本目录保存机器可读 schema、冻结 workload/config 和确定性审计结果。验证规则以 [`docs/VALIDATION.md`](../../docs/VALIDATION.md) 为准，当前风险以 [`docs/STATUS.md`](../../docs/STATUS.md) 为准，算法来源以 [`docs/porting/`](../../docs/porting/README.md) 为准。

## 当前工具

- `src/debug/BenchmarkRunController.ts`：warm-up、采样、异步结果收尾。
- `src/debug/FrameProfiler.ts`：CPU/GPU phase、submit、upload/readback 和 counter。
- `src/debug/BenchmarkCapabilityEvidence.ts`：feature-to-counter 支持状态。
- `tools/audit-shader-sources.mjs`：Shader import/consumer/owner 静态审计。
- `benchmarks/shader-source-audit.json`：审计生成物，不是设计权威。
- `tools/benchmark-texture-residency-policies.mjs`：对相同 texture set 的所有唯一排列比较 Step 2 候选 bank policy。
- `benchmarks/texture-residency-policy.json`：Step 2 方案选择的可复算内存、增长、copy/resize 与预算证据。
- `examples/rendering-lab/`：唯一保留的真实浏览器 fixture。

## 采样合同

固定 commit/dirty state、浏览器、adapter、分辨率、DPR、feature set、workload、seed、camera path、warm-up 和采样帧数。GPU timestamp 不可用时明确记录 unavailable，不能用 CPU 时间替代。Readback 必须异步、有界；ring 满时丢样本并记录 diagnostics，不阻塞主帧。

最低证据包括：

- CPU frame/build/compile/execute/submit；
- GPU 总时间与逻辑 phase P50/P95；
- submit、upload/readback bytes；
- GPU queue/work/visibility/material/lighting/temporal counters；
- resident/transient/history/shadow memory；
- validation、uncaptured error、device loss 和采样失败；
- feature-off 时对应 Pass、资源、history、readback 和 submit 缺席。

## Shader source 审计

```powershell
Set-Location OEngine
npm run audit:shaders
```

Shader 数量、分类、实际 consumer 和 deletion candidate 只以生成的 `benchmarks/shader-source-audit.json` 为准；README 不复制会随源码变化的计数。运行审计后必须检查生成物 diff，不能手工修改结果。

## 结果解释

结构完整只说明 artifact 可分析，不代表能力或性能达标。任何结论必须能从真实 producer、counter/timestamp、浏览器 diagnostics 和相同条件对比复算；一次截图、空 counter 或类名存在都不是证据。
