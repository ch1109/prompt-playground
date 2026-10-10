# Prompt Studio v1.1 实现报告

> 对应需求：`Prompt_Studio需求_v1.1.md`；审计：`docs/prompt-studio-audit-v1.1.md`；测试：`docs/prompt-studio-test-report-v1.1.md`。
> 本轮范围（用户确认）：审计，加全部 P0；P1 只评估状态，不开发。

## 一、提交记录

| 提交 | 内容 |
|---|---|
| `cda2992` | docs：需求文档与审计报告 |
| `30b095b` | feat：输入覆盖清单、运行前阻断、分阶段耗时、原样重试 |
| `7ded232` | feat：四套视图补齐与证据联动 |
| `bac06aa` | feat：人工纠错标注（评判 + 8 类错误归因） |
| `f3a9dca` | feat：运行对比增加「一致 / 无法对齐」与严格同条件判定 |
| `7f97d49` | feat：提示词编辑器、样本库筛选与详情、空状态入口 |
| `92cba64` | fix：Excel 来源按 Sheet + 行对齐（问题由真实运行发现） |

## 二、R-01 ~ R-16（P0）

| ID | 状态 | 主要变更文件 | 做法与理由 |
|---|---|---|---|
| R-01 样本库 | 已实现 | `lib/fixtures/catalog.ts`、`editor-pane.tsx`（FixtureList / FixtureDetailCard） | 按来源分为三组：真实运行录制（非 Gold）、人工构造异常样本、结构 Fixture。原来每个录制样本单独占一个分组标题，列表很长。支持按样本名、样本号、验收项（如 AT09）搜索，按来源、Schema 版本、是否有 Gold 筛选。选中后显示素材、录制来源、上游依赖、能否真实运行。P1~P4 筛选沿用左侧导航（只列当前 P 的样本）。 |
| R-02 输入覆盖 | 已实现 | 新增 `lib/runs/input-manifest.ts`、`components/playground/input-coverage.tsx`；`page-images.ts`、`service.ts`、`contracts/run.ts` | 每次运行和请求预览都生成 `input_manifest`，列出：文件、原件 Hash、预处理版本、文本字数与页码、Excel 的 Sheet 行列、页图实际发送页 / 总页数（用 `pdfinfo` 读取）、`page_coverage`（如 20/25）、`truncation_reason`、视觉证据是否送入。缺页、没有可发送内容、模型声明不支持图片时 `complete=false`，界面醒目提示「不是完整输入」。20 页上限保留（原因：控制请求体积和费用），但超出部分会明确报告，不静默截断。 |
| R-03 请求预览 | 已实现 | `service.ts#previewModelRun`、`editor-pane.tsx#PreviewTab`、`input-builders#unresolvedVariables` | 预览增加模型参数、token 粗估（按字符数估算，标「粗估」）、草稿状态和覆盖卡片；文本做脱敏。模板里出现未登记的 `{{变量}}` 时，预览显示阻断原因，服务端拒绝运行，返回 `UNRESOLVED_TEMPLATE_VARIABLE`。 |
| R-04 能力与诊断 | 已实现 | `provider-adapter.ts`、`openai-compatible.ts`（1.1.0）、`service.ts#runBlockers`、`editor-pane.tsx#CapabilityTable` | 能力通过 `.env.local` 显式声明：`MODEL_SUPPORTS_IMAGES`、`MODEL_SUPPORTS_JSON_MODE`、`MODEL_SUPPORTS_THINKING`、`MODEL_MAX_OUTPUT_TOKENS`。没填的显示「未声明」，不当作支持。以下情况在运行前直接拦截：声明不支持图片却勾选附带图片、`max_tokens` 超过上限、参数不合法或不受支持。Run 新增记录：分阶段耗时（预处理 / 模型 / 解析）、服务商请求 ID、费用（服务商不返回价格时显示「未知」）。失败或取消的 Run 可以原样重试（`/api/runs/[id]/retry`）。状态枚举保留 `CREATED`，与需求里 IDLE / INPUT_READY 的对应关系见审计 §3。 |
| R-05 Run 不可变 | 已实现（沿用） | `db.ts` 触发器 | 新字段都写在 Run 的 JSON body 里，不改表结构。重试会新建 Run，原 Run 不变。 |
| R-06 提示词编辑 | 已实现 | 新增 `prompt-editor.tsx`；`prompts.ts`、`db.ts`（change_note 列） | 继续使用 textarea（遵守「不为换技术栈重写 UI」），在外层补了：全文搜索（计数和所在行）、可收起的规则目录（按「一、」「#」「【】」标题，带行号）、光标所在行、变量实时检查。保存版本时可以填变更说明，并显示父版本和创建时间。版本只新增，不覆盖。 |
| R-07 双 Run 比较 | 已实现 | `run-compare.tsx` | 差异分为 新增 / 删除 / 变化 / 一致 / 无法对齐。对象数组找不到可靠业务键时标为「无法对齐」，不按行号硬配。严格同条件判定要求以下各项都相同：构造输入 Hash、附带图片、预处理版本、构造器、模型、参数；缺记录也判为不满足。修复了审计发现的问题：一边附带图片、一边没有时，原来会显示「同输入」。也修复了真实运行中发现的问题：Excel 页码噪声导致整行错配。没有 Gold 时只展示差异，不计算正确率。 |
| R-08 P1 视图 | 已实现（有限定） | `data-table.tsx`、`business-view.tsx` | 被问题指向的单元格显示「冲突 / 问题」角标；「核心字段」视图也保留有问题的列（原来默认看不到冲突列）；可以只看有问题的行、按列筛选、排序。**限定**：v3 契约中「未识别」和「空」都用空串表示，Studio 无法区分，不做猜测。 |
| R-09 P2 视图 | 已实现（有限定） | `jiuli-p2.ts`（v3 Adapter 1.1.0） | `range_status` 为 PARTIAL / UNCERTAIN 时进入问题区；可以按型号、品牌、产地等列筛选，并支持「只看有问题的行」；修正了 `raw_row_count` 的指针。**限定**：v3 契约没有「合并商品」层，三层视图只在 v2 有；产地来源类别仍以「类别:原文」的文本显示，没有做成徽章。 |
| R-10 P3 视图 | 已实现 | `jiuli-p3.ts`（v3 Adapter 1.1.0）、`renderers/v3/jiuli-p3-v3.renderer.json`（1.1.0） | 新增「请求候选池」，列出 InputBuilder 实际传入的全部候选：是否被选中、列为候选、列为弱候选、完全没提及，以及占用情况。用它区分「召回问题」和「裁决问题」。新增 4 条契约检查：MULTIPLE 少于 2 组、同一原始行被两个 MATCHED 选中、COMPLETE 但不是 DISJOINT、选中已被他人占用的行。构造器不做过滤，所以没有「被排除候选」，也不编造。 |
| R-11 P4 视图 | 已实现（有限定） | `jiuli-p4.ts`（v3 Adapter 1.1.0）、`jiuli-p4-v3.renderer.json`（1.1.0） | 决策、核验状态、写入策略附中文说明；锁定字段标「【锁定】」，且不进入可模拟应用集合；`value_origin` / `write_policy` 指向请求中的精确位置；新增「委托行 × 25 字段」矩阵，没核验的字段显示「本轮未核验」，不当作空值。**限定**：v3 契约没有 `rule_id` 和 `base_draft_version`（草稿版本由系统按 request_id 绑定），对 v3 不适用；v2 照旧核对。 |
| R-12 联动 | 已实现 | `data-table.tsx`、`issue-list.tsx`、`result-pane.tsx` | 列排序只改变显示顺序，指针不变（e2e AT-21 验证）；问题行和选中对象上有「查看 JSON 位置 / 查看来源」。 |
| R-13 原始材料 | 已实现（有限定） | `evidence-viewer.tsx#excelRowExcerpt` | Excel 证据显示快照中该行的单元格，内容来自随请求发送的预处理文本，并高亮对应列。证据卡注明原文是「模型摘录」还是「请求原文」。**限定**：不提供原件 Excel 的单元格截图。 |
| R-14 人工纠错 | 已实现 | `repositories/runs.ts`、`db.ts`（增量加 6 列）、两个标注接口、`annotations-export.ts`、`result-pane.tsx#AnnotationForm` | 评判分 错误 / 正确 / 不确定。错误归因 8 类，可以标「疑似 / 待核实」。保存时，服务端按指针记录模型原值（请求输入位置不记）、来源引用和标注人（`STUDIO_USER`，默认「本机用户」）。标注错误必须选归因，标注正确不能带归因。旧标注照常显示和导出。Gold 晋升属于 R-21（P1），本轮不做。 |
| R-15 主界面 | 已实现 | `result-pane.tsx`、`playground.tsx` | 空状态提供「打开最近一次运行」和「查看示例结果（样本 Fixture）」。样本仅渲染的结果统一显示「不是模型本次运行」。其余沿用现有布局：放大、拖动分栏、旧结果横幅、窄屏页签。 |
| R-16 九立只读 | 沿用，如实说明 | — | **状态：只连接九立 Demo 本地文件；真实业务 API 未配置。** 只读接口、跨客户拒绝、快照隔离的测试照常通过。 |

