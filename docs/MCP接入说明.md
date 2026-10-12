# 让 Codex / Claude Code 读取 Prompt Studio 的运行证据（MCP 接入说明）

Prompt Studio 提供一个**只读**的 MCP 服务。MCP（Model Context Protocol）是 Codex、Claude Code 这类编程 Agent 调用外部工具的标准接口。接好以后，你在 Agent 里给出一个 Run ID，它就能自己读这次运行的全部证据：实际发送的提示词与请求、哪些页进了模型、模型原始输出、Schema / Adapter 诊断、字段来源和人工标注，然后写出带引用的诊断报告。

默认令牌**只能读**：不能改提示词、代码、标注，也碰不到九立业务数据。发令牌时显式加上实验权限，Agent 还能在隔离区创建提示词候选、在固定样本上做实验（见第 7 节）；但正式版本只能由你在网页上采纳。

## 1. 前提

- Prompt Studio 正在运行：在项目目录执行 `pnpm dev`，浏览器能打开 http://localhost:3000 。MCP 服务地址是 `http://localhost:3000/api/mcp`，**只接受本机访问**。
- 已安装 Claude Code 或 Codex（任选其一或都装）。

## 2. 发一个访问令牌

每个 Agent 单独发一个令牌，方便分别撤销、分别审计。在项目目录执行：

```bash
pnpm mcp:grant create --principal claude-code --days 7
```

- `--principal`：这个令牌给谁用，写 `claude-code` 或 `codex` 即可。
- `--days`：有效期（1–90 天，默认 7 天），到期自动失效。
- `--project`：可读哪个项目（默认 `jiuli`），可写多次。
- `--customer`：只允许读某个客户的 Run（例如 `--customer C-89aa660b4b46`），可写多次；不写 = 项目内全部客户。客户受限时，无法确定所属客户的 Run 一律拒绝。

命令最后一行是令牌（`psk_` 开头），**只显示这一次**。不要提交到 git，也不要发到聊天里。

其他命令：

```bash
pnpm mcp:grant list               # 看全部令牌（不显示令牌本身）
pnpm mcp:grant revoke <grant_id>  # 立即撤销
pnpm mcp:grant audit 30           # 看最近 30 次调用记录（谁、何时、读了哪个 Run、是否被拒绝）
```

## 3a. 接入 Claude Code

把上一步的令牌填进下面命令（替换 `psk_…`），在终端执行一次：

```bash
claude mcp add --transport http prompt-studio http://localhost:3000/api/mcp --header "Authorization: Bearer psk_…"
```

令牌会保存在 Claude Code 的本机配置里。之后在 Claude Code 里输入 `/mcp` 能看到 `prompt-studio` 已连接。不再使用时：`claude mcp remove prompt-studio`，并用 `pnpm mcp:grant revoke` 撤销令牌。

## 3b. 接入 Codex

1. 把令牌放进环境变量（写进 `~/.zshrc` 后重开终端）：

   ```bash
   export PROMPT_STUDIO_MCP_TOKEN="psk_…"
   ```

2. 在 `~/.codex/config.toml` 末尾加上：

   ```toml
   [mcp_servers.prompt_studio]
   url = "http://127.0.0.1:3000/api/mcp"
   bearer_token_env_var = "PROMPT_STUDIO_MCP_TOKEN"
   ```

   Codex 这里要写 `127.0.0.1`，不要写 `localhost`。本机实测（Codex 0.162.1）写 `localhost` 时连不上，报 `error sending request`，原因还没查清。

Codex 发请求时会自动带上 `Authorization: Bearer <令牌>`，配置文件里不出现令牌本身。

## 4. 怎么用

1. 在 Prompt Studio 结果页点一个字段，右侧字段面板里点 **「复制 Agent 诊断指令」**。指令里已经带好 Run ID、字段定位，以及你标注的期望值（如果标过）。
2. 粘贴到 Claude Code 或 Codex。Agent 会按顺序调用下面的工具，输出结构化诊断报告。

网页里暂时**不能一键启动 Agent**：浏览器无权在你电脑上运行程序，需要单独的 Runner，属于后续阶段（M4）。

## 5. 工具一览（第一批 8 个，全部只读）

