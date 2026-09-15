# ADR-0011: Asset Codec 与 GPU-native Texture

Status: accepted

## Context

主线程即时解码、隐式格式转换和 reference codec 进入生产 source graph 会增加卡顿、复制和格式不确定性。

## Decision

KTX2 preparation 使用固定版本 Khronos libktx Worker/WASM；Cooked GPU-native variant 优先直接上传。`GraphicsContext` 惰性持有有界 codec service，结果回到统一 TextureAssetPackage/Residency 流程。Production source graph 不得 import `ReferenceTextureCodec`。

## Consequences

codec provenance 和许可证写入 porting ledger；Worker 失败、取消和 device loss 必须有清晰语义。reference codec 仅用于测试/oracle，不是运行时 fallback。

## Verification

验证固定 artifact hash、format/extent/mip、Worker 生命周期、GPU upload/readback 和 production import audit；来源见 [platform ledger](../porting/platform.md)。
