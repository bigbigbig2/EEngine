# Offline (OEGPACK) validation fixtures

这两组目录是 ADR-0016 S6 的 Offline 路线 fixture：一对由 Native Offline Cooker
产出的 `.oegpack` + `scene.oescene`，供 `virtual-product-offline` case 与
`tests/oegpack-offline-product.test.mjs` 消费。它们是 cooker 的**原始输出**，
未被重命名或改写，目录名只用来提供稳定 URL。

来源 GLB：`glb-web-product-v1.glb`（同目录）（33×33 单面高度场，1 primitive，1 material）。

生成命令（`--out` 分别指向两个目录的临时副本，再整体复制进来）：

```text
tools/oengine-asset-core/build/oengine-asset-cooker.exe glb-web-product-v1.glb \
  --out offline-product-a --threads 1

tools/oengine-asset-core/build/oengine-asset-cooker.exe glb-web-product-v1.glb \
  --out offline-product-b --threads 1 \
  --meshlet-vertices 64 --meshlet-triangles 64 --group-meshlets 4
```

`offline-product-b` 用更细的 meshlet/group recipe cook，因此得到不同的
`packContentHash`，也就得到不同的 Product identity；case 用它验证 Offline 的
Product 替换与换版后的画面连续性。

| 文件 | 字节 | SHA-256 |
| --- | --- | --- |
| `offline-product-a/geometry-967c8790e690c3514f97.oegpack` | 51634 | `224cc92e10e7df787d6575a7a1e3161e3e52420136e86cabc6623e5abd4968ec` |
| `offline-product-a/scene.oescene` | 432 | `d07be9697891b01c8fa15fd4beaf40b3acf6d349ae4e811598907e6cc14d05c3` |
| `offline-product-b/geometry-880a82f452dfa57dbcfa.oegpack` | 57892 | `c6f7678fb8bfc02eb207fa52ea8a686864b7e5cc6360ab38f01571540c262441` |
| `offline-product-b/scene.oescene` | 432 | `3910a4cf7bedd01c356590e5536fa605605794289564312adb1d0e33948d1391` |

合同见 `docs/specs/oegpack-scene-manifest-v3.md` 与 `docs/specs/oegpack-v3.md`。
替换这些 fixture 时必须同时更新本表、命令与 `docs/STATUS.md` 的证据数字。
