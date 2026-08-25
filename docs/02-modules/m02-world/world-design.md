# M02 · World 设计

> 母本：设计 v2 §3.3、附录 A；`03-data/*`

## 1. World 是什么

```txt
CPU 侧场景真源（逻辑）
plain data stores 的聚合根
不是 Object3D 树，不是 Renderer
```

## 2. 聚合内容意图

```txt
stores: transform/mesh/instance/material/texture/light/…
id 分配器
dirty tracker
（可选）asset registry 引用
（可选）engine 引用
gpuScene 句柄（由外部挂上，或懒创建）
modules 列表（tree-shake 注册）
```

## 3. 对外能力意图

```txt
create/destroy 记录
get by id
mark dirty
iterate dirty ranges
统计：各表 count、free 数
```

## 4. 不包含

```txt
traverse three
encode GPU commands
PBR 公式
```

## 5. 与 Adapter

```txt
Adapter 是主要写入者
应用也可直写 World API（进阶）
直写时仍须 dirty，否则 GPU 陈旧
```

## 6. 序列化预留

```txt
stores 可 transient 导出（调试/自定义格式）
不是第一阶段交付
```
