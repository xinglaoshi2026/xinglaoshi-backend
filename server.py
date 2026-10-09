# -*- coding: utf-8 -*-
"""
邢老师工作台 · 云端同步后端（零依赖，纯标准库）
=================================================
功能：
  - 用户认证（注册/登录，token 会话）
  - 通用数据存储（模块/JSON），覆盖 v1：questions/papers/exams/students/schedule/records/knowledgePoints
  - 媒体文件上传/下载（题目图片等）
  - 同步接口：pull(since) 增量拉取，push 批量上推（last-write-wins by updatedAt）
  - 静态托管移动端 SPA（同源于 /）

部署：
  - 本地： python server.py   （默认 0.0.0.0:8000，数据在 ./data）
  - 免费云平台(Render/Fly.io)： build/start 用 python server.py，PORT 由环境变量提供

数据模型（业务字段保持与桌面端 data.json 一致，整条以 JSON 存于 store 表）：
  store(module, id, body, updated_at)
"""
import os, sys, json, sqlite3, hashlib, secrets, time, uuid, mimetypes, re, io, zipfile, struct, shutil, threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse, parse_qs, quote as urlquote, unquote as urlunquote
from datetime import datetime, timezone
from xml.sax.saxutils import escape as xesc

BASE = os.path.dirname(os.path.abspath(__file__))
DATA_DIR = os.environ.get("DATA_DIR", os.path.join(BASE, "data"))
DB_PATH = os.path.join(DATA_DIR, "sync.db")
MEDIA_DIR = os.path.join(DATA_DIR, "media")
os.makedirs(DATA_DIR, exist_ok=True)
os.makedirs(MEDIA_DIR, exist_ok=True)

PORT = int(os.environ.get("PORT", "8000"))

# (deploy trigger) 重启以恢复因并发写入锁死的 sync.db


# ---------------- 数据库 ----------------
def db():
    cx = sqlite3.connect(DB_PATH)
    cx.row_factory = sqlite3.Row
    cx.execute("PRAGMA journal_mode=WAL")
    return cx


def init_db():
    cx = db()
    cx.executescript("""
    CREATE TABLE IF NOT EXISTS users(
        id TEXT PRIMARY KEY, username TEXT UNIQUE, pw_hash TEXT, role TEXT, created_at INTEGER,
        student_id TEXT);
    CREATE TABLE IF NOT EXISTS sessions(
        token TEXT PRIMARY KEY, user_id TEXT, expires INTEGER);
    CREATE TABLE IF NOT EXISTS store(
        module TEXT, id TEXT, body TEXT, updated_at INTEGER,
        PRIMARY KEY(module, id));
    CREATE TABLE IF NOT EXISTS tombstones(
        module TEXT, id TEXT, deleted_at INTEGER,
        PRIMARY KEY(module, id));
    CREATE TABLE IF NOT EXISTS meta(
        k TEXT PRIMARY KEY, v TEXT);
    """)
    cx.commit()
    # 迁移：users 增加 student_id 列(学生账号用), 旧库已存在则忽略
    try:
        cx.execute("ALTER TABLE users ADD COLUMN student_id TEXT")
    except Exception:
        pass
    cx.commit()
    # 初始化：若没有任何用户，创建管理员。密码用环境变量 ADMIN_PASSWORD，未设则随机生成并打印
    # （不再使用 admin/admin123 这类默认弱口令 —— 那等于把后台公开）
    cur = cx.execute("SELECT COUNT(*) c FROM users")
    if cur.fetchone()["c"] == 0:
        _pw = os.environ.get("ADMIN_PASSWORD") or secrets.token_urlsafe(9)
        add_user(cx, "admin", _pw, "admin")
        print("[init] 已创建管理员 admin / %s （请尽快登录后修改密码）" % _pw)
    cx.commit()
    cx.close()


def pw_hash(pw):
    return hashlib.sha256(pw.encode("utf-8")).hexdigest()


def add_user(cx, username, pw, role="user", student_id=None):
    uid = "u_" + uuid.uuid4().hex[:12]
    cx.execute("INSERT INTO users(id,username,pw_hash,role,created_at,student_id) VALUES(?,?,?,?,?,?)",
               (uid, username, pw_hash(pw), role, int(time.time()), student_id))
    return uid


def now_ts():
    return int(time.time())


def now_ms():
    """毫秒时间戳：store 行的 updated_at 统一用毫秒（与桌面桥推送一致），
    避免手机端直接 POST 产生秒级时间戳，导致排序沉底/增量拉取拉不到。"""
    return int(time.time() * 1000)


def migrate_ts():
    """启动时把历史秒级时间戳统一放大为毫秒（幂等：毫秒值恒 > 1e11）。"""
    cx = db()
    cx.execute("UPDATE store SET updated_at=updated_at*1000 WHERE updated_at>0 AND updated_at<100000000000")
    cx.execute("UPDATE tombstones SET deleted_at=deleted_at*1000 WHERE deleted_at>0 AND deleted_at<100000000000")
    cx.commit()
    cx.close()


# ---------------- 存储层 ----------------
MODULES = ["questions", "papers", "exams", "students", "schedule",
           "records", "knowledgePoints", "examCategories", "wrongNotes",
           "examPapers", "myCategories",
           "dailyQuestions", "dailyAnswers",
           "trainErrors", "trainCards", "trainTasks", "trainLogs"]


def store_get(module, id):
    cx = db()
    r = cx.execute("SELECT body,updated_at FROM store WHERE module=? AND id=?", (module, id)).fetchone()
    cx.close()
    if not r:
        return None, None
    return json.loads(r["body"]), r["updated_at"]


def store_put(module, id, body, ts=None):
    ts = ts or now_ms()
    cx = db()
    cx.execute("INSERT INTO store(module,id,body,updated_at) VALUES(?,?,?,?) "
               "ON CONFLICT(module,id) DO UPDATE SET body=excluded.body, updated_at=excluded.updated_at",
               (module, id, json.dumps(body, ensure_ascii=False), ts))
    cx.commit()
    cx.close()


def store_list(module, since=None, limit=200, offset=0, q=None, **filters):
    cx = db()
    sql = "SELECT id,body,updated_at FROM store WHERE module=?"
    args = [module]
    if since:
        sql += " AND updated_at>=?"
        args.append(int(since))
    if q:
        sql += " AND body LIKE ?"
        args.append("%" + q + "%")
    sql += " ORDER BY updated_at DESC LIMIT ? OFFSET ?"
    args += [limit, offset]
    rows = cx.execute(sql, args).fetchall()
    cx.close()
    out = []
    for r in rows:
        try:
            b = json.loads(r["body"])
        except Exception:
            continue  # 损坏记录(body 非法 JSON)跳过, 避免下游崩
        if b is None:
            continue  # body 为 JSON null 的脏数据跳过
        out.append({"id": r["id"], "updated_at": r["updated_at"], "body": b})
    return out


# ---------------- 试卷导出 DOCX（零依赖，手工构建 OOXML） ----------------
IMG_TAG_RE = re.compile(r'<img[^>]*src=["\']([^"\']+)["\'][^>]*>', re.I)
HTML_TAG_RE = re.compile(r'<[^>]+>')
DOCX_CTYPE = "application/vnd.openxmlformats-officedocument.wordprocessingml.document"


def _img_dims(data):
    """从 PNG/JPEG/GIF 二进制头里取 (宽, 高)，取不到用 800x600。"""
    try:
        if data[:8] == b"\x89PNG\r\n\x1a\n" and len(data) > 24:
            w, h = struct.unpack(">II", data[16:24]); return w, h
        if data[:2] == b"\xff\xd8":
            i = 2
            while i < len(data) - 9:
                if data[i] != 0xFF:
                    i += 1; continue
                marker = data[i + 1]
                if marker in (0xC0, 0xC1, 0xC2, 0xC3, 0xC5, 0xC6, 0xC7,
                              0xC9, 0xCA, 0xCB, 0xCD, 0xCE, 0xCF):
                    h, w = struct.unpack(">HH", data[i + 5:i + 9]); return w, h
                i += 2 + struct.unpack(">H", data[i + 2:i + 4])[0]
        if data[:6] in (b"GIF87a", b"GIF89a"):
            w, h = struct.unpack("<HH", data[6:10]); return w, h
    except Exception:
        pass
    return 800, 600


def _disk_rel(rel):
    """逻辑 rel -> 磁盘上的(相对)文件名(ASCII, 各分量独立编码)。

    注意: Linux 单文件名上限约 255 字节。超长中文名 URL 编码后易超限 ->
    open 抛 [Errno 36] File name too long(上传 500)。因此对“编码后仍超 240
    字节”的单个分量, 改用其 md5 哈希(保留扩展名)作为磁盘名。哈希对原名
    确定, GET 时按同一规则还原即可命中。"""
    safe = []
    for p in rel.split("/"):
        if p == "":
            safe.append(p); continue
        enc = urlquote(p, safe="")
        if len(enc.encode("utf-8")) > 240:
            ext = p[p.rfind("."):] if "." in p else ""
            enc = hashlib.md5(p.encode("utf-8")).hexdigest() + ext
        safe.append(enc)
    return "/".join(safe)


def _sanitize_media_rel(rel):
    """归一化媒体逻辑路径：统一斜杠、去掉空段与 . / .. 段，返回不会越界的相对路径。
    用于写入侧（上传），避免 sub/name 里带 ../ 造成任意文件写入（路径穿越）。"""
    rel = (rel or "").replace("\\", "/")
    parts = []
    for seg in rel.split("/"):
        seg = seg.strip()
        if not seg or seg in (".", ".."):
            continue
        parts.append(seg)
    return "/".join(parts)


def _media_disk(rel):
    """逻辑媒体路径 -> 磁盘绝对路径(见 _disk_rel 的编码/超长处理说明)。"""
    return os.path.normpath(os.path.join(MEDIA_DIR, _disk_rel(rel)))


MEDIA_RE = re.compile(r'media://([^\s"\'<>]+\.(?:png|jpg|jpeg|gif|webp))', re.I)


def _file_rels(body):
    """返回 body.files[].rel（试卷附件等）。"""
    out = []
    if isinstance(body, dict):
        for f in (body.get("files") or []):
            if isinstance(f, dict):
                rel = (f.get("rel") or "").strip()
                if rel:
                    out.append(rel)
    return out


# /api/media/xxx 写法（训练错题 images/answerImages/files[].url 等用的就是这种）
MEDIA_PATH_RE = re.compile(r'/api/media/([^\s"\'<>\\]+)')
_REL_FIELD_RE = re.compile(r'"rel"\s*:\s*"([^"]+)"')


def _collect_refs(body):
    """收集一条记录引用的所有媒体 rel。
    同时兼容两种写法：media://sub/name（题库/试卷正文）与 /api/media/sub/name（训练错题数组），
    以及 files[].rel。用于判断删除后哪些文件不再被任何记录引用。"""
    refs = set()
    if not isinstance(body, dict):
        return refs
    txt = json.dumps(body, ensure_ascii=False)
    refs.update(MEDIA_RE.findall(txt))
    refs.update(MEDIA_PATH_RE.findall(txt))
    refs.update(_REL_FIELD_RE.findall(txt))
    refs.update(_file_rels(body))
    return {r for r in refs if r}


def _referenced_media():
    """扫描所有模块, 收集仍被引用的媒体 rel（题目图 media://、/api/media/ 数组图、试卷附件等）。
    用于清理孤儿文件时判断“哪些文件可以删”。"""
    refs = set()
    for m in MODULES:
        try:
            items = store_list(m, limit=100000)
        except Exception:
            continue
        for it in items:
            body = it.get("body") if isinstance(it, dict) else None
            refs |= _collect_refs(body)
    return refs


def _remove_media_file(rel):
    """删除一个媒体文件（对象存储 + 本地云端磁盘），返回释放字节数。"""
    freed = 0
    cl = _r2_client()
    if cl:
        try:
            cl.delete_object(Bucket=_r2_conf()["bucket"], Key=rel)
        except Exception:
            pass
    for fp in {_media_disk(rel), os.path.normpath(os.path.join(MEDIA_DIR, rel))}:
        try:
            if os.path.isfile(fp):
                freed += os.path.getsize(fp)
                os.remove(fp)
        except Exception:
            pass
    return freed


def purge_replaced_media(old_body, new_body):
    """记录被更新后，清掉“旧版引用过、新版不再引用”的图片/附件（新版已入库，故旧图安全删）。"""
    gone = _collect_refs(old_body) - _collect_refs(new_body)
    if gone:
        purge_media_refs(gone)


def _rmdirs_empty(base):
    """删除 base 下的空目录。"""
    for root, dirs, files in os.walk(base, topdown=False):
        for d in dirs:
            dp = os.path.join(root, d)
            try:
                if not os.listdir(dp):
                    os.rmdir(dp)
            except Exception:
                pass


def purge_media_refs(rels):
    """删除这些媒体文件，但跳过仍被其它记录引用的（防止误删错题与题库共用的图）。
    应在记录已从库里删除之后调用。返回 {removed, kept, freed}。"""
    rels = {r for r in (rels or set()) if r}
    if not rels:
        return {"removed": 0, "kept": 0, "freed": 0}
    still = _referenced_media()
    removed = kept = freed = 0
    for rel in rels:
        if rel in still:
            kept += 1
            continue
        before = freed
        freed += _remove_media_file(rel)
        if freed > before:
            removed += 1
        else:
            kept += 1
    if removed:
        _rmdirs_empty(MEDIA_DIR)
    return {"removed": removed, "kept": kept, "freed": freed}


def _safe_media_path(rel):
    """逻辑路径 -> 真实存在的磁盘路径(已做越界校验)；不存在返回 None。

    同时尝试“URL 编码落盘路径”和“旧版字面路径”两种方案，向后兼容。
    用 abspath 归一化斜杠/盘符，避免 Windows 下 / 与 \\ 混用导致 startswith 误判。
    """
    base = os.path.abspath(MEDIA_DIR)
    for fp in (_media_disk(rel), os.path.normpath(os.path.join(MEDIA_DIR, rel))):
        afp = os.path.abspath(fp)
        if afp.startswith(base + os.sep) and os.path.isfile(afp):
            return afp
    return None


def _media_file(src):
    """media://xxx 或 /api/media/xxx -> 本地文件路径；不存在返回 None。"""
    rel = src
    for pre in ("media://", "/api/media/"):
        if rel.startswith(pre):
            rel = rel[len(pre):]
            break
    return _safe_media_path(rel)


# ---------------- 对象存储(R2) + 图片压缩 + 自动清理 ----------------
def _s3_conf():
    """通用 S3 兼容对象存储配置。支持 腾讯云 COS 与 Cloudflare R2 两套环境变量。
    未配置完整则返回 None(回退本地磁盘)。优先读 COS 变量。"""
    # ---- 腾讯云 COS ----
    cid = os.environ.get("COS_SECRET_ID")
    ckey = os.environ.get("COS_SECRET_KEY")
    cbucket = os.environ.get("COS_BUCKET")
    cregion = os.environ.get("COS_REGION")
    cendpoint = os.environ.get("COS_ENDPOINT")
    if cid and ckey and cbucket:
        if not cendpoint and cregion:
            cendpoint = "https://cos.%s.myqcloud.com" % cregion
        if cendpoint:
            return {"provider": "cos", "access_key_id": cid, "secret": ckey,
                    "bucket": cbucket, "endpoint": cendpoint,
                    "region": cregion or "ap-guangzhou"}
    # ---- Cloudflare R2 ----
    aid = os.environ.get("R2_ACCOUNT_ID")
    key = os.environ.get("R2_ACCESS_KEY_ID")
    sec = os.environ.get("R2_SECRET_ACCESS_KEY")
    bucket = os.environ.get("R2_BUCKET")
    if aid and key and sec and bucket:
        return {"provider": "r2", "access_key_id": key, "secret": sec,
                "bucket": bucket, "endpoint": "https://%s.r2.cloudflarestorage.com" % aid,
                "region": "auto"}
    return None


def _s3_client():
    cfg = _s3_conf()
    if not cfg:
        return None
    try:
        import boto3
        from botocore.config import Config as _BC
        return boto3.client("s3", endpoint_url=cfg["endpoint"],
                            aws_access_key_id=cfg["access_key_id"],
                            aws_secret_access_key=cfg["secret"],
                            region_name=cfg["region"],
                            config=_BC(signature_version="s3v4",
                                       s3={"addressing_style": "virtual"}))
    except Exception:
        return None


def _s3_enabled():
    return _s3_client() is not None


# 兼容旧调用名(原有 R2 逻辑已泛化为 S3 兼容)
_r2_conf = _s3_conf
_r2_client = _s3_client
_r2_enabled = _s3_enabled


