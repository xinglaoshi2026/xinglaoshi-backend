// 邢老师工作台 · 手机端 SPA（无构建，纯 JS）
// 同源调用后端 /api/*；题目图片 media://... 改写为 /api/media/...
(function () {
  const $ = (s) => document.querySelector(s);
  const LS_TOKEN = "xls_token", LS_USER = "xls_user", LS_BASE = "xls_base";
  let token = localStorage.getItem(LS_TOKEN);
  let user = localStorage.getItem(LS_USER);
  let tab = "questions";
  let qOffset = 0, qHasMore = true;

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
  function debounce(fn, ms) { let t; return function () { clearTimeout(t); t = setTimeout(fn, ms); }; }
  function cachePut(k, v) { try { localStorage.setItem("cache_" + k, JSON.stringify(v)); } catch (e) {} }
  function cacheGet(k) { try { return JSON.parse(localStorage.getItem("cache_" + k)); } catch (e) { return null; } }

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

  function enterMain() {
    $("#loginView").classList.add("hidden"); $("#mainView").classList.remove("hidden");
    const u = user ? JSON.parse(user) : {};
    $("#who").textContent = (u.username || "") + " · 退出";
    $("#who").onclick = logout;
    loadQuestions();
  }

  // ---------- 题库 ----------
  async function loadQuestions(more) {
    if (!more) { qOffset = 0; qHasMore = true; $("#qList").innerHTML = ""; }
    if (!qHasMore && more) return;
    const q = $("#qSearch").value.trim();
    let path = "/api/questions?limit=30&offset=" + qOffset + (q ? "&q=" + encodeURIComponent(q) : "");
    try {
      const r = await api("GET", path);
      const items = r.items || [];
      cachePut(path, items);
      items.forEach(addQCard);
      qOffset += items.length;
      qHasMore = items.length === 30;
      if (items.length === 0 && qOffset === 0) $("#qList").innerHTML = '<div class="center">暂无题目</div>';
    } catch (e) {
      const cached = cacheGet(path);
      if (cached) { cached.forEach(addQCard); toast("离线缓存：" + e.message); }
      else $("#qList").innerHTML = '<div class="center">加载失败：' + e.message + "</div>";
    }
  }
  function addQCard(it) {
    const b = it.body || {};
    const div = document.createElement("div");
    div.className = "card";
    div.innerHTML = `<div class="row"><span class="tag">${esc(b.type || "题")}</span>
      <span class="muted">${esc(b.kpId || "")}</span></div>
      <div style="margin:6px 0">${renderMedia(b.content)}</div>
      <div class="muted">答案：${esc(b.answer || "—")}</div>`;
    div.onclick = () => openDetail(it.id);
    $("#qList").appendChild(div);
  }

  async function openDetail(id) {
    let b;
    try { const r = await api("GET", "/api/questions/" + id); b = r.body; }
    catch (e) { const c = cacheGet("/api/questions/" + id); if (c) b = c.body; else return toast("加载失败：" + e.message); }
    const box = $("#modalBox");
    box.innerHTML = `
      <h3>题目详情</h3>
      <div class="kv">ID: ${esc(id)} · ${esc(b.kpId || "")} · ${esc(b.type || "")}</div>
      <div style="margin:8px 0">${renderMedia(b.content)}</div>
      <div class="kv">答案</div><div>${esc(b.answer || "—")}</div>
      <div class="kv" style="margin-top:6px">解析</div><div>${renderMedia(b.analysis)}</div>
      <div class="row" style="margin-top:14px">
        <button class="btn" onclick="openEditor('${id}')">编辑</button>
        <button class="btn danger" onclick="delQ('${id}')">删除</button>
        <button class="btn sec" onclick="closeModal()">关闭</button>
      </div>`;
    openModal();
  }
  async function delQ(id) {
    if (!confirm("确认删除该题？")) return;
    try { await api("DELETE", "/api/questions/" + id); toast("已删除"); closeModal(); loadQuestions(); }
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
      api("GET", "/api/questions/" + id).then(r => {
        const b = r.body || {};
        $("#etype").value = b.type || "选择题"; $("#ekp").value = b.kpId || "";
        $("#econtent").value = b.content || ""; $("#eanswer").value = b.answer || ""; $("#eanalysis").value = b.analysis || "";
      }).catch(() => {});
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
      toast("已保存"); closeModal(); loadQuestions();
    } catch (e) { toast("保存失败：" + e.message); }
  }

  // ---------- 试卷 ----------
  async function loadPapers() {
    try {
      const r = await api("GET", "/api/papers");
      const items = r.items || [];
      $("#pList").innerHTML = items.length ? "" : '<div class="center">暂无试卷</div>';
      items.forEach(it => {
        const b = it.body || {};
        const div = document.createElement("div"); div.className = "card";
        div.innerHTML = `<h3>${esc(b.title || "未命名试卷")}</h3>
          <div class="muted">学生：${esc((b.studentNames || []).join("、") || b.studentName || "—")} · 题数：${(b.questionIds || []).length}</div>`;
        div.onclick = () => openPaper(it.id);
        $("#pList").appendChild(div);
      });
    } catch (e) { $("#pList").innerHTML = '<div class="center">加载失败：' + e.message + "</div>"; }
  }
  async function openPaper(id) {
    const r = await api("GET", "/api/papers/" + id); const b = r.body || {};
    const ids = b.questionIds || [];
    let qs = "";
    for (const qid of ids.slice(0, 50)) {
      try { const qr = await api("GET", "/api/questions/" + qid); qs += `<div class="card" style="margin:6px 0">${renderMedia(qr.body.content)}<div class="muted">答：${esc(qr.body.answer || "")}</div></div>`; }
      catch (e) { qs += `<div class="muted">（题 ${esc(qid)} 缺失）</div>`; }
    }
    $("#modalBox").innerHTML = `<h3>${esc(b.title || "试卷")}</h3><div class="muted">${esc(b.note || "")}</div>${qs}
      <button class="btn sec" onclick="closeModal()">关闭</button>`;
    openModal();
  }

  // ---------- 学生 ----------
  async function loadStudents() {
    try {
      const r = await api("GET", "/api/students");
      const items = r.items || [];
      $("#sList").innerHTML = items.length ? "" : '<div class="center">暂无学生</div>';
      items.forEach(it => {
        const b = it.body || {};
        const div = document.createElement("div"); div.className = "card";
        div.innerHTML = `<h3>${esc(b.name || "未命名")}</h3>
          <div class="muted">${esc(b.grade || "")} · ${esc(b.school || "")} · 课时余 ${esc(b.hours || "")}</div>`;
        div.onclick = () => openStudent(it.id);
        $("#sList").appendChild(div);
      });
    } catch (e) { $("#sList").innerHTML = '<div class="center">加载失败：' + e.message + "</div>"; }
  }
  async function openStudent(id) {
    let b = {}; try { const r = await api("GET", "/api/students/" + id); b = r.body || {}; } catch (e) {}
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
    try { if (id) await api("PUT", "/api/students/" + id, body); else await api("POST", "/api/students", body); toast("已保存"); closeModal(); loadStudents(); }
    catch (e) { toast("保存失败：" + e.message); }
  }

  // ---------- 弹窗/切换 ----------
  function openModal() { $("#modal").classList.remove("hidden"); }
  function closeModal() { $("#modal").classList.add("hidden"); }
  function switchTab(t) {
    tab = t;
    document.querySelectorAll(".tabs button").forEach(b => b.classList.toggle("on", b.dataset.tab === t));
    $("#tab-questions").classList.toggle("hidden", t !== "questions");
    $("#tab-papers").classList.toggle("hidden", t !== "papers");
    $("#tab-students").classList.toggle("hidden", t !== "students");
    $("#title").textContent = { questions: "题库", papers: "试卷", students: "学生" }[t];
    if (t === "papers") loadPapers();
    if (t === "students") loadStudents();
  }

  // 暴露给 inline onclick
  window.doLogin = doLogin; window.switchTab = switchTab; window.loadQuestions = loadQuestions;
  window.openDetail = openDetail; window.openEditor = openEditor; window.saveQ = saveQ;
  window.delQ = delQ; window.closeModal = closeModal; window.openPaper = openPaper;
  window.openStudent = openStudent; window.saveStudent = saveStudent;

  // 启动
  if (token) enterMain();
})();
