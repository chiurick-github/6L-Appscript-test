#!/usr/bin/env node
/**
 * setup-github.js
 * 跨平台 (Windows / macOS / Linux) GitHub 版控與 GitHub Pages 無橫幅起始頁一鍵安裝設定精靈
 *
 * 內建智慧判斷邏輯：
 * 1. 自動偵測本地專案是否已設定 GitHub 版控 (.git 與 origin)，若已存在則提示並詢問是否直接使用。
 * 2. 設定 GitHub 版控或 GitHub Pages 時，自動檢查 GitHub 上是否已有同名儲存庫或既有頁面；
 *    若有重複名稱，讓使用者決定要「覆蓋更新」還是「另外建立一個不重複的新名稱」。
 */

const { execSync, spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const readline = require('readline');

const ROOT_DIR = __dirname;
const PROJECT_NAME = path.basename(ROOT_DIR);

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout
});

function ask(question, defaultVal = '') {
  return new Promise((resolve) => {
    const suffix = defaultVal ? ` (預設: ${defaultVal}): ` : ': ';
    rl.question(question + suffix, (answer) => {
      const val = answer.trim();
      resolve(val || defaultVal);
    });
  });
}

function runCmd(cmd, options = {}) {
  return execSync(cmd, {
    cwd: options.cwd || ROOT_DIR,
    stdio: options.stdio || 'pipe',
    encoding: 'utf8'
  });
}

function checkPrerequisites() {
  try {
    runCmd('git --version');
  } catch (e) {
    console.error('❌ 找不到 git 指令，請先安裝 Git (https://git-scm.com/)。');
    process.exit(1);
  }

  try {
    runCmd('gh --version');
  } catch (e) {
    console.error('❌ 找不到 GitHub CLI (gh) 指令。請先安裝：');
    if (process.platform === 'win32') {
      console.error('   Windows (PowerShell / CMD): winget install --id GitHub.cli');
    } else if (process.platform === 'darwin') {
      console.error('   macOS (Homebrew): brew install gh');
    } else {
      console.error('   Linux: 請參考 https://github.com/cli/cli#installation');
    }
    process.exit(1);
  }
}

function detectLocalGitRemote() {
  if (!fs.existsSync(path.join(ROOT_DIR, '.git'))) {
    return '';
  }
  try {
    return runCmd('git remote get-url origin').trim();
  } catch (e) {
    return '';
  }
}

function parseRepoFromUrl(remoteUrl) {
  // 支援 https://github.com/owner/repo.git 或 git@github.com:owner/repo.git
  const match = remoteUrl.match(/github\.com[:/]([^/]+\/[^/.]+)(?:\.git)?$/i);
  return match ? match[1] : '';
}

function checkRemoteRepoExists(fullRepo) {
  try {
    runCmd(`gh repo view "${fullRepo}" --json name`);
    return true;
  } catch (e) {
    return false;
  }
}

function getExistingPagesBranch(fullRepo) {
  try {
    return runCmd(`gh api repos/${fullRepo}/pages --jq .source.branch`).trim();
  } catch (e) {
    return '';
  }
}

async function resolveNonDuplicateRepoName(currentAccount, initialName, purposeLabel, visibilityFlag) {
  let candidate = initialName;
  while (true) {
    const fullCandidate = `${currentAccount}/${candidate}`;
    const exists = checkRemoteRepoExists(fullCandidate);
    if (!exists) {
      console.log(`\n📦 正在 GitHub 建立全新的儲存庫 ${fullCandidate} (${visibilityFlag})...`);
      runCmd(`gh repo create "${fullCandidate}" ${visibilityFlag} --description "${PROJECT_NAME} - ${purposeLabel}"`);
      console.log(`✅ 已成功建立儲存庫：https://github.com/${fullCandidate}`);
      return { repoName: candidate, fullRepo: fullCandidate };
    }

    console.log(`\n⚠️ 偵測到 GitHub 帳號 [${currentAccount}] 下已經存在同名儲存庫：${fullCandidate}`);
    const existingPagesBranch = getExistingPagesBranch(fullCandidate);
    if (existingPagesBranch) {
      console.log(`   (且該儲存庫目前已啟用 GitHub Pages，來源分支為: ${existingPagesBranch})`);
    }
    console.log('請問您希望如何處理？');
    console.log(`  [1] 直接覆蓋 / 使用既有的 [${fullCandidate}]`);
    console.log('  [2] 另外輸入一個不重複的新儲存庫名稱 (推薦，避免覆蓋既有資料)');
    console.log('  [3] 取消此項操作');
    const decision = await ask('請輸入選項編號 [1/2/3]', '2');

    if (decision === '1') {
      return { repoName: candidate, fullRepo: fullCandidate };
    } else if (decision === '3') {
      return null;
    } else {
      candidate = await ask('請輸入新的不重複儲存庫名稱 (不含帳號名稱)', `${candidate}-new`);
    }
  }
}

