# dsh-stellaris-player

让 DSH 真正会「玩」群星的插件：读状态 → 想 → 下命令 → 回读，并且以 `dsh-stellaris-ai` 里设置的人格说话。

## 它做什么

**5 个工具**（在任意会话里都能调用）：

| 工具 | 作用 |
| --- | --- |
| `stellaris_state` | 读当前存档：日期/暂停、资源、殖民地、舰队、科研槽、外交数量；`deep=true` 带星球明细 |
| `stellaris_actions` | 列 92 条操控命令及参数（可按 unit 过滤） |
| `stellaris_act` | 下发一条命令并回读校验（`method` + `params`） |
| `stellaris_status` | 看链接器/桥是否连上、桥类型、游戏状态 |
| `stellaris_persona` | 读当前「群星 AI」人格（10 个倾向 + 人格文本） |

**system prompt 注入**：每个会话都会多一段「你正在玩《群星》」的说明——
包括玩法循环（先读、再想、再下令、再回读）、硬规则（不背 JSON、失败不原样重试、暂停不擅自动），
以及从 `dsh-stellaris-ai` 取来的当前人格（名字/头衔/10 个倾向/说话方式）。
人格改了不用重启，下一轮提示词自动用新的。

## 依赖

- 本机运行「群星链接器」（`群星链接器.exe` 或 `node bin/connector.mjs serve`），默认地址 `http://127.0.0.1:8790`；
  可用环境变量 `STELLARIS_CONNECTOR_URL` 覆盖。
- `dsh-stellaris-ai` 插件（人格设置）；没装也能用，只是用中性参谋口吻。

## 调用示例（模型侧）

```
stellaris_state {}
stellaris_actions { unit: "research" }
stellaris_act { method: "select_research", params: { slot: "physics", tech: "蓝激光" } }
stellaris_state {}
```

## 安装

把本目录 link 进 DSH profile 的 `node_modules`，并在 `package.json` 的 `dsh.profile.bundles` 里加上
`dsh-stellaris-player`，重启 DSH（或等 cordis 热加载）。
