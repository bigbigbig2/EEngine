# R5 FX-03 · B-shading-oracle

使用生产 `Renderer.render()`、单个 Damaged Helmet 和冻结的 64×64 working-linear HDR octahedral 环境验证 IBL。页面关闭 direct light、shadow、SSR、SSAO、Temporal、exposure 与 post，输出 Surface、Diffuse IBL、Specular IBL、Linear HDR 和最终 tonemapped 调试视图，并采集 sampled-mip histogram 与环境显存 owner 证据。

自动入口：`npm run gate:r5-fx03`。
