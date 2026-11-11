# 6L-Appscript-test 本地端與 Google Apps Script 開發指南

本專案由 `google-apps-script-dev` 技能自動建立，連接雲端 Google Apps Script 專案（Script ID: `1qjktDYKVUO8_yZnMBN12QKUgyKqlEyvmIl5C1Yn05tDyPOFKgJRr-bCT`）。專案根目錄放置啟動與設定程序，其餘檔案依性質分類存放於 **`js/`**（`js/main.js`、`js/datastore.js`）、**`css/`**（`css/style.css.html`）與 **`html/`**（`html/index.html`），並透過 `@google/clasp` 同步與部署至 Google Apps Script Web App。

---

## 0. 專案目錄分類結構說明（`js/`、`css/`、`html/`）

- **專案根目錄 (`/`)**：放置啟動程序與設定檔（`dev-server.js`、`setup-github.js`、`appsscript.json`、`package.json`、`jsconfig.json`、`.clasp.json`、`.claspignore`、`.gitignore`、`README.md`）。
- **`js/` 目錄**：存放所有 JavaScript / GAS 程式碼（`js/main.js` 與 `js/datastore.js`）。
- **`css/` 目錄**：存放所有 CSS 樣式表，命名為 **`*.css.html`**（如 `css/style.css.html`，外層包覆 `<style>...</style>`），上傳至 GAS 雲端時以 HTML 檔案存放並可由 `.css.html` 檔名區分。
- **`html/` 目錄**：存放所有 HTML 頁面模板（`html/index.html`），透過 `<?!= include('css/style.css'); ?>` 引用樣式表。
- **`secrets.local.json`（本地 IDE 專屬雙認證設定檔，不入版控）**：支援設定 `OAUTH_TOKEN`（短期 OAuth Token）與 `SERVICE_ACCOUNT_FILE`（長期服務帳戶金鑰檔）兩種認證模式，供本地端 **JS（`js/datastore.js` + `dev-server.js`）** 與 **Python（`test_datastore.py`）** 程式存取 Cloud Datastore 資料。

---

## 1. 後續在 IDE 內的常用開發指令

在 `6L-Appscript-test` 專案根目錄的終端機中，可使用以下指令：

- **啟動本地預覽伺服器**（預設為 `http://localhost:3030`）：
  ```bash
  npm run dev
  ```
- **查看待推送檔案狀態**：
  ```bash
  npm run status
  ```
- **從雲端拉取最新程式碼**：
  ```bash
  npm run pull
  ```
- **將本地修改推送至 Google Apps Script 雲端**：
  ```bash
  npm run push
  ```
- **查看目前已建立的部署版本清單**：
  ```bash
  npm run deployments
  ```
- **更新正式版 Web App 部署（維持相同正式網址）**：
  ```bash
  npx clasp -A .clasprc.json -P .clasp.json deploy -i AKfycbzWtUBi7PYkJs5E5QkPfYhv4AiFSRN9uZVFd0Z7pNr2DADQza7MsnDT-RR0wKemDLdPPA -d "更新版本說明"
  ```
- **建立全新版本的 Web App 部署**：
  ```bash
  npm run deploy -- -d "新版本說明"
  ```
- **在瀏覽器開啟雲端 Apps Script 編輯器**：
  ```bash
  npm run open
  ```
- **重新進行 Google 帳號授權登入**：
  ```bash
  npm run login
  ```
- **事後補設定 GitHub Pages 或 GitHub Actions 自動部署精靈**：
  ```bash
  npm run setup:github
  ```

---

## 2. 本地端預覽伺服器 Port Number 修改方法

本地端開發伺服器（`dev-server.js`）預設使用 **`3030`** 埠號（`http://localhost:3030`）。若遇到 Port 衝突或想改用其他埠號（例如 `8080`），提供以下 **3 種修改方式**：

### 方法一：啟動時直接帶入參數（最快速、單次生效）
```bash
npm run dev -- 8080
```

### 方法二：透過環境變數 `PORT` 指定（單次生效）
- **macOS / Linux (zsh / bash)**：
  ```bash
  PORT=8080 npm run dev
  ```
- **Windows (PowerShell)**：
  ```powershell
  $env:PORT=8080; npm run dev
  ```

### 方法三：直接修改 `dev-server.js` 預設值（永久生效）
開啟 `dev-server.js` 第 18 行，將預設埠號 `3030` 改為您想要的數值。

---

## 3. 雲端專案與部署資訊

- **Script ID**：`1qjktDYKVUO8_yZnMBN12QKUgyKqlEyvmIl5C1Yn05tDyPOFKgJRr-bCT`
- **正式版 Web App 部署 ID**：`AKfycbzWtUBi7PYkJs5E5QkPfYhv4AiFSRN9uZVFd0Z7pNr2DADQza7MsnDT-RR0wKemDLdPPA`
- **正式版 Web App 網址 (`@7`)**：
  https://script.google.com/macros/s/AKfycbzWtUBi7PYkJs5E5QkPfYhv4AiFSRN9uZVFd0Z7pNr2DADQza7MsnDT-RR0wKemDLdPPA/exec
- **Web App 存取權限**：僅限同網域或自己存取 (`MYSELF`)
- **Google Apps Script 雲端編輯器**：
  https://script.google.com/d/1qjktDYKVUO8_yZnMBN12QKUgyKqlEyvmIl5C1Yn05tDyPOFKgJRr-bCT/edit
- **GitHub 儲存庫**：
  https://github.com/chiurick-github/6L-Appscript-test
