# Loader 所有权

- 拥有源格式检测、解析、规范化和 Runtime Asset 构造。
- 不拥有长期 GPU 资源，不直接把临时解析对象注册为 GPU 数据 owner。
- glTF/USD/自定义格式支持必须以明确子集、错误诊断和 fixture 表达。
- Cooker 可离线生成的昂贵几何工作，不应默认在每次运行时加载重复执行。
- 格式扩展不得重新引入 three.js 兼容依赖。
