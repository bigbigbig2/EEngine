# SurfaceWork Runtime V3 Phase 0 基线

日期：2026-10-02。状态：已固定比较身份和采集口径，尚未采样。

唯一配置是 [`surface-work-v3-phase0-baseline.yaml`](../../validation/profiles/surface-work-v3-phase0-baseline.yaml)。本记录只冻结 Phase 7 的实验条件，不把旧报告、dirty worktree 采样或跨设备数据当作 V3 性能证据。

## 固定内容

- 首要目标：GTX 1650 Ti、1920×1080 输出和内部尺寸、Chrome stable headed、device scale factor 1。
- 场景：`dungeon_warkarma.glb`，SHA256 为 `cac0fc8c16d107e7ac4e69efde89c2cb6ef4bc66c34456a4dd0923218e5aafb1`。
- 三个历史比较 revision：`89f0a9412a0740ae67b0062b4337b8785f85400c`、`15f12f7b7a1735078eff968382ce4391efb371e8`、`e7296be9cebbc3bcc1b6b738d682c928548d72d5`；最终 revision 在 Phase 7 固定。
- 特性：HZB、cone visibility、XeGTAO、FSR3、Bloom、physical environment 开启；VSM 和 temporal jitter 关闭；SSE threshold 为 4；固定时间步 1/60 秒。
- 远景和近景按 GPU 可见像素占比分别校准到 25%–35% 和 80%–90%；测量批次锁定相机和驻留状态。
- 每个 revision 预热 60 帧、连续采集 120 帧、两批交替顺序；保留逐帧 GPU interval、P50/P95、所有 counters、源码/资源 fingerprint 和 NVIDIA 传感器窗口。

## 当前边界

Phase 0 没有运行浏览器、GPU benchmark 或性能采样。`adapterIdentity`、温度/时钟和最终 source fingerprint 只在 Phase 7 的 clean revision 宿主记录。VSM-on、AO off、Product LOD/page miss、device recovery 等属于原文 §8.2 的 Phase 7 场景矩阵，不改变这份主基线。
