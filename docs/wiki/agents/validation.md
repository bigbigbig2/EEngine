# 风险驱动验证

| 变更 | 最低验证 |
|---|---|
| 文档/链接 | `rg` 检查链接、旧术语和孤立文件 |
| TypeScript interface | typecheck + build |
| CPU 数学/ABI | 单元测试 + CPU/WGSL layout 对照 |
| Loader/Cooker | fixture、错误输入、序列化 round-trip |
| GPU producer/consumer | counter、indirect args、overflow fixture |
| Visibility/HZB | debug view、快速镜头、遮挡/漏绘回归 |
| Material/Lighting | 数值/截图回归、材质数量扩展 |
| Temporal | resize、相机切换、LOD 切换、页面恢复 |
| 性能 | `docs/PERFORMANCE.md` benchmark + P95/P99 |

构建通过不能证明渲染正确；平均 FPS 不能证明稳定性或无漏绘。

