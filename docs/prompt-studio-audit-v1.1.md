# Prompt Studio v1.1 代码级审计

> 依据：`Prompt_Studio需求_v1.1.md` §1。基线 commit `6e39443`（2026-10-10）。
> 审计方法：先读源码，再实测。不只看截图，也不因为某个按钮存在就判"已完成"。
>
> **基线测试（实际执行）**
> - `pnpm typecheck` 通过
> - `pnpm test`：88/88 通过
> - `pnpm e2e`：45/45 通过
>
> **实测环境**：`next start -p 3200`。数据库用 `data/studio.db` 的副本，强制 `MODEL_API_KEY=""`，所以审计期间不会调用真实模型。接口脚本和浏览器（Chrome DevTools）都跑在这个环境上。截图在 `docs/audit-shots/`。
>
> **状态取值**：已实现且实测通过 / 已实现未验证 / 部分实现 / 未实现 / 不适用。

## 0. 前置事实

| 项 | 实际情况 | 证据 |
|---|---|---|
| v3 契约 | `prompts/jiuli-v3/P1~P4_*_FINAL_v3.0.txt`，加上 Studio 根据文档推导的 Schema `lib/schemas/jiuli-v3.ts`（不是九立官方 Schema）。外层统一为 `schema_version="jiuli-ai-v3"` | Schema 注册键为 (promptKind, schemaVersion)：`lib/schemas/registry.ts:47` |
| 界面上的 `v3.0-fix1` | 是数据库里的 Prompt 版本（`pv_7a00ed032f824376` 等），**不是**另一套 Schema。业务 Schema 仍是 `jiuli-ai-v3` | `prompt_versions` 表；真实 Run `run_8c53b17ee1db4dd3` |
| v2.0 / v2.1 | v2.0 有独立的 Schema 和 Adapter（`jiuli-ai-v2`）。v2.1 **不存在正式 Schema**，只把 `relation_review_status` 等作为可选增强字段识别 | `lib/adapters/jiuli-p3.ts:18`；`docs/验收结果.md` AT11 |
| 样本 | 共 65 个：v2 结构示例 4 个、v3 真实录制 48 个（12 套 × P1~P4，**不是 Gold**）、人工构造 13 个（其中 1 个带 Gold 行数）| `lib/fixtures/catalog.ts` |
| 真实模型 | `.env.local` 已配置阿里云百炼 `qwen3.6-35b-a3b`（OpenAI 兼容接口）。审计库副本里有 97 个 Run，其中 55 个是 MODEL_RUN | `sqlite3 … select count(*), sum(mode='MODEL_RUN') from runs` → `97\|55` |
| 标注 | 审计库中**有效标注 0 条** | `select count(*) from annotations where deleted_at is null` → 0 |
| 九立连接 | **只读取九立 Demo 本地文件**；真实业务 API 的连接器是占位实现（全部方法返回 `CONNECTOR_UNAVAILABLE`） | `lib/connectors/registry.ts:10-34`，`types.ts:7` |

## 1. 必测五条路径（§1.2）