# 对象存储「是否存在该对象」缓存：避免每次读图都 HEAD 一次 COS。
# 写入成功置 True；迁移线程搬完旧图后置 True；其余情况 HEAD 后缓存结果。
_COS_HAS = {}


def _cos_has(rel):
    if rel in _COS_HAS:
        return _COS_HAS[rel]
    cl = _s3_client()
    if not cl:
        return False
    try:
        cl.head_object(Bucket=_s3_conf()["bucket"], Key=rel)
        _COS_HAS[rel] = True
        return True
    except Exception:
        _COS_HAS[rel] = False
        return False


def _guess_ct(name, data):
    ct = mimetypes.guess_type(name or "")[0]
    if ct:
        return ct
    if data[:4] == b"%PDF":
        return "application/pdf"
    if data[:2] == b"\xff\xd8":
        return "image/jpeg"
    if data[:8] == b"\x89PNG\r\n\x1a\n":
        return "image/png"
    if data[:4] == b"GIF8":
        return "image/gif"
    if data[:4] == b"RIFF" and data[8:12] == b"WEBP":
        return "image/webp"
    return "application/octet-stream"


def _put_media(rel, raw, name):
    """写入媒体：R2 启用则上传对象存储，否则写本地磁盘。
    图片原样存储（不做缩放/有损压缩），保证题目与截图清晰度。返回 (ok, url_or_err, code)。"""
    rel = _sanitize_media_rel(rel)
    if not rel:
        return False, "非法媒体路径", 400
    ct = _guess_ct(name, raw)
    cl = _r2_client()
    if cl:
        try:
            cl.put_object(Bucket=_r2_conf()["bucket"], Key=rel, Body=raw, ContentType=ct)
            _COS_HAS[rel] = True
            return True, "/api/media/" + rel, 200
        except Exception as e:
            return False, "对象存储上传失败: " + str(e), 500
    fp = _media_disk(rel)
    # 越界保护：归一化后必须仍在 MEDIA_DIR 内（防 ../ 穿越写任意位置）
    base = os.path.abspath(MEDIA_DIR)
    afp = os.path.abspath(fp)
    if not (afp == base or afp.startswith(base + os.sep)):
        return False, "非法媒体路径", 400
    os.makedirs(os.path.dirname(fp), exist_ok=True)
    with open(fp, "wb") as f:
        f.write(raw)
    return True, "/api/media/" + rel, 200


# ---------------- 媒体访问签名 ----------------
# 页面用 <img src> 展示图片，浏览器不会带 Authorization 头，所以图片接口过去是
# 完全公开的（只要知道路径就能看图）。这里改为「签名链接」：
#   客户端登录后取一张限时票据(?tk=&e=)，图片 URL 带上它才能读。
# 票据只用于读图、到期自动失效、且不是登录 token，即使出现在日志/截图里影响也有界。
MEDIA_TTL = int(os.environ.get("MEDIA_TTL", "86400"))   # 票据有效期(秒)，默认 24h


def _media_secret():
    """取（或首次生成）媒体签名密钥，存 meta 表，重启不失效。"""
    cx = db()
    try:
        r = cx.execute("SELECT v FROM meta WHERE k='media_secret'").fetchone()
        if r and r["v"]:
            return r["v"]
        s = secrets.token_hex(32)
        cx.execute("INSERT OR REPLACE INTO meta(k,v) VALUES('media_secret',?)", (s,))
        cx.commit()
        return s
    finally:
        cx.close()


def _media_sign(exp):
    return hashlib.sha256((_media_secret() + "|" + str(exp)).encode("utf-8")).hexdigest()[:40]


def media_ticket():
    """签发图片访问票据。"""
    exp = int(time.time()) + MEDIA_TTL
    return {"tk": _media_sign(exp), "exp": exp}


def media_ticket_ok(tk, exp):
    try:
        e = int(exp)
    except Exception:
        return False
    if e < int(time.time()):
        return False
    return secrets.compare_digest(str(tk or ""), _media_sign(e))


def _media_url(rel):
    """对象存储启用且「该对象已存在于云」时返回预签名 GET URL(302 重定向)；
    否则返回 None(走本地磁盘读)。这样迁移期间旧图仍在本地、新图已上云，
    读取自动路由，不出现 404 窗口。"""
    cl = _r2_client()
    if not cl:
        return None
    if not _cos_has(rel):
        return None
    try:
        return cl.generate_presigned_url("get_object",
            Params={"Bucket": _r2_conf()["bucket"], "Key": rel},
            ExpiresIn=int(os.environ.get("MEDIA_URL_TTL", "3600")))
    except Exception:
        return None


def _run_orphan_cleanup():
    """删除未被任何模块引用的上传文件(孤儿), 释放本地磁盘与对象存储。返回统计字典。"""
    refs = _referenced_media()
    keep_disk = {_disk_rel(r) for r in refs}
    freed = 0
    removed = 0
    for root, dirs, files in os.walk(MEDIA_DIR):
        for fn in files:
            fp = os.path.join(root, fn)
            raw_rel = os.path.relpath(fp, MEDIA_DIR).replace(os.sep, "/")
            decoded = urlunquote(raw_rel)
            if decoded.startswith("_exports/") or raw_rel.startswith("_exports/"):
                continue   # 导出的 Word 等文件，不作为孤儿清理
            if decoded in refs or raw_rel in refs or raw_rel in keep_disk:
                continue
            try:
                freed += os.path.getsize(fp)
                os.remove(fp)
                removed += 1
            except Exception:
                pass
    _rmdirs_empty(MEDIA_DIR)
    # 对象存储（启用时）：同步删除无人引用的对象，避免云端存储越积越多
    r2_removed = 0
    cl = _r2_client()
    if cl:
        try:
            bucket = _r2_conf()["bucket"]
            token = None
            while True:
                kw = {"Bucket": bucket, "MaxKeys": 1000}
                if token:
                    kw["ContinuationToken"] = token
                page = cl.list_objects_v2(**kw)
                for ob in (page.get("Contents") or []):
                    key = ob.get("Key")
                    if not key or key in refs:
                        continue
                    try:
                        cl.delete_object(Bucket=bucket, Key=key)
                        r2_removed += 1
                    except Exception:
                        pass
                if page.get("IsTruncated"):
                    token = page.get("NextContinuationToken")
                else:
                    break
        except Exception:
            pass
    return {"freed": freed, "removed": removed, "object_removed": r2_removed}


def _disk_watchdog():
    """后台线程：周期检查本地磁盘余量，低于阈值自动清理孤儿媒体，避免撑爆。"""
    import threading
    def loop():
        import time as _t
        while True:
            try:
                _t.sleep(int(os.environ.get("DISK_WATCH_INTERVAL", "600")))
                free = shutil.disk_usage(os.path.dirname(MEDIA_DIR) or ".").free
                thr = int(os.environ.get("DISK_LOW_THRESHOLD", str(200 * 1024 * 1024)))
                if free < thr:
                    _run_orphan_cleanup()
            except Exception:
                pass
    threading.Thread(target=loop, daemon=True).start()


def _migrate_media_to_r2():
    """把本地媒体批量上传到对象存储(键=逻辑 rel)。两段式：先全部上传(不删本地),
    全部成功后再统一删除本地副本释放盘, 避免「传到一半删本地」导致读取缺口。
    兼容 腾讯云 COS / Cloudflare R2。"""
    cl = _s3_client()
    if not cl:
        return {"ok": False, "error": "对象存储未配置"}
    bucket = _r2_conf()["bucket"]
    todo = []
    for root, dirs, files in os.walk(MEDIA_DIR):
        for fn in files:
            fp = os.path.join(root, fn)
            rel = urlunquote(os.path.relpath(fp, MEDIA_DIR).replace(os.sep, "/"))
            todo.append((fp, rel))
    done = errs = 0
    for fp, rel in todo:
        try:
            with open(fp, "rb") as f:
                data = f.read()
            cl.put_object(Bucket=bucket, Key=rel, Body=data, ContentType=_guess_ct(rel, data))
            _COS_HAS[rel] = True
            done += 1
        except Exception:
            errs += 1
    removed = 0
    if errs == 0:  # 全部上云成功才清本地, 否则保留本地副本(下次重跑可续传)
        for fp, rel in todo:
            try:
                os.remove(fp); removed += 1
            except Exception:
                pass
        _rmdirs_empty(MEDIA_DIR)
    return {"ok": True, "migrated": done, "errors": errs, "removed_local": removed}


# ---------------- 错题循环训练（间隔重复 / 艾宾浩斯简化） ----------------
TRAIN_MODULES = ["trainErrors", "trainCards", "trainTasks", "trainLogs"]
TRAIN_INTERVALS = [1, 2, 4, 7, 15, 30]  # 各掌握等级对应的间隔天数
TRAIN_DAILY_MAX = 3  # 每日练习题量上限（老师反馈 5~8 道太多写不完）


def _date_today():
    # 统一用北京时间(UTC+8)：Railway 服务器是 UTC, 直接 date.today() 在北京时间
    # 0点~8点之间会返回"昨天", 导致任务日期/错题日期/到期判断全部偏移一天。
    from datetime import datetime, timezone, timedelta
    return datetime.now(timezone(timedelta(hours=8))).date().isoformat()


def _date_after(d, n):
    from datetime import date, timedelta
    return (date.fromisoformat(d) + timedelta(days=n)).isoformat()


def _days_between(d1, d2):
    from datetime import date
    try:
        return (date.fromisoformat(d2) - date.fromisoformat(d1)).days
    except Exception:
        return 0


def purge_student_data(sid):
    """彻底删除某学生及其全部训练数据：错题、训练卡、作答日志、每日任务、草稿照片、账号、学生记录。
    返回各模块删除条数与媒体清理结果。供教师端「删除学生及全部数据」使用。"""
    if not sid:
        return {"ok": False, "error": "缺少学生"}
    # 1) 收集该生记录引用的媒体 rel（错题图 + 作答草稿照片），稍后清理不再被引用的部分
    refs = set()
    for mod in ("trainErrors", "trainLogs"):
        for it in store_list(mod, limit=100000):
            b = it.get("body") if isinstance(it, dict) else None
            if b and b.get("studentId") == sid:
                refs |= _collect_refs(b)
    # 2) 删除该生全部训练记录
    counts = {}
    for mod in ("trainErrors", "trainCards", "trainLogs", "trainTasks"):
        n = 0
        for it in store_list(mod, limit=100000):
            b = it.get("body") if isinstance(it, dict) else None
            if b and b.get("studentId") == sid:
                store_delete(mod, b.get("id"))
                n += 1
        counts[mod] = n
    # 3) 删除该生登录账号
    try:
        cx = db()
        cx.execute("DELETE FROM users WHERE student_id=?", (sid,))
        cx.commit(); cx.close()
    except Exception:
        pass
    # 4) 删除学生记录本身
    store_delete("students", sid)
    # 5) 清理不再被任何记录引用的媒体（草稿照片等；错题↔题库共用图会被保留）
    media = purge_media_refs(refs)
    counts["media"] = media
    counts["ok"] = True
    return counts


def train_card_id(student_id, error_id):
    return "c_%s_%s" % (student_id, error_id)


def _bank_mediarel(html):
    """从题库题的 HTML 里取出 media:// 相对路径（去 /api/media/ 前缀便于统一比较）。"""
    return re.findall(r"media://([^\"'\s>]+)", html or "")


def _bank_txt(html):
    """题库题 HTML 去标签后的纯文字。"""
    return re.sub(r"<[^>]+>", "", html or "").strip()


def _bank_key(stem, images, answer, answer_images):
    """题目内容指纹：题面文字 + 题图 + 答案文字 + 答案图。
    图片统一去掉 /api/media/ 前缀，使「错题(带 /api/media/ 前缀)」与「题库题(media:// 相对路径)」可比。"""
    norm = lambda u: (u or "").replace("/api/media/", "")
    return hashlib.md5("|".join([
        (stem or "").strip(),
        ",".join(sorted(norm(u) for u in (images or []))),
        (answer or "").strip(),
        ",".join(sorted(norm(u) for u in (answer_images or []))),
    ]).encode("utf-8")).hexdigest()


def train_error_to_bank(rec):
    """把一道错题的题目内容同步进题库，按内容去重（同一道题只存一条题库记录）。
    返回 (题库题目id, 是否新建)。无内容时返回 (None, 0)。

    去重要点：既比对错题转入标记(_eHash)，也把题库现有题的实际内容换算成同一指纹比对。
    否则「从题库选题 → 存为错题」时，原题没有 _eHash，会被误判为新题再存一份（题库翻倍）。
    """
    stem = rec.get("stem") or ""
    images = rec.get("images") or []
    answer = rec.get("analysis") or ""
    answer_images = rec.get("answerImages") or []
    if not (stem or images or answer or answer_images):
        return None, 0
    key = _bank_key(stem, images, answer, answer_images)
    # 已存在同题则直接复用，建立链接
    for q in store_list("questions", limit=5000):
        b = q.get("body") or {}
        if b.get("_eHash") == key:
            return b.get("id") or q.get("id"), 0
        if _bank_key(_bank_txt(b.get("content")), _bank_mediarel(b.get("content")),
                     _bank_txt(b.get("answer")), _bank_mediarel(b.get("answer"))) == key:
            # 命中题库现有题（含切题入库的）：回填标记便于以后快速命中，并复用其 id
            if b.get("_eHash") != key:
                b["_eHash"] = key
                store_put("questions", b.get("id") or q.get("id"), b)
            return b.get("id") or q.get("id"), 0
    # 构建媒体 HTML：用 media:// 相对路径，供教师端 pickQb 的 extractMediaRel 提取
    def media_html(urls):
        return "".join('<img src="media://%s">' % u.replace("/api/media/", "")
                       for u in urls)
    content = (("<p>%s</p>" % stem) if stem else "") + media_html(images)
    ans_html = (("<p>%s</p>" % answer) if answer else "") + media_html(answer_images)
    qid = "q_" + uuid.uuid4().hex[:12]
    # 归到老师指定的知识点；未指定则留空（不再自动挂到「错题自动收录」节点）
    kp_id = rec.get("kpId") or ""
    kp_name = rec.get("knowledgePoint") or ""
    body = {
        "id": qid,
        "content": content,
        "answer": ans_html,
        "knowledgePoint": kp_name,
        "kpId": kp_id,
        "type": "错题",
        "source": "错题转入",
        "grade": rec.get("grade") or "",
        "tags": rec.get("tags") or "",
        "_eHash": key,
        "createdAt": now_ms(),
        "updatedAt": now_ts(),
    }
    store_put("questions", qid, body)
    return qid, 1



def train_ensure_card(student_id, error_id, first_seen=None):
    cid = train_card_id(student_id, error_id)
    c, _ = store_get("trainCards", cid)
    if c:
        return c
    c = {"id": cid, "studentId": student_id, "errorId": error_id, "level": 0,
         "consecutiveRight": 0, "nextDueDate": _date_today(), "status": "active",
         "firstSeen": first_seen or _date_today(), "updatedAt": now_ms()}
    store_put("trainCards", cid, c)
    return c


def train_on_answer(card, result):
    """result: right / half / wrong / self_right / self_wrong"""
    right = result in ("right", "self_right")
    if right:
        card["consecutiveRight"] += 1
        card["level"] = min(card["level"] + 1, 5)
    else:
        card["consecutiveRight"] = 0
        card["level"] = max(card["level"] - 1, 0)
        card["nextDueDate"] = _date_after(_date_today(), 1)  # 错了明天必见
        card["updatedAt"] = now_ms()
        store_put("trainCards", card["id"], card)
        return
    # 毕业判定：连续对3次 且 首次收录≥14天 且 等级到顶(level>=4)
    if (card["consecutiveRight"] >= 3 and card["level"] >= 4
            and _days_between(card["firstSeen"], _date_today()) >= 14):
        card["status"] = "month_pool"  # 毕业, 进月度抽检池
    else:
        card["nextDueDate"] = _date_after(_date_today(), TRAIN_INTERVALS[card["level"]])
    card["updatedAt"] = now_ms()
    store_put("trainCards", card["id"], card)


def train_answered_ids(task_id):
    """该任务下已提交过的错题 id 集合（按 trainLogs 判断）。"""
    out = set()
    for l in store_list("trainLogs", limit=20000):
        b = l.get("body") or {}
        if b.get("taskId") == task_id:
            out.add(b.get("errorId"))
    return out


def _student_practiced_ids(student_id):
    """该学生「已经练过」（有作答流水）的错题 id 集合。"""
    out = set()
    for l in store_list("trainLogs", limit=20000):
        b = l.get("body") or {}
        if b.get("studentId") == student_id and b.get("errorId"):
            out.add(b["errorId"])
    return out


