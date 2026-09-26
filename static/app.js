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
    // 兼容：部分网关会丢弃 DELETE 请求的 Authorization 头（表现为手机端删除一直 401），
    // DELETE 额外把 token 放到查询参数上（服务端 get_token 头/查询参数都认）。
    if (method === "DELETE" && token) {
      url += (url.includes("?") ? "&" : "?") + "token=" + encodeURIComponent(token);
    }
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
  // 媒体文件访问地址：补上后端 base 与登录 token。
  // <img>/<a> 标签无法自动带 Authorization 头，必须放到 URL 上，否则云端媒体接口返回 401，
  // 导致手机端看不到题目/答案图片（电脑端用本地文件故正常）。
  function mediaUrl(p) {
    const base = localStorage.getItem(LS_BASE) || "";
    const t = token || "";
    return base + "/api/media/" + p + (t ? "?token=" + encodeURIComponent(t) : "");
  }
  // 图片加载失败自动重试一次：弱网/慢网下首次加载常超时，
  // 直接隐藏会让"纯图片题"在手机上看起来是一道空题（电脑端本地文件秒开无此问题）。
  function imgRetry(el) {
    if (!el.dataset.r) {
      el.dataset.r = "1";
      el.src = el.src + (el.src.includes("?") ? "&" : "?") + "r=" + Date.now();
    } else { el.style.display = "none"; }
  }
  window.imgRetry = imgRetry;
  // 把 media://questions/<id>/{c,a}/img_1.png 改成可访问的图片标签
  // 捕获组必须带 questions/ 前缀：服务端媒体路径是 questions/<qid>/<kind>/img_N.png，
  // 丢掉该段会拼出 /api/media/<qid>/... 导致 404（表现为手机端看不到题目/答案图片）。
  function renderMedia(text) {
    if (!text) return "";
    return esc(text).replace(/media:\/\/(questions\/[^\s)]+)/g,
      (m, p) => `<img class="qimg" loading="lazy" src="${mediaUrl(p)}" onerror="imgRetry(this)">`);
  }
  // 内容是桌面端生成的 HTML（含 <img src="media://...">）→ 按原样渲染并改写媒体地址；
  // 纯文本则转义后把 media:// 引用转成图片。
  function renderRich(html) {
    if (!html) return "";
    const s = String(html);
    if (/<[a-z][\s\S]*>/i.test(s)) {
      return s.replace(/<div class="qb-meta">[\s\S]*?<\/div>/gi, "")
              .replace(/(src\s*=\s*["'])media:\/\/([^\s"'>]+)/gi,
                (m, pre, p) => pre + mediaUrl(p))
              .replace(/<img(?![^>]*onerror)/gi, '<img loading="lazy" onerror="imgRetry(this)"')
              .replace(/<img(?![^>]*\bclass=)/gi, '<img class="qimg"');
    }
    return renderMedia(s);
  }
  function debounce(fn, ms) { let t; return function () { clearTimeout(t); t = setTimeout(fn, ms); }; }
  function cachePut(k, v) { try { localStorage.setItem("cache_" + k, JSON.stringify(v)); } catch (e) {} }
  function cacheGet(k) { try { return JSON.parse(localStorage.getItem("cache_" + k)); } catch (e) { return null; } }

  // ---------- 通用辅助：日期 / 课时 / 确认弹窗 ----------
  function pad(n) { return (n < 10 ? "0" : "") + n; }
  function dateKey(d) { return d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate()); }
  function addDays(d, n) { const r = new Date(d); r.setDate(r.getDate() + n); return r; }
  function todayStr() { return dateKey(new Date()); }
  const DAYS = ["周一", "周二", "周三", "周四", "周五", "周六", "周日"];
  const WD = ["日", "一", "二", "三", "四", "五", "六"];
  const SCHEDULE_SLOTS = [
    { start: "08:00", end: "10:00", label: "8-10" },
    { start: "10:00", end: "12:00", label: "10-12" },
    { start: "13:00", end: "15:00", label: "1-3" },
    { start: "15:00", end: "17:00", label: "3-5" },
    { start: "17:00", end: "19:00", label: "5-7" },
    { start: "19:00", end: "21:00", label: "7-9" },
    { start: "21:00", end: "23:00", label: "9-11" },
  ];
  /* 返回所查看周的周一（以周一为一周起点）；offset=0 为本周，正负为未来/过去周 */
  function startOfWeekDate(offset) {
    const now = new Date(); now.setHours(0, 0, 0, 0);
    const day = now.getDay(); // 0=周日 .. 6=周六
    const diffToMon = (day === 0 ? -6 : 1 - day);
    return addDays(now, diffToMon + (offset || 0) * 7);
  }
  /* 课时换算：2 小时 = 1 次课 */
  function hoursToLessons(h) { return (parseFloat(h) || 0) / 2; }
  function fmtLessons(n) {
    const v = parseFloat(n) || 0;
    if (Number.isInteger(v)) return String(v);
    const fixed = (Math.round(v * 100) / 100).toFixed(2);
    return fixed.replace(/\.00$/, "").replace(/(\.\d)0$/, "$1");
  }
  /* 通用确认弹窗（移动端友好，替代原生 confirm） */
  function confirmModal(title, html, onOk) {
    const box = $("#modalBox");
    box.innerHTML =
      '<div class="modal-header"><span class="modal-title">' + esc(title) + '</span><button class="modal-close" onclick="closeModal()">✕</button></div>' +
      '<div class="modal-body">' + html + "</div>" +
      '<div class="modal-footer"><button class="btn sec" style="flex:1" onclick="closeModal()">取消</button>' +
      '<button class="btn danger" style="flex:1" onclick="closeModal();__cfmOk()">确定</button></div>';
    window.__cfmOk = onOk;
    openModal();
  }

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

  // 自动同步：定时增量拉取云端，手机端改动无需手动下拉刷新（仅云端有变化才重渲染当前视图）
  let _autoTimer = null;
  async function autoSync() {
    if (!mainTab) return;
    const ae = document.activeElement;
    if (document.querySelector('.modal.open') ||
        (ae && (ae.tagName === 'INPUT' || ae.tagName === 'TEXTAREA'))) return; // 不打断输入/编辑
    try {
      const before = DB.server_ts || 0;
      const r = await api('GET', '/api/sync/pull?since=' + before);
      if (!r || !r.data) return;
      const after = r.server_ts || 0;
      if (after <= before) return; // 云端无新变更
      for (const m of Object.keys(r.data)) {
        const cloud = r.data[m] || [];
        const local = DB.data[m] || [];
        const map = {};
        local.forEach(it => { if (it && it.id) map[it.id] = it; });
        for (const cit of cloud) {
          if (!cit || !cit.id) continue;
          const body = cit.body || cit;
          map[cit.id] = { id: cit.id, updated_at: cit.updated_at || body.updatedAt, body };
        }
        const dels = (r.deletions && r.deletions[m]) || {};
        for (const id in dels) delete map[id];
        DB.data[m] = Object.values(map);
      }
      DB.server_ts = after;
      qMap = {}; (DB.data.questions || []).forEach(it => { qMap[it.id] = it; }); buildKpIndex(); cachePut('pull', DB);
      // 仅在有变化时重渲染当前所在页面（覆盖题目/试卷/课表/学生/错题/记录等所有页）
      // 添加题目页与知识点抽屉打开时禁止重渲染，避免表单/已选知识点被重置
      const addFormVisible = (mainTab === 'questions' && qSubPane === 'add');
      const kpSheetOpen = !($("#kpSheet") && $("#kpSheet").classList.contains('hidden'));
      if (addFormVisible || kpSheetOpen) return;
      if (typeof renderTab === 'function') renderTab();
      else if (mainTab === 'questions') qSub(qSubPane);
    } catch (e) { /* 静默 */ }
  }
  function startAutoSync() {
    if (_autoTimer) return;
    _autoTimer = setInterval(autoSync, 10000);
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
    $("#qList").innerHTML = '<div class="center">正在同步数据…</div>';
    await loadPull(true);
    switchMain("questions");
    startAutoSync(); // 启动自动同步（手机端改动无需手动下拉刷新）
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
    // 新题置顶：按 updated_at 倒序（毫秒），秒级时间戳归一为毫秒，再按 id 稳定排序
    const tsOf = it => {
      let t = it.updated_at || (it.body && (it.body.updatedAt || it.body.createdAt)) || 0;
      if (t && t < 1e11) t *= 1000; // 秒 → 毫秒
      return t;
    };
    qFiltered.sort((a, b) => tsOf(b) - tsOf(a) || String(a.id).localeCompare(String(b.id)));
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
    // 题型下拉
    const typeSel = $("#qTypeSel");
    const curType = qf.type || "";
    typeSel.innerHTML = '<option value="">全部题型</option>' +
      Q_TYPE_CHIPS.map(t => '<option value="' + t + '"' + (t === curType ? " selected" : "") + ">" + t + "</option>").join("");
    typeSel.classList.toggle("on", !!curType);
    // 知识点：用按钮触发层级树抽屉（与电脑端一致的父级/子级形式）
    const kpBtn = $("#qKpBtn");
    const curKp = qf.kpId || "";
    if (curKp && kpMap[curKp]) {
      kpBtn.textContent = "💡 " + kpPath(curKp);
      kpBtn.classList.add("on");
    } else {
      kpBtn.textContent = "全部知识点";
      kpBtn.classList.remove("on");
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
    const frag = document.createDocumentFragment();
    slice.forEach(it => frag.appendChild(qCard(it)));
    qShown += slice.length;
    $("#qList").appendChild(frag);
  }
  function qCard(it) {
    const b = it.body || {};
    const inCompose = composeSet.includes(it.id);
    const div = document.createElement("div");
    div.className = "card q";
    div.innerHTML =
      '<div class="q-body-wrap" data-act="detail" data-id="' + it.id + '"><div class="q-content">' + renderRich(b.content) + "</div></div>" +
      '<div class="q-actions">' +
        '<button class="q-link" data-act="answer" data-id="' + it.id + '">查看解析</button>' +
        '<button class="q-link" data-act="detail" data-id="' + it.id + '">详情</button>' +
        '<button class="q-link' + (inCompose ? " on" : "") + '" data-act="compose" data-id="' + it.id + '">' + (inCompose ? "✕ 取消组卷" : "加入组卷") + "</button>" +
      "</div>" +
      '<div class="q-ans-box" id="ans-' + it.id + '"><div class="ans-label">答案 / 解析</div>' + (renderRich(b.answer) || "—") + (b.analysis ? '<div style="margin-top:6px">' + renderRich(b.analysis) + "</div>" : "") + "</div>";
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
      t.innerHTML = box.classList.contains("open") ? "收起解析" : "查看解析";
    }
    else if (act === "compose") quickCompose(id);
    else if (act === "wrong") markWrong(id);
    else if (act === "kp") { setKpFilter(t.getAttribute("data-kp")); window.scrollTo(0, 0); }
  }
  function quickCompose(id) {
    const i = composeSet.indexOf(id);
    if (i >= 0) {
      composeSet.splice(i, 1);
      toast("已取消组卷");
    } else {
      composeSet.push(id);
      toast("已加入组卷（共 " + composeSet.length + " 题）");
    }
    syncComposeBtn(id);
    updateComposeBar();
  }
  // 原地同步某题的组卷按钮状态（列表卡片 + 详情弹窗），不整页刷新
  function syncComposeBtn(id) {
    const on = composeSet.includes(id);
    document.querySelectorAll('button[data-act="compose"][data-id="' + id + '"]').forEach(btn => {
      btn.classList.toggle("on", on);
      btn.innerHTML = on ? "✕ 取消组卷" : "加入组卷";
    });
  }
  function showLightbox(src) {
    $("#lightboxImg").src = src;
    $("#lightbox").classList.remove("hidden");
  }

  // ---------- 知识点选择抽屉 ----------
  // kpSheet 抽屉复用模式：null=题库筛选；"add"=添加题目表单选知识点
  let kpSheetFor = null;
  let addQKp = ""; // 添加题目表单当前选中的知识点
  let modKpParent = ""; // 知识点编辑表单当前选中的父级（知识点树选择）
  let kpFocusId = ""; // 刚创建的知识点（在树中高亮并展开其祖先）
  function openKpSheet(forWhat) {
    kpSheetFor = forWhat || null;
    kpFocusId = "";
    $("#kpSearch").value = "";
    renderKpTree();
    $("#kpSheet").classList.remove("hidden");
  }
  function closeKpSheet() { $("#kpSheet").classList.add("hidden"); }
  // 选中节点的祖先链（用于再次打开抽屉时自动展开到当前筛选位置）
  function kpAncestors(id) {
    const set = new Set();
    let cur = kpMap[id] && kpMap[id].parentId;
    while (cur) { set.add(cur); cur = kpMap[cur] && kpMap[cur].parentId; }
    return set;
  }
  function renderKpTree() {
    const kw = ($("#kpSearch").value || "").trim().toLowerCase();
    const box = $("#kpTree");
    const isAdd = kpSheetFor === "add";
    const isPick = kpSheetFor === "kpParent";
    const curSel = isAdd ? addQKp : (isPick ? modKpParent : qf.kpId);
    const anc = curSel ? kpAncestors(curSel) : new Set();
    if (kpFocusId) kpAncestors(kpFocusId).forEach(x => anc.add(x));
    const allLabel = isPick ? "（顶级，无父级）" : "📚 全部知识点";
    // "＋"只在知识点管理场景（选择父级/管理）出现；题库选题/筛选时是纯选择器，不显示管理按钮
    const canManage = isPick;
    const allBtn = isAdd ? "" :
      '<div class="kp-row' + (curSel || kpFocusId ? "" : " sel") + '" data-kp="" onclick="pickKp(\'\')">' +
      '<span class="kp-toggle leaf">·</span><span class="kp-name">' + allLabel + '</span>' +
      (canManage ? '<span class="kp-add" title="新建顶级知识点" onclick="event.stopPropagation();kpNewChildAt(\'\')">＋</span>' : "") +
      (isPick ? "" : '<span class="kp-cnt">' + (DB.data.questions || []).length + " 题</span>") + '</div>';
    function nodeHtml(id) {
      const b = kpMap[id] || {};
      const kids = (kpKids[id] || []).slice().sort((a, c) => String(kpMap[a].name).localeCompare(String(kpMap[c].name), "zh-CN"));
      const cnt = kpCount(id);
      if (kw && !String(b.name || "").toLowerCase().includes(kw) && !kids.some(k => String(kpMap[k].name || "").toLowerCase().includes(kw))) return "";
      const hasKids = kids.length > 0;
      const expanded = hasKids && anc.has(id);
      return '<div><div class="kp-row' + (curSel === id || kpFocusId === id ? " sel" : "") + '" data-kp="' + esc(id) + '" onclick="pickKp(\'' + esc(id) + '\')">' +
        '<span class="kp-toggle' + (hasKids ? "" : " leaf") + (expanded ? " open" : "") + '" onclick="event.stopPropagation();this.classList.toggle(\'open\');this.closest(\'.kp-row\').parentElement.querySelector(\':scope > .kp-kids\').classList.toggle(\'open\')">' + (hasKids ? "▶" : "") + "</span>" +
        '<span class="kp-name">' + esc(b.name || id) + "</span>" +
        (canManage ? '<span class="kp-add" title="在此知识点下新建子知识点" onclick="event.stopPropagation();kpNewChildAt(\'' + esc(id) + '\')">＋</span>' : "") +
        '<span class="kp-cnt">' + cnt + " 题</span></div>" +
        (hasKids ? '<div class="kp-kids' + (expanded ? " open" : "") + '">' + kids.map(nodeHtml).join("") + "</div>" : "") +
        "</div>";
    }
    const roots = (kpKids[""] || []).slice().sort((a, c) => String(kpMap[a].name).localeCompare(String(kpMap[c].name), "zh-CN"));
    box.innerHTML = allBtn + roots.map(nodeHtml).join("");
    // 滚动到当前选中的知识点，方便接着选同级/相邻节点
    if (curSel) {
      const sel = box.querySelector(".kp-row.sel");
      if (sel && sel.scrollIntoView) setTimeout(() => sel.scrollIntoView({ block: "center" }), 60);
    }
  }
  function pickKp(id) {
    closeKpSheet();
    if (kpSheetFor === "add") {
      addQKp = id || "";
      const lbl = $("#nq_kp_btn");
      if (lbl) { lbl.textContent = addQKp ? "📍 " + kpPath(addQKp) : "选择知识点"; lbl.classList.toggle("on", !!addQKp); }
      kpSheetFor = null;
      return;
    }
    if (kpSheetFor === "kpParent") {
      modKpParent = id || "";
      const btn = $("#mf_parentId_btn");
      if (btn) { btn.textContent = modKpParent ? "📍 " + kpPath(modKpParent) : "（顶级，无父级）"; btn.classList.toggle("on", !!modKpParent); }
      const hid = $("#mf_parentId"); if (hid) hid.value = modKpParent;
      kpSheetFor = null;
      return;
    }
    setKpFilter(id); window.scrollTo(0, 0);
  }

  // 在知识点树某节点下直接新建子知识点（对齐电脑端的树形新建体验）
  let kpNewParent = "";
  function kpNewChildAt(parentId) {
    kpNewParent = parentId || "";
    const box = $("#modalBox");
    box.innerHTML =
      '<div class="modal-header"><span class="modal-title">🌱 ' + (kpNewParent ? "在「" + esc(kpPath(kpNewParent)) + "」下新建" : "新建顶级知识点") + '</span><button class="modal-close" onclick="closeModal()">✕</button></div>' +
      '<div class="modal-body">' +
        '<div class="form-group"><label class="kv">知识点名称</label><input id="kpNewName" placeholder="如：光的折射"></div>' +
        '<div class="muted">ID 将自动生成，创建后可在「设置 → 知识点管理」中编辑。</div>' +
      "</div>" +
      '<div class="modal-footer"><button class="btn ok" onclick="kpSaveNewChild()">保存</button><button class="btn sec" onclick="closeModal()">取消</button></div>';
    openModal();
    setTimeout(() => { const el = $("#kpNewName"); if (el) el.focus(); }, 80);
  }
  async function kpSaveNewChild() {
    const name = ($("#kpNewName").value || "").trim();
    if (!name) { toast("请填写知识点名称"); return; }
    const id = "kp_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 5);
    try {
      await api("POST", "/api/knowledgePoints", { id, name, parentId: kpNewParent, updatedAt: Date.now() });
      toast("已创建：" + name);
      const fromPicker = kpSheetFor === "kpParent";
      closeModal();
      await loadPull(true);
      buildKpIndex();
      if (fromPicker) {
        // 从知识点编辑器的父级选择进入：创建完成后回到管理列表
        closeKpSheet(); kpSheetFor = null;
        openModuleListEditor("knowledgePoints");
      } else {
        // 浏览/筛选模式：留在树上，定位并高亮新节点
        kpFocusId = id;
        const search = $("#kpSearch"); if (search) search.value = "";
        renderKpTree();
      }
    } catch (e) { toast("创建失败：" + e.message); }
  }

  // ---------- 标记错题 ----------
  function markWrong(qId) {
    const students = DB.data.students || [];
    const existing = (DB.data.wrongNotes || []).find(it => (it.body || {}).questionId === qId && !(it.body || {}).resolved);
    const qb = (qMap[qId] && qMap[qId].body) || {};
    const box = $("#modalBox");
    box.innerHTML =
      '<div class="modal-header"><span class="modal-title">📕 ' + (existing ? "编辑错题" : "标记错题") + '</span><button class="modal-close" onclick="closeModal()">✕</button></div>' +
      '<div class="modal-body">' +
        '<div class="q-preview-card">' + (renderRich(qb.content) || '<span class="muted">（题目内容为空）</span>') + "</div>" +
        '<div class="form-group"><label class="kv">哪位学生做错<span class="opt">（可先不选）</span></label>' +
        '<select id="wnStudent"><option value="">— 暂不指定 —</option>' +
        students.map(s => '<option value="' + esc(s.id) + '">' + esc((s.body || {}).name || s.id) + "</option>").join("") +
        "</select></div>" +
        '<div class="form-group"><label class="kv">备注 / 错因<span class="opt">（可选）</span></label>' +
        '<textarea id="wnNote" style="min-height:88px" placeholder="例如：概念不清 / 公式记错 / 计算失误…">' + esc(existing ? (existing.body.note || "") : "") + "</textarea></div>" +
      "</div>" +
      '<div class="modal-footer">' +
        '<button class="btn sec" style="flex:1" onclick="closeModal()">取消</button>' +
        '<button class="btn ok" style="flex:2" onclick="saveWrong(\'' + qId + '\')">' + (existing ? "保存修改" : "保存错题") + "</button>" +
      "</div>";
    if (existing && existing.body.studentId) $("#wnStudent").value = existing.body.studentId;
    openModal();
  }
  async function saveWrong(qId) {
    const existing = (DB.data.wrongNotes || []).find(it => (it.body || {}).questionId === qId && !(it.body || {}).resolved);
    const studentId = $("#wnStudent").value || "";
    const stu = (DB.data.students || []).find(s => s.id === studentId);
    const base = existing ? existing.body : { id: "wn_" + Date.now().toString(36), source: "手机端", createdAt: Date.now() };
    const body = Object.assign({}, base, {
      questionId: qId,
      studentId, studentName: stu ? ((stu.body || {}).name || "") : "",
      note: ($("#wnNote").value || "").trim(),
      resolved: false, updatedAt: Date.now()
    });
    try {
      if (existing) {
        await api("PUT", "/api/wrongNotes/" + existing.id, body);
        existing.body = body;
        toast("错题已更新 ✓");
      } else {
        await api("POST", "/api/wrongNotes", body);
        DB.data.wrongNotes = DB.data.wrongNotes || [];
        DB.data.wrongNotes.push({ id: body.id, updated_at: body.updatedAt, body });
        toast("已标记错题 ✓");
      }
      closeModal();
      if (paperReopenId) {
        const pid = paperReopenId; paperReopenId = null;
        openPaper(pid);
      } else {
        applyFilter(); loadWrong();
      }
    } catch (e) { toast("保存失败：" + e.message); }
  }

  // ---------- 错题本 ----------
  function loadWrong() {
    const box = $("#wrongList");
    const kw = ($("#wrongSearch") ? $("#wrongSearch").value : "").trim().toLowerCase();
    let items = (DB.data.wrongNotes || []).slice().reverse();
    if (kw) items = items.filter(it => { const b = it.body || {}; return ((b.studentName || "") + " " + (b.note || "")).toLowerCase().includes(kw); });
    if (!items.length) { box.innerHTML = '<div class="center">还没有错题记录<br><span style="font-size:12px">在「组卷」打开某份试卷，每题下方点「📕 标记错题」即可添加</span></div>'; return; }
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
    const body = Object.assign({}, it.body, { resolved: !it.body.resolved, updatedAt: Date.now() });
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
    const badges = [];
    if (b.type) badges.push('<span class="tag">' + esc(b.type) + "</span>");
    if (b.grade) badges.push('<span class="badge badge-gray">' + esc(b.grade) + "</span>");
    if (b.qid) badges.push('<span class="badge badge-gray">' + esc(b.qid) + "</span>");
    if (b.kpId) badges.push('<span class="badge badge-info">💡 ' + esc(kpPath(b.kpId)) + "</span>");
    box.innerHTML = `
      <div class="modal-header"><span class="modal-title">题目详情</span><button class="modal-close" onclick="closeModal()">✕</button></div>
      <div class="modal-body">
        <div class="dt-badges">${badges.join("")}</div>
        <div class="dt-sec"><span class="dt-label">题干</span><div class="dt-content">${renderRich(b.content) || "—"}</div></div>
        <div class="dt-sec"><span class="dt-label ans">答案</span><div class="dt-content ans-box">${renderRich(b.answer) || "—"}</div></div>
        ${b.analysis ? '<div class="dt-sec"><span class="dt-label">解析</span><div class="dt-content">' + renderRich(b.analysis) + "</div></div>" : ""}
      </div>
      <div class="modal-footer">
        <div class="row-3">
          <button class="btn sec" onclick="openEditor('${id}')">编辑</button>
          <button class="btn sec" onclick="delQ('${id}')">删除</button>
          <button class="btn sec" onclick="closeModal()">关闭</button>
        </div>
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
      <div class="modal-header"><span class="modal-title">${isEdit ? "编辑题目" : "新建题目"}</span><button class="modal-close" onclick="closeModal()">✕</button></div>
      <div class="modal-body">
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
      </div>
      <div class="modal-footer">
        <div class="row-2">
          <button class="btn ok" onclick="saveQ()">保存</button>
          <button class="btn sec" onclick="closeModal()">取消</button>
        </div>
      </div>`;
    if (isEdit) {
      const b = (qMap[id] && qMap[id].body) || {};
      $("#etype").value = b.type || "选择题"; $("#ekp").value = b.kpId || "";
      $("#econtent").value = b.content || ""; $("#eanswer").value = b.answer || ""; $("#eanalysis").value = b.analysis || "";
    }
    $("#upC").onclick = () => pickImg("econtent", "c");
    $("#upA").onclick = () => pickImg("eanswer", "a");
    openModal();
  }
  // 图片上传到 题目id/{c,a}/img_N.png（qid 缺省取编辑弹窗当前题目 id）
  function pickImg(targetId, kind, qidArg) {
    const inp = document.createElement("input");
    inp.type = "file"; inp.accept = "image/*";
    inp.onchange = async () => {
      const f = inp.files[0]; if (!f) return;
      const ta = $("#" + targetId);
      const qid = qidArg || ($("#eid") && $("#eid").value) || ("tmp_" + Date.now());
      // 文件名序号：从 textarea 里已有引用推断，避免刷新后重复覆盖 img_1
      let n = 0;
      if (ta) {
        const re = new RegExp("media://questions/" + qid + "/" + kind + "/img_(\\d+)\\.png", "g");
        let mm; while ((mm = re.exec(ta.value))) n = Math.max(n, parseInt(mm[1], 10));
      }
      n += 1;
      const sub = "questions/" + qid + "/" + kind;
      try {
        await api("POST", "/api/media?sub=" + encodeURIComponent(sub), f, true, "img_" + n + ".png");
        const ref = "media://" + sub + "/img_" + n + ".png";
        if (ta) ta.value = (ta.value ? ta.value + "\n" : "") + ref;
        toast("图片已添加");
      } catch (e) { toast("上传失败：" + e.message); }
    };
    inp.click();
  }
  async function saveQ() {
    const id = $("#eid").value || ("q_" + Date.now().toString(36));
    const body = {
      id, type: $("#etype").value, kpId: $("#ekp").value.trim(),
      content: $("#econtent").value, answer: $("#eanswer").value, analysis: $("#eanalysis").value,
      updatedAt: Date.now()
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
    const base = localStorage.getItem(LS_BASE) || "";
    const title = b.title || "试卷";
    const ids = b.questionIds || [];
    currentPaperId = id;
    let qs = "";
    for (const qid of ids.slice(0, 50)) {
      const q = qMap[qid];
      if (q) {
        const qb = q.body || {};
        const wn = (DB.data.wrongNotes || []).find(w => (w.body || {}).questionId === qid && !(w.body || {}).resolved);
        qs += `<div class="card" style="margin:6px 0">${renderRich(qb.content)}` +
          `<div class="muted">答：${renderRich(qb.answer) || "—"}</div>` +
          `<div class="q-actions" style="margin-top:6px;padding:0">` +
            `<button class="q-link ${wn ? " on" : ""}" onclick="openPaperWrong('${esc(qid)}')">${wn ? "✓ 已标错题" : "📕 标记错题"}</button>` +
          `</div></div>`;
      } else {
        qs += `<div class="muted">（题 ${esc(qid)} 未同步）</div>`;
      }
    }
    $("#modalBox").innerHTML = `<div class="modal-header"><span class="modal-title">📄 ${esc(b.title || "试卷")}</span><button class="modal-close" onclick="closeModal()">✕</button></div>
      <div class="modal-body"><div class="muted">${esc(b.note || "")}</div>${qs}</div>
      <div class="modal-footer" style="flex-wrap:wrap;gap:8px">
        <button class="btn ok" style="flex:1 1 100%" onclick="downloadPaper('${esc(id)}')">⬇ 下载 Word 试卷</button>
        <button class="btn sec" style="flex:1 1 100%" onclick="buildWrongPaperFromPaper('${esc(id)}')">📕 本卷错题重组卷</button>
        <button class="btn sec" style="flex:1 1 100%" onclick="closeModal()">关闭</button>
      </div>`;
    openModal();
    // 微信/企业微信等 webview 常拦截自动下载，提示用浏览器打开本页再下载
    const ua = navigator.userAgent || "";
    if (/MicroMessenger|WXWork|QQ\/|Weibo|Alipay/i.test(ua))
      toast("若没自动保存，点右上角 ⋯ 选「用浏览器打开」本页后再下载", 2600);
  }
  // 试卷视图内点「标记错题」：记录来源试卷，保存后回重开该试卷
  function openPaperWrong(qId) {
    paperReopenId = currentPaperId;
    markWrong(qId);
  }
  // 收集未掌握的错题题目 id（可限定学生 / 限定某份试卷的题目范围）
  function wrongQidsFor({ studentId, paperIds } = {}) {
    const scope = new Set();
    if (paperIds) {
      (DB.data.papers || []).forEach(p => {
        if (paperIds.includes(p.id)) (p.body.questionIds || []).forEach(q => scope.add(q));
      });
    }
    const out = []; const seen = new Set();
    (DB.data.wrongNotes || []).forEach(w => {
      const b = w.body || {};
      if (b.resolved) return;
      if (studentId && b.studentId !== studentId) return;
      const qid = b.questionId;
      if (!qid || !qMap[qid]) return;
      if (paperIds && !scope.has(qid)) return;
      if (seen.has(qid)) return;
      seen.add(qid); out.push(qid);
    });
    return out;
  }
  // 弹窗：按学生组「错题练习卷」
  function openWrongPaperBuilder() {
    const students = DB.data.students || [];
    const opts = ['<option value="">全部学生</option>'].concat(
      students.map(s => '<option value="' + esc(s.id) + '">' + esc((s.body || {}).name || s.id) + "</option>")).join("");
    $("#modalBox").innerHTML = `
      <div class="modal-header"><span class="modal-title">📕 错题重组卷</span><button class="modal-close" onclick="closeModal()">✕</button></div>
      <div class="modal-body">
        <div class="muted" style="margin-bottom:10px">把标记给某位（或全部）学生的未掌握错题，整理成一份新的练习卷，发给学生再次练习。</div>
        <div class="form-group"><label class="kv">学生</label><select id="wpStudent">${opts}</select></div>
        <div class="form-group"><label class="kv">试卷标题</label><input id="wpTitle" placeholder="如：小明错题练习卷"></div>
      </div>
      <div class="modal-footer">
        <button class="btn sec" style="flex:1" onclick="closeModal()">取消</button>
        <button class="btn ok" style="flex:1" onclick="buildWrongPaperFromStudent()">生成练习卷</button>
      </div>`;
    openModal();
  }
  async function buildWrongPaperFromStudent() {
    const sid = ($("#wpStudent") ? $("#wpStudent").value : "") || "";
    const stu = (DB.data.students || []).find(s => s.id === sid);
    const qids = wrongQidsFor({ studentId: sid });
    if (!qids.length) return toast("没有可组卷的错题");
    const title = ($("#wpTitle") && $("#wpTitle").value ? $("#wpTitle").value : "").trim() || ("错题练习" + (stu ? "·" + (stu.body || {}).name : ""));
    await saveWrongPaper(title, "错题重组" + (stu ? "·" + (stu.body || {}).name : ""), qids);
  }
  async function buildWrongPaperFromPaper(paperId) {
    const paper = (DB.data.papers || []).find(p => p.id === paperId);
    const qids = wrongQidsFor({ paperIds: [paperId] });
    if (!qids.length) return toast("本卷还没有标记错题");
    const title = ((paper && (paper.body || {}).title) || "试卷") + "·错题练习";
    await saveWrongPaper(title, "本卷错题重组", qids);
  }
  async function saveWrongPaper(title, note, qids) {
    const body = {
      id: "p_" + Date.now().toString(36),
      title, note,
      questionIds: qids.slice(),
      source: "mobile",
      createdAt: Date.now()
    };
    try {
      await api("POST", "/api/papers", body);
      toast("练习卷已生成 ✓"); closeModal();
      await loadPull(true); qSub("compose");
    } catch (e) { toast("生成失败：" + e.message); }
  }

  // 试卷下载：微信/QQ 等 webview 会拦截所有 <a> 下载与新窗口打开，唯一可靠的是复制链接。
  // 直接弹出面板，给出「复制下载链接」按钮 + 链接全文。
  function downloadPaper(id) {
    const it = (DB.data.papers || []).find(x => x.id === id);
    const title = ((it && it.body && it.body.title) || "试卷").replace(/[\\/:*?"<>|]/g, "_");
    const base = localStorage.getItem(LS_BASE) || "";
    const url = base + "/api/papers/" + encodeURIComponent(id) + "/docx";
    const fname = title + ".docx";
    showDownloadPanel(url, fname);
  }

  // 复制文本到剪贴板（含旧浏览器兜底）
  function copyText(t) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      return navigator.clipboard.writeText(t).catch(() => legacyCopy(t));
    }
    return Promise.resolve(legacyCopy(t));
  }
  function legacyCopy(t) {
    try {
      const ta = document.createElement("textarea");
      ta.value = t; ta.style.position = "fixed"; ta.style.opacity = "0";
      document.body.appendChild(ta); ta.focus(); ta.select();
      document.execCommand("copy"); ta.remove(); return true;
    } catch (e) { return false; }
  }

  // 下载面板：微信/QQ 等 webview 会拦截所有 <a> 下载与新窗口打开，唯一可靠的是复制链接。
  // 因此只保留「复制下载链接」按钮，点击后复制真实链接，再去系统浏览器打开下载。
  function showDownloadPanel(url, fname) {
    let box = $("#downloadPanel");
    if (!box) {
      box = document.createElement("div");
      box.id = "downloadPanel";
      box.style.cssText = "position:fixed;inset:0;background:rgba(0,0,0,.55);display:none;align-items:center;justify-content:center;z-index:9999;padding:18px";
      document.body.appendChild(box);
      const st = document.createElement("style");
      st.textContent = ".dp-btn{display:block;width:100%;box-sizing:border-box;text-align:center;padding:13px;border-radius:10px;border:none;background:#2f7d4f;color:#fff;font-size:15px;text-decoration:none;cursor:pointer}.dp-ghost{background:#eee;color:#333}";
      document.head.appendChild(st);
    }
    const ua = navigator.userAgent || "";
    const isWV = /MicroMessenger|WXWork|QQ\/|Weibo|Alipay|webview/i.test(ua);
    box.innerHTML =
      '<div style="background:#fff;border-radius:14px;max-width:340px;width:100%;padding:18px 16px;box-shadow:0 8px 30px rgba(0,0,0,.25)">' +
        '<div style="font-size:16px;font-weight:700;margin-bottom:4px">下载试卷</div>' +
        '<div style="font-size:13px;color:#555;margin-bottom:14px;word-break:break-all">文件名：<b>' + esc(fname) + '</b></div>' +
        '<button class="dp-btn" id="dpCopy">📋 复制下载链接</button>' +
        '<div id="dpHint" style="font-size:12px;color:#888;margin-top:12px;line-height:1.6">' +
          (isWV
            ? '当前在微信/QQ 内，链接与文件会被拦截。请点「复制下载链接」，再打开手机<b>系统浏览器</b>（Chrome/Safari）粘贴打开即可下载；或点右上角 ⋯ →「用浏览器打开」本页后直接下载。'
            : '点「复制下载链接」，粘贴到手机系统浏览器地址栏打开即可下载。') +
        '</div>' +
        '<button class="dp-btn dp-ghost" id="dpClose" style="margin-top:14px">关闭</button>' +
      '</div>';
    box.style.display = "flex";
    const close = () => { box.style.display = "none"; };
    const afterCopy = (ok) => {
      $("#dpHint").style.color = "#2f7d4f";
      $("#dpHint").innerHTML = ok
        ? '✅ 链接已复制：<br>' + esc(url) + '<br>粘贴到手机系统浏览器打开即可下载'
        : '复制失败，请长按下方链接手动复制：<br>' + esc(url);
    };
    $("#dpClose").onclick = close;
    box.onclick = (e) => { if (e.target === box) close(); };
    $("#dpCopy").onclick = () => copyText(url).then(ok => { afterCopy(ok); toast(ok ? "下载链接已复制" : "复制失败，请长按链接"); });
  }

  // ---------- 学生（手机端增删改 + 充值，云端同步） ----------
  function renderStudents() {
    const box = $("#studentList");
    const items = DB.data.students || [];
    box.innerHTML = items.length ? "" : '<div class="center">暂无学生<br><span style="font-size:12px">点上方「＋ 添加学生」</span></div>';
    items.forEach(it => {
      const b = it.body || {};
      const div = document.createElement("div"); div.className = "card stu-card";
      div.innerHTML =
        '<div class="stu-avatar">' + esc((b.name || "?").slice(0, 1)) + "</div>" +
        '<div class="stu-main"><div class="stu-name">' + esc(b.name || "未命名") + "</div>" +
        '<div class="stu-sub">' + esc(b.grade || "") + (b.school ? " · " + esc(b.school) : "") + "</div></div>" +
        '<div class="stu-hours"><div class="h">' + esc(b.hours == null ? "0" : b.hours) + '</div><div class="l">剩余课时</div></div>';
      div.onclick = () => openStudentEditor(it.id);
      box.appendChild(div);
    });
  }
  function openStudentEditor(id) {
    const it = id ? (DB.data.students || []).find(x => x.id === id) : null;
    const b = (it && it.body) || {};
    const isEdit = !!id;
    $("#modalBox").innerHTML = `
      <div class="modal-header"><span class="modal-title">${isEdit ? "学生信息" : "添加学生"}</span><button class="modal-close" onclick="closeModal()">✕</button></div>
      <div class="modal-body">
        <input type="hidden" id="sId" value="${esc(id || "")}">
        <label class="kv">姓名</label><input id="sName" value="${esc(b.name || "")}">
        <label class="kv">年级</label><input id="sGrade" value="${esc(b.grade || "")}">
        <label class="kv">学校</label><input id="sSchool" value="${esc(b.school || "")}">
        <label class="kv">电话</label><input id="sPhone" value="${esc(b.phone || "")}">
        <label class="kv">家长姓名</label><input id="sParentName" value="${esc(b.parentName || "")}">
        <label class="kv">家长电话</label><input id="sParentPhone" value="${esc(b.parentPhone || "")}">
        <label class="kv">单价（元/课时）</label><input id="sPrice" type="number" value="${esc(b.price == null ? "" : b.price)}">
        <label class="kv">剩余课时</label><input id="sHours" type="number" value="${esc(b.hours == null ? "" : b.hours)}">
        <label class="kv">欠费（元）</label><input id="sArrears" type="number" value="${esc(b.arrears == null ? "" : b.arrears)}">
        <label class="kv">备注</label><textarea id="sNote">${esc(b.note || "")}</textarea>
        ${isEdit ? `<div class="form-group" style="margin-top:12px"><label class="kv">充值课时</label><div class="row"><input id="sRecharge" type="number" placeholder="本次充值课时数"><button class="btn sec" onclick="doRecharge()">充值</button></div><div class="muted">充值将增加剩余课时，并写入课时记录（电脑端同步可见）。</div></div>` : ""}
      </div>
      <div class="modal-footer"><button class="btn sec" style="flex:1" onclick="closeModal()">取消</button><button class="btn ok" style="flex:1" onclick="saveStudentEditor()">保存</button></div>`;
    openModal();
  }
  async function saveStudentEditor() {
    const id = $("#sId").value || ("stu_" + Date.now().toString(36));
    const body = {
      id,
      name: $("#sName").value.trim(),
      grade: $("#sGrade").value.trim(),
      school: $("#sSchool").value.trim(),
      phone: $("#sPhone").value.trim(),
      parentName: $("#sParentName").value.trim(),
      parentPhone: $("#sParentPhone").value.trim(),
      price: $("#sPrice").value === "" ? 0 : Number($("#sPrice").value),
      hours: $("#sHours").value === "" ? 0 : Number($("#sHours").value),
      arrears: $("#sArrears").value === "" ? 0 : Number($("#sArrears").value),
      note: $("#sNote").value.trim(),
      updatedAt: Date.now()
    };
    if (!body.name) return toast("姓名不能为空");
    try {
      if ($("#sId").value) await api("PUT", "/api/students/" + id, body);
      else await api("POST", "/api/students", body);
      toast("已保存 ✓"); closeModal();
      await loadPull(true); renderStudents();
    } catch (e) { toast("保存失败：" + e.message); }
  }
  async function doRecharge() {
    const id = $("#sId").value;
    const hours = parseInt($("#sRecharge").value, 10);
    if (!hours || hours <= 0) return toast("请输入有效的充值课时数");
    const it = (DB.data.students || []).find(x => x.id === id);
    if (!it) return;
    const b = it.body || {};
    const newHours = (Number(b.hours) || 0) + hours;
    const studentBody = Object.assign({}, b, { hours: newHours, updatedAt: Date.now() });
    const rec = {
      id: "rec_" + Date.now().toString(36), studentId: id, studentName: b.name || "",
      type: "recharge", hours: hours, date: todayStr(), topic: "充值 " + hours + " 课时",
      note: "手机端充值", createdAt: Date.now()
    };
    try {
      await api("PUT", "/api/students/" + id, studentBody);
      await api("POST", "/api/records", rec);
      toast("已充值 " + hours + " 课时 ✓");
      closeModal();
      await loadPull(true); renderStudents();
    } catch (e) { toast("充值失败：" + e.message); }
  }

  // ---------- 弹窗/切换 ----------
  function openModal() { $("#modal").classList.remove("hidden"); }
  function closeModal() { $("#modal").classList.add("hidden"); }
  function refreshData() {
    toast("正在同步…");
    loadPull(true).then(ok => { if (ok) { renderTab(); toast("已刷新"); } else toast("刷新失败"); });
  }
  // ---------- 底部四主菜单导航 ----------
  let mainTab = "questions";
  let qSubPane = "q";
  let schedSubPane = "grid";
  function renderTab() {
    if (mainTab === "questions") { if (qSubPane !== "add") qSub(qSubPane); } // 添加表单页不重渲染，防清空
    else if (mainTab === "schedule") schedSub(schedSubPane);
    else if (mainTab === "students") renderStudents();
    else if (mainTab === "settings") renderSettings();
    else if (mainTab === "daily") renderDaily();
  }
  function switchMain(m) {
    mainTab = m;
    ["questions", "schedule", "students", "settings", "daily"].forEach(id =>
      $("#view-" + id).classList.toggle("hidden", id !== m));
    document.querySelectorAll(".tab-btn").forEach(b => b.classList.toggle("active", b.dataset.main === m));
    if (m === "questions") qSub(qSubPane);
    else if (m === "schedule") schedSub(schedSubPane);
    else if (m === "students") renderStudents();
    else if (m === "settings") renderSettings();
    else if (m === "daily") renderDaily();
  }
  function qSub(s) {
    qSubPane = s;
    document.querySelectorAll("#qSubTabs .subtab").forEach(b => b.classList.toggle("on", b.dataset.sub === s));
    ["q", "compose", "paper", "wrong", "add"].forEach(id => $("#sub-" + id).classList.toggle("hidden", id !== s));
    if (s === "q") applyFilter();
    else if (s === "compose") renderMyPapers();
    else if (s === "paper") renderAllPapers();
    else if (s === "wrong") loadWrong();
    else if (s === "add") renderAddQForm();
    updateComposeBar();
  }
  function schedSub(s) {
    schedSubPane = s;
    document.querySelectorAll("#schedSubTabs .subtab").forEach(b => b.classList.toggle("on", b.dataset.sub === s));
    $("#sub-grid").classList.toggle("hidden", s !== "grid");
    $("#sub-records").classList.toggle("hidden", s !== "records");
    if (s === "grid") renderScheduleGrid();
    else renderRecordsList();
  }
  function openSidebar() {} function closeSidebar() {} function closeArc() {}

  // ---------- 组卷（在题库点「加入组卷」收集，底部浮条保存） ----------
  let composeSet = [];   // 已选题目 id（有序）
  let currentPaperId = null;  // 当前打开的试卷（用于试卷内标记错题后回显）
  let paperReopenId = null;   // 标记错题来自试卷视图时，保存后回重开该试卷
  // 底部浮条：仅当在「题库」子视图且已选题目时显示
  function updateComposeBar() {
    const bar = $("#composeBar");
    if (!bar) return;
    if (qSubPane === "q" && composeSet.length > 0) {
      bar.classList.remove("hidden");
      $("#cSelCount").textContent = composeSet.length;
    } else {
      bar.classList.add("hidden");
    }
  }
  function clearComposeSel() {
    composeSet = [];
    if (qSubPane === "q") applyFilter();
    updateComposeBar();
    toast("已清空选择");
  }
  function openComposeModal() {
    toast("去「题库」点题目上的「🧩 加入组卷」");
    switchMain("questions"); qSub("q");
  }
  async function doComposeSave() {
    if (!composeSet.length) return toast("还没有选题目");
    $("#modalBox").innerHTML = `
      <div class="modal-header"><span class="modal-title">🧩 保存组卷</span><button class="modal-close" onclick="closeModal()">✕</button></div>
      <div class="modal-body">
        <div class="muted" style="margin-bottom:10px">已选 ${composeSet.length} 道题，给这份试卷起个名字：</div>
        <label class="kv">试卷标题</label><input id="cTitle" placeholder="如：2026秋季高三力学测试">
        <label class="kv">备注（可选）</label><textarea id="cNote" placeholder="如：周末作业 / 期中复习"></textarea>
      </div>
      <div class="modal-footer"><button class="btn sec" style="flex:1" onclick="closeModal()">取消</button><button class="btn ok" style="flex:1" onclick="commitComposeSave()">保存并生成试卷</button></div>`;
    openModal();
  }
  async function commitComposeSave() {
    const title = ($("#cTitle").value || "").trim() || ("组卷_" + new Date().toLocaleString("zh-CN"));
    const body = {
      id: "p_" + Date.now().toString(36),
      title,
      note: ($("#cNote").value || "").trim(),
      questionIds: composeSet.slice(),
      source: "mobile",
      createdAt: Date.now()
    };
    try {
      await api("POST", "/api/papers", body);
      toast("试卷已保存 ✓"); closeModal();
      composeSet = []; updateComposeBar();
      if (qSubPane === "q") applyFilter();
      await loadPull(true); qSub("compose");
    } catch (e) { toast("保存失败：" + e.message); }
  }
  function paperCard(it) {
    const b = it.body || {};
    const div = document.createElement("div"); div.className = "card pa-card";
    div.innerHTML =
      '<div class="pa-main"><div class="pa-title">' + esc(b.title || "未命名试卷") + "</div>" +
      '<div class="pa-sub">题数：' + ((b.questionIds || []).length) + (b.note ? " · " + esc(b.note) : "") + (b.source === "mobile" ? " · 📱手机组" : b.source === "desktop" ? " · 🖥电脑组" : "") + "</div></div>" +
      '<div class="pa-actions"><button class="btn sm" onclick="openPaper(\'' + esc(it.id) + '\')">查看</button>' +
      '<button class="btn ok sm" onclick="downloadPaper(\'' + esc(it.id) + '\')">下载</button></div>';
    return div;
  }
  function renderMyPapers() {
    const box = $("#myPapers");
    const items = (DB.data.papers || []).filter(p => { const s = (p.body || {}).source; return s === "mobile" || s === "desktop"; });
    box.innerHTML = items.length ? "" : '<div class="center">还没有组卷<br><span style="font-size:12px">去「题库」选题目加入组卷</span></div>';
    items.forEach(it => box.appendChild(paperCard(it)));
  }
  function renderAllPapers() {
    const box = $("#allPapers");
    const items = DB.data.papers || [];
    box.innerHTML = items.length ? "" : '<div class="center">暂无试卷</div>';
    items.forEach(it => box.appendChild(paperCard(it)));
    renderExamsM();
  }

  // ---------- 收藏试卷（exams，与电脑端「试卷中心·收藏试卷」一致） ----------
  let examDraft = { id: null, files: [] };   // 编辑/新增时的草稿（含待上传附件 rels）
  function renderExamsM() {
    const fbtn = $("#examCatFilterBtn");
    if (fbtn) fbtn.textContent = examCatFilter ? "🏷️ " + catPath(examCatFilter) : "全部分类";
    const box = $("#examListM"); if (!box) return;
    let items = DB.data.exams || [];
    if (examCatFilter) {
      const subs = catSubtreeIds(examCatFilter);
      items = items.filter(it => subs.has((it.body && it.body.categoryId) || ""));
    }
    const cnt = $("#examCountM"); if (cnt) cnt.textContent = "(" + (DB.data.exams || []).length + "份)";
    box.innerHTML = items.length ? "" :
      '<div class="center">还没有收藏试卷<br><span style="font-size:12px">真题卷、期末卷、好练习卷都能收藏，可上传 PDF/Word</span></div>';
    items.forEach(it => {
      const b = it.body || {};
      const files = b.files || [];
      const meta = [b.grade, b.source, (b.tags || "").toString()].filter(Boolean).join(" · ");
      let catLabel = "";
      if (b.categoryId) { const cc = examCats().find(x => x.id === b.categoryId); if (cc) catLabel = " · 🏷️ " + catPath(b.categoryId); }
      const div = document.createElement("div"); div.className = "card pa-card";
      div.innerHTML =
        '<div class="pa-main"><div class="pa-title">' + esc(b.title || "未命名试卷") + "</div>" +
        '<div class="pa-sub">' + esc(meta) + (files.length ? " · 📎" + files.length + "个附件" : "") + catLabel + "</div></div>" +
        '<div class="pa-actions">' +
          '<button class="btn sm" onclick="openExamDetail(\'' + esc(it.id) + '\')">查看</button>' +
          '<button class="btn ok sm" onclick="openExamEditor(\'' + esc(it.id) + '\')">编辑</button>' +
          '<button class="btn danger sm" onclick="delExamM(\'' + esc(it.id) + '\')">删除</button>' +
        "</div>";
      box.appendChild(div);
    });
  }
  function openExamEditor(id) {
    const isEdit = !!id;
    const it = isEdit ? (DB.data.exams || []).find(x => x.id === id) : null;
    const b = (it && it.body) || {};
    examDraft = { id: isEdit ? id : ("ex_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6)),
                  files: (b.files || []).map(f => ({ rel: f.rel, name: f.name })) };
    const v = (k, ph) => '<input id="ef_' + k + '" value="' + esc(b[k] || "") + '" placeholder="' + ph + '">';
    let html = `
      <div class="modal-header"><span class="modal-title">${isEdit ? "编辑" : "新建"}收藏试卷</span><button class="modal-close" onclick="closeModal()">✕</button></div>
      <div class="modal-body">
      <label class="kv">标题</label>${v("title", "如：2026高三一模物理卷")}
      <label class="kv">年级</label>${v("grade", "如：高三")}
      <label class="kv">来源</label>${v("source", "如：学校月考")}
      <label class="kv">标签（空格分隔）</label>${v("tags", "如：真题 期末")}
      <label class="kv">分类</label>
      <button id="ef_cat_btn" class="filter-select" style="width:100%;text-align:left" onclick="openCatSheet('pick')">${esc(b.categoryId ? catPath(b.categoryId) : "未分类（点此选择）")}</button>
      <input type="hidden" id="ef_cat" value="${esc(b.categoryId || "")}">
      <label class="kv">备注</label><textarea id="ef_note">${esc(b.note || "")}</textarea>
      <label class="kv">内容（整卷文字 / 说明，可选）</label><textarea id="ef_content">${esc(b.contentHtml || "")}</textarea>
      <label class="kv">附件（PDF / Word / 图片）</label>
      <label class="btn ok" for="ef_docs" style="display:block;text-align:center;padding:11px;font-size:15px">📎 上传文档（PDF / Word 等，可多选）<input type="file" id="ef_docs" multiple
        accept=".pdf,.doc,.docx,.ppt,.pptx,.xls,.xlsx,.txt,application/pdf,application/msword,application/vnd.openxmlformats-officedocument.wordprocessingml.document,application/vnd.openxmlformats-officedocument.presentationml.presentation,application/vnd.ms-powerpoint,application/vnd.ms-excel,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
        style="display:none" onchange="examUploadFiles(this)"></label>
      <label class="btn sec" for="ef_imgs" style="display:block;text-align:center;padding:11px;font-size:15px;margin-top:8px">🖼️ 添加图片<input type="file" id="ef_imgs" multiple
        accept="image/*"
        style="display:none" onchange="examUploadFiles(this)"></label>
      <div id="ef_fileList" class="muted" style="margin-top:6px"></div>
      </div>
      <div class="modal-footer">
        <div class="row-2">
          <button class="btn ok" onclick="saveExamM()">保存</button>
          <button class="btn sec" onclick="closeModal()">取消</button>
        </div>
      </div>`;
    $("#modalBox").innerHTML = html; openModal(); renderExamFileList();
  }
  async function examUploadFiles(input) {
    const files = Array.from(input.files || []);
    if (!files.length) return;
    toast("正在上传 " + files.length + " 个文件…");
    for (const f of files) {
      try {
        const buf = await f.arrayBuffer();
        // 文件名走 ?name= 查询参数：X-Filename 头放中文会按 latin-1 编码损坏，
        // 服务端优先取查询参数里的文件名。
        const res = await api("POST", "/api/media?sub=" + encodeURIComponent("exams/" + examDraft.id) + "&name=" + encodeURIComponent(f.name), buf, true);
        const rel = (res.url || "").replace(/^\/api\/media\//, "");
        if (rel) examDraft.files.push({ rel, name: f.name });
      } catch (e) { toast("上传失败：" + f.name + " " + e.message); }
    }
    renderExamFileList(); toast("上传完成");
  }
  function renderExamFileList() {
    const el = $("#ef_fileList"); if (!el) return;
    if (!examDraft.files.length) { el.textContent = "暂无附件"; return; }
    el.innerHTML = examDraft.files.map((f, i) =>
      '<div style="display:flex;align-items:center;gap:8px;margin:3px 0">' +
      '<a href="' + mediaUrl(encodeURIComponent(f.rel)) + '" target="_blank" style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">' + esc(f.name || f.rel) + "</a>" +
      '<button class="btn danger sm" onclick="examRemoveFile(' + i + ')">移除</button></div>'
    ).join("");
  }
  function examRemoveFile(i) { examDraft.files.splice(i, 1); renderExamFileList(); }
  async function saveExamM() {
    const body = {
      id: examDraft.id,
      title: ($("#ef_title") ? $("#ef_title").value : "").trim(),
      grade: ($("#ef_grade") ? $("#ef_grade").value : "").trim(),
      source: ($("#ef_source") ? $("#ef_source").value : "").trim(),
      tags: ($("#ef_tags") ? $("#ef_tags").value : "").trim(),
      categoryId: ($("#ef_cat") ? $("#ef_cat").value : "").trim(),
      note: ($("#ef_note") ? $("#ef_note").value : "").trim(),
      contentHtml: ($("#ef_content") ? $("#ef_content").value : "").trim(),
      files: examDraft.files.slice()
    };
    if (!body.title) return toast("请填写标题");
    body.updatedAt = Date.now();
    try {
      const existing = (DB.data.exams || []).find(x => x.id === examDraft.id);
      if (existing) await api("PUT", "/api/exams/" + encodeURIComponent(examDraft.id), body);
      else await api("POST", "/api/exams", body);
      toast("已保存"); closeModal(); await loadPull(true); renderAllPapers();
    } catch (e) { toast("保存失败：" + e.message); }
  }
  function openExamDetail(id) {
    const it = (DB.data.exams || []).find(x => x.id === id);
    const b = (it && it.body) || {};
    const files = b.files || [];
    let html = '<div class="modal-header"><span class="modal-title">' + esc(b.title || "未命名试卷") + '</span><button class="modal-close" onclick="closeModal()">✕</button></div>' +
      '<div class="modal-body">' +
      '<div class="muted">' + esc([b.grade, b.source, b.tags].filter(Boolean).join(" · ")) + "</div>" +
      '<div style="margin-top:6px"><button class="btn sec sm" onclick="openCatSheet(\'pick\')">🏷️ ' + esc(b.categoryId ? catPath(b.categoryId) : "未分类") + "</button></div>";
    if (b.note) html += '<div class="kv" style="margin-top:8px">备注</div><div>' + esc(b.note) + "</div>";
    if (b.contentHtml) html += '<div class="kv" style="margin-top:8px">内容</div><div>' + renderRich(b.contentHtml) + "</div>";
    if (files.length) {
      html += '<div class="kv" style="margin-top:8px">附件（' + files.length + "）</div>";
      files.forEach(fl => { html += '<div style="margin:4px 0"><a href="' + mediaUrl(encodeURIComponent(fl.rel)) + '" target="_blank" download>' + esc(fl.name || fl.rel) + "</a></div>"; });
    }
    html += '</div><div class="modal-footer"><div class="row-3">' +
      '<button class="btn sec" onclick="openExamEditor(\'' + esc(id) + '\')">编辑</button>' +
      '<button class="btn sec" onclick="delExamM(\'' + esc(id) + '\')">删除</button>' +
      '<button class="btn sec" onclick="closeModal()">关闭</button>' +
      "</div></div>";
    $("#modalBox").innerHTML = html; openModal();
  }
  async function delExamM(id) {
    if (!confirm("确认删除这份收藏试卷？")) return;
    try { await api("DELETE", "/api/exams/" + encodeURIComponent(id)); toast("已删除"); closeModal(); await loadPull(true); renderAllPapers(); }
    catch (e) { toast("删除失败：" + e.message); }
  }

  // ---------- 收藏试卷 · 分类管理 / 按分类筛选（与电脑端「试卷中心·收藏试卷」分类一致） ----------
  let examCatFilter = "";   // 当前筛选的分类（""=全部分类）
  function examCats() { return DB.data.examCategories || []; }
  function catName(c) { const b = c.body || {}; return b.name || c.name || ""; }
  function catPid(c) { const b = c.body || {}; return b.parentId || c.parentId || ""; }
  function catKids(pid) {
    return examCats().filter(c => catPid(c) === pid)
      .sort((a, b) => catName(a).localeCompare(catName(b), "zh-CN"));
  }
  function catPath(id) {
    const names = []; const guard = new Set(); let cur = id;
    while (cur && !guard.has(cur)) { guard.add(cur); const c = examCats().find(x => x.id === cur); if (!c) break; names.unshift(catName(c)); cur = catPid(c); }
    return names.join(" / ");
  }
  function catSubtreeIds(id) {
    const set = new Set([id]); const stack = [id];
    while (stack.length) { const cur = stack.pop(); catKids(cur).forEach(k => { if (!set.has(k.id)) { set.add(k.id); stack.push(k.id); } }); }
    return set;
  }
  function setExamCatFilter(v) { examCatFilter = v || ""; renderExamsM(); }
  function catExamCount(id) {
    const subs = catSubtreeIds(id);
    return (DB.data.exams || []).filter(e => subs.has((e.body && e.body.categoryId) || "")).length;
  }
  // ---- 白底树形抽屉（与题库"按知识点筛选"同款交互：搜索 + ▶ 展开）----
  let catSheetMode = "pick";      // "pick"=编辑器里选分类 | "filter"=列表筛选 | "manage"=分类管理
  let catExpanded = new Set();    // 展开的分类节点
  let catAdding = null;           // {pid} 正在新增（抽屉内联输入行）
  let catRenaming = null;         // 正在改名的分类 id
  function openCatSheet(mode) {
    catSheetMode = mode || "pick";
    catAdding = null; catRenaming = null;
    $("#catSearch").value = "";
    $("#catSheetTitle").textContent = catSheetMode === "manage" ? "🏷️ 试卷分类管理" : "🏷️ 选择分类";
    renderCatTree();
    $("#catSheet").classList.remove("hidden");
  }
  function closeCatSheet() { $("#catSheet").classList.add("hidden"); }
  function toggleCat(id) {
    if (catExpanded.has(id)) catExpanded.delete(id); else catExpanded.add(id);
    renderCatTree();
  }
  function renderCatTree() {
    const box = $("#catTree"); if (!box) return;
    const kw = ($("#catSearch").value || "").trim().toLowerCase();
    const manage = catSheetMode === "manage";
    const editRow = (inputHtml, saveFn) =>
      '<div class="kp-row" style="gap:6px">' + inputHtml +
      '<button class="btn ok sm" onclick="' + saveFn + '">保存</button>' +
      '<button class="btn sec sm" onclick="catCancelEdit()">取消</button></div>';
    let top = "";
    if (catAdding && !catAdding.pid) {
      top += editRow('<input id="catNewName" placeholder="顶级分类名称" style="flex:1;margin:0" onkeydown="if(event.key===\'Enter\')catSaveAdd()">', "catSaveAdd()");
    }
    top += '<div class="kp-row' + (!examCatFilter && catSheetMode !== "manage" ? " sel" : "") + '" onclick="pickCat(\'\')">' +
      '<span class="kp-toggle leaf">·</span><span class="kp-name">' + (catSheetMode === "filter" ? "📂 全部分类" : "📂 未分类") + "</span>" +
      (manage ? '<button class="btn sm" onclick="event.stopPropagation();catBeginAdd(\'\')">＋顶级</button>' : "") +
      (catSheetMode === "filter" ? '<span class="kp-cnt">' + (DB.data.exams || []).length + " 卷</span>" : "") +
      "</div>";
    function nodeHtml(c) {
      const kids = catKids(c.id);
      const nm = catName(c);
      if (kw && !nm.toLowerCase().includes(kw) && !kids.some(k => catName(k).toLowerCase().includes(kw))) return "";
      const hasKids = kids.length > 0;
      const expanded = catExpanded.has(c.id);
      let inner;
      if (catRenaming === c.id) {
        inner = editRow('<input id="catNewName" value="' + esc(nm) + '" style="flex:1;margin:0" onkeydown="if(event.key===\'Enter\')catSaveRename(\'' + esc(c.id) + '\')">', "catSaveRename('" + esc(c.id) + "')");
      } else {
        inner = '<div class="kp-row" onclick="pickCat(\'' + esc(c.id) + '\')">' +
          '<span class="kp-toggle' + (hasKids ? "" : " leaf") + (expanded ? " open" : "") + '" onclick="event.stopPropagation();toggleCat(\'' + esc(c.id) + '\')">' + (hasKids ? "▶" : "") + "</span>" +
          '<span class="kp-name">' + esc(nm) + "</span>" +
          (manage ? '<button class="btn sm" onclick="event.stopPropagation();catBeginAdd(\'' + esc(c.id) + '\')">＋子</button>' +
                    '<button class="btn sec sm" onclick="event.stopPropagation();catBeginRename(\'' + esc(c.id) + '\')">改名</button>' +
                    '<button class="btn danger sm" onclick="event.stopPropagation();delExamCatM(\'' + esc(c.id) + '\')">删除</button>' : "") +
          '<span class="kp-cnt">' + catExamCount(c.id) + " 卷</span></div>";
      }
      return "<div>" + inner +
        (hasKids ? '<div class="kp-kids' + (expanded ? " open" : "") + '">' + kids.map(nodeHtml).join("") + "</div>" : "") +
        "</div>";
    }
    let html = top + catKids("").map(nodeHtml).join("");
    if (catAdding && catAdding.pid) {
      html += editRow('<input id="catNewName" placeholder="子分类名称" style="flex:1;margin:0" onkeydown="if(event.key===\'Enter\')catSaveAdd()">', "catSaveAdd()");
    }
    box.innerHTML = html;
    if (catAdding || catRenaming) setTimeout(() => { const el = $("#catNewName"); if (el) el.focus(); }, 60);
  }
  function pickCat(id) {
    if (catSheetMode === "filter") { setExamCatFilter(id || ""); closeCatSheet(); return; }
    const hid = $("#ef_cat"), btn = $("#ef_cat_btn");
    if (hid) hid.value = id || "";
    if (btn) btn.textContent = id ? "🏷️ " + catPath(id) : "未分类（点此选择）";
    closeCatSheet();
  }
  function catBeginAdd(pid) { catAdding = { pid: pid || "" }; catRenaming = null; renderCatTree(); }
  function catBeginRename(id) { catRenaming = id; catAdding = null; renderCatTree(); }
  function catCancelEdit() { catAdding = null; catRenaming = null; renderCatTree(); }
  async function catSaveAdd() {
    const name = (($("#catNewName") || {}).value || "").trim();
    if (!name) { toast("请填写分类名称"); return; }
    const pid = (catAdding && catAdding.pid) || "";
    const body = { id: "ec_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6), name, parentId: pid, createdAt: Date.now() };
    DB.data.examCategories = DB.data.examCategories || [];
    DB.data.examCategories.push({ id: body.id, updated_at: body.createdAt, body });
    try { await api("POST", "/api/examCategories", body); } catch (e) { toast("保存失败：" + e.message); }
    catAdding = null;
    if (pid) catExpanded.add(pid);
    renderCatTree(); renderExamsM();
  }
  async function catSaveRename(id) {
    const name = (($("#catNewName") || {}).value || "").trim();
    if (!name) { toast("请填写分类名称"); return; }
    const c = examCats().find(x => x.id === id); if (!c) return;
    const body = Object.assign({}, c.body, { id, name, parentId: catPid(c), createdAt: (c.body && c.body.createdAt) || Date.now() });
    try { await api("PUT", "/api/examCategories/" + id, body); } catch (e) { toast("保存失败：" + e.message); }
    c.body = body; catRenaming = null;
    renderCatTree(); renderExamsM();
  }
  async function delExamCatM(id) {
    const c = examCats().find(x => x.id === id); if (!c) return;
    const subs = catSubtreeIds(id);
    if (!window.confirm("确定删除分类「" + catName(c) + "」吗？\n其下子分类会一并删除，相关试卷将变为「未分类」。")) return;
    const affected = (DB.data.exams || []).filter(e => subs.has((e.body && e.body.categoryId) || ""));
    try {
      for (const e of affected) { e.body.categoryId = ""; try { await api("PUT", "/api/exams/" + e.id, e.body); } catch (err) {} }
      for (const sid of subs) { try { await api("DELETE", "/api/examCategories/" + sid); } catch (err) {} }
    } catch (e) { toast("部分删除失败：" + e.message); }
    DB.data.examCategories = examCats().filter(x => !subs.has(x.id));
    if (examCatFilter && subs.has(examCatFilter)) examCatFilter = "";
    catAdding = null; catRenaming = null;
    renderCatTree(); renderExamsM();
  }

  // ---------- 排课（周课表网格，复刻电脑版，云端同步） ----------
  let scheduleWeekOffset = 0;
  let scheduleFormDay = 1, scheduleFormStart = "08:00", scheduleFormEnd = "10:00";
  function renderScheduleGrid() {
    const schedule = DB.data.schedule || [];
    const students = DB.data.students || [];
    const ws = startOfWeekDate(scheduleWeekOffset);
    const we = addDays(ws, 6);
    const weekKey = dateKey(ws);
    const todayKey = todayStr();
    const weekSchedule = schedule.filter(s => (s.body || {}).weekStart === weekKey);
    const cellMap = {};
    weekSchedule.forEach(s => {
      const b = s.body || {};
      const key = (b.dayOfWeek || 1) + "-" + (b.startTime || "");
      (cellMap[key] = cellMap[key] || []).push(s);
    });
    const offsetLabel = scheduleWeekOffset === 0 ? "本周"
      : (scheduleWeekOffset > 0 ? "未来第 " + scheduleWeekOffset + " 周" : "过去第 " + Math.abs(scheduleWeekOffset) + " 周");
    let html = `<div class="week-nav">
        <button class="btn sec sm" onclick="schedulePrevWeek()">‹ 上一周</button>
        <div class="week-range"><div class="wr-title">${ws.getFullYear()}年${ws.getMonth()+1}月${ws.getDate()}日 – ${we.getMonth()+1}月${we.getDate()}日</div>
        <div class="wr-sub">${offsetLabel}</div></div>
        <button class="btn sec sm" onclick="scheduleNextWeek()">下周 ›</button>
        ${scheduleWeekOffset !== 0 ? `<button class="btn sec sm" onclick="scheduleGotoThisWeek()">回到本周</button>` : ""}
        <button class="btn sm" onclick="scheduleCopyWeekToNext()" title="把当前周排课复制到下一邻近周">📋 复制到下周</button>
      </div>`;
    if (students.length === 0)
      html += `<div class="card"><div class="muted" style="padding:14px">还没有学生，请先到「学生」添加，之后即可在课表里点时间段排课。</div></div>`;
    html += `<div class="schedule-scroll"><div class="schedule-table">`;
    html += `<div class="st-corner">时间</div>`;
    for (let day = 1; day <= 7; day++) {
      const dayDate = addDays(ws, day - 1);
      const isToday = dateKey(dayDate) === todayKey;
      html += `<div class="st-day${isToday ? " today" : ""}"><span>${DAYS[day-1]}</span><span class="sd-date">${dayDate.getMonth()+1}/${dayDate.getDate()}</span></div>`;
    }
    SCHEDULE_SLOTS.forEach(slot => {
      html += `<div class="st-time">${esc(slot.label)}</div>`;
      for (let day = 1; day <= 7; day++) {
        const key = day + "-" + slot.start;
        const items = cellMap[key];
        if (items && items.length) {
          const rows = items.map(s => {
            const b = s.body || {};
            const full = b.studentName || ""; const sur = full.charAt(0);
            return `<span class="st-name-wrap" title="点姓名：上课消课；点 ×：取消排课">
              <span class="st-name" onclick="event.stopPropagation();scheduleCheckin('${esc(s.id)}')">${esc(items.length === 1 ? full : sur)}</span>
              <span class="st-del" title="取消这节排课" onclick="event.stopPropagation();scheduleDelete('${esc(s.id)}')">×</span></span>`;
          }).join("");
          html += `<div class="st-cell has-class" onclick="scheduleOpenAddFor(${day},'${slot.start}','${slot.end}')" title="点空白处追加排课；点姓名上课消课；点 × 取消">
            <div class="st-names">${rows}</div></div>`;
        } else {
          html += `<div class="st-cell empty" onclick="scheduleOpenAddFor(${day},'${slot.start}','${slot.end}')" title="点击在此时间段添加排课"></div>`;
        }
      }
    });
    html += `</div></div>`;
    $("#sub-grid").innerHTML = html;
  }
  function schedulePrevWeek() { scheduleWeekOffset--; renderScheduleGrid(); }
  function scheduleNextWeek() { scheduleWeekOffset++; renderScheduleGrid(); }
  function scheduleGotoThisWeek() { scheduleWeekOffset = 0; renderScheduleGrid(); }
  async function scheduleCopyWeekToNext() {
    const schedule = DB.data.schedule || [];
    const srcKey = dateKey(startOfWeekDate(scheduleWeekOffset));
    const dstKey = dateKey(startOfWeekDate(scheduleWeekOffset + 1));
    const src = schedule.filter(s => (s.body || {}).weekStart === srcKey);
    if (src.length === 0) return toast("当前周没有可复制的排课");
    const dst = schedule.filter(s => (s.body || {}).weekStart === dstKey);
    let added = 0;
    for (const s of src) {
      const b = s.body || {};
      const dup = dst.some(d => { const db = d.body || {}; return db.dayOfWeek === b.dayOfWeek && db.startTime === b.startTime && db.studentName === b.studentName; });
      if (dup) continue;
      const copy = Object.assign({}, b, { id: "sch_" + Date.now().toString(36) + "_" + added, weekStart: dstKey, createdAt: Date.now() });
      try { await api("POST", "/api/schedule", copy); added++; } catch (e) { toast("复制失败：" + e.message); }
    }
    if (added === 0) return toast("下一邻近周已有相同排课，无需复制");
    toast("已将 " + added + " 节排课复制到下周 ✓");
    scheduleWeekOffset += 1;
    await loadPull(true); renderScheduleGrid();
  }
  async function scheduleCheckin(id) {
    const s = (DB.data.schedule || []).find(x => x.id === id);
    if (!s) return;
    const b = s.body || {};
    const student = (DB.data.students || []).find(x => (x.body || {}).name === b.studentName);
    if (!student) return toast("未找到学生：" + b.studentName);
    const sb = student.body || {};
    const base = new Date((b.weekStart || todayStr()) + "T00:00:00");
    const classDate = addDays(base, (b.dayOfWeek || 1) - 1);
    const dateStr = dateKey(classDate);
    const duration = 2; const lessons = hoursToLessons(duration);
    const remain = parseFloat(sb.hours) || 0;
    const arrears = parseFloat(sb.arrears) || 0;
    confirmModal("上课消课",
      `确认给 <b>${esc(sb.name || "")}</b> 在 <b>${dateStr}</b> 消课 <b>${fmtLessons(lessons)} 次</b>？`,
      async () => {
        try {
          if (remain < lessons) {
            const newArrears = remain > 0 ? arrears + (lessons - remain) : arrears + lessons;
            await api("PUT", "/api/students/" + student.id, Object.assign({}, sb, { hours: 0, arrears: newArrears, updatedAt: Date.now() }));
            await api("POST", "/api/records", { id: "rec_" + Date.now().toString(36), studentId: student.id, studentName: sb.name || "", type: "arrears", hours: lessons, durationHours: duration, date: dateStr, topic: "", note: "从排课表一键消课", createdAt: Date.now() });
            toast("已记录欠费上课，欠费 " + fmtLessons(newArrears) + " 次课");
          } else {
            await api("PUT", "/api/students/" + student.id, Object.assign({}, sb, { hours: remain - lessons, updatedAt: Date.now() }));
            await api("POST", "/api/records", { id: "rec_" + Date.now().toString(36), studentId: student.id, studentName: sb.name || "", type: "consume", hours: lessons, durationHours: duration, date: dateStr, topic: "", note: "从排课表一键消课", createdAt: Date.now() });
            toast("上课成功，消耗 " + fmtLessons(lessons) + " 次课");
          }
          await loadPull(true); renderScheduleGrid();
          if (mainTab === "students") renderStudents();
        } catch (e) { toast("操作失败：" + e.message); }
      });
  }
  async function scheduleDelete(id) {
    confirmModal("删除排课", "确定要删除这节排课吗？", async () => {
      try { await api("DELETE", "/api/schedule/" + id); toast("排课已删除"); await loadPull(true); renderScheduleGrid(); }
      catch (e) { toast("删除失败：" + e.message); }
    });
  }
  function scheduleOpenAddFor(day, start, end) {
    scheduleFormDay = day; scheduleFormStart = start; scheduleFormEnd = end;
    scheduleShowForm(null);
  }
  function scheduleShowForm(s) {
    const isEdit = !!s;
    const b = (s && s.body) || {};
    const students = DB.data.students || [];
    const studentOpts = ['<option value="">（选择学生）</option>'].concat(
      students.map(st => { const stb = st.body || {}; return `<option value="${esc(stb.name || "")}" ${b.studentName === stb.name ? "selected" : ""}>${esc(stb.name || "")}${stb.grade ? " (" + esc(stb.grade) + ")" : ""}</option>`; })
    ).join("");
    const dayOpts = DAYS.map((d, i) => `<option value="${i+1}" ${(b.dayOfWeek || scheduleFormDay || 1) === i+1 ? "selected" : ""}>${d}</option>`).join("");
    const timeOpts = SCHEDULE_SLOTS.map(t => `<option value="${t.start}" ${(b.startTime || scheduleFormStart || t.start) === t.start ? "selected" : ""}>${t.start}</option>`).join("");
    const endTimeOpts = SCHEDULE_SLOTS.map(t => `<option value="${t.end}" ${(b.endTime || scheduleFormEnd || t.end) === t.end ? "selected" : ""}>${t.end}</option>`).join("");
    $("#modalBox").innerHTML = `
      <div class="modal-header"><span class="modal-title">${isEdit ? "编辑排课" : "添加排课"}</span><button class="modal-close" onclick="closeModal()">✕</button></div>
      <div class="modal-body">
        <input type="hidden" id="schId" value="${esc(s ? s.id : "")}">
        <label class="kv">学生 *</label><select id="schStudent">${studentOpts}</select>
        <label class="kv">星期 *</label><select id="schDay">${dayOpts}</select>
        <label class="kv">开始时间 *</label><select id="schStart">${timeOpts}</select>
        <label class="kv">结束时间 *</label><select id="schEnd">${endTimeOpts}</select>
        <label class="kv">辅导内容</label><input id="schSubject" value="${esc(b.subject || "")}" placeholder="如：力学综合、期末复习">
        <label class="kv">上课地点</label><input id="schLocation" value="${esc(b.location || "")}" placeholder="如：学生家、线上、自习室">
        <label class="kv">备注</label><textarea id="schNote">${esc(b.note || "")}</textarea>
      </div>
      <div class="modal-footer">
        ${isEdit ? `<button class="btn danger" style="flex:1" onclick="scheduleDelete('${esc(s.id)}')">删除</button>` : ""}
        <button class="btn sec" style="flex:1" onclick="closeModal()">取消</button>
        <button class="btn ok" style="flex:1" onclick="scheduleSaveForm()">保存</button>
      </div>`;
    $("#schStart").addEventListener("change", function () {
      const pr = this.value.split(":"); const ev = pad(parseInt(pr[0], 10) + 2) + ":" + pad(parseInt(pr[1], 10));
      const sel = $("#schEnd"); if (SCHEDULE_SLOTS.some(t => t.end === ev)) sel.value = ev;
    });
    openModal();
  }
  async function scheduleSaveForm() {
    const sId = $("#schId").value;
    const studentName = ($("#schStudent").value || "").trim();
    if (!studentName) return toast("请选择学生");
    const startTime = $("#schStart").value, endTime = $("#schEnd").value;
    if (!startTime || !endTime) return toast("请选择上课时间");
    if (startTime >= endTime) return toast("结束时间必须晚于开始时间");
    const base = {
      dayOfWeek: parseInt($("#schDay").value, 10),
      startTime, endTime,
      studentName,
      subject: ($("#schSubject").value || "").trim(),
      location: ($("#schLocation").value || "").trim(),
      note: ($("#schNote").value || "").trim(),
      weekStart: dateKey(startOfWeekDate(scheduleWeekOffset))
    };
    try {
      if (sId) { await api("PUT", "/api/schedule/" + sId, Object.assign({ id: sId }, base)); toast("排课已更新"); }
      else { await api("POST", "/api/schedule", Object.assign({ id: "sch_" + Date.now().toString(36) }, base)); toast("排课已添加"); }
      closeModal(); await loadPull(true); renderScheduleGrid();
    } catch (e) { toast("保存失败：" + e.message); }
  }
  function renderRecordsList() {
    const box = $("#sub-records");
    const recs = (DB.data.records || []).slice().sort((a, c) => String((c.body || {}).date || "").localeCompare(String((a.body || {}).date || "")));
    const students = DB.data.students || [];
    const monthKey = todayStr().slice(0, 7);
    const inMonth = r => String((r.body || {}).date || "").slice(0, 7) === monthKey;
    const isConsume = r => (r.body || {}).type === "consume" || (r.body || {}).type === "arrears";
    const sum = (arr, f) => arr.reduce((s, r) => s + (parseFloat(f(r)) || 0), 0);
    const monthRecs = recs.filter(inMonth);
    const monthConsume = sum(monthRecs.filter(isConsume), r => r.body.hours);
    const totalConsume = sum(recs.filter(isConsume), r => r.body.hours);
    const monthIncome = sum(monthRecs.filter(r => (r.body || {}).type === "recharge"), r => r.body.amount);
    let totalArrears = 0, totalRemain = 0;
    students.forEach(s => { const b = s.body || {}; totalArrears += parseFloat(b.arrears) || 0; totalRemain += parseFloat(b.hours) || 0; });

    // 年级→学生→上课日期 表格（同电脑端）
    if (!students.length) { box.innerHTML = '<div class="center">还没有学生，先去「学生」页添加</div>'; return; }
    const byName = {};
    recs.filter(isConsume).forEach(r => {
      const b = r.body || {};
      const key = b.studentName || "未知";
      (byName[key] = byName[key] || []).push(b.date);
    });
    Object.keys(byName).forEach(k => byName[k] = [...new Set(byName[k])].sort());
    const byGrade = {};
    students.forEach(s => { const b = s.body || {}; const g = b.grade || "未设置年级"; (byGrade[g] = byGrade[g] || []).push(s); });
    const gradeColors = { "初二": "#c6e0b4", "初三": "#a9d08e", "高一": "#f4b183", "高二": "#9dc3e6", "高三": "#ffd966", "未设置年级": "#e2e3e5" };
    const gradeRank = ["高三", "高二", "高一", "初三", "初二", "初一", "六年级", "五年级", "四年级", "三年级", "二年级", "一年级", "未设置年级"];
    const gradeEntries = Object.keys(byGrade).sort((a, b) => {
      const ia = gradeRank.indexOf(a), ib = gradeRank.indexOf(b);
      return (ia === -1 ? 99 : ia) - (ib === -1 ? 99 : ib);
    });
    const ordered = [];
    gradeEntries.forEach(g => byGrade[g].forEach(s => ordered.push(s)));
    let html = "";
    const maxDates = Math.max(0, ...ordered.map(s => (byName[(s.body || {}).name] || []).length));
    if (maxDates === 0) { box.innerHTML = html + '<div class="center">暂无上课记录</div>'; return; }
    html += '<div class="rec-table-wrap"><table class="rec-table"><thead><tr class="rt-grade">' +
      gradeEntries.map(g => `<th colspan="${byGrade[g].length}" style="background:${gradeColors[g] || "#e2e3e5"}">${esc(g)}</th>`).join("") +
      '</tr><tr class="rt-stu">' +
      ordered.map(s => `<th>${esc((s.body || {}).name || "")}</th>`).join("") +
      '</tr><tr class="rt-count">' +
      ordered.map(s => `<td>${(byName[(s.body || {}).name] || []).length}</td>`).join("") +
      '</tr></thead><tbody>';
    for (let i = 0; i < maxDates; i++) {
      html += "<tr>" + ordered.map(s => {
        const d = (byName[(s.body || {}).name] || [])[i];
        if (!d) return "<td></td>";
        const dt = new Date(d);
        return `<td class="rt-date">${dt.getMonth() + 1}.${dt.getDate()}</td>`;
      }).join("") + "</tr>";
    }
    html += "</tbody></table></div>";
    box.innerHTML = html;
  }

  // ---------- 添加题目（手机端新建题目，云端同步） ----------
  let addQId = ""; // 本轮添加表单预生成的题目 id：图片先上传到 questions/<id>/...，保存时同名入库
  function renderAddQForm() {
    const box = $("#addQForm");
    addQKp = "";
    addQId = "q_" + Date.now().toString(36);
    box.innerHTML = `
      <div style="display:flex;gap:8px;margin-bottom:8px">
        <select id="nq_type" style="flex:1;margin:0"></select>
        <button type="button" id="nq_kp_btn" class="filter-select" style="flex:1;margin:0" onclick="openKpSheet('add')">选择知识点</button>
      </div>
      <textarea id="nq_content" placeholder="题干" style="min-height:90px"></textarea>
      <label class="kv">答案</label>
      <textarea id="nq_answer" style="min-height:50px"></textarea>
      <div class="seg">
        <button type="button" id="nq_upC">上传题干图</button>
        <button type="button" id="nq_upA">上传答案图</button>
      </div>`;
    $("#nq_type").innerHTML = '<option>选择题</option><option>多选题</option><option>填空题</option><option>解答题</option><option>计算题</option><option>实验题</option><option>作图题</option><option>综合题</option>';
    $("#nq_upC").onclick = () => pickImg("nq_content", "c", addQId);
    $("#nq_upA").onclick = () => pickImg("nq_answer", "a", addQId);
  }
  async function saveNewQuestion() {
    const body = {
      id: addQId || ("q_" + Date.now().toString(36)),
      type: $("#nq_type").value,
      kpId: addQKp || "",
      content: ($("#nq_content").value || "").trim(),
      answer: ($("#nq_answer").value || "").trim(),
      analysis: "",
      createdAt: Date.now()
    };
    if (!body.content) return toast("题干不能为空");
    try {
      await api("POST", "/api/questions", body);
      toast("已保存 ✓"); await loadPull(true); qSub("q");
    } catch (e) { toast("保存失败：" + e.message); }
  }

  // ---------- 设置（含后端地址 / 模块列表） ----------
  function renderSettings() {
    const base = localStorage.getItem(LS_BASE) || "(同源/默认)";
    const el = $("#setBase"); if (el) el.textContent = base;
  }
  function openBaseUrlEditor() {
    const cur = localStorage.getItem(LS_BASE) || "";
    $("#modalBox").innerHTML = `
      <div class="modal-header"><span class="modal-title">🌐 后端地址</span><button class="modal-close" onclick="closeModal()">✕</button></div>
      <div class="modal-body">
        <div class="muted" style="margin-bottom:8px">默认同源即可。若手机访问的是独立域名，请填写部署后的后端地址（如 https://xxx.up.railway.app）。</div>
        <label class="kv">后端地址</label><input id="baseUrlEdit" value="${esc(cur)}" placeholder="https://your-app.up.railway.app">
      </div>
      <div class="modal-footer"><button class="btn sec" style="flex:1" onclick="closeModal()">取消</button><button class="btn ok" style="flex:1" onclick="saveBaseUrl()">保存</button></div>`;
    openModal();
  }
  function saveBaseUrl() {
    const v = ($("#baseUrlEdit").value || "").trim().replace(/\/+$/, "");
    if (v) localStorage.setItem(LS_BASE, v); else localStorage.removeItem(LS_BASE);
    toast("已保存后端地址"); closeModal(); renderSettings();
  }
  async function openModuleListEditor(mod) {
    const ui = MOD_UI[mod]; if (!ui) return;
    $("#modalBox").innerHTML = `
      <div class="modal-header"><span class="modal-title">${ui.label}管理</span><button class="modal-close" onclick="closeModal()">✕</button></div>
      <div class="modal-body">
        <div class="search"><input id="${mod}Search" placeholder="搜索${ui.label}…" oninput="renderModuleList('${mod}')"><button class="btn sec" onclick="renderModuleList('${mod}')">搜</button></div>
        <div id="${mod}List"></div>
      </div>
      <div class="modal-footer"><button class="btn sec" style="flex:1" onclick="closeModal()">关闭</button><button class="btn ok" style="flex:1" onclick="openModuleEditor('${mod}',null)">＋ 新建</button></div>`;
    openModal();
    renderModuleList(mod);
  }

  // ---------- 通用模块（课时/考试/知识点/记录）----------
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
        { k: "id", label: "知识点ID(kpId)", type: "text" },
        { k: "name", label: "名称", type: "text" },
        { k: "parentId", label: "父级知识点", type: "parent" },
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
    let html = `<div class="modal-header"><span class="modal-title">${esc(ui.title(b))}</span><button class="modal-close" onclick="closeModal()">✕</button></div><div class="modal-body"><div class="muted">${esc(ui.sub(b))}</div>`;
    (ui.fields || []).forEach(f => {
      const v = b[f.k];
      if (f.k === "contentHtml" && v) html += `<div class="kv" style="margin-top:6px">${esc(f.label)}</div><div>${renderRich(v)}</div>`;
      else html += `<div class="kv" style="margin-top:4px">${esc(f.label)}：${esc(v == null ? "" : v)}</div>`;
    });
    if (ui.files && (b.files || []).length) {
      html += `<div class="kv" style="margin-top:6px">附件</div>`;
      (b.files || []).forEach(fl => { html += `<div><a href="${mediaUrl(encodeURIComponent(fl.rel))}" target="_blank">${esc(fl.name || fl.rel)}</a></div>`; });
    }
    html += `</div><div class="modal-footer"><div class="row-3">
      <button class="btn sec" onclick="openModuleEditor('${mod}','${id}')">编辑</button>
      <button class="btn sec" onclick="delModule('${mod}','${id}')">删除</button>
      <button class="btn sec" onclick="closeModal()">关闭</button></div></div>`;
    $("#modalBox").innerHTML = html; openModal();
  }
  function openModuleEditor(mod, id) {
    const ui = MOD_UI[mod];
    const isEdit = !!id;
    const it = isEdit ? (DB.data[mod] || []).find(x => x.id === id) : null;
    const b = (it && it.body) || {};
    let html = `<div class="modal-header"><span class="modal-title">${isEdit ? "编辑" : "新建"}${ui.label}</span><button class="modal-close" onclick="closeModal()">✕</button></div>
      <div class="modal-body">
      <input type="hidden" id="m_mod" value="${mod}"><input type="hidden" id="m_id" value="${esc(id || "")}">`;
    (ui.fields || []).forEach(f => {
      const v = b[f.k] == null ? "" : b[f.k];
      if (f.type === "textarea") html += `<label class="kv">${esc(f.label)}</label><textarea id="mf_${f.k}">${esc(v)}</textarea>`;
      else if (f.type === "parent") {
        // 用知识点树选择所属知识点（与电脑端一致的父级/子级树形选择）
        modKpParent = (v || "");
        const lbl = modKpParent ? ("📍 " + kpPath(modKpParent)) : "（顶级，无父级）";
        html += '<label class="kv">' + esc(f.label) + '</label>' +
          '<button type="button" class="filter-select" style="width:100%;text-align:left;margin:0" id="mf_' + f.k + '_btn" onclick="openKpSheet(\'kpParent\')">' + esc(lbl) + '</button>' +
          '<input type="hidden" id="mf_' + f.k + '" value="' + esc(v) + '">';
      }
      else html += `<label class="kv">${esc(f.label)}</label><input id="mf_${f.k}" type="${f.type === "number" ? "number" : "text"}" value="${esc(v)}">`;
    });
    html += `</div><div class="modal-footer"><div class="row-2"><button class="btn ok" onclick="saveModule()">保存</button><button class="btn sec" onclick="closeModal()">取消</button></div></div>`;
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
    body.updatedAt = Date.now();
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
  window.doLogin = doLogin;
  window.refreshData = refreshData; window.applyFilter = applyFilter; window.debounce = debounce;
  window.loadMore = showMore;
  window.setTypeFilter = setTypeFilter; window.setKpFilter = setKpFilter; window.openKpSheet = openKpSheet; window.closeKpSheet = closeKpSheet;
  window.renderKpTree = renderKpTree; window.pickKp = pickKp;
  window.kpNewChildAt = kpNewChildAt; window.kpSaveNewChild = kpSaveNewChild;
  window.quickCompose = quickCompose; window.markWrong = markWrong; window.saveWrong = saveWrong;
  window.loadWrong = loadWrong; window.toggleWrongResolved = toggleWrongResolved; window.delWrong = delWrong;
  window.showLightbox = showLightbox;
  window.openDetail = openDetail; window.openEditor = openEditor; window.saveQ = saveQ;
  window.delQ = delQ; window.closeModal = closeModal; window.openPaper = openPaper;
  window.openPaperWrong = openPaperWrong; window.buildWrongPaperFromPaper = buildWrongPaperFromPaper;
  window.openWrongPaperBuilder = openWrongPaperBuilder; window.buildWrongPaperFromStudent = buildWrongPaperFromStudent;
  window.downloadPaper = downloadPaper;
  window.switchMain = switchMain; window.qSub = qSub; window.schedSub = schedSub;
  window.renderStudents = renderStudents; window.openStudentEditor = openStudentEditor; window.saveStudentEditor = saveStudentEditor; window.doRecharge = doRecharge;
  window.doComposeSave = doComposeSave; window.commitComposeSave = commitComposeSave; window.clearComposeSel = clearComposeSel; window.openComposeModal = openComposeModal;
  window.renderMyPapers = renderMyPapers; window.renderAllPapers = renderAllPapers;
  window.renderScheduleGrid = renderScheduleGrid; window.schedulePrevWeek = schedulePrevWeek; window.scheduleNextWeek = scheduleNextWeek;
  window.scheduleGotoThisWeek = scheduleGotoThisWeek; window.scheduleCopyWeekToNext = scheduleCopyWeekToNext;
  window.scheduleOpenAddFor = scheduleOpenAddFor; window.scheduleCheckin = scheduleCheckin; window.scheduleDelete = scheduleDelete; window.scheduleSaveForm = scheduleSaveForm;
  window.renderAddQForm = renderAddQForm; window.saveNewQuestion = saveNewQuestion;
  window.renderSettings = renderSettings; window.openBaseUrlEditor = openBaseUrlEditor; window.saveBaseUrl = saveBaseUrl; window.openModuleListEditor = openModuleListEditor;
  window.renderModuleList = renderModuleList; window.openModuleDetail = openModuleDetail;
  window.openModuleEditor = openModuleEditor; window.saveModule = saveModule; window.delModule = delModule;
  window.openExamEditor = openExamEditor; window.saveExamM = saveExamM; window.delExamM = delExamM;
  window.openExamDetail = openExamDetail; window.examUploadFiles = examUploadFiles; window.examRemoveFile = examRemoveFile;
  window.setExamCatFilter = setExamCatFilter;
  window.openCatSheet = openCatSheet; window.closeCatSheet = closeCatSheet; window.renderCatTree = renderCatTree;
  window.pickCat = pickCat; window.toggleCat = toggleCat; window.catBeginAdd = catBeginAdd; window.catBeginRename = catBeginRename;
  window.catCancelEdit = catCancelEdit; window.catSaveAdd = catSaveAdd; window.catSaveRename = catSaveRename;
  window.delExamCatM = delExamCatM;
  window.logout = logout;

  // ===================== 每日一题（出题程序） =====================
  let dailySubPane = "manage";
  let dailyDocDraft = [];   // 出题编辑器当前会话的附件文档草稿
  function renderDailyDocList() {
    const el = $("#dqDocList"); if (!el) return;
    if (!dailyDocDraft.length) { el.innerHTML = '<span class="muted">暂无附件文档</span>'; return; }
    el.innerHTML = dailyDocDraft.map((f, i) =>
      `<div style="display:flex;gap:8px;align-items:center;margin:3px 0"><a href="${mediaUrl(encodeURIComponent(f.rel))}" target="_blank" style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(f.name || f.rel)}</a><button class="btn danger sm" onclick="dailyRemoveDoc(${i})">移除</button></div>`).join("");
  }
  async function dailyUploadDoc(input) {
    const files = Array.from(input.files || []);
    if (!files.length) return;
    toast("上传文档中…");
    const id = $("#dqId").value;
    for (const f of files) {
      try {
        const res = await api("POST", "/api/media?sub=" + encodeURIComponent("dailyQuestions/" + id + "/docs") + "&name=" + encodeURIComponent(f.name), f, true);
        const rel = (res.url || "").replace(/^\/api\/media\//, "");
        if (rel) dailyDocDraft.push({ rel, name: f.name });
      } catch (e) { toast("文档上传失败：" + f.name); }
    }
    renderDailyDocList(); toast("文档已添加");
  }
  window.dailyRemoveDoc = (i) => { dailyDocDraft.splice(i, 1); renderDailyDocList(); };
  function _role() { try { return (user ? JSON.parse(user) : {}).role; } catch (e) { return ""; } }
  function _meName() { try { return (user ? JSON.parse(user) : {}).username || ""; } catch (e) { return ""; } }

  function renderDaily() {
    const isTeacher = _role() === "admin";
    const tabs = isTeacher
      ? [["manage", "出题 / 排期"], ["stats", "答题统计"]]
      : [["practice", "今日一题"], ["wrong", "我的错题本"]];
    if (!tabs.find(t => t[0] === dailySubPane)) dailySubPane = tabs[0][0];
    const tt = $("#dailySubTabs");
    tt.innerHTML = tabs.map(t =>
      `<button class="subtab ${t[0] === dailySubPane ? "on" : ""}" data-sub="${t[0]}" onclick="dailySub('${t[0]}')">${t[1]}</button>`
    ).join("");
    ["manage", "stats", "practice", "wrong"].forEach(id =>
      $("#sub-daily-" + id).classList.toggle("hidden", id !== dailySubPane));
    if (dailySubPane === "manage") renderDailyManage();
    else if (dailySubPane === "stats") renderDailyStats();
    else if (dailySubPane === "practice") renderDailyPractice();
    else if (dailySubPane === "wrong") renderDailyWrong();
  }
  function dailySub(s) { dailySubPane = s; renderDaily(); }

  // ---- 老师：出题 / 排期 ----
  function renderDailyManage() {
    const box = $("#sub-daily-manage");
    const items = (DB.data.dailyQuestions || []).slice()
      .sort((a, b) => (b.body.date || "").localeCompare(a.body.date || ""));
    let html = `<div class="row" style="margin-bottom:10px">
      <button class="btn" style="flex:1" onclick="openDailyEditor(null)">＋ 出题</button>
      <button class="btn sec" style="flex:1" onclick="openAccountEditor()">👥 学生账号</button>
    </div>`;
    if (!items.length) html += `<div class="center">还没有每日一题<br><span style="font-size:12px">点上方「＋ 出题」录入今天 / 某天的题目</span></div>`;
    html += items.map(it => {
      const b = it.body || {};
      const preview = (b.stem || "").replace(/<[^>]+>/g, "").replace(/media:\/\/\S+/g, "[图]").slice(0, 30);
      return `<div class="card">
        <div class="row" style="justify-content:space-between;align-items:center">
          <span class="badge-info">${esc(b.date || "")}</span>
          <span class="muted">${esc(preview)}</span>
        </div>
        <div class="q-content" style="margin:6px 0">${renderRich(b.stem || "")}</div>
        <div class="q-ans-box open" style="margin-top:6px"><div class="ans-label">答案</div>${esc(b.answer || "（开放题，无标准答案）")}</div>
        ${b.analysis ? `<div class="q-ans-box open" style="margin-top:6px;border-left-color:var(--primary)"><div class="ans-label" style="color:var(--primary)">解析</div>${esc(b.analysis)}</div>` : ""}
        <div class="row" style="margin-top:8px;gap:6px">
          <button class="btn sec sm" onclick="openDailyEditor('${it.id}')">编辑</button>
          <button class="btn danger sm" onclick="delDaily('${it.id}')">删除</button>
        </div>
      </div>`;
    }).join("");
    box.innerHTML = html;
  }
  function openDailyEditor(id) {
    const isNew = !id;
    const qid = id || ("dq_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6));
    const it = isNew ? null : (DB.data.dailyQuestions || []).find(x => x.id === id);
    const b = (it && it.body) || {};
    dailyDocDraft = (b.docs || []).slice();
    $("#modalBox").innerHTML = `
      <div class="modal-header"><span class="modal-title">${isNew ? "出题（每日一题）" : "编辑每日一题"}</span><button class="modal-close" onclick="closeModal()">✕</button></div>
      <div class="modal-body">
        <input type="hidden" id="dqId" value="${esc(qid)}">
        <label class="kv">日期（发题日）</label><input id="dqDate" type="date" value="${esc(b.date || todayStr())}">
        <label class="kv">题面（可配图：选图后自动插入 media:// 引用）</label>
        <textarea id="dqStem" style="min-height:120px">${esc(b.stem || "")}</textarea>
        <div class="row" style="margin:6px 0 0"><input id="dqImg" type="file" accept="image/*" style="flex:1"></div>
        <label class="kv">附件文档（PDF / Word / PPT / Excel 等，可多选）</label>
        <label class="btn ok" for="dqDocs" style="display:block;text-align:center;padding:9px;margin-top:4px">📎 上传文档（可多选）<input type="file" id="dqDocs" multiple
          accept=".pdf,.doc,.docx,.ppt,.pptx,.xls,.xlsx,.txt,application/pdf,application/msword,application/vnd.openxmlformats-officedocument.wordprocessingml.document,application/vnd.openxmlformats-officedocument.presentationml.presentation,application/vnd.ms-powerpoint,application/vnd.ms-excel,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
          style="display:none" onchange="dailyUploadDoc(this)"></label>
        <div id="dqDocList" style="margin-top:4px"></div>
        <label class="kv">标准答案（留空 = 开放题，由学生自评）</label>
        <textarea id="dqAnswer" style="min-height:60px">${esc(b.answer || "")}</textarea>
        <label class="kv">解析（可选）</label>
        <textarea id="dqAnalysis" style="min-height:60px">${esc(b.analysis || "")}</textarea>
      </div>
      <div class="modal-footer"><button class="btn sec" style="flex:1" onclick="closeModal()">取消</button><button class="btn ok" style="flex:1" onclick="saveDailyQuestion()">保存</button></div>`;
    openModal();
    renderDailyDocList();
  }
  async function saveDailyQuestion() {
    const id = $("#dqId").value;
    const date = $("#dqDate").value || todayStr();
    let stem = $("#dqStem").value;
    const file = $("#dqImg") && $("#dqImg").files && $("#dqImg").files[0];
    try {
      if (file) {
        // 去除旧的同路径图片引用，再追加新的
        stem = stem.replace(new RegExp("media://dailyQuestions/" + id + "/c/img_1\\.png", "g"), "");
        await api("POST", "/api/media?sub=" + encodeURIComponent("dailyQuestions/" + id + "/c") + "&name=" + encodeURIComponent("img_1.png"), file, true);
        stem = (stem + "\nmedia://dailyQuestions/" + id + "/c/img_1.png").trim();
      }
      const body = { id, date, stem, answer: $("#dqAnswer").value.trim(), analysis: $("#dqAnalysis").value.trim(), docs: dailyDocDraft.slice(), updatedAt: Date.now() };
      if ((DB.data.dailyQuestions || []).find(x => x.id === id)) {
        await api("PUT", "/api/dailyQuestions/" + id, body);
      } else {
        await api("POST", "/api/dailyQuestions", body);
      }
      toast("已保存 ✓"); closeModal(); await loadPull(true); renderDaily();
    } catch (e) { toast("保存失败：" + e.message); }
  }
  async function delDaily(id) {
    confirmModal("删除该题", "确定删除这道每日一题？学生已答记录会保留用于统计。", async () => {
      try { await api("DELETE", "/api/dailyQuestions/" + id); toast("已删除"); await loadPull(true); renderDaily(); }
      catch (e) { toast("删除失败：" + e.message); }
    });
  }

  // ---- 老师：答题统计 ----
  function renderDailyStats() {
    const qs = DB.data.dailyQuestions || [];
    const ans = DB.data.dailyAnswers || [];
    const byQ = {};
    ans.forEach(a => {
      const b = a.body || {}; const k = b.qId; if (!k) return;
      byQ[k] = byQ[k] || { total: 0, correct: 0 };
      byQ[k].total++; if (b.correct === 1) byQ[k].correct++;
    });
    let html = `<div class="card"><div class="muted">共 ${qs.length} 道每日一题 · ${ans.length} 条答题记录</div></div>`;
    const sorted = qs.slice().sort((a, b) => (b.body.date || "").localeCompare(a.body.date || ""));
    if (!sorted.length) html += `<div class="center">还没有题目</div>`;
    html += sorted.map(it => {
      const b = it.body || {}; const s = byQ[it.id] || { total: 0, correct: 0 };
      const rate = s.total ? Math.round(s.correct / s.total * 100) : 0;
      return `<div class="card">
        <div class="row" style="justify-content:space-between;align-items:center">
          <span class="badge-info">${esc(b.date || "")}</span>
          <span class="muted">${s.total} 人答 · 正确率 ${rate}%</span>
        </div>
        <div class="q-content" style="margin:6px 0">${renderRich(b.stem || "")}</div>
      </div>`;
    }).join("");
    // 学生答题榜
    const byS = {};
    ans.forEach(a => {
      const b = a.body || {}; if (!b.studentId) return;
      byS[b.studentId] = byS[b.studentId] || { name: b.studentName, total: 0, correct: 0 };
      byS[b.studentId].total++; if (b.correct === 1) byS[b.studentId].correct++;
    });
    const st = Object.values(byS).sort((a, b) => b.total - a.total);
    if (st.length) {
      html += `<div class="card"><div style="font-weight:600;margin-bottom:6px">学生答题榜</div>` +
        st.map(s => `<div class="row" style="justify-content:space-between"><span>${esc(s.name || "")}</span><span class="muted">${s.total} 题 · 正确 ${s.correct}</span></div>`).join("") + `</div>`;
    }
    $("#sub-daily-stats").innerHTML = html;
  }

  // ---- 学生：今日一题 ----
  function dailyDocLinks(docs) {
    if (!docs || !docs.length) return "";
    return `<div style="margin:6px 0"><div class="muted" style="margin-bottom:4px">📎 附件文档</div>` +
      docs.map(f => `<a class="btn sec sm" style="margin:3px 6px 3px 0;display:inline-block" href="${mediaUrl(encodeURIComponent(f.rel))}" target="_blank">📄 ${esc(f.name || f.rel)}</a>`).join("") +
      `</div>`;
  }
  function _myDaily() {
    const name = _meName();
    return (DB.data.dailyAnswers || []).filter(a => (a.body && a.body.studentName) === name);
  }
  function renderDailyPractice() {
    const today = todayStr();
    const items = (DB.data.dailyQuestions || []).filter(x => (x.body && x.body.date) === today);
    const mine = _myDaily();
    const box = $("#sub-daily-practice");
    if (!items.length) {
      box.innerHTML = `<div class="center">今天还没有出题~<br><span style="font-size:12px">老师会在「出题 / 排期」里录入每日一题</span></div>`;
      return;
    }
    box.innerHTML = items.map(it => {
      const b = it.body || {};
      const rec = mine.find(a => a.body && a.body.qId === it.id);
      const done = !!rec;
      const correct = rec && rec.body ? rec.body.correct : null;
      const openEnded = rec && rec.body ? rec.body.openEnded : false;
      let body;
      if (!done) {
        body = `<textarea id="dqInput_${it.id}" placeholder="输入你的答案…" style="min-height:70px;margin-top:8px"></textarea>
          <div class="row" style="margin-top:8px;gap:6px"><button class="btn ok" onclick="submitDailyAnswer('${it.id}')">提交并核对</button></div>`;
      } else {
        let tail = "";
        if (openEnded && correct === null) {
          tail = `<div class="row" style="margin-top:8px;gap:6px">
            <button class="btn ok sm" onclick="markDaily('${it.id}',1)">我答对了</button>
            <button class="btn danger sm" onclick="markDaily('${it.id}',0)">我答错了</button></div>`;
        }
        body = `<div class="q-ans-box open" style="margin-top:8px"><div class="ans-label">答案</div>${esc(b.answer || "（开放题，无标准答案）")}</div>
          ${b.analysis ? `<div class="q-ans-box open" style="margin-top:6px;border-left-color:var(--primary)"><div class="ans-label" style="color:var(--primary)">解析</div>${esc(b.analysis)}</div>` : ""}
          ${tail}`;
      }
      const badge = !done ? `<span class="badge-gray">未答</span>`
        : correct === 1 ? `<span class="badge-success">已答对</span>`
        : correct === 0 ? `<span class="badge-danger">答错</span>`
        : `<span class="badge-gray">已提交</span>`;
      return `<div class="card">
        <div class="row" style="justify-content:space-between;align-items:center"><span class="badge-info">${esc(b.date || "")}</span>${badge}</div>
        <div class="q-content" style="margin:8px 0">${renderRich(b.stem || "")}</div>
        ${dailyDocLinks(b.docs)}
        <div id="dqAns_${it.id}">${body}</div>
      </div>`;
    }).join("");
  }
  async function submitDailyAnswer(qid) {
    const input = $("#dqInput_" + qid);
    const answer = input ? input.value : "";
    if (!answer.trim()) return toast("请先输入答案");
    try {
      const r = await api("POST", "/api/daily/answer", { qId: qid, answer });
      toast(r.correct === 1 ? "答对啦 🎉" : r.correct === 0 ? "答错了，看下答案吧" : "已提交");
      await loadPull(true); renderDailyPractice();
    } catch (e) { toast("提交失败：" + e.message); }
  }
  async function markDaily(qid, correct) {
    try {
      await api("POST", "/api/daily/answer", { qId: qid, correct });
      await loadPull(true); renderDailyPractice();
    } catch (e) { toast("提交失败：" + e.message); }
  }

  // ---- 学生：我的错题本 ----
  function renderDailyWrong() {
    const wrong = _myDaily().filter(a => a.body && a.body.correct === 0);
    const box = $("#sub-daily-wrong");
    if (!wrong.length) {
      box.innerHTML = `<div class="center">暂无错题 🎉<br><span style="font-size:12px">答对越多，错题越少</span></div>`;
      return;
    }
    const qmap = {};
    (DB.data.dailyQuestions || []).forEach(q => { qmap[q.id] = q.body || {}; });
    box.innerHTML = wrong.map(a => {
      const b = a.body || {}; const q = qmap[b.qId] || {};
      return `<div class="card">
        <div class="row" style="justify-content:space-between"><span class="badge-danger">错题</span><span class="muted">${esc(b.date || "")}</span></div>
        <div class="q-content" style="margin:6px 0">${renderRich(q.stem || "（题目已删除）")}</div>
        <div class="q-ans-box open" style="margin-top:6px"><div class="ans-label">你的答案</div>${esc(b.answer || "（未填写）")}</div>
        <div class="q-ans-box open" style="margin-top:6px"><div class="ans-label">正确答案</div>${esc(q.answer || "（开放题）")}</div>
        ${q.analysis ? `<div class="q-ans-box open" style="margin-top:6px;border-left-color:var(--primary)"><div class="ans-label" style="color:var(--primary)">解析</div>${esc(q.analysis)}</div>` : ""}
      </div>`;
    }).join("");
  }

  window.renderDaily = renderDaily; window.dailySub = dailySub;
  window.renderDailyManage = renderDailyManage; window.openDailyEditor = openDailyEditor;
  window.saveDailyQuestion = saveDailyQuestion; window.delDaily = delDaily;
  window.renderDailyStats = renderDailyStats; window.renderDailyPractice = renderDailyPractice;
  window.submitDailyAnswer = submitDailyAnswer; window.markDaily = markDaily;
  window.renderDailyWrong = renderDailyWrong;
  window.openAccountEditor = openAccountEditor; window.saveAccount = saveAccount;

  // 老师给学生建「工作台登录账号」（学生用同一工作台答题，需各自账号）
  function openAccountEditor() {
    $("#modalBox").innerHTML = `
      <div class="modal-header"><span class="modal-title">新建学生账号</span><button class="modal-close" onclick="closeModal()">✕</button></div>
      <div class="modal-body">
        <div class="muted" style="margin-bottom:8px">学生用此账号登录同一工作台，在「每日一题 → 今日一题」答题。账号仅用于本工作台，与 CRM 学生资料相互独立。</div>
        <label class="kv">登录用户名</label><input id="accUser" placeholder="如 xiaoming">
        <label class="kv">密码</label><input id="accPwd" type="password" placeholder="初始密码">
        <label class="kv">确认密码</label><input id="accPwd2" type="password" placeholder="再次输入">
      </div>
      <div class="modal-footer"><button class="btn sec" style="flex:1" onclick="closeModal()">取消</button><button class="btn ok" style="flex:1" onclick="saveAccount()">创建</button></div>`;
    openModal();
  }
  async function saveAccount() {
    const username = $("#accUser").value.trim();
    const pwd = $("#accPwd").value;
    const pwd2 = $("#accPwd2").value;
    if (!username) return toast("请填写用户名");
    if (pwd.length < 4) return toast("密码至少 4 位");
    if (pwd !== pwd2) return toast("两次密码不一致");
    try {
      await api("POST", "/api/auth/register", { username, password: pwd, role: "user" });
      toast("账号已创建 ✓"); closeModal();
    } catch (e) { toast("创建失败：" + e.message); }
  }

  // 全局事件委托：题库卡片（详情/答案/组卷/错题/知识点/图片放大）
  document.getElementById("qList").addEventListener("click", qListClick);
  document.getElementById("modalBox").addEventListener("click", (e) => {
    const img = e.target.closest("img");
    if (img) showLightbox(img.src);
  });

  if (token) enterMain();
})();
