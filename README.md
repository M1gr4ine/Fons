<p align="center">
  <img src="assets/logo.svg" width="96" height="96" alt="Fons · 思如泉涌">
</p>

# Fons · 思如泉涌

Fons 为 Antigravity 提供按会话隔离的灵感蓄水池。非紧急补充先记入收件箱，每条灵感独立蓄水消抖，到期后在下一次模型调用时合并投递；紧急纠偏或叫停仍直接使用聊天框或停止按钮。

## <img src="assets/sidebar-icon.svg" width="20" height="20" align="absmiddle" alt=""> 使用灵感池

在会话右侧点击 **+ → Extensions → 灵感池**，面板自动绑定当前会话。No Project 会话只显示打开项目的提示；在已挂载 Fons 的项目会话中可以录入。底部速记行按 Enter 添加，粘贴多行时按非空行拆分；中文输入法选词时不会提交。

条目分为待投递、已投递和已完成：
- **待投递**：每条各自独立 `45s` 蓄水涨水位（顶栏可在「`↑ 水位` 自下而上」与「`→ 水位` 自左向右」之间切换），点进某条二次编辑时仅暂缓该条自身的计时，不影响其他已蓄满条目按时投递；修改保存后该条重新蓄水。
- **已投递与已完成**：文本锁定只读不可直接改写。「归档」收拢并整理已完成条目。删除已投递条目时会先确认，下一次模型调用将收到一次撤回通知。即使删除的是最后一条，待发通知也会保留到送达。撤回后再写入相同文字会重新投递。如果同一次调用包含两条消息，模型先读到撤回，再读到标有“重新添加”的新条目；旧的确认编号随上一轮投递失效。

模型有写权限时，根据注入消息里的本会话收件箱绝对路径，用 `edit_file` 只修改对应行的前缀。只读 Plan 模式的纯问答可在回复末行使用 `[FONS_ACK: 编号]` 确认实际回答的条目，不必为勾选退出只读模式。

### 工作区文件

每个会话使用 UUID 作为文件名的一部分，首次添加灵感时创建收件箱。

```text
<workspace>/.agents/fons/
├── ideas-<conversationId>.md       本会话收件箱
├── .state-<conversationId>.json    Hook 的投递和确认账本
├── .ui-<conversationId>.json       面板和 CLI 的操作记录
└── archive/
    └── <conversationId>.md         本会话归档
```

收件箱也可在编辑器中直接打开，每行一条。空行和 `#` 开头的标题或注释会被忽略。

```markdown
# 本轮补充灵感
导出接口补充 created_at 字段
- [ ] 增加导出权限校验
【√】 已完成的条目
```

完成条目的标准前缀是 `【√】 `，也兼容 `- [√]`、`[√]`、`✓`、`- [x]` 和 `- [X]`。面板和 CLI 使用追加回执或受检查的行编辑，保留其他条目。

## 安装与挂载

推荐将 Hook 挂在目标工作区，并将纯 UI 面板包 `ui-plugin` 挂到全局 `plugins` 目录（这样侧边栏标签页会自动显示专属水珠图标，且不含全局 Hook，不会污染其他项目）。将示例中的 `F:\Fons` 换成实际仓库路径，在目标工作区运行以下 PowerShell 命令：

```powershell
New-Item -ItemType Directory -Force .agents\plugins | Out-Null
cmd /c mklink /J .agents\plugins\fons F:\Fons

# 若此前挂载过旧的独立 sidecars\fons-pool，请先移除避免菜单重复
$oldSidecar = Join-Path $env:USERPROFILE '.gemini\config\sidecars\fons-pool'
if (Test-Path -LiteralPath $oldSidecar) { cmd /c rmdir "$oldSidecar" }

$pluginsDir = Join-Path $env:USERPROFILE '.gemini\config\plugins'
New-Item -ItemType Directory -Force $pluginsDir | Out-Null
cmd /c mklink /J "$pluginsDir\fons-pool" "F:\Fons\ui-plugin"
```

挂载后可在 Antigravity 的 Customizations 页面确认「灵感池」已启用，并从会话右侧 **+ → Extensions → 灵感池** 打开面板（侧边栏标签将显示专属图标）。

不要把仓库根目录 `F:\Fons` 直接联接到 `~/.gemini/config/plugins/fons`。根目录包含 `hooks.json`，全局挂载会使 Hook 在所有工作区生效并可能与工作区挂载重复执行；而 `ui-plugin` 仅包含面板与图标配置。工作区联接方式支持空箱时的启动脚本短路。

也可在目标项目 `.agents/plugins.json` 中引用仓库的父目录，Antigravity 会按一层子目录扫描。此方式不满足工作区联接的短路前提。

```json
{
  "entries": [
    {
      "path": "F:/",
      "include_only": ["Fons"]
    }
  ]
}
```

