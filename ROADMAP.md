# Fons 后续演进计划（Roadmap）

本文档记录下一阶段规划的重点演进方向，随仓库版本一并维护。

---

## 1. 【已完成】灵感池支持添加附件（截图 / 图片 / 参考文件）

- **交互入口**：
  - 底部速记框与待投递行支持**剪贴板粘贴截图**（`Ctrl+V` 粘贴图片）、**拖拽文件入池**以及轻量附件选择按钮，CLI 同步支持 `-a` / `--attach <文件路径>`；
  - 对齐模型对话框输入体验，图片渲染为可点击灯箱放大的圆角缩略预览图，非图片文件渲染为带后缀徽标与体积信息的文件块，支持草稿区与待投递行内单独移除。
- **落盘与会话隔离**：
  - 附件按会话隔离保存在 `<workspace>/.agents/fons/attachments/<conversationId>/`（无工作区会话同构保存在 `<appData>/fons/no-workspace/attachments/<conversationId>/`），采用 `<safeStem>-<sha256前8位><ext>` 内容哈希命名防冲突并自动去重；
  - `ideas-<conversationId>.md` 中使用对纯文本编辑器友好的标准 Markdown 相对链接关联附件，保持单行一条的可读性，并支持零配文的纯附件入池。
- **投递与清理**：
  - 到期投递时将附件规范化绝对路径随该条灵感一并提供（无工作区会话自动按需镜像至 `artifactDirectoryPath/fons-attachments/`），方便模型按需调用 `read_file` 查看图片或文档；
  - 草稿未入池移除零残留，条目在缓冲期删除或移除单个附件时按会话引用计数自动清理孤立附件，归档时保留附件并将归档链接重写为 `../attachments/<conversationId>/...`（同时归一化完成计数以保持 `deliveryId` 稳定）。

---

## 2. 【已完成】Codex 适配与多宿主抽象

- **核心层与宿主层解耦**：
  - 保持收件箱解析与状态账本层（`scripts/fons-inbox.mjs`、`scripts/fons-store.mjs`）及领域引擎（`scripts/fons-engine.mjs`）完全宿主无关；
  - 将 Antigravity 专属协议抽离为 `adapters/antigravity.mjs`，新增 `adapters/codex.mjs` 与 `adapters/index.mjs`。
- **Codex 适配层与 MCP Apps 面板**：
  - 对接 Codex 的 `SessionStart` / `UserPromptSubmit` / `PostToolUse` / `Stop` 钩子、主线程锚定与工作区/无项目识别，支持 `fons codex init` 一键打包本地插件市场；
  - 提供基于 MCP Apps 的 Codex 原生侧边栏面板（`codex/fons-mcp.mjs`、`codex/fons-mcp-ui.mjs`），与 Antigravity Sidecar 共享同一套收件箱、单条蓄水、附件与撤回体验。

---

## 3. 【已完成】Hook 提示词瘦身：将处理模式收归程序侧

- **现状问题**：
  - 当前 `fons-hook.mjs` 在每次注入与收尾核对时，都会向模型拼入大段模式分支操作说明（如何判断写权限、何时用 `edit_file` 改前缀、何时禁止 `write_file`、只读模式下如何不退出 `exit_plan_mode` 并追加 `[FONS_ACK: ...]`），同时模型为了勾选收件箱还需要额外消耗一次 `edit_file` 工具调用。
- **演进方向（程序接管账本回写，最小化上下文占用）**：
  - **极简注入负载**：注入消息仅保留纯粹的补充事项与短编号（例如 `[FONS] 补充事项：\n1. xxx [id]`），将固定约定收敛到精简静态规则或单行回执协议，不再每轮重复塞入文件编辑指令；
  - **由 Hook 程序统一落盘勾选**：模型无论处于读写模式还是只读 Plan 模式，只需正常完成代码/回答并在末尾输出极短确认标记（或由收尾 Hook 识别已处理信号），由 `Stop` / 后置脚本在宿主外部**直接安全回写** `ideas-<conversationId>.md` 的 `【√】 ` 前缀与账本状态；
  - **收益**：彻底省掉模型侧专门改收件箱文件的工具轮次、避免并发编辑冲突，并大幅压缩每次投递占用的上下文 Token。

