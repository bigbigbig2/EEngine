# ADR-0003 · 软硬件混合 Visibility

Status: accepted

## 背景

微三角形可能受固定功能 primitive front-end 限制，普通和大三角形则更适合硬件光栅。当前 OEngine 只有 Hardware Visibility。

## 决策

Visibility 模块支持 Compute Software Micro Raster 与 Hardware Raster。GPU 按屏幕工作量分类，两条路径输出统一 VisibilityKey 和深度语义。

WebGPU baseline 无 64 位原子，默认设计使用两阶段完整深度软件光栅；packed 单阶段只能作为有精度和容量验证的替代实现。

## 后果

- Material Resolve 不感知光栅来源。
- SW/HW 阈值由 benchmark 和 capability profile 决定。
- Hardware 路径始终作为普通场景和 fallback。

## 验证

同一场景可切换 Hardware/Software/Hybrid，比较正确性、SW/HW triangle 数、GPU 时间和跨设备表现。

