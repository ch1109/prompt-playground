# 渲染 Adapter 字段映射与 Fixture 清单｜v1.0

本目录下 `fixtures/jiuli-v2.0/*.json` **由用户上传的 v2.0 原始 Prompt 文档中的完整“输出契约示例”直接提取**，不是模型实时运行输出，也不是已核验的真实客户业务数据。样例中会存在为说明字段结构而使用的空字符串/临时 ID；用于验证字段映射和结构，而非判断业务准确率。

## P1：委托识别适配器

- `output.rows[]` → `tables.orderRows`，每个 `row.local_row_ref` 是 `rowId`，`values` 的 25 键成为 25 列；一个字段的 JsonPointer 精确如 `/output/rows/0/values/model`。
- `output.source_refs[]` → `evidence`，按 `local_source_ref` 建索引；`row.field_sources` 可以指向证据 Ref；无来源时 `sourceRefIds=[]`。
- `row.field_conflicts[]` → `issues`（有实际结构且定位字段时）；空数组不渲染虚假问题。
- `output.warnings[]` → 通用诊断或一般问题（根据实际数据类型）；不能将字符串随意推断到具体行。
- v2.1 正式字段若存在，`output.precheck_findings[]` → `issues`；行完整性使用事实报告和可追溯证据，不能让 Adapter 擅自宣告“漏行准确率”。

## P2：查货事实适配器

- `output.logical_inspections[]` → `tables.logicalInspections`。
- `logical_inspections[].merged_products[]` → `tables.mergedProducts`；`raw_row_refs` 是关联原始行的引用，适配器需检查每个引用是否真的存在。
- `logical_inspections[].raw_rows[]` → `tables.inspectionRawRows`；必须保持 `local_raw_row_ref`。
- `output.unresolved_scopes[]`、各 `scope_uncertain`、`field_conflicts` → `issues`；不要把无法确定的入仓号自动归入其他逻辑查货单。
- `output.source_refs[]` → `evidence`；`origin_facts/manual_marks/package_facts/weight_facts` 可在详情抽屉按原始对象展示，不强行扁平为一个最终值。

## P3：商品对应适配器

- `output.row_relations[]` → `tables.orderRows` 的关系摘要及 `relations[]`。
- `selected_group.sources[].raw_row_ids[]` → `RelationView.toIds`；`fromId = order_row_id`。检查业务 Ref 是否存在于当前 InputSnapshot，仅在来源清楚时展示边；缺失则保留诊断。
- `candidate_groups` / `weak_candidates` → `tables.candidateGroups`（按原结构展示候选，不允许自动排序出“被选中候选”）。
- `coverage` + `match_evidence` → 关系详情；`confidence` 为模型输出的文字字段，不能作为概率准确率。
- 无候选/缺快照池状态 → `UNMATCHED` 原样呈现，不擅自推断查货未到；v2.1 `unmatched_reason` 有值时才显示具体原因。

## P4：字段裁决适配器

- `output.row_patches[].field_decisions[]` → `tables.fieldDecisions`；字段层稳定键建议 `${order_row_id}:${field}`；`jsonPointer` 指向该 field_decisions 对象中的具体字段。
- `current_value/result_value` + `decision/verification_status/rule_id/source_refs/conflict_values` → `changes[]` 和风险 `issues[]`。
- `output.base_draft_version` 必须与输入快照版本在“只读 Patch 模拟器”中核对；没有基准快照或者版本不匹配 → 只展示 Patch 声称的结果，不生成模拟完整草稿。
- v2.1 `review_findings` 可以额外展示风险；`manual_overlay/field_locks` 可能来自输入上下文，请以实际注册 Schema 决定字段读取路径。

## 通用规范

- JSON Pointer 使用 RFC6901 转义，路径定位要精确到原始响应对应节点。
- Renderer 的 binding 例如 `tables.orderRows` 是**命名表的逻辑选择器**：即从 `ViewModel.tables[]` 选择 `id === 'orderRows'`，不是 JS 对象动态执行表达式。
- `metadata.summary` 属于 Adapter 通过确定性统计派生的**只读 ViewModel extension**，应声明在扩展 Schema 中。如果当前没有扩展实现，summary-strip 要安全隐藏而不是报整个页面失败。
- Schema 错误不等于业务错误；把 `invalid JSON` 与 `JSON valid but schema invalid` 分为两个 Fixture。
- 文件预览必须通过服务端授权，不从 `source_refs.file_name` 直接拼接文件系统路径。
- 业务字符串（包括 `raw_text`）一律当不可信文本转义，禁止渲染 HTML 脚本。

## Fixture 使用要求

1. M0 必须从此目录加载 v2.0 结构示例并确认四套 Adapter 都能适配。
2. 额外自行构造 6 类负例：无效 JSON、Schema 类型错误、P1 冲突数据、P2 无仓号数据、P3 多候选、P4 CONFLICT；负例不得伪装成原始真实单证。
3. 如果拿到真实原始单证和标准结果，将它们作为独立数据集；不要拿这四份模板示例直接宣称“识别准确率 X%”。