function getLatestDeploymentId() {
  try {
    const claspBin = path.join(
      ROOT_DIR,
      'node_modules',
      '.bin',
      process.platform === 'win32' ? 'clasp.cmd' : 'clasp'
    );
    if (!fs.existsSync(claspBin)) return '';
    const out = runCmd(`"${claspBin}" -A .clasprc.json -P .clasp.json deployments`);
    const lines = out.split(/\r?\n/);
    let latestId = '';
    for (const line of lines) {
      const match = line.match(/-\s+(AKfycb[a-zA-Z0-9_-]+)\s+@(\d+)/);
      if (match) {
        latestId = match[1];
      }
    }
    return latestId;
  } catch (e) {
    return '';
  }
}

function getScriptId() {
  try {
    const claspJsonPath = path.join(ROOT_DIR, '.clasp.json');
    if (fs.existsSync(claspJsonPath)) {
      const parsed = JSON.parse(fs.readFileSync(claspJsonPath, 'utf8'));
      return parsed.scriptId || '';
    }
  } catch (e) {}
  return '';
}

function buildPagesHtml(title, deploymentId) {
  return `<!DOCTYPE html>
<html lang="zh-Hant">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>${title}</title>
  <style>
    html, body {
      margin: 0;
      padding: 0;
      width: 100%;
      height: 100%;
      overflow: hidden;
      background-color: #f8fafc;
    }
    iframe {
      width: 100%;
      height: 100%;
      border: none;
      display: block;
    }
  </style>
</head>
<body>
  <!-- 部署於 GitHub Pages 的起始頁面：透過 iframe 嵌入 GAS Web App，自動隱藏「這個應用程式是由 Google Apps Script 的使用者建立」頂部橫幅 -->
  <iframe
    id="gas-frame"
    src="https://script.google.com/macros/s/${deploymentId}/exec"
    allow="clipboard-read; clipboard-write"
    title="${title}">
  </iframe>
</body>
</html>
`;
}

