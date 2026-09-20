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
  function refreshData() {
    toast("正在同步…");
    loadPull(true).then(ok => { if (ok) { renderTab(); toast("已刷新"); } else toast("刷新失败"); });
  }
  function renderTab() {
    if (tab === "questions") applyFilter();
    if (tab === "papers") loadPapers();
    if (tab === "students") loadStudents();
    if (tab === "compose") { renderComposePool(); renderCompose(); }
    if (tab === "schedule") renderModuleList("schedule");
    if (tab === "exams") renderModuleList("exams");
    if (tab === "knowledgePoints") renderModuleList("knowledgePoints");
    if (tab === "records") renderModuleList("records");
  }
  function switchTab(t) {
    tab = t;
    document.querySelectorAll(".tabs button").forEach(b => b.classList.toggle("on", b.dataset.tab === t));
    $("#tab-questions").classList.toggle("hidden", t !== "questions");
    $("#tab-papers").classList.toggle("hidden", t !== "papers");
    $("#tab-students").classList.toggle("hidden", t !== "students");
    $("#tab-compose").classList.toggle("hidden", t !== "compose");
    $("#tab-schedule").classList.toggle("hidden", t !== "schedule");
    $("#tab-exams").classList.toggle("hidden", t !== "exams");
    $("#tab-knowledgePoints").classList.toggle("hidden", t !== "knowledgePoints");
    $("#tab-records").classList.toggle("hidden", t !== "records");
    $("#title").textContent = { questions: "题库", papers: "试卷", students: "学生", compose: "组卷",
      schedule: "课时", exams: "考试", knowledgePoints: "知识点", records: "记录" }[t];
    renderTab();   // 仅用本地缓存渲染，秒开；不再自动后台重拉，避免免费服务器冷启卡顿
  }
  function openFab() {
    if (tab === "questions") return openEditor();
    if (MOD_UI[tab]) return openModuleEditor(tab, null);
    toast("当前页不支持新建");
  }

  // ---------- 组卷 ----------
  let composeSet = [];   // 已选题目 id（有序）
  const TYPE_KEYS = [
    { label: "选择题", input: "cN_choice" },
    { label: "多选题", input: "cN_multi" },
    { label: "填空题", input: "cN_blank" },
    { label: "解答题", input: "cN_solve" },
  ];
  function composePool() {
    const kw = ($("#cKw").value || "").trim().toLowerCase();
    const type = $("#cType").value || "";
    const kp = ($("#cKp").value || "").trim();
    return (DB.data.questions || []).filter(it => {
      const b = it.body || {};
      if (type && b.type !== type) return false;
      if (kp && !String(b.kpId || "").includes(kp)) return false;
      if (kw && !((b.content || "") + " " + (b.answer || "")).toLowerCase().includes(kw)) return false;
      return true;
    });
  }
  function renderComposePool() {
    if (tab !== "compose") return;
    const pool = composePool().slice(0, 60);
    const box = $("#composePool");
    box.innerHTML = pool.length ? "" : '<div class="center">无匹配题目</div>';
    pool.forEach(it => {
      const b = it.body || {};
      const div = document.createElement("div"); div.className = "card";
      const inSet = composeSet.includes(it.id);
      div.innerHTML = `<div class="row"><span class="tag">${esc(b.type || "题")}</span>
        <span class="muted">${esc(b.kpId || "")}${b.qid ? " · " + esc(b.qid) : ""}</span></div>
        <div style="margin:6px 0">${renderRich(b.content)}</div>
        <button class="btn ${inSet ? "sec" : ""}" style="width:100%" ${inSet ? "disabled" : ""} onclick="addToCompose('${it.id}')">${inSet ? "已加入" : "＋ 加入组卷"}</button>`;
      box.appendChild(div);
    });
  }
  function addToCompose(id) { if (!composeSet.includes(id)) { composeSet.push(id); renderComposePool(); renderCompose(); } }
  function removeFromCompose(id) { composeSet = composeSet.filter(x => x !== id); renderComposePool(); renderCompose(); }
  function clearCompose() { composeSet = []; renderComposePool(); renderCompose(); }
  function renderCompose() {
    $("#cCount").textContent = composeSet.length;
    const box = $("#composeList");
    if (!composeSet.length) { box.innerHTML = '<div class="center">还没有选题目，用上方「智能抽取」或手动 ＋ 加入</div>'; return; }
    box.innerHTML = "";
    composeSet.forEach((id, i) => {
      const it = qMap[id]; const b = (it && it.body) || {};
      const div = document.createElement("div"); div.className = "card";
      div.innerHTML = `<div class="row"><span class="muted">${i + 1}.</span>
        <span class="tag">${esc(b.type || "题")}</span>
        <span style="flex:1">${esc(b.qid || id)}</span>
        <button class="btn danger" style="padding:4px 9px;font-size:13px" onclick="removeFromCompose('${id}')">移除</button></div>`;
      box.appendChild(div);
    });
  }
  function smartCompose() {
    const pool = composePool();
    const want = {};
    TYPE_KEYS.forEach(t => { want[t.label] = Math.max(0, parseInt($("#" + t.input).value, 10) || 0); });
    const total = Object.values(want).reduce((a, c) => a + c, 0);
    if (total === 0) return toast("请先设置每种题型要抽几道");
    const byType = {};
    pool.forEach(it => { const tp = (it.body || {}).type || "其他"; (byType[tp] = byType[tp] || []).push(it); });
    const added = [];
    TYPE_KEYS.forEach(t => {
      const n = want[t.label]; if (!n) return;
      const src = (byType[t.label] || []).filter(it => !composeSet.includes(it.id));
      for (let i = src.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [src[i], src[j]] = [src[j], src[i]]; }
      src.slice(0, n).forEach(it => { if (!composeSet.includes(it.id)) { composeSet.push(it.id); added.push(it.id); } });
    });
    if (added.length === 0) return toast("没有更多可抽取的题目（可能已全部加入）");
    renderComposePool(); renderCompose();
    toast("已抽取 " + added.length + " 道，共 " + composeSet.length + " 道");
  }
  function previewCompose() {
    if (!composeSet.length) return toast("还没有选题目");
    let html = `<h3>${esc($("#cTitle").value || "未命名试卷")}</h3><div class="muted">${esc($("#cNote").value || "")}</div>`;
    composeSet.forEach((id, i) => {
      const it = qMap[id]; const b = (it && it.body) || {};
      html += `<div class="card" style="margin:6px 0"><b>${i + 1}.</b> ${renderRich(b.content)}
        <div class="muted">答：${renderRich(b.answer) || "—"}</div></div>`;
    });
    html += `<button class="btn sec" onclick="closeModal()">关闭</button>`;
    $("#modalBox").innerHTML = html; openModal();
  }
  async function saveCompose() {
    if (!composeSet.length) return toast("还没有选题目");
    const body = {
      id: "p_" + Date.now().toString(36),
      title: $("#cTitle").value.trim() || ("组卷_" + new Date().toLocaleString("zh-CN")),
      note: $("#cNote").value.trim(),
      questionIds: composeSet.slice(),
      createdAt: Math.floor(Date.now() / 1000)
    };
    try {
      await api("POST", "/api/papers", body);
      toast("试卷已保存"); closeModal();
      await loadPull(true); switchTab("papers");
    } catch (e) { toast("保存失败：" + e.message); }
  }

  // ---------- 通用模块（课时/考试/知识点/记录）----------
  const WD = ["日", "一", "二", "三", "四", "五", "六"];
  const MOD_UI = {
    schedule: {
      label: "课时",
      title: b => b.studentName || "课时",
      sub: b => `周${WD[b.dayOfWeek] != null ? WD[b.dayOfWeek] : "?"} ${b.startTime || ""}-${b.endTime || ""}` + (b.subject ? " · " + b.subject : "") + (b.location ? " @ " + b.location : ""),
      fields: [
        { k: "studentName", label: "学生", type: "text" },
        { k: "dayOfWeek", label: "星期(0-6)", type: "number" },
        { k: "startTime", label: "开始时间", type: "text" },
        { k: "endTime", label: "结束时间", type: "text" },
        { k: "subject", label: "科目", type: "text" },
        { k: "location", label: "地点", type: "text" },
        { k: "weekStart", label: "周起始日", type: "text" },
        { k: "note", label: "备注", type: "textarea" },
      ],
    },
    exams: {
      label: "考试",
      title: b => b.title || "未命名考试",
      sub: b => [b.grade, b.source, b.tags].filter(Boolean).join(" · "),
      fields: [
        { k: "title", label: "标题", type: "text" },
        { k: "grade", label: "年级", type: "text" },
        { k: "source", label: "来源", type: "text" },
        { k: "tags", label: "标签", type: "text" },
        { k: "categoryId", label: "分类ID", type: "text" },
        { k: "note", label: "备注", type: "textarea" },
        { k: "contentHtml", label: "内容HTML", type: "textarea" },
      ],
      files: true,
    },
    knowledgePoints: {
      label: "知识点",
      title: b => b.name || b.id || "知识点",
      sub: b => b.parentId ? ("父: " + b.parentId) : "顶级",
      fields: [
        { k: "id", label: "ID", type: "text" },
        { k: "name", label: "名称", type: "text" },
        { k: "parentId", label: "父ID", type: "text" },
      ],
    },
    records: {
      label: "记录",
      title: b => (b.studentName || "") + (b.date ? " " + b.date : ""),
      sub: b => [b.type, b.topic].filter(Boolean).join(" · "),
      fields: [
        { k: "studentName", label: "学生", type: "text" },
        { k: "type", label: "类型", type: "text" },
        { k: "date", label: "日期", type: "text" },
        { k: "hours", label: "课时", type: "number" },
        { k: "durationHours", label: "时长(小时)", type: "number" },
        { k: "topic", label: "主题", type: "text" },
        { k: "note", label: "备注", type: "textarea" },
      ],
    },
  };
  function renderModuleList(mod) {
    const ui = MOD_UI[mod]; if (!ui) return;
    const q = ($("#" + mod + "Search") ? $("#" + mod + "Search").value : "").trim().toLowerCase();
    let items = DB.data[mod] || [];
    if (q) items = items.filter(it => { const b = it.body || {}; return (ui.title(b) + " " + (ui.sub ? ui.sub(b) : "")).toLowerCase().includes(q); });
    const box = $("#" + mod + "List");
    box.innerHTML = items.length ? "" : '<div class="center">暂无' + ui.label + "</div>";
    items.forEach(it => {
      const b = it.body || {};
      const div = document.createElement("div"); div.className = "card";
      div.innerHTML = `<div class="row"><span class="tag">${esc(ui.label)}</span>
        <span style="flex:1;font-weight:600">${esc(ui.title(b))}</span></div>
        <div class="muted">${esc(ui.sub(b))}</div>`;
      div.onclick = () => openModuleDetail(mod, it.id);
      box.appendChild(div);
    });
  }
  function openModuleDetail(mod, id) {
    const ui = MOD_UI[mod];
    const it = (DB.data[mod] || []).find(x => x.id === id);
    const b = (it && it.body) || {};
    let html = `<h3>${esc(ui.title(b))}</h3><div class="muted">${esc(ui.sub(b))}</div>`;
    (ui.fields || []).forEach(f => {
      const v = b[f.k];
      if (f.k === "contentHtml" && v) html += `<div class="kv" style="margin-top:6px">${esc(f.label)}</div><div>${renderRich(v)}</div>`;
      else html += `<div class="kv" style="margin-top:4px">${esc(f.label)}：${esc(v == null ? "" : v)}</div>`;
    });
    if (ui.files && (b.files || []).length) {
      html += `<div class="kv" style="margin-top:6px">附件</div>`;
      (b.files || []).forEach(fl => { html += `<div><a href="/api/media/${encodeURIComponent(fl.rel)}" target="_blank">${esc(fl.name || fl.rel)}</a></div>`; });
    }
    html += `<div class="row" style="margin-top:12px">
      <button class="btn" onclick="openModuleEditor('${mod}','${id}')">编辑</button>
      <button class="btn danger" onclick="delModule('${mod}','${id}')">删除</button>
      <button class="btn sec" onclick="closeModal()">关闭</button></div>`;
    $("#modalBox").innerHTML = html; openModal();
  }
  function openModuleEditor(mod, id) {
    const ui = MOD_UI[mod];
    const isEdit = !!id;
    const it = isEdit ? (DB.data[mod] || []).find(x => x.id === id) : null;
    const b = (it && it.body) || {};
    let html = `<h3>${isEdit ? "编辑" : "新建"}${ui.label}</h3>
      <input type="hidden" id="m_mod" value="${mod}"><input type="hidden" id="m_id" value="${esc(id || "")}">`;
    (ui.fields || []).forEach(f => {
      const v = b[f.k] == null ? "" : b[f.k];
      if (f.type === "textarea") html += `<label class="kv">${esc(f.label)}</label><textarea id="mf_${f.k}">${esc(v)}</textarea>`;
      else html += `<label class="kv">${esc(f.label)}</label><input id="mf_${f.k}" type="${f.type === "number" ? "number" : "text"}" value="${esc(v)}">`;
    });
    html += `<div class="row" style="margin-top:12px"><button class="btn ok" onclick="saveModule()">保存</button><button class="btn sec" onclick="closeModal()">取消</button></div>`;
    $("#modalBox").innerHTML = html; openModal();
  }
  async function saveModule() {
    const mod = $("#m_mod").value;
    const id = $("#m_id").value || (mod.slice(0, 2) + "_" + Date.now().toString(36));
    const ui = MOD_UI[mod];
    const body = { id };
    (ui.fields || []).forEach(f => {
      let v = $("#mf_" + f.k).value;
      if (f.type === "number") v = v === "" ? 0 : Number(v);
      body[f.k] = v;
    });
    body.updatedAt = Math.floor(Date.now() / 1000);
    try {
      if ($("#m_id").value) await api("PUT", "/api/" + mod + "/" + id, body);
      else await api("POST", "/api/" + mod, body);
      toast("已保存"); closeModal(); await loadPull(true); renderTab();
    } catch (e) { toast("保存失败：" + e.message); }
  }
  async function delModule(mod, id) {
    if (!confirm("确认删除？")) return;
    try { await api("DELETE", "/api/" + mod + "/" + id); toast("已删除"); closeModal(); await loadPull(true); renderTab(); }
    catch (e) { toast("删除失败：" + e.message); }
  }

  // 暴露给 inline onclick
  window.doLogin = doLogin; window.switchTab = switchTab; window.loadQuestions = () => applyFilter();
  window.refreshData = refreshData;
  window.loadMore = showMore;
  window.openDetail = openDetail; window.openEditor = openEditor; window.saveQ = saveQ;
  window.delQ = delQ; window.closeModal = closeModal; window.openPaper = openPaper;
  window.openStudent = openStudent; window.saveStudent = saveStudent;
  window.renderComposePool = renderComposePool; window.addToCompose = addToCompose;
  window.removeFromCompose = removeFromCompose; window.clearCompose = clearCompose;
  window.smartCompose = smartCompose; window.previewCompose = previewCompose; window.saveCompose = saveCompose;
  window.renderModuleList = renderModuleList; window.openModuleDetail = openModuleDetail;
  window.openModuleEditor = openModuleEditor; window.saveModule = saveModule; window.delModule = delModule;
  window.openFab = openFab;

  // 启动
  if (token) enterMain();
})();
