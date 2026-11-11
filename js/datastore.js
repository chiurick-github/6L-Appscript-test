/**
 * ============================================================================
 * Google Cloud Datastore 參數設定與 REST API 呼叫公用程式 (datastore.js)
 * ============================================================================
 * 支援雙環境直接執行：
 * 1. Google Apps Script 雲端環境 (V8 Runtime)：使用 UrlFetchApp / ScriptApp / Utilities
 * 2. Local Node.js 本地端開發環境 (dev-server.js)：使用 Node 內建 https / crypto / child_process
 *
 * 支援兩種驗證模式 (AUTH_MODE)：
 * - 'OAUTH_TOKEN'     : 使用部署者/執行者的 OAuth Token (GAS: ScriptApp.getOAuthToken() / Local: gcloud)
 * - 'SERVICE_ACCOUNT' : 使用 GCP Service Account 私鑰簽發 JWT 換取 Access Token (免安裝第三方套件)
 * ============================================================================
 */

const DATASTORE_CONFIG = {
  // 1. GCP 專案與資料庫基本設定
  PROJECT_ID: 'syscom-demo',         // 您的 GCP Project ID
  DATABASE_ID: 'mydemo2',            // 您建立的具名資料庫名稱 ('mydemo2')；若為預設資料庫則填 ''
  NAMESPACE_ID: '',                  // 預設 Namespace 請留空字串 ''
  DEFAULT_KIND: 'Newsletter',        // 預設查詢的 Entity Kind 名稱

  // 2. 預設驗證方式：'OAUTH_TOKEN' 或 'SERVICE_ACCOUNT'
  AUTH_MODE: 'OAUTH_TOKEN',

  // 3. 若無真實憑證時，本地端是否啟用「模擬資料 (Mock Fallback)」方便先測試前後端串接流程
  ENABLE_MOCK_WHEN_UNCONFIGURED: true,

  // 4. Service Account 設定 (當 AUTH_MODE === 'SERVICE_ACCOUNT' 時使用)
  // 為確保 GitHub 版控安全，此處不寫死私鑰：
  // - 本地端自動從已被 .gitignore 排除的 secrets.local.json / 金鑰檔讀取
  // - GAS 雲端自動從 PropertiesService.getScriptProperties() (SA_CLIENT_EMAIL / SA_PRIVATE_KEY) 讀取
  SERVICE_ACCOUNT: {
    client_email: '',
    private_key: '',
    token_uri: 'https://oauth2.googleapis.com/token',
    scope: 'https://www.googleapis.com/auth/datastore'
  }
};

/**
 * 判斷目前是否運行於 Google Apps Script 雲端環境
 */
function isGasRuntime() {
  return typeof UrlFetchApp !== 'undefined' && typeof ScriptApp !== 'undefined';
}

/**
 * 正規化驗證模式名稱：支援 'SERVICE_ACCOUNT' ('sa') 與 'OAUTH_TOKEN' ('oauth')
 */
function normalizeAuthMode(mode) {
  if (!mode) return '';
  const upper = String(mode).trim().toUpperCase();
  if (upper === 'SA' || upper === 'SERVICE_ACCOUNT' || upper === 'KEY_FILE') {
    return 'SERVICE_ACCOUNT';
  }
  if (upper === 'OAUTH' || upper === 'OAUTH_TOKEN') {
    return 'OAUTH_TOKEN';
  }
  if (upper === 'AUTO') {
    return 'AUTO';
  }
  return upper;
}

/**
 * 讀取實際生效的設定（優先讀取 GAS ScriptProperties 或本地 secrets.local.json / process.env，其次使用 DATASTORE_CONFIG）
 */
