# OEngine 活跃实施文档

implementation 文档只协调仍在进行的跨 owner 交付，不是永久设计档案。

每篇必须声明 `Status: active|blocked`、Owners、Outcome、Slices 和 Shared gates。每个 slice 以可运行 producer -> consumer 结果为单位，写清退出证据与删除目标；不得只列类名、文件名或“完成基础设施”。

切片完成后：

1. 把当前 owner/数据流写回 ARCHITECTURE 或 PIPELINE。
2. 把剩余风险和下一步写回 STATUS。
3. 把稳定字段写入 spec，来源写入 porting ledger。
4. 删除已完成的过程叙述，让 Git 保存历史。

## Active

- [0016 · Virtualized Assets](./0016-virtualized-assets.md)
