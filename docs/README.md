---
id: readme
state: current
verifies:
  - project/workstreams/active/eengine-next-clean-rebuild.yaml
  - docs
---
# EEngine Next 文档入口

EEngine 的目标是极致性能、现代 GPU-Driven、WebGPU Native、AAA Rendering 与可持续扩展。当前工程方向是先完善功能效果，再集中优化完整组合；目标、当前实现和历史验证分开阅读。

## 从这里开始

1. 先读目标源码、公开设置、真实主图及直接消费者；用 `node tools/vibe.mjs context <path>` 定位 owner。类、shader、旧注释或 debug 名称的存在不证明生产功能完整。
2. [workstream.authority / currentSlice](../project/workstreams/active/eengine-next-clean-rebuild.yaml)：唯一当前路线和模块入口。本页不复制模块状态，不能根据旧执行计划的 STOP 自动否决用户新的功能方向。
3. [V4 Native Shading 架构母稿](./next-design/eengine-v4-native-shading-2026-10.md)：精简后的全局架构不变量；旧源码快照、预算推演和 M1/M2 迁移顺序已经移入历史记录。
4. [源码与 owner 总结](./domains/README.md)：已实现数据流和缺口，辅助读代码，不替代真实调用核对。
5. [检查与测试说明](./VALIDATION.md)：功能模块的必要检查与最终整图性能验收分开。

Texture Compression 的现行产品边界按需查 [Texture Design](./next-design/eengine-v4-texture-compression-2026-10.md) / [Texture Execution](./next-execution/eengine-v4-texture-compression-execution-2026-10.md)，不作为并行待执行模块。其余旧迁移、效果和性能计划均按 history 回溯，延期责任只从当前执行计划导航；暂停或归档不撤销实现，也不把未完成资格改写为通过。

旧文档/测试工具重构方案已转为历史实施记录；工具当前行为与通用验证纪律统一读 [VALIDATION](./VALIDATION.md)，不再从旧方案启动另一轮治理任务。

使用 `node tools/vibe.mjs context <path>` 查询 owner。导航不是编码许可，也不是实现验证；当前设计/执行链接读取 workstream 的 authority，两种 context 共用路由。

## 文档职责

| 位置 | 内容 |
| --- | --- |
| next-design/ | 总体路线和当前模块目标/设计理由；复杂算法在对应模块启动时研究 |
| next-execution/ | 唯一详细状态、完整单元、验证/延期责任与日期化记录 |
| domains/ | 已实现原理、owner 边界与缺口 |
| contracts/、specs/ | 稳定跨 owner 合同和 ABI |
| sources/、porting/ | 来源与迁移映射、采用状态 |
| adr/ | 决策和替代关系 |
| reviews/、performance/、archive/ | 历史审查和诊断，不定义当前规则 |

`state: current` 表示当前使用，包含目标设计；不能据此认定实现或性能通过。旧 next-design/next-execution 文件保留原路径供引用，`state: history`、顶部历史声明和 `supersededBy` 共同表明它们已退出当前路线，其旧指令不继续生效。`generated` 是工具产物。继续遵守根规则的 frontmatter/verifies 要求。

`node tools/docs-verify.mjs` 检查真实 YAML、Markdown 链接、全局身份、替代环与当前导航。支持 all/changed/staged；staged 读取 index 快照，changed 包含 untracked。历史断链单列 warnings，不重写原始记录；当前断链和历史文档作为 authority 会失败。

verifies.files 是依赖提示，0 findings 不等于正文为真。检查目标是文件链接与导航，不自动认证正文或全部标题 fragment。generated Markdown 必须有实际 producer，单有 marker 不能通过；Git忽略的旧status文件可能残留在本地，不能作为实现状态依据。browser registry 用 `vibe registry --check` 比较字节，只有 `--write` 更新。
