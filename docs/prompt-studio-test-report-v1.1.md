# Prompt Studio v1.1 测试报告（AT-01 ~ AT-36）

- 执行日期：2026-10-10，代码在 commit `92cba64`。
- 环境：macOS，Next.js 16.3.5 生产构建，Playwright 1.56.1（Chromium），Vitest 3.2.4。

## 命令与结果

| 命令 | 结果 |
|---|---|
| `pnpm typecheck` | 0 个错误 |
| `pnpm test` | **107/107 通过**：`tests/unit/acceptance.test.ts` 88 项（v1.0）+ `tests/unit/v1.1.test.ts` 19 项（新增） |
| `pnpm e2e` | **54/54 通过**：`e2e/acceptance.spec.ts` 45 项 + `e2e/v1.1.spec.ts` 9 项（新增） |

> 说明：e2e 第一次跑时有 5 项失败，全部是我新写或新改的用例：
> - 选择器重名 2 项；
> - 测试依赖 e2e 数据库里被其他用例改过的提示词 1 项；
> - 「不涉及图片」的标签写错 1 项（产品文案，已更正）；
> - 一项旧用例跑到中途服务器被另一个会话重启，属于环境干扰。
>
> 修正后整套重跑全部通过。

**证据类型的写法**：
- **Fixture**：用离线样本仅渲染，或用本地假模型服务（不代表真实模型）；
- **真实运行**：调用阿里云百炼 qwen3.6-35b-a3b；
- **浏览器**：Playwright 或 Chrome DevTools 实际操作页面；
- **静态**：只做了代码检查。

## 真实模型运行（本轮 3 次，预算 10 次以内）

| Run ID | 样本 · Prompt | 条件 | 状态 | 耗时（模型 / 解析） | Token 入 / 出 | 输入覆盖 |
|---|---|---|---|---|---|---|
| `run_60ccbe8b7b4e435d` | SC-08 · P1 | v3.0 原文；temperature=0，max_tokens=16000 | SUCCEEDED | 47.2s / 34ms | 3973 / 11087 | 完整；Excel 不涉及图片；文本 8976 字 |
| `run_e9e2b2a82b3347f7` | SC-08 · P1 | 草稿：在原文基础上加一行「Source.column 必须是字符串」，其余条件同上 | SUCCEEDED | 44.9s / 6ms | 3997 / 10550 | 同上；构造输入 Hash 同为 `0e30069bcd37` |
| `run_e809499870a04696` | SC-08 · P2 | v3.0 原文，附带原件图片 | SUCCEEDED | 预处理 107ms / 24.3s / 12ms | 5527 / 7889 | 完整；页图覆盖 1/1，已发送 1 张图片；提示「模型没有声明是否支持图片」 |

**对比结果**：两次 P1 运行在浏览器里显示「✓ 满足严格同条件」。
- 修正 Excel 对齐之后：新增 0 / 删除 0 / 变化 41 / 一致 352 / 无法对齐 0。
- 25 个业务字段的值两次完全相同。
- 变化主要是来源页码（1 和 null 交替），以及「币种」的来源行（第 7/8 行和第 3 行）。
- **注意**：这只说明两次输出的差别，**不代表准确率**。没有 Gold，样本只有 1 套。

**真实运行发现的缺陷**：同一 Excel 行，模型一次把页码填成 1，一次填成 null。原先「原文位置」键包含页码，结果整行被报成删除加新增（373 + 373）。已修复（`92cba64`），并补了单测。

**这几项没有用真实模型验证**：超时、取消、HTTP 失败、不支持的参数。原因是故意制造这些失败会浪费调用次数，所以只用假服务验证（结果见下表）。

## 逐项结果