---

## 4. 【已完成】支持无工作区会话

- **现状问题**：
  - 原先 Hook 入口（`scripts/fons-hook.mjs`）在会话没有工作区（`workspacePaths` 为空或缺少有效 `rootDir`）时会直接跳过处理，且收件箱与账本文件默认存放在 `<workspace>/.agents/fons/` 下，导致无工作区会话无法登记，Fons 侧栏面板、CLI 与自动投递均无法使用。
- **落地实现**：
  - **双包作用域隔离**：全局 `ui-plugin` 率先引入无工作区专属 Hook（`node scripts/bootstrap-hook.mjs`，强制 `--scope=no-workspace` 并与 Hook 共用宿主目录解析），根目录工作区 Hook 限定 `--scope=workspace`，二者互斥、零污染普通项目（后续在里程碑 6 中升级为可按工作区开关的 `global` 自动接管模式）；
  - **统一落盘与索引**：无工作区会话数据存放在 `<appData>/fons/no-workspace/`（与 `<workspace>/.agents/fons/` 同构），索引增加 `scope: "no-workspace"` 并兼容旧工作区索引；
  - **按需首次极简协议与防串台**：无工作区 `PreInvocation` 仅在同会话首次投递时附带极简 `[FONS_ACK: 编号]` 回执提示，后续投递只留 `[FONS]` 与条目；Sidecar 与面板核对 `workspaceUris` 与会话登记的 `scope`/`rootDir` 一致性（覆盖无工作区与多项目间切换），CLI 新增 `-n` / `--no-workspace` 支持。

---

## 5. 【已完成】Claude Code 适配与原生侧栏面板

> **版本要求**：Hook 最低需要支持 `PostToolBatch` 的 Claude Code 版本；原生侧栏面板依赖插件 UI 模块（`modules`）能力（具体最低版本号待实测确认）。

- **共享基础设施与适配层**：
  - 抽取 `adapters/shared.mjs` 与 `scripts/fons-package.mjs` 消除跨宿主重复，新增 `adapters/claude.mjs` 并注册至 `adapters/index.mjs` 与 `scripts/fons-sessions.mjs`（支持 `--host claude` / `FONS_HOST=claude` / `CLAUDE_CONFIG_DIR` 与唯一活跃会话优先匹配）。
- **生命周期 Hook 与主会话锚定**：
  - 对接 Claude Code 的 `SessionStart`、`UserPromptSubmit`、`PostToolBatch`、`Stop`、`SessionEnd` 五个事件，过滤带 `agent_id` 的子代理调用同时兼容 `claude --agent` 主会话，以 `<session_id>.jsonl`（非 `subagents/`）路径锚点锁定主会话，自动隔离工作区（`.agents/fons/`）与无工作区会话；
  - 注入文案采用事实陈述口吻（回执约定在 `SessionStart` 说明一次），单次 `additionalContext` 上限 `10,000` 字符并将超出条目延后到下一次投递点；
  - `Stop` 仅读取 stdin 中的 `last_assistant_message` 提取 `[FONS_ACK: 编号]` 自动回写 `【√】 `（按 `{ promptId, digest }` 防重），未确认条目通过 `hookSpecificOutput.additionalContext` 按 `prompt_id` 执行每轮最多 2 次兜底续跑（缺少 `prompt_id` 时回退到最近一次持久化的 `prompt_id`）。
- **Claude Code 原生侧栏面板（`claude/pane.mjs` + `claude/pane-bridge.mjs`）**：
  - 通过 `claude/hooks.json` 的 `modules` 加载 `fons-pane.mjs`，并在插件 `userConfig` 中提供「启动时自动打开侧栏」（`openAtStart`，默认 `on`），桌面端自动打开右侧面板，终端内联放置且非手动打开时自动收起；
  - 注册 `immediate` 命令 `/fons`（不打断当前轮次，支持开关侧栏、`open` / `close` / `web` 以及 `/fons <内容>` 快速入池），侧栏内支持输入速记、1 秒实时蓄水进度条、行内编辑暂缓自动续期、完成/删除/撤回/重开/归档、`⚙` 蓄水与工作区设置；侧栏关闭且存在活跃条目时在 `AbovePrompt` 展示精简提示条与「打开侧栏」按钮；
  - `claude/pane-bridge.mjs` 复用 `createBoundPoolRoutes` 读写会话账本，点击「网页版」或 `/fons web` 时按需拉起并复用后台 `fons panel` 回环服务（闲置 15 分钟自动退出）以承接截图粘贴与文件拖拽。
