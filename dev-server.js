const http = require('http');
const fs = require('fs');
const path = require('path');
const datastorePath = path.join(__dirname, 'js', 'datastore.js');
const datastore = fs.existsSync(datastorePath) ? require(datastorePath) : null;

// 解析 CLI 參數：支援 `npm run dev -- 8080` 與 `npm run dev -- --mode sa|oauth`
const rawArgs = process.argv.slice(2);
let cliPortArg = '';
let cliModeArg = '';
for (let i = 0; i < rawArgs.length; i++) {
  const arg = rawArgs[i];
  if (arg === '--mode' && rawArgs[i + 1]) {
    cliModeArg = rawArgs[++i];
  } else if (arg.startsWith('--mode=')) {
    cliModeArg = arg.split('=')[1];
  } else if (!arg.startsWith('-') && !cliPortArg && /^\d+$/.test(arg)) {
    cliPortArg = arg;
  }
}

const PORT = Number(cliPortArg || process.env.PORT || 3030);
const ROOT_DIR = __dirname;
const CLI_GCP_ACCESS_TOKEN = process.env.GCP_ACCESS_TOKEN || '';
const CLI_AUTH_MODE = datastore
  ? datastore.normalizeAuthMode(cliModeArg || process.env.DATASTORE_AUTH_MODE || '')
  : (cliModeArg || process.env.DATASTORE_AUTH_MODE || '');
const CLI_PROJECT_ID = process.env.DATASTORE_PROJECT_ID || '';
const CLI_SA_EMAIL = process.env.SA_CLIENT_EMAIL || '';
const CLI_SA_KEY = process.env.SA_PRIVATE_KEY || '';

/**
 * 從本地 secrets.local.json 讀取 OAUTH_TOKEN 與 SERVICE_ACCOUNT_FILE 金鑰檔設定
 * - 支援短期 OAuth Token ("OAUTH_TOKEN") 與長期 Service Account 金鑰檔 ("SERVICE_ACCOUNT_FILE")
 * - 每次呼叫 /api/datastore/* 時自動重新同步，在 IDE 修改 secrets.local.json 無需重啟伺服器
 */
