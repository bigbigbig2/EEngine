# 重构与删除

- 重构同步迁移调用方、验证、文档和示例。
- 内部 interface 默认直接迁移，不保留无需求兼容层。
- 删除旧路径后搜索旧符号、旧目录和旧术语残留。
- 当前项目允许删除 reconstructed/oracle/旧 Pass，但必须先确认实际运行 import 和替代验证。
- 不把死代码移动到 `archive/` 规避删除；只有持续研究价值且不会被构建时才保留 reference。
- 保留用户已有、与任务无关的 dirty changes。

