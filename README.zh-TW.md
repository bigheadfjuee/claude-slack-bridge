# claude-slack-bridge

[English](README.md) | 繁體中文

**把 Slack 接上 Claude Code**：純 Slack 的遠端控制介面，用來操作
[Claude Code](https://claude.com/claude-code) 這個 coding agent。

在 Slack 頻道或私訊裡操作 Claude Code：送出 prompt、看它逐字串流回覆、核准或拒絕它要執行的工具、
在回合中途打斷它，並讓每個 Slack thread 各自保有一段長期對話。

這是刻意做得很小的單一 daemon：沒有網頁後台、沒有資料庫、沒有佇列。Slack *就是*介面。

---

## 為什麼做這個

[`pi-slack-bridge`](https://github.com/bigheadfjuee/pi-slack-bridge) 以 **pi extension**
的形式載入，為 `pi` coding agent 做了同樣的事。Claude Code 沒有對應的 extension API，無法從外部掛勾；
`claude -p --output-format stream-json` 模式雖然能正常串流，卻**沒有核准介面**：在 print 模式下
Claude 會回報 *"this session has no approval surface"*，`--permission-prompts` 參數也沒有作用。

所以本專案走另一條路：它是建立在官方
**[Claude Agent SDK](https://github.com/anthropics/claude-agent-sdk-typescript)** 上的**獨立 daemon**。
SDK 是唯一有提供 `canUseTool` callback 的正式管道，有了它才能做到「在 Slack 上核准這個 Bash 指令」。
架構說明見 [`docs/architecture.md`](docs/architecture.md)。

---

## 功能

- **以 thread 為單位的 session**：每個 Slack thread 是獨立的對話，有自己的 Claude session。
  頂層訊息會開一個新的，回覆則接續原本的。
- **串流回覆**：回答只發一則訊息，隨 token 抵達原地編輯，並做節流以符合 Slack 的速率限制。
- **在 Slack 核准工具呼叫**：Claude 要執行工具時，會出現一張有 **Allow**、**Allow always**、**Deny**
  按鈕的卡片，決定會直接回傳給 agent。只有已授權的使用者能按。
- **中斷**：`/stop` 取消 Claude 正在執行的回合。
- **Session 重用**：對話會保留；`/new` 重新開始，`/resume` 把 thread 重新綁到既有的 session。
- **Slack 與 CLI 互相接手**：用 `/resume` 在 Slack 接手 `claude` CLI 的 session，或用 `/handoff`
  把 Slack 的 session 交回終端機。bridge 重啟後，thread 仍記得自己的 session。
- **存取控制**：使用者白名單加上一次性挑戰碼驗證，存在磁碟上，重啟後依然有效。
- **repo 裡沒有任何機密**：token 來自環境變數，或你自己管理的 `~/.claude-slack-bridge/config.json`。

---

## 快速開始

### 1. 建立 Slack app

1. 前往 <https://api.slack.com/apps> → **Create New App** → **From scratch**。
2. **Socket Mode** → 啟用，並建立一個具有 `connections:write` scope 的 app-level token。
   這就是你的 `CLAUDE_SLACK_APP_TOKEN`（`xapp-…`）。
3. **OAuth & Permissions** → Bot Token Scopes，加入：
   `app_mentions:read`、`chat:write`、`im:history`、`im:read`、`im:write`、
   `channels:history`、`groups:history`、`reactions:write`、`users:read`。
4. **Event Subscriptions** → 訂閱 bot 事件：`app_mention`、`message.im`。
5. **Interactivity & Shortcuts** → 啟用（核准按鈕的點擊靠它送達）。
6. **Install App** 安裝到你的 workspace，複製 **Bot User OAuth Token**（`xoxb-…`）。
   這就是你的 `CLAUDE_SLACK_BOT_TOKEN`。

### 2. 設定

```bash
git clone https://github.com/bigheadfjuee/claude-slack-bridge.git
cd claude-slack-bridge
npm install
cp .env.example .env      # 然後編輯 .env
```

至少要設定：

```dotenv
CLAUDE_SLACK_BOT_TOKEN=xoxb-…
CLAUDE_SLACK_APP_TOKEN=xapp-…
CLAUDE_SLACK_ALLOWED_USERS=U012ABCDEF   # 你的 Slack user id（見 /whoami）
```

其他都是選填，見[設定](#設定)。

### 3. 確認 Claude Code 已登入

daemon 透過 Agent SDK 執行 Claude，會沿用你現有的 Claude Code 憑證。請在要執行 bridge 的機器上
確認 `claude` 已安裝並登入：

```bash
claude --version
```

### 4. 執行

```bash
npm run build && npm start
# 或者不 build、直接快速跑起來：
npm run dev
```

接著在 Slack 傳訊息給 bot（在頻道裡 mention 它，或直接私訊）。

---

## 指令

| 指令 | 作用 |
|---|---|
| `/help` | 顯示指令列表 |
| `/status` | 這個 thread 的 session id、模型、權限模式和目錄 |
| `/new` | 在這個 thread 開一個全新的 Claude session |
| `/stop` | 中斷 Claude 正在執行的回合 |
| `/sessions [path]` | 列出這台機器上最近的 Claude session，CLI 和 Slack 開的都有 |
| `/resume <id\|前綴> [--fork]` | 在這個 thread 接續已存的 session（在它原本建立的目錄） |
| `/handoff` | 釋放這個 thread 的 session，並給出 CLI 用的 `claude --resume` 指令 |
| `/model <name>` | 切換模型（`opus`、`sonnet`、`haiku` 或完整名稱） |
| `/mode <mode>` | 設定權限模式（`default`、`acceptEdits`、`plan`、`dontAsk`、`bypassPermissions`） |
| `/cwd <path>` | 切換工作目錄（會開新的 session） |
| `/whoami` | 你的 Slack id 以及是否已授權 |

不是指令的內容都會當成 prompt 送給 Claude。只是*看起來*像指令的訊息，例如 `/usr/local/bin`
這種單純的路徑，會被當成一般對話。

---

## 在 Slack 與 CLI 之間移交 session

bridge 和 `claude` CLI 把 session 存在同一個地方（`~/.claude/projects`），
所以任何一邊都能接著另一邊停下的地方繼續。

### CLI → Slack

1. 在 Slack thread 輸入 `/sessions`（或用 `/sessions <path>` 只看某個專案）。
   會列出這台機器上所有已存的 session，CLI 和 Slack 開的都有。每一列顯示 id 前 8 碼、主題、
   最後修改時間、目錄和 git branch。
2. 輸入 `/resume <id>`，給前 8 碼就夠了。如果前綴對到不只一個 session，bridge 會列出符合的項目讓你選。
   下一則訊息會**在該 session 原本建立的目錄**接續它。
3. 如果想保留原本的 session 不動，用 `/resume <id> --fork`。session 會複製成新的 id，在新的那份繼續。
   CLI 那邊還開著這個 session 時，請用這個方式。

### Slack → CLI

1. 在 thread 輸入 `/handoff`。bridge 會關掉自己這端的 session，並回一行可以直接貼上的指令：
   ```bash
   cd <dir> && claude --resume <id>
   ```
2. 在終端機執行它，繼續工作。
3. 之後回到 Slack thread 回話時，bridge 會 resume 這個 session，CLI 期間做的事也會帶回來。

`/status` 也會顯示這個 thread 的 session 對應的 `claude --resume` 指令。

### 重啟後 thread 依然接得上

每個 thread 的 session 都存在 `~/.claude-slack-bridge/threads.json`，所以 bridge 重啟後，
舊 thread 會接續原本的 session，不會從頭開始。如果對應的 session 紀錄已被刪除，這筆對應會被清掉，
thread 改開新的 session，不會每則訊息都失敗。`/new`、`/reset`、`/cwd` 會清除這筆對應。

### 防呆機制

- 某個 session 已經在其他 Slack thread 開著時，`/resume` 會拒絕。請先在那個 thread 執行 `/handoff`，
  或改用 `--fork`。
- Claude 正在 thread 裡執行回合時，`/handoff` 和 `/resume` 會被拒絕。請等它結束，或先 `/stop`。
- 先執行 `/cwd` 再執行 `/resume`，會使用被 resume 的 session 自己的目錄。

### 注意事項

- **不要同時從兩個地方寫同一個 session。** 在 Slack 執行不加 `--fork` 的 `/resume` 之前，先關掉 CLI。
  bridge 無法得知終端機是否還開著這個 session，只能提醒你。
- 如果你的 CLI 版本在 resume 後給 session 新的 id，thread 不會自動找到它。
  請在 thread 執行 `/resume <新 id>` 重新接上。

---

## 設定

設定值依序從環境變數、`~/.claude-slack-bridge/config.json`、內建預設值讀取。兩個來源的白名單會**合併**，
所以在設定檔加入同事，不會讓你在 shell 裡 export 的使用者消失。

| 環境變數 | 設定檔 key | 用途 |
|---|---|---|
| `CLAUDE_SLACK_BOT_TOKEN` | `slack.botToken` | Bot token（`xoxb-…`）。必填。 |
| `CLAUDE_SLACK_APP_TOKEN` | `slack.appToken` | App-level token（`xapp-…`）。Socket Mode 必填。 |
| `CLAUDE_SLACK_ALLOWED_USERS` | `allowedUsers` | 以逗號分隔、可略過驗證的 Slack user id。 |
| `CLAUDE_SLACK_CHALLENGE_CODE` | `challengeCode` | 新使用者用來證明身分的一次性代碼。 |
| `CLAUDE_SLACK_WORKDIR` | `workdir` | 新 session 的預設工作目錄。 |
| `CLAUDE_SLACK_MODEL` | `model` | 模型別名或完整名稱。 |
| `CLAUDE_SLACK_PERMISSION_MODE` | `permissionMode` | 預設權限模式。 |

### 授權

在白名單上、或已完成挑戰碼驗證的使用者即為已授權。兩者都存在 `~/.claude-slack-bridge/auth.json`
（環境變數中的白名單也會一併檢查）。按下核准按鈕被視為特權操作，需要和送出 prompt 相同的授權。

> **關於 `bypassPermissions`：** 設定後 Claude 執行工具時不會詢問。偶爾很好用，但刻意不設為預設值。

---

## 安全性

- daemon 會在你的工作目錄執行 Claude 決定要跑的任何東西。請把 bot 的存取權視同那台機器的 shell 存取權，
  白名單要嚴格控管。
- token 永遠不會寫進 repo；`.env` 已列入 gitignore，設定檔以 `0600` 權限建立。
- 核准按鈕受授權把關，看得到頻道的人無法核准他們沒有權限核准的指令。

---

## 開發

```bash
npm test          # vitest，執行一次
npm run test:watch
npm run lint      # biome
npm run typecheck # tsc --noEmit
```

本專案採測試先行：每個模組的測試都是在程式碼存在之前就寫好、並先確認會失敗。關鍵邏輯另外有
mutation check 覆蓋，它會刻意破壞行為，並確認測試能察覺：

```bash
python3 scripts/mutation-check.py
```

模組地圖及背後的設計決策見 [`docs/architecture.md`](docs/architecture.md)。

---

## 授權條款

MIT，見 [LICENSE](LICENSE)。