- **本地插件市场与通用回环 Web 面板**：
  - 提供 `fons claude init` 生成本地插件市场（`.claude-plugin/marketplace.json` + exec 形式 `hooks/hooks.json`）并拦截直接配置冲突，不改动用户已有 `settings.json` 与 `CLAUDE.md`（附可选 `claude/CLAUDE.snippet.md`）；
  - 新增 `fons panel`（`scripts/fons-panel.mjs` + `scripts/fons-panel-ui.mjs`），基于 `127.0.0.1` + 32 字节随机令牌、同源校验与 `sessionStorage` 令牌续持复用 `mountPoolRoutes` 与共享前端，支持 `/clear` 后活跃会话自动切换。

---

## 6. 【已完成】全局自动接管与统一可视化设置中心

- **跨宿主统一配置账本（`scripts/fons-config.mjs`）**：
  - 引入 `<appData>/fons/config.json`，集中持久化 `debounceSec`（`0`–`3600` 秒，支持 `0` 秒即时投递）、`stopWaitDebounce`、`autoAttachWorkspaces` 与 `enabledWorkspaces` / `disabledWorkspaces`（路径规范化、子目录前缀匹配且同级停用优先）；
  - Antigravity、Codex 与 Claude Code 三端 Hook 引擎及面板统一读取配置，显式环境变量（`FONS_DEBOUNCE_SEC`、`FONS_STOP_WAIT_DEBOUNCE`）保持最高优先级并在面板设置中给出覆盖提示。
- **Antigravity 全局 `fons-pool` 自动接管**：
  - 将 `ui-plugin` 从无工作区限定升级为 `global` 作用域，一份全局安装即可默认覆盖所有项目工作区与无工作区会话；
  - 空会话零项目文件落盘，`ui-plugin/scripts/bootstrap-hook.mjs` 在空箱时直接短路退出，并自动检测项目已单独挂载的本地插件（`.agents/plugins/fons` 或 `.agents/plugins.json`）主动让位防重。
- **全端可视化设置面板**：
  - 在共享前端（`sidecars/fons-pool/index.html`、`main.mjs` 的 `/api/pool/settings` 接口，覆盖 Antigravity Sidecar / Codex MCP Apps / `fons panel`）与 Claude Code 原生侧栏中内置设置弹窗/视图，收拢水位方向、蓄水时长预设与自定义、收尾等待蓄水满、工作区自动挂载/单独启停以及未登记会话的一键立即登记。

---

## 7. 适配 DSH

- **复用宿主无关核心引擎**：
  - 复用收件箱解析（`scripts/fons-inbox.mjs`）、状态账本（`scripts/fons-store.mjs`）、统一配置（`scripts/fons-config.mjs`）与单条蓄水引擎（`scripts/fons-engine.mjs`），新增 DSH 宿主适配层并接入 `adapters/index.mjs` 与 `scripts/fons-sessions.mjs`。
- **会话隔离与交互入口**：
  - 对接 DSH 的会话生命周期与投递/收尾回执链路，支持工作区与无工作区会话隔离，并打通面板与 `fons` CLI 互通体验。

---

## 8. Claude Code 原生插件界面优化

- **原生侧栏交互与视觉打磨**：
  - 持续优化 `claude/pane.mjs` 原生侧栏的排版布局、操作交互、状态反馈与设置项完整度；
  - 实机核验并标注 `PostToolBatch` 与插件 UI 模块（`modules`）的最低稳定版本。
- **原生附件与多入口体验演进**：
  - 随宿主插件 UI 模块组件能力演进探索更顺滑的原生附件交互，并持续优化与本地回环网页版面板（`fons panel`）的协同切换体验。
