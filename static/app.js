// 邢老师工作台 · 手机端 SPA（无构建，纯 JS）
// v2：题目内容按 HTML 渲染（media:// 改写为 /api/media/）；
//     一次 /api/sync/pull 拉全量到内存，切页/搜索/翻页全部本地完成，秒开。
(function () {
  const $ = (s) => document.querySelector(s);
  const LS_TOKEN = "xls_token", LS_USER = "xls_user", LS_BASE = "xls_base";
  let token = localStorage.getItem(LS_TOKEN);
  let user = localStorage.getItem(LS_USER);
  let tab = "questions";

  // 全量数据缓存
  let DB = { data: {}, server_ts: 0 };
  let qMap = {};            // id -> question item
  let qFiltered = [], qShown = 0;   // 题库本地过滤 + 分页
  let lastPull = 0;

  // ---------- 工具 ----------
  function api(method, path, body, isRaw, fname) {
    const base = localStorage.getItem(LS_BASE) || "";
    let url = base + path;
    const opt = { method, headers: {} };
    if (token) opt.headers["Authorization"] = "Bearer " + token;
    if (isRaw) {
      opt.body = body;
      if (fname) opt.headers["X-Filename"] = fname;
    } else if (body !== undefined) {
      opt.headers["Content-Type"] = "application/json";
      opt.body = JSON.stringify(body);
    }
    return fetch(url, opt).then(async (r) => {
      let t = "";
      try { t = await r.text(); } catch (e) {}
      if (!r.ok) throw new Error((t && JSON.parse(t).error) || ("HTTP " + r.status));
      return t ? JSON.parse(t) : {};
    });
  }
  function toast(msg) {
    const el = $("#toast"); el.textContent = msg; el.classList.add("show");
    clearTimeout(toast._t); toast._t = setTimeout(() => el.classList.remove("show"), 1800);
  }
  function esc(s) { return (s == null ? "" : String(s)).replace(/[&<>]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c])); }
  // 把 media://questions/<id>/{c,a}/img_1.png 改成可访问的图片标签
  function renderMedia(text) {
    if (!text) return "";
    return esc(text).replace(/media:\/\/questions\/([^\s)]+)/g,
      (m, p) => `<img class="qimg" src="/api/media/${p}" onerror="this.style.display='none'">`);
  }
  // 内容是桌面端生成的 HTML（含 <img src="media://...">）→ 按原样渲染并改写媒体地址；
  // 纯文本则转义后把 media:// 引用转成图片。
  function renderRich(html) {
    if (!html) return "";
    const s = String(html);
    if (/<[a-z][\s\S]*>/i.test(s)) {
      return s.replace(/(src\s*=\s*["'])media:\/\//gi, "$1/api/media/")
              .replace(/<img(?![^>]*onerror)/gi, '<img onerror="this.style.display=\'none\'"');
    }
    return renderMedia(s);
  }
  function debounce(fn, ms) { let t; return function () { clearTimeout(t); t = setTimeout(fn, ms); }; }
  function cachePut(k, v) { try { localStorage.setItem("cache_" + k, JSON.stringify(v)); } catch (e) {} }
  function cacheGet(k) { try { return JSON.parse(localStorage.getItem("cache_" + k)); } catch (e) { return null; } }

  // ---------- 全量拉取 ----------
  async function loadPull(force) {
    const now = Date.now() / 1000;
    if (!force && lastPull && now - lastPull < 60) return;
    try {
      const r = await api("GET", "/api/sync/pull?since=0");
      DB = { data: r.data || {}, server_ts: r.server_ts || 0 };
      lastPull = now;
      qMap = {};
      (DB.data.questions || []).forEach(it => { qMap[it.id] = it; });
      cachePut("pull", DB);
      return true;
    } catch (e) {
      if (!DB.server_ts) {
        const c = cacheGet("pull");
        if (c) {
          DB = c; lastPull = now;
          qMap = {};
          (DB.data.questions || []).forEach(it => { qMap[it.id] = it; });
          toast("离线缓存数据");
        } else {
          toast("加载失败：" + e.message);
        }
      }
      return false;
    }
  }

  // ---------- 登录 ----------
  async function doLogin() {
    const base = $("#baseUrl").value.trim();
    const u = $("#username").value.trim();
    const p = $("#password").value.trim();
    $("#loginMsg").textContent = "登录中…";
    try {
      const r = await api("POST", "/api/auth/login", { username: u, password: p });
      token = r.token; user = JSON.stringify(r.user);
      localStorage.setItem(LS_TOKEN, token); localStorage.setItem(LS_USER, user);
      if (base) localStorage.setItem(LS_BASE, base.replace(/\/+$/, ""));
      enterMain();
    } catch (e) { $("#loginMsg").textContent = "登录失败：" + e.message; }
  }
  function logout() { token = null; localStorage.removeItem(LS_TOKEN); $("#mainView").classList.add("hidden"); $("#loginView").classList.remove("hidden"); }

  async function enterMain() {
    $("#loginView").classList.add("hidden"); $("#mainView").classList.remove("hidden");
    const u = user ? JSON.parse(user) : {};
    $("#who").textContent = (u.username || "") + " · 退出";
    $("#who").onclick = logout;
    $("#qList").innerHTML = '<div class="center">正在同步数据…</div>';
    await loadPull(true);
    applyFilter();
  }

  // ---------- 题库（本地过滤 + 分页） ----------
  function applyFilter() {
    const q = $("#qSearch").value.trim().toLowerCase();
    const all = DB.data.questions || [];
    qFiltered = q ? all.filter(it => {
      const b = it.body || {};
      return ((b.content || "") + " " + (b.answer || "") + " " + (b.kpId || "") + " " + (b.qid || ""))
        .toLowerCase().includes(q);
    }) : all.slice();
    qShown = 0;
    $("#qList").innerHTML = "";
    showMore();
  }
  function showMore() {
    if (qShown >= qFiltered.length) {
      if (qShown > 0) toast("已全部加载 " + qFiltered.length + " 题");
      return;
    }
    const slice = qFiltered.slice(qShown, qShown + 30);
    slice.forEach(addQCard);
    qShown += slice.length;
  }
  function plainText(html) {
    const d = document.createElement("div");
    d.innerHTML = String(html || "");
    return (d.textContent || "").trim().replace(/\s+/g, " ");
  }
  function addQCard(it) {
    const b = it.body || {};
    const cHtml = renderRich(b.content);
    const aText = plainText(b.answer);
    let aShow;
    if (aText) aShow = esc(aText.slice(0, 60)) + (aText.length > 60 ? "…" : "");
    else if (b.answer) aShow = "（图片答案，点击查看）";
    else aShow = "—";
    const div = document.createElement("div");
    div.className = "card";
    div.innerHTML = `<div class="row"><span class="tag">${esc(b.type || "题")}</span>
      <span class="muted">${esc(b.kpId || "")}${b.qid ? " · " + esc(b.qid) : ""}</span></div>
      <div style="margin:6px 0">${cHtml}</div>
      <div class="muted">答案：${aShow}</div>`;
    div.onclick = () => openDetail(it.id);
    $("#qList").appendChild(div);
  }

  async function openDetail(id) {
    let b = (qMap[id] && qMap[id].body) || null;
    if (!b) {
      try { const r = await api("GET", "/api/questions/" + id); b = r.body; }
      catch (e) { return toast("加载失败：" + e.message); }
    }
    const box = $("#modalBox");
    box.innerHTML = `
      <h3>题目详情</h3>
      <div class="kv">ID: ${esc(id)} · ${esc(b.kpId || "")} · ${esc(b.type || "")}</div>
      <div style="margin:8px 0">${renderRich(b.content)}</div>
      <div class="kv">答案</div><div>${renderRich(b.answer) || "—"}</div>
      <div class="kv" style="margin-top:6px">解析</div><div>${renderRich(b.analysis) || "—"}</div>
      <div class="row" style="margin-top:14px">
        <button class="btn" onclick="openEditor('${id}')">编辑</button>
        <button class="btn danger" onclick="delQ('${id}')">删除</button>
        <button class="btn sec" onclick="closeModal()">关闭</button>
      </div>`;
    openModal();
  }
  async function delQ(id) {
    if (!confirm("确认删除该题？")) return;
    try { await api("DELETE", "/api/questions/" + id); toast("已删除"); closeModal(); await loadPull(true); applyFilter(); }
    catch (e) { toast("删除失败：" + e.message); }
  }

  // ---------- 编辑/新建 ----------
  function openEditor(id) {
    const isEdit = !!id;
    const box = $("#modalBox");
    box.innerHTML = `
      <h3>${isEdit ? "编辑题目" : "新建题目"}</h3>
      <input type="hidden" id="eid" value="${esc(id || "")}">
      <label class="kv">题型</label>
      <select id="etype"><option>选择题</option><option>多选题</option><option>填空题</option><option>解答题</option></select>
      <label class="kv">知识点ID(kpId)</label>
      <input id="ekp" placeholder="如 qb3_1_1_1_T1">
      <label class="kv">题干（可含 media://questions/&lt;id&gt;/c/img_1.png 引用图片）</label>
      <textarea id="econtent"></textarea>
      <label class="kv">答案</label>
      <textarea id="eanswer" style="min-height:50px"></textarea>
      <label class="kv">解析</label>
      <textarea id="eanalysis"></textarea>
      <div class="seg">
        <button type="button" id="upC">上传题干图</button>
        <button type="button" id="upA">上传答案图</button>
      </div>
      <div class="row" style="margin-top:10px">
        <button class="btn ok" onclick="saveQ()">保存</button>
        <button class="btn sec" onclick="closeModal()">取消</button>
      </div>`;
    if (isEdit) {
      const b = (qMap[id] && qMap[id].body) || {};
      $("#etype").value = b.type || "选择题"; $("#ekp").value = b.kpId || "";
      $("#econtent").value = b.content || ""; $("#eanswer").value = b.answer || ""; $("#eanalysis").value = b.analysis || "";
    }
    $("#upC").onclick = () => pickImg(id, "c");
    $("#upA").onclick = () => pickImg(id, "a");
    openModal();
  }
  function pickImg(id, kind) {
    const inp = document.createElement("input");
    inp.type = "file"; inp.accept = "image/*";
    inp.onchange = async () => {
      const f = inp.files[0]; if (!f) return;
      const sub = "questions/" + (id || ("new_" + Date.now())) + "/" + kind;
      try {
        await api("POST", "/api/media?sub=" + encodeURIComponent(sub), f, true, "img_1.png");
        const ref = "media://" + sub + "/img_1.png";
        const ta = kind === "c" ? $("#econtent") : $("#eanswer");
        ta.value = (ta.value ? ta.value + "\n" : "") + ref;
        toast("图片已添加：" + ref);
      } catch (e) { toast("上传失败：" + e.message); }
    };
    inp.click();
  }
  async function saveQ() {
    const id = $("#eid").value || ("q_" + Date.now().toString(36));
    const body = {
      id, type: $("#etype").value, kpId: $("#ekp").value.trim(),
      content: $("#econtent").value, answer: $("#eanswer").value, analysis: $("#eanalysis").value,
      updatedAt: Math.floor(Date.now() / 1000)
    };
    try {
      if ($("#eid").value) await api("PUT", "/api/questions/" + id, body);
      else await api("POST", "/api/questions", body);
      toast("已保存"); closeModal();
      await loadPull(true); renderTab();
    } catch (e) { toast("保存失败：" + e.message); }
  }

  // ---------- 试卷（全部走本地缓存） ----------
  function loadPapers() {
    const items = DB.data.papers || [];
    $("#pList").innerHTML = items.length ? "" : '<div class="center">暂无试卷</div>';
    items.forEach(it => {
      const b = it.body || {};
      const div = document.createElement("div"); div.className = "card";
      div.innerHTML = `<h3>${esc(b.title || "未命名试卷")}</h3>
        <div class="muted">题数：${(b.questionIds || []).length}</div>`;
      div.onclick = () => openPaper(it.id);
      $("#pList").appendChild(div);
    });
  }
  async function openPaper(id) {
    const it = (DB.data.papers || []).find(x => x.id === id);
    const b = (it && it.body) || {};
    const ids = b.questionIds || [];
    let qs = "";
    for (const qid of ids.slice(0, 50)) {
      const q = qMap[qid];
      if (q) {
        const qb = q.body || {};
        qs += `<div class="card" style="margin:6px 0">${renderRich(qb.content)}<div class="muted">答：${renderRich(qb.answer) || "—"}</div></div>`;
      } else {
        qs += `<div class="muted">（题 ${esc(qid)} 未同步）</div>`;
      }
    }
    $("#modalBox").innerHTML = `<h3>${esc(b.title || "试卷")}</h3><div class="muted">${esc(b.note || "")}</div>${qs}
      <button class="btn sec" onclick="closeModal()">关闭</button>`;
    openModal();
  }

  // ---------- 学生（本地缓存） ----------
  function loadStudents() {
    const items = DB.data.students || [];
    $("#sList").innerHTML = items.length ? "" : '<div class="center">暂无学生</div>';
    items.forEach(it => {
      const b = it.body || {};
      const div = document.createElement("div"); div.className = "card";
      div.innerHTML = `<h3>${esc(b.name || "未命名")}</h3>
        <div class="muted">${esc(b.grade || "")} · ${esc(b.school || "")} · 课时余 ${esc(b.hours || "")}</div>`;
      div.onclick = () => openStudent(it.id);
      $("#sList").appendChild(div);
    });
  }
  function openStudent(id) {
    const it = (DB.data.students || []).find(x => x.id === id);
    const b = (it && it.body) || {};
    $("#modalBox").innerHTML = `
      <h3>学生信息</h3>
      <label class="kv">姓名</label><input id="sname" value="${esc(b.name || "")}">
      <label class="kv">年级</label><input id="sgrade" value="${esc(b.grade || "")}">
      <label class="kv">学校</label><input id="sschool" value="${esc(b.school || "")}">
      <label class="kv">剩余课时</label><input id="shours" value="${esc(b.hours || "")}">
      <label class="kv">电话</label><input id="sphone" value="${esc(b.phone || "")}">
      <div class="row" style="margin-top:10px">
        <button class="btn ok" onclick="saveStudent('${id}')">保存</button>
        <button class="btn sec" onclick="closeModal()">取消</button>
      </div>`;
    openModal();
  }
  async function saveStudent(id) {
    const body = { id, name: $("#sname").value, grade: $("#sgrade").value, school: $("#sschool").value,
      hours: $("#shours").value, phone: $("#sphone").value, updatedAt: Math.floor(Date.now() / 1000) };
    try { if (id) await api("PUT", "/api/students/" + id, body); else await api("POST", "/api/students", body); toast("已保存"); closeModal(); await loadPull(true); renderTab(); }
    catch (e) { toast("保存失败：" + e.message); }
  }

  // ---------- 弹窗/切换 ----------
  function openModal() { $("#modal").classList.remove("hidden"); }
  function closeModal() { $("#modal").classList.add("hidden"); }
  function renderTab() {
    if (tab === "questions") applyFilter();
    if (tab === "papers") loadPapers();
    if (tab === "students") loadStudents();
  }
  function switchTab(t) {
    tab = t;
    document.querySelectorAll(".tabs button").forEach(b => b.classList.toggle("on", b.dataset.tab === t));
    $("#tab-questions").classList.toggle("hidden", t !== "questions");
    $("#tab-papers").classList.toggle("hidden", t !== "papers");
    $("#tab-students").classList.toggle("hidden", t !== "students");
    $("#title").textContent = { questions: "题库", papers: "试卷", students: "学生" }[t];
    renderTab();                       // 先用缓存立刻渲染（秒开）
    loadPull(false).then(ok => { if (ok) renderTab(); });  // 超过 60 秒才后台刷新
  }

  // 暴露给 inline onclick
  window.doLogin = doLogin; window.switchTab = switchTab; window.loadQuestions = () => applyFilter();
  window.loadMore = showMore;
  window.openDetail = openDetail; window.openEditor = openEditor; window.saveQ = saveQ;
  window.delQ = delQ; window.closeModal = closeModal; window.openPaper = openPaper;
  window.openStudent = openStudent; window.saveStudent = saveStudent;

  // 启动
  if (token) enterMain();
})();