## 三、R-17 ~ R-26（P1，本轮只评估）

| ID | 状态 | 说明 |
|---|---|---|
| R-17 标签组合筛选 | 部分 | 样本库能搜索标签（验收项、场景、样本号），但没有组合标签体系 |
| R-18 可编辑快照 | 未实现 | — |
| R-19 P1/P2 → P3 手动构造 | 部分（v1.0 已有） | 从九立 Demo 导入时可以构造 P3 输入并显示候选池；不能把 Studio 的 P1/P2 Run 输出直接当作上游 |
| R-20 P3 → P4 | 未实现 | Demo 没有已确定关系，所以如实阻断 |
| R-21 Gold 管理 | 未实现 | 标注已经有评判和归因，可作为后续晋升 Gold 的基础 |
| R-22 批量回归 | 未实现 | `docs/批量运行报告_2026-10-09.md` 是手动批量，不是功能 |
| R-23 正确率报告 | 未实现 | 对比界面明确写着「没有 Gold 不算正确率」 |
| R-24 规则命中复盘 | 未实现 | — |
| R-25 继续上次调试 | 已实现（v1.0） | 工作区持久化（zustand persist） |
| R-26 性能观察 | 部分 | Run 记录预处理、模型、解析三段耗时；浏览器渲染耗时没有记录 |