function syncLocalSecretsToEnv() {
  const localSecretsPath = path.join(ROOT_DIR, 'secrets.local.json');
  const status = {
    secretsFileFound: false,
    authMode: CLI_AUTH_MODE || '',
    hasOAuthToken: Boolean(CLI_GCP_ACCESS_TOKEN),
    serviceAccountFile: process.env.GOOGLE_APPLICATION_CREDENTIALS || '',
    serviceAccountFileExists: false,
    serviceAccountEmail: CLI_SA_EMAIL || ''
  };

  if (!fs.existsSync(localSecretsPath)) {
    return status;
  }

  try {
    const localSecrets = JSON.parse(fs.readFileSync(localSecretsPath, 'utf8'));
    status.secretsFileFound = true;

    if (!CLI_PROJECT_ID && localSecrets.PROJECT_ID) {
      process.env.DATASTORE_PROJECT_ID = String(localSecrets.PROJECT_ID).trim();
    }

    if (!CLI_GCP_ACCESS_TOKEN) {
      if (localSecrets.OAUTH_TOKEN && String(localSecrets.OAUTH_TOKEN).trim()) {
        process.env.GCP_ACCESS_TOKEN = String(localSecrets.OAUTH_TOKEN).trim();
        status.hasOAuthToken = true;
      } else {
        delete process.env.GCP_ACCESS_TOKEN;
        status.hasOAuthToken = false;
      }
    }

    let loadedSaEmail = CLI_SA_EMAIL;
    let loadedSaKey = CLI_SA_KEY;

    if (!loadedSaEmail && localSecrets.SA_CLIENT_EMAIL) {
      loadedSaEmail = String(localSecrets.SA_CLIENT_EMAIL).trim();
    }
    if (!loadedSaKey && localSecrets.SA_PRIVATE_KEY) {
      loadedSaKey = String(localSecrets.SA_PRIVATE_KEY).replace(/\\n/g, '\n');
    }

    if (localSecrets.SERVICE_ACCOUNT_FILE) {
      status.serviceAccountFile = String(localSecrets.SERVICE_ACCOUNT_FILE).trim();
      const saFilePath = path.resolve(ROOT_DIR, status.serviceAccountFile);
      process.env.GOOGLE_APPLICATION_CREDENTIALS = saFilePath;
      if (fs.existsSync(saFilePath) && fs.statSync(saFilePath).isFile()) {
        status.serviceAccountFileExists = true;
        const saJson = JSON.parse(fs.readFileSync(saFilePath, 'utf8'));
        if (!CLI_SA_EMAIL && saJson.client_email) {
          loadedSaEmail = saJson.client_email;
        }
        if (!CLI_SA_KEY && saJson.private_key) {
          loadedSaKey = saJson.private_key;
        }
        if (!CLI_PROJECT_ID && !localSecrets.PROJECT_ID && saJson.project_id) {
          process.env.DATASTORE_PROJECT_ID = saJson.project_id;
        }
      }
    }

    if (loadedSaEmail) {
      process.env.SA_CLIENT_EMAIL = loadedSaEmail;
      status.serviceAccountEmail = loadedSaEmail;
    }
    if (loadedSaKey) {
      process.env.SA_PRIVATE_KEY = loadedSaKey;
    }

    const normMode = datastore
      ? datastore.normalizeAuthMode(localSecrets.AUTH_MODE)
      : String(localSecrets.AUTH_MODE || '').toUpperCase();
    const configuredMode = CLI_AUTH_MODE || normMode;
    if (configuredMode && configuredMode !== 'AUTO') {
      process.env.DATASTORE_AUTH_MODE = configuredMode;
      status.authMode = configuredMode;
    } else if (loadedSaEmail && loadedSaKey) {
      process.env.DATASTORE_AUTH_MODE = 'SERVICE_ACCOUNT';
      status.authMode = 'SERVICE_ACCOUNT';
    } else {
      process.env.DATASTORE_AUTH_MODE = 'OAUTH_TOKEN';
      status.authMode = 'OAUTH_TOKEN';
    }
  } catch (e) {
    // 忽略 secrets.local.json 解析錯誤
  }

  return status;
}

const initialSecretsStatus = syncLocalSecretsToEnv();

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.css': 'text/css; charset=utf-8'
};

function sendJson(res, statusCode, data) {
  res.writeHead(statusCode, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(data, null, 2));
}

// 阻擋透過瀏覽器 HTTP 直接讀取本地機敏憑證或隱藏設定檔
function isBlockedSensitivePath(relPath) {
  const base = path.basename(relPath).toLowerCase();
  if (base.startsWith('.')) return true; // 阻擋 .clasprc.json, .env, .git 等
  if (
    base === 'secrets.local.json' ||
    base.includes('service-account') ||
    base.includes('credentials') ||
    base.includes('secret') ||
    base.endsWith('.pem') ||
    base.endsWith('.key') ||
    base.endsWith('.p12')
  ) {
    return true;
  }
  return false;
}

/**
 * 將瀏覽器請求路徑對應至分類子目錄 (html/, css/, js/)
 */
function resolveLocalAssetPath(rawPathname) {
  if (rawPathname === '/' || rawPathname === '/index.html') {
    const htmlIndex = path.join(ROOT_DIR, 'html', 'index.html');
    if (fs.existsSync(htmlIndex)) return htmlIndex;
  }
  const directPath = path.join(ROOT_DIR, rawPathname);
  if (fs.existsSync(directPath) && fs.statSync(directPath).isFile()) {
    return directPath;
  }
  if (rawPathname.endsWith('.css') && !rawPathname.endsWith('.css.html')) {
    const cssHtmlPath = path.join(ROOT_DIR, rawPathname + '.html');
    if (fs.existsSync(cssHtmlPath)) return cssHtmlPath;
  }
  return directPath;
}

