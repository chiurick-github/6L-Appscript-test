#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
===============================================================================
Google Cloud Datastore (資料庫: mydemo2) 本地端雙模式連線測試程式
檔案名稱: test_datastore_mydemo.py
===============================================================================
本程式完全比照 Google Apps Script Web App 呼叫 Cloud Datastore v1 REST API 的方式，
針對您建立的 `mydemo2` 資料庫進行「寫入 (:commit)」與「查詢 (:runQuery)」測試。

支援兩種驗證模式測試：
  1. 【模式 A：OAuth Token 模式 (對應 GAS 的 ScriptApp.getOAuthToken())】
     - 可直接貼入從 GAS `Logger.log(ScriptApp.getOAuthToken())` 取得的 Token，
       或自動呼叫本機 `gcloud auth print-access-token` 取得個人 OAuth Token。
  2. 【模式 B：Service Account 模式 (服務帳戶 JSON 金鑰)】
     - 讀取 GCP Service Account JSON 金鑰檔（或直接填入 client_email 與 private_key），
       簽發 RS256 JWT 向 https://oauth2.googleapis.com/token 換取 Bearer Token。
     - 支援 `google-auth` 套件，若未安裝亦會自動使用系統內建 `openssl` 完成簽章（免額外安裝套件）。

執行方式：
  python3 test_datastore_mydemo.py --mode both
  python3 test_datastore_mydemo.py --mode oauth --project YOUR_PROJECT_ID
  python3 test_datastore_mydemo.py --mode sa --project YOUR_PROJECT_ID --sa-key ./service-account.json
