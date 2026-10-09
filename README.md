# Prompt Studio v1.0｜Codex 交付包

**产品决策已冻结：方案 C（独立 Studio + 九立只读导入 + 隔离快照运行）**。

开始前请把这个目录整体交给 Codex：

1. `01_Prompt_Studio_PRD_技术实现规范_v1.0.md` —— 完整产品需求、渲染协议、数据架构、交互、接口、安全边界、28 条验收案例。
2. `02_Codex_开发执行指令.md` —— 给 Codex 的直接执行任务入口；先做 M0，再做 M1。
3. `03_渲染契约映射与Fixture清单.md` —— 真正的 P1～P4 输出路径绑定、渲染规则和 Fixture 使用说明。
4. `renderers/*.json` —— P1～P4 四个默认渲染配置草案。
5. `fixtures/jiuli-v2.0/*.json` —— 从用户上传的 v2.0 Prompt 文档提取的 4 份结构演示输出，**不是已验证业务样本**。

## 接入要求

- 无真实九立只读接口时，离线渲染可独立开发并运行，Connector 显示为“未接通”。不可声明已实现真正的九立数据连接。
- 具备授权后的真实只读源时再完成 Connector 联调；不允许 Studio 调试写回九立业务数据。
- P1～P4 最新 Schema/Prompt 的文件由 Codex 在目标仓库中核对；如果已有正式 v2.1 资料，以其实际 JSON Schema 新增版本化 Adapter。