/**
 * 本地端模擬 Google Apps Script HtmlService 的 <?!= include('css/style.css'); ?> 模板語法
 * 自動將 css/*.css.html 等檔案內容嵌入 html/index.html 中供本地預覽
 */
function renderGasHtmlIncludes(htmlContent) {
  return htmlContent.replace(/<\?!=\s*include\(\s*['"]([^'"]+)['"]\s*\)\s*;?\s*\?>/g, (match, includeName) => {
    const normalized = includeName.replace(/^\/+/, '');
    const candidates = [
      path.join(ROOT_DIR, normalized),
      path.join(ROOT_DIR, normalized + '.html')
    ];
    for (const candidate of candidates) {
      if (candidate.startsWith(ROOT_DIR) && fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
        return fs.readFileSync(candidate, 'utf8');
      }
    }
    return `<!-- [dev-server] include not found: ${includeName} -->`;
  });
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.setEncoding('utf8');
    req.on('data', (chunk) => { raw += chunk; });
    req.on('end', () => {
      if (!raw) return resolve({});
      try { resolve(JSON.parse(raw)); } catch (e) { reject(new Error('Invalid JSON body')); }
    });
    req.on('error', reject);
  });
}

const server = http.createServer(async (req, res) => {
  const rawPathname = req.url.split('?')[0];

  // 本地端 Datastore API 路由（若存在 js/datastore.js 則自動掛載，並即時同步 secrets.local.json）
  if (datastore && rawPathname.startsWith('/api/datastore/')) {
    syncLocalSecretsToEnv();
    if (rawPathname === '/api/datastore/config' && req.method === 'GET') {
      try { return sendJson(res, 200, datastore.getDatastoreConfigSummary()); }
      catch (err) { return sendJson(res, 500, { status: 'error', message: err.message }); }
    }
    if (rawPathname === '/api/datastore/query' && req.method === 'POST') {
      try {
        const body = await readJsonBody(req);
        const result = await Promise.resolve(datastore.queryDatastoreEntities(body));
        return sendJson(res, 200, result);
      } catch (err) { return sendJson(res, 500, { status: 'error', message: err.message }); }
    }
    if (rawPathname === '/api/datastore/upsert' && req.method === 'POST') {
      try {
        const body = await readJsonBody(req);
        const result = await Promise.resolve(datastore.upsertDatastoreEntity(body));
        return sendJson(res, 200, result);
      } catch (err) { return sendJson(res, 500, { status: 'error', message: err.message }); }
    }
  }

  const filePath = resolveLocalAssetPath(rawPathname);

  if (!filePath.startsWith(ROOT_DIR) || isBlockedSensitivePath(rawPathname) || isBlockedSensitivePath(filePath)) {
    res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('403 Forbidden');
    return;
  }

  fs.readFile(filePath, (err, content) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('404 Not Found');
      return;
    }
    const ext = path.extname(filePath);
    if (ext === '.html') {
      const rendered = renderGasHtmlIncludes(content.toString('utf8'));
      res.writeHead(200, { 'Content-Type': MIME_TYPES['.html'] });
      res.end(rendered);
      return;
    }
    res.writeHead(200, { 'Content-Type': MIME_TYPES[ext] || 'text/plain; charset=utf-8' });
    res.end(content);
  });
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`Local dev server running at http://localhost:${PORT}`);
  console.log(`  - Default AUTH_MODE    : ${initialSecretsStatus.authMode || 'OAUTH_TOKEN'}`);
  console.log(
    `  - SERVICE_ACCOUNT_FILE : ${
      initialSecretsStatus.serviceAccountFileExists
        ? `${initialSecretsStatus.serviceAccountFile} (${initialSecretsStatus.serviceAccountEmail})`
        : 'Not configured / not found'
    }`
  );
  console.log(
    `  - OAUTH_TOKEN          : ${
      initialSecretsStatus.hasOAuthToken ? 'Configured in secrets.local.json / env' : 'Not configured (will fallback to gcloud CLI)'
    }`
  );
});
