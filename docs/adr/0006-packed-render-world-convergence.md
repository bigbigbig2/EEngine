# ADR-0006: Packed Render World 收敛

Status: accepted

## Context

对象图直接驱动 Renderer 会导致每帧遍历、重复状态派生和普通 Scene/Packed Scene 两套执行模型。

## Decision

`GpuRenderWorld` 统一接收 Runtime Asset、普通 Scene adapter 和 Packed source，发布稳定 asset/instance/material identity 与显式 patch。Renderer 只消费冻结 revision，不重新解释 Application World。

## Consequences

bulk/mostly-static 场景获得紧凑表和有界 patch 成本；普通 Scene 只是输入适配器，不是第二套 GPU runtime。完整 Gameplay 生命周期与自动任意对象追踪不在范围内。

## Verification

检查帧间无全量对象扫描、patch 只更新命中窗口、publication 原子、replace/device-loss 后 generation 正确，以及所有生产 Pass 读取同一 revision。