function getEffectiveDatastoreConfig(overrides) {
  overrides = overrides || {};
  let projectId = overrides.projectId || DATASTORE_CONFIG.PROJECT_ID;
  let explicitAuthMode = normalizeAuthMode(overrides.authMode);
  let authMode = explicitAuthMode || DATASTORE_CONFIG.AUTH_MODE;
  let namespaceId = overrides.namespaceId !== undefined ? overrides.namespaceId : DATASTORE_CONFIG.NAMESPACE_ID;
  let databaseId = overrides.databaseId !== undefined ? overrides.databaseId : DATASTORE_CONFIG.DATABASE_ID;
  let defaultKind = overrides.kind || DATASTORE_CONFIG.DEFAULT_KIND;

  let clientEmail = DATASTORE_CONFIG.SERVICE_ACCOUNT.client_email;
  let privateKey = DATASTORE_CONFIG.SERVICE_ACCOUNT.private_key;
  let serviceAccountFile = '';
  let hasOAuthTokenConfigured = false;

  if (isGasRuntime()) {
    hasOAuthTokenConfigured = true;
    try {
      const props = PropertiesService.getScriptProperties();
      projectId = overrides.projectId || props.getProperty('DATASTORE_PROJECT_ID') || projectId;
      authMode = explicitAuthMode || normalizeAuthMode(props.getProperty('DATASTORE_AUTH_MODE')) || authMode;
      clientEmail = props.getProperty('SA_CLIENT_EMAIL') || clientEmail;
      const savedKey = props.getProperty('SA_PRIVATE_KEY');
      if (savedKey) {
        privateKey = savedKey.replace(/\\n/g, '\n');
      }
    } catch (e) {
      // 忽略尚未綁定 PropertiesService 的情況
    }
  } else if (typeof process !== 'undefined' && process.env) {
    let localSecretsAuthMode = '';
    // 本地端：自動讀取已被 .gitignore 排除的 secrets.local.json 與 Service Account 金鑰檔
    if (typeof require !== 'undefined') {
      try {
        const fs = require('fs');
        const path = require('path');
        const projectRoot = fs.existsSync(path.join(__dirname, 'secrets.local.json'))
          ? __dirname
          : path.resolve(__dirname, '..');
        const localSecretsPath = path.join(projectRoot, 'secrets.local.json');
        if (fs.existsSync(localSecretsPath)) {
          const localSecrets = JSON.parse(fs.readFileSync(localSecretsPath, 'utf8'));
          projectId = overrides.projectId || localSecrets.PROJECT_ID || projectId;
          databaseId = overrides.databaseId !== undefined ? overrides.databaseId : (localSecrets.DATABASE_ID || databaseId);
          namespaceId = overrides.namespaceId !== undefined ? overrides.namespaceId : (localSecrets.NAMESPACE_ID !== undefined ? localSecrets.NAMESPACE_ID : namespaceId);
          defaultKind = overrides.kind || localSecrets.KIND || defaultKind;
          localSecretsAuthMode = normalizeAuthMode(localSecrets.AUTH_MODE);

          if (localSecrets.OAUTH_TOKEN && String(localSecrets.OAUTH_TOKEN).trim()) {
            hasOAuthTokenConfigured = true;
          }
          if (localSecrets.SA_CLIENT_EMAIL) {
            clientEmail = localSecrets.SA_CLIENT_EMAIL;
          }
          if (localSecrets.SA_PRIVATE_KEY) {
            privateKey = String(localSecrets.SA_PRIVATE_KEY).replace(/\\n/g, '\n');
          }
          if (localSecrets.SERVICE_ACCOUNT_FILE) {
            serviceAccountFile = localSecrets.SERVICE_ACCOUNT_FILE;
            const saFilePath = path.resolve(projectRoot, localSecrets.SERVICE_ACCOUNT_FILE);
            if (fs.existsSync(saFilePath)) {
              const saJson = JSON.parse(fs.readFileSync(saFilePath, 'utf8'));
              clientEmail = saJson.client_email || clientEmail;
              privateKey = saJson.private_key || privateKey;
              if (!overrides.projectId && !localSecrets.PROJECT_ID && saJson.project_id) {
                projectId = saJson.project_id;
              }
            }
          }
        }
      } catch (e) {}
    }

    if (process.env.GCP_ACCESS_TOKEN && String(process.env.GCP_ACCESS_TOKEN).trim()) {
      hasOAuthTokenConfigured = true;
    }
    if (!serviceAccountFile && process.env.GOOGLE_APPLICATION_CREDENTIALS) {
      serviceAccountFile = process.env.GOOGLE_APPLICATION_CREDENTIALS;
    }
    projectId = overrides.projectId || process.env.DATASTORE_PROJECT_ID || projectId;
    clientEmail = process.env.SA_CLIENT_EMAIL || clientEmail;
    if (process.env.SA_PRIVATE_KEY) {
      privateKey = process.env.SA_PRIVATE_KEY.replace(/\\n/g, '\n');
    }

    const envAuthMode = normalizeAuthMode(process.env.DATASTORE_AUTH_MODE);
    authMode = explicitAuthMode || envAuthMode || localSecretsAuthMode || '';
  }

  const isPlaceholderProject = !projectId || projectId === 'your-gcp-project-id';
  const isPlaceholderSA =
    !clientEmail ||
    clientEmail.indexOf('your-service-account@') === 0 ||
    !privateKey ||
    privateKey.indexOf('YOUR_PRIVATE_KEY_HERE') !== -1;

  // 若本地端未強制指定 authMode (或設為 AUTO)，且已設定有效的 Service Account 金鑰檔，預設優先使用 SERVICE_ACCOUNT (免每小時更新 Token)
  if (!authMode || authMode === 'AUTO') {
    if (!isGasRuntime() && !isPlaceholderSA) {
      authMode = 'SERVICE_ACCOUNT';
    } else {
      authMode = DATASTORE_CONFIG.AUTH_MODE || 'OAUTH_TOKEN';
    }
  }

  return {
    projectId: projectId,
    databaseId: databaseId,
    namespaceId: namespaceId,
    defaultKind: defaultKind,
    authMode: authMode,
    enableMock: DATASTORE_CONFIG.ENABLE_MOCK_WHEN_UNCONFIGURED,
    isPlaceholderProject: isPlaceholderProject,
    isPlaceholderSA: isPlaceholderSA,
    serviceAccountFile: serviceAccountFile,
    hasOAuthTokenConfigured: hasOAuthTokenConfigured,
    serviceAccount: {
      client_email: clientEmail,
      private_key: privateKey,
      token_uri: DATASTORE_CONFIG.SERVICE_ACCOUNT.token_uri,
      scope: DATASTORE_CONFIG.SERVICE_ACCOUNT.scope
    }
  };
}