仓库的 `hooks.json` 默认使用 Windows 入口。Unix / macOS 需要赋予 `scripts/run-hook.sh` 和 `bin/fons` 执行权限，并将三个事件的命令改为对应的 `./scripts/run-hook.sh SessionStart`、`./scripts/run-hook.sh PreInvocation` 和 `./scripts/run-hook.sh Stop`。

### Hook 事件

- `SessionStart` 登记本会话与工作区的对应关系，空箱时也登记。宿主明确报告工作区列表为空时，Hook 跳过登记和投递。
- `PreInvocation` 在首次需要时补登记旧会话，消抖后投递当前会话的未处理条目，并发送待发撤回。
- `Stop` 核对本会话尚未确认的条目，最多续跑两次。

没有非空收件箱或待发撤回时，工作区启动脚本会短路。索引保存在宿主数据目录下的 `fons/conversations/<conversationId>.json`，供面板和 CLI 找到对应工作区。

升级前已打开且尚未登记的会话，如果整个工作区都是空箱，单独发送聊天消息仍会走短路。可以新开会话立即登记，也可以在编辑器里创建本会话的 `ideas-<conversationId>.md`、写入第一条灵感，再发消息触发补登记。

## CLI

可将 `bin/` 加入 `PATH`，也可直接使用 `bin\fons.cmd`。在目标工作区运行，或从其子目录运行。

```powershell
fons "导出接口补充 created_at 字段"
fons list
fons done $token1
fons done $token1 $token2
fons archive
fons -s $sessionId list
fons --session $sessionId "另一条灵感"
```

示例中的 `$token1`、`$token2` 和 `$sessionId` 请替换为实际令牌与会话 UUID。`list` 显示未完成条目和确认令牌，`done` 整批检查所给令牌后追加回执。若条目或它之前的内容已变化，旧令牌可能失效，可重新运行 `list` 获取。`archive` 将已完成条目移入本会话归档；操作期间请保存并暂停编辑收件箱。

没有显式会话 ID 时，CLI 向上寻找包含 `.agents` 或 `.git` 的工作区，并在索引中查找对应会话。恰好一个时自动选择，多个时列出 ID、标题和登记时间并要求使用 `-s`，没有时提示先在 Antigravity 中开启会话。`FONS_ROOT` 可覆盖用于查找候选的工作区。`-s`、`--session` 或 `FONS_SESSION` 指定的会话必须已登记，显式参数优先于环境变量；实际读写路径始终来自该会话的索引。

| 环境变量 | 默认值 | 用途 |
| --- | --- | --- |
| `FONS_DEBOUNCE_SEC` | `45` | 每条待投递灵感的独立蓄水秒数，`0` 表示不等待 |
| `FONS_SESSION` | 未设置 | 指定已登记的会话 UUID |
| `FONS_ROOT` | 从当前目录向上查找 | 未指定会话时用于查找工作区候选 |
| `FONS_APP_DATA` | `~/.gemini/antigravity` | CLI 使用的宿主数据目录，索引位于其 `fons/conversations` 下 |

每条待投递灵感各自独立计时，新增条目不会刷新先前草稿的进度；在面板中点进某条待投递灵感二次编辑时，仅暂缓该条自身计时，改写保存后该条重新计时。已投递和已完成条目不可直接编辑文本。

## 旧数据迁移

Hook 检测到旧的 `.agents/fons/ideas.md` 时，会将已投递条目和账本按会话拆分；从未投递的条目归入首先触发迁移的会话。旧 `archive.md` 留在 `archive/legacy.md`，旧 `.state.json` 留在 `.state.legacy.json`。若目标会话已有冲突数据，迁移会保留旧数据并停止，需先处理冲突。

只有 Hook 执行迁移。CLI 遇到旧箱会提示在 Antigravity 中触发 Hook。迁移锁残留时，面板和 CLI 会提示；各会话自己的新收件箱仍可使用，旧箱留待恢复。

### 中断后的手动恢复

迁移会创建 `.agents/fons/.migration.lock`。正常完成或成功回滚后锁会移除；进程中断或回滚失败时会保留现场。先停止涉及该工作区的 Hook、面板、CLI 和编辑器写入，保持现场不变。确认迁移进程已结束后，再备份并核对。不要仅凭 PID 判断锁已失效，PID 可能被系统复用；无法确认时保留锁并继续核查。

以下命令在目标工作区的 PowerShell 中只读取锁记录和进程信息。

```powershell
$fonsDir = Join-Path (Get-Location).Path '.agents\fons'
$lockDir = Join-Path $fonsDir '.migration.lock'
$ownerPath = Join-Path $lockDir 'owner.json'
$migrationOwner = Get-Content -LiteralPath $ownerPath -Raw | ConvertFrom-Json
$migrationOwner | Format-List pid, startedAt, step, source, targets
[DateTimeOffset]::FromUnixTimeMilliseconds([long]$migrationOwner.startedAt).ToLocalTime()
Get-Process -Id ([int]$migrationOwner.pid) -ErrorAction SilentlyContinue |
  Select-Object Id, ProcessName, StartTime
```

