# Generation Guard

**修復手機端 SillyTavern 在瀏覽器切到背景後串流卡死、必須重開的問題。**

[![SillyTavern Extension](https://img.shields.io/badge/SillyTavern-Extension-7c3aed)](https://github.com/SillyTavern/SillyTavern)
[![License: AGPL-3.0](https://img.shields.io/badge/License-AGPL--3.0-blue)](LICENSE)

[简体中文](README.md) · [English](README.en.md)

---

## 問題

在手機上使用 SillyTavern 時，若在串流生成期間把瀏覽器切到背景（鎖屏、切換 App、螢幕熄滅），
回到瀏覽器後介面會**永久鎖死**：

- 無法傳送訊息、無法重新生成 / 繼續 / 扮演
- 無法開新聊天、無法查看歷史
- 只能重新整理或重開瀏覽器

同時 Termux 終端會成對印出：

```
Streaming request in progress
Streaming request finished
```

## 根因

瀏覽器進入背景後，用戶端串流讀取可能永久懸置：

| 環節 | 程式碼位置 |
| --- | --- |
| 串流讀取沒有逾時 | `await reader.read()` — `public/scripts/openai.js:3170` |
| `Generate()` 只靠 Promise settle 收尾 | `.then(onSuccess, onError)` — `public/script.js:5453` |
| 該 Promise 不 settle，兩個回呼都不會執行 | `public/script.js:5396`、`3875` |
| 於是 `is_send_press` 永久為 `true` | 設於 `public/script.js:4986`，僅 `5699` 復位 |
| `is_send_press === true` 擋住幾乎所有主要操作 | `public/script.js:1739`、`11598-11659` |

用戶端**完全沒有** `visibilitychange` / `pagehide` 處理，因此沒有任何偵測或復原機制。

## 這個擴充怎麼修

在**不改動 SillyTavern 任何原始碼**的前提下切斷這條路徑：

1. **隱藏後寬限中止** —— 頁面隱藏後等待 `hiddenGraceMs`（預設 3000ms），若仍未完成，
   呼叫 `stopGeneration()` 主動中止。這會讓懸置的讀取立刻失敗，酒館正常的解鎖流程隨即執行。
2. **回前景靜默期兜底** —— 回到前景後，若仍判定生成中且連續 `stallMs`（預設 5000ms）
   沒有任何新內容（內容變化或 token 事件），再次中止並強制解鎖介面。
3. **只提示，不自動重試** —— 避免在使用者不知情時多消耗 API 額度。

> 判定「是否仍在生成」使用 `streamingProcessor.isFinished`，因為酒館**沒有**把
> `isGenerating()` 暴露給擴充（`public/scripts/st-context.js`）。

## 安裝

### 方式一：手動放置（推薦，不需要 git、不需要連網）

1. 下載本倉庫（點 `Code` → `Download ZIP`），取出其中的 `index.js`、`manifest.json`、`settings.html`
2. 放進酒館的 `public/scripts/extensions/third-party/gen-guard/`
3. **重新整理酒館頁面** —— 擴充清單只在頁面載入時掃描
4. 打開 **擴充功能** 面板 → 找到 **Generation Guard** → 啟用

最終結構必須是：

```
SillyTavern/public/scripts/extensions/third-party/gen-guard/
├── manifest.json
├── index.js
└── settings.html
```

⚠️ 必須多一層 `gen-guard` 目錄。直接把三個檔案丟在 `third-party/` 底下是**不會生效**的：
酒館以「子目錄 + 內含 manifest.json」辨識第三方擴充。

### 方式二：Termux / Linux 一行指令

```bash
git clone https://github.com/<你的帳號>/sillytavern-gen-guard /tmp/gen-guard
mkdir -p ~/SillyTavern/public/scripts/extensions/third-party/gen-guard
cp /tmp/gen-guard/{manifest.json,index.js,settings.html} \
   ~/SillyTavern/public/scripts/extensions/third-party/gen-guard/
```

### 方式三：透過酒館「安裝擴充功能」

在酒館的 **擴充功能 → 安裝擴充功能** 填入本倉庫的 Git URL，安裝後重新整理並啟用。
`index.js`、`manifest.json`、`settings.html` 同時位於倉庫根目錄，因此酒館可直接抓取。

## 設定

| 設定 | 預設 | 說明 |
| --- | --- | --- |
| 啟用 Generation Guard | 開 | 總開關。關閉後立即停止一切偵測（不殘留計時器） |
| 背景寬限期（毫秒） | `3000` | 頁面隱藏後多久仍未完成就中止。**設為 0 = 隱藏即中止** |
| 卡死判定閾值（毫秒） | `5000` | 回到前景後，多久無新內容就判定卡死並解鎖（下限 1000） |
| 顯示提示 | 開 | 是否彈出 toast 提示 |
| 診斷記錄 | 開 | 是否在主控台輸出 `[gen-guard]` 前綴記錄 |

### 調參建議

- **仍然卡死** → 把背景寬限期調小（如 `1000`）或設為 `0`
- **正常生成被誤中止** → 把背景寬限期調大（如 `10000`），或調大卡死判定閾值
- **排查問題** → 保持診斷記錄開啟，主控台可看到：

```
[gen-guard] event=visibilitychange hidden=true wasHidden=false generating=true hiddenGraceMs=3000
[gen-guard] check=hidden_grace elapsedMs=3000 generating=true
[gen-guard] action=abort reason=hidden_grace_elapsed kind=hidden
```

## 配套建議（Termux / Android）

擴充只處理「用戶端狀態被卡住」。若 Termux 行程本身被系統凍結，伺服端仍會停擺。建議同時：

- `termux-wake-lock`（取得喚醒鎖）
- 在 Android 設定中對 Termux **關閉電池最佳化**、允許背景執行
- 生成期間盡量避免鎖屏

## 已知邊界

- 不修復位於伺服端的根因：`src/util.js` 的串流轉發缺少寫入逾時與心跳，
  且存在「監聽器掛載晚於串流結束」的競態。徹底修復需要改動酒館原始碼。
- **不會自動重試**，中止後請手動點「繼續」。
- 未做多分頁協調：若多分頁同時生成，背景分頁的自動中止會誤殺前景分頁的生成。

## 開發與自測

本擴充為**零依賴、無建置**的純 ES module。測試套件以依賴注入替換計時器與
`SillyTavern.getContext()`，因此可在純 Node 下確定性地驗證全部時序邏輯，不需要瀏覽器。

```bash
node tests/run.mjs
```

涵蓋 30 個邏輯案例（寬限期邊界、靜默期兜底、冪等、競態、提示、一鍵繼續、診斷記錄、降級）
與 11 個靜態契約案例（manifest 欄位、面板控制項、無網路請求、無靜態 import、
雙份副本一致性、ESM 標記與零依賴、內聯兜底與模板控制項一致、失敗路徑可見性等），共 41 個。

> `extension/package.json` 只宣告 `{"type": "module"}`，讓 Node 18 正確把 `index.js`
> 當成 ES module 解析（Node 22+ 會自動嗅探 ESM 語法，因此這個坑只在舊版本上暴露）。
> **倉庫根目錄刻意不放 `package.json`**，這樣酒館的「安裝擴充功能」拉到的就是乾淨的擴充檔案。

## 授權

[AGPL-3.0-or-later](LICENSE)，與 [SillyTavern](https://github.com/SillyTavern/SillyTavern) 主專案一致。
