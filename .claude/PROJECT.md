# Prompt Studio 项目记忆

给以后接手的 AI 或人看。这是项目的「长期记忆」：重大变更、遇到难题解决后要更新这里。

产品是什么：一个只在本机使用的网页工具，用来调试和评测九立单证识别的提示词（P1~P4）。可以上传原件、跑模型、看结果表格、标注错在哪、对比两次运行、导出上下文给 AI 修提示词。

## 1. 技术栈

- Next.js 16.3.5（App Router，开发用 `next dev --webpack`，端口 3000）；React 19.2.0；TypeScript 5.9.3
- Tailwind CSS 4.3.3；zustand 5（前端状态）；@xyflow/react（关系图）；react-markdown
- zod 4、ajv 8（JSON Schema 校验）；diff；fflate（导出 ZIP）
- xlsx 0.20.3（读 Excel，从 SheetJS 官方 CDN 安装，不是 npm 源）
- @modelcontextprotocol/sdk 1.30.1（只读 MCP 服务，给 Codex / Claude Code 读运行证据）
- SQLite：用 Node 自带的 `node:sqlite`（`DatabaseSync`，见 `lib/repositories/db.ts`），默认文件 `data/studio.db`，不装数据库软件
- 测试：Vitest 3.2.4（单元测试）；Playwright 1.56.1（e2e，端口 3100）
- 包管理：pnpm 10.13.1

## 2. 关键约定

- 界面规矩见项目根目录 `CLAUDE.md`。写 Next 相关代码前先读 `node_modules/next/dist/docs/`（见 `AGENTS.md`），这个版本的 API 和旧版不同。
- 视觉风格（2026-11-13 按用户给的 Hearth 参考图定）：中性灰底 + 白卡片，选中项黑底白字，全站等宽字体（Geist Mono + 苹方）；颜色只改 `app/globals.css` 的 `@theme`。分段页签统一用 `components/ui.tsx` 的 `SEG_TRACK` / `segItem`。
- 界面只显示中文。英文原值（枚举、错误码）放进悬停提示（`title`）。
- 状态值的中文映射只有一份：`lib/adapters/helpers.ts` 的 `STATE_LABEL`。改映射只改这一处。
- 以下数据只能新增，不能修改或覆盖：模型原始输出、Run、提示词版本、数据集版本、外发确认记录。修改要新建一条。
- 密钥只进不出：密钥不返回浏览器，响应里只给末 4 位；日志里不写密钥。
- 改设置类接口（`POST` / `PUT` / `DELETE`）必须先过 `lib/api/origin.ts` 的来源校验，只允许本机页面调用。
- 人工标注里，字段的「对 / 错 / 不确定」用 `assessment`；问题的「属实 / 误报」用独立的 `issue_type`。问题标注不参与评判，也不计入标准答案。
- 产品定位：任意场景的提示词测试，区别于其他 playground 的是输出能渲染成业务期望的版式。通用提示词用「版式」（`lib/layouts/`，规范见 `docs/版式规范.md`）：只含 JSON Pointer 路径和显示名，不含代码；按提示词保存、只追加；显示时即时计算，对不上退回 JSON 树。AI 生成版式只返回不保存，要用户确认后才存。
- 提交信息用中文，前缀用 `feat:` / `fix:` / `docs:` / `refactor:`。不主动 push。
- `.env.local` 里有真实密钥，禁止读取。需要知道配置项时看 `docs/使用说明.md`。

## 3. 怎么验证

- 单元测试：`pnpm test`
- 类型检查：`pnpm exec tsc --noEmit`（`pnpm typecheck` 会先生成类型再检查，同样可用）
- 界面验收：`pnpm e2e`（会先 `next build`，使用独立的 `data/e2e.db`；每次启动前清空）。3100 端口被占用时：`E2E_PORT=3110 pnpm e2e`
- 看界面：`pnpm dev` 后打开 `http://127.0.0.1:3000`。前端改动要实际打开页面看，不能只靠测试

## 4. 踩坑记录