// ============================================================================
// 【驗證方式一】使用 ScriptApp.getOAuthToken() (本地端支援 gcloud auth print-access-token)
// ============================================================================
function getOAuthTokenForDatastore() {
  // 1. 在 Google Apps Script 雲端環境：直接呼叫 ScriptApp.getOAuthToken()
  if (isGasRuntime()) {
    return ScriptApp.getOAuthToken();
  }

  // 2. 在本地端 Node.js 環境：優先讀取環境變數 GCP_ACCESS_TOKEN、secrets.local.json 的 OAUTH_TOKEN，或嘗試呼叫本機 gcloud CLI
  if (typeof process !== 'undefined' && process.env && process.env.GCP_ACCESS_TOKEN) {
    return process.env.GCP_ACCESS_TOKEN.trim();
  }

  if (typeof require !== 'undefined') {
    try {
      const fs = require('fs');
      const path = require('path');
      const projectRoot = fs.existsSync(path.join(__dirname, 'secrets.local.json'))
        ? __dirname
        : path.resolve(__dirname, '..');
      const localSecretsPath = path.join(projectRoot, 'secrets.local.json');
      if (fs.existsSync(localSecretsPath)) {
        const localSecrets = JSON.parse(fs.readFileSync(localSecretsPath, 'utf8'));
        if (localSecrets.OAUTH_TOKEN && String(localSecrets.OAUTH_TOKEN).trim()) {
          return String(localSecrets.OAUTH_TOKEN).trim();
        }
      }
    } catch (e) {
      // 忽略讀取 secrets.local.json 失敗
    }

    try {
      const cp = require('child_process');
      const token = cp.execSync('gcloud auth print-access-token', {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
        timeout: 3000
      }).trim();
      if (token) return token;
    } catch (e) {
      // 本機未安裝或未登入 gcloud
    }
  }

  throw new Error(
    '無法取得 OAuth Token：在雲端由 ScriptApp.getOAuthToken() 自動提供；在本地端請於 secrets.local.json 設定 "OAUTH_TOKEN"、執行 `gcloud auth login` 或設定環境變數 GCP_ACCESS_TOKEN。'
  );
}

