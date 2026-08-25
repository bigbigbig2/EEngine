# M05 · FrameGraph（帧图调度）

## 1. 一句话职责

声明一帧内有哪些 **pass**、读写哪些 **临时资源**，并按依赖执行（含资源复用/别名）。

## 2. 为什么独立成模块

Pass 会越来越多（cull、depth、VB、light、TAA…）。没有 FrameGraph，资源生命周期与执行顺序会散落在 Renderer 上帝类里。

## 3. 拥有 / 不拥有

### 拥有

```txt
- FrameTask / Pass 描述结构
- 资源声明（create/read/write）与生命周期
- build(world/frame) → execute(encoder)
- 与 ResourcePool 的协作接口
- 默认图的「挂载点」（注册 cull pass、draw pass…）
```

### 不拥有

```txt
- 某个 pass 的算法内容（各 render 模块实现 execute 体）
- 场景数据所有权
- three 后处理 EffectComposer 兼容层
```

## 4. 依赖

| 方向 | 模块 |
|------|------|
| 依赖 | M01 Engine（encoder、资源） |
| 被依赖 | 应用 Renderer 门面；各 M08–M13 注册为 task |

## 5. 对外概念接口

```txt
createFrameGraph() → FrameGraph
graph.addTask(task)
graph.build(frameCtx)
graph.execute(frameCtx)
// task: { name, setup(resources), execute(passCtx) }
```

## 6. 计划中的子文档

| 文件 | 用途 | 状态 |
|------|------|------|
| `task-model.md` | Task 模型 | 未写 |
| `resource-aliasing.md` | 临时 RT 复用 | 未写 |
| `default-graph.md` | 默认 pass 顺序 | 未写 |
| `interface.md` | API | 未写 |

## 7. 关联

- 原则：P6 Module boundaries  
- 母本：设计 v2 §3.5、§17 FrameGraph  
- 帧级编排后写：`04-pipelines/`  