| # | 路径 | 结果 | 证据 |
|---|---|---|---|
| 1 | P1 委托书与发票冲突 | **通过（Fixture）** | 用 `constructed/p1-v3-conflict.json` 仅渲染，Run `run_b78ba6d26c204076`。界面显示 FIELD_CONFLICT「报关单价：委托单价 10 与发票单价 11 不同」，附 2 个来源（F-ORDER 原文 "10"、F-INVOICE 第 1 页原文 "USD 11.00"）。「无牌」显示为 EXPLICIT_NONE，空串显示为 NOT_DETECTED。截图 `a1-p1-conflict.png`。**问题**：冲突单元格本身没有角标；冲突字段不在「核心字段」里，默认看不到；两个来源都是 METADATA_ONLY（样本快照没有原件） |
| 2 | P2 同入仓号多原始行 | **通过（Fixture），v3 有契约限制** | v2：`constructed/p2-v2-merge.json` 显示 2 个逻辑单 / 2 个合并产品 / 4 条原始行，悬空引用 IR_404 被诊断出来。v3：`v3/SC-08/P2` 显示 1 个逻辑单 / 2 条原始行 / 2 条范围记录。**v3 契约本身没有"合并产品"层**（P2 提示词规定由程序合并），所以只有两层 |
| 3 | P3 多候选 | **部分通过** | `constructed/p3-v3-multi-candidate.json`：OR_002 为 MULTIPLE_CANDIDATES，3 个候选按模型原顺序显示，没有自动选中任何一个；关系图可以切换。**缺口**：请求中有 6 个候选，视图只列模型提到的。请求里有、模型没提到的候选看不到，所以无法区分「召回问题」和「裁决问题」 |
| 4 | P4 UPDATE / CONFLICT | **通过（Fixture），有缺口** | `constructed/p4-v3-conflict.json`：7 个决策（KEEP 1 / UPDATE 2 / FILL 2 / CONFLICT 1 / MISSING 1），可模拟应用 2 个，带 SIMULATION_ONLY 标签；KEEP+NO_EVIDENCE 显示「未取得证据」。**缺口**：决策表显示英文枚举；没有锁定徽章；没有「委托行 × 25 字段」视图 |
| 5 | 同样本两个 Prompt 版本 | **部分通过（真实运行）** | `run_8d293992f12e4c0c`（v3.0 原文）对比 `run_8c53b17ee1db4dd3`（fix1）：同一快照，构造输入 Hash `c06ba4b2f4c8` 相同，参数相同。对比弹窗能显示提示词行级差异和 JSON 差异。**发现缺陷**：`run_1496486108ce4418` 附带了 1 页原件图片，但构造输入 Hash 仍是 `c06ba4b2f4c8`，对比弹窗的「构造输入 Hash」一行显示相同，**会误导用户以为输入相同**；对比也没有「严格同条件」的总判定 |

**Fixture 与真实链路分开说明**：路径 1~4 只用了 Fixture 仅渲染。路径 5 用的是历史真实 Run（2026-10-09 运行的 qwen3.6-35b-a3b）。本轮审计**没有**新调用真实模型。

## 2. 审计矩阵