## 四、数据库迁移与回滚

- 只做加列，不删除也不修改旧数据：
  - `annotations`：assessment、error_category、category_confirmed、model_value、source_ref_ids、author
  - `prompt_versions`：change_note
- 服务启动时自动补列（`lib/repositories/db.ts`）。Run 的新字段写在 JSON body 里，不改表结构。
- **回滚**：切回旧代码即可。旧代码不读这些新列，SQLite 允许多余的列存在，旧数据不受影响。
- **一处兼容改动**：`prompt_versions` 的插入语句改成显式列名，否则加列后旧的插入语句会失败。

## 五、版本号变化

| 组件 | 旧版本 | 新版本 |
|---|---|---|
| jiuli-p2-v3 Adapter | 1.0.0 | 1.1.0 |
| jiuli-p3-v3 Adapter | 1.0.0 | 1.1.0 |
| jiuli-p4-v3 Adapter | 1.0.0 | 1.1.0 |
| jiuli-p3-v3 RendererConfig | 1.0.0 | 1.1.0 |
| jiuli-p4-v3 RendererConfig | 1.0.0 | 1.1.0 |
| OpenAI 兼容 Provider 适配器 | 1.0.0 | 1.1.0 |

另外新增 `input-manifest@1.0.0`。

以下未变：InputBuilder（1.2.0）、Schema、Prompt 原文。历史 Run 可以通过「重渲染」用新 Adapter 查看，原 Run 不变。

## 六、还缺什么、为什么、下一步

1. **九立真实只读 API**：外部条件，仓库中没有接口。目前用 Demo 文件和离线样本完成调试。
2. **模型能力未声明**：`.env.local` 没有 `MODEL_SUPPORTS_IMAGES` 等配置，界面显示「未声明」。qwen3.6-35b-a3b 附带图片时输入 token 明显增加，但是否真的支持看图需要你确认后再填。
3. **v3 契约限制**：「未识别」与「空」无法区分；P2 没有合并层；P4 没有 rule_id / base_draft_version。这些需要在九立提示词或契约层面决定，Studio 不擅自补字段。
4. **下一阶段（P1）建议顺序**：
   1. R-21 Gold 晋升：基于现有标注；
   2. R-22 / R-23 批量回归与正确率：只在 Gold 覆盖部分计算；
   3. R-18 可编辑快照；
   4. R-20 P3 → P4 手动串联。
