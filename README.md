# dsh-global-rules

DSH 插件：维护一份「全局规则」，并把它注入**每一次**请求的系统提示，让 Agent 在回答前必须逐条核对。

A DSH plugin that keeps one user-owned rule list and injects it into **every** request's system prompt, so the agent has to walk the rules before answering.

## 它做什么

| 能力 | 位置 |
|---|---|
| 可视化编辑规则 | 设置（Settings）→ **全局规则**（顺序 55，在「背景图片」之前） |
| Agent 读写规则 | `global_rules` 工具 |
| 命令行快速改 | `/rules` 命令 |
| 注入系统提示 | 每一步请求都会重新装配；第 100 位（部署人设之后、工具说明之前） |
| 存储 | `$DSH_HOME/dsh-global-rules/rules.json` |

三条入口改的是同一份数据，不会出现「设置页改了但工具读到的还是旧的」。

## 注入的是什么

只要开着开关且至少有一条启用的规则，系统提示里就会出现这样一段（`interpolate: false`，规则文本原样进入，不做变量替换）：

```
## 全局规则（每次回答前必须逐条核对）

以下规则由用户维护。在生成任何回答之前，先逐条核对本清单，并确保最终回答完全符合每一条；
若某条规则与本次要求冲突，以规则为准，并在回答中说明冲突。

1. <规则一>
2. <规则二>

（共 N 条启用规则，存储于 …\rules.json；可在「设置 → 全局规则」、global_rules 工具或 /rules 命令中修改。）
核对在内部完成即可：不要在回答里输出规则核对结果、规则编号或规则清单本身。
```

上面最后一行是**默认（静默）**行为：规则照旧逐条核对，但回答里不出现任何核对痕迹。

只有在设置页打开「回答里显示规则检查」后，这一行才会被换成一条输出要求：

```
核对后，在回答的最后另起一行输出一行核对结果，格式：`规则检查：已核对 N 条`；
若某条无法满足，改写这一行说明是哪一条、为什么。
```

关掉总开关、或一条规则都没启用时，这一段整体消失（空 section 会被丢弃），不占用任何 token。

## 设置页

- **启用全局规则**：关掉后规则仍保留，只是不再注入。
- **回答里显示规则检查**：默认关闭；打开后每次回答末尾会附一行核对结果。
- **规则清单**：每条规则可以单独启用/停用、上移/下移、删除，文本支持多行。
- **编辑为文本**：一个 textarea，一行一条；行号与左侧列表一一对应，所以编辑某一行会保留那一行的启用状态。
- **预览**：显示模型实际会收到的完整文本（保存后刷新；有未保存修改时会标注）。

## `/rules` 命令

```
/rules                     查看当前规则
/rules add <文本>          新增一条
/rules remove <序号>       删除第 N 条（序号从 1 开始）
/rules clear yes           清空全部（必须写 yes）
/rules on | off            启用 / 停用注入
/rules check on | off      回答里显示 / 不显示规则检查行
/rules help                用法说明
```

命令结果不进模型历史，也不会触发一轮对话。

## `global_rules` 工具

| action | 参数 | 作用 |
|---|---|---|
| `list` | — | 列出规则与开关状态 |
| `add` | `text` | 追加一条 |
| `update` | `index` 或 `id`，可选 `text` / `ruleEnabled` | 改内容或单条启停 |
| `remove` | `index` 或 `id` | 删除一条 |
| `clear` | — | 清空全部 |
| `replace` | `rules: string[]` | 整份替换 |
| `configure` | `enabled` / `acknowledge` | 总开关与可见检查 |

`index` 从 1 开始。任何改动在下一次模型请求就生效，无需重启。

## 存储格式

`$DSH_HOME/dsh-global-rules/rules.json`（可直接手改；写入是临时文件 + rename 的原子替换）：

```json
{
  "version": 1,
  "enabled": true,
  "acknowledge": false,
  "rules": [
    { "id": "r-1a2b3c4d", "text": "回答只用简体中文。", "enabled": true },
    { "id": "r-5e6f7a8b", "text": "代码块必须标注语言。", "enabled": false }
  ],
  "updatedAt": "2026-01-01T00:00:00.000Z"
}
```

读取是宽容的（某条坏掉只丢那一条），写入是严格的（不会把空规则或超限内容写进去）。每条最多 2000 字，最多 200 条。

## 安装与卸载

插件在 profile 的 bundle 列表里，名为 `dsh-global-rules`。安装/卸载走 Plugin Manager 的 `install_bundle` / `remove_bundle`，不要手改 `cordis.patch.yml`。

从 GitHub 装（本仓库）：

```
https://github.com/IHS470/dsh-global-rules/archive/refs/tags/v1.0.0.tar.gz
```

把它交给 Plugin Manager，或在 profile 里 `pnpm add <上面的 URL> --dir <profile>`，然后把 `dsh-global-rules` 加入 `dsh.profile.bundles`。规则数据在 `$DSH_HOME/dsh-global-rules/rules.json`，与安装方式无关，升级插件不会动它。

## 自检

```powershell
node test/host-smoke.mjs
```

在临时 `DSH_HOME` 里跑完整 Host 半个：装配函数、`global_rules` 工具、`/rules` 命令、浏览器半用的 HTTP 路由、以及请求围栏（跨站 / 非回环 Host / 外来 Origin 一律拒绝）。不会碰真实规则文件。

## 与其他「全局指令」机制的关系

- `@deepseek-ai/dsh-agent-instructions`（`$DSH_HOME/AGENTS.md`）走的是「首轮把指令作为一条消息写进历史」，且在当前 profile 里是关闭的。本插件与它独立：规则每次都出现在**系统提示**里，压缩/裁剪上下文也不会丢。
- 本插件不写入会话日志，不改任何已有事件类型；它只贡献一个 prompt section、一个工具、一个命令和一条自己的 HTTP 路由。

## 边界

- 规则清单不进入会话日志，所以历史会话回放时不会带上「当时的规则」——它是部署级配置，不是对话内容。
- 没有浏览器端控制时无法截图证明外观；设置页的正确性靠 slot 注册（Client `Slots`）与 Host 半个的 smoke test 保证。
- **规则保证「送达」，不保证「遵从」。** 每条规则都会出现在每一步请求的系统提示里，但模型是否照做由模型决定，插件无法强制。

### 实测：「思考用中文」这类规则为什么要换新会话

推理（reasoning / 思考）通道对系统提示中段的用户规则遵从度明显低于回答本身，而且**会话惯性很强**：同一个会话里已经积累的推理语言会把后续推理继续往同一方向带。本机实测（会话日志里持久化的 `reasoning` 块）：

| 阶段 | 推理块 | 中文占比 |
|---|---|---|
| 规则加入前（同一会话已有 66 块英文推理） | 66 | 7% |
| 规则加入后、同一会话继续 | 9 | 16% |
| 换成新会话后 | — | 明显转为中文 |

所以控制**推理语言**时：改规则措辞只能小幅改善；**开新会话**（惯性归零）才是主要杠杆。已生成的推理是持久内容，任何规则改动都不会回溯改写它。提问时再带一句「用中文思考」效果最直接，因为用户消息紧贴生成点。

若新会话里仍不稳定，可再考虑两条更强的通道：把规则摘要作为**每一步请求末尾的 runtime context** 注入（`systemPrompt.context()`，紧贴生成点），或把指令写进 profile 的 `system-prompt.personaPrefix`（系统提示第 0 位，人设层）。两者都需要改 Host 代码并重启 DSH。
