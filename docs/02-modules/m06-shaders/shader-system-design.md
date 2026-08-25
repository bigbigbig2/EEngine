# M06 · Shader 系统设计

> 母本：设计 v2 §18；对比 TSL；PBR 语义参考 three

## 1. 立场

```txt
用 WGSL + 可组合 fragment
不用完整 TSL/Node 作为 GPU-resident 内核
BRDF/外观语义可参考 three Standard
```

## 2. 组合意图

```txt
ShaderFragment：可拼接的源片段
Composer：按变体选择片段图
稳定 ABI：与 bind group 布局一致
```

## 3. 变体键意图

```txt
来自 Material.flags、几何 attributeMask、pass 类型
例：HAS_NORMAL、ALPHA_TEST、双面、是否 skinned
控制排列组合爆炸：核心子集优先
```

## 4. 与三套路径共享

```txt
Baseline forward
Visibility（极简 FS）
Material resolve
Lighting
Post
尽量共用：math、transform、PBR lib、编码函数
```

## 5. 禁止

```txt
每材质一份完全手写无注册 shader（v1 主路径）
运行时字符串任意用户 GLSL 注入当内核
```

## 6. 调试

```txt
变体名可打印
支持强制 debug 替换输出（albedo only 等）
```
