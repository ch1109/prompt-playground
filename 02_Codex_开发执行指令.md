# Codex 执行指令｜Prompt Studio 独立 Web 工具 v1.0

你将开发 **Prompt Studio**：用于结构化 Prompt 的编辑、运行、可视化调试、错误定位与版本回放的独立 Web 工具。第一版聚焦九立 P1～P4，未来需复用在其他 Prompt 项目。

**唯一设计基线**：优先完整读取同目录《01_Prompt_Studio_PRD_技术实现规范_v1.0.md》及 `renderers/*.json`，本文件是执行入口，不能替代完整规格。方案 C 已冻结：**独立应用 + 九立只读连接 + 隔离输入快照**。不要把它做成九立原 Demo 中的一个 Tab，也不要把 Prompt Studio 的测试写入九立业务池。

## 0. 开发前的硬性预检

1. 扫描当前可访问的仓库目录、`package.json`、路由与布局、样本、九立 Demo 数据源/API、文件预览组件、P1～P4 提示词和 JSON Schema；不要猜测用户电脑上的文件路径一定存在。
2. 列出能复用的组件、尚未实现的模块、环境工具和运行前置条件。特别确认是否存在九立的**真实只读接口**；若无则不得假设某个 URL 可用或声称已经连通。
3. 如果仓库里已有 sub agents/agent 编排和相关工具，优先按照项目约定使用；不要因为缺少某个模型的第三方 API Key 而擅自改变调试产品的输入或模型设计。
4. 使用真实已存在的 P1～P4 输出样本、提示词文档中的结构演示样本作 Fixture，区分真实样本与人为构造的测试数据；先构建 mock 可见结果，避免做一堆空页面。
5. 不修改 P1～P4 的业务字段定义和来源裁决规则。若 v2.1 正式 schema 不在仓库，先完全支持 v2.0，额外风险字段按可选设计，记录该限制。

## 1. 分两层落地，不要大而全

### M0：先交付可运行的离线可视化调试

- 支持手动粘贴/上传 JSON 的 `RENDER_ONLY` 模式；不调用模型即可看到结果。
- 原始输出永久独立存储；JSON Parse、Schema Validation、Adapter、Renderer 分层。
- 实现通用类型：`TableView/IssueView/RelationView/ChangeView/EvidenceView/Diagnostic/SelectionState`。
- 实现 P1 宽表+问题、P2 入仓号分组+合并原始行、P3 候选对比+关系图、P4 字段决策+只读 Patch 预览。
- 点击字段/问题/关系，联动 JSON 路径、文件来源；失败时明确说明无原文证据/预览权限。
- UI：左侧项目/P1-P4，编辑输入区、右侧可视化结果；结果区“可视化/原始 JSON/结构校验/运行信息”，最大化和拖拽分隔线。
- 支持无效 JSON、合法 JSON 但 Schema 失败、未知 Schema、部分来源不可访问等降级。

M0 完成后先验证全部 Fixture，确保渲染正确，再进入下一阶段。

### M1：再交付真实 Playground 与九立只读导入

- Prompt Editor、版本存储、模型配置/服务端调用网关、离线文件/JSON/上游快照输入、实际请求预览。
- 本地持久化 `PromptVersion / InputSnapshot / Run / Annotation`。每次 Run 保存模型、参数、输入和 Prompt Hash、原始响应、诊断、适配器和渲染配置版本。
- 九立只读 Connector：有已确认的真实只读数据源则实现并完成授权检查；否则实现 `JiuliReadonlyConnector` 契约、`LocalFixtureConnector` 与明确的“尚未配置/尚未连通”界面，不要做假的“真实接入成功”。
- 只读导入流：选客户/任务/查货批次 → 授权读取 → 挑选数据 → 创建 Studio 快照 → 显式构造 P1/P2/P3/P4 输入 → 运行。刷新只能创建新快照。
- 运行历史回放和用户纠错标注；标注不得修改模型原始 JSON，也不得写回九立业务数据。
- 完整 P1→P4 自动编排、批量 A/B 准确率评测、拖拽式模板设计器与多人协同先不做。

## 2. 必须采用的 Schema 绑定

目前原始 v2.0 提示词结构：

- P1: `output.rows[]` 中 `local_row_ref/values/field_sources/field_conflicts`；25 个业务字段保留。
- P2: `output.logical_inspections[]` 中 `warehouse_no/raw_rows/merged_products/unresolved_scopes`（`unresolved_scopes` 位于 output 顶层）；原始行必须能展开追溯。
- P3: `output.row_relations[]` 中 `order_row_id/match_status/selected_group/coverage/match_evidence/candidate_groups/weak_candidates`。
- P4: `output.row_patches[]` 中 `order_row_id/field_decisions/row_verification`，单字段包含 `decision/current_value/result_value/verification_status/rule_id/source_refs`。

如果实际 v2.1 schema 存在，则通过 `(promptKind,schemaVersion)` 注册独立 Adapter：P1/P2 precheck_findings、P3 relation_review_status、P4 review_findings 等新增字段不得破坏 v2.0 渲染。

## 3. 安全和业务边界（不能妥协）

- 只读 Connector **没有外部写方法**，禁止九立业务源的 POST/PATCH/PUT/DELETE；Studio 创建快照/运行可 POST Studio 本身 API。
- 不能直接编辑模型输出；纠错标注独立保存。
- P3 的关系线只是一种观察/标注，不更改九立原始行占用、对应或核销。
- P4 的 Patch 仅本地模拟，不写入正式核对草稿、不封版、不触发人工确认。
- 连接凭据仅服务端保存和使用；校验客户权限和文件授权；不把未授权客户信息回显给前端。
- 运行外部模型前检查文件能力并提示材料将发送到哪个服务商，禁止在报错时悄悄替换为假结果。

## 4. 验收与提交格式

按主规格的 AT01～AT28 编写/执行单元测试、组件测试、关键 E2E 和只读安全测试。至少提供四份 P1～P4 示例与异常 JSON 样本。每次改动先确保已经通过的用例没有退化。

完成时报告：

1. 当前仓库、技术栈、实际复用情况和文件变更清单；
2. M0/M1 每一项完成度，以及 UI 可访问路由；
3. 运行、测试、构建的真实命令和通过/失败结果；
4. 真实九立只读 Connector 的联通情况与权限约束（**未接通必须明确**）；
5. P1～P4 四类测试样本的可见结果与异常降级结果；
6. 剩余问题、阻断条件与 M2 后续项。

**验收底线**：离线模式能完整运行四个渲染视图；所有输出可查看原始 JSON；可定位和复现；既不篡改原始结果，也不写回九立业务系统。
