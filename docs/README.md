---
id: readme
state: current
verifies:
  - project/workstreams/active/eengine-next-clean-rebuild.yaml
  - docs
---
# EEngine Next 文档入口

EEngine 的目标是极致性能、现代 GPU-Driven、WebGPU Native、AAA Rendering 与可持续扩展。目标、当前实现和历史验证分开阅读。

## 从这里开始

1. [V4 Native Shading 架构母稿](./next-design/eengine-v4-native-shading-2026-10.md)：全局架构不变量和 M1/M2 设计。
2. 当前模块的设计/执行读 workstream.authority；Texture Compression 使用 [Texture Design](./next-design/eengine-v4-texture-compression-2026-10.md) / [Texture Execution](./next-execution/eengine-v4-texture-compression-execution-2026-10.md)。已完成 M3 留在 [Lighting Execution](./next-execution/eengine-v4-lighting-execution-2026-10.md)；[原执行记录](./next-execution/eengine-v4-native-shading-execution-2026-10.md)保留 M1/M2/CPU 结果和通用验证纪律。
3. [workstream 的 currentSlice](../project/workstreams/active/eengine-next-clean-rebuild.yaml)：当前切片，本页不复制阶段。
4. [源码与 owner 总结](./domains/README.md)：当前实现边界；目标采纳不表示源码完成。
5. [检查与测试说明](./VALIDATION.md)：真实命令、范围和未运行项。
6. [文档与测试轻量收口方案](./next-design/eengine-documentation-validation-system-redesign-2026-10.md)：待讨论方案。

使用 `node tools/vibe.mjs context <path>` 查询 owner。导航不是编码许可，也不是实现验证；当前设计/执行链接读取 workstream 的 authority，两种 context 共用路由。

## 文档职责

| 位置 | 内容 |
| --- | --- |
| next-design/ | 目标架构与设计理由 |
| next-execution/ | 切换步骤、退出要求和日期化记录 |
| domains/ | 已实现原理、owner 边界与缺口 |
| contracts/、specs/ | 稳定跨 owner 合同和 ABI |
| sources/、porting/ | 来源与迁移映射、采用状态 |
| adr/ | 决策和替代关系 |
| reviews/、performance/、archive/ | 历史审查和诊断，不定义当前规则 |

`state: current` 表示当前使用，包含目标设计；不能据此认定实现或性能通过。`history` 只供追溯；`generated` 是工具产物。继续遵守根规则的 frontmatter/verifies 要求。

`node tools/docs-verify.mjs` 检查真实 YAML、Markdown 链接、全局身份、替代环与当前导航。支持 all/changed/staged；staged 读取 index 快照，changed 包含 untracked。历史断链单列 warnings，不重写原始记录；当前断链和历史文档作为 authority 会失败。

verifies.files 是依赖提示，0 findings 不等于正文为真。检查目标是文件链接与导航，不自动认证正文或全部标题 fragment。generated Markdown 必须有实际 producer，单有 marker 不能通过；旧 status 生成页已删除。browser registry 用 `vibe registry --check` 比较字节，只有 `--write` 更新。