def _error_in_generated_task(student_id, error_id):
    """该错题是否已进入该学生某天「已生成」的练习任务（看答案前的归属校验）。"""
    for tk in store_list("trainTasks", limit=6000):
        b = tk.get("body") or {}
        if (b.get("studentId") == student_id and b.get("generated")
                and error_id in (b.get("errorIds") or [])):
            return True
    return False


_UPLOADED_CACHE = {}


def _student_uploaded_today(student_id, date_str=None):
    """学生当天是否已上传过作答照片（本地盘或对象存储里有 train/<sid>/drafts/<date>/ 文件）。
    用于「先上传照片、再看答案」的服务端强制校验。结果缓存 60 秒。"""
    date_str = date_str or _date_today()
    key = (student_id, date_str)
    now = time.time()
    hit = _UPLOADED_CACHE.get(key)
    if hit and now - hit[0] < 60:
        return True
    ok = False
    rel = "train/%s/drafts/%s" % (student_id, date_str)
    try:
        d = _media_disk(rel)
        if d and os.path.isdir(d):
            with os.scandir(d) as it:
                ok = any(True for _ in it)
    except Exception:
        pass
    if not ok:
        cl = _r2_client()
        if cl:
            try:
                page = cl.list_objects_v2(Bucket=_r2_conf()["bucket"], Prefix=rel + "/", MaxKeys=1)
                ok = bool(page.get("Contents"))
            except Exception:
                pass
    if ok:
        _UPLOADED_CACHE[key] = (now, True)   # 只缓存「已上传」，避免阴性结果把之后的正常放行也挡掉
    return ok

def train_task_all_answered(task):
    """该任务的题是否全部提交过（按 trainLogs 判断）。"""
    ids = set(task.get("errorIds") or [])
    if not ids:
        return False
    return ids <= train_answered_ids(task.get("id"))


def train_heal_task_status(task):
    """旧数据自愈：题已全部提交、状态却还是 partial（早期按正确率判定留下的），纠正为 done。
    否则学生答完但做错过题，再次进入时「最近一周错题」会被永久锁住。"""
    if task and task.get("status") == "partial" and train_task_all_answered(task):
        task["status"] = "done"
        store_put("trainTasks", task["id"], task)
    return task


