# 数据所有权与生命周期

> 设计 v2 单向所有权；webgpu-browser-limits 可回收；Shade resident

## 1. 单向所有权

```txt
App/three 对象  --compile/sync-->  World
World           --upload-->        GPU Scene
FrameGraph      --借用-->          临时 RT/Buffer
Post            --持有-->          history（跨帧）
Browser         --可令-->          全部失效重建
```

禁止：

```txt
GPU pass 直接抓 THREE.Mesh 指针
临时 RT 泄漏成「全局隐式当前 target」
```

## 2. 三态生命周期

```txt
1. Authoring 态：three 对象可改
2. Resident 态：GPU 表有效，帧循环消费
3. Invalid 态：device lost / 主动 dispose / 页回收后
```

Invalid → 必须能走回 compile/upload（M14 + M01 + M04）。

## 3. 跨帧 vs 单帧

```txt
跨帧：GPU tables 主体、history、部分 shadow/GI 缓存（路线）
单帧：visible lists、多数中间 RT、部分 pyramid
```

FrameGraph 负责单帧资源别名；resident 表不在「每帧 create/destroy」默认路径。

## 4. 加载与释放（局限文档）

```txt
上传完成后：释放 CPU 临时解码缓冲（意图）
流式：可部分 resident，未加载 id 保持无效或占位
关页：允许全部丢弃；不承诺磁盘级游戏缓存语义
```