- **清测试库写错了位置。** 现象：e2e 启动时测试库没被清空。原因：Playwright 的 `globalSetup` 在 `webServer` 启动之后才执行，清库太晚。做法：清库命令写在 `playwright.config.ts` 的 `webServer.command` 里（当前就是这样）。
- **e2e 假设库里有很多历史记录。** 现象：清空测试库后，几个用例失败。原因：用例依赖旧库里的记录数量。做法：e2e 不假设历史数量。勾选运行历史前，先等最新一行出现，否则列表刷新后会两次勾到同一行。
- **3100 端口被占用。** 现象：`pnpm e2e` 启动失败。原因：本机其他项目占用了 3100。做法：用 `E2E_PORT` 换端口（如 `E2E_PORT=3110 pnpm e2e`），不要去停别人的服务。
- **e2e 全部失败，报 `Executable doesn't exist ... headless_shell`。** 现象：2026-11-13 跑 `pnpm e2e`，90 个用例全挂。原因：本机 Playwright 测试浏览器缓存被清掉了，不是代码问题。做法：`pnpm exec playwright install chromium` 后重跑。
- **e2e 里清 `localStorage` 没生效。** 现象：`page.evaluate(() => localStorage.clear())` 后 `reload`，页面仍记得之前选的输入。原因：页面的定时刷新会改状态，状态变化时会自动写回 `localStorage`，在重新加载前又写了一遍。做法：用 `page.addInitScript` 在页面脚本运行前清，并用 `sessionStorage` 标记只清一次（见 `e2e/v1.3.spec.ts`「打开历史运行」用例）。
- **多个 AI 并行改代码。** 现象：端口和 `.next` 目录互相冲突，改动互相覆盖。做法：按文件划分归属；不让它们各自跑 e2e 或 build（会抢端口和 `.next`）；不让它们提交，由协调者统一跑和提交。
- **导出的 ZIP 中文文件名乱码。** 现象：macOS 自带的 `unzip` 解压后文件名乱码。原因：它不认 UTF-8 文件名。做法：ZIP 内路径用英文，原件中文名写在 `context.md` 里。
- **脚本里的多个参数没拆开。** 现象：变量里的多个参数被当成一个。原因：zsh 不会像 bash 那样自动拆开变量。做法：脚本里传多个参数要用数组。
- **弹窗覆盖用户输入。** 现象：设置弹窗里，用户刚填的内容被晚到的当前值覆盖。原因：弹窗先显示空表单，再异步读取当前值。做法：读取完成前禁用输入框。
- **「只读安全」单测拦住了新的写文件。** 现象：`tests/unit/acceptance.test.ts` 的「只读安全」用例失败。原因：`lib/` 下禁止随便写文件，这是为了保护九立原件。做法：确实要写文件的模块，加进该测试的白名单，并写清楚理由。不要为了过测试删掉检查。
- **`pnpm dev --webpack` 下服务偶发卡死。** 现象：2026-11-12 走查时出现过一次，开发服务器 CPU 一直 100%，所有接口无响应（页面点「打开最近一次运行」没反应）。原因：没查明，之后在同一份代码上重启再试没有复现；默认的 Turbopack 开发模式和生产构建都正常。做法：遇到就重启 `pnpm dev`；反复出现就去掉 `package.json` 里的 `--webpack` 对比。
- **二阶段 demo 的 v15 提示词在 Studio 里只显示 JSON 树。** 现象：2026-11-16 导入 P1/P2 v5.3、P3 v1.0、P4 最终版（报告见 `docs/v5.3提示词真实材料测试_2026-11-16.md`）后，结果页提示「不符合九立预设结构」。原因：输出没有 `schema_version`，注册表只认 `jiuli-ai-v2/v3`，状态是 `UNKNOWN_SCHEMA`，不算失败。做法：要看业务表格，需在 `lib/schemas/registry.ts`、`lib/adapters/registry.ts`、`renderers/` 新增 v15 支持。
- **Studio 给模型的输入和二阶段 demo 不一样。** 现象：同一提示词在 Studio 和 demo 里结果可能不同。原因有三：
  - Excel 写法不同：Studio 是行号、列号数字加 `merged` 数组；demo 是 `cell:Sheet1:A1 = 文字` 加 `spreadsheet_merges`。
  - Studio 没有 demo 在提示词后追加的技术附录。
  - Studio 不传 `enable_thinking`。

  做法：比较结果时先排除这些差异。
- **P3/P4 不能直接用原件跑。** 原因：`buildFromUpload` 只能构造 P1/P2 的输入。做法：用 P1/P2 的输出拼 JSON，通过 `POST /api/snapshots/import`（`promptKind` + `requestText`）导入后再运行。P1 上传时至少要有一份材料类型是 `ORDER`，只有发票、箱单的批次跑不了 P1。
- **真实运行前要先确认外发。** 现象：`POST /api/runs` 返回 409 `EGRESS_NOT_CONFIRMED`。做法：先 `POST /api/egress`，并带本机 Origin。jiuli 项目对 `dashscope.aliyuncs.com` 已于 2026-11-16 确认。

## 5. 待办与已知限制

（详细说明见 `docs/audit/v1.3-gap-matrix.md` 第 18 节）

- 网页一键启动 Agent（§9）：用户决定不做。
- 窄屏（小于 1280px）三种工作模式都能用；窄屏的「提示词调试」里编辑区和结果区改成页签切换。业务表格在窄屏横向滚动，侧栏占 244px，需要更宽的结果区时可折叠侧栏。
- 版本对比还缺业务视图并排、同步滚动（UX-03）。
- 业务待决的 4 项（见 `docs/audit/v1.3-gap-matrix.md` 第 6 节「需要业务负责人拍板」）。
- `/api/*` 除模型设置和外发确认外仍无鉴权，目前靠只监听本机来保护。