`startedAt` 是 Unix 毫秒时间戳，`source` 和 `targets` 中的路径相对于 `.agents/fons`。强杀还可能留下锁目录中的 `state-staging.json` 或其 `.tmp-*` 文件；应连同锁一起备份，不要用暂存文件覆盖会话账本。如果 `owner.json` 缺失或损坏，保留整个现场，人工检查旧箱、账本、归档和各会话文件，不要自动清锁或覆盖文件。

确认已停写后，将整个 `.agents/fons` 复制到该目录之外的新备份目录，并核对备份完整。下面的示例创建一个独立目录，不覆盖原文件。

```powershell
$backupBase = Join-Path $env:USERPROFILE ("Documents\Fons-recovery-" + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $backupBase | Out-Null
Copy-Item -LiteralPath $fonsDir -Destination $backupBase -Recurse -Force
```

检查 `source` 列出的旧箱 `ideas`、被认领的 `claimed`、旧账本 `state` 和旧归档 `archive`，以及对应的 `stateBackup` 和 `archiveBackup`。核对每个路径是否存在和内容是否一致。源与备份可能同时存在，不能只按文件名猜测归属。

对 `targets` 中每个已存在的 `ideas` 和 `state` 文件，分别计算 SHA-256 并与同一项的 `ideasHash`、`stateHash` 比较。以下命令只读取，不会移动文件。

```powershell
foreach ($target in $migrationOwner.targets) {
  foreach ($kind in @('ideas', 'state')) {
    $relativePath = $target.$kind
    $expectedHash = $target.($kind + 'Hash')
    $targetPath = Join-Path $fonsDir $relativePath
    $actualHash = if (Test-Path -LiteralPath $targetPath -PathType Leaf) {
      (Get-FileHash -LiteralPath $targetPath -Algorithm SHA256).Hash
    } else { $null }
    [pscustomobject]@{
      Path = $relativePath
      Expected = $expectedHash
      Actual = $actualHash
      Matches = $null -ne $actualHash -and $actualHash -eq $expectedHash
    }
  }
}
```

`step` 记录下一步或正在进行的步骤，文件可能已完成，也可能尚未出现。

| 步骤 | 核对重点 |
| --- | --- |
| `claiming`、`planning` | 旧箱可能仍在原处，也可能已成为 `claimed`；发布清单可能尚为空 |
| `publishing` | 只有部分目标可能已发布，逐项核对清单和哈希 |
| `moving-archive`、`moving-state` | 旧源和对应 legacy 副本可能同时存在，逐对核对 |
| `finalizing` | 目标可能已全部发布，旧箱可能已移除；确认全部结果后可保留完成结果 |
| `rollback-failed` | 可能已有部分回滚，结合所有源和目标的实际内容判断 |

若准备恢复旧箱后重试，只有在确认文件属于本次迁移且哈希与清单完全一致时，才将已发布目标逐个**移动到备份目录中的独立位置**，不要盲删或覆盖备份。哈希不符、来源不明，或迁移后已被新会话修改的文件留在原处，先人工比对并合并；不得丢弃各会话的新数据。

对旧箱、旧账本和旧归档，只有原路径不存在时才从确认对应的 `claimed` 或 legacy 副本复制回原路径；原路径已存在时先比对，内容不同则保留两份并人工合并。若确认 legacy 副本是本次部分迁移产生的，在恢复原文件并核对后，把该副本移入备份的独立位置，避免重试时目标名冲突。恢复并核对旧箱后，也将对应的 `claimed` 副本移入备份的独立位置。保留原有的其他归档及所有未列入迁移清单的会话文件。

确认全部数据已保全、冲突已解决后，将 `.migration.lock` 整个移入备份目录，随后在 Antigravity 中触发 Hook 重试。若已核实 `finalizing` 的迁移结果完整，可保留结果并移走锁，无需再次导入旧箱；不要同时保留会被再次迁移的旧 `ideas.md`。有任何归属或内容无法确定时保留现场，先完成核对。

## 已知限制

1. 消抖到期只在下一次模型调用时生效，空闲会话不会被唤醒；本轮收尾（`Stop`）会自动兜底未处于编辑暂缓中的待投递条目。
2. 行编辑的最后一次比较和写入之间仍有很短的并发窗口；面板与 CLI 同时写 `.ui` 时，最坏可能丢失一次暂缓续期或取消勾选标记。
3. 在编辑器中直接修改前序行会改变后续行令牌，已追加的回执可能失配，对应条目重新显示为待办。面板和 CLI 的行编辑会折叠回执以规避这一问题。
4. 宿主中删除会话后，相应 `ideas-<id>.md` 不会自动清理，需要手动归档或删除。

## 对比验证

可以在两个复杂度相近的编码任务中比较直接插话与使用灵感池。分别观察原任务是否完整、补充项在何时处理、是否产生返工，以及所有补充得到确认后 `Stop` 是否正常结束。

## 测试

项目使用 Node 内置测试运行器，无需额外安装测试依赖。

```sh
node --test
```
