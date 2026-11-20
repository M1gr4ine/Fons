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

## 2. Codex 适配与多宿主抽象

- **核心层与宿主层解耦**：
  - 保持收件箱解析与状态账本层（`scripts/fons-inbox.mjs`、`scripts/fons-store.mjs`）完全宿主无关；
  - 将 Antigravity 专属的协议字段（`SessionStart` / `PreInvocation` / `Stop` 事件结构、`transcript.jsonl` 解析、`brain` 索引定位）抽离为独立的 `adapters/antigravity.mjs`。
- **Codex 适配层（`adapters/codex.mjs`）**：
  - 对接 Codex 的生命周期钩子 / 会话标识与工作区发现机制，映射待投递注入与收尾核对语义；
  - 为无内置 Sidecar 容器的环境提供轻量本地面板服务或增强 CLI（`fons`）交互，使同一套收件箱格式、单条独立蓄水与撤回机制在 Antigravity 与 Codex 下无缝共用。

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
  - **双包作用域互斥**：全局 `ui-plugin` 新增无工作区专属 Hook（`node scripts/bootstrap-hook.mjs`，强制 `--scope=no-workspace` 并与 Hook 共用宿主目录解析），根目录工作区 Hook 限定 `--scope=workspace`，二者天然互斥、零污染普通项目；
  - **统一落盘与索引**：无工作区会话数据存放在 `<appData>/fons/no-workspace/`（与 `<workspace>/.agents/fons/` 同构），索引增加 `scope: "no-workspace"` 并兼容旧工作区索引；
  - **按需首次极简协议与防串台**：无工作区 `PreInvocation` 仅在同会话首次投递时附带极简 `[FONS_ACK: 编号]` 回执提示，后续投递只留 `[FONS]` 与条目；Sidecar 与面板核对 `workspaceUris` 与会话登记的 `scope`/`rootDir` 一致性（覆盖无工作区与多项目间切换），CLI 新增 `-n` / `--no-workspace` 支持。