def train_build_daily(student_id, date_str, include_new=True):
    """为某学生生成某天应练的错题卡（到期错题优先, 新课巩固补充, 不足则提前拉取）。
    每日题量上限取该学生自定的 dailyCount（默认 TRAIN_DAILY_MAX=3 道），
    不同学生能力/时间不同，题量也应不同。

    名额分配(修复旧漏洞)：至少留 max(1, daily_max//2) 道给「新课巩固」池，避免
    旧到期卡永远占满全部名额、新收录的错题长期排不进去（学生一落后就卡死在老题上）。"""
    stu, _ = store_get("students", student_id)
    try:
        daily_max = int((stu or {}).get("dailyCount", TRAIN_DAILY_MAX) or TRAIN_DAILY_MAX)
    except Exception:
        daily_max = TRAIN_DAILY_MAX
    if daily_max < 1:
        daily_max = 1
    cards = [c["body"] if isinstance(c, dict) else c for c in
             store_list("trainCards", limit=3000)]
    due = [c for c in cards if c.get("studentId") == student_id
           and c.get("status") == "active" and c.get("nextDueDate", "") <= date_str]
    due.sort(key=lambda c: (c.get("level", 0),
                            -_days_between(c.get("nextDueDate", date_str), date_str)))
    # 新课巩固池：近7天收录且仍 level0 的错题
    new_pool = []
    if include_new:
        new_errs = [e["body"] for e in store_list("trainErrors", limit=3000)]
        for e in new_errs:
            if e.get("studentId") != student_id:
                continue
            cid = train_card_id(student_id, e["id"])
            c = next((x for x in cards if x.get("id") == cid), None)
            if c and c.get("level", 0) == 0 and _days_between(c.get("firstSeen", date_str), date_str) <= 7:
                new_pool.append(c)
    new_ids = {c.get("errorId") for c in new_pool}
    new_quota = max(1, daily_max // 2) if new_pool else 0
    picked = []
    picked_ids = set()
    # 1) 先取新课巩固（限量），保证新错题至少露面
    for c in new_pool:
        if len(picked) >= new_quota:
            break
        eid = c.get("errorId")
        if eid in picked_ids:
            continue
        picked.append(c); picked_ids.add(eid)
    # 2) 用到期卡填满剩余名额
    for c in due:
        if len(picked) >= daily_max:
            break
        eid = c.get("errorId")
        if eid in picked_ids:
            continue
        picked.append(c); picked_ids.add(eid)
    # 3) 仍不满(到期卡不够)：用新课巩固剩余补齐，绝不因配额而少派
    if len(picked) < daily_max:
        for c in new_pool:
            if len(picked) >= daily_max:
                break
            eid = c.get("errorId")
            if eid in picked_ids:
                continue
            picked.append(c); picked_ids.add(eid)
    # 4) 仍不满：拉即将到期的(未来1天内)
    if len(picked) < daily_max:
        up = [c for c in cards if c.get("studentId") == student_id
              and c.get("status") == "active" and c.get("nextDueDate", "") > date_str
              and _days_between(date_str, c.get("nextDueDate", date_str)) <= 1]
        up.sort(key=lambda c: c.get("nextDueDate", date_str))
        for c in up:
            if c.get("errorId") not in picked_ids:
                picked.append(c); picked_ids.add(c.get("errorId"))
            if len(picked) >= daily_max:
                break
    return picked


def train_monthly_sample(student_id, date_str):
    """每月1号从 month_pool 抽取≤题量(约20%)降级回 active, 混入当天任务；上限不超过该生每日题数。"""
    cards = [c["body"] for c in store_list("trainCards", limit=3000)]
    pool = [c for c in cards if c.get("studentId") == student_id and c.get("status") == "month_pool"]
    if not pool:
        return []
    stu, _ = store_get("students", student_id)
    try:
        dmax = int((stu or {}).get("dailyCount", TRAIN_DAILY_MAX) or TRAIN_DAILY_MAX)
    except Exception:
        dmax = TRAIN_DAILY_MAX
    cap = max(1, min(3, dmax))
    k = min(cap, max(1, round(len(pool) * 0.2)))
    import random
    random.seed(student_id + date_str)
    chosen = random.sample(pool, min(k, len(pool)))
    for c in chosen:
        c["status"] = "active"
        c["nextDueDate"] = date_str
        c["updatedAt"] = now_ms()
        store_put("trainCards", c["id"], c)
    return chosen


def train_task_error_ids(student_id, date_str):
    """算出某学生某天应练的错题 id 列表（去重 + 剔除已删错题）。
    生成任务与「改每天题数后立即重建」共用同一套逻辑，保证口径一致。"""
    cards = train_build_daily(student_id, date_str)
    # 去重：同一题被重复收录多条(相同题面+相同图片)时只出一次；
    # 已被删除的错题卡片也在此处自动剔除。
    err_ids = []
    seen_keys = set()
    for c in cards:
        eid = c.get("errorId")
        e, _ = store_get("trainErrors", eid)
        if not e:
            continue
        key = ((e.get("stem") or ""), tuple(e.get("images") or []),
               tuple(e.get("answerImages") or []))
        if key in seen_keys:
            continue
        seen_keys.add(key)
        err_ids.append(eid)
    return err_ids


def train_rebuild_today_task(student_id, date_str=None):
    """按学生当前的 dailyCount 重建「今天」的任务题单。
    只在今天已生成正式任务、且学生还没作答(done/partial)时才重建，避免抹掉作答记录。
    返回重建后的题数；未重建返回 None。"""
    date_str = date_str or _date_today()
    tid = "t_%s_%s" % (student_id, date_str)
    task, _ = store_get("trainTasks", tid)
    if not task or not task.get("generated"):
        return None
    if task.get("status") in ("done", "partial"):
        return None      # 已作答：保留原题单，避免把已交的题换掉
    task["errorIds"] = train_task_error_ids(student_id, date_str)
    task["updatedAt"] = now_ms()
    store_put("trainTasks", tid, task)
    return len(task["errorIds"])


def train_generate_tasks(date_str=None, student_ids=None):
    """为全体学生(或指定 student_ids)生成某天任务包(覆盖式)。返回生成统计。
    student_ids 非空时只给这些学生生成，其余学生任务不动（用于按学生单独派发）。"""
    date_str = date_str or _date_today()
    students = [s["body"] for s in store_list("students", limit=2000)]
    if student_ids:
        wanted = set(str(x).strip() for x in student_ids if str(x).strip())
        students = [s for s in students if s.get("id") in wanted]
    if date_str[8:10] == "01":  # 每月1号先月度抽检
        for s in students:
            train_monthly_sample(s.get("id"), date_str)
    made = 0
    for s in students:
        sid = s.get("id")
        if not sid:
            continue
        err_ids = train_task_error_ids(sid, date_str)
        tid = "t_%s_%s" % (sid, date_str)
        task = {"id": tid, "studentId": sid, "date": date_str,
                "errorIds": err_ids, "status": "pending",
                "generated": True,   # 仅老师点「生成今日任务」才算正式任务，学生端据此放行
                "score": None, "finishedAt": None, "updatedAt": now_ms()}
        # 保留已有完成状态(若当天已做过则不全覆盖)
        old, _ = store_get("trainTasks", tid)
        if old and old.get("status") in ("done", "partial"):
            # 学生若已在「自动任务」上作答过，则把该任务收编为正式任务，避免作答记录被隐藏
            if not old.get("generated"):
                old["generated"] = True
                old["updatedAt"] = now_ms()
                store_put("trainTasks", tid, old)
            continue
        store_put("trainTasks", tid, task)
        made += 1
    return {"ok": True, "date": date_str, "students": made}


def train_reviewed_tasks(student_id):
    """该学生被老师「已阅」过的任务，按日期倒序。"""
    out = []
    for t in store_list("trainTasks", limit=8000):
        b = t.get("body") or {}
        if b.get("studentId") == student_id and b.get("reviewed"):
            out.append(b)
    out.sort(key=lambda x: (x.get("date") or ""), reverse=True)
    return out


def _review_payload(task, is_today):
    return {"date": task.get("date") or "",
            "comment": (task.get("reviewComment") or "").strip(),
            "reviewedAt": task.get("reviewedAt"),
            "isToday": bool(is_today)}


def train_pick_review(student_id, date_str, finished=False, today=None):
    """学生端该显示哪条评语：
    - 今天的任务已被老师阅过 → 显示今天的（不论是否提交完）；
    - 今天还没全部提交（含今天没有任务）→ 显示最近一次已阅，即"前一天的评语"；
    - 今天已全部提交、老师还没阅今天的 → 不显示旧评语（避免和"已完成"混淆）。"""
    if today and today.get("reviewed"):
        return _review_payload(today, True)
    if finished:
        return None
    for t in train_reviewed_tasks(student_id):
        if (t.get("date") or "") < date_str:
            return _review_payload(t, False)
    return None


def train_student_today(student_id, date_str=None):
    """返回某学生当天的任务(含错题明细)。
    只有老师点了「生成今日任务」后才存在任务；未生成前学生端应显示"今天还没有练习"，
    不能看到刚录入、尚未进入当日任务的错题。"""
    date_str = date_str or _date_today()
    tid = "t_%s_%s" % (student_id, date_str)
    task, _ = store_get("trainTasks", tid)
    if not task or not task.get("generated"):
        # 今天还没生成任务：把最近一次的评语继续带出来（新的一天提交前仍能看到）
        return {"task": None, "items": [],
                "review": train_pick_review(student_id, date_str)}
    train_heal_task_status(task)   # 旧数据自愈：答完却没记成 done 的纠正过来
    # 已答/总题数一并下发，学生端据此判断"今天是否已全部完成"（不单纯依赖 status 字段）
    need = set(task.get("errorIds") or [])
    done_ids = train_answered_ids(task.get("id"))
    answered_n = len(need & done_ids)
    finished = bool(need) and need <= done_ids
    items = []
    for eid in task.get("errorIds", []):
        e, _ = store_get("trainErrors", eid)
        if not e:
            continue
        # 学生端不下发答案/解析/答案图(答案在上传计算过程后通过 /reveal 获取)
        pub = {k: v for k, v in e.items() if k not in ("answer", "analysis", "answerImages")}
        pub["answered"] = eid in done_ids   # 今天这题是否已交过（中途退出再进来时无需重填）
        items.append(pub)
    return {"task": task, "items": items,
            "answered": answered_n, "total": len(need),
            "review": train_pick_review(student_id, date_str, finished=finished, today=task)}


def train_student_recent(student_id, days=14):
    """学生端「近期表现」：近 days 天的练习量/正确率/连续打卡等，用于激励展示。
    按北京时间(与 _date_today 一致)统计，避免跨零点日期偏移。"""
    from datetime import date, timedelta
    try:
        days = max(1, min(int(days or 14), 60))
    except Exception:
        days = 14
    today = date.fromisoformat(_date_today())
    day_map = {}
    for d in range(days):
        dt = today - timedelta(days=d)
        day_map[dt.isoformat()] = {"date": dt.isoformat(), "dd": dt.day, "n": 0, "right": 0}
    total = 0
    for it in store_list("trainLogs", limit=100000):
        b = it.get("body") if isinstance(it, dict) else None
        if not b or (b.get("studentId") or "") != student_id:
            continue
        ad = (b.get("answerDate") or b.get("date") or "").strip()
        if ad in day_map:
            day_map[ad]["n"] += 1
            if b.get("result") in ("right", "self_right"):
                day_map[ad]["right"] += 1
        if ad:
            total += 1
    seq = sorted(day_map.keys())                      # 升序（旧→新）
    last7 = seq[-7:] if days >= 7 else seq
    week_n = sum(day_map[k]["n"] for k in last7)
    week_right = sum(day_map[k]["right"] for k in last7)
    week_acc = round(week_right / week_n * 100) if week_n else 0
    week_days = sum(1 for k in last7 if day_map[k]["n"] > 0)
    # 连续打卡：从今天起向前数连续有练习的天（今天没练则从昨天起算，不算断）
    streak = 0
    start = 0
    if day_map.get(today.isoformat(), {}).get("n", 0) == 0:
        start = 1
    for d in range(start, days):
        dt = today - timedelta(days=d)
        if day_map.get(dt.isoformat(), {}).get("n", 0) > 0:
            streak += 1
        else:
            break
    days_list = []
    for k in seq:
        x = day_map[k]
        x["a"] = round(x["right"] / x["n"] * 100) if x["n"] else 0
        days_list.append(x)
    return {
        "streak": streak, "weekCount": week_n, "weekAcc": week_acc,
        "totalCount": total, "weekGoal": 5, "weekGoalDone": week_days,
        "days": days_list,
    }


def train_submit(student_id, date_str, answers):
    """学生提交：自动判分 + 更新卡片 + 写流水 + 更新任务。返回逐题结果。"""
    date_str = date_str or _date_today()
    tid = "t_%s_%s" % (student_id, date_str)
    task, _ = store_get("trainTasks", tid)
    if not task:
        return {"ok": False, "error": "今日任务不存在"}
    need = set(task.get("errorIds") or [])   # 本任务题单：submit 只接受题单内的题
    # 今天这题是否已经交过（学生中途退出后再进来重做时，不重复记流水/不重复推进卡片等级）
    prev = {}
    for l in store_list("trainLogs", limit=20000):
        b = l.get("body") or {}
        if b.get("taskId") == tid and b.get("errorId"):
            prev[b["errorId"]] = b
    results = []
    new_n = 0
    for a in answers:
        eid = a.get("errorId")
        e, _ = store_get("trainErrors", eid)
        if not e:
            continue
        # 归属 + 题单范围校验：只接受「本学生名下、且在今天任务题单里」的错题，
        # 防止学生构造 errorId 把别人的错题「提交」到自己名下（否则可借自动建卡再套答案）。
        if (e.get("studentId") or "") != student_id or eid not in need:
            continue
        result = a.get("result")  # right/half/wrong/self_right/self_wrong
        qans = (e.get("answer") or "").strip()
        # 客观题自动判分(仅当明确给出 submittedAnswer 且为标准题)
        if qans and a.get("submittedAnswer") is not None and result in (None, "", "auto"):
            norm = lambda s: re.sub(r"\s+", "", str(s)).lower()
            result = "right" if norm(a.get("submittedAnswer")) == norm(qans) else "wrong"
        if eid in prev:
            results.append({"errorId": eid, "result": prev[eid].get("result"),
                            "answer": qans, "analysis": e.get("analysis") or "",
                            "answerImages": e.get("answerImages") or [],
                            "stem": e.get("stem") or "", "already": True})
            continue
        cid = train_card_id(student_id, eid)
        c, _ = store_get("trainCards", cid)
        if not c:
            c = train_ensure_card(student_id, eid)
        train_on_answer(c, result)
        lid = "log_%s_%s_%d" % (student_id, eid, now_ms())
        log = {"id": lid, "studentId": student_id, "errorId": eid, "taskId": tid,
               "answerDate": date_str, "date": _date_today(), "result": result,
               "submittedAnswer": a.get("submittedAnswer") or "",
               "draftImage": (a.get("draftImage") or "").strip(),
               "draftImages": a.get("draftImages") or [],
               "errorNote": (a.get("errorNote") or "").strip(),
               "durationSec": a.get("durationSec") or 0, "updatedAt": now_ms()}
        store_put("trainLogs", lid, log)
        prev[eid] = log
        new_n += 1
        results.append({"errorId": eid, "result": result,
                        "answer": qans, "analysis": e.get("analysis") or "",
                        "answerImages": e.get("answerImages") or [],
                        "stem": e.get("stem") or ""})
    # 分数/状态按该任务的全部流水重算（含本次与今天之前已交的题）
    answered = [prev[e] for e in need if e in prev]
    total = len(answered)
    right_n = sum(1 for b in answered if b.get("result") in ("right", "self_right"))
    if total:
        task["score"] = round(right_n / total, 2)
        # 状态按「完成度」判定（不是正确率）：今天的题全部提交过就是 done，否则 partial。
        task["status"] = "done" if (need and need <= set(prev)) else "partial"
        task["finishedAt"] = now_ms()
        task["updatedAt"] = now_ms()
        store_put("trainTasks", tid, task)
    return {"ok": True, "score": task.get("score"), "total": total,
            "right": right_n, "results": results, "new": new_n}


def train_dashboard(date_str=None):
    """老师看板数据：指定日期(默认今天)任务概况 + 每生掌握进度。"""
    students = [s["body"] for s in store_list("students", limit=2000)]
    today = date_str or _date_today()
    only_gen = (today == _date_today())   # 当天视图只认老师正式生成的任务，屏蔽学生端触发的残留任务
    tasks_today = [t["body"] for t in store_list("trainTasks", limit=4000)
                   if t["body"].get("date") == today
                   and (t["body"].get("generated") or not only_gen)]
    # 只有「全部题目都提交过」(done) 才算今日完成；partial=只提交了一部分
    done = sum(1 for t in tasks_today if t.get("status") == "done")
    cards = [c["body"] for c in store_list("trainCards", limit=6000)]
    per_student = []
    for s in students:
        sid = s.get("id")
        sc = [c for c in cards if c.get("studentId") == sid]
        mastered = sum(1 for c in sc if c.get("status") == "month_pool")
        active = sum(1 for c in sc if c.get("status") == "active")
        new0 = sum(1 for c in sc if c.get("status") == "active" and c.get("level", 0) == 0)
        t = next((x for x in tasks_today if x.get("studentId") == sid), None)
        per_student.append({"id": sid, "name": s.get("name") or s.get("username") or "",
                            "active": active, "mastered": mastered, "new": new0,
                            "todayStatus": t.get("status") if t else "none",
                            "todayScore": t.get("score") if t else None,
                            "todayReviewed": bool(t.get("reviewed")) if t else False,
                            "todayReviewComment": (t.get("reviewComment") or "") if t else "",
                            "todayTaskId": t.get("id") if t else None})
    return {"todayDate": today, "studentsTotal": len(students),
            "tasksToday": len(tasks_today), "doneToday": done,
            "perStudent": per_student}


def _content_segments(html):
    """题干 HTML -> [("text", s) | ("img", 本地路径)] 序列。"""
    segs = []
    pos = 0
    for m in IMG_TAG_RE.finditer(html or ""):
        before = html_mod_unescape(HTML_TAG_RE.sub("", (html or "")[pos:m.start()])).strip()
        if before:
            segs.append(("text", before))
        fp = _media_file(m.group(1))
        if fp:
            segs.append(("img", fp))
        pos = m.end()
    tail = html_mod_unescape(HTML_TAG_RE.sub("", (html or "")[pos:])).strip()
    if tail:
        segs.append(("text", tail))
    return segs


def html_mod_unescape(s):
    import html as _html
    return _html.unescape(s)


def build_train_errors_docx(name, errors, title=None, note=None,
                            with_answers=True, blank_lines=0, header=None):
    """把某学生的错题导出为 Word（复用组卷导出的排版：题面 + 答案/解析 + 图片）。
    with_answers=False 时只印题目（供学生做题前打印出来在纸上作答，不含任何答案/解析/答案图）。"""
    qmap = {}
    ids = []
    for i, e in enumerate(errors, 1):
        qid = "te%d" % i
        imgs = [u for u in (e.get("images") or []) if isinstance(u, str)]
        content = (("<p>%s</p>" % e["stem"]) if e.get("stem") else "") + \
                  "".join('<img src="%s">' % u for u in imgs)
        ans = []
        if with_answers:
            aimgs = [u for u in (e.get("answerImages") or []) if isinstance(u, str)]
            if e.get("analysis"):
                ans.append("<p>答案：%s</p>" % e["analysis"])
            elif aimgs:
                ans.append("<p>答案：</p>")
            ans += ['<img src="%s">' % u for u in aimgs]
            atts = [f.get("name") for f in (e.get("files") or [])
                    if isinstance(f, dict) and f.get("name")]
            if atts:
                ans.append("<p>附件：%s（请在手机上查看）</p>" % "、".join(atts))
        qmap[qid] = {"content": content, "answer": "".join(ans),
                     "type": e.get("knowledgePoint") or "错题",
                     "qid": e.get("wrongDate") or ""}
        ids.append(qid)
    paper = {"title": title or ((name or "学生") + " 错题本"),
             "note": note or ("共 %d 道错题　导出日期 %s" % (len(ids), _date_today())),
             "header": header, "blankLines": blank_lines,
             "questionIds": ids}
    return build_paper_docx(paper, qmap)


def _p_text(text, bold=False, sz=22):
    rpr = "<w:rPr>%s<w:sz w:val=\"%d\"/></w:rPr>" % ("<w:b/>" if bold else "", sz)
    return ("<w:p><w:r>%s<w:t xml:space=\"preserve\">%s</w:t></w:r></w:p>"
            % (rpr, xesc(text)))


_EMU_MAX = 5400000  # 约 5.9 英寸页宽（试卷正文可用宽度）
_EMU_PER_IN = 914400  # 1 英寸 = 914400 EMU
_PRINT_DPI = 220      # 图片在 Word 中的目标打印清晰度（不低于此值即清晰）


def _p_image(rid, idx, cx, cy):
    return (
        '<w:p><w:r><w:drawing>'
        '<wp:inline distT="0" distB="0" distL="0" distR="0" '
        'xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing">'
        '<wp:extent cx="%d" cy="%d"/><wp:docPr id="%d" name="img%d"/>'
        '<a:graphic xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">'
        '<a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture">'
        '<pic:pic xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture">'
        '<pic:nvPicPr><pic:cNvPr id="%d" name="img%d"/><pic:cNvPicPr/></pic:nvPicPr>'
        '<pic:blipFill><a:blip r:embed="%s"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill>'
        '<pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="%d" cy="%d"/></a:xfrm>'
        '<a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr>'
        '</pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r></w:p>'
        % (cx, cy, idx, idx, idx, idx, rid, cx, cy))


def build_paper_docx(paper, questions_map):
    """paper: {title, note, questionIds}; questions_map: id -> body。返回 docx 字节。"""
    paras = []
    rels = []          # (rid, target)
    media = []         # (arcname, bytes)
    img_idx = 0

    paras.append(_p_text(paper.get("title") or "试卷", bold=True, sz=32))
    if paper.get("note"):
        paras.append(_p_text(paper["note"], sz=20))
    if paper.get("header"):
        paras.append(_p_text(paper["header"], sz=20))
    paras.append(_p_text("", sz=12))

    blank_lines = int(paper.get("blankLines") or 0)  # 每题下方留白，供打印后在纸上作答
    ids = paper.get("questionIds") or []
    for i, qid in enumerate(ids, 1):
        qb = questions_map.get(qid) or {}
        head = "%d. %s%s" % (i, qb.get("type") or "", ("　" + qb["qid"]) if qb.get("qid") else "")
        paras.append(_p_text(head, bold=True, sz=22))
        for kind, val in (_content_segments(qb.get("content") or "")
                          + _content_segments(qb.get("answer") or "")
                          + _content_segments(qb.get("analysis") or "")):
            if kind == "text":
                paras.append(_p_text(val))
            else:
                try:
                    with open(val, "rb") as f:
                        data = f.read()
                except Exception:
                    continue
                ext = os.path.splitext(val)[1].lstrip(".").lower() or "png"
                if ext == "jpg":
                    ext = "jpeg"
                img_idx += 1
                w, h = _img_dims(data)
                # 统一按「页面可用宽度」铺满：题目截图通常像素不多，
                # 若按原尺寸(pt)排版会很小、打印看不清；放大不超过 3 倍以免糊。
                nat_w = int(w * _EMU_PER_IN / _PRINT_DPI)
                nat_h = int(h * _EMU_PER_IN / _PRINT_DPI)
                target = _EMU_MAX
                if nat_w * 3 < target:
                    target = nat_w * 3
                cx = target
                cy = int(nat_h * target / max(nat_w, 1))
                rid = "rId%d" % (100 + img_idx)
                arc = "word/media/img%d.%s" % (img_idx, ext)
                rels.append((rid, "media/img%d.%s" % (img_idx, ext)))
                media.append((arc, data))
                paras.append(_p_image(rid, img_idx, cx, cy))
        paras.append(_p_text("", sz=12))
        for _ in range(blank_lines):   # 打印版：每题下方留白
            paras.append('<w:p><w:r><w:rPr><w:sz w:val="22"/></w:rPr><w:t xml:space="preserve">　</w:t></w:r></w:p>')

    doc = ('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
           '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" '
           'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">'
           '<w:body>' + "".join(paras) +
           '<w:sectPr><w:pgSz w:w="11906" w:h="16838"/>'
           '<w:pgMar w:top="1200" w:right="1100" w:bottom="1200" w:left="1100"/></w:sectPr>'
           '</w:body></w:document>')

    rels_xml = ('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
                '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
                + "".join('<Relationship Id="%s" Type="http://schemas.openxmlformats.org/officeDocument/'
                          '2006/relationships/image" Target="%s"/>' % (rid, tgt)
                          for rid, tgt in rels)
                + "</Relationships>")

    default_exts = {"rels": "application/vnd.openxmlformats-package.relationships+xml",
                    "xml": "application/xml", "png": "image/png", "jpeg": "image/jpeg",
                    "gif": "image/gif", "webp": "image/webp", "bmp": "image/bmp"}
    used_exts = {os.path.splitext(a)[1].lstrip(".") for a, _ in media}
    ct = ('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
          '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
          + "".join('<Default Extension="%s" ContentType="%s"/>' % (e, default_exts.get(e, "application/octet-stream"))
                    for e in sorted(set(default_exts) | used_exts))
          + '<Override PartName="/word/document.xml" ContentType="' + DOCX_CTYPE + '.main+xml"/>'
          "</Types>")

    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as z:
        z.writestr("[Content_Types].xml", ct)
        z.writestr("_rels/.rels",
                   '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
                   '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
                   '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/'
                   'relationships/officeDocument" Target="word/document.xml"/></Relationships>')
        z.writestr("word/document.xml", doc)
        z.writestr("word/_rels/document.xml.rels", rels_xml)
        for arc, data in media:
            z.writestr(arc, data)
    return buf.getvalue()


def train_paper_resolve(paper):
    """把 paper.questionIds 解析成题目明细(content/answer/analysis 含 media:// 引用), 供学生端渲染。"""
    ids = paper.get("questionIds") or []
    qmap = {i["id"]: i["body"] for i in store_list("questions", limit=5000)}
    qs = []
    for qid in ids:
        b = qmap.get(qid) or {}
        qs.append({
            "id": qid,
            "type": b.get("type") or "",
            "content": b.get("content") or "",
            "answer": b.get("answer") or "",
            "analysis": b.get("analysis") or "",
            "kpId": b.get("kpId") or "",
        })
    return qs


def store_tombstone(module, id, ts=None):
    """记录删除墓碑（用于双向删除同步）。删除时间取 ts 或当前时间。"""
    ts = ts or now_ms()
    cx = db()
    cx.execute("INSERT INTO tombstones(module,id,deleted_at) VALUES(?,?,?) "
               "ON CONFLICT(module,id) DO UPDATE SET deleted_at=excluded.deleted_at",
               (module, id, ts))
    cx.commit()
    cx.close()


def store_delete(module, id):
    cx = db()
    cx.execute("DELETE FROM store WHERE module=? AND id=?", (module, id))
    cx.commit()
    cx.close()
    store_tombstone(module, id)


# ---------------- 认证 ----------------
def auth_user(username, pw):
    cx = db()
    r = cx.execute("SELECT * FROM users WHERE username=?", (username,)).fetchone()
    cx.close()
    if not r or r["pw_hash"] != pw_hash(pw):
        return None
    return r


# ---- 登录防爆破：同一「用户名+来源IP」90 秒内失败满 5 次，锁到窗口结束 ----
_LOGIN_FAILS = {}          # key -> [失败次数, 窗口起始时间]
_LOGIN_LOCK = threading.Lock()
_LOGIN_WINDOW = 90
_LOGIN_MAX = 5


def login_throttle(key, ok):
    """记录一次登录结果；返回还需等待的秒数（0 表示放行）。"""
    now = time.time()
    with _LOGIN_LOCK:
        if ok:
            _LOGIN_FAILS.pop(key, None)
            return 0
        if len(_LOGIN_FAILS) > 5000:      # 兜底：防止异常来源把内存撑大
            _LOGIN_FAILS.clear()
        ent = _LOGIN_FAILS.get(key)
        if not ent or now - ent[1] > _LOGIN_WINDOW:
            _LOGIN_FAILS[key] = [1, now]
            return 0
        ent[0] += 1
        if ent[0] >= _LOGIN_MAX:
            return max(1, int(_LOGIN_WINDOW - (now - ent[1])))
        return 0


def new_session(user_id):
    token = secrets.token_hex(24)
    exp = now_ts() + 60 * 60 * 24 * 30  # 30 天
    cx = db()
    cx.execute("INSERT INTO sessions(token,user_id,expires) VALUES(?,?,?)", (token, user_id, exp))
    cx.commit()
    cx.close()
    return token


def user_of(token):
    if not token:
        return None
    cx = db()
    r = cx.execute("SELECT s.user_id,u.role,u.username,u.student_id FROM sessions s JOIN users u ON u.id=s.user_id "
                   "WHERE s.token=? AND s.expires>?", (token, now_ts())).fetchone()
    cx.close()
    return dict(r) if r else None


# ---------------- 工具 ----------------
def send_json(h, obj, code=200):
    data = json.dumps(obj, ensure_ascii=False).encode("utf-8")
    h.send_response(code)
    h.send_header("Content-Type", "application/json; charset=utf-8")
    h.send_header("Content-Length", str(len(data)))
    h.send_cors()
    h.end_headers()
    h.wfile.write(data)
    h._responded = True


def _sniff_content_type(path):
    """按文件头魔数判定图片类型, 避免转码(PNG->JPEG)后扩展名与真实格式不符导致手机端无法渲染。"""
    try:
        with open(path, "rb") as f:
            head = f.read(12)
        if head[:8] == b"\x89PNG\r\n\x1a\n":
            return "image/png"
        if head[:3] == b"\xff\xd8\xff":
            return "image/jpeg"
        if head[:6] in (b"GIF87a", b"GIF89a"):
            return "image/gif"
        if head[:4] == b"RIFF" and head[8:12] == b"WEBP":
            return "image/webp"
    except Exception:
        pass
    return mimetypes.guess_type(path)[0] or "application/octet-stream"


def send_index(h):
    # 首页：按 app.js 的修改时间自动注入版本号，避免手机端 WebView 缓存旧 JS
    fp = os.path.join(BASE, "static", "index.html")
    if not os.path.exists(fp):
        h.send_response(404); h.send_cors(); h.end_headers(); return
    with open(fp, "r", encoding="utf-8") as f:
        html = f.read()
    appjs = os.path.join(BASE, "static", "app.js")
    ver = int(os.path.getmtime(appjs)) if os.path.exists(appjs) else int(time.time())
    html = re.sub(r"/static/app\.js\?v=\d+", "/static/app.js?v=%d" % ver, html)
    data = html.encode("utf-8")
    h.send_response(200)
    h.send_header("Content-Type", "text/html; charset=utf-8")
    h.send_header("Content-Length", str(len(data)))
    h.send_header("Cache-Control", "no-cache, no-store, must-revalidate")
    h.send_header("Pragma", "no-cache")
    h.send_header("Expires", "0")
    h.send_cors()
    h.end_headers()
    h.wfile.write(data)


def send_file(h, path, filename=None):
    h._responded = True
    if not os.path.exists(path):
        h.send_response(404); h.send_cors(); h.end_headers(); return
    mt = _sniff_content_type(path)
    sz = os.path.getsize(path)
    h.send_response(200)
    h.send_header("Content-Type", mt)
    h.send_header("Content-Length", str(sz))
    if path.endswith((".html", ".js", ".css")):
        # 页面与样式不缓存，避免手机端拿到旧 CSS 出现新旧混合的界面
        h.send_header("Cache-Control", "no-cache, no-store, must-revalidate")
        h.send_header("Pragma", "no-cache")
        h.send_header("Expires", "0")
    if filename:
        h.send_header("Content-Disposition", f'inline; filename="{filename}"')
    h.send_cors()
    h.end_headers()
    with open(path, "rb") as f:
        while True:
            b = f.read(65536)
            if not b: break
            h.wfile.write(b)


def read_body(h):
    n = int(h.headers.get("Content-Length", "0") or "0")
    raw = h.rfile.read(n) if n else b""
    ct = h.headers.get("Content-Type", "")
    if "application/json" in ct:
        try:
            return json.loads(raw.decode("utf-8")), None
        except Exception as e:
            return None, "JSON 解析失败: " + str(e)
    return raw, None


def get_token(h):
    ah = h.headers.get("Authorization", "")
    if ah.startswith("Bearer "):
        return ah[7:]
    return h.query.get("token", [None])[0]


# ---------------- 路由处理 ----------------
class H(BaseHTTPRequestHandler):
    def _setup(self):
        self.query = parse_qs(urlparse(self.path).query)
        self.path_only = urlparse(self.path).path
        self._responded = False

    def send_cors(self):
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Headers", "Content-Type, Authorization")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS")

    def do_OPTIONS(self):
        self.send_response(204); self.send_cors(); self.end_headers()

    def log_message(self, *a):
        pass  # 静默

    def do_GET(self):
        self._setup()
        try:
            self.route_get()
        except Exception as e:
            send_json(self, {"error": str(e)}, 500)

    def do_POST(self):
        self._setup()
        try:
            self.route_post()
        except Exception as e:
            send_json(self, {"error": str(e)}, 500)

    def do_PUT(self):
        self._setup()
        try:
            self.route_put()
        except Exception as e:
            send_json(self, {"error": str(e)}, 500)

    def do_DELETE(self):
        self._setup()
        try:
            self.route_delete()
        except Exception as e:
            send_json(self, {"error": str(e)}, 500)

    # ---- GET ----
    # ---------------- 错题循环训练 路由 ----------------
    def _train_route_get(self, p, q):
        if p in ("/train", "/train.html"):
            return send_file(self, os.path.join(BASE, "static", "train_teacher.html"))
        if p in ("/train_student", "/train_student.html"):
            return send_file(self, os.path.join(BASE, "static", "train_student.html"))
        if not p.startswith("/api/train/"):
            return None  # 非训练接口, 交给主路由
        # 训练类 GET 接口均需登录
        u = user_of(get_token(self))
        if not u:
            return send_json(self, {"error": "未登录"}, 401)
        # 学生角色: 强制只看自己, 且禁用看板
        is_student = (u.get("role") == "student")
        sid_param = q.get("studentId", [None])[0]
        eff_sid = (u.get("student_id") if is_student else sid_param)
        if p == "/api/train/students":
            items = [s["body"] for s in store_list("students", limit=1000)]
            if is_student:
                items = [s for s in items if s.get("id") == eff_sid]
            return send_json(self, {"items": items})
        # 教师端：列出全部已发试卷（按创建时间倒序）
        if p == "/api/train/teacher/papers":
            if u.get("role") not in ("admin", "teacher"):
                return send_json(self, {"error": "无权限"}, 403)
            items = [x["body"] for x in store_list("papers", limit=500)]
            items.sort(key=lambda b: b.get("createdAt", 0) or 0, reverse=True)
            return send_json(self, {"items": items})
        # 学生端：列出发给本人的试卷（含已解析的题目明细，student 角色强制只看自己）
        m_papers = re.match(r"^/api/train/student/([^/]+)/papers$", p)
        if m_papers:
            sid = m_papers.group(1)
            if is_student and eff_sid != sid:
                return send_json(self, {"error": "无权限"}, 403)
            out = []
            for x in store_list("papers", limit=500):
                pp = x["body"]
                to = [str(t) for t in (pp.get("assignedTo") or [])]
                if to and "all" not in to:
                    stu, _ = store_get("students", sid)
                    cls = str((stu or {}).get("class") or (stu or {}).get("className") or "")
                    if (sid not in to) and (not cls or cls not in to):
                        continue
                pc = dict(pp)
                pc["questions"] = train_paper_resolve(pp)
                out.append(pc)
            out.sort(key=lambda b: b.get("createdAt", 0) or 0, reverse=True)
            return send_json(self, {"items": out})
        if p == "/api/train/errors":
            items = [e["body"] for e in store_list("trainErrors", limit=5000)]
            if eff_sid:
                items = [e for e in items if e.get("studentId") == eff_sid]
            # 学生端「最近一周错题」只列出「自己已经练过」的题：老师刚添加、还没轮到练的题不下发，
            # 免得学生一提交今日练习就提前看到老师添加的全部错题（含答案）。老师/管理员不受限。
            if is_student and eff_sid:
                practiced = _student_practiced_ids(eff_sid)
                items = [e for e in items if e.get("id") in practiced]
            return send_json(self, {"items": items, "count": len(items)})
        if p == "/api/train/errors/export.docx":
            # 导出 Word。学生只能导出自己的；老师可带 ?studentId= 导出指定学生。
            #  ?date=YYYY-MM-DD  只导该天练习任务里的题
            #  ?mode=questions   只印题目、不含答案/解析/答案图（供做题前打印到纸上写）
            if not eff_sid:
                return send_json(self, {"error": "缺少学生"}, 400)
            date_arg = (q.get("date", [None])[0] or "").strip()
            mode = (q.get("mode", [None])[0] or "").strip().lower()
            questions_only = mode in ("questions", "stem", "print")
            if questions_only:
                # 只印题目：不含任何答案，学生做题前即可下载打印
                d = date_arg or _date_today()
                task, _ = store_get("trainTasks", "t_%s_%s" % (eff_sid, d))
                ids = set(task.get("errorIds") or []) if task else set()
                if not ids:
                    return send_json(self, {"error": "当天没有练习任务"}, 400)
                errs = [e["body"] for e in store_list("trainErrors", limit=5000)
                        if e["id"] in ids]
                order = {eid: i for i, eid in enumerate(task.get("errorIds") or [])}
                errs.sort(key=lambda e: order.get(e.get("id"), 999))
                stu, _ = store_get("students", eff_sid)
                nm = ((stu.get("name") if stu else "") or eff_sid)
                data = build_train_errors_docx(
                    nm, errs,
                    title="%s %s 练习题" % (nm, d),
                    note="共 %d 道题　请打印后在纸上作答" % len(errs),
                    with_answers=False, blank_lines=6,
                    header="姓名：______________　　日期：______________")
                fname = urlquote("%s %s 练习题.docx" % (nm, d))
                self.send_response(200)
                self.send_header("Content-Type", DOCX_CTYPE)
                self.send_header("Content-Disposition", "attachment; filename*=UTF-8''" + fname)
                self.send_header("Content-Length", str(len(data)))
                self.send_cors()
                self.end_headers()
                self.wfile.write(data)
                self._responded = True
                return
            # 学生端防提前看答案：当日练习包未提交完成前不允许下载（含答案的错题本）
            # （当天没有出题的空任务不算拦截，否则学生永远无法下载）
            if is_student:
                d = date_arg or _date_today()
                task, _ = store_get("trainTasks", "t_%s_%s" % (eff_sid, d))
                train_heal_task_status(task)
                if task and task.get("errorIds") and task.get("status") != "done":
                    return send_json(self, {"error": "请先完成当天的练习，再下载错题"}, 403)
            title = note = None
            if date_arg:
                task, _ = store_get("trainTasks", "t_%s_%s" % (eff_sid, date_arg))
                ids = set(task.get("errorIds") or []) if task else set()
                if not ids:
                    return send_json(self, {"error": "该日期没有练习任务"}, 400)
                errs = [e["body"] for e in store_list("trainErrors", limit=5000)
                        if e["id"] in ids]
                title = "%s %s 练习" % (((store_get("students", eff_sid)[0] or {})
                                         .get("name") or eff_sid), date_arg)
                note = "共 %d 道题　导出日期 %s" % (len(errs), _date_today())
            else:
                errs = [e["body"] for e in store_list("trainErrors", limit=5000)
                        if (e["body"] or {}).get("studentId") == eff_sid]
                if is_student:
                    # 与「最近一周错题」口径一致：学生只导出「已练过」的错题（老师导出不受限）
                    practiced = _student_practiced_ids(eff_sid)
                    errs = [e for e in errs if e.get("id") in practiced]
            if not errs:
                return send_json(self, {"error": "还没有错题可以导出"}, 400)
            if date_arg:
                # 当天任务内的顺序按任务里的顺序展示
                order = {eid: i for i, eid in enumerate(ids)}
                errs.sort(key=lambda e: order.get(e.get("id"), 999))
            else:
                errs.sort(key=lambda e: (e.get("wrongDate") or "",
                                         e.get("createdAt") or 0))
            stu, _ = store_get("students", eff_sid)
            name = ((stu.get("name") if stu else "") or errs[0].get("studentName")
                    or eff_sid)
            data = build_train_errors_docx(name, errs, title=title, note=note)
            fname = urlquote((title or (name + " 错题本")) + ".docx")
            self.send_response(200)
            self.send_header("Content-Type", DOCX_CTYPE)
            self.send_header("Content-Disposition", "attachment; filename*=UTF-8''" + fname)
            self.send_header("Content-Length", str(len(data)))
            self.send_cors()
            self.end_headers()
            self.wfile.write(data)
            self._responded = True
            return
        if p == "/api/train/errors/practices":
            # 每个错题的练习次数（可选按学生过滤）
            sid = q.get("studentId", [None])[0] or eff_sid
            sid = str(sid) if sid else None
            counts, per = {}, {}
            for l in store_list("trainLogs", limit=20000):
                try:
                    b = l.get("body") if isinstance(l, dict) else None
                    if not isinstance(b, dict):
                        continue
                    eid = b.get("errorId")
                    if not eid or not isinstance(eid, str):
                        continue
                    ssid = b.get("studentId")
                    if sid and str(ssid) != sid:
                        continue
                    counts[eid] = counts.get(eid, 0) + 1
                    key = str(ssid) if ssid is not None else "unknown"
                    per.setdefault(eid, {})[key] = per[eid].get(key, 0) + 1
                except Exception:
                    continue
            return send_json(self, {"counts": counts, "perStudent": per})
        if p.startswith("/api/train/errors/") and p.endswith("/practices"):
            eid = p[len("/api/train/errors/"):-len("/practices")]
            logs = [l.get("body") for l in store_list("trainLogs", limit=20000)
                    if (l.get("body") or {}).get("errorId") == eid]
            return send_json(self, {"errorId": eid, "total": len(logs),
                                   "logs": [{"ts": lg.get("updatedAt"), "date": lg.get("date"),
                                             "result": lg.get("result"),
                                             "studentId": lg.get("studentId"),
                                             "errorNote": lg.get("errorNote") or "",
                                             "draftImages": lg.get("draftImages") or ([] if not lg.get("draftImage") else [lg.get("draftImage")])}
                                            for lg in logs]})
        if p.startswith("/api/train/errors/") and p.endswith("/reveal"):
            # 学生上传计算过程后查看答案/解析(需登录)
            eid = p[len("/api/train/errors/"):-len("/reveal")]
            e, _ = store_get("trainErrors", eid)
            if not e:
                return send_json(self, {"error": "错题不存在"}, 404)
            # 归属校验：学生只能看「自己名下（有自己错题卡）」的答案，避免猜到/拿到
            # 别人的 errorId 就套走答案。老师/管理员不受限。
            if is_student:
                c, _ = store_get("trainCards", train_card_id(eff_sid, eid))
                if not c:
                    return send_json(self, {"error": "无权限"}, 403)
                # ① 必须属于本人
                if (e.get("studentId") or "") != (eff_sid or ""):
                    return send_json(self, {"error": "无权限"}, 403)
                # ② 必须已进入本人「已生成」的练习任务（防止把整个错题库的答案一次性套走）
                if not _error_in_generated_task(eff_sid, eid):
                    return send_json(self, {"error": "这道题还没排进你的练习，先完成今日练习"}, 403)
                # ③ 必须先上传作答照片（先自己做、再对答案）；跨零点也认前一天的
                _today = _date_today()
                if not (_student_uploaded_today(eff_sid, _today)
                        or _student_uploaded_today(eff_sid, _date_after(_today, -1))):
                    return send_json(self, {"error": "请先上传作答照片，再看答案"}, 403)
            return send_json(self, {"errorId": eid,
                                    "answer": e.get("answer") or "",
                                    "analysis": e.get("analysis") or "",
                                    "answerImages": e.get("answerImages") or []})
        if p == "/api/train/cards":
            items = [c["body"] for c in store_list("trainCards", limit=8000)]
            if eff_sid:
                items = [c for c in items if c.get("studentId") == eff_sid]
            return send_json(self, {"items": items, "count": len(items)})
        if p == "/api/train/tasks":
            d = q.get("date", [None])[0]
            stu_names = {s.get("id"): (s.get("name") or s.get("username") or s.get("id"))
                         for s in (b["body"] for b in store_list("students", limit=2000))}
            # 自愈：题已全部提交、状态却还是 partial 的旧任务纠正为 done（与 /api/train/today 一致）
            logs_by_task = {}
            for lg in store_list("trainLogs", limit=20000):
                lb = lg.get("body") or {}
                if lb.get("taskId"):
                    logs_by_task.setdefault(lb["taskId"], set()).add(lb.get("errorId"))
            items = []
            for t in store_list("trainTasks", limit=8000):
                b = dict(t["body"])
                if b.get("status") == "partial":
                    need = set(b.get("errorIds") or [])
                    if need and need <= logs_by_task.get(b.get("id"), set()):
                        b["status"] = "done"
                        store_put("trainTasks", b["id"], b)
                b["studentName"] = stu_names.get(b.get("studentId"), b.get("studentId"))
                items.append(b)
            if eff_sid:
                items = [t for t in items if t.get("studentId") == eff_sid]
            if d:
                items = [t for t in items if t.get("date") == d]
            # 当天任务列表只展示老师正式生成的任务，屏蔽学生端触发的残留任务
            if d == _date_today():
                items = [t for t in items if t.get("generated")]
            return send_json(self, {"items": items, "count": len(items)})
        if p.startswith("/api/train/tasks/") and p.endswith("/logs"):
            # 老师查看某学生某天任务的逐题作答。
            # 需求：不论学生是否提交，老师都能看到当日全部题目（含题图/答案/解析）；
            # 已提交的再附带学生自评/错误原因/过程照片。故以「任务的题目清单」为主线，
            # 合并学生已提交的作答日志（而不是只依赖日志，否则未提交时是空的）。
            if u.get("role") == "student":
                return send_json(self, {"error": "无权限"}, 403)
            tid = p[len("/api/train/tasks/"):-len("/logs")]
            task = None
            for t in store_list("trainTasks", limit=8000):
                tb = t.get("body") or {}
                if tb.get("id") == tid:
                    task = tb
                    break
            # 学生已作答日志：按 errorId 归并（同一题多次作答时保留最后一条）
            logs_by_eid = {}
            for lg in store_list("trainLogs", limit=20000):
                b = lg.get("body") or {}
                if b.get("taskId") != tid:
                    continue
                eid = b.get("errorId")
                if eid:
                    logs_by_eid[eid] = b

            # 该生每道错题的「累计练习次数」（跨全部历史，不限今天）。
            # 用途：老师在「查看当日学生错题」时，能看到每个学生对每道题练过几次，做到心里有数。
            _tsid = (task or {}).get("studentId")
            prac_count = {}
            for lg in store_list("trainLogs", limit=20000):
                b = lg.get("body") or {}
                if _tsid is None or b.get("studentId") != _tsid:
                    continue
                eid = b.get("errorId")
                if not eid:
                    continue
                prac_count[eid] = prac_count.get(eid, 0) + 1

            def _mk_log_item(eid, lb):
                e, _ = store_get("trainErrors", eid)
                _e = e or {}
                return {"errorId": eid,
                        "stem": _e.get("stem", ""),
                        # 老师端着照片批改需要看到题目本身：一并下发题图/答案/解析/答案图
                        # （本接口对学生 403，不受"学生未做不能看答案"的限制）
                        "images": _e.get("images") or ([_e.get("image")] if _e.get("image") else []),
                        "answer": _e.get("answer") or "",
                        "analysis": _e.get("analysis") or "",
                        "answerImages": _e.get("answerImages") or [],
                        "result": lb.get("result"),
                        "errorNote": lb.get("errorNote") or "",
                        "draftImages": lb.get("draftImages") or ([] if not lb.get("draftImage") else [lb.get("draftImage")]),
                        "submitted": bool(lb),
                        "date": lb.get("answerDate"),
                        "practiceCount": prac_count.get(eid, 0)}

            # 题目顺序：优先任务自带的 errorIds；没有则退回日志里的题（历史数据兜底）
            eids = [e for e in ((task or {}).get("errorIds") or []) if e]
            if not eids:
                eids = list(logs_by_eid.keys())
            out, seen = [], set()
            for eid in eids:
                if eid in seen:
                    continue
                seen.add(eid)
                out.append(_mk_log_item(eid, logs_by_eid.get(eid) or {}))
            for eid, lb in logs_by_eid.items():
                if eid in seen:
                    continue
                seen.add(eid)
                out.append(_mk_log_item(eid, lb))
            return send_json(self, {"taskId": tid, "items": out, "count": len(out),
                                    "studentId": (task or {}).get("studentId"),
                                    "date": (task or {}).get("date"),
                                    "status": (task or {}).get("status")})
        if p == "/api/train/today":
            d = q.get("date", [None])[0]
            if not eff_sid:
                return send_json(self, {"error": "缺少 studentId"}, 400)
            return send_json(self, train_student_today(eff_sid, d))
        if p == "/api/train/dashboard":
            if is_student:
                return send_json(self, {"error": "无权限"}, 403)
            return send_json(self, train_dashboard(q.get("date", [None])[0]))
        if p == "/api/train/student/accounts":
            if u.get("role") not in ("admin", "teacher"):
                return send_json(self, {"error": "无权限"}, 403)
            cx = db()
            rows = cx.execute("SELECT student_id, username, pw_hash FROM users "
                              "WHERE role='student' AND student_id IS NOT NULL").fetchall()
            cx.close()
            out = []
            for r in rows:
                # 不再回传明文密码（密码只以哈希形式存在 users.pw_hash 里）。
                out.append({"studentId": r["student_id"], "username": r["username"],
                            "hasPassword": bool(r["pw_hash"])})
            return send_json(self, {"items": out})
        if p.startswith("/api/train/student/") and p.endswith("/recent"):
            import re as _re
            m = _re.match(r"^/api/train/student/([^/]+)/recent$", p)
            if not m:
                return send_json(self, {"error": "参数错误"}, 400)
            rsid = m.group(1)
            sid = eff_sid if is_student else (rsid or sid_param)
            if not sid:
                return send_json(self, {"error": "缺少 studentId"}, 400)
            try:
                dd = int(q.get("days", ["14"])[0])
            except Exception:
                dd = 14
            return send_json(self, train_student_recent(sid, dd))
        if p == "/api/train/comments":
            # 读取某学生某题的教师评语（文字/图片/语音）。学生角色强制本人，老师可查任意学生。
            sid = eff_sid if is_student else (q.get("studentId", [None])[0] or sid_param)
            eid = (q.get("errorId", [None])[0] or "").strip()
            if not sid or not eid:
                return send_json(self, {"error": "缺少 studentId/errorId"}, 400)
            items = []
            for it in store_list("trainComments", limit=200000):
                b = it.get("body") or {}
                if b.get("studentId") == sid and b.get("errorId") == eid:
                    items.append(b)
            items.sort(key=lambda x: (x.get("ts") or 0))
            return send_json(self, {"items": items})
        return None

    def _train_route_post(self, p, q):
        # 学生作答提交 + 草稿/错题图片上传: 需登录, 学生角色强制用本人 studentId
        if not p.startswith("/api/train/"):
            return None  # 非训练接口交给主路由(避免拦截 /api/auth/login 等)
        u = user_of(get_token(self))
        if not u:
            return send_json(self, {"error": "未登录"}, 401)
        is_student = (u.get("role") == "student")

        def _eff_sid(param_sid):
            # 学生角色: 只能操作自己(token 中的 student_id), 前端无法伪造
            return (u.get("student_id") if is_student else param_sid)

        def _teacher_only():
            # 仅老师/管理员可用（学生 token 一律拒绝）——已应答，无需再处理
            if u.get("role") not in ("admin", "teacher"):
                send_json(self, {"error": "无权限"}, 403)
                return False
            return True

        if p == "/api/train/submit":
            body, err = read_body(self)
            if err:
                return send_json(self, {"error": err}, 400)
            sid = _eff_sid(body.get("studentId"))
            if not sid:
                return send_json(self, {"error": "缺少 studentId"}, 400)
            return send_json(self, train_submit(sid, body.get("date"), body.get("answers") or []))
        # 教师端：组卷并发送给学生（云端下发）。assignedTo 可为学生 id 列表或 ["all"]
        if p == "/api/train/teacher/papers":
            if not _teacher_only():
                return
            body, err = read_body(self)
            if err:
                return send_json(self, {"error": err}, 400)
            pid = (body.get("id") or "").strip()
            if not pid:
                pid = "paper_%d" % now_ms()
            paper = {
                "id": pid,
                "title": (body.get("title") or "未命名试卷").strip()[:200],
                "note": (body.get("note") or "").strip()[:2000],
                "questionIds": [str(x) for x in (body.get("questionIds") or [])],
                "assignedTo": [str(x) for x in (body.get("assignedTo") or [])],
                "showAnswer": bool(body.get("showAnswer")),
                "createdAt": body.get("createdAt") or now_ms(),
                "updatedAt": now_ms(),
                "createdBy": (u.get("name") or u.get("username") or ""),
            }
            store_put("papers", pid, paper)
            return send_json(self, {"ok": True, "paper": paper})
        # 老师「已阅」+ 评语（学生端下次打开即可看到；第二天提交新练习前也一直可见）
        if p == "/api/train/tasks/review":
            if is_student:
                return send_json(self, {"error": "无权限"}, 403)
            body, err = read_body(self)
            if err:
                return send_json(self, {"error": err}, 400)
            tid = (body.get("taskId") or "").strip()
            if not tid:
                return send_json(self, {"error": "缺少 taskId"}, 400)
            task, _ = store_get("trainTasks", tid)
            if not task:
                return send_json(self, {"error": "任务不存在"}, 404)
            reviewed = body.get("reviewed")
            reviewed = True if reviewed is None else bool(reviewed)
            task["reviewed"] = reviewed
            task["reviewComment"] = (body.get("comment") or "").strip()[:2000]
            task["reviewedAt"] = now_ms() if reviewed else None
            task["reviewedBy"] = (u.get("name") or u.get("username") or "") if reviewed else ""
            task["updatedAt"] = now_ms()
            store_put("trainTasks", tid, task)
            return send_json(self, {"ok": True, "task": {
                "id": tid, "reviewed": reviewed, "reviewComment": task["reviewComment"],
                "reviewedAt": task["reviewedAt"]}})
        # 学生上传草稿/错题图片(需登录; 仅允许图片, 防任意文件上传滥用)
        if p == "/api/train/media":
            sid = _eff_sid((q.get("studentId", [None])[0] or "").strip())
            if not sid:
                return send_json(self, {"error": "缺少 studentId"}, 400)
            # studentId 限制为安全单段, 防止目录穿越
            sid = re.sub(r"[^A-Za-z0-9_\-]", "_", sid)[:48]
            sub = (q.get("sub", ["drafts"])[0] or "drafts").strip()
            sub = re.sub(r"[^A-Za-z0-9_\-]", "_", sub)[:48]
            name = q.get("name", [None])[0] or self.headers.get("X-Filename") or "upload.bin"
            name = os.path.basename(name)
            raw, _ = read_body(self)
            if not isinstance(raw, bytes) or len(raw) == 0:
                return send_json(self, {"error": "空文件"}, 400)
            if len(raw) > 12 * 1024 * 1024:
                return send_json(self, {"error": "图片过大(>12MB)"}, 413)
            ct = _guess_ct(name, raw)
            if not ct.startswith("image/"):
                return send_json(self, {"error": "仅支持图片上传"}, 415)
            d = _date_today()
            rel = "train/%s/%s/%s/%s" % (sid, sub, d, name)
            ok, url, code = _put_media(rel, raw, name)
            if not ok:
                return send_json(self, {"error": url}, code)
            return send_json(self, {"ok": True, "url": url})
        if p == "/api/train/student/account":
            # 老师(管理员)给学生设置/修改账号密码
            if u.get("role") not in ("admin", "teacher"):
                return send_json(self, {"error": "无权限"}, 403)
            body, err = read_body(self)
            if err:
                return send_json(self, {"error": err}, 400)
            sid = body.get("studentId")
            username = (body.get("username") or "").strip()
            pw = body.get("password") or ""
            if not sid or not username:
                return send_json(self, {"error": "缺少 studentId / username"}, 400)
            cx = db()
            # 该学生是否已存在账号
            exist = cx.execute("SELECT * FROM users WHERE student_id=?", (sid,)).fetchone()
            uname_exist = cx.execute("SELECT id FROM users WHERE username=? AND student_id IS NOT ?",
                                     (username, sid)).fetchone()
            if uname_exist:
                cx.close()
                return send_json(self, {"error": "用户名已被其他账号占用"}, 409)
            if exist:
                # 密码留空 = 只改账号名，不动密码（密码由「重置密码」生成，库里只存哈希）
                if pw:
                    cx.execute("UPDATE users SET username=?, pw_hash=?, role='student' WHERE id=?",
                               (username, pw_hash(pw), exist["id"]))
                else:
                    cx.execute("UPDATE users SET username=?, role='student' WHERE id=?",
                               (username, exist["id"]))
            else:
                if not pw:
                    cx.close()
                    return send_json(self, {"error": "新建账号需填密码，或直接点「重置密码」自动生成"}, 400)
                add_user(cx, username, pw, role="student", student_id=sid)
            cx.commit(); cx.close()
            # 不再保存明文密码：只留 users.pw_hash。老师若要给学生新密码，用「重置密码」。
            try:
                stu, _ = store_get("students", sid)
                if stu:
                    stu.pop("spw", None)      # 顺手清掉历史遗留的明文
                    store_put("students", sid, stu)
            except Exception:
                pass
            return send_json(self, {"ok": True})
        if p == "/api/train/student/reset_password":
            # 老师给学生「重置密码」：服务端生成一个易读易报的新密码，设置哈希后
            # 把明文**只返回这一次**（页面弹给老师，转给学生）；库里不留明文。
            if u.get("role") not in ("admin", "teacher"):
                return send_json(self, {"error": "无权限"}, 403)
            body, err = read_body(self)
            if err:
                return send_json(self, {"error": err}, 400)
            sid = (body.get("studentId") or "").strip()
            if not sid:
                return send_json(self, {"error": "缺少 studentId"}, 400)
            # 避开易混字符 0/O/1/l/I
            alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"
            newpw = "".join(secrets.choice(alphabet) for _ in range(8))
            cx = db()
            exist = cx.execute("SELECT id, username FROM users WHERE student_id=?", (sid,)).fetchone()
            if exist:
                cx.execute("UPDATE users SET pw_hash=? WHERE id=?", (pw_hash(newpw), exist["id"]))
                uname = exist["username"]
            else:
                # 还没有账号：自动起一个用户名（学生姓名拼音无保障，用 stu+短号）
                stu, _ = store_get("students", sid)
                base = re.sub(r"[^A-Za-z0-9_]", "", (sid or ""))[-8:] or uuid.uuid4().hex[:8]
                uname = "stu" + base
                n = 1
                while cx.execute("SELECT id FROM users WHERE username=?", (uname,)).fetchone():
                    n += 1
                    uname = "stu" + base + str(n)
                add_user(cx, uname, newpw, role="student", student_id=sid)
            cx.commit(); cx.close()
            try:
                stu, _ = store_get("students", sid)
                if stu:
                    stu.pop("spw", None)
                    store_put("students", sid, stu)
            except Exception:
                pass
            # 明文仅在此响应中出现一次，不落库
            return send_json(self, {"ok": True, "username": uname, "password": newpw})
        if p == "/api/train/student/greeting":
            # 老师给某学生写鼓励语 → 学生端顶部显示（留空则显示默认「你好，姓名」）
            if u.get("role") not in ("admin", "teacher"):
                return send_json(self, {"error": "无权限"}, 403)
            body, err = read_body(self)
            if err:
                return send_json(self, {"error": err}, 400)
            sid = body.get("studentId")
            if not sid:
                return send_json(self, {"error": "缺少 studentId"}, 400)
            stu, _ = store_get("students", sid)
            if not stu:
                return send_json(self, {"error": "学生不存在"}, 404)
            stu["greeting"] = (body.get("greeting") or "").strip()
            store_put("students", sid, stu)
            return send_json(self, {"ok": True, "greeting": stu["greeting"]})
        if p == "/api/train/student/daily":
            # 设置某学生每天训练题数（能力/时间不同，题量也应不同）
            if u.get("role") not in ("admin", "teacher"):
                return send_json(self, {"error": "无权限"}, 403)
            body, err = read_body(self)
            if err:
                return send_json(self, {"error": err}, 400)
            sid = body.get("studentId")
            if not sid:
                return send_json(self, {"error": "缺少 studentId"}, 400)
            stu, _ = store_get("students", sid)
            if not stu:
                return send_json(self, {"error": "学生不存在"}, 404)
            try:
                n = int(body.get("dailyCount", 3))
            except Exception:
                n = 3
            if n < 1:
                n = 1
            if n > 20:
                n = 20
            stu["dailyCount"] = n
            store_put("students", sid, stu)
            # 立刻按新题数重建「今天」的任务（学生还没作答时）——改完当场生效，
            # 不用再等下一次「生成今日任务」。
            rebuilt = None
            try:
                rebuilt = train_rebuild_today_task(sid)
            except Exception as _e:
                print('rebuild today task failed:', _e)
            return send_json(self, {"ok": True, "dailyCount": n, "rebuilt": rebuilt})
        if p == "/api/train/student/purge":
            # 彻底删除某学生及其全部数据（含草稿照片/账号）。仅老师/管理员。
            if u.get("role") not in ("admin", "teacher"):
                return send_json(self, {"error": "无权限"}, 403)
            body, err = read_body(self)
            if err:
                return send_json(self, {"error": err}, 400)
            sid = (body.get("studentId") or "").strip()
            if not sid:
                return send_json(self, {"error": "缺少 studentId"}, 400)
            r = purge_student_data(sid)
            return send_json(self, r)
        if p == "/api/train/errors":
            # 只有老师/管理员能建错题：错题会写进错题库、并自动进「题库」，
            # 学生端只读自己的题（学生页面也不调用本接口）。放开会导致学生
            # 往题库/老师界面注入任意内容（存储型 XSS + 数据污染）。
            if u.get("role") not in ("admin", "teacher"):
                return send_json(self, {"error": "无权限"}, 403)
            body, err = read_body(self)
            if err:
                return send_json(self, {"error": err}, 400)
            # 支持批量：studentIds 列表 -> 给每个学生各建一条错题+一张卡
            sids = body.get("studentIds")
            if not sids:
                sid = body.get("studentId")
                sids = [sid] if sid else []
            if not sids:
                return send_json(self, {"error": "请至少选择一个学生"}, 400)
            shared = {k: v for k, v in body.items()
                      if k not in ("studentId", "studentIds", "id", "createdAt")}
            if not shared.get("wrongDate"):
                shared["wrongDate"] = _date_today()
            # 错题自动同步进题库（按内容去重，同题多学生共用一条题库记录）
            kbId, bank_new = train_error_to_bank(shared)
            if kbId:
                shared["kbId"] = kbId
            _raw_id = body.get("id")
            _ok_id = isinstance(_raw_id, str) and bool(re.fullmatch(r"[A-Za-z0-9_\-]{1,64}", _raw_id))
            ids = []
            for sid in sids:
                eid = _raw_id if _ok_id else ("te_" + uuid.uuid4().hex[:12])
                rec = dict(shared)
                rec["id"] = eid
                rec["studentId"] = sid
                if not rec.get("studentName"):
                    s, _ = store_get("students", sid)
                    rec["studentName"] = (s.get("name") if s else sid)
                rec["createdAt"] = now_ms()
                store_put("trainErrors", eid, rec)
                train_ensure_card(sid, eid, first_seen=rec["wrongDate"])  # 自动建卡
                ids.append(eid)
            return send_json(self, {"ok": True, "ids": ids,
                                    "count": len(ids), "bankNew": bank_new})
        if p.startswith("/api/train/errors/"):
            # 删除错题（并同步删卡）——仅老师/管理员，避免学生删库
            if not _teacher_only():
                return
            eid = p[len("/api/train/errors/"):]
            store_delete("trainErrors", eid)
            # 同步删卡(若存在)
            for s in store_list("students", limit=2000):
                cid = train_card_id(s.get("id"), eid)
                c, _ = store_get("trainCards", cid)
                if c:
                    store_delete("trainCards", cid)
            return send_json(self, {"ok": True})
        if p == "/api/train/tasks/generate":
            # 生成任务——仅老师/管理员；支持按 studentIds 指定学生单独派发
            if not _teacher_only():
                return
            d = q.get("date", [None])[0]
            sids = None
            body, _ = read_body(self)
            if isinstance(body, dict):
                v = body.get("studentIds")
                if v:
                    sids = [str(x).strip() for x in v if str(x).strip()]
            return send_json(self, train_generate_tasks(d, student_ids=sids))
        if p == "/api/train/logs":
            # 手动登记/改写作答流水（会改卡片等级）——仅老师/管理员
            if not _teacher_only():
                return
            body, err = read_body(self)
            if err:
                return send_json(self, {"error": err}, 400)
            lid = body.get("id") or ("logm_" + uuid.uuid4().hex[:12])
            body["id"] = lid; body["updatedAt"] = now_ms()
            if not body.get("date"):
                body["date"] = _date_today()
            store_put("trainLogs", lid, body)
            # 同步更新卡片(老师手动登记结果)
            if body.get("errorId") and body.get("studentId"):
                c, _ = store_get("trainCards", train_card_id(body["studentId"], body["errorId"]))
                if c:
                    train_on_answer(c, body.get("result", "self_right"))
            return send_json(self, {"ok": True, "id": lid})
        if p == "/api/train/comments":
            # 老师/管理员给学生某题写评语（文字/图片/语音）；学生禁止写（只能看）。
            if not _teacher_only():
                return
            body, err = read_body(self)
            if err:
                return send_json(self, {"error": err}, 400)
            sid = (body.get("studentId") or "").strip()
            eid = (body.get("errorId") or "").strip()
            ctype = (body.get("type") or "text").strip()
            text = (body.get("text") or "").strip()
            url = (body.get("url") or "").strip()
            if not sid or not eid:
                return send_json(self, {"error": "缺少 studentId/errorId"}, 400)
            if ctype not in ("text", "image", "voice"):
                return send_json(self, {"error": "类型不合法"}, 400)
            if ctype == "text" and not text:
                return send_json(self, {"error": "文字评语不能为空"}, 400)
            if ctype in ("image", "voice") and not url:
                return send_json(self, {"error": "媒体评语缺少文件"}, 400)
            rid = "".join("%02x" % b for b in os.urandom(3))
            cid = "cm_%s_%s_%d_%s" % (sid, eid, now_ms(), rid)
            rec = {"id": cid, "studentId": sid, "errorId": eid,
                   "type": ctype, "text": text, "url": url, "ts": now_ms()}
            store_put("trainComments", cid, rec)
            return send_json(self, {"ok": True, "item": rec})
        if p.startswith("/api/train/comments/") and p.endswith("/delete"):
            if not _teacher_only():
                return
            cid = p[len("/api/train/comments/"):-len("/delete")]
            store_delete("trainComments", cid)
            return send_json(self, {"ok": True})
        return None

    def route_get(self):
        self._train_route_get(self.path_only, self.query)
        if self._responded:
            return
        p = self.path_only
        if p == "/" or p == "/index.html":
            return send_index(self)
        if p.startswith("/static/"):
            fp = os.path.normpath(os.path.join(BASE, "static", p[len("/static/"):]))
            if fp.startswith(os.path.join(BASE, "static")):
                return send_file(self, fp)
            self.send_response(403); self.send_cors(); self.end_headers(); return
        if p == "/api/media/ticket":
            # 登录后领取图片访问票据（客户端把它拼到 <img src> 的查询串上）
            if not user_of(get_token(self)):
                return send_json(self, {"error": "未登录"}, 401)
            return send_json(self, media_ticket())
        if p.startswith("/api/media/"):
            # 图片需要「有效票据(?tk=&e=)」或登录态；否则 401 —— 防止外站/匿名直接抓图。
            q = self.query
            _signed = media_ticket_ok(q.get("tk", [None])[0], q.get("e", [None])[0])
            if not (_signed or user_of(get_token(self))):
                return send_json(self, {"error": "图片需要签名"}, 401)
            # URL 路径已是 percent-encoded, 先解码回原始(可能含中文)再查盘,
            # 否则 _media_disk 的 urlquote 会二次编码导致 404。
            rel = urlunquote(p[len("/api/media/"):])
            # 对象存储启用时: 302 重定向到预签名 URL(不直接占云端盘)
            r2url = _media_url(rel)
            if r2url:
                self.send_response(302)
                self.send_header("Location", r2url)
                self.send_cors(); self.end_headers(); return
            fp = _safe_media_path(rel)
            if fp:
                return send_file(self, fp)
            self.send_response(404); self.send_cors(); self.end_headers(); return
        if p == "/api/health":
            # 运维诊断: 云端容器磁盘容量/余量(决定能否容纳全部媒体图)
            # 运维诊断：仅老师/管理员可见（学生也不需要），否则泄露数据目录与磁盘信息
            _hu = user_of(get_token(self))
            if not _hu or _hu.get("role") not in ("admin", "teacher"):
                return send_json(self, {"error": "无权限"}, 403)
            try:
                du = shutil.disk_usage(os.path.dirname(MEDIA_DIR) or ".")
                n = 0
                for _, _, fs in os.walk(MEDIA_DIR):
                    n += len(fs)
                return send_json(self, {
                    "ok": True,
                    "disk_total": du.total, "disk_used": du.used, "disk_free": du.free,
                    "data_dir": DATA_DIR, "media_files": n,
                })
            except Exception as e:
                return send_json(self, {"ok": False, "error": str(e)}, 500)
        m = re.match(r"^/api/papers/([^/]+)/docx$", p)
        if m:
            if not user_of(get_token(self)):
                return send_json(self, {"error": "未登录"}, 401)
            paper, _ = store_get("papers", m.group(1))
            if not paper:
                self.send_response(404); self.send_cors(); self.end_headers(); return
            qmap = {qid: body for qid, body in
                    ((i["id"], i["body"]) for i in store_list("questions", limit=5000))}
            data = build_paper_docx(paper, qmap)
            fname = urlquote((paper.get("title") or "试卷") + ".docx")
            self.send_response(200)
            self.send_header("Content-Type", DOCX_CTYPE)
            self.send_header("Content-Disposition", "attachment; filename*=UTF-8''" + fname)
            self.send_header("Content-Length", str(len(data)))
            self.send_cors(); self.end_headers()
            self.wfile.write(data)
            return
        if not p.startswith("/api/"):
            self.send_response(404); self.send_cors(); self.end_headers(); return
        self.api_get(p)

    def api_get(self, p):
        q = self.query
        # ===== 统一鉴权闸门 =====
        # 除登录接口外，所有数据接口都必须带有效 token。此前只有 /api/train/* 查了权限，
        # 其余（/api/sync/pull、/api/students、/api/questions …）匿名就能全量拉取，
        # 等于把整库（含学生与家长手机号、收费记录）公开在公网上。此处统一收口。
        u = user_of(get_token(self))
        if not u:
            return send_json(self, {"error": "未登录"}, 401)
        if p == "/api/me":
            return send_json(self, u)
        # 学生角色只能走训练接口（/api/train/* 在 _train_route_get 里单独鉴权并强制只看自己），
        # 不允许读取通用题库/学生名册/同步等数据。
        if u.get("role") == "student":
            return send_json(self, {"error": "无权限"}, 403)
        if p == "/api/knowledgePoints":
            return send_json(self, store_list("knowledgePoints", limit=2000))
        if p == "/api/questions":
            since = q.get("since", [None])[0]
            kw = q.get("q", [None])[0]
            kp = q.get("kpId", [None])[0]
            try:
                lim = int(q.get("limit", ["200"])[0])
            except Exception:
                lim = 200
            lim = max(1, min(lim, 5000))
            res = store_list("questions", since=since, q=kw, limit=lim)
            if kp:
                # 按知识点「子树」过滤：选中某知识点时，连同其所有子孙节点的题目一并返回
                # （题目常挂在子节点上，如 串联 < 动态分析 < 欧姆定律，只匹配 exact 会搜不到）
                allkp = store_list("knowledgePoints", limit=5000)
                kids = {kp}
                changed = True
                while changed:
                    changed = False
                    for k in allkp:
                        b = k.get("body") or {}
                        if b.get("parentId") in kids and b.get("id") and b.get("id") not in kids:
                            kids.add(b.get("id")); changed = True
                res = [x for x in res if x["body"].get("kpId") in kids]
            return send_json(self, {"items": res, "count": len(res)})
        if p.startswith("/api/questions/"):
            id = p[len("/api/questions/"):]
            body, ts = store_get("questions", id)
            if body is None: return send_json(self, {"error": "not found"}, 404)
            return send_json(self, {"id": id, "updated_at": ts, "body": body})
        if p == "/api/papers":
            return send_json(self, {"items": store_list("papers", limit=500), "count": 0})
        if p.startswith("/api/papers/"):
            id = p[len("/api/papers/"):]
            body, ts = store_get("papers", id)
            if body is None: return send_json(self, {"error": "not found"}, 404)
            return send_json(self, {"id": id, "updated_at": ts, "body": body})
        # 通用：单条查询（覆盖 knowledgePoints/examCategories/exams/schedule/records 等）
        for m in MODULES:
            pre = "/api/" + m + "/"
            if p.startswith(pre):
                id = p[len(pre):]
                body, ts = store_get(m, id)
                if body is None: return send_json(self, {"error": "not found"}, 404)
                return send_json(self, {"id": id, "updated_at": ts, "body": body})
        if p == "/api/exams":
            return send_json(self, {"items": store_list("exams", limit=500)})
        if p == "/api/students":
            return send_json(self, {"items": store_list("students", limit=1000)})
        if p == "/api/schedule":
            return send_json(self, {"items": store_list("schedule", limit=2000)})
        if p == "/api/records":
            return send_json(self, {"items": store_list("records", limit=2000)})
        if p == "/api/sync/pull":
            since = q.get("since", [0])[0]
            out = {}
            for m in MODULES:
                out[m] = store_list(m, since=since, limit=5000)
            # 墓碑：已删除条目的 id 与删除时间，供另一端本地删除（since 之后的）
            dels = {}
            cx = db()
            for m in MODULES:
                rows = cx.execute(
                    "SELECT id,deleted_at FROM tombstones WHERE module=? AND deleted_at>=?",
                    (m, int(since))).fetchall()
                if rows:
                    dels[m] = {r["id"]: r["deleted_at"] for r in rows}
            cx.close()
            # server_ts 用本批数据的最大 updated_at（毫秒）；无变更时回显 since，
            # 客户端据此判断"云端无新变更"，避免每次全量重拉
            max_ts = 0
            for m in MODULES:
                for it in out[m]:
                    t = it.get("updated_at") or 0
                    if t > max_ts: max_ts = t
            for m in dels:
                for t in dels[m].values():
                    if t > max_ts: max_ts = t
            if max_ts == 0: max_ts = since
            return send_json(self, {"server_ts": max_ts, "data": out, "deletions": dels})
        send_json(self, {"error": "未知接口 " + p}, 404)

    # ---- POST ----
    def route_post(self):
        self._train_route_post(self.path_only, self.query)
        if self._responded:
            return
        p = self.path_only
        q = self.query
        if p == "/api/admin/cleanup_orphans":
            # 运维接口（会删除未被引用的媒体文件）：仅管理员
            u = user_of(get_token(self))
            if not u or u.get("role") != "admin":
                return send_json(self, {"error": "仅管理员可执行"}, 403)
            return self._cleanup_orphan_media()
        if p == "/api/admin/migrate_media_to_r2":
            u = user_of(get_token(self))
            if not u or u.get("role") != "admin":
                return send_json(self, {"error": "仅管理员可执行"}, 403)
            r = _migrate_media_to_r2()
            if not r.get("ok"):
                return send_json(self, r, 400)
            return send_json(self, r)
        if p == "/api/admin/clear_tombstones":
            # 清空同步删除墓碑表：当一次错误同步把大量条目打成"已删除"墓碑后，
            # 这些 id 会被同步脚本永久跳过、无法再推回云端。运维恢复用。
            u = user_of(get_token(self))
            if not u or u.get("role") != "admin":
                return send_json(self, {"error": "仅管理员可执行"}, 403)
            cx = db()
            n = cx.execute("DELETE FROM tombstones").rowcount
            cx.commit(); cx.close()
            return send_json(self, {"ok": True, "cleared": n})
        if p == "/api/admin/media_stats":
            # 运维诊断：media/ 各一级子目录的文件数与占用，定位「磁盘被谁占满」
            u = user_of(get_token(self))
            if not u or u.get("role") != "admin":
                return send_json(self, {"error": "仅管理员可执行"}, 403)
            stats = {}
            try:
                for entry in os.scandir(MEDIA_DIR):
                    if entry.is_dir():
                        n = 0; sz = 0
                        for root, _d, files in os.walk(entry.path):
                            for fn in files:
                                try:
                                    sz += os.path.getsize(os.path.join(root, fn)); n += 1
                                except Exception:
                                    pass
                        stats[entry.name] = {"files": n, "bytes": sz}
                    elif entry.is_file():
                        try:
                            slot = stats.setdefault("(根文件)", {"files": 0, "bytes": 0})
                            slot["files"] += 1
                            slot["bytes"] += entry.stat().st_size
                        except Exception:
                            pass
            except Exception as e:
                return send_json(self, {"ok": False, "error": str(e)}, 500)
            du = shutil.disk_usage(os.path.dirname(MEDIA_DIR) or ".")
            return send_json(self, {"ok": True, "dirs": stats,
                                    "disk_total": du.total, "disk_used": du.used, "disk_free": du.free})
        if p == "/api/admin/purge_exports":
            # 清理 media/_exports/（导出的 Word/PDF 等中间产物，纯缓存，可随时重新生成）
            u = user_of(get_token(self))
            if not u or u.get("role") != "admin":
                return send_json(self, {"error": "仅管理员可执行"}, 403)
            freed = removed = 0
            exp_dir = os.path.join(MEDIA_DIR, "_exports")
            for root, _d, files in os.walk(exp_dir):
                for fn in files:
                    fp = os.path.join(root, fn)
                    try:
                        freed += os.path.getsize(fp); os.remove(fp); removed += 1
                    except Exception:
                        pass
            try:
                _rmdirs_empty(exp_dir)
            except Exception:
                pass
            du = shutil.disk_usage(os.path.dirname(MEDIA_DIR) or ".")
            return send_json(self, {"ok": True, "removed": removed, "freed_bytes": freed,
                                    "disk_free_after": du.free})
        if p == "/api/auth/register":
            body, err = read_body(self)
            if err: return send_json(self, {"error": err}, 400)
            u = user_of(get_token(self))
            if not u or u.get("role") != "admin":
                return send_json(self, {"error": "仅管理员可注册"}, 403)
            cx = db()
            ex = cx.execute("SELECT id FROM users WHERE username=?", (body.get("username"),)).fetchone()
            if ex: return send_json(self, {"error": "用户名已存在"}, 409)
            uid = add_user(cx, body.get("username"), body.get("password", ""), body.get("role", "user"))
            cx.commit(); cx.close()
            return send_json(self, {"ok": True, "id": uid})
        if p == "/api/auth/login":
            body, err = read_body(self)
            if err: return send_json(self, {"error": err}, 400)
            uname = (body.get("username", "") or "")[:64]
            # 限速按「用户名」计数（不掺来源 IP：云端在反代后面，client_address 可能每次不同，
            # 掺进去会导致计数永远不累计，限速形同虚设）
            tkey = uname.strip().lower() or "-"
            r = auth_user(uname, body.get("password", ""))
            if not r:
                left = login_throttle(tkey, False)
                if left:
                    return send_json(self, {"error": "失败次数过多，请 %d 秒后再试" % left}, 429)
                return send_json(self, {"error": "用户名或密码错误"}, 401)
            login_throttle(tkey, True)
            tok = new_session(r["id"])
            return send_json(self, {"token": tok, "user": {"username": r["username"], "role": r["role"], "studentId": r["student_id"]}})
        if p == "/api/auth/password":
            # 自助修改密码（老师/学生各自改自己的）；需登录 + 校验原密码
            uu = user_of(get_token(self))
            if not uu:
                return send_json(self, {"error": "未登录"}, 401)
            body, err = read_body(self)
            if err: return send_json(self, {"error": err}, 400)
            old = body.get("oldPassword") or ""
            new = body.get("newPassword") or ""
            if len(new) < 8:
                return send_json(self, {"error": "新密码至少 8 位"}, 400)
            cx = db()
            row = cx.execute("SELECT pw_hash FROM users WHERE id=?", (uu["user_id"],)).fetchone()
            if not row or row["pw_hash"] != pw_hash(old):
                cx.close()
                return send_json(self, {"error": "原密码不正确"}, 400)
            cx.execute("UPDATE users SET pw_hash=? WHERE id=?", (pw_hash(new), uu["user_id"]))
            cx.commit(); cx.close()
            return send_json(self, {"ok": True})
        # 以下需登录，且仅老师/管理员可写通用数据。
        # 学生 token 只能走 /api/train/*（在 _train_route_post 里单独鉴权、强制只看自己），
        # 否则学生可伪造请求删改任何学生/题目/收费记录。
        u = user_of(get_token(self))
        if not u: return send_json(self, {"error": "未登录"}, 401)
        if u.get("role") not in ("admin", "teacher"):
            return send_json(self, {"error": "无权限"}, 403)
        if p == "/api/questions":
            body, err = read_body(self)
            if err: return send_json(self, {"error": err}, 400)
            id = body.get("id") or ("q_" + uuid.uuid4().hex[:12])
            body["id"] = id; body["updatedAt"] = now_ts()
            # 兼容桌面端 qid/kpId/type/content/answer 字段
            store_put("questions", id, body)
            # 媒体随题提交（形如 {"c": "data:..."} 暂由前端分批上传，这里仅存文本）
            return send_json(self, {"ok": True, "id": id})
        if p == "/api/papers":
            body, err = read_body(self)
            if err: return send_json(self, {"error": err}, 400)
            id = body.get("id") or ("p_" + uuid.uuid4().hex[:12])
            body["id"] = id; body["updatedAt"] = now_ts()
            store_put("papers", id, body)
            return send_json(self, {"ok": True, "id": id})
        if p == "/api/exams":
            body, err = read_body(self)
            if err: return send_json(self, {"error": err}, 400)
            id = body.get("id") or ("e_" + uuid.uuid4().hex[:12])
            body["id"] = id; body["updatedAt"] = now_ts()
            store_put("exams", id, body)
            return send_json(self, {"ok": True, "id": id})
        if p == "/api/students":
            body, err = read_body(self)
            if err: return send_json(self, {"error": err}, 400)
            id = body.get("id") or ("s_" + uuid.uuid4().hex[:12])
            body["id"] = id; body["updatedAt"] = now_ts()
            store_put("students", id, body)
            return send_json(self, {"ok": True, "id": id})
        if p == "/api/schedule":
            body, err = read_body(self)
            if err: return send_json(self, {"error": err}, 400)
            id = body.get("id") or ("sc_" + uuid.uuid4().hex[:12])
            body["id"] = id; body["updatedAt"] = now_ts()
            store_put("schedule", id, body)
            return send_json(self, {"ok": True, "id": id})
        if p == "/api/records":
            body, err = read_body(self)
            if err: return send_json(self, {"error": err}, 400)
            id = body.get("id") or ("rc_" + uuid.uuid4().hex[:12])
            body["id"] = id; body["updatedAt"] = now_ts()
            store_put("records", id, body)
            return send_json(self, {"ok": True, "id": id})
        # 通用：创建（覆盖 knowledgePoints/examCategories 等未单独处理的模块）
        for m in MODULES:
            if p == "/api/" + m:
                body, err = read_body(self)
                if err: return send_json(self, {"error": err}, 400)
                id = body.get("id") or (m[:2] + "_" + uuid.uuid4().hex[:12])
                body["id"] = id; body["updatedAt"] = now_ts()
                store_put(m, id, body)
                return send_json(self, {"ok": True, "id": id})
        if p == "/api/sync/push":
            body, err = read_body(self)
            if err: return send_json(self, {"error": err}, 400)
            applied = 0
            data = body.get("data", {})
            for m, items in data.items():
                if m not in MODULES: continue
                for it in items:
                    ts = it.get("updated_at") or now_ms()
                    if it.get("deleted"):
                        # 删除型同步：仅当删除时间不早于本地更新才生效
                        existing, old_ts = store_get(m, it["id"])
                        if old_ts and old_ts > ts:
                            continue
                        store_delete(m, it["id"])
                        purge_media_refs(_collect_refs(existing))  # 同步清掉独占的图片/附件
                        applied += 1
                        continue
                    existing, old_ts = store_get(m, it["id"])
                    if existing and old_ts and old_ts > ts:
                        continue  # 服务端更新更新 -> last write wins
                    store_put(m, it["id"], it["body"], ts=ts)
                    purge_replaced_media(existing, it.get("body"))  # 清掉新版不再引用的旧图
                    applied += 1
            return send_json(self, {"ok": True, "applied": applied})
        if p == "/api/media":
            # 裸二进制上传：文件名取自 X-Filename 或 ?name=
            # 优先用查询参数 name(sub 亦来自查询, 均已被 urlparse 正确解码为中文),
            # 避免桌面端 urllib 无法把中文写入 X-Filename 头(latin-1)导致上传失败;
            # X-Filename 仍作为移动端兼容回退。
            name = q.get("name", [None])[0] or self.headers.get("X-Filename") or "upload.bin"
            name = os.path.basename(name)
            raw, _ = read_body(self)
            if not isinstance(raw, bytes): raw = b""
            # 放入 media/<module>/<id>/... 由前端在路径里指定；
            # 用 URL 编码后的 ASCII 路径落盘，规避部分文件系统不支持中文文件名的问题。
            sub = q.get("sub", ["others"])[0]
            # sub 只允许「字母数字/下划线/短横/斜杠」，且由 _put_media 再去掉 .. 段，防路径穿越
            sub = re.sub(r"[^A-Za-z0-9_\-/]", "", sub).strip("/")
            if not sub:
                sub = "others"
            rel = f"{sub}/{name}"
            # 磁盘空间保护：本地回退模式剩余不足时拒绝写入, 避免撑爆数据盘导致
            # sync.db(WAL)写入失败而整体宕机；R2 模式媒体不落本地盘, 不受此限。
            #
            # 例外：**覆盖同名已存在文件**放行。旧图换更小版本(降质/降分辨率)是
            # 磁盘写满时唯一的自救手段——体积只会持平或变小，不会加剧占用。
            # 不加这条会陷入死锁：盘满 → 拒绝写入 → 腾不出空间 → 永远传不了新图。
            try:
                if _safe_media_path(rel) is None:
                    free = shutil.disk_usage(os.path.dirname(MEDIA_DIR) or ".").free
                    if free < 20 * 1024 * 1024 and not _r2_enabled():
                        return send_json(self, {"error": "云端磁盘空间不足, 图片上传被拒绝(请清理或启用对象存储)"}, 507)
            except Exception:
                pass
            ok, url, code = _put_media(rel, raw, name)
            if not ok:
                return send_json(self, {"error": url}, code)
            return send_json(self, {"ok": True, "url": url})
        send_json(self, {"error": "未知接口 " + p}, 404)

    def _cleanup_orphan_media(self):
        """删除未被任何模块引用的上传文件(孤儿), 释放云端磁盘空间。

        云端持久盘仅 ~430MB, media/ 累计常把磁盘吃满 -> 上传触发 507 被拒,
        表现为「手机收藏的试卷电脑打不开」。孤儿=上传成功但从未被题目/试卷等
        引用的文件(如半截保存、重复上传、删除题目后残留)。删除安全。

        注意: 磁盘文件以 urlquote 编码存储, 比对前必须 urlunquote 还原。"""
        r = _run_orphan_cleanup()
        try:
            du = shutil.disk_usage(os.path.dirname(MEDIA_DIR) or ".")
            free_after = du.free
        except Exception:
            free_after = None
        return send_json(self, {"ok": True, "referenced": len(_referenced_media()),
                                "removed": r["removed"], "freed_bytes": r["freed"],
                                "object_removed": r.get("object_removed", 0),
                                "disk_free_after": free_after})

    # ---- PUT ----
    def route_put(self):
        p = self.path_only
        u = user_of(get_token(self))
        if not u: return send_json(self, {"error": "未登录"}, 401)
        if u.get("role") not in ("admin", "teacher"):
            return send_json(self, {"error": "无权限"}, 403)
        if p.startswith("/api/questions/"):
            id = p[len("/api/questions/"):]
            body, err = read_body(self)
            if err: return send_json(self, {"error": err}, 400)
            body["id"] = id; body["updatedAt"] = now_ts()
            old, _ = store_get("questions", id)
            store_put("questions", id, body)
            purge_replaced_media(old, body)
            return send_json(self, {"ok": True, "id": id})
        if p.startswith("/api/papers/"):
            id = p[len("/api/papers/"):]
            body, err = read_body(self)
            if err: return send_json(self, {"error": err}, 400)
            body["id"] = id; body["updatedAt"] = now_ts()
            old, _ = store_get("papers", id)
            store_put("papers", id, body)
            purge_replaced_media(old, body)
            return send_json(self, {"ok": True, "id": id})
        if p.startswith("/api/students/"):
            id = p[len("/api/students/"):]
            body, err = read_body(self)
            if err: return send_json(self, {"error": err}, 400)
            body["id"] = id; body["updatedAt"] = now_ts()
            store_put("students", id, body)
            return send_json(self, {"ok": True, "id": id})
        # 通用：更新（覆盖 exams/schedule/records/knowledgePoints/examCategories 等）
        for m in MODULES:
            pre = "/api/" + m + "/"
            if p.startswith(pre):
                id = p[len(pre):]
                body, err = read_body(self)
                if err: return send_json(self, {"error": err}, 400)
                body["id"] = id; body["updatedAt"] = now_ts()
                old, _ = store_get(m, id)
                store_put(m, id, body)
                purge_replaced_media(old, body)
                return send_json(self, {"ok": True, "id": id})
        send_json(self, {"error": "未知接口 " + p}, 404)

    # ---- DELETE ----
    def route_delete(self):
        p = self.path_only
        u = user_of(get_token(self))
        if not u: return send_json(self, {"error": "未登录"}, 401)
        if u.get("role") not in ("admin", "teacher"):
            return send_json(self, {"error": "无权限"}, 403)
        for prefix, mod in (("/api/questions/", "questions"), ("/api/papers/", "papers"),
                            ("/api/exams/", "exams"), ("/api/students/", "students"),
                            ("/api/schedule/", "schedule"), ("/api/records/", "records"),
                            ("/api/knowledgePoints/", "knowledgePoints"),
                            ("/api/examCategories/", "examCategories"),
                            ("/api/dailyQuestions/", "dailyQuestions"),
                            ("/api/dailyAnswers/", "dailyAnswers")):
            if p.startswith(prefix):
                id = p[len(prefix):]
                # 先取原记录，便于删除后清掉它独占的图片/附件
                old, _ = store_get(mod, id)
                store_delete(mod, id)
                media = purge_media_refs(_collect_refs(old)) if old else None
                return send_json(self, {"ok": True, "id": id, "media": media})
        # 错题删除（同步清对应训练卡 + 不再被引用的图片）
        if p.startswith("/api/train/errors/"):
            eid = p[len("/api/train/errors/"):]
            old, _ = store_get("trainErrors", eid)
            store_delete("trainErrors", eid)
            for s in store_list("students", limit=2000):
                cid = train_card_id(s.get("id"), eid)
                c, _ = store_get("trainCards", cid)
                if c:
                    store_delete("trainCards", cid)
            media = purge_media_refs(_collect_refs(old)) if old else None
            return send_json(self, {"ok": True, "media": media})
        send_json(self, {"error": "未知接口 " + p}, 404)


