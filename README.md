# DeepSeek 用量行情终端 / DeepSeek usage terminal

A Harness Web UI plugin that renders DeepSeek usage as a trading terminal: a
candlestick chart of spend and tokens per day, with the account balance beside
it. The layout follows the stock-terminal reference: dark board, left
watchlist, central K-line stage with volume, right-side rankings and a live
tape, a model table below, and a status bar.

## Where it appears

- **Workspace strip** (left column, under Plugins / Schedules): a **Usage
  K-line** row with a candle glyph; selecting it shows the terminal.
- **Main column**: the terminal page (see the layout below).
- **Workspace column** (right docked pane): an openable tab type
  `usage-kline`, opened through `ctx.sidebarRightTabs.openTab('usage-kline')`.
- **Composer chip**: recharged balance shown as a green negative (−), the usable
  balance (recharged + granted) as a red positive (+), and today's spend.
  Clicking it opens the workspace tab.

## Terminal layout

| Region | Content |
|---|---|
| Title bar | terminal name, live-sample counter, 7/14/30/60/90-day range, refresh, clock |
| 自选行情 (watchlist) | one row per model: code, name, sparkline, total spend and its day change; below it the 统计 rows for cached / uncached / output tokens and requests, which switch the tape's readout |
| Center stage | the selected model's **日K** candles or today's **分时** calls, selectable by **金额** / **Token**; MA5 overlay, volume histogram, last-price tag, crosshair with price scales |
| 主力动向 (rankings) | models ranked by spend with proportional bars |
| 逐笔成交 (live tape) | the most recent calls, newest first |
| 个股列表 (table) | every model with code, spend, change, requests, tokens, share, and a mini K-line strip of today's calls |
| 本次对话用量 (turns) | turn-by-turn usage of the conversation on screen: turn number, time, tokens, cached hit, input and cost, with a footer total |
| 工作区对话用量排名 (ranking) | every conversation of a picked Workspace (or all of them) ranked by **lifetime** spend: rank, conversation ID, title and Workspace, amount, tokens, requests, share, and a jump button. A row's context menu offers **跳转至该对话**, **删除该对话** and **复制对话 ID**. Delete removes the row for good: the Session is also archived when the client can, and its id is stored in `$DSH_HOME/usage-kline-removed.json` so the checkpoint scan never lists it again |
| 用量对比 (sources) | every usage source this Harness can show, side by side: projection checkpoints, live requests, the page total, the account wallets, and the Platform usage page. Its footer prints the scan diagnostics (checkpoint directory, files found, files readable, or the scan error) |
| Status bar | live samples, sessions, peak/off-peak pricing, data health |

Right-click a conversation row for its menu; a left click also jumps straight
to the conversation when the workspace navigation is available.

## How the numbers are produced

| Piece | Source |
|---|---|
| Per-Session token totals | the `tokenUsage` fold in `session-projection-cache` checkpoints under `$DSH_HOME/storages/session_projcache/sessions`, grouped per model by the Session's newest route |
| Calls made since a Session's last checkpoint | the `llm/stream` waterfall; Search/Fetch through `ctx.web` |
| Prices | official DeepSeek list price per 1M tokens (peak rate); off-peak is half, chosen per call by its time of day |
| Balance | `ctx.deepseekAccount.getBalance` |

### Every viewable usage source

The 用量对比 block compares one range of calls across all six views in one
place; the column pair shows each source's token count and estimate next to the
page total:

1. **投影检查点** (`session-projcache/tokenUsage`) — per-Session cumulative
   totals, model from the Session's newest route. When that directory cannot be
   read, the same totals are read through `sessionQuery` + `sessionProjections`,
   so the conversation lists still populate; the footer prints which path ran.
2. **实时请求** (`llm/stream`) — calls made after each checkpoint.
3. **本页合计** — the priced sum shown in the charts above.
4. **账户余额** — Platform wallets (recharged + granted).
5. **平台用量页** (platform.deepseek.com/usage) — the official bill; it also
   counts calls this Host never saw (other devices, Search/Fetch), so expect
   the two totals to differ.
6. The **会话记录** footer counts conversations contributing to the page.

Prices used (CNY / USD per 1M tokens, peak): `deepseek-flash` cache hit
0.04 / 0.006, cache miss 2 / 0.3, output 8 / 1.2; `deepseek-v4-pro` 0.3 / 0.044,
9 / 1.32, 27 / 3.96. Peak hours are 01:00-04:00 and 06:00-10:00 UTC on weekdays.
Amounts are estimates from those rates, not the actual bill.

## Settings (`cordis.patch.yml`)

```yaml
- id: usage-kline
  config:
    currency: CNY            # CNY or USD
    priceMode: auto          # auto | peak | offpeak
    includeSubagentSessions: true
    liveRequestCount: 20000
    scanConcurrency: 6
    checkpointDir: ''        # defaults to $DSH_HOME/storages/session_projcache/sessions
    prices:                  # per-model overrides for the active currency
      deepseek-flash: { cacheHit: 0.04, cacheMiss: 2, output: 8 }
```

## Extension seats used

- `sidebar.panellist` (id `usage-kline`) — the workspace-strip row glyph.
- `main` (key `usage-kline`) — the page that row selects.
- `sidebarRightTabs.register` — the tab type `usage-kline` (id
  `dsh-usage-kline/tab`) for the workspace column.
- `sidebar.right.pane.tab` / `sidebar.right.pane.tab.title` — that tab's body.
- `conversation.composer.dock` — the chip under the input.

Client halves reach every service through `ctx.get(name)`; no other Context
property is touched, per the client runner's guard.

## Endpoints

The Host half serves them under `/dsh-usage-kline/api` and admits any request
the Client connection admits:

- `GET /overview?days=30` — per-model candles for the range, today's per-call
  series, totals, unpriced routes, range and lifetime conversation rows, and
  the checkpoint-scan diagnostics
- `GET /turns?sessionId=…` — turn-by-turn usage of one live Session
- `GET /account`
- `GET /diag` — the checkpoint directory the host actually scans and how many
  files it could read
- `GET /events` (Server-Sent Events revision feed)