function buildGitHubActionsYaml(projectName, scriptId, deploymentId, pagesUrl) {
  const pagesComment = pagesUrl
    ? `# 如此一來，GAS Web App 網址與 GitHub Pages (${pagesUrl}) 永遠不需修改即可呈現最新版本！`
    : `# 如此一來，GAS Web App 正式版網址永遠維持固定不變！`;

  return `name: Deploy Google Apps Script Web App

on:
  # 【觸發條件 1】當開發者執行 git push 推送至 main 分支時，自動觸發雲端部署
  push:
    branches:
      - main
    # 若只有修改說明文件 (.md)、Python 測試檔 (.py) 或 .gitignore，不觸發 GAS 部署以節省資源
    paths-ignore:
      - '*.md'
      - '*.py'
      - '.gitignore'

  # 【觸發條件 2】支援在 GitHub 網頁的 Actions 頁籤手動點擊「Run workflow」按鈕觸發部署
  workflow_dispatch:
    inputs:
      description:
        description: '部署版本說明 (Deployment Description)'
        required: false
        default: 'Manual deploy from GitHub Actions'

jobs:
  deploy-gas:
    name: Push & Deploy to Google Apps Script (${projectName})
    runs-on: ubuntu-latest

    steps:
      # 步驟 1：將 GitHub 儲存庫內的最新程式碼下載至 GitHub Actions 虛擬機
      - name: 1. 檢出專案原始碼 (Checkout Repository)
        uses: actions/checkout@v4

      # 步驟 2：安裝 Node.js 20 環境並快取 npm 套件
      - name: 2. 設定 Node.js 環境 (Setup Node.js)
        uses: actions/setup-node@v4
        with:
          node-version: '20'
          cache: 'npm'

      # 步驟 3：根據 package-lock.json 安裝 @google/clasp
      - name: 3. 安裝 @google/clasp 依賴套件
        run: npm ci

      # 步驟 4：從 GitHub 加密的 Secrets 讀取 CLASPRC_JSON，在虛擬機內動態產生 .clasprc.json 憑證檔
      - name: 4. 檢查並注入 Google Clasp 授權憑證 (從 GitHub Secrets 讀取)
        env:
          CLASPRC_JSON: \${{ secrets.CLASPRC_JSON }}
        run: |
          if [ -z "$CLASPRC_JSON" ]; then
            echo "⚠️ 尚未設定 GitHub Secret: CLASPRC_JSON"
            echo "請至 GitHub Repository -> Settings -> Secrets and variables -> Actions"
            echo "新增名為 CLASPRC_JSON 的 Repository Secret，並貼上本地端 .clasprc.json 的完整內容。"
            exit 1
          fi
          printf '%s\\n' "$CLASPRC_JSON" > .clasprc.json
          chmod 600 .clasprc.json

      # 步驟 5：執行 clasp push
      # -A .clasprc.json : 使用步驟 4 產生的授權憑證
      # -P .clasp.json   : 指向本專案 Script ID (${scriptId || '<SCRIPT_ID>'})
      # -I .claspignore  : 排除 node_modules、.github、*.md、*.py 等非 GAS 檔案
      # -f               : 強制覆蓋雲端的 appsscript.json 清單與程式碼
      - name: 5. 推送檔案至 Google Apps Script 雲端 (clasp push)
        run: npx clasp -A .clasprc.json -P .clasp.json -I .claspignore push -f

      # 步驟 6：執行 clasp deploy 更新本專案固定的正式版 Deployment ID (${deploymentId || '<DEPLOYMENT_ID>'})
      ${pagesComment}
      - name: 6. 更新正式版 Web App 部署 (clasp deploy)
        env:
          DEPLOYMENT_ID: \${{ secrets.GAS_DEPLOYMENT_ID || '${deploymentId}' }}
          DEPLOY_DESC: \${{ github.event.inputs.description || format('GitHub Actions Auto Deploy ({0})', github.sha) }}
        run: |
          npx clasp -A .clasprc.json -P .clasp.json deploy -i "$DEPLOYMENT_ID" -d "$DEPLOY_DESC"

      # 步驟 7：部署結束後（無論成功或失敗），立即銷毀虛擬機上的 .clasprc.json 暫存檔
      - name: 7. 清除暫存憑證
        if: always()
        run: rm -f .clasprc.json
`;
}

