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
import os, sys, json, sqlite3, hashlib, secrets, time, uuid, mimetypes, re, io, zipfile, struct, shutil
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
        id TEXT PRIMARY KEY, username TEXT UNIQUE, pw_hash TEXT, role TEXT, created_at INTEGER);
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
    # 初始化：若没有任何用户，创建默认管理员（用户名 admin / 密码 admin123），仅首次
    cur = cx.execute("SELECT COUNT(*) c FROM users")
    if cur.fetchone()["c"] == 0:
        add_user(cx, "admin", "admin123", "admin")
        print("[init] 已创建默认管理员 admin / admin123 （请登录后修改密码）")
    cx.commit()
    cx.close()


def pw_hash(pw):
    return hashlib.sha256(pw.encode("utf-8")).hexdigest()


def add_user(cx, username, pw, role="user"):
    uid = "u_" + uuid.uuid4().hex[:12]
    cx.execute("INSERT INTO users(id,username,pw_hash,role,created_at) VALUES(?,?,?,?,?)",
               (uid, username, pw_hash(pw), role, int(time.time())))
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
           "dailyQuestions", "dailyAnswers"]


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
    return [{"id": r["id"], "updated_at": r["updated_at"],
             "body": json.loads(r["body"])} for r in rows]


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


def _media_disk(rel):
    """逻辑媒体路径 -> 磁盘路径。

    部分运行环境(如某些云容器的文件系统)不支持中文/全角文件名，
    直接 open 中文路径会写出“乱码”文件、GET 时按解码路径找不到 -> 404。
    这里统一把逻辑路径 URL 编码成 ASCII 再落盘，规避该问题；
    rel 中的 '/' 保留为目录分隔，仅对中文等特殊字符做 %XX 转义。
    """
    return os.path.normpath(os.path.join(MEDIA_DIR, urlquote(rel, safe="/")))


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
    paras.append(_p_text("", sz=12))

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
                # 按原生像素 + 目标 DPI 计算真实尺寸，避免打印时被放大发虚；
                # 仅当比页宽还大时才等比缩到页宽（缩小仍清晰）
                nat_w = int(w * _EMU_PER_IN / _PRINT_DPI)
                nat_h = int(h * _EMU_PER_IN / _PRINT_DPI)
                if nat_w > _EMU_MAX:
                    cx = _EMU_MAX
                    cy = int(nat_h * _EMU_MAX / max(nat_w, 1))
                else:
                    cx = nat_w
                    cy = nat_h
                rid = "rId%d" % (100 + img_idx)
                arc = "word/media/img%d.%s" % (img_idx, ext)
                rels.append((rid, "media/img%d.%s" % (img_idx, ext)))
                media.append((arc, data))
                paras.append(_p_image(rid, img_idx, cx, cy))
        paras.append(_p_text("", sz=12))

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
    r = cx.execute("SELECT s.user_id,u.role,u.username FROM sessions s JOIN users u ON u.id=s.user_id "
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
    def route_get(self):
        p = self.path_only
        if p == "/" or p == "/index.html":
            return send_index(self)
        if p in ("/student", "/student.html"):
            return send_file(self, os.path.join(BASE, "static", "student.html"))
        if p == "/student.webmanifest":
            return send_file(self, os.path.join(BASE, "student.webmanifest"))
        if p.startswith("/static/"):
            fp = os.path.normpath(os.path.join(BASE, "static", p[len("/static/"):]))
            if fp.startswith(os.path.join(BASE, "static")):
                return send_file(self, fp)
            self.send_response(403); self.send_cors(); self.end_headers(); return
        if p.startswith("/api/media/"):
            # URL 路径已是 percent-encoded, 先解码回原始(可能含中文)再查盘,
            # 否则 _media_disk 的 urlquote 会二次编码导致 404。
            rel = urlunquote(p[len("/api/media/"):])
            fp = _safe_media_path(rel)
            if fp:
                return send_file(self, fp)
            self.send_response(404); self.send_cors(); self.end_headers(); return
        if p == "/api/health":
            # 运维诊断: 云端容器磁盘容量/余量(决定能否容纳全部媒体图)
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
        if p == "/api/me":
            u = user_of(get_token(self))
            return send_json(self, u or {"error": "未登录"}, 401 if not u else 200)
        if p == "/api/knowledgePoints":
            return send_json(self, store_list("knowledgePoints", limit=2000))
        if p == "/api/questions":
            since = q.get("since", [None])[0]
            kw = q.get("q", [None])[0]
            kp = q.get("kpId", [None])[0]
            res = store_list("questions", since=since, q=kw, limit=200)
            if kp:
                res = [x for x in res if x["body"].get("kpId") == kp]
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
        p = self.path_only
        q = self.query
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
            r = auth_user(body.get("username", ""), body.get("password", ""))
            if not r: return send_json(self, {"error": "用户名或密码错误"}, 401)
            tok = new_session(r["id"])
            return send_json(self, {"token": tok, "user": {"username": r["username"], "role": r["role"]}})
        # 以下需登录
        u = user_of(get_token(self))
        if not u: return send_json(self, {"error": "未登录"}, 401)
        # ---- 每日一题：学生提交答案并判分 ----
        if p == "/api/daily/answer":
            body, err = read_body(self)
            if err: return send_json(self, {"error": err}, 400)
            qid = body.get("qId")
            if not qid: return send_json(self, {"error": "缺少 qId"}, 400)
            q, _ = store_get("dailyQuestions", qid)
            if q is None: return send_json(self, {"error": "题目不存在"}, 404)
            ans = (body.get("answer") or "").strip()
            qans = (q.get("answer") or "").strip()
            if qans:
                # 标准答案非空：自动比对（去空白、忽略大小写）
                norm = lambda s: re.sub(r"\s+", "", s).lower()
                correct = 1 if norm(ans) == norm(qans) else 0
                open_ended = False
            else:
                # 开放题：由学生自评（仅当明确传 correct=0/1 时记录）
                correct = body.get("correct") if body.get("correct") in (0, 1) else None
                open_ended = True
            aid = "a_" + u["user_id"] + "_" + qid
            rec = {
                "id": aid, "qId": qid, "date": q.get("date"),
                "studentId": u["user_id"], "studentName": u.get("username") or "",
                "answer": ans, "correct": correct, "openEnded": open_ended,
                "updatedAt": now_ms(),
            }
            store_put("dailyAnswers", aid, rec)
            return send_json(self, {
                "ok": True, "correct": correct, "openEnded": open_ended,
                "answer": q.get("answer") or "", "analysis": q.get("analysis") or "",
                "stem": q.get("stem") or "",
            })
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
                        applied += 1
                        continue
                    existing, old_ts = store_get(m, it["id"])
                    if existing and old_ts and old_ts > ts:
                        continue  # 服务端更新更新 -> last write wins
                    store_put(m, it["id"], it["body"], ts=ts)
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
            rel = f"{sub}/{name}"
            # 磁盘空间保护：剩余不足时拒绝写入, 避免撑爆数据盘导致 sync.db(WAL)写入失败而整体宕机
            try:
                free = shutil.disk_usage(os.path.dirname(MEDIA_DIR) or ".").free
                if free < 30 * 1024 * 1024:
                    return send_json(self, {"error": "云端磁盘空间不足, 图片上传被拒绝(请清理或扩容)"}, 507)
            except Exception:
                pass
            fp = _media_disk(rel)
            os.makedirs(os.path.dirname(fp), exist_ok=True)
            with open(fp, "wb") as f: f.write(raw)
            return send_json(self, {"ok": True, "url": "/api/media/" + rel})
        send_json(self, {"error": "未知接口 " + p}, 404)

    # ---- PUT ----
    def route_put(self):
        p = self.path_only
        u = user_of(get_token(self))
        if not u: return send_json(self, {"error": "未登录"}, 401)
        if p.startswith("/api/questions/"):
            id = p[len("/api/questions/"):]
            body, err = read_body(self)
            if err: return send_json(self, {"error": err}, 400)
            body["id"] = id; body["updatedAt"] = now_ts()
            store_put("questions", id, body)
            return send_json(self, {"ok": True, "id": id})
        if p.startswith("/api/papers/"):
            id = p[len("/api/papers/"):]
            body, err = read_body(self)
            if err: return send_json(self, {"error": err}, 400)
            body["id"] = id; body["updatedAt"] = now_ts()
            store_put("papers", id, body)
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
                store_put(m, id, body)
                return send_json(self, {"ok": True, "id": id})
        send_json(self, {"error": "未知接口 " + p}, 404)

    # ---- DELETE ----
    def route_delete(self):
        p = self.path_only
        u = user_of(get_token(self))
        if not u: return send_json(self, {"error": "未登录"}, 401)
        for prefix, mod in (("/api/questions/", "questions"), ("/api/papers/", "papers"),
                            ("/api/exams/", "exams"), ("/api/students/", "students"),
                            ("/api/schedule/", "schedule"), ("/api/records/", "records"),
                            ("/api/knowledgePoints/", "knowledgePoints"),
                            ("/api/examCategories/", "examCategories"),
                            ("/api/dailyQuestions/", "dailyQuestions"),
                            ("/api/dailyAnswers/", "dailyAnswers")):
            if p.startswith(prefix):
                id = p[len(prefix):]
                store_delete(mod, id)
                return send_json(self, {"ok": True, "id": id})
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


def main():
    _free_disk_if_needed()
    init_db()
    migrate_ts()
    srv = ThreadingHTTPServer(("0.0.0.0", PORT), H)
    print(f"[server] 云端同步后端已启动: http://0.0.0.0:{PORT}  (数据目录 {DATA_DIR})")
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        srv.shutdown()


if __name__ == "__main__":
    main()
