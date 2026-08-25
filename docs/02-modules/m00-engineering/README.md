# M00 · Engineering（工程骨架）

## 1. 一句话职责

提供可构建、可运行示例的 **仓库与工具骨架**，不包含渲染算法。

## 2. 为什么独立成模块

工程问题（包管理、TS、示例入口、CI）与渲染内核无关，单独成册避免和 Engine 搅在一起。

## 3. 拥有 / 不拥有

### 拥有

```txt
- monorepo / 包划分约定
- TypeScript / 构建 / lint 约定
- examples 入口壳
- 文档与代码目录对齐约定
- CI 占位（测试以后再接）
```

### 不拥有

```txt
- WebGPU 设备逻辑（→ M01）
- 场景数据（→ M02）
- 任何 pass / shader
```

## 4. 依赖

| 方向 | 模块 |
|------|------|
| 依赖 | 无（最底层工程） |
| 被依赖 | 所有模块间接受益 |

## 5. 对外概念接口

```txt
- 仓库可安装、可启动 example
- packages/* 命名与 docs/02-modules 对齐（见 01-architecture/repo-alignment.md）
```

## 6. 计划中的子文档

| 文件 | 用途 | 状态 |
|------|------|------|
| `repo-layout.md` | 未来 packages 树 | 未写 |
| `scripts.md` | dev/build/test 命令 | 未写 |
| `coding-conventions.md` | 代码约定 | 未写 |

## 7. 关联

- 原则：P9 Docs match code  
- 母本：设计 v2 §21 目录设计  