| ID | 用例 | 结果 | 证据类型 | 位置 / 说明 |
|---|---|---|---|---|
| AT-01 | P1 25 列 + 多行 | PASS | Fixture | unit「AT01」×2：25 个键的顺序与 Pointer 逐一核对 |
| AT-02 | 委托 / 发票单价 10 / 11 冲突 | PASS | Fixture + 浏览器 | unit「AT02」；e2e「AT-02 冲突字段在核心字段下也显示」；截图 `docs/audit-shots/c1-p1-conflict-annotation.png` 显示两个来源（F-ORDER "10"，F-INVOICE 第 1 页 "USD 11.00"） |
| AT-03 | 无牌 / 空 / 未识别 / 0 | PASS（有限定） | Fixture | unit「AT03」：「无牌」= EXPLICIT_NONE，"" = NOT_DETECTED，"0" 保持原值。**v3 契约里「未识别」和「空」都是空串，无法区分** |
| AT-04 | 模型少识别一行 | PASS | Fixture | unit「AT04」×2：有独立 Gold 才报，没有 Gold 不报 |
| AT-05 | P2 同仓号合并 | PASS（仅 v2） | Fixture | unit「AT05」：组成行可以展开，原始行数不变。v3 契约没有合并层，不适用 |
| AT-06 | P2 不同产地同型号 | PASS（静态） | 静态 | Adapter 不做任何合并，原始行逐条输出（`jiuli-p2.ts`）。**没有专门构造这个样本** |
| AT-07 | 仓号不清 / unresolved_scopes | PASS | Fixture | unit「AT06」；v1.1「AT-07 范围 PARTIAL」；e2e「P2 按入仓号分组」 |
| AT-08 | COD / COA / 印刷 Origin | PASS | Fixture | unit「AT07」：类别、原文、来源全部保留 |
| AT-09 | P3 一行对两条查货行 | PASS | Fixture + 浏览器 | unit「AT08」；e2e「AT18」点击关系边 |
| AT-10 | MULTIPLE_CANDIDATES | PASS | Fixture | unit「AT09」：全部候选可见，不自动选中 |
| AT-11 | 召回未包含正确商品 | PASS | Fixture + 浏览器 | v1.1「AT-11 请求候选池」：没被提及的候选会标出；池里没有同型号候选可直接看出是召回问题。e2e「P3 请求候选池」 |
| AT-12 | UNMATCHED 无查货池状态 | PASS | Fixture | unit「AT10」：不出现「等待查货到达」之类的推断 |
| AT-13 | 型号前后缀差异 / 部分覆盖 | 部分 PASS / NOT_TESTED | Fixture | 部分覆盖：OR_004 显示 PARTIAL，并加上 4 条契约诊断（v1.1 单测）。**前后缀差异（MODEL_AFFIX_DIFFERENCE）没有专门样本：NOT_TESTED** |
| AT-14 | P4 KEEP + NO_EVIDENCE | PASS | Fixture | unit「AT12」；v1.1「AT-14/AT-16」：显示「NO_EVIDENCE（未取得证据）」 |
| AT-15 | UPDATE / FILL / CONFLICT | PASS | Fixture | unit「AT13」「AT14」 |
| AT-16 | 人工字段锁 | PASS | Fixture + 浏览器 | v1.1：锁定字段不可模拟应用，矩阵中显示【锁定】；e2e「P4 委托行 × 25 字段矩阵」 |
| AT-17 | base_draft_version 不符 | PASS（v2）/ 不适用（v3） | Fixture | unit「AT15」：版本不符时不生成草稿并给出诊断。v3 契约没有这个字段 |
| AT-18 | 无效 JSON | PASS | Fixture + 浏览器 | unit / e2e「AT16」 |
| AT-19 | 合法 JSON 但不符合 Schema | PASS | Fixture + 浏览器 | unit / e2e「AT17」：报出精确 Pointer，标为局部渲染 |
| AT-20 | 未知 schema_version | PASS | Fixture + 浏览器 | unit「UNKNOWN_SCHEMA」；e2e「没有业务视图时自动显示原始 JSON」 |
| AT-21 | 排序筛选后点击字段 | PASS | 浏览器 | e2e「AT-21」：按序号降序后点第一行，指针是 `/output/rows/2/values/model` |
| AT-22 | 无来源 / 无权限 | PASS | Fixture + 浏览器 | unit / e2e「AT19」：区分 METADATA_ONLY / FORBIDDEN / MISSING |
| AT-23 | PDF 25 页只发 20 页 | PASS | Fixture（构造 25 页 PDF + 假模型） | v1.1「AT-23」：实际发送 20 张图，清单 `page_coverage=20/25`，`complete=false`，`visual_evidence=PARTIAL` |
| AT-24 | 手写页只发文本不发图 | PASS | Fixture | v1.1「AT-24」：`visual_evidence=NOT_SENT`，提示「不能检验视觉识别能力」 |
| AT-25 | Excel 多 Sheet | PASS | Fixture | v1.1「AT-25」：两个 Sheet 的行、列、单元格数都列出；真实运行 `run_60ccbe8b7b4e435d` 也有 Sheet 信息 |
| AT-26 | 模板变量未展开 | PASS | Fixture + 浏览器 | v1.1「AT-26」：服务端拒绝运行，模型没有被调用；e2e「AT-26」预览显示阻断 |
| AT-27 | Provider 不支持输入 / 参数 | PASS | Fixture（假服务） | v1.1「AT-27」：返回 CAPABILITY_UNSUPPORTED / MODEL_PARAM_INVALID / MODEL_PARAM_UNSUPPORTED，模型没有被调用；unit「AT27」文件不支持 |
| AT-28 | 超时 / 取消 / 失败 | PASS | Fixture（假服务） | unit「AT22」×5、取消和中断用例；v1.1「AT-28 原样重试」：重试新建 Run，原失败记录不变 |
| AT-29 | Run 后修改未保存 Prompt | PASS | 浏览器 + 静态 | e2e「AT23」显示「当前结果来自上次运行」；`prompt_versions` 有禁止 UPDATE 的触发器 |
| AT-30 | 历史 Run 回放 | PASS | Fixture + 真实运行 | unit「AT24」「AT28」；真实 Run 重启服务后仍可复查，原始响应 Hash 不变 |
| AT-31 | 标注产地正确值 | PASS | Fixture | v1.1「AT-31」：写入 Annotation（含模型原值、归因、标注人），`raw_response` 与 Hash 完全不变；e2e「标注独立保存」 |
| AT-32 | 模型对、Adapter 显示错 | PASS（机制） | Fixture + 静态 | 可以把归因标为 ADAPTER_RENDER；修 Adapter 后用「重渲染」生成 REPLAY Run 并标明版本变化（unit「AT28」）。**没有构造真实的 Adapter 缺陷样本** |
| AT-33 | 两次 Run 条件完全一致 | PASS | Fixture + 真实运行 + 浏览器 | v1.1「AT-33」；真实运行 `run_60cc…` 对比 `run_e9e2…`：严格同条件 ✓，差异逐项列出 |
| AT-34 | 预处理版本不同 | PASS | Fixture | v1.1「AT-34」：预处理版本或附带图片不同，都判为「不满足严格同条件」 |
| AT-35 | 只读 Connector 越权 / 写入 | PASS（Demo）/ BLOCKED（真实 API） | Fixture | unit「AT21」「AT25」：跨客户访问返回 403，接口上没有写方法，Demo 文件 Hash 不变。**真实九立 API 未配置，无法验证** |
| AT-36 | HTML / 脚本片段 | PASS | 浏览器 + 静态 | e2e「9.4 恶意 HTML 片段按文本显示」（P1 表格）；全仓库没有 `dangerouslySetInnerHTML`（静态检查） |

## 汇总

| 结果 | 数量 |
|---|---|
| PASS | 32 |
| PASS（有限定 / 仅 v2 / 静态 / 机制） | 含在上面的 32 项中，见各行说明 |
| 部分 NOT_TESTED | 1（AT-13 前后缀） |
| BLOCKED | 1（AT-35 真实九立 API 部分） |
| FAIL | 0 |

**九立只读连接状态：只连接九立 Demo 本地文件；真实业务 API 未配置。** 没有任何测试把 Mock 当作真实连接。