def _free_disk_if_needed():
    """云端数据盘(容器磁盘)可能被子目录 media 撑满, 导致 sync.db 的 WAL 文件
    无法创建、server.py 启动即崩溃(表现为 Railway 部署失败 / 502)。
    此处: 若 DB 因磁盘满无法初始化, 清空可重建的 media 目录释放空间后重试。
    media 由桌面端 --watch 重新回填, 题目数据亦由桌面端重新同步, 故清空安全。"""
    try:
        cx = sqlite3.connect(DB_PATH)
        cx.execute("PRAGMA journal_mode=WAL")
        cx.close()
        return
    except Exception:
        pass
    try:
        shutil.rmtree(MEDIA_DIR, ignore_errors=True)
        os.makedirs(MEDIA_DIR, exist_ok=True)
    except Exception:
        pass
    try:
        cx = sqlite3.connect(DB_PATH)
        cx.execute("PRAGMA journal_mode=WAL")
        cx.close()
    except Exception:
        pass


def purge_plaintext_student_pw():
    """一次性清理：历史上 students.spw 存了学生明文密码，现已改为只存哈希。
    启动时把残留的 spw 删掉（顺带 bump 时间戳，让本地端也会同步删除）。"""
    n = 0
    try:
        for s in store_list("students", limit=5000):
            b = s.get("body") or {}
            if b.get("spw"):
                b.pop("spw", None)
                store_put("students", s["id"], b)
                n += 1
    except Exception as e:
        print("[security] 清理明文密码失败:", e)
    if n:
        print("[security] 已清理 %d 条历史明文学生密码(spw)" % n)


