# M15 · Debug & Stats（调试与统计）

## 1. 一句话职责

提供 **统一 stats 计数、debug 视图、性能采样钩子**，让「模块是否达标」可观测。

## 2. 为什么独立成模块

没有统一埋点，各阶段验收会变成口头感觉。独立模块定义指标名与 debug 通道，各 render 模块只负责填充。

## 3. 拥有 / 不拥有

### 拥有

```txt
- FrameStats 结构（cpuMs、uploadBytes、visibleCount、drawCount…）
- Debug view 枚举与切换
- GPU timestamp 可选封装（依赖 M01 features）
- 叠加层 / 日志格式约定
```

### 不拥有

```txt
- 业务 pass 本身
- CI 视觉回归完整系统（可后挂 tests，不阻塞边界定义）
```

## 4. 依赖

| 方向 | 模块 |
|------|------|
| 依赖 | M01；读取各模块导出的 stat 钩子 |
| 被依赖 | 示例、后续 roadmap 验收 |

## 5. 对外概念接口

```txt
createStats()
stats.beginFrame / endFrame
stats.set(counter, value)
setDebugView(view)
// DebugView = albedo | normal | depth | instanceId | materialId | ...
```

## 6. 计划中的子文档

| 文件 | 用途 | 状态 |
|------|------|------|
| `counters.md` | 计数器字典 | 未写 |
| `debug-views.md` | 视图列表 | 未写 |
| `profiling.md` | 计时 | 未写 |
| `interface.md` | API | 未写 |

## 7. 关联

- 原则：可测（与后续 07-roadmap 衔接）  
- 母本：设计 v2 §22 Benchmark  
