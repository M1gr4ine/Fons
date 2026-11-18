# Fons · 思如泉涌

为 AI 编码 Agent 提供**“旁路灵感蓄水池 + 消抖合并 + 延迟确认注入 + 收尾兜底”**的 Antigravity 原生插件，解决编码中途高频涌现想法时直接插话打断模型跨文件修改心流、引发近因注意力劫持（Recency Bias）的问题。

## 核心工作流与分流原则

| 场景 | 操作通道 | 原因 |
| :--- | :--- | :--- |
| **非紧急补充 / 顺手灵感** | 分屏编辑 `.agents/fons/ideas.md` 或使用 `fons "<内容>"` | 走消抖合并 + `systemMessage` 延迟确认注入，不打断当前跨文件修改与验证闭环 |
| **紧急方向纠偏 / 叫停** | 直接在原生主聊天框发送消息或点击停止 | 立即干预模型执行方向 |

### 旁路文件语法（`.agents/fons/ideas.md`）

每行一条灵感，支持纯文本或 Markdown 待办：

```markdown
# 本轮补充灵感
导出接口补充 created_at 字段
- [ ] 增加导出权限校验
- [x] 已完成并由模型自动勾选的条目
```

- 空行与 `#` 开头标题/注释行自动忽略。
- `- [x]` / `- [X]` 开头行视为已完成，直接跳过。
- Hook **只读** `ideas.md`，并将投递账本写入 `.agents/fons/.state.json`，避免分屏编辑时触发“磁盘文件已被外部修改”冲突弹窗；仅在模型实际消化处理完毕后由模型将其勾选为 `- [x]`。

### CLI 工具（`bin/fons.cmd` / `bin/fons`）

可将 `bin/` 加入 `PATH`，或在仓库根目录直接运行：

- `bin\fons.cmd "导出接口补充 created_at 字段"`：向当前工作区 `.agents/fons/ideas.md` 追加一条 `- [ ] ...`
- `bin\fons.cmd list`：查看当前未处理条目
- `bin\fons.cmd archive`：将已标 `- [x]` 的条目归档至 `.agents/fons/archive.md`（若原文件仅剩空白则置为 0 字节，恢复空箱短路性能）

> 支持从工作区任意子目录调用，自动向上查找包含 `.agents` 或 `.git` 的工作区根目录；也可通过 `FONS_ROOT` 显式指定目标工作区路径。

---

## 安装与挂载

### 方式一：挂载到目标项目 `.agents/plugins/fons`（推荐，享 `<5ms` 空箱短路）

Windows PowerShell（目录联接无需管理员权限）：

```powershell
New-Item -ItemType Directory -Force .agents\plugins | Out-Null
cmd /c mklink /J .agents\plugins\fons E:\Fons
```

macOS / Linux：

```sh
mkdir -p .agents/plugins
ln -s /path/to/fons .agents/plugins/fons
```

### 方式二：通过 `.agents/plugins.json` 引用外部路径

在目标项目的 `.agents/plugins.json` 中引用 `Fons` 仓库的父目录（Antigravity 按一层子目录扫描插件）：

```json
{
  "entries": [
    {
      "path": "E:/",
      "include_only": ["Fons"]
    }
  ]
}
```

### Unix / macOS 环境额外说明

仓库默认 `hooks.json` 使用 Windows 入口 `scripts\run-hook.cmd`。在 Unix / macOS 上使用时：

1. 授予脚本执行权限：`chmod +x scripts/run-hook.sh bin/fons`
2. 将 `hooks.json` 中的 `command` 改为 `./scripts/run-hook.sh PreInvocation` 与 `./scripts/run-hook.sh Stop`。

---

## 环境变量

| 变量名 | 默认值 | 说明 |
| :--- | :--- | :--- |
| `FONS_DEBOUNCE_SEC` | `60` | 消抖窗口秒数。`ideas.md` 在此窗口内有保存动作时不触发 `PreInvocation` 注入；设为 `0` 时跳过时间差判定立即投递（仍受 `conversationId` 幂等账本保护，同一条目不重复注入）。 |

---

## 单元测试

运行基于 Node 内置 `node:test` 的单元测试（无需额外安装依赖）：

```sh
node --test test/fons-hook.test.mjs
```

---

## A/B 实测验收参考

在真实编码项目中选取两道复杂度对等的中等任务（涉及 3~4 个文件改动 + 1 次编译/单测验证，耗时约 4~6 分钟），均在启动后 1~2 分钟内陆续产生 3 条补充灵感（其中第 2 条微调第 1 条细节）：

- **A 组（原生直接插话）**：每次想到立即在主聊天框发送。
- **B 组（Fons 收件箱）**：分屏在 `.agents/fons/ideas.md` 写入并微调，不碰主聊天框。

| 验收维度 | 观测指标 | 通过标准 |
| :--- | :--- | :--- |
| **原计划完整性** | 初始任务的改动点、校验与测试是否遗漏 | B 组 `0` 遗漏 |
| **切入时机自治** | `transcript` 中 `[FONS]` 注入后，模型是否先把手头未改完的文件闭环再处理补充项 | 不出现半截抛弃正在修改的文件 |
| **返工次数** | 同一文件推翻前序改动的重复编辑次数 | B 组废修改少于 A 组 |
| **消化与防循环** | 3 条灵感是否全部实现并标为 `- [x]`，`Stop` 是否正常终止 | 100% 消化且无循环卡死 |
| **空箱性能** | 无积压灵感时的日常对话工具调用延迟 | `<5ms`，无体感卡顿 |