def _backfill_trainlog_dates():
    """存量 trainLogs 补 date(练习日期)字段, 便于以后核查规则是否执行。
    优先用已有的 answerDate; 没有则按 updatedAt(北京时间)反推; 已含 date 的跳过。幂等。"""
    from datetime import datetime, timezone, timedelta
    n = 0
    for l in store_list("trainLogs", limit=20000):
        if not isinstance(l, dict):
            continue
        b = l.get("body")
        if not isinstance(b, dict):
            continue
        if b.get("date"):
            continue
        d = b.get("answerDate") or ""
        if not d and b.get("updatedAt"):
            try:
                d = datetime.fromtimestamp(b["updatedAt"] / 1000,
                                           timezone(timedelta(hours=8))).date().isoformat()
            except Exception:
                d = ""
        if not d:
            continue
        b["date"] = d
        store_put("trainLogs", l.get("id"), b)
        n += 1
    if n:
        print(f"[backfill] 为 {n} 条旧练习记录补上了日期")


def _maybe_automigrate():
    """部署且对象存储已配置时, 后台把本地媒体一次性搬上云并清本地盘, 只跑一次
    (meta 标记 s3_migrated 控制)。无需人工触发; 迁移期间读取由 _cos_has 自动路由。"""
    import threading
    def run():
        import time as _t
        try:
            _t.sleep(8)  # 等 db 与首次请求就绪
            if not _s3_enabled():
                return
            cx = db()
            try:
                r = cx.execute("SELECT v FROM meta WHERE k='s3_migrated'").fetchone()
                if r and r["v"]:
                    return
            finally:
                cx.close()
            res = _migrate_media_to_r2()
            if res.get("ok") and res.get("errors", 0) == 0:
                cx = db()
                try:
                    cx.execute("INSERT OR REPLACE INTO meta(k,v) VALUES('s3_migrated','1')")
                    cx.commit()
                finally:
                    cx.close()
                print("[migrate] 本地媒体已迁移至对象存储并清本地盘:", res)
            else:
                print("[migrate] 迁移未全部成功, 保留本地副本:", res)
        except Exception as e:
            print("[migrate] 自动迁移异常:", e)
    threading.Thread(target=run, daemon=True).start()


def main():
    _free_disk_if_needed()
    init_db()
    migrate_ts()
    purge_plaintext_student_pw()
    _disk_watchdog()  # 后台自动清理孤儿媒体, 防云端盘被撑满
    _backfill_trainlog_dates()  # 存量练习记录补日期(幂等)
    _maybe_automigrate()  # 对象存储就绪后自动把本地媒体搬上云并清本地盘
    srv = ThreadingHTTPServer(("0.0.0.0", PORT), H)
    print(f"[server] 云端同步后端已启动: http://0.0.0.0:{PORT}  (数据目录 {DATA_DIR})")
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        srv.shutdown()


if __name__ == "__main__":
    main()
