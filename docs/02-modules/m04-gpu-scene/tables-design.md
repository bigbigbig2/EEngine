# M04 · GPU Tables 设计（承接 03-data）

> 母本：设计 v2 §6  
> 字段细节见 [`../../03-data/records-fields.md`](../../03-data/records-fields.md)

## 1. 模块责任边界

```txt
M04 拥有：
  GPUBuffer 镜像
  upload 调度与 budget
  visible/counter/indirect 缓冲池尺寸策略

M04 不拥有：
  字段业务语义的「发明权」（跟 03-data / 母本）
  cull/VB 算法
```

## 2. 必须常驻的表集合（按阶段累积）

| 阶段 | 表 |
|------|-----|
| Phase 2 | Instance, Transform, Mesh, Material, Texture 元数据, Bounds |
| Phase 3 | + VisibleInstance + Counters |
| Phase 4 | + Meshlet + VisibleMeshlet |
| Phase 3–7 | + Maybe 列表、IndirectArgs 随路径 |
| 全程 | Light 表在 lighting 需要时存在 |

## 3. Upload 契约

```txt
输入：World dirty ranges
输出：GPU 表与 CPU 逻辑版本对齐（帧内）
失败：budget 耗尽时可跨帧摊销，须可观测（Stats）
```

## 4. 与 Bind Group 的关系

```txt
Scene 表进入稳定 bind group 布局意图（设计 v2 附录 G 方向）
具体 slot 号实现时冻结；设计要求「一张场景组、一帧常量组、pass 资源组」分层
无 bindless 时纹理不走「无限数组 id」，走 TextureRegistry 策略
```

## 5. 调试

```txt
可打印：表元素数量、upload bytes、full vs range 比例
M15 计数器命名应稳定
```