===============================================================================
"""

import argparse
import base64
import datetime
import json
import os
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.parse
import urllib.request

# =============================================================================
# 1. 預設參數設定區（機敏 Token 與私鑰優先從本地端不入版控的 secrets.local.json 讀取）
# =============================================================================
_SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
_LOCAL_SECRETS_PATH = os.path.join(_SCRIPT_DIR, "secrets.local.json")
_LOCAL_SECRETS = {}
if os.path.isfile(_LOCAL_SECRETS_PATH):
    try:
        with open(_LOCAL_SECRETS_PATH, "r", encoding="utf-8") as _sf:
            _LOCAL_SECRETS = json.load(_sf)
    except Exception:
        _LOCAL_SECRETS = {}


def _resolve_sa_file_path(raw_path: str) -> str:
    """解析 Service Account 金鑰檔案路徑（支援相對於專案根目錄或當前目錄）"""
    if not raw_path:
        return ""
    raw_path = raw_path.strip()
    if os.path.isfile(raw_path):
        return os.path.abspath(raw_path)
    candidate = os.path.normpath(os.path.join(_SCRIPT_DIR, raw_path))
    if os.path.isfile(candidate):
        return candidate
    return raw_path


def _normalize_mode(raw_mode: str) -> str:
    """正規化驗證模式名稱：支援 auto / sa (SERVICE_ACCOUNT) / oauth (OAUTH_TOKEN) / both"""
    if not raw_mode:
        return "auto"
    val = str(raw_mode).strip().lower()
    if val in ("sa", "service_account", "key_file"):
        return "sa"
    if val in ("oauth", "oauth_token"):
        return "oauth"
    if val in ("both", "all"):
        return "both"
    if val == "dry-run":
        return "dry-run"
    return "auto"


CONFIG = {
    # 請填入您的 GCP Project ID（例如 "syscom-demo"）
    "PROJECT_ID": os.environ.get("DATASTORE_PROJECT_ID", _LOCAL_SECRETS.get("PROJECT_ID", "syscom-demo")),

    # 您在 Google Cloud Datastore / Firestore 建立的資料庫名稱
    "DATABASE_ID": os.environ.get("DATASTORE_DATABASE_ID", _LOCAL_SECRETS.get("DATABASE_ID", "mydemo2")),

    # 預設 Namespace（預設留空字串 "" 代表 default namespace）
    "NAMESPACE_ID": os.environ.get("DATASTORE_NAMESPACE_ID", _LOCAL_SECRETS.get("NAMESPACE_ID", "")),

    # 測試讀寫的 Entity Kind（相當於資料表名稱）
    "KIND": os.environ.get("DATASTORE_KIND", _LOCAL_SECRETS.get("KIND", "Newsletter")),

    # 預設驗證模式：可於 secrets.local.json 設定 "AUTH_MODE": "SERVICE_ACCOUNT" 或 "OAUTH_TOKEN" 或 "AUTO"
    "AUTH_MODE": _normalize_mode(
        os.environ.get("DATASTORE_AUTH_MODE", _LOCAL_SECRETS.get("AUTH_MODE", "auto"))
    ),

    # -------------------------------------------------------------------------
    # 【模式 A：短期 OAuth Token】對應 GAS ScriptApp.getOAuthToken() 的設定
    # 機敏 Token 請放在 secrets.local.json 的 "OAUTH_TOKEN" 或環境變數 GCP_ACCESS_TOKEN
    # -------------------------------------------------------------------------
    "OAUTH_TOKEN": os.environ.get("GCP_ACCESS_TOKEN", _LOCAL_SECRETS.get("OAUTH_TOKEN", "")),

    # -------------------------------------------------------------------------
    # 【模式 B：長期 Service Account 金鑰檔】設定
    # 金鑰檔案路徑預設從 secrets.local.json 的 "SERVICE_ACCOUNT_FILE" 讀取，免每小時更新 Token
    # -------------------------------------------------------------------------
    "SERVICE_ACCOUNT_FILE": _resolve_sa_file_path(
        os.environ.get(
            "GOOGLE_APPLICATION_CREDENTIALS",
            _LOCAL_SECRETS.get("SERVICE_ACCOUNT_FILE", "./service-account.json")
        )
    ),
    "SERVICE_ACCOUNT_INFO": {
        "client_email": os.environ.get(
            "SA_CLIENT_EMAIL",
            _LOCAL_SECRETS.get("SA_CLIENT_EMAIL", "")
        ),
        "private_key": os.environ.get(
            "SA_PRIVATE_KEY",
            _LOCAL_SECRETS.get("SA_PRIVATE_KEY", "")
        ),
        "token_uri": "https://oauth2.googleapis.com/token",
        "scope": "https://www.googleapis.com/auth/datastore"
    }
}


# =============================================================================
# 2. 驗證方式實作：取得 Bearer Access Token
# =============================================================================

def get_oauth_token(manual_token: str = "") -> str:
    """
    【模式 A】取得 OAuth 2.0 Access Token (對應 GAS 的 ScriptApp.getOAuthToken())
    優先順序：
      1. 參數或 CONFIG["OAUTH_TOKEN"] 手動貼入的 Token（可從 GAS 執行 ScriptApp.getOAuthToken() 複製）
      2. 本機 gcloud CLI (`gcloud auth print-access-token`)
    """
    token = (manual_token or CONFIG["OAUTH_TOKEN"] or "").strip()
    if token:
        print("  🔑 [OAuth 模式] 使用手動提供的 OAuth Access Token (ScriptApp.getOAuthToken)")
        return token

    try:
        res = subprocess.run(
            ["gcloud", "auth", "print-access-token"],
            capture_output=True,
            text=True,
            check=True,
            timeout=5
        )
        gcloud_token = res.stdout.strip()
        if gcloud_token:
            print("  🔑 [OAuth 模式] 已透過本機 `gcloud auth print-access-token` 取得 OAuth Token")
            return gcloud_token
    except Exception:
        pass

    raise RuntimeError(
        "無法取得 OAuth Token！請選擇以下任一方式：\n"
        "  (1) 在 Google Apps Script 執行 `Logger.log(ScriptApp.getOAuthToken())`，將取得的字串填入 CONFIG['OAUTH_TOKEN'] 或使用 `--oauth-token <TOKEN>`\n"
        "  (2) 或在本機終端機執行 `gcloud auth login` 登入 Google 帳號。"
    )


def _b64url_encode(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).decode("utf-8").rstrip("=")


def _sign_rs256_jwt(unsigned_jwt: str, private_key_pem: str) -> str:
    """
    使用 RS256 私鑰對 JWT 進行簽章：
    優先使用 google-auth / cryptography（若已安裝），否則自動呼叫系統內建 `openssl` CLI（零外部套件依賴）。
    """
    # 嘗試使用 cryptography (若環境已安裝)
    try:
        from cryptography.hazmat.primitives import hashes, serialization
        from cryptography.hazmat.primitives.asymmetric import padding

        priv_key = serialization.load_pem_private_key(
            private_key_pem.encode("utf-8"),
            password=None
        )
        sig = priv_key.sign(
            unsigned_jwt.encode("utf-8"),
            padding.PKCS1v15(),
            hashes.SHA256()
        )
        return _b64url_encode(sig)
    except ImportError:
        pass

    # Fallback：使用作業系統內建的 openssl CLI 進行 RSA-SHA256 簽章（免安裝 pip 套件）
    with tempfile.NamedTemporaryFile("w", suffix=".pem", delete=False, encoding="utf-8") as kf:
        kf.write(private_key_pem)
        key_path = kf.name

    try:
        proc = subprocess.run(
            ["openssl", "dgst", "-sha256", "-sign", key_path],
            input=unsigned_jwt.encode("utf-8"),
            capture_output=True,
            check=True
        )
        return _b64url_encode(proc.stdout)
    except Exception as e:
        raise RuntimeError(
            f"RS256 簽章失敗 ({e})。請確認 private_key 格式正確，或執行 `pip install cryptography`。"
        )
    finally:
        if os.path.exists(key_path):
            os.remove(key_path)


def has_valid_service_account(sa_key_file: str = "") -> tuple[bool, str]:
    """檢查是否已設定有效的 Service Account 金鑰檔或私鑰，回傳 (is_valid, source_desc)"""
    key_file = _resolve_sa_file_path(sa_key_file or CONFIG["SERVICE_ACCOUNT_FILE"])
    if key_file and os.path.isfile(key_file):
        try:
            with open(key_file, "r", encoding="utf-8") as f:
                loaded = json.load(f)
            if loaded.get("client_email") and loaded.get("private_key"):
                return True, f"{key_file} ({loaded.get('client_email')})"
        except Exception:
            pass
    sa_info = CONFIG["SERVICE_ACCOUNT_INFO"]
    if sa_info.get("client_email") and sa_info.get("private_key"):
        return True, f"CONFIG['SERVICE_ACCOUNT_INFO'] ({sa_info.get('client_email')})"
    return False, "未設定或檔案不存在"


def get_service_account_token(sa_key_file: str = "") -> tuple[str, str]:
    """
    【模式 B】使用 Service Account 簽發 JWT 並向 Google OAuth2 Token 端點換取 Access Token。
    回傳 (access_token, project_id_from_json)
    """
    key_file = _resolve_sa_file_path(sa_key_file or CONFIG["SERVICE_ACCOUNT_FILE"])
    sa_info = dict(CONFIG["SERVICE_ACCOUNT_INFO"])
    detected_project_id = ""

    if key_file and os.path.isfile(key_file):
        print(f"  📄 [Service Account 模式] 讀取金鑰檔案: {key_file}")
        with open(key_file, "r", encoding="utf-8") as f:
            loaded = json.load(f)
            sa_info.update(loaded)
            detected_project_id = loaded.get("project_id", "")
    else:
        print("  📄 [Service Account 模式] 使用 CONFIG['SERVICE_ACCOUNT_INFO'] 內的設定")

    client_email = sa_info.get("client_email", "")
    private_key = sa_info.get("private_key", "").replace("\\n", "\n")
    token_uri = sa_info.get("token_uri", "https://oauth2.googleapis.com/token")
    scope = sa_info.get("scope", "https://www.googleapis.com/auth/datastore")

    if (
        not client_email
        or client_email.startswith("your-service-account@")
        or "YOUR_PRIVATE_KEY_HERE" in private_key
    ):
        raise RuntimeError(
            "尚未設定真實的 Service Account 金鑰！\n"
            "請將 GCP 下載的 JSON 金鑰存為 `./service-account.json`（或使用 `--sa-key <路徑>`），\n"
            "或直接填寫檔案頂端 CONFIG['SERVICE_ACCOUNT_INFO'] 的 client_email 與 private_key。"
        )

    now = int(time.time())
    header = {"alg": "RS256", "typ": "JWT"}
    claim_set = {
        "iss": client_email,
        "scope": scope,
        "aud": token_uri,
        "iat": now,
        "exp": now + 3600
    }

    unsigned_jwt = (
        _b64url_encode(json.dumps(header).encode("utf-8"))
        + "."
        + _b64url_encode(json.dumps(claim_set).encode("utf-8"))
    )
    signature = _sign_rs256_jwt(unsigned_jwt, private_key)
    signed_jwt = f"{unsigned_jwt}.{signature}"

    body = urllib.parse.urlencode({
        "grant_type": "urn:ietf:params:oauth:grant-type:jwt-bearer",
        "assertion": signed_jwt
    }).encode("utf-8")

    req = urllib.request.Request(
        token_uri,
        data=body,
        headers={"Content-Type": "application/x-www-form-urlencoded"},
        method="POST"
    )
    try:
        with urllib.request.urlopen(req, timeout=15) as resp:
            resp_data = json.loads(resp.read().decode("utf-8"))
            access_token = resp_data["access_token"]
            print(f"  ✅ [Service Account 模式] 成功換取 Bearer Token (帳號: {client_email})")
            return access_token, detected_project_id
    except urllib.error.HTTPError as err:
        err_body = err.read().decode("utf-8", errors="replace")
        raise RuntimeError(f"Service Account Token 交換失敗 (HTTP {err.code}): {err_body}")


# =============================================================================
# 3. Cloud Datastore v1 REST API 封裝 (針對資料庫 `mydemo2`)
# =============================================================================

def to_datastore_value(val):
    if val is None:
        return {"nullValue": None}
    if isinstance(val, bool):
        return {"booleanValue": val}
    if isinstance(val, int):
        return {"integerValue": str(val)}
    if isinstance(val, float):
        return {"doubleValue": val}
    if isinstance(val, dict):
        return {"entityValue": {"properties": {k: to_datastore_value(v) for k, v in val.items()}}}
    if isinstance(val, list):
        return {"arrayValue": {"values": [to_datastore_value(x) for x in val]}}
    return {"stringValue": str(val)}


def from_datastore_value(ds_val: dict):
    if not ds_val:
        return None
    if "stringValue" in ds_val:
        return ds_val["stringValue"]
    if "integerValue" in ds_val:
        return int(ds_val["integerValue"])
    if "doubleValue" in ds_val:
        return float(ds_val["doubleValue"])
    if "booleanValue" in ds_val:
        return bool(ds_val["booleanValue"])
    if "timestampValue" in ds_val:
        return ds_val["timestampValue"]
    if "arrayValue" in ds_val:
        return [from_datastore_value(v) for v in ds_val["arrayValue"].get("values", [])]
    if "entityValue" in ds_val:
        return simplify_entity(ds_val["entityValue"])
    return None


def simplify_entity(entity: dict) -> dict:
    out = {}
    key_path = entity.get("key", {}).get("path", [])
    if key_path:
        last = key_path[-1]
        out["_kind"] = last.get("kind")
        out["_id"] = last.get("name") or last.get("id")
    for k, v in entity.get("properties", {}).items():
        out[k] = from_datastore_value(v)
    return out


def call_datastore_rest_api(
    project_id: str,
    database_id: str,
    action: str,
    access_token: str,
    payload: dict
) -> dict:
    """
    呼叫 https://datastore.googleapis.com/v1/projects/{project_id}:{action}
    注意：當存取具名資料庫 (Named Database，如 mydemo2) 時，Google API Gateway 強制要求在
    HTTP Header 加上 `x-goog-request-params: project_id=<PROJECT_ID>&database_id=<DATABASE_ID>`
    """
    url = f"https://datastore.googleapis.com/v1/projects/{urllib.parse.quote(project_id)}:{action}"
    data_bytes = json.dumps(payload).encode("utf-8")

    headers = {
        "Authorization": f"Bearer {access_token}",
        "Content-Type": "application/json; charset=utf-8"
    }
    if database_id and database_id != "(default)":
        headers["x-goog-request-params"] = f"project_id={project_id}&database_id={database_id}"
    else:
        headers["x-goog-request-params"] = f"project_id={project_id}"

    req = urllib.request.Request(
        url,
        data=data_bytes,
        headers=headers,
        method="POST"
    )
    try:
        with urllib.request.urlopen(req, timeout=20) as resp:
            return {
                "ok": True,
                "status": resp.status,
                "data": json.loads(resp.read().decode("utf-8"))
            }
    except urllib.error.HTTPError as err:
        err_text = err.read().decode("utf-8", errors="replace")
        try:
            err_json = json.loads(err_text)
        except Exception:
            err_json = {"raw": err_text}
        return {
            "ok": False,
            "status": err.code,
            "error": err_json
        }


def call_firestore_rest_api(
    project_id: str,
    database_id: str,
    doc_path: str,
    method: str,
    access_token: str,
    payload: dict = None
) -> dict:
    """
    當資料庫建立為 Enterprise 版本 (或 Firestore Native 模式) 時，
    改呼叫 https://firestore.googleapis.com/v1/projects/{project_id}/databases/{database_id}/documents/{doc_path}
    """
    db = database_id or "(default)"
    url = f"https://firestore.googleapis.com/v1/projects/{urllib.parse.quote(project_id)}/databases/{urllib.parse.quote(db)}/documents/{doc_path}"
    data_bytes = json.dumps(payload).encode("utf-8") if payload is not None else None

    headers = {
        "Authorization": f"Bearer {access_token}",
        "Content-Type": "application/json; charset=utf-8",
        "x-goog-request-params": f"project_id={project_id}&database_id={db}"
    }

    req = urllib.request.Request(
        url,
        data=data_bytes,
        headers=headers,
        method=method.upper()
    )
    try:
        with urllib.request.urlopen(req, timeout=20) as resp:
            return {
                "ok": True,
                "status": resp.status,
                "data": json.loads(resp.read().decode("utf-8"))
            }
    except urllib.error.HTTPError as err:
        err_text = err.read().decode("utf-8", errors="replace")
        try:
            err_json = json.loads(err_text)
        except Exception:
            err_json = {"raw": err_text}
        return {
            "ok": False,
            "status": err.code,
            "error": err_json
        }


def run_firestore_fallback_suite(
    mode_label: str,
    access_token: str,
    project_id: str,
    database_id: str,
    kind: str,
    key_name: str,
    entity_data: dict
):
    print("\n  🔄 偵測到 `mydemo` 為 Firestore Enterprise (企業版) / Native 資料庫，自動切換為 Cloud Firestore REST API (`firestore.googleapis.com/v1`)...")

    # 步驟 1：使用 Firestore REST API 寫入文件 (PATCH /documents/{collection}/{docId})
    firestore_doc = {
        "fields": {k: to_datastore_value(v) for k, v in entity_data.items()}
    }
    doc_path = f"{urllib.parse.quote(kind)}/{urllib.parse.quote(key_name)}"
    print(f"\n[步驟 1/2 (Firestore API)] 正在寫入測試資料至 `{database_id}` ({doc_path})...")
    write_res = call_firestore_rest_api(
        project_id=project_id,
        database_id=database_id,
        doc_path=doc_path,
        method="PATCH",
        access_token=access_token,
        payload=firestore_doc
    )
    if write_res["ok"]:
        print("  ✅ 寫入成功 (Firestore REST API HTTP 200)！")
        print("  寫入內容:", json.dumps(entity_data, ensure_ascii=False, indent=2))
    else:
        print(f"  ❌ 寫入失敗 (HTTP {write_res['status']}):")
        print(json.dumps(write_res["error"], ensure_ascii=False, indent=2))
        return

    # 步驟 2：使用 Firestore REST API 查詢集合文件 (GET /documents/{collection}?pageSize=5)
    list_path = f"{urllib.parse.quote(kind)}?pageSize=5"
    print(f"\n[步驟 2/2 (Firestore API)] 正在從 `{database_id}` 查詢 `{kind}` 前 5 筆資料...")
    list_res = call_firestore_rest_api(
        project_id=project_id,
        database_id=database_id,
        doc_path=list_path,
        method="GET",
        access_token=access_token
    )
    if list_res["ok"]:
        docs = list_res["data"].get("documents", [])
        simplified = []
        for d in docs:
            doc_name = d.get("name", "")
            doc_id = doc_name.split("/")[-1] if "/" in doc_name else doc_name
            item = {"_kind": kind, "_id": doc_id}
            for k, v in d.get("fields", {}).items():
                item[k] = from_datastore_value(v)
            simplified.append(item)
        print(f"  ✅ 查詢成功 (Firestore REST API HTTP 200)！共讀出 {len(simplified)} 筆資料：")
        print(json.dumps(simplified, ensure_ascii=False, indent=2))
    else:
        print(f"  ❌ 查詢失敗 (HTTP {list_res['status']}):")
        print(json.dumps(list_res["error"], ensure_ascii=False, indent=2))


def run_datastore_test_suite(
    mode_label: str,
    access_token: str,
    project_id: str,
    database_id: str,
    namespace_id: str,
    kind: str
):
    print("\n" + "=" * 72)
    print(f"🚀 開始測試 [{mode_label}]")
    print(f"   目標專案 (Project ID)  : {project_id}")
    print(f"   目標資料庫 (Database)  : {database_id or '(default)'}")
    print(f"   目標資料表 (Entity Kind): {kind}")
    print("=" * 72)

    # 1. 測試寫入一筆 Entity (:commit)
    key_name = f"test-{int(time.time())}"
    now_iso = datetime.datetime.now(datetime.timezone.utc).isoformat()
    entity_data = {
        "title": f"6L 電子報測試項目 ({mode_label})",
        "authMode": mode_label,
        "database": database_id,
        "updatedAt": now_iso,
        "published": True
    }

    partition_id = {"projectId": project_id}
    if namespace_id:
        partition_id["namespaceId"] = namespace_id
    if database_id and database_id != "(default)":
        partition_id["databaseId"] = database_id

    commit_payload = {
        "mode": "NON_TRANSACTIONAL",
        "mutations": [
            {
                "upsert": {
                    "key": {
                        "partitionId": partition_id,
                        "path": [{"kind": kind, "name": key_name}]
                    },
                    "properties": {k: to_datastore_value(v) for k, v in entity_data.items()}
                }
            }
        ]
    }
    if database_id and database_id != "(default)":
        commit_payload["databaseId"] = database_id

    print(f"\n[步驟 1/2] 正在寫入測試資料至資料庫 `{database_id}` (Key: {key_name})...")
    commit_res = call_datastore_rest_api(project_id, database_id, "commit", access_token, commit_payload)
    if commit_res["ok"]:
        print("  ✅ 寫入成功 (:commit HTTP 200)！")
        print("  寫入內容:", json.dumps(entity_data, ensure_ascii=False, indent=2))
    else:
        err_str = json.dumps(commit_res["error"], ensure_ascii=False)
        if "CLOUDV1_REJECTS_ENTERPRISE_DATABASES" in err_str or "Enterprise databases" in err_str:
            run_firestore_fallback_suite(
                mode_label=mode_label,
                access_token=access_token,
                project_id=project_id,
                database_id=database_id,
                kind=kind,
                key_name=key_name,
                entity_data=entity_data
            )
            return
        print(f"  ❌ 寫入失敗 (HTTP {commit_res['status']}):")
        print(json.dumps(commit_res["error"], ensure_ascii=False, indent=2))
        return

    # 2. 測試查詢 Entities (:runQuery)
    query_payload = {
        "partitionId": partition_id,
        "query": {
            "kind": [{"name": kind}],
            "limit": 5
        }
    }
    if database_id and database_id != "(default)":
        query_payload["databaseId"] = database_id

    print(f"\n[步驟 2/2] 正在從資料庫 `{database_id}` 查詢 `{kind}` 前 5 筆資料 (:runQuery)...")
    query_res = call_datastore_rest_api(project_id, database_id, "runQuery", access_token, query_payload)
    if query_res["ok"]:
        batch = query_res["data"].get("batch", {})
        results = batch.get("entityResults", [])
        simplified = [simplify_entity(r.get("entity", {})) for r in results]
        print(f"  ✅ 查詢成功 (:runQuery HTTP 200)！共讀出 {len(simplified)} 筆資料：")
        print(json.dumps(simplified, ensure_ascii=False, indent=2))
    else:
        print(f"  ❌ 查詢失敗 (HTTP {query_res['status']}):")
        print(json.dumps(query_res["error"], ensure_ascii=False, indent=2))


# =============================================================================
# 4. 主程式入口 (支援命令列參數與互動提示)
# =============================================================================

def main():
    parser = argparse.ArgumentParser(
        description="測試 Google Cloud Datastore (資料庫: mydemo2) 的短期 OAuth Token 與長期 Service Account 金鑰檔雙驗證模式"
    )
    parser.add_argument(
        "--mode",
        choices=["auto", "oauth", "sa", "both", "dry-run"],
        default="",
        help="驗證模式：auto (依 secrets.local.json 自動選擇，有金鑰檔優先用 sa)、sa (Service Account 金鑰檔，免更新 Token)、oauth (短期 OAuth Token / gcloud)、both (兩者皆測)、dry-run (僅預覽 REST 封包)"
    )
    parser.add_argument("--project", default="", help="GCP Project ID")
    parser.add_argument("--database", default="", help="Datastore 資料庫名稱 (預設: mydemo2)")
    parser.add_argument("--kind", default="", help="Entity Kind 名稱 (預設: Newsletter)")
    parser.add_argument("--oauth-token", default="", help="手動指定從 GAS ScriptApp.getOAuthToken() 複製的短期 Token")
    parser.add_argument("--sa-key", default="", help="Service Account JSON 金鑰檔案路徑 (覆寫 secrets.local.json 的 SERVICE_ACCOUNT_FILE)")

    args = parser.parse_args()

    project_id = args.project or CONFIG["PROJECT_ID"]
    database_id = args.database or CONFIG["DATABASE_ID"] or "mydemo2"
    namespace_id = CONFIG["NAMESPACE_ID"]
    kind = args.kind or CONFIG["KIND"]

    sa_valid, sa_desc = has_valid_service_account(args.sa_key)
    has_oauth = bool((args.oauth_token or CONFIG["OAUTH_TOKEN"] or "").strip())

    # 決定實際執行的驗證模式：
    # 1. 若命令列明確傳入 --mode，優先採用
    # 2. 若命令列傳入 --sa-key，預設用 sa；若傳入 --oauth-token，預設用 oauth
    # 3. 否則讀取 secrets.local.json 的 AUTH_MODE (預設為 auto：若 SERVICE_ACCOUNT_FILE 存在則優先用 sa，否則用 oauth)
    selected_mode = args.mode
    if not selected_mode:
        if args.sa_key:
            selected_mode = "sa"
        elif args.oauth_token:
            selected_mode = "oauth"
        else:
            selected_mode = CONFIG["AUTH_MODE"] or "auto"

    if selected_mode == "auto":
        effective_mode = "sa" if sa_valid else "oauth"
        mode_display = f"auto -> 自動選用 [{effective_mode}] ({'偵測到有效 Service Account 金鑰檔' if sa_valid else '使用短期 OAuth Token'})"
    else:
        effective_mode = selected_mode
        mode_display = effective_mode

    print("========================================================================")
    print("🗄️  Google Cloud Datastore 本地端連線測試工具 (test_datastore_mydemo.py)")
    print("========================================================================")
    print(f"📌 設定專案 ID (PROJECT_ID)       : {project_id}")
    print(f"📌 設定資料庫 (DATABASE_ID)      : {database_id}")
    print(f"📌 設定資料表 (KIND)             : {kind}")
    print(f"📌 長期金鑰檔 (SERVICE_ACCOUNT)   : {'✅ 已就緒 - ' + sa_desc if sa_valid else '⚪ ' + sa_desc}")
    print(f"📌 短期憑證 (OAUTH_TOKEN)         : {'✅ 已設定 (secrets.local.json / env)' if has_oauth else '⚪ 未手動設定 (將自動嘗試 gcloud)'}")
    print(f"📌 執行測試模式 (--mode)          : {mode_display}")
    print("💡 提示：可透過 `--mode sa` (金鑰檔)、`--mode oauth` (短期 OAuth) 或 `--mode both` 自由切換")

    # 若尚未設定真實 Project ID 或選擇 dry-run，印出將發送給 `mydemo2` 的完整 REST 封包結構
    if effective_mode == "dry-run" or project_id == "your-gcp-project-id":
        print("\n⚠️  提示：目前尚未填入真實的 GCP Project ID（或處於 dry-run 模式）。")
        print("以下為實際將發送至 Google Cloud Datastore (`mydemo2` 資料庫) 的 REST API 封包預覽：")
        sample_payload = {
            "databaseId": database_id,
            "partitionId": {
                "projectId": project_id,
                "databaseId": database_id,
                "namespaceId": namespace_id
            },
            "query": {
                "kind": [{"name": kind}],
                "limit": 5
            }
        }
        print(f"\nPOST https://datastore.googleapis.com/v1/projects/{project_id}:runQuery")
        print("Headers: { 'Authorization': 'Bearer <OAUTH_OR_SERVICE_ACCOUNT_TOKEN>' }")
        print("Body:")
        print(json.dumps(sample_payload, ensure_ascii=False, indent=2))
        print("\n👉 請填入真實 Project ID 後重新執行，例如：")
        print(f"   python3 test_datastore_mydemo.py --mode oauth --project <您的GCP專案ID> --database {database_id}")
        print(f"   python3 test_datastore_mydemo.py --mode sa --project <您的GCP專案ID> --database {database_id} --sa-key ./service-account.json")
        return

    # 測試模式 A：短期 OAuth Token (對應 GAS ScriptApp.getOAuthToken())
    if effective_mode in ("oauth", "both"):
        try:
            oauth_token = get_oauth_token(args.oauth_token)
            run_datastore_test_suite(
                mode_label="模式 A：短期 OAuth Token (ScriptApp.getOAuthToken / gcloud)",
                access_token=oauth_token,
                project_id=project_id,
                database_id=database_id,
                namespace_id=namespace_id,
                kind=kind
            )
        except Exception as e:
            print(f"\n⚠️ [模式 A：短期 OAuth Token] 無法執行：{e}")

    # 測試模式 B：長期 Service Account 金鑰檔 (對應 JWT RS256 簽章)
    if effective_mode in ("sa", "both"):
        try:
            sa_token, sa_project = get_service_account_token(args.sa_key)
            effective_project = project_id if project_id != "your-gcp-project-id" else (sa_project or project_id)
            run_datastore_test_suite(
                mode_label="模式 B：長期 Service Account 金鑰檔 (JWT RS256 簽章)",
                access_token=sa_token,
                project_id=effective_project,
                database_id=database_id,
                namespace_id=namespace_id,
                kind=kind
            )
        except Exception as e:
            print(f"\n⚠️ [模式 B：長期 Service Account 金鑰檔] 無法執行：{e}")


if __name__ == "__main__":
    main()
