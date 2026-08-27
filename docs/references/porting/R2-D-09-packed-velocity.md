# R2-D-09 · Packed Velocity motion transform

## Reference

- Reference ID：`R2-D-09-GL-MATRIX-MOTION`
- upstream project：gl-matrix
- repository URL：https://github.com/toji/gl-matrix
- locked package/tag：`gl-matrix@3.4.4` / `v3.4.4`
- locked tag commit：`accefb6ddf1897a0dc443bbc7664c90e67af6455`
- npm integrity：`sha512-latSnyDNt/8zYUB6VIJ6PCh2jBjJX6gnDsoCZ7LyW7GkqrD51EWwa9qCoGixj8YqBtETQK/xY7OmpTF8xz1DdQ==`
- source：upstream `src/mat4.js`，installed package `esm/mat4.js` 的 `invert()` / `multiply()`
- license：MIT；npm package 保留 `LICENSE.md`
- matrix convention：column-major；不可逆矩阵由 `invert()` 返回 `null`
- decision：`direct dependency`

## ABI v2 与保留不变量

`InstanceRecord` 仍为 192 B，但 ABI 从 v1 升到 v2：offset 64 保存 `current_object_to_world`，offset 128 不再保存 raw previous matrix，而保存：

```text
previous_from_current = previous_object_to_world * inverse(current_object_to_world)
```

CPU bulk/patch 阶段使用锁定的 gl-matrix 求逆与相乘；Packed Velocity 每个可见像素只做一次预计算矩阵乘法，不再执行完整 4×4 inverse。第一次 frame patch 使用旧 current 作为 previous；同一 frame 的后续 patch 通过已有 motion × current 重建 prior-frame transform；下一 frame 重新以当前矩阵为 previous。

## Failure / fallback

- current 与 previous byte-identical 时直接写 identity，即使静态 transform 奇异也能表达零运动。
- 其他不可逆、非 affine、相对 3×3 determinant 不足 `1e-8` 或非有限结果写 identity，并设置 `MotionInvalid`；相对判据除以三轴长度乘积，不会把单纯很小但条件良好的 uniform scale 误判。Velocity Shader 输出零，禁止 NaN/Inf/病态放大。
- 同一 frame 已丢失 prior transform 后即使再次 patch 为可逆矩阵，也保持 `MotionInvalid` 到下一 frame，避免伪造速度。
- 该内部 flag 由 packer/patch owner 控制，不能由调用者伪造为有效。

## 性能假设与验证

工作从 `shaded pixels × mat4 inverse` 移为 `patched instances × CPU mat4 inverse`；稳定实例零新增 CPU/GPU 工作。新增依赖可 tree-shake，版本精确锁定。实际 GPU 时间需由 Packed Velocity timestamp 前后 artifact 补齐；结构上已经由 Shader source audit 证明 `mat4_inverse`/`inverse()` 不存在。

本地验证：`gpu-scene.test.mjs` 覆盖 translation、same-frame、next-frame、singular/recovery/abort；`packed-r2-algorithms.test.mjs` 覆盖 rotation、non-uniform scale、current→previous 点映射和 Shader source；完整 `npm test` 覆盖 ABI/build。