function buildGitHubDeployDoc(projectName, githubAccount, codeFullRepo, scriptId, deploymentId, pagesUrl) {
  const workflowYaml = buildGitHubActionsYaml(projectName, scriptId, deploymentId, pagesUrl);
  return `# 透過 GitHub (GitHub Actions) 自動部署 ${projectName} Web App 操作指南

本文件說明如何將 \`${projectName}\` 專案納入 GitHub 版本控制（確保機敏私鑰與憑證不上傳），並透過 **GitHub Actions** 實現「**當 \`git push\` 至 GitHub 時，自動將程式碼同步並部署至 Google Apps Script Web App**」的完整做法。

---

## 一、本專案 (\`${projectName}\`) 專屬參數對照表

| 參數項目 | 本專案實際設定值 | 檔案位置 / 備註 |
| :--- | :--- | :--- |
| **本地專案目錄** | \`${projectName}\` | 專案根目錄 |
| **Google Script ID** | \`${scriptId || '<SCRIPT_ID>'}\` | 紀錄於 \`.clasp.json\` |
| **正式版 Deployment ID** | \`${deploymentId || '<DEPLOYMENT_ID>'}\` | 固定更新此 ID，確保網址不變 |
| **GAS Web App 網址** | \`https://script.google.com/macros/s/${deploymentId || '<DEPLOYMENT_ID>'}/exec\` | 雲端執行端點 |
| **GitHub 帳號 / 版控庫** | \`${codeFullRepo || githubAccount}\` | GitHub 授權儲存庫 |
| **GitHub Pages 無橫幅首頁** | \`${pagesUrl || '尚未設定 (可執行 npm run setup:github 設定)'}\` | 嵌入上述固定 Deployment ID |

---

## 二、機敏私鑰與憑證隔離（確保不上傳 GitHub）

本專案的 [\`.gitignore\`](./.gitignore) 與 [\`.claspignore\`](./.claspignore) 已自動排除以下機敏檔案：
- \`.clasprc.json\`（Google Clasp OAuth 登入憑證）
- \`secrets.local.json\`、\`*service-account*.json\`、\`*credentials*.json\`、\`*secret*.json\`、\`*.pem\`、\`*.key\`、\`.env*\`

---

## 三、GitHub Actions Secrets 設定說明

若您使用 \`npm run setup:github\` 並選擇自動上傳 Secrets，精靈已透過 \`gh secret set\` 替您設定完成。若需手動設定或更新：
1. 開啟 \`https://github.com/${codeFullRepo || (githubAccount + '/' + projectName)}/settings/secrets/actions\`
2. 新增 Repository Secret：
   - **\`CLASPRC_JSON\`**：貼上本地端 \`.clasprc.json\` 的完整 JSON 內容。
   - **\`GAS_DEPLOYMENT_ID\`**：\`${deploymentId || '<DEPLOYMENT_ID>'}\`

---

## 四、GitHub Actions 自動部署設定檔 (\`.github/workflows/deploy-gas.yml\`) 完整註解

\`\`\`yaml
${workflowYaml.trim()}
\`\`\`
`;
}

