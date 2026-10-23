# dsh-codex-runs

一个自包含的 DSH Web 插件：把 **Codex CLI 自己的 rollout 会话文件**渲染成右上角的只读运行记录面板。

- 数据源：`~/.codex/sessions/<YYYY>/<MM>/<DD>/rollout-<时间>-<sessionUuid>.jsonl`
- 只读路由：`GET /api/codex-runs`
- 不改任何 Codex 文件、不写状态文件、不依赖任何第三方补丁

## 安装

```bash
dsh plugin --profile web add /path/to/dsh-codex-runs
# 确认 profile 的 dsh.profile.bundles 里出现 "dsh-codex-runs"，然后重启 dsh web
```

## 面板

标题 `Codex 运行记录 (N)`，右上角固定，10s 轮询，折叠状态存
`localStorage["dsh-codex-runs:open"]`。

每行：`HH:MM · <cwd basename> · ●done / ◐running / ✕aborted / ?unknown · 耗时`

展开后：`sessionId`（可复制）、`model`、`cwd` 全路径、`totalTokens`、`lastMessage` 全文。

## 数据是怎么读的

一个 rollout 文件就是一个 run。为了一次读多份又不把多 MB 的文件整个拉进内存：

| 读取 | 大小 | 用途 |
|---|---|---|
| head | 4 KB，按行边界自动增长到能读完 `session_meta`（实测该行约 22 KB），必要时向前探测，上限 256 KB | `sessionId` / `cwd` / 起始时间（`session_meta`）、`model`（`turn_context`） |
| tail | 64 KB | `task_started` / `task_complete` / `turn_aborted`、累计 token（`info.total_token_usage.total_tokens`）、最后一条 assistant 消息 |

只扫描 mtime 在最近 **7 天**内的文件，最多 **200** 个；返回按 `startedAt` 倒序的 **50** 条。
解析结果按 `(path, size, mtimeMs)` 缓存，所以 10s 一次的轮询只在文件真的变长时才重读。

`status` 判定：最后一个事件是 `task_complete` → `done`；`turn_aborted` → `aborted`；只有
`task_started` 时，文件仍在新写入（5 分钟内）→ `running`，否则 `aborted`；读到的窗口里没有任何
回合事件 → `unknown`。

`durationMs = endedAt - startedAt`（整段会话跨度，包含多轮之间的空闲时间）；`running` 时由前端用
当前时间算实时耗时。

## 路由响应

```json
{ "ok": true, "runs": [{ "id": "…", "cwd": "…", "model": "gpt-6.1-sol", "startedAt": "…",
  "endedAt": "…", "status": "done", "durationMs": 5480, "lastMessage": "…",
  "totalTokens": 21413, "rolloutPath": "…" }], "rootMissing": false,
  "scannedFiles": 10, "matchedFiles": 10, "generatedAt": "…" }
```

任何异常都返回 `{ "ok": false, "error": { "name", "message", "code"? } }`，日志里只有条数与错误码，
不含 rollout 内容。

信任模型：只接受同源 GET。回环调用（面板自己）直接放行；其它来源必须由宿主的 `connection`
服务放行（Host/Origin 围栏 + 已认证的浏览器会话），围栏不可用时一律 403。

## License

MIT
