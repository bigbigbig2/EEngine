# OEngine 共享领域语言

## 产品词汇

- **OEngine**：面向 WebGPU 的 GPU-first 游戏引擎核心。
- **Application World**：面向 Gameplay、编辑和序列化的 CPU 世界表示。
- **GPU Render World**：面向批处理、查询和工作生成的 GPU 常驻表示。
- **Runtime Asset**：设备无关、可序列化、由 Cooker 生成或 Loader 解析的资产。
- **Resident Resource**：已上传到特定 GPUDevice、可以被 GPU 安全引用的资源。
- **Change Set**：Application World 向 GPU Render World 传递的显式增量变化。

## 几何与工作生成

- **Meshlet**：有顶点/三角形上限、可独立剔除和光栅化的几何簇。
- **Cluster Group**：具有父子关系和几何误差的 Meshlet/Cluster 组。
- **Geometry Hierarchy**：用于 GPU traversal 和 LOD 选择的层次结构，不等同于 streaming page table。
- **Geometric Error**：资产空间简化误差。
- **Screen-Space Error (SSE)**：几何误差投影到屏幕后的像素误差。
- **Work Queue**：GPU producer 写入、后续 GPU consumer 间接消费的工作列表。
- **VisibilityKey**：统一标识可见 Cluster/实例/局部三角形的 32 位键；软硬件路径必须产出相同语义。

## 渲染

- **Hardware Visibility Raster**：固定功能光栅器通过 indirect draw 写 VisibilityKey 和 depth。
- **Software Micro Raster**：Compute 处理微三角形覆盖与深度竞争。
- **Hybrid Visibility**：GPU 根据屏幕工作量把 Cluster/三角形分到软硬件路径，最终合并为统一 Visibility。
- **Material Resolve**：根据 VisibilityKey 回查几何和材质，生成着色所需的表面数据。
- **Unified Pipeline**：一条统一主管线；功能通过依赖和配置启停，不按档位复制三套管线。

## 完成语义

- **存在**：仓库里有类、函数或 Shader。
- **接入**：真实主帧 producer/consumer 已连接。
- **闭环**：数据、容量、溢出、生命周期、统计和验证均成立。
- **完成**：在固定场景通过正确性、性能和回归验证；不能只以“接入”代替。

