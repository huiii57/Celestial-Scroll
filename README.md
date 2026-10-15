# 星辰卷軸

以 Notion 資料庫「星辰卷軸」為儲存處的個人日記 PWA。放在手機桌面，點開就能看星圖月曆、翻閱、書寫。

## 它怎麼運作

```
手機上的 PWA  ──(裝置金鑰)──▶  你的 Vercel 後端 (/api/*)  ──(Notion 金鑰)──▶  Notion
```

- **Notion 金鑰只存在 Vercel 的環境變數**，網頁程式碼裡完全沒有，瀏覽器的開發者工具也看不到。
- 後端只允許存取「星辰卷軸」資料庫裡的頁面，即使你的 Integration 還連到別的頁面也碰不到。
- 手機開啟不需輸入密碼：第一次在手機上貼一次「裝置金鑰」，之後永遠自動帶上。

## 檔案說明

| 檔案 | 作用 |
| --- | --- |
| `api/_lib.js` | 共用：金鑰驗證、屬性名稱對照、頁面模板、讀取 Notion |
| `api/month.js` | 取得某月份哪些日子有日記（星圖月曆） |
| `api/entry.js` | 讀取 / 建立 / 儲存單篇日記 |
| `public/index.html` `app.css` `app.js` | 前端畫面 |
| `public/sw.js` | 離線快取 |
| `public/manifest.webmanifest` `icons/` | 加到桌面用的設定與圖示 |
| `vercel.json` | 安全標頭（CSP 等） |

## 架設步驟

### 1. 在 Notion 建立 Integration
1. 開啟 https://www.notion.so/profile/integrations → **New integration**，類型選 Internal。
2. 權限勾選：**Read content、Update content、Insert content**。
3. 複製 **Internal Integration Secret**（這就是 `NOTION_TOKEN`）。

### 2. 讓 Integration 能連到「星辰卷軸」
打開資料庫頁面 → 右上角 **⋯** → **Connections**（連線）→ 加入剛建立的 Integration。

### 3. 取得資料庫 ID
把資料庫用「整頁」開啟，網址長這樣：
`https://www.notion.so/你的工作區/0123456789abcdef0123456789abcdef?v=...`
`?v=` 前面那 32 碼就是 `NOTION_DATABASE_ID`。

### 4. 確認屬性名稱
資料庫的屬性名稱必須和 `api/_lib.js` 裡的 `PROP` 一致：
`日期、典藏、聊天、學習、運動、飲料、TAG`（以及系統自動的「建立時間」）。
- 「日期」要是 **Date** 類型；聊天／學習／運動／典藏是 **Checkbox**；飲料、TAG 是 **Select**。
- 飲料選項：`無糖`、`沒喝`、`含糖`；TAG 選項：`價值觀`、`想法`、`心情`。

### 5. 產生裝置金鑰
終端機執行 `openssl rand -hex 24`，把輸出的字串存進密碼管理器（這就是 `ACCESS_KEY`）。

### 6. 部署到 Vercel
1. 把這個資料夾上傳到 **私人（Private）** GitHub repo（`.gitignore` 已排除 `.env`）。
2. 到 https://vercel.com → **Add New → Project** → 匯入該 repo，Framework 選 **Other**，直接 Deploy。
3. 專案的 **Settings → Environment Variables** 新增三個變數：
   `NOTION_TOKEN`、`NOTION_DATABASE_ID`、`ACCESS_KEY`。
4. 到 **Deployments** 對最新一筆按 **Redeploy**，讓環境變數生效。

> 不想用 GitHub 也可以：安裝 Vercel CLI 後在專案資料夾執行 `vercel`，再用 `vercel env add` 加入變數，最後 `vercel --prod`。

### 7. 放到手機桌面並配對
- **iPhone**：Safari 開啟你的網址 → 分享 → **加入主畫面**。從主畫面開啟 App，出現配對畫面後貼上 `ACCESS_KEY`。
- **Android**：Chrome 開啟你的網址 → ⋮ → **安裝應用程式**。開啟後貼上金鑰；或先在 Chrome 開 `https://你的網址/#key=你的金鑰`，會自動配對並把金鑰從網址列清掉。

配對完成後，之後開啟都不需要再輸入任何東西。

## 本機測試
```bash
npm i -g vercel
npm install
cp .env.example .env.local   # 填入真實值
vercel dev
```

## 疑難排解
- 畫面顯示「連線失敗，請檢查伺服器設定」：到 Vercel → **Logs** 查看原因。常見：忘記 Redeploy、Integration 沒加到資料庫、屬性名稱不一致。
- 更新前端檔案後手機沒變：把 `public/sw.js` 的 `VERSION` 加 1 再部署。
- 金鑰外洩或換手機：在 Vercel 改 `ACCESS_KEY` → Redeploy → 各手機重新配對。

## 已知限制
- 離線時可翻閱「之前看過」的月份與日記，但不能寫入。
- 在 App 裡編輯過的段落，會以單一樣式儲存（保留該段第一個字的粗體／顏色）；有多種顏色混搭的段落，請在 Notion 內編輯。
- 表格、欄位排版等區塊暫不支援顯示。
