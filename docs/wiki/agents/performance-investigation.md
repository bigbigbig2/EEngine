# 性能调查流程

## 先固定条件

硬件、OS、浏览器版本、分辨率、DPR、画质、场景、相机、warm-up、采样帧数。

## 再分层

```text
资产候选量
→ GPU 工作生成
→ Visibility/Raster
→ Material/Lighting
→ 全屏与时域带宽
→ CPU 编码/submit/readback
```

## 单变量实验

- feature on/off；
- previous-HZB vs second-chance；
- Hardware vs Software vs Hybrid；
- LOD/hierarchy on/off；
- 单材质 vs 多材质；
- 固定 render scale；
- stats/readback/graph compile on/off。

调查结论必须列出事实、推断和未验证假设。高成本、反直觉结论写入 lessons。