async function main() {
  console.log('============================================================');
  console.log('🚀 GitHub 版控與 GitHub Pages 無橫幅起始頁 安裝/設定精靈');
  console.log('   (同時支援 Windows / macOS / Linux)');
  console.log('============================================================\n');

  checkPrerequisites();

  // 步驟 1：檢查 GitHub CLI 登入與授權狀態
  let currentAccount = '';
  try {
    runCmd('gh auth status');
    currentAccount = runCmd('gh api user --jq .login').trim();
  } catch (e) {
    currentAccount = '';
  }

  let needLogin = !currentAccount;
  if (currentAccount) {
    const reuse = await ask(`偵測到本機已登入 GitHub 帳號 [${currentAccount}]，是否確認使用此帳號？ (Y/n)`, 'Y');
    if (reuse.toLowerCase() === 'n') {
      needLogin = true;
    }
  }

  if (needLogin) {
    console.log('\n🌐 即將開啟瀏覽器進行 GitHub OAuth 登入與授權...');
    console.log('   請在彈出的瀏覽器視窗中輸入終端機顯示的 8 碼驗證碼並點擊 Authorize。\n');
    const loginRes = spawnSync('gh', ['auth', 'login', '-h', 'github.com', '-p', 'https', '-s', 'repo,workflow', '-w'], {
      stdio: 'inherit',
      shell: process.platform === 'win32'
    });
    if (loginRes.status !== 0) {
      console.error('❌ GitHub 授權未完成。');
      process.exit(1);
    }
    currentAccount = runCmd('gh api user --jq .login').trim();
  }

  try {
    runCmd('gh auth setup-git');
  } catch (e) {}

  console.log(`✅ 目前授權使用的 GitHub 帳號：${currentAccount}\n`);

  // 步驟 2：詢問欲執行的功能組合
  console.log('請選擇要執行的 GitHub 設定項目：');
  console.log('  [1] 完整設定：「GitHub 地端程式版控」+「GitHub Pages 無橫幅起始頁面」+「GitHub Actions 自動部署」 (推薦)');
  console.log('  [2] 僅設定「GitHub Pages 無橫幅起始頁面」 (地端程式不上傳 GitHub)');
  console.log('  [3] 設定「GitHub 地端程式版控」 (並於最後確認是否啟用 GitHub Actions 自動部署)');
  console.log('  [4] 僅單獨設定 / 補建立「GitHub Actions 自動部署 GAS Web App」');
  const modeChoice = await ask('請輸入選項編號 [1/2/3/4]', '1');

  const enableCodeRepo = modeChoice === '1' || modeChoice === '3' || modeChoice === '4';
  const enablePages = modeChoice === '1' || modeChoice === '2';
  const forceActionsPrompt = modeChoice === '1' || modeChoice === '3' || modeChoice === '4';

  if (!enableCodeRepo && !enablePages) {
    console.log('已取消設定。');
    rl.close();
    return;
  }

  const defaultBaseName = PROJECT_NAME.toLowerCase().replace(/[^a-z0-9-_]/g, '-');
  let activeCodeFullRepo = '';
  let configuredPagesUrl = '';
  let sharedDeploymentId = getLatestDeploymentId();

  // ============================================================================
  // 步驟 3：處理「地端程式版控」 (含自動偵測既有版控與重複名稱檢查)
  // ============================================================================
  if (enableCodeRepo) {
    console.log('\n------------------------------------------------------------');
    console.log('📂 【階段 A】設定地端程式 GitHub 版控');
    console.log('------------------------------------------------------------');

    const existingRemoteUrl = detectLocalGitRemote();
    const existingFullRepo = parseRepoFromUrl(existingRemoteUrl);
    let useExistingBoundRepo = false;

    if (existingRemoteUrl) {
      console.log(`ℹ️ 偵測到本專案已經設定過 GitHub 版控！`);
      console.log(`   目前綁定的遠端儲存庫：${existingRemoteUrl}`);
      console.log('請問是否直接使用此既有的版控設定？');
      console.log('  [1] 是，直接使用此既有版控儲存庫並同步最新變更 (預設)');
      console.log('  [2] 否，我要改綁定或另外建立新的 GitHub 儲存庫');
      console.log('  [3] 略過地端版控推送');
      const gitChoice = await ask('請輸入選項編號 [1/2/3]', '1');

      if (gitChoice === '1') {
        useExistingBoundRepo = true;
        activeCodeFullRepo = existingFullRepo;
      } else if (gitChoice === '3') {
        console.log('⏭️ 已略過地端版控設定。');
      }
    }

    if (!useExistingBoundRepo && activeCodeFullRepo === '' && modeChoice !== '2') {
      const targetCodeRepoName = await ask('請輸入用於「地端程式版控」的 Repository 名稱', defaultBaseName);
      const visAns = await ask('請問此版控儲存庫若需新建，要設為公開 (public) 還是私有 (private)？ [public/private]', 'private');
      const visFlag = visAns.toLowerCase() === 'public' ? '--public' : '--private';

      const resolved = await resolveNonDuplicateRepoName(
        currentAccount,
        targetCodeRepoName,
        'GAS Local Development Source Code',
        visFlag
      );

      if (resolved) {
        activeCodeFullRepo = resolved.fullRepo;
        const repoUrl = `https://github.com/${activeCodeFullRepo}.git`;

        if (!fs.existsSync(path.join(ROOT_DIR, '.git'))) {
          runCmd('git init -b main');
        } else {
          runCmd('git branch -M main');
        }

        try {
          runCmd(`git remote add origin "${repoUrl}"`);
        } catch (e) {
          runCmd(`git remote set-url origin "${repoUrl}"`);
        }
      }
    }

    if (activeCodeFullRepo || useExistingBoundRepo) {
      // 確保 .gitignore 安全排除所有憑證、私鑰與機敏檔案
      const gitignorePath = path.join(ROOT_DIR, '.gitignore');
      const requiredIgnores = [
        'node_modules/',
        '.DS_Store',
        '.clasprc.json',
        'secrets.local.json',
        '*service-account*.json',
        '*syscom-demo*.json',
        '*credentials*.json',
        '*secret*.json',
        '*.pem',
        '*.key',
        '*.p12',
        '.env',
        '.env.*'
      ];
      let currentIgnore = fs.existsSync(gitignorePath) ? fs.readFileSync(gitignorePath, 'utf8') : '';
      let updated = false;
      requiredIgnores.forEach((pattern) => {
        if (!currentIgnore.includes(pattern)) {
          currentIgnore = currentIgnore.trimEnd() + '\n' + pattern;
          updated = true;
        }
      });
      if (updated) {
        fs.writeFileSync(gitignorePath, currentIgnore.trim() + '\n', 'utf8');
      }

      console.log('\n📤 正在將本地端專案程式碼提交並推送至 GitHub (main 分支)...');
      runCmd('git add .');
      try {
        runCmd('git commit -m "chore: sync GAS local development project"');
      } catch (e) {
        console.log('ℹ️ 本地檔案無新增變更，直接確認遠端同步狀態...');
      }
      runCmd('git push -u origin main', { stdio: 'inherit' });
      console.log(`✅ 地端程式版控已同步至：https://github.com/${activeCodeFullRepo || existingFullRepo}`);
    }
  }

  // ============================================================================
  // 步驟 4：處理「GitHub Pages 無橫幅起始頁面」 (含重複名稱覆蓋或新建詢問)
  // ============================================================================
  if (enablePages) {
    console.log('\n------------------------------------------------------------');
    console.log('🌐 【階段 B】設定 GitHub Pages 無橫幅起始頁面');
    console.log('------------------------------------------------------------');

    const detectedId = getLatestDeploymentId();
    if (detectedId) {
      console.log(`🔍 自動偵測到本專案最新的正式版 Deployment ID: ${detectedId}`);
    }
    const deploymentId = await ask('請確認或輸入要嵌入的 GAS 正式版 Deployment ID (AKfycb...)', detectedId);
    if (!deploymentId) {
      console.error('❌ 未提供 Deployment ID，請先執行 npm run deploy 建立正式部署後再試。');
      rl.close();
      process.exit(1);
    }

    let pagesFullRepo = '';
    let targetBranch = 'gh-pages';

    // 若已經有啟用地端版控儲存庫，詢問是否共用同一個 Repo 的 gh-pages 分支，或是另外指定/建立獨立的 Pages Repo
    if (activeCodeFullRepo) {
      console.log(`\n偵測到本專案已綁定版控儲存庫 [${activeCodeFullRepo}]，請問 GitHub Pages 要部署在哪裡？`);
      console.log(`  [1] 共用 [${activeCodeFullRepo}] 的 gh-pages 分支 (注意：GitHub Pages 免費版需將儲存庫設為 Public)`);
      console.log('  [2] 另外指定或建立一個專門用來放 GitHub Pages 起始頁的公開儲存庫 (推薦，可讓程式碼維持 Private)');
      const pagesTargetChoice = await ask('請輸入選項編號 [1/2]', '2');

      if (pagesTargetChoice === '1') {
        pagesFullRepo = activeCodeFullRepo;
        targetBranch = 'gh-pages';
      }
    }

    if (!pagesFullRepo) {
      const initialPagesName = await ask(
        '請輸入用於 GitHub Pages 起始頁面的 Repository 名稱',
        `${defaultBaseName}-pages`
      );
      const resolvedPages = await resolveNonDuplicateRepoName(
        currentAccount,
        initialPagesName,
        'Google Apps Script Web App Entry Page',
        '--public'
      );
      if (!resolvedPages) {
        console.log('⏭️ 已取消 GitHub Pages 部署。');
        rl.close();
        return;
      }
      pagesFullRepo = resolvedPages.fullRepo;

      // 若此 Pages Repo 與程式碼版控 Repo 不同，檢查它是否原本就以 main 分支作為 Pages 來源
      const existingBranch = getExistingPagesBranch(pagesFullRepo);
      if (existingBranch && pagesFullRepo !== activeCodeFullRepo) {
        targetBranch = existingBranch;
      } else if (pagesFullRepo !== activeCodeFullRepo) {
        targetBranch = 'main';
      } else {
        targetBranch = 'gh-pages';
      }
    }

    const pagesRepoUrl = `https://github.com/${pagesFullRepo}.git`;
    console.log(`\n🚀 正在產生無橫幅起始頁面 (index.html) 並部署至 ${pagesFullRepo} (${targetBranch} 分支)...`);

    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gas-gh-pages-'));
    try {
      const htmlContent = buildPagesHtml(`${PROJECT_NAME} Web App`, deploymentId);
      fs.writeFileSync(path.join(tmpDir, 'index.html'), htmlContent, 'utf8');

      runCmd(`git init -b "${targetBranch}"`, { cwd: tmpDir });
      runCmd('git add index.html', { cwd: tmpDir });
      runCmd('git commit -m "deploy: GitHub Pages no-banner entry page"', { cwd: tmpDir });
      runCmd(`git push -f "${pagesRepoUrl}" "${targetBranch}"`, { cwd: tmpDir, stdio: 'inherit' });
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }

    console.log('⚙️ 正在透過 GitHub API 確認並啟用 GitHub Pages 服務...');
    try {
      runCmd(`gh api repos/${pagesFullRepo}/pages -X POST -F "source[branch]=${targetBranch}" -F "source[path]=/"`);
    } catch (e) {
      try {
        runCmd(`gh api repos/${pagesFullRepo}/pages -X PUT -F "source[branch]=${targetBranch}" -F "source[path]=/"`);
      } catch (err) {
        console.warn(`⚠️ 請確認儲存庫 ${pagesFullRepo} 為 Public，並於 GitHub Settings -> Pages 指向 ${targetBranch} 分支。`);
      }
    }

    const pagesRepoShort = pagesFullRepo.split('/')[1];
    const pagesUrl = `https://${currentAccount}.github.io/${pagesRepoShort}/index.html`;
    configuredPagesUrl = pagesUrl;
    sharedDeploymentId = deploymentId;
    console.log('\n============================================================');
    console.log('🎉 GitHub Pages 無橫幅起始頁面設定完成！');
    console.log(`🔗 起始頁面網址: ${pagesUrl}`);
    console.log('   (首次啟用或更新請等待約 30~60 秒讓 GitHub 完成背景發佈)');
    console.log('ℹ️ 提示：往後更新 GAS 程式只要使用相同 Deployment ID 重新部署，此 GitHub Pages 頁面永久不需再修改！');
    console.log('============================================================');
  }

  // ============================================================================
  // 步驟 5：最後階段 — 判斷與建立「GitHub Actions 自動部署 GAS Web App 機制」
  // ============================================================================
  const finalCodeRepo = activeCodeFullRepo || parseRepoFromUrl(detectLocalGitRemote());
  if (forceActionsPrompt || finalCodeRepo) {
    console.log('\n------------------------------------------------------------');
    console.log('⚡ 【階段 C】判斷與建立 GitHub Actions 自動部署 GAS Web App');
    console.log('------------------------------------------------------------');

    const workflowRelPath = path.join('.github', 'workflows', 'deploy-gas.yml');
    const workflowFullPath = path.join(ROOT_DIR, workflowRelPath);
    const deployDocFullPath = path.join(ROOT_DIR, 'GitHub-WebApp-Deploy.md');
    const hasExistingWorkflow = fs.existsSync(workflowFullPath);

    let actionChoice = '2';
    if (hasExistingWorkflow) {
      console.log(`ℹ️ 偵測到本專案已存在 GitHub Actions 自動部署設定檔 (${workflowRelPath})！`);
      console.log('請問是否要更新設定檔並同步加密上傳 GitHub Actions Secrets (CLASPRC_JSON / GAS_DEPLOYMENT_ID)？');
      console.log('  [1] 是，更新部署設定檔與說明文件，並同步設定 GitHub Repository Secrets (預設)');
      console.log('  [2] 僅同步更新 GitHub Repository Secrets (不覆寫現有 .yml 檔案)');
      console.log('  [3] 略過 GitHub Actions 設定');
      actionChoice = await ask('請輸入選項編號 [1/2/3]', '1');
    } else {
      console.log('請問是否要建立「GitHub Actions 自動部署機制」（當 git push 至 main 分支時，自動執行 clasp push & deploy 更新 Web App）？');
      console.log('  [1] 是，建立 .github/workflows/deploy-gas.yml、GitHub-WebApp-Deploy.md 並設定 GitHub Secrets (推薦)');
      console.log('  [2] 否，暫不啟用 GitHub Actions 自動部署');
      const yn = await ask('請輸入選項編號 [1/2]', '1');
      actionChoice = yn === '1' ? '1' : '3';
    }

    if (actionChoice === '1' || actionChoice === '2') {
      const scriptId = getScriptId();
      if (!sharedDeploymentId) {
        sharedDeploymentId = getLatestDeploymentId();
      }
      const deployIdForAction = await ask(
        '請確認用於 GitHub Actions 自動更新的正式版 Deployment ID (AKfycb...)',
        sharedDeploymentId
      );

      if (actionChoice === '1') {
        fs.mkdirSync(path.dirname(workflowFullPath), { recursive: true });
        const yamlContent = buildGitHubActionsYaml(
          PROJECT_NAME,
          scriptId,
          deployIdForAction,
          configuredPagesUrl
        );
        fs.writeFileSync(workflowFullPath, yamlContent, 'utf8');

        const docContent = buildGitHubDeployDoc(
          PROJECT_NAME,
          currentAccount,
          finalCodeRepo,
          scriptId,
          deployIdForAction,
          configuredPagesUrl
        );
        fs.writeFileSync(deployDocFullPath, docContent, 'utf8');

        // 確保 .claspignore 排除 .github/** 與 *.md
        const claspIgnorePath = path.join(ROOT_DIR, '.claspignore');
        let currentClaspIgnore = fs.existsSync(claspIgnorePath) ? fs.readFileSync(claspIgnorePath, 'utf8') : '';
        ['.github/**', '*.md'].forEach((pat) => {
          if (!currentClaspIgnore.includes(pat)) {
            currentClaspIgnore = currentClaspIgnore.trimEnd() + '\n' + pat;
          }
        });
        fs.writeFileSync(claspIgnorePath, currentClaspIgnore.trim() + '\n', 'utf8');
        console.log(`✅ 已產製 ${workflowRelPath} 與 GitHub-WebApp-Deploy.md`);
      }

      // 若已綁定 GitHub 版控儲存庫，詢問是否自動透過 gh secret set 上傳加密憑證並推送分支
      if (finalCodeRepo) {
        const clasprcPath = path.join(ROOT_DIR, '.clasprc.json');
        if (fs.existsSync(clasprcPath)) {
          const uploadSecretsAns = await ask(
            `是否自動將本地 .clasprc.json 與 Deployment ID 加密設定至 GitHub 儲存庫 [${finalCodeRepo}] 的 Actions Secrets？ (Y/n)`,
            'Y'
          );
          if (uploadSecretsAns.toLowerCase() !== 'n') {
            try {
              runCmd(`gh secret set CLASPRC_JSON -R "${finalCodeRepo}" < "${clasprcPath}"`);
              if (deployIdForAction) {
                runCmd(`gh secret set GAS_DEPLOYMENT_ID -R "${finalCodeRepo}" --body "${deployIdForAction}"`);
              }
              console.log(`✅ 已成功將 CLASPRC_JSON 與 GAS_DEPLOYMENT_ID 加密寫入 ${finalCodeRepo} 的 GitHub Secrets！`);
            } catch (err) {
              console.warn('⚠️ 自動設定 GitHub Secrets 失敗，請參考 GitHub-WebApp-Deploy.md 手動於網頁設定。');
            }
          }
        } else {
          console.warn('⚠️ 找不到本地 .clasprc.json，請先執行 npm run login 後再設定 GitHub Secret CLASPRC_JSON。');
        }

        if (actionChoice === '1') {
          console.log('\n📤 正在將 GitHub Actions 自動部署設定檔推送至 GitHub (main 分支)...');
          try {
            runCmd('git add .github/workflows/deploy-gas.yml GitHub-WebApp-Deploy.md .claspignore .gitignore');
            runCmd('git commit -m "ci: add GitHub Actions workflow for GAS Web App auto-deployment"');
            runCmd('git push -u origin main', { stdio: 'inherit' });
            console.log(`🎉 GitHub Actions 自動部署設定已推送至 https://github.com/${finalCodeRepo}/actions`);
          } catch (e) {
            console.log('ℹ️ GitHub Actions 檔案已為最新狀態或尚未初始化遠端分支。');
          }
        }
      } else {
        console.log('ℹ️ 尚未綁定 GitHub 版控遠端儲存庫，已先在本地端建立好 .github/workflows/deploy-gas.yml 與 GitHub-WebApp-Deploy.md。');
      }
    }
  }

  rl.close();
}

main().catch((err) => {
  console.error('❌ 執行發生錯誤：', err.message);
  rl.close();
  process.exit(1);
});
