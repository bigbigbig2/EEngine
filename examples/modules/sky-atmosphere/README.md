# Mesa Commons · Sky & Atmosphere

这是模块示例线里的天空与大气场景。它使用一块 600 m × 600 m 的程序化地面，中心放置平台、柱列、太阳石和低矮地形，专门观察 Physical Sky、太阳 VSM 阴影、FSR3 时域抗锯齿和 aerial perspective 的组合行为。

```powershell
Set-Location examples
yarn demo:sky
```

页面地址为 `http://localhost:5175/modules/sky-atmosphere/index.html`。场景没有外部模型或 HDR 资产；地面和几何在页面启动时经过同一套 GeometryProduct cook/upload 路径。