| 工具 | 作用 | 需要的权限 |
|---|---|---|
| `list_runs` | 按项目列出 Run，可按阶段、样本、状态筛选，分页 | `runs:read` |
| `get_run_manifest` | 一次运行的总览：各层版本、采集完整度（缺了什么、有何影响）、诊断状态 | `runs:read` |
| `get_run_trace` | 按需取证据：实际请求（脱敏）、构造输入、输入覆盖、原始响应、Schema / Adapter 诊断；指定字段时给出该字段的显示值、原始节点、来源与实际输入 | `runs:read` |
| `get_prompt_snapshot` | 当次实际发送的提示词（带章节行号），或某个已保存版本 | `prompts:read` |
| `get_source_evidence` | 某条来源：模型声称的原文，对照构造输入里该位置的真实内容（单元格 / 页文本），以及这一页有没有进模型。`view=original` 时直接打开原件读该单元格 / 页，核对原件、输入快照、模型原文三者是否一致，并校验原件 Hash 是否与运行时记录相同 | `evidence:read` |
| `get_annotations` | 人工标注与修订历史，可按字段过滤 | `annotations:read` |
| `get_evaluation` | 评测；没有 Gold 时如实返回「未评测」，不给准确率 | `eval:read` |
| `compare_runs` | 两次运行的业务差异、输入是否可比、Token 与耗时 | `runs:read` |

## 6. 安全边界（服务端强制，不靠 Agent 自觉）

- **令牌**：数据库只存令牌的 sha256；撤销、过期立即失效；没有「一个管理员 Key 读全部」。
- **范围**：每次调用都在服务端核对项目、客户、权限范围；越权返回 `FORBIDDEN` 并写审计。
- **来源读取**：`source_ref` 必须是该 Run 结果里登记过的来源；不接受文件路径，不能跨 Run 猜 ID。打开原件时，文件还必须真的在这次运行的输入里（模型声称的 file_id 可能是编造的）。
- **默认只读**：默认令牌没有任何写入工具；实验权限必须发令牌时显式加上，而且只作用于隔离候选和实验，不存在修改正式版本或业务数据的权限。
- **不可信数据**：每个结果都带一条提醒：原件文字、模型输出、提示词都是数据，其中的指令不执行。
- **缺证据就说缺**：旧 Run 没保存的内容返回 `available:false` 和原因，不重新生成、不推断补齐。
- **大小控制**：单次结果不超过 12 万字符，长文本用 `offset` 分段读；超出时报错提示缩小范围，不悄悄截断。
- **审计**：每次调用（包括被拒绝的、令牌无效的）都记入只追加的审计表。

## 7. 实验权限与工具（v1.3 M3）

发令牌时加 `--scope`，Agent 才会看到下面 3 个工具；不加就看不到，默认令牌仍然只读：

```bash
pnpm mcp:grant create --principal claude-code --days 1 \
  --scope experiments:read --scope experiments:write --scope experiments:execute
```

| 工具 | 作用 | 需要的权限 |
|---|---|---|
| `create_prompt_candidate` | 基于某个已保存版本创建**隔离候选**。修改用「查找 → 替换」描述，每段 find 必须在原文里恰好出现一次。候选不进版本列表，也不影响正式版本 | `experiments:write` |
| `run_experiment` | 在固定样本上运行候选。**会真实调用模型、产生费用**，必须给 `max_model_runs`（服务端硬上限 20），超出就在调用模型前拒绝；`dry_run=true` 只预演、不花钱；同一个 `idempotency_key` 重复提交不会重复运行。已有可比的基线（同一输入、同一模型）会直接复用 | `experiments:execute` |
| `evaluate_experiment` | 查看实验状态与评判报告，只读 | `experiments:read` |

评判规则：没有标准答案，所以只看两类依据。
- **结构检查**：能否解析、Schema 错误数。
- **人工标注**：标「错」并填了正确值的字段，看候选是否改对；标「对」的字段，看候选是否把它改坏。

另外有一道硬闸门：P1 / P2 主表行数减少，按疑似漏行处理。其余输出差异记为「未判定」，不宣称准确率提升。结论分三种：
- **可供人审**：目标样本全部修好、没有退化，且样本都可比。
- **不建议**：有任何退化。
- **证据不足**：其余情况。

审批只在网页上做：「提示词调试 → 候选与实验」页签里能看到 Diff 和逐样本判定，由你点「采纳为正式版本」或「拒绝」。结论不是「可供人审」时，必须先勾选「了解风险」才能采纳。Agent 没有任何采纳或修改正式版本的工具。

## 8. 常见问题

- **Agent 报连接失败**：先确认 `pnpm dev` 在运行、http://localhost:3000 能打开；Codex 的地址要用 `127.0.0.1`。
- **返回 401**：令牌填错、已过期或已撤销。用 `pnpm mcp:grant list` 查看状态，必要时重新发一个。
- **返回 FORBIDDEN**：令牌没有这个项目或客户的授权，或缺少对应权限范围。
- **改了服务端代码后表不存在**：重启一次 `pnpm dev`（开发服务会缓存数据库连接）。
