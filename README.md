# 到班正式版程式

此專案包含 GitHub Pages 前端、Supabase Edge Function、PostgreSQL 資料庫 migration 與測試。**前端、資料庫與 API 已部署，使用者已確認手機 LINE 登入成功；手機定位、管理員與地點設定仍待完成，尚未完成正式出勤驗收。**

2026-10-15 已確認 [GitHub Pages](https://linjinyi404.github.io/-/) 發布成功，LIFF ID `2012025693-u2dzrOVz` 的 endpoint 已設為該網址，scope 為 `openid`、`profile`。LINE Login Channel ID 為 `2012025693`。Supabase 專案 `meregxzdfizybmnonfza` 已部署 `attendance-api`，遠端已設定 `LINE_CHANNEL_ID`、`ALLOWED_ORIGINS`，並依使用者確認關閉 legacy JWT gateway 驗證，改由程式驗證 LINE 憑證與短期 session。

遠端六張資料表均啟用 RLS；anon/authenticated 無權直接執行資料 RPC，service_role 可執行。五項真實 API 檢查通過：health 200 且 configured=true、匿名 snapshot 401、無效 LINE 憑證 401、正式來源 CORS 204、不允許來源 403。這些檢查沒有建立員工或打卡資料。

目前依使用者決定**先不指定管理員**，`BOOTSTRAP_LINE_SUB` 留空，所有新登入帳號先建立為一般員工。LINE Channel 仍為開發模式，測試帳號需要相應權限；公開與手機定位、出勤實測尚待完成。具體後續步驟請看 `建立服務步驟.md`。

已依使用者決定實作：任何已驗證的 LINE 帳號可建立一般員工帳號、地點與班表不固定、地點半徑預設兩公里、哥與弟作為兩位管理員人選、管理員不能審核自己的補打卡。管理員身份以驗證後的 LINE subject 綁定，姓名不是授權依據。

## 檔案與設定

- `frontend/`：可以上傳 GitHub Pages 的網頁。沒有示範帳號、示範位置或本機出勤保存。
- `frontend/config.js`：只放公開的 LIFF ID、API URL、公司名稱。
- `supabase/functions/attendance-api/`：後端驗證 LINE ID token，發放 30 分鐘的隨機登入憑證。前端只在記憶體保存憑證，資料庫只保存憑證 SHA-256。
- `supabase/migrations/202610130001_attendance.sql`：資料表、RLS 與交易 RPC。所有表對 anon/authenticated 預設拒絕，只授權伺服器執行受控 RPC。
- `.github/workflows/pages.yml`：正式儲存庫的 GitHub Pages 發布流程。
- `tests/`：API 安全與 PostgreSQL 規則測試。

## 建立服務與部署

### 1. GitHub 儲存庫

在 [GitHub 建立儲存庫](https://github.com/new)，例如 `clockin`。把**這個 production 資料夾內的檔案**放在儲存庫根目錄，包含 `.github`、`frontend`、`supabase` 等，不要再多包一層 production。GitHub 免費方案的 Pages 可使用 public 儲存庫；其他方案也支援 private，依帳號方案決定。公開原始碼不會公開出勤資料，資料保存在受權限保護的資料庫。

在儲存庫 Settings → Pages 把 Source 設為 GitHub Actions。工作流程只上傳 `frontend`，不把後端設定或測試資料上傳網頁。網址通常是 `https://帳號.github.io/儲存庫/`，請以 GitHub 實際顯示的網址為準。[官方文件](https://docs.github.com/en/pages/getting-started-with-github-pages/using-custom-workflows-with-github-pages)

### 2. Supabase 專案

到 [Supabase Dashboard](https://supabase.com/dashboard) 登入並建立專案。資料庫密碼自行保存，選擇適合團隊的區域與方案；正式出勤需另外安排備份與復原。免費方案適合先驗收，但沒有自動備份，低活動可能暫停。[方案說明](https://supabase.com/pricing)

在新專案 SQL Editor 執行 migration **一次**。不要在已有同名資料表的專案重複執行。正式應用到遠端後，這份 migration 不再修改，未來調整追加新的 migration。

**目前這個專案已在 2026-10-15 執行 `202610130001_attendance.sql` 成功，請勿重複執行；以下建立與部署指令供新環境或後續部署參考。**

安裝 Supabase CLI 後，在這個資料夾執行（首次 CLI 登入與連結專案會要求你的帳號／資料庫設定）：

```powershell
supabase login
supabase link --project-ref meregxzdfizybmnonfza
supabase functions deploy attendance-api
```

函式設定 `verify_jwt=false`，因為接受的是 LINE 與應用程式登入憑證，不是 Supabase Auth JWT。**此設定沒有移除應用程式驗證**：登入會向 LINE 驗證，所有資料路由都檢查資料庫內的短期 session。程式沒有匿名寫入路徑。[官方部署文件](https://supabase.com/docs/guides/functions/deploy)

Supabase Edge Function 通常自帶 `SUPABASE_URL` 與 API 金鑰。程式優先讀取 `SUPABASE_SECRET_KEYS` 的 default secret，並支援舊的 `SUPABASE_SERVICE_ROLE_KEY`；新版 secret 只送在 `apikey`，不冒充 JWT。必要時可用後端的 `DATABASE_SECRET_KEY` 覆寫，禁止放進前端。[官方金鑰文件](https://supabase.com/docs/guides/getting-started/api-keys)

在 Functions Secrets 補上以下設定：

| 名稱 | 值 |
| --- | --- |
| `LINE_CHANNEL_ID` | LINE Login Channel 的公開 Channel ID |
| `ALLOWED_ORIGINS` | GitHub Pages **來源**，例如 `https://帳號.github.io`，不含 repo 路徑；多個來源用逗號分隔 |
| `BOOTSTRAP_LINE_SUB` | 哥的已確認 LINE user ID，作為唯一首位管理員候選。不得以姓名替代 |

私有設計預覽用於檢視畫面。真實登入請在 GitHub／LIFF 正式 endpoint 驗收；如要另用預覽網域测试，需設定相符的測試 LIFF endpoint 與 API 允許來源。`.env.example` 列出名稱與已確認的公開設定，機密欄位留空；真正密碼、service role key、Channel Secret 不進 GitHub、不放前端、不貼聊天。

### 3. LINE Developers / LIFF

到 [LINE Developers Console](https://developers.line.biz/console/) 建立 Provider 與 **LINE Login Channel**，再新增 LIFF app。設定 `openid`、`profile` scope，以及 GitHub Pages 的 HTTPS endpoint。Channel 尚在開發模式時，哥、弟和測試人員需具備測試權限；公開使用前依 Console 設定發布 Channel。

以這個 Provider / Channel 下確認的「哥」帳號 user ID 設定 `BOOTSTRAP_LINE_SUB`，**不是手機號碼、LINE ID 或暱稱**。如果找不到，可先讓哥登入為一般員工，再由專案擁有者於資料庫確認其驗證後 `line_sub`，設定 bootstrap 候選後重新登入。切勿把未知的第一個登入者自動設為管理員。

拿到 LIFF ID 後，填入 `frontend/config.js`：

```js
export const config = Object.freeze({
  liffId: 'Console 顯示的 LIFF ID',
  apiUrl: 'https://專案識別碼.supabase.co/functions/v1/attendance-api',
  companyName: '到班',
});
```

以上是公開設定。前端未填設定時會顯示等待設定，登入與打卡按鈕會鎖定，不會假裝登入或把資料寫入本機。

### 4. 哥、弟綁定與地點

哥以 bootstrap 指定帳號登入後取得第一位管理員權限。弟以自己的 LINE 登入，先取得一般員工編號。哥到「管理工作區 → 員工與權限」，確認弟的員工編號與 LINE 尾碼後，將該帳號設為管理員；可以把顯示姓名改為「弟」。哥哥自己的補打卡只能由弟審核，反之亦然。

到「打卡地點」新增實際中心點，可使用管理員目前位置填入座標，預設半徑 2,000 公尺。所有員工共用啟用地點。沒有啟用地點時拒絕正常打卡，仍可依規則申請補打卡。

## 規則與資料

- 正式打卡時間由資料庫 `clock_timestamp()` 產生，前端不能指定員工、角色、距離或成功旗標。
- 定位精度上限 150 公尺，距離加精度誤差須在任一地點半徑內；位置需在五分鐘內，裝置時間超前超過 30 秒拒絕。
- 同一筆重試使用原 Idempotency-Key；同 key 不同內容拒絕，已有上班不能再上班，未上班不能下班。
- 以資料庫交易與 advisory lock 保護這個小團隊的打卡、審核、地點與權限調整，避免角色變動和同時打卡競態。
- 補打卡保存原申請，核准追加出勤；衝突序列拒絕且交易回滾，自己不能核准或退回自己的申請。
- 地點版本與打卡時的快照保留；之後改地點不回溯修改歷史紀錄。
- 員工只讀自己的資料；管理員讀全體、設定地點與權限；最後一位啟用管理員不能停用／降權。
- 查詢可選歷史日期，每次開始到結束最多相差 90 天、最多 10,000 筆。不會自動刪除資料；資料保存期限與復原政策需在正式啟用前訂定。
- 前端 CSV 防止試算表公式注入；匯出時先由伺服器確認資料範圍並保存稽核。資料庫／稽核只由受控伺服器寫入。
- 登入憑證不放 localStorage；重新整理後需要由 LINE 建立新 session。位置只在主動定位／打卡時取得。
- 瀏覽器位置可以被模擬，後端驗算不能保證杜絕代打卡。

## 本機驗證

測試需要 Node.js 22+ 與 pnpm（或自行使用 npm 安裝依賴）。正式前端與後端沒有 npm 執行依賴，PGlite 只用於測試。

```powershell
pnpm install --frozen-lockfile
node --test tests/*.test.mjs
node tools/serve.mjs
```

本機預覽預設 `http://127.0.0.1:4174`。瀏覽器整合測試 `node tools/browser-qa.mjs` 另外需要 Playwright 與 Edge，可用 `PLAYWRIGHT_PATH`、`EDGE_PATH` 指定安裝位置。它使用模擬 LINE 回應、模擬座標和本機 PGlite，**不代表真實 LINE、Supabase 遠端部署或兩台手機的網路操作已驗收**。

上線前仍需：iPhone / Android 的 LINE 登入與定位實測、停用／登出／過期登入、兩台手機同時打卡與超時重送、真實資料庫備份復原，以及哥弟互相審核。
