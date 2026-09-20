# -*- coding: utf-8 -*-
"""把桌面端 data.json 导入云端后端 store，并复制媒体目录。

用法：
  # 本地模式：直接写本地 sqlite（在后端机器上运行）
  python seed.py
  python seed.py --no-media

  # 远程模式：把现有桌面数据推送到已部署的云端后端（在你的电脑上运行）
  python seed.py --url https://你的后端.onrender.com
  python seed.py --url https://你的后端.onrender.com --login admin --password admin123
  python seed.py --url https://... --token <登录拿到的token> --no-media
"""
import os, sys, json, shutil, argparse, time
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import server as S

SRC = "D:/工作/物理老师工作台/data.json"
MEDIA_SRC = "D:/工作/物理老师工作台/media"

MODS = ["questions", "papers", "exams", "students", "schedule",
        "records", "knowledgePoints", "examCategories"]


def _items(d, m):
    items = d.get(m, [])
    if isinstance(items, dict):
        items = list(items.values())
    return [it for it in items if isinstance(it, dict)]


def local_seed(no_media):
    if not os.path.exists(SRC):
        print("未找到 data.json:", SRC); sys.exit(1)
    d = json.load(open(SRC, encoding="utf-8"))
    S.init_db()
    total = 0
    for m in MODS:
        for it in _items(d, m):
            id = str(it.get("id") or it.get("qid") or ("_" + str(total)))
            ts = int(it.get("updatedAt") or it.get("createdAt") or time.time())
            S.store_put(m, id, it, ts=ts)
            total += 1
        print(f"  {m}: {len(_items(d, m))} 条")
    print(f"[seed] 共导入 {total} 条")
    if not no_media:
        _copy_media(MEDIA_SRC, os.path.join(S.MEDIA_DIR, "questions"))
    print("[seed] 完成。默认管理员 admin/admin123")


def _copy_media(src, dst):
    if os.path.exists(src):
        print(f"[seed] 复制媒体 {src} -> {dst} ...")
        shutil.copytree(src, dst, dirs_exist_ok=True)
        print("  完成")
    else:
        print("[seed] 未找到媒体源，跳过")


def remote_push(base, token, no_media):
    import requests  # 仅远程模式需要
    base = base.rstrip("/")
    d = json.load(open(SRC, encoding="utf-8"))
    payload = {"data": {}}
    for m in MODS:
        arr = []
        for it in _items(d, m):
            id = str(it.get("id") or it.get("qid") or it.get("kpId") or ("_" + m))
            ts = int(it.get("updatedAt") or it.get("createdAt") or time.time())
            arr.append({"id": id, "body": it, "updated_at": ts})
        payload["data"][m] = arr
    r = requests.post(base + "/api/sync/push",
                      json=payload, headers={"Authorization": "Bearer " + token}, timeout=120)
    print("[push] 模块数据:", r.status_code, r.text[:200])

    if not no_media and os.path.exists(MEDIA_SRC):
        print("[push] 上传媒体（可能较慢）...")
        n = 0
        for root, _, files in os.walk(MEDIA_SRC):
            for f in files:
                fp = os.path.join(root, f)
                rel = os.path.relpath(fp, MEDIA_SRC).replace("\\", "/")
                sub = os.path.dirname(rel)
                name = os.path.basename(rel)
                with open(fp, "rb") as fh:
                    try:
                        requests.post(base + "/api/media",
                                      params={"sub": sub},
                                      data=fh.read(),
                                      headers={"Authorization": "Bearer " + token,
                                               "X-Filename": name}, timeout=120)
                        n += 1
                    except Exception as e:  # noqa
                        print("  媒体失败", rel, repr(e)[:120])
                if n % 50 == 0:
                    print(f"  已上传 {n} 个媒体")
        print(f"[push] 媒体上传完成：{n} 个")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--url", help="云端后端地址（远程模式）")
    ap.add_argument("--token", help="已有 token（远程模式，可选）")
    ap.add_argument("--login", default="admin")
    ap.add_argument("--password", default="admin123")
    ap.add_argument("--no-media", action="store_true")
    args = ap.parse_args()

    if not args.url:
        local_seed(args.no_media)
        return

    # 远程模式
    if not os.path.exists(SRC):
        print("未找到 data.json:", SRC); sys.exit(1)
    import requests  # 仅远程模式需要
    token = args.token
    if not token:
        r = requests.post(args.url.rstrip("/") + "/api/auth/login",
                          json={"username": args.login, "password": args.password}, timeout=30)
        if r.status_code != 200:
            print("登录失败:", r.status_code, r.text[:200]); sys.exit(1)
        token = r.json().get("token")
        print("[seed] 已登录，获得 token")
    remote_push(args.url.rstrip("/"), token, args.no_media)


if __name__ == "__main__":
    main()