// ============================================================================
// 【驗證方式二】使用 Service Account 私鑰簽發 JWT 換取 Google OAuth2 Access Token
// ============================================================================
function base64UrlEncodeString(str) {
  if (isGasRuntime()) {
    return Utilities.base64EncodeWebSafe(str, Utilities.Charset.UTF_8).replace(/=+$/, '');
  }
  return Buffer.from(str, 'utf8')
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

function signJwtRsaSha256(unsignedToken, privateKeyPem) {
  if (isGasRuntime()) {
    const signatureBytes = Utilities.computeRsaSha256Signature(unsignedToken, privateKeyPem);
    return Utilities.base64EncodeWebSafe(signatureBytes).replace(/=+$/, '');
  }
  const crypto = require('crypto');
  const signer = crypto.createSign('RSA-SHA256');
  signer.update(unsignedToken);
  signer.end();
  return signer
    .sign(privateKeyPem, 'base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

// 本地端 Node.js 記憶體快取 Service Account Access Token (避免每次 API 請求重覆換發 JWT)
const _localSaTokenCache = {};

/**
 * 透過 Service Account 產生簽章 JWT 並向 https://oauth2.googleapis.com/token 換取 Bearer Token
 * - 在 GAS 環境為同步回傳字串
 * - 在本地 Node.js 環境為回傳 Promise<string>
 */
function getServiceAccountTokenForDatastore(saConfig) {
  if (!saConfig || !saConfig.client_email || !saConfig.private_key) {
    throw new Error(
      'Service Account 設定不完整，請確認 secrets.local.json 的 SERVICE_ACCOUNT_FILE 金鑰檔或 client_email / private_key。'
    );
  }

  const nowSec = Math.floor(Date.now() / 1000);
  const cacheKey = 'DATASTORE_SA_TOKEN_' + saConfig.client_email;

  // 1. 在 GAS 環境先檢查 CacheService 是否已有快取的 Token
  if (isGasRuntime()) {
    try {
      const cached = CacheService.getScriptCache().get(cacheKey);
      if (cached) return cached;
    } catch (e) { }
  } else {
    // 2. 在本地 Node.js 環境檢查記憶體快取 (55 分鐘有效期)
    const localCached = _localSaTokenCache[cacheKey];
    if (localCached && localCached.token && localCached.exp > nowSec + 60) {
      return Promise.resolve(localCached.token);
    }
  }

  const header = { alg: 'RS256', typ: 'JWT' };
  const claimSet = {
    iss: saConfig.client_email,
    scope: saConfig.scope || 'https://www.googleapis.com/auth/datastore',
    aud: saConfig.token_uri || 'https://oauth2.googleapis.com/token',
    iat: nowSec,
    exp: nowSec + 3600
  };

  const encodedHeader = base64UrlEncodeString(JSON.stringify(header));
  const encodedClaim = base64UrlEncodeString(JSON.stringify(claimSet));
  const unsignedJwt = encodedHeader + '.' + encodedClaim;
  const signature = signJwtRsaSha256(unsignedJwt, saConfig.private_key);
  const signedJwt = unsignedJwt + '.' + signature;

  const formBody =
    'grant_type=' +
    encodeURIComponent('urn:ietf:params:oauth:grant-type:jwt-bearer') +
    '&assertion=' +
    encodeURIComponent(signedJwt);

  const tokenResOrPromise = sendHttpRequest(saConfig.token_uri || 'https://oauth2.googleapis.com/token', {
    method: 'POST',
    contentType: 'application/x-www-form-urlencoded',
    payload: formBody
  });

  function parseTokenResponse(tokenRes) {
    if (!tokenRes || tokenRes.statusCode !== 200) {
      throw new Error(
        'Service Account Token 交換失敗 (' +
          (tokenRes ? tokenRes.statusCode : 'NO_RESPONSE') +
          '): ' +
          (tokenRes ? tokenRes.bodyText : '')
      );
    }

    const parsed = JSON.parse(tokenRes.bodyText);
    const accessToken = parsed.access_token;

    if (isGasRuntime() && accessToken) {
      try {
        CacheService.getScriptCache().put(cacheKey, accessToken, 3300); // 快取 55 分鐘
      } catch (e) { }
    } else if (accessToken) {
      _localSaTokenCache[cacheKey] = {
        token: accessToken,
        exp: nowSec + 3300
      };
    }

    return accessToken;
  }

  if (tokenResOrPromise && typeof tokenResOrPromise.then === 'function') {
    return tokenResOrPromise.then(parseTokenResponse);
  }
  return parseTokenResponse(tokenResOrPromise);
}

/**
 * 依設定取得 Access Token（支援同步 GAS 與非同步 Node.js Promise）
 */
function resolveAccessTokenForConfig(cfg) {
  if (cfg.authMode === 'SERVICE_ACCOUNT') {
    return getServiceAccountTokenForDatastore(cfg.serviceAccount);
  }
  return getOAuthTokenForDatastore();
}

// ============================================================================
// 底層跨環境 HTTP 請求封裝 (支援 GAS UrlFetchApp 與 Local Node.js https)
// ============================================================================
function sendHttpRequest(url, options) {
  options = options || {};
  const method = (options.method || 'POST').toUpperCase();
  const headers = Object.assign({}, options.headers || {});
  if (options.contentType) {
    headers['Content-Type'] = options.contentType;
  }

  // 1. Google Apps Script 環境：同步呼叫 UrlFetchApp.fetch
  if (isGasRuntime()) {
    const res = UrlFetchApp.fetch(url, {
      method: method.toLowerCase(),
      headers: headers,
      payload: options.payload,
      muteHttpExceptions: true
    });
    return {
      statusCode: res.getResponseCode(),
      bodyText: res.getContentText()
    };
  }

  // 2. Local Node.js 環境：回傳 Promise 供 dev-server.js 非同步處理
  const https = require('https');
  const { URL } = require('url');
  return new Promise((resolve, reject) => {
    const parsedUrl = new URL(url);
    const reqOptions = {
      hostname: parsedUrl.hostname,
      port: parsedUrl.port || 443,
      path: parsedUrl.pathname + parsedUrl.search,
      method: method,
      headers: headers
    };

    const req = https.request(reqOptions, (res) => {
      let rawData = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => {
        rawData += chunk;
      });
      res.on('end', () => {
        resolve({
          statusCode: res.statusCode,
          bodyText: rawData
        });
      });
    });

    req.on('error', (err) => reject(err));
    if (options.payload) {
      req.write(options.payload);
    }
    req.end();
  });
}

// ============================================================================
// Datastore Entity 格式轉換公用函式 (將 Datastore Value 轉為一般易讀 JSON)
// ============================================================================
function toDatastoreValue(jsVal) {
  if (jsVal === null || jsVal === undefined) return { nullValue: null };
  if (typeof jsVal === 'boolean') return { booleanValue: jsVal };
  if (typeof jsVal === 'number') {
    return Number.isInteger(jsVal) ? { integerValue: String(jsVal) } : { doubleValue: jsVal };
  }
  if (jsVal instanceof Date) return { timestampValue: jsVal.toISOString() };
  if (Array.isArray(jsVal)) {
    return { arrayValue: { values: jsVal.map(toDatastoreValue) } };
  }
  if (typeof jsVal === 'object') {
    const props = {};
    Object.keys(jsVal).forEach((k) => {
      props[k] = toDatastoreValue(jsVal[k]);
    });
    return { entityValue: { properties: props } };
  }
  return { stringValue: String(jsVal) };
}

function fromDatastoreValue(dsVal) {
  if (!dsVal) return null;
  if ('stringValue' in dsVal) return dsVal.stringValue;
  if ('integerValue' in dsVal) return Number(dsVal.integerValue);
  if ('doubleValue' in dsVal) return Number(dsVal.doubleValue);
  if ('booleanValue' in dsVal) return Boolean(dsVal.booleanValue);
  if ('timestampValue' in dsVal) return dsVal.timestampValue;
  if ('nullValue' in dsVal) return null;
  if ('arrayValue' in dsVal) {
    return (dsVal.arrayValue.values || []).map(fromDatastoreValue);
  }
  if ('entityValue' in dsVal) {
    return simplifyDatastoreEntity(dsVal.entityValue);
  }
  return dsVal;
}

function simplifyDatastoreEntity(entity) {
  if (!entity) return null;
  const result = {};
  if (entity.key && entity.key.path && entity.key.path.length > 0) {
    const lastPath = entity.key.path[entity.key.path.length - 1];
    result._kind = lastPath.kind;
    result._id = lastPath.id || lastPath.name || null;
  }
  const props = entity.properties || {};
  Object.keys(props).forEach((k) => {
    result[k] = fromDatastoreValue(props[k]);
  });
  return result;
}

// ============================================================================
// 核心 API 公用函式：呼叫 Cloud Datastore v1 REST API (:runQuery / :lookup / :commit)
// ============================================================================

/**
 * 查詢 Cloud Datastore Entities (對應 POST /v1/projects/{projectId}:runQuery)
 * @param {Object} params - { projectId, authMode, kind, limit }
 */
function queryDatastoreEntities(params) {
  params = params || {};
  const cfg = getEffectiveDatastoreConfig(params);
  const kindName = params.kind || cfg.defaultKind;
  const limitCount = Number(params.limit || 10);

  const endpointUrl =
    'https://datastore.googleapis.com/v1/projects/' +
    encodeURIComponent(cfg.projectId) +
    ':runQuery';

  const partitionId = {
    projectId: cfg.projectId,
    namespaceId: cfg.namespaceId || ''
  };
  if (cfg.databaseId) {
    partitionId.databaseId = cfg.databaseId;
  }

  const requestPayload = {
    partitionId: partitionId,
    query: {
      kind: [{ name: kindName }],
      limit: limitCount
    }
  };
  if (cfg.databaseId) {
    requestPayload.databaseId = cfg.databaseId;
  }

  // 若尚未設定真實 GCP Project ID 且開啟 Mock 模式，回傳結構化模擬資料與實際將發送的 REST 封包預覽
  if (cfg.isPlaceholderProject && cfg.enableMock) {
    return {
      status: 'mock',
      message: '目前為模擬模式（尚未設定真實 GCP Project ID）。填入實際 PROJECT_ID 後即會直接連線 Google Cloud Datastore。',
      authModeUsed: cfg.authMode,
      authMechanism:
        cfg.authMode === 'SERVICE_ACCOUNT'
          ? 'Service Account JWT (RS256 -> https://oauth2.googleapis.com/token)'
          : 'ScriptApp.getOAuthToken() / gcloud Bearer Token',
      restRequestPreview: {
        method: 'POST',
        url: endpointUrl,
        headers: { Authorization: 'Bearer <' + cfg.authMode + '_ACCESS_TOKEN>' },
        body: requestPayload
      },
      entities: [
        {
          _kind: kindName,
          _id: 'newsletter-2026-01',
          title: '6L 雲端架構技術雙週刊 - 第 1 期',
          category: 'Cloud & GAS',
          published: true,
          updatedAt: new Date().toISOString()
        },
        {
          _kind: kindName,
          _id: 'newsletter-2026-02',
          title: 'Google Apps Script 串接 Cloud Datastore 實戰指南',
          category: 'Database',
          published: true,
          updatedAt: new Date().toISOString()
        }
      ]
    };
  }

  function executeQueryWithToken(accessToken, usedAuthMode) {
    const reqHeaders = {
      Authorization: 'Bearer ' + accessToken
    };
    if (cfg.databaseId && cfg.databaseId !== '(default)') {
      reqHeaders['x-goog-request-params'] =
        'project_id=' + cfg.projectId + '&database_id=' + cfg.databaseId;
    } else {
      reqHeaders['x-goog-request-params'] = 'project_id=' + cfg.projectId;
    }

    const responseOrPromise = sendHttpRequest(endpointUrl, {
      method: 'POST',
      contentType: 'application/json',
      headers: reqHeaders,
      payload: JSON.stringify(requestPayload)
    });

    function formatQueryResponse(res) {
      let parsedBody = {};
      try {
        parsedBody = JSON.parse(res.bodyText);
      } catch (e) {
        parsedBody = { raw: res.bodyText };
      }

      if (res.statusCode !== 200) {
        return {
          status: 'error',
          httpStatus: res.statusCode,
          authModeUsed: usedAuthMode,
          endpoint: endpointUrl,
          error: parsedBody.error || parsedBody
        };
      }

      const entityResults = (parsedBody.batch && parsedBody.batch.entityResults) || [];
      const simplified = entityResults.map((item) => simplifyDatastoreEntity(item.entity));

      return {
        status: 'ok',
        httpStatus: res.statusCode,
        authModeUsed: usedAuthMode,
        projectId: cfg.projectId,
        kind: kindName,
        count: simplified.length,
        entities: simplified
      };
    }

    if (responseOrPromise && typeof responseOrPromise.then === 'function') {
      return responseOrPromise.then(formatQueryResponse);
    }
    return formatQueryResponse(responseOrPromise);
  }

  // 取得對應模式的 Access Token（支援同步與 Promise）
  const tokenOrPromise = resolveAccessTokenForConfig(cfg);
  if (tokenOrPromise && typeof tokenOrPromise.then === 'function') {
    return tokenOrPromise.then((token) => executeQueryWithToken(token, cfg.authMode));
  }
  return executeQueryWithToken(tokenOrPromise, cfg.authMode);
}

/**
 * 新增或更新單筆 Cloud Datastore Entity (對應 POST /v1/projects/{projectId}:commit)
 * @param {Object} params - { projectId, authMode, kind, keyName, data }
 */
function upsertDatastoreEntity(params) {
  params = params || {};
  const cfg = getEffectiveDatastoreConfig(params);
  const kindName = params.kind || cfg.defaultKind;
  const keyName = params.keyName || 'item-' + Date.now();
  const dataObj = params.data || {
    title: '測試寫入電子報項目',
    createdAt: new Date().toISOString()
  };

  const endpointUrl =
    'https://datastore.googleapis.com/v1/projects/' +
    encodeURIComponent(cfg.projectId) +
    ':commit';

  const propertiesMap = {};
  Object.keys(dataObj).forEach((k) => {
    propertiesMap[k] = toDatastoreValue(dataObj[k]);
  });

  const partitionId = {
    projectId: cfg.projectId,
    namespaceId: cfg.namespaceId || ''
  };
  if (cfg.databaseId) {
    partitionId.databaseId = cfg.databaseId;
  }

  const commitPayload = {
    mode: 'NON_TRANSACTIONAL',
    mutations: [
      {
        upsert: {
          key: {
            partitionId: partitionId,
            path: [{ kind: kindName, name: String(keyName) }]
          },
          properties: propertiesMap
        }
      }
    ]
  };
  if (cfg.databaseId) {
    commitPayload.databaseId = cfg.databaseId;
  }

  if (cfg.isPlaceholderProject && cfg.enableMock) {
    return {
      status: 'mock',
      message: '目前為模擬模式（尚未設定真實 GCP Project ID）。以下為實際將發送至 Datastore :commit 的 REST 封包預覽：',
      authModeUsed: cfg.authMode,
      restRequestPreview: {
        method: 'POST',
        url: endpointUrl,
        headers: { Authorization: 'Bearer <' + cfg.authMode + '_ACCESS_TOKEN>' },
        body: commitPayload
      },
      savedEntity: Object.assign({ _kind: kindName, _id: keyName }, dataObj)
    };
  }

  function executeCommitWithToken(accessToken, usedAuthMode) {
    const commitHeaders = {
      Authorization: 'Bearer ' + accessToken
    };
    if (cfg.databaseId && cfg.databaseId !== '(default)') {
      commitHeaders['x-goog-request-params'] =
        'project_id=' + cfg.projectId + '&database_id=' + cfg.databaseId;
    } else {
      commitHeaders['x-goog-request-params'] = 'project_id=' + cfg.projectId;
    }

    const responseOrPromise = sendHttpRequest(endpointUrl, {
      method: 'POST',
      contentType: 'application/json',
      headers: commitHeaders,
      payload: JSON.stringify(commitPayload)
    });

    function formatCommitResponse(res) {
      let parsedBody = {};
      try {
        parsedBody = JSON.parse(res.bodyText);
      } catch (e) {
        parsedBody = { raw: res.bodyText };
      }

      if (res.statusCode !== 200) {
        return {
          status: 'error',
          httpStatus: res.statusCode,
          authModeUsed: usedAuthMode,
          endpoint: endpointUrl,
          error: parsedBody.error || parsedBody
        };
      }

      return {
        status: 'ok',
        httpStatus: res.statusCode,
        authModeUsed: usedAuthMode,
        projectId: cfg.projectId,
        savedEntity: Object.assign({ _kind: kindName, _id: keyName }, dataObj),
        rawResult: parsedBody
      };
    }

    if (responseOrPromise && typeof responseOrPromise.then === 'function') {
      return responseOrPromise.then(formatCommitResponse);
    }
    return formatCommitResponse(responseOrPromise);
  }

  const tokenOrPromise = resolveAccessTokenForConfig(cfg);
  if (tokenOrPromise && typeof tokenOrPromise.then === 'function') {
    return tokenOrPromise.then((token) => executeCommitWithToken(token, cfg.authMode));
  }
  return executeCommitWithToken(tokenOrPromise, cfg.authMode);
}

/**
 * 取得目前 Datastore 設定摘要（供前端介面顯示與檢查，自動遮罩私鑰）
 */
function getDatastoreConfigSummary() {
  const cfg = getEffectiveDatastoreConfig();
  return {
    projectId: cfg.projectId,
    databaseId: cfg.databaseId || '(default)',
    namespaceId: cfg.namespaceId || '(default)',
    defaultKind: cfg.defaultKind,
    authMode: cfg.authMode,
    isPlaceholderProject: cfg.isPlaceholderProject,
    serviceAccountFile: cfg.serviceAccountFile || '(not set)',
    serviceAccountEmail: cfg.serviceAccount.client_email,
    hasPrivateKeyConfigured: !cfg.isPlaceholderSA,
    hasOAuthTokenConfigured: cfg.hasOAuthTokenConfigured,
    runtime: isGasRuntime() ? 'Google Apps Script (Cloud)' : 'Node.js (Local Dev Server)'
  };
}

// 若在本地端 Node.js 環境被 dev-server.js 載入，匯出公用函式
if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    DATASTORE_CONFIG,
    normalizeAuthMode,
    getEffectiveDatastoreConfig,
    getDatastoreConfigSummary,
    getOAuthTokenForDatastore,
    getServiceAccountTokenForDatastore,
    queryDatastoreEntities,
    upsertDatastoreEntity
  };
}