| 需求 ID | 状态 | 代码 / 页面 / 测试位置 | 实测证据 | 问题描述 | 修复方式 | 优先级 |
|---|---|---|---|---|---|---|
| R-01 样本库 | 部分实现 | `lib/fixtures/catalog.ts:14`；`editor-pane.tsx` 的 FixtureList | P1 下列出 19 项。每个录制样本单独占一个分组标题，列表高 1012px、可视区 758px，需要滚动 | 有来源标签（结构示例 / 真实录制·非Gold / 人工构造）和 ctx 角标。缺：搜索、按来源 / Gold / Schema 版本筛选、样本详情（provenance、页数、上游依赖、能否运行）、问题标签 | 改造：summary 增加 hasGold / schemaVersion / tags；列表加搜索与筛选；加详情展开 | P0 |
| R-02 输入覆盖 | 部分实现 | `lib/runs/page-images.ts:12`（MAX_PAGES=20，截断会警告）；`service.ts:269`（attached_images）；`materials/preprocess.ts` | 页数超限时生成警告「只附带了前 N 页」，**不是静默截断** | Run 上没有 `sent_text_chars / sent_image_count / page_coverage / truncation_reason / preprocessor_version / original_file_hash`；没有集中展示的「覆盖」卡片；Excel 不统计 Sheet 覆盖；页数截断时 Run 没有标「非完整输入」 | 新增：运行时生成 `input_manifest` 并写入 Run；预览接口返回同一份；在预览页和运行信息页展示 | P0 |
| R-03 请求预览 | 部分实现 | `service.ts:141` previewModelRun；`editor-pane.tsx` PreviewTab；e2e「请求预览与真实运行使用同一份输入」 | 预览显示展开后的 system/user、构造器、prompt hash / input hash、附件文件列表；与运行使用同一快照（e2e 已覆盖） | 不显示模型参数和 token 粗估；预览页没有「未保存草稿」标记；**未替换的 `{{变量}}` 会原样发送**（`renderUserTemplate` 只替换 `{{input_json}}`）；预览文本没有过 `redactSecrets` | 改造 previewModelRun 和 PreviewTab；服务端拦截未解析变量 | P0 |
| R-04 Provider 能力 | 部分实现 | `provider-adapter.ts:16`；`openai-compatible.ts`；`contracts/run.ts:7` | 失败时保存 MODEL_ERROR，不回退为 Mock（单测 AT22 ×5）；可以取消；中断后标为 INTERRUPTED | 能力只声明了 `supportsFileInput=false`，**没有「是否支持看图」**：勾选附带图片时不会预先校验；没有分段耗时；服务商 request id 取到了但没保存；费用恒为 null，界面显示 "unknown"；没有重试按钮。状态枚举用 CREATED 而不是 IDLE/INPUT_READY | 新增 capabilities（来自环境变量，默认保守）；Run 记录 timing / request id；失败 Run 加「重试」 | P0 |
| R-05 Run 不可变 | 已实现且实测通过 | `db.ts:43-49` 触发器（raw_responses 禁止 UPDATE；非 RUNNING 的 runs 禁止 UPDATE；prompt_versions 禁止 UPDATE）；`service.ts` rerender 另存 REPLAY | 单测 AT24 / AT28 /「数据库层不可修改」通过；路径 5 的历史 Run 原始响应 Hash 可以复查 | 缺：Run 上没有预处理清单（并入 R-02）；没有 DELETE 触发器（目前没有删除接口，风险低） | 复用；清单并入 R-02 | P0 |
| R-06 Prompt 编辑器 | 部分实现 | `editor-pane.tsx:101/111`（textarea）；`repositories/prompts.ts:16` | 有未保存红点和「未保存草稿」徽标；版本只能 INSERT，不可变；草稿运行会记录 `is_unsaved_draft` 和实际 hash | 没有全文搜索、行号、章节目录、变量检查；版本没有 change_note | 改造：在 textarea 上加搜索、行号、目录、变量检查；prompt_versions 加 change_note 列 | P0 |
| R-07 双 Run 比较 | 部分实现 | `run-compare.tsx` | 路径 5：能列出提示词差异和按业务键对齐的 JSON 差异 | 分类只有 新增/删除/变化，缺「一致 / 无法对齐」；退回按位置对齐时不提示；条件比对**漏了附带图片和预处理版本**（见路径 5 的误导）；没有「严格同条件」总判定 | 改造 compareRuns 和 diffJson | P0 |
| R-08 P1 视图 | 部分实现 | `adapters/jiuli-p1.ts`；`data-table.tsx` | 路径 1：25 字段 / 核心字段切换、序号和型号列固定、表内横向滚动、Gold 漏行判断都正常 | 冲突单元格没有角标（只在问题区）；「未识别」和空串都算 NOT_DETECTED（v3 契约用空串表示缺失，未识别时只在 issues 里说明，所以分不开是契约本身的限制）；没有按字段/状态筛选 | 改造：冲突角标、悬浮显示各来源值；补充"有问题的行"筛选 | P0 |
| R-09 P2 视图 | 部分实现 | `adapters/jiuli-p2.ts`；`business-view.tsx:99-192` | 路径 2 通过；没有入仓号的行归入虚拟分组，不伪造仓号 | v3 契约没有合并产品层（不适用）；v3 的 `range_status=PARTIAL/UNCERTAIN` 不生成问题；没有型号/品牌/产地/风险筛选；产地来源类别是拼接文本，没有徽章 | 改造 Adapter（PARTIAL/UNCERTAIN 生成问题）和视图筛选 | P0 |
| R-10 P3 视图 | 部分实现 | `adapters/jiuli-p3.ts:114-206` | 路径 3 | 看不到请求中未被提及的候选（召回诊断缺失）；`occupied_by_order_row_id` 不显示；缺 3 条契约一致性检查（MULTIPLE 至少 2 组、同一原始行被多个 MATCHED 选中、COMPLETE 必须 DISJOINT）。InputBuilder 原样传入全部原始行，没有"被排除候选"的数据（不适用） | 新增「请求候选池」表：逐条显示被哪些委托行选中、列为候选、未提及，以及占用情况；补诊断 | P0 |
| R-11 P4 视图 | 部分实现 | `adapters/jiuli-p4.ts:115-284` | 路径 4 | v3 契约**没有 `rule_id` 和 `base_draft_version`**（草稿版本由系统通过 request_id 绑定，见 P4 提示词「二、VERIFY_FIELDS 输入」），所以这两项对 v3 不适用，v2 已实现；没有「委托行 × 25 字段」视图；枚举未中文化；`write_policy=LOCKED` 没有醒目标识；`value_origin / write_policy / simulated_value` 单元格指针太粗 | 改造：矩阵视图（未评估字段显示「本轮未核验」，不当作空）、中文标签、锁定徽章、修正指针 | P0 |
| R-12 联动 | 部分实现 | `studio-store.ts:118`；`result-pane.tsx` cellIndex；e2e AT18 | 单元格 ↔ JSON ↔ 问题 ↔ 关系边可以联动（e2e 通过） | 表格不能排序；字段和问题上没有显式的「查看 JSON / 查看来源」按钮（要先选中，再到抽屉里点） | 新增列排序（指针不随顺序变）；单元格抽屉加两个按钮 | P0 |
| R-13 原始材料 | 部分实现 | `evidence-viewer.tsx`；`api/materials/[id]/preview` | PDF 能跳到 `#page=N`；METADATA_ONLY / FORBIDDEN / MISSING 有区分（单测 AT19） | Excel 只显示 Sheet/行/列文字，不显示单元格内容；FORBIDDEN 时仍显示模型输出里自带的 raw_text（这是模型输出，不是原件，需要标明） | 证据卡显示快照预处理文本中对应 Sheet 行的单元格；标明「原文摘录来自模型输出」 | P0 |
| R-14 人工纠错 | 部分实现（关键缺口） | `result-pane.tsx` AnnotationForm；`repositories/runs.ts:94`；`db.ts:39` | 能新增、修改、软删除、导出；不改 raw_response（单测 AT24） | 没有 错误/正确/不确定 判断；没有 8 类错误归因；不保存模型原值、来源引用、标注人；没有「疑似 / 待核实」 | 增量迁移 annotations 表（只加列）；改造表单 | P0 |
| R-15 主界面 | 部分实现 | `playground.tsx`；`result-pane.tsx:153` | 截图 `a1-p1-conflict.png`：结构完整、可放大、可拖动分栏、有旧结果横幅、窄屏有页签 | 结果区空状态只有文字；没有「最近 Run / 示例 Fixture」入口 | 改造空状态 | P0 |
| R-16 九立只读 | 已实现且实测通过（仅 Demo） | `lib/connectors/*`；单测 AT20 / AT21 / AT25 | 接口没有写方法；跨客户访问返回 403；导入前后 Demo 文件 SHA-256 不变；快照记录 source_ids / source_version / content_hash / parent_snapshot_id | 真实业务 API 未配置，状态如实写为 `仅 Demo 本地文件`；快照没有单独的「授权范围」字段（客户白名单来自 `JIULI_ALLOWED_CUSTOMERS`） | 复用；报告如实说明 | P0 |
| R-17~R-26 | 见实现报告 | — | — | P1 项，本轮只评估状态 | — | P1 |

## 3. 冲突与兼容决定

1. **P2 v3 没有合并产品，P4 v3 没有 rule_id / base_draft_version。** 需求说「读真实 v3 契约，不把 v2 字段硬套」。所以这几项对 v3 判「不适用」，v2 的实现保留；不编造字段。
2. **状态枚举。** 现有 `CREATED` 对应需求里的 IDLE / INPUT_READY。前端用「输入就绪」提示来体现，数据库枚举不改，避免迁移旧 Run。
3. **P3 「被排除的候选」。** 现在的 InputBuilder 不做过滤，把全部原始行原样传入，所以没有排除记录；只展示「请求候选池」，不编造排除原因。
4. **数据库变更全部是增量**（加列，或在 Run 的 JSON body 里加字段），不删也不改旧数据。

## 4. 开发顺序

按需求 §13 推进：阶段 B（R-02 / R-03 / R-04、四套视图、R-12 / R-13）→ 阶段 C（R-14 / R-07 / R-06 / R-01 / R-15）→ 阶段 D 只做评估。每项的完成情况见 `docs/prompt-studio-implementation-v1.1.md`。
