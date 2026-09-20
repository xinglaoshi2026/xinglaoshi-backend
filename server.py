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
import os, sys, json, sqlite3, hashlib, secrets, time, uuid, mimetypes
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse, parse_qs
from datetime import datetime, timezone

BASE = os.path.dirname(os.path.abspath(__file__))
DATA_DIR = os.environ.get("DATA_DIR", os.path.join(BASE, "data"))
DB_PATH = os.path.join(DATA_DIR, "sync.db")
MEDIA_DIR = os.path.join(DATA_DIR, "media")
os.makedirs(DATA_DIR, exist_ok=True)
os.makedirs(MEDIA_DIR, exist_ok=True)

PORT = int(os.environ.get("PORT", "8000"))


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


# ---------------- 存储层 ----------------
MODULES = ["questions", "papers", "exams", "students", "schedule",
           "records", "knowledgePoints", "examCategories"]


def store_get(module, id):
    cx = db()
    r = cx.execute("SELECT body,updated_at FROM store WHERE module=? AND id=?", (module, id)).fetchone()
    cx.close()
    if not r:
        return None, None
    return json.loads(r["body"]), r["updated_at"]


def store_put(module, id, body, ts=None):
    ts = ts or now_ts()
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


def store_delete(module, id):
    cx = db()
    cx.execute("DELETE FROM store WHERE module=? AND id=?", (module, id))
    cx.commit()
    cx.close()


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


def send_file(h, path, filename=None):
    if not os.path.exists(path):
        h.send_response(404); h.send_cors(); h.end_headers(); return
    mt = mimetypes.guess_type(path)[0] or "application/octet-stream"
    sz = os.path.getsize(path)
    h.send_response(200)
    h.send_header("Content-Type", mt)
    h.send_header("Content-Length", str(sz))
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
            return send_file(self, os.path.join(BASE, "static", "index.html"))
        if p.startswith("/static/"):
            fp = os.path.normpath(os.path.join(BASE, "static", p[len("/static/"):]))
            if fp.startswith(os.path.join(BASE, "static")):
                return send_file(self, fp)
            self.send_response(403); self.send_cors(); self.end_headers(); return
        if p.startswith("/api/media/"):
            rel = p[len("/api/media/"):]
            fp = os.path.normpath(os.path.join(MEDIA_DIR, rel))
            if fp.startswith(MEDIA_DIR):
                return send_file(self, fp)
            self.send_response(403); self.send_cors(); self.end_headers(); return
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
            return send_json(self, {"server_ts": now_ts(), "data": out})
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
        if p == "/api/sync/push":
            body, err = read_body(self)
            if err: return send_json(self, {"error": err}, 400)
            applied = 0
            data = body.get("data", {})
            for m, items in data.items():
                if m not in MODULES: continue
                for it in items:
                    ts = it.get("updated_at") or now_ts()
                    existing, old_ts = store_get(m, it["id"])
                    if existing and old_ts and old_ts > ts:
                        continue  # 服务端更新更新 -> last write wins
                    store_put(m, it["id"], it["body"], ts=ts)
                    applied += 1
            return send_json(self, {"ok": True, "applied": applied})
        if p == "/api/media":
            # 裸二进制上传：文件名取自 X-Filename 或 ?name=
            name = self.headers.get("X-Filename") or q.get("name", ["upload.bin"])[0]
            name = os.path.basename(name)
            raw, _ = read_body(self)
            if not isinstance(raw, bytes): raw = b""
            # 放入 media/<module>/<id>/... 由前端在路径里指定，这里简单放 media/others
            sub = q.get("sub", ["others"])[0]
            d = os.path.join(MEDIA_DIR, sub)
            os.makedirs(d, exist_ok=True)
            fp = os.path.join(d, name)
            with open(fp, "wb") as f: f.write(raw)
            rel = f"{sub}/{name}"
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
        send_json(self, {"error": "未知接口 " + p}, 404)

    # ---- DELETE ----
    def route_delete(self):
        p = self.path_only
        u = user_of(get_token(self))
        if not u: return send_json(self, {"error": "未登录"}, 401)
        for prefix, mod in (("/api/questions/", "questions"), ("/api/papers/", "papers"),
                            ("/api/exams/", "exams"), ("/api/students/", "students"),
                            ("/api/schedule/", "schedule"), ("/api/records/", "records")):
            if p.startswith(prefix):
                id = p[len(prefix):]
                store_delete(mod, id)
                return send_json(self, {"ok": True, "id": id})
        send_json(self, {"error": "未知接口 " + p}, 404)


def main():
    init_db()
    srv = ThreadingHTTPServer(("0.0.0.0", PORT), H)
    print(f"[server] 云端同步后端已启动: http://0.0.0.0:{PORT}  (数据目录 {DATA_DIR})")
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        srv.shutdown()


if __name__ == "__main__":
    main()
