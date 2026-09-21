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
  let qf = { kw: "", type: "", kpId: "" };          // 题库筛选：关键词/题型/知识点
  let kpMap = {}, kpKids = {};                      // 知识点索引：id->body / id->[childIds]
  const Q_TYPE_CHIPS = ["选择题", "多选题", "填空题", "解答题", "计算题", "实验题", "作图题", "综合题"];

  // ---------- 知识点索引 ----------
  function buildKpIndex() {
    kpMap = {}; kpKids = {};
    (DB.data.knowledgePoints || []).forEach(it => {
      const b = it.body || {};
      kpMap[it.id] = b;
      const p = b.parentId || "";
      (kpKids[p] = kpKids[p] || []).push(it.id);
    });
  }
  function kpName(id) { return (kpMap[id] && kpMap[id].name) || id; }
  function kpPath(id) {
    const parts = []; let cur = id, guard = 0;
    while (cur && kpMap[cur] && guard++ < 10) { parts.unshift(kpName(cur)); cur = kpMap[cur].parentId || ""; }
    return parts.join(" / ") || id;
  }
  function kpSubtreeIds(id) {
    const out = new Set([id]); const stack = [id];
    while (stack.length) {
      const cur = stack.pop();
      (kpKids[cur] || []).forEach(c => { if (!out.has(c)) { out.add(c); stack.push(c); } });
    }
    return out;
  }
  // 某知识点（含后代）下的题目数
  function kpCount(id) {
    const ids = kpSubtreeIds(id);
    return (DB.data.questions || []).filter(it => ids.has(it.body && it.body.kpId)).length;
  }

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
      buildKpIndex();
      cachePut("pull", DB);
      return true;
    } catch (e) {
      if (!DB.server_ts) {
        const c = cacheGet("pull");
        if (c) {
          DB = c; lastPull = now;
          qMap = {};
          (DB.data.questions || []).forEach(it => { qMap[it.id] = it; });
          buildKpIndex();
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
    switchTab("dashboard");
  }

  // ---------- 题库（题型/知识点/关键词 筛选 + 本地分页） ----------
  function wrongQIds() {
    const s = new Set();
    (DB.data.wrongNotes || []).forEach(it => { const b = it.body || {}; if (!b.resolved && b.questionId) s.add(b.questionId); });
    return s;
  }
  function applyFilter() {
    qf.kw = ($("#qSearch").value || "").trim().toLowerCase();
    const all = DB.data.questions || [];
    const kpIds = qf.kpId ? kpSubtreeIds(qf.kpId) : null;
    qFiltered = all.filter(it => {
      const b = it.body || {};
      if (qf.type && (b.type || "") !== qf.type) return false;
      if (kpIds && !kpIds.has(b.kpId || "")) return false;
      if (qf.kw) {
        const hay = ((b.content || "") + " " + (b.answer || "") + " " + (b.kpId || "") + " " + (b.qid || "") + " " + (b.tags || "") + " " + kpPath(b.kpId || "")).toLowerCase();
        if (!hay.includes(qf.kw)) return false;
      }
      return true;
    });
    // 新知识点优先、同知识点按编号
    qFiltered.sort((a, b) => String(a.body && a.body.kpId).localeCompare(String(b.body && b.body.kpId)) || String(a.body && a.body.qid).localeCompare(String(b.body && b.body.qid), "zh-CN", { numeric: true }));
    qShown = 0;
    renderFilterBar();
    $("#qList").innerHTML = "";
    if (!qFiltered.length) {
      $("#qList").innerHTML = '<div class="center">没有符合条件的题目<br><span style="font-size:12px">试试调整关键词或筛选条件</span></div>';
      $("#qCount").textContent = "共 0 题";
      return;
    }
    showMore();
  }
  function renderFilterBar() {
    const chips = ['<button class="chip' + (qf.type ? "" : " on") + '" onclick="setTypeFilter(\'\')">全部</button>']
      .concat(Q_TYPE_CHIPS.map(t => '<button class="chip' + (qf.type === t ? " on" : "") + '" onclick="setTypeFilter(\'' + t + '\')">' + t + "</button>"));
    $("#qTypeChips").innerHTML = chips.join("");
    const kpChip = $("#qKpChip");
    if (qf.kpId) {
      kpChip.classList.add("on");
      kpChip.innerHTML = "💡 " + esc(kpPath(qf.kpId)) + ' <span class="x">✕</span>';
    } else {
      kpChip.classList.remove("on");
      kpChip.textContent = "💡 全部知识点";
    }
    $("#qCount").textContent = "共 " + qFiltered.length + " 题" + (qf.kpId ? " · " + kpPath(qf.kpId) : "") + (qf.type ? " · " + qf.type : "");
  }
  function setTypeFilter(t) { qf.type = t; applyFilter(); }
  function setKpFilter(id) { qf.kpId = id || ""; applyFilter(); }
  function showMore() {
    if (qShown >= qFiltered.length) {
      if (qShown > 0) toast("已全部加载 " + qFiltered.length + " 题");
      return;
    }
    const slice = qFiltered.slice(qShown, qShown + 20);
    const wrongSet = wrongQIds();
    const frag = document.createDocumentFragment();
    slice.forEach(it => frag.appendChild(qCard(it, wrongSet)));
    qShown += slice.length;
    $("#qList").appendChild(frag);
  }
  const TYPE_BADGE = { "选择题": "tag", "多选题": "badge badge-info", "填空题": "badge badge-success", "解答题": "badge badge-warning", "计算题": "badge badge-warning", "实验题": "badge badge-info", "作图题": "badge badge-info", "综合题": "badge badge-danger" };
  function qCard(it, wrongSet) {
    const b = it.body || {};
    const typeCls = TYPE_BADGE[b.type] || "tag";
    const diff = b.difficulty || "";
    const inCompose = composeSet.includes(it.id);
    const isWrong = wrongSet && wrongSet.has(it.id);
    const badges = [];
    if (b.grade) badges.push('<span class="badge badge-gray">' + esc(b.grade) + "</span>");
    if (diff) badges.push('<span class="badge ' + (diff === "基础" ? "badge-success" : diff === "拔高" ? "badge-danger" : "badge-warning") + '">' + esc(diff) + "</span>");
    if (b.qid) badges.push('<span class="badge badge-gray">' + esc(b.qid) + "</span>");
    const div = document.createElement("div");
    div.className = "card q";
    div.innerHTML =
      '<div class="q-head">' +
        '<span class="' + typeCls + '">' + esc(b.type || "题") + "</span>" +
        '<span class="grow"></span>' + badges.join("") +
        (isWrong ? '<span class="badge badge-danger">错题</span>' : "") +
      "</div>" +
      (b.kpId ? '<div class="q-kp-line"><span class="q-kp" data-act="kp" data-id="' + esc(b.kpId) + '" data-kp="' + esc(b.kpId) + '">💡 ' + esc(kpPath(b.kpId)) + "</span></div>" : "") +
      '<div class="q-body-wrap" data-act="detail" data-id="' + it.id + '"><div class="q-content">' + renderRich(b.content) + "</div></div>" +
      '<button class="q-ans-toggle" data-act="answer" data-id="' + it.id + '">👁 查看答案 / 解析</button>' +
      '<div class="q-ans-box" id="ans-' + it.id + '"><div class="ans-label">答案 / 解析</div>' + (renderRich(b.answer) || "—") + (b.analysis ? '<div style="margin-top:6px">' + renderRich(b.analysis) + "</div>" : "") + "</div>" +
      '<div class="q-actions">' +
        '<button class="btn sec sm" data-act="detail" data-id="' + it.id + '">🔍 详情</button>' +
        '<button class="btn sm' + (inCompose ? " ok" : "") + '" data-act="compose" data-id="' + it.id + '">' + (inCompose ? "✓ 已加入组卷" : "🧩 加入组卷") + "</button>" +
        '<button class="btn danger sm' + (isWrong ? " marked" : "") + '" data-act="wrong" data-id="' + it.id + '">' + (isWrong ? "✓ 已标错题" : "📕 标记错题") + "</button>" +
      "</div>";
    return div;
  }
  // 题库列表统一事件委托（详情/答案/组卷/错题/知识点/图片放大）
  function qListClick(e) {
    const img = e.target.closest("img");
    if (img && $("#qList").contains(img)) { showLightbox(img.src); return; }
    const t = e.target.closest("[data-act]");
    if (!t) return;
    e.stopPropagation();
    const act = t.getAttribute("data-act"), id = t.getAttribute("data-id");
    if (act === "detail") openDetail(id);
    else if (act === "answer") {
      const box = document.getElementById("ans-" + id);
      box.classList.toggle("open");
      t.innerHTML = box.classList.contains("open") ? "🙈 收起答案 / 解析" : "👁 查看答案 / 解析";
    }
    else if (act === "compose") quickCompose(id);
    else if (act === "wrong") markWrong(id);
    else if (act === "kp") { setKpFilter(t.getAttribute("data-kp")); window.scrollTo(0, 0); }
  }
  function quickCompose(id) {
    if (composeSet.includes(id)) { toast("该题已在组卷清单中"); return; }
    composeSet.push(id);
    toast("已加入组卷（共 " + composeSet.length + " 题）");
    applyFilter();
  }
  function showLightbox(src) {
    $("#lightboxImg").src = src;
    $("#lightbox").classList.remove("hidden");
  }

  // ---------- 知识点选择抽屉 ----------
  function openKpSheet() { $("#kpSearch").value = ""; renderKpTree(); $("#kpSheet").classList.remove("hidden"); }
  function closeKpSheet() { $("#kpSheet").classList.add("hidden"); }
  function renderKpTree() {
    const kw = ($("#kpSearch").value || "").trim().toLowerCase();
    const box = $("#kpTree");
    const allBtn = '<div class="kp-row' + (qf.kpId ? "" : " sel") + '" data-kp="" onclick="pickKp(\'\')">' +
      '<span class="kp-toggle leaf">·</span><span class="kp-name">📚 全部知识点</span>' +
      '<span class="kp-cnt">' + (DB.data.questions || []).length + " 题</span></div>";
    function nodeHtml(id) {
      const b = kpMap[id] || {};
      const kids = (kpKids[id] || []).slice().sort((a, c) => String(kpMap[a].name).localeCompare(String(kpMap[c].name), "zh-CN"));
      const cnt = kpCount(id);
      if (kw && !String(b.name || "").toLowerCase().includes(kw) && !kids.some(k => String(kpMap[k].name || "").toLowerCase().includes(kw))) return "";
      const hasKids = kids.length > 0;
      return '<div><div class="kp-row' + (qf.kpId === id ? " sel" : "") + '" data-kp="' + esc(id) + '" onclick="pickKp(\'' + esc(id) + '\')">' +
        '<span class="kp-toggle' + (hasKids ? "" : " leaf") + '" onclick="event.stopPropagation();this.classList.toggle(\'open\');this.closest(\'.kp-row\').parentElement.querySelector(\':scope > .kp-kids\').classList.toggle(\'open\')">' + (hasKids ? "▶" : "") + "</span>" +
        '<span class="kp-name">' + esc(b.name || id) + "</span>" +
        '<span class="kp-cnt">' + cnt + " 题</span></div>" +
        (hasKids ? '<div class="kp-kids">' + kids.map(nodeHtml).join("") + "</div>" : "") +
        "</div>";
    }
    const roots = (kpKids[""] || []).slice().sort((a, c) => String(kpMap[a].name).localeCompare(String(kpMap[c].name), "zh-CN"));
    box.innerHTML = allBtn + roots.map(nodeHtml).join("");
  }
  function pickKp(id) { closeKpSheet(); setKpFilter(id); window.scrollTo(0, 0); }

  // ---------- 标记错题 ----------
  function markWrong(qId) {
    const students = DB.data.students || [];
    const existing = (DB.data.wrongNotes || []).find(it => (it.body || {}).questionId === qId && !(it.body || {}).resolved);
    const box = $("#modalBox");
    box.innerHTML =
      "<h3>📕 标记错题</h3>" +
      '<div style="margin:8px 0">' + renderRich((qMap[qId] && qMap[qId].body || {}).content) + "</div>" +
      '<label class="kv">哪位学生做错（可先不选）</label>' +
      '<select id="wnStudent"><option value="">— 暂不指定 —</option>' +
      students.map(s => '<option value="' + esc(s.id) + '">' + esc((s.body || {}).name || s.id) + "</option>").join("") +
      "</select>" +
      '<label class="kv">备注（错因等，可选）</label>' +
      '<textarea id="wnNote" style="min-height:60px">' + esc(existing ? (existing.body.note || "") : "") + "</textarea>" +
      '<div class="row" style="margin-top:12px">' +
      '<button class="btn ok" onclick="saveWrong(\'' + qId + '\')">保存错题</button>' +
      '<button class="btn sec" onclick="closeModal()">取消</button></div>';
    if (existing && existing.body.studentId) $("#wnStudent").value = existing.body.studentId;
    openModal();
  }
  async function saveWrong(qId) {
    const studentId = $("#wnStudent").value || "";
    const stu = (DB.data.students || []).find(s => s.id === studentId);
    const body = {
      id: "wn_" + Date.now().toString(36),
      questionId: qId,
      studentId, studentName: stu ? ((stu.body || {}).name || "") : "",
      source: "手机端", note: ($("#wnNote").value || "").trim(),
      resolved: false, createdAt: Math.floor(Date.now() / 1000),
      updatedAt: Math.floor(Date.now() / 1000)
    };
    try {
      await api("POST", "/api/wrongNotes", body);
      DB.data.wrongNotes = DB.data.wrongNotes || [];
      DB.data.wrongNotes.push({ id: body.id, updated_at: body.updatedAt, body });
      toast("已标记错题 ✓"); closeModal(); applyFilter();
    } catch (e) { toast("标记失败：" + e.message); }
  }

  // ---------- 错题本 ----------
  function loadWrong() {
    const box = $("#wrongList");
    const kw = ($("#wrongSearch") ? $("#wrongSearch").value : "").trim().toLowerCase();
    let items = (DB.data.wrongNotes || []).slice().reverse();
    if (kw) items = items.filter(it => { const b = it.body || {}; return ((b.studentName || "") + " " + (b.note || "")).toLowerCase().includes(kw); });
    if (!items.length) { box.innerHTML = '<div class="center">还没有错题记录<br><span style="font-size:12px">在题库里点「📕 标记错题」即可添加</span></div>'; return; }
    box.innerHTML = "";
    items.forEach(it => {
      const b = it.body || {};
      const q = qMap[b.questionId] || {};
      const qb = q.body || {};
      const div = document.createElement("div");
      div.className = "card wn-card";
      div.innerHTML =
        '<div class="wn-meta">' +
          '<span class="badge ' + (b.resolved ? "badge-success" : "badge-danger") + '">' + (b.resolved ? "已掌握" : "未掌握") + "</span>" +
          (b.studentName ? '<span class="badge badge-gray">👤 ' + esc(b.studentName) + "</span>" : "") +
          (qb.type ? '<span class="tag">' + esc(qb.type) + "</span>" : "") +
          (qb.qid ? '<span class="badge badge-gray">' + esc(qb.qid) + "</span>" : "") +
        "</div>" +
        '<div onclick="openDetail(\'' + esc(b.questionId) + '\')">' + (renderRich(qb.content) || '<span class="muted">（题目已删除或未同步）</span>') + "</div>" +
        (b.note ? '<div class="wn-note">📝 ' + esc(b.note) + "</div>" : "") +
        '<div class="row" style="margin-top:8px">' +
          '<button class="btn sm ' + (b.resolved ? "sec" : "ok") + '" onclick="toggleWrongResolved(\'' + it.id + '\')">' + (b.resolved ? "标为未掌握" : "✓ 已掌握") + "</button>" +
          '<button class="btn danger sm" onclick="delWrong(\'' + it.id + '\')">删除</button>' +
        "</div>";
      box.appendChild(div);
    });
  }
  async function toggleWrongResolved(id) {
    const it = (DB.data.wrongNotes || []).find(x => x.id === id);
    if (!it) return;
    const body = Object.assign({}, it.body, { resolved: !it.body.resolved, updatedAt: Math.floor(Date.now() / 1000) });
    try {
      await api("PUT", "/api/wrongNotes/" + id, body);
      it.body = body; toast(body.resolved ? "已标为掌握 ✓" : "已标为未掌握"); loadWrong(); 
    } catch (e) { toast("操作失败：" + e.message); }
  }
  async function delWrong(id) {
    if (!confirm("确认删除该错题记录？")) return;
    try {
      await api("DELETE", "/api/wrongNotes/" + id);
      DB.data.wrongNotes = (DB.data.wrongNotes || []).filter(x => x.id !== id);
      toast("已删除"); loadWrong();
    } catch (e) { toast("删除失败：" + e.message); }
  }

  async function openDetail(id) {
    let b = (qMap[id] && qMap[id].body) || null;
    if (!b) {
      try { const r = await api("GET", "/api/questions/" + id); b = r.body; }
      catch (e) { return toast("加载失败：" + e.message); }
    }
    const box = $("#modalBox");
    const inCompose = composeSet.includes(id);
    box.innerHTML = `
      <h3>题目详情</h3>
      <div class="kv">${esc(kpPath(b.kpId || ""))}${b.qid ? " · " + esc(b.qid) : ""} · ${esc(b.type || "")}</div>
      <div style="margin:8px 0">${renderRich(b.content)}</div>
      <div class="kv">答案</div><div>${renderRich(b.answer) || "—"}</div>
      <div class="kv" style="margin-top:6px">解析</div><div>${renderRich(b.analysis) || "—"}</div>
      <div class="row" style="margin-top:14px">
        <button class="btn sm ${inCompose ? "ok" : ""}" onclick="quickCompose('${id}');openDetail('${id}')">${inCompose ? "✓ 已加入组卷" : "🧩 加入组卷"}</button>
        <button class="btn danger sm" onclick="markWrong('${id}')">📕 标记错题</button>
      </div>
      <div class="row" style="margin-top:8px">
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
    if (tab === "wrong") loadWrong();
    if (tab === "papers") loadPapers();
    if (tab === "students") loadStudents();
    if (tab === "compose") { renderComposePool(); renderCompose(); }
    if (tab === "schedule") renderModuleList("schedule");
    if (tab === "exams") renderModuleList("exams");
    if (tab === "knowledgePoints") renderModuleList("knowledgePoints");
    if (tab === "records") renderModuleList("records");
    if (tab === "dashboard") renderDashboard();
  }
  function switchTab(t) {
    tab = t;
    // 侧栏高亮（与桌面版 nav-btn.active 一致）
    document.querySelectorAll(".sb-btn").forEach(b => b.classList.toggle("active", b.dataset.tab === t));
    ["dashboard","questions","wrong","papers","compose","students","schedule","records","exams","knowledgePoints"]
      .forEach(id => $("#tab-" + id).classList.toggle("hidden", id !== t));
    $("#title").textContent = { dashboard: "首页", questions: "题库", wrong: "错题本", papers: "试卷", compose: "组卷",
      students: "学生", schedule: "排课", records: "课时", exams: "考试", knowledgePoints: "知识点" }[t];
    $(".fab").style.display = (t === "dashboard") ? "none" : "flex";
    closeSidebar();
    renderTab();   // 仅用本地缓存渲染，秒开；不再自动后台重拉，避免免费服务器冷启卡顿
  }
  function openSidebar() { $("#sidebar").classList.add("open"); $("#backdrop").classList.add("show"); }
  function closeSidebar() { $("#sidebar").classList.remove("open"); $("#backdrop").classList.remove("show"); }
  // 首页仪表盘（与桌面版 stats-grid / stat-card 一致）
  function renderDashboard() {
    const d = DB.data || {};
    const stats = [
      { ico: "📚", label: "题库题目", value: (d.questions || []).length, color: "" },
      { ico: "📄", label: "试卷", value: (d.papers || []).length },
      { ico: "👥", label: "学生", value: (d.students || []).length },
      { ico: "📝", label: "课时记录", value: (d.records || []).length },
      { ico: "📋", label: "考试", value: (d.exams || []).length },
      { ico: "💡", label: "知识点", value: (d.knowledgePoints || []).length },
    ];
    $("#dashStats").innerHTML = stats.map(s => `
      <div class="stat-card">
        <div class="stat-icon">${s.ico}</div>
        <div class="stat-info">
          <div class="stat-label">${s.label}</div>
          <div class="stat-value">${s.value}</div>
        </div>
      </div>`).join("");
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
      label: "排课",
      title: b => b.studentName || "排课",
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
  window.setTypeFilter = setTypeFilter; window.openKpSheet = openKpSheet; window.closeKpSheet = closeKpSheet;
  window.renderKpTree = renderKpTree; window.pickKp = pickKp;
  window.quickCompose = quickCompose; window.markWrong = markWrong; window.saveWrong = saveWrong;
  window.loadWrong = loadWrong; window.toggleWrongResolved = toggleWrongResolved; window.delWrong = delWrong;
  window.showLightbox = showLightbox;
  window.openDetail = openDetail; window.openEditor = openEditor; window.saveQ = saveQ;
  window.delQ = delQ; window.closeModal = closeModal; window.openPaper = openPaper;
  window.openStudent = openStudent; window.saveStudent = saveStudent;
  window.renderComposePool = renderComposePool; window.addToCompose = addToCompose;
  window.removeFromCompose = removeFromCompose; window.clearCompose = clearCompose;
  window.smartCompose = smartCompose; window.previewCompose = previewCompose; window.saveCompose = saveCompose;
  window.renderModuleList = renderModuleList; window.openModuleDetail = openModuleDetail;
  window.openModuleEditor = openModuleEditor; window.saveModule = saveModule; window.delModule = delModule;
  window.openFab = openFab;
  window.openSidebar = openSidebar; window.closeSidebar = closeSidebar; window.renderDashboard = renderDashboard;

  // 全局事件委托：题库卡片（详情/答案/组卷/错题/知识点/图片放大）
  document.getElementById("qList").addEventListener("click", qListClick);
  document.getElementById("modalBox").addEventListener("click", (e) => {
    const img = e.target.closest("img");
    if (img) showLightbox(img.src);
  });

  // 启动
  if (token) enterMain();
})();
