# ADR-0012 · 示例库重置与重建设计边界

Status: accepted

## Context

原 `examples/` 同时承担教学示例、Storybook 目录、独立 WebGPU runtime、Canonical Browser Fixture、验证 Runner、Rendering Lab 和 formal benchmark。多种责任在同一包内长期演化，目录、脚本、测试与权威文档形成了紧耦合；继续在旧结构上增量修补会让下一代示例分类、runtime 生命周期和验证协议被既有实现反向限制。

项目决定先清空现有示例体系，再单独设计新的示例库。重置期间必须诚实表达验证能力缺口，不能保留不可执行的命令、空 Fixture 或伪造的 GPU consumer。

## Decision

- 删除现有教学示例、独立 runtime、Browser Validation Fixture、Validation Runner、Rendering Lab、随附场景资产和专用构建入口。
- `examples/` 只保留一个不导入 `OEngine`、不创建 WebGPU 资源的 Storybook 空壳，以及安装、typecheck 和静态构建所需的最小配置。
- Storybook 能启动或静态构建成功只证明 UI 壳与工具链可用，不证明 Renderer 初始化、WebGPU capability、渲染正确性、GPU producer → consumer、画质或性能。
- 旧 Browser Validation 与 Rendering Lab 的代码、协议和 ADR-0005 不作为新设计兼容目标；需要追溯时使用 Git 历史。已经提交的机器可读 benchmark 继续作为其冻结 commit 的历史证据，不得冒充当前 revision 的验证。
- 新示例库实施前必须通过后续 ADR 确定：示例分类与导航、每例 runtime/resource 生命周期、Storybook 与真实页面的边界、浏览器 Case registry/protocol、错误与 device-loss 语义、截图/readback/counter 产物、综合 workload、formal policy 和 CI 所有权。
- 在替代浏览器宿主落地前，渲染改动可以达到 Implementation Complete，但不能新声明 Runtime Validated、Performance Evaluated、Performance Improved、Pipeline Feature Complete 或 ADR Complete。

## Consequences

仓库暂时失去真实浏览器回归、综合画质 fixture 和 formal 性能入口。TypeScript、WGSL 组合、CPU oracle、静态 ABI 与文档检查仍可运行，但它们不能替代 GPU 运行证据。依赖旧 Fixture 源码的单元测试必须删除该依赖，生产代码不得为了维持旧测试而保留兼容层。

下一代示例库可以重新确定信息架构和验证边界，无需兼容旧 URL、Case id、Bridge、脚本名、场景资产或 artifact schema。恢复任何性能声明前，必须重新建立固定 adapter/browser/resolution/workload/cadence、错误采集和可复算 provenance。

## Verification

- `git ls-files examples` 只包含 Storybook 壳、包/TypeScript 配置、锁文件和空目录说明。
- `examples/` 不引用 `OEngine` 源码，不包含 WebGPU runtime、浏览器 Runner、Playwright、测试场景或 benchmark 资产。
- 在 `examples/` 运行 `yarn typecheck` 与 `yarn build`，确认无 Story 的 Storybook 可以静态构建。
- 静态文档检查确认当前事实页、协作规则和 owner 路由不再指向已删除的验证实现。
