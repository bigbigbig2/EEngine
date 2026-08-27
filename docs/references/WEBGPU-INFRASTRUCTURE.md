# WebGPU 工程参考

## 当前 capability 契约

- 主要性能 profile：桌面浏览器 WebGPU、桌面级独立 GPU。
- 低能力 adapter：明确协商 feature/limit，保证正确 fallback 或拒绝原因，不作为近期主要性能 Gate。
- 64 位原子、MDI、mesh/task shader、buffer device address 不是 baseline。
- `texture-formats-tier1`、storage format、timestamp-query、subgroups 等必须在设备创建前协商。
- capability 只选择同一 module 的 adapter，不产生第二条产品管线。

## 工程参考

| 参考 | 用途 | 不采用 |
|---|---|---|
| Babylon.js | device/pipeline/bind group/frame graph 工程化 | 多后端和通用 Mesh 产品架构 |
| PlayCanvas | WebGPU cache、scan/scatter、浏览器适配 | GSplat 专用链直接替代 Mesh renderer |
| three.js WebGPU | feature negotiation、timestamp/readback 生命周期、浏览器行为 | three.js public interface 和场景生态 |
| Renderling/wgpu | Web/backend 与 shader ownership 对照 | Rust/native ABI 进入 OEngine public interface |

## 验证

- feature/limit/format 在目标 adapter 真实创建设备并运行 micro example；
- production build 不替代 WebGPU validation；
- validation/uncaptured/device-lost/compilation diagnostics 必须进入 artifact；
- steady frame 不创建无条件 encoder/submit/readback；
- pipeline/bind group/compiled graph 以稳定 key 缓存；
- resize、render-scale、camera cut 和 feature toggle 使对应 history 正确失效。
