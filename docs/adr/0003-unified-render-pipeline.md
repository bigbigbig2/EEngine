# ADR-0003: 统一渲染主管线

Status: accepted

## Context

为质量档、实验功能或 benchmark 复制整条 Renderer 会造成 ABI 分叉、重复资源和无法比较的结果。

## Decision

`Renderer` 作为公开 shell，`MainRenderPipeline` 作为唯一 recipe owner。能力通过 feature dependency、FrameGraph pruning 和静态 specialization 组合；所有变体共享 FrameProducts、GPU queue 与 asset identity。

## Consequences

功能可以启停，但不得形成独立 Core/Quality/Experimental backend。替换算法必须迁移 consumer 并删除旧路径，不保留长期 runtime switch。

## Verification

编译图和真实浏览器 topology 应只有一条主管线；feature-off 无 live pass/resource/readback/submit；切换完成需通过删除审计。
