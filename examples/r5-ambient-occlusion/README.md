# FX-07 Ambient Occlusion Gate

使用 production `Renderer.render()` 验证当前 GTAO/SSAO 的 flat/corner、near/far、full/half、temporal off/on、camera pan/disocclusion 与 feature-off 生命周期。runner 保存 AO raw、spatial denoise、temporal、final linear HDR 关键帧，并记录逐 Pass GPU timestamp、AO/history bytes 与 graph/submit/readback 证据。
