# M04 · GPU Scene — 设计意图

> 母本：设计 v2 §6；Shade v3 GPU-resident；docs/source/comparison-three-vs-shade.md「数据结构层面重写」

## 1. 为何是地基

docs/source/comparison-three-vs-shade.md / Shade：

```txt
three：开发者友好的对象图
现代路径：GPU 可独立读的连续表

没有 GPU scene tables：
  无法认真做 GPU cull / VB 回查 / resident
  容易退回 CPU render-list
```

## 2. 表要支撑的能力（母本能力集）

```txt
GPU 读场景
GPU culling
visible list
shader 经 id 回查 mesh/material/transform/texture
CPU 不每帧遍历全部 Mesh 决定 draw
```

## 3. Resident 的含义

```txt
关键数据长期在 GPU
CPU 上传的是变更与流式新资源
不是每帧把整个场景从 JS 对象重新塞一遍
```

## 4. 与首次加载的关系（webgpu-browser-limits）

```txt
Resident 之前：网络→解码→上传仍是大成本
本模块负责「进 GPU 之后」的布局与更新契约
加载管线与 worker 策略是同级系统，不背锅式塞进单个 draw pass
```

## 5. 非目标

```txt
不在本模块实现 BRDF
不在本模块实现 HZB 算法（消费 bounds 表即可）
不持有 THREE.* 类型
```
