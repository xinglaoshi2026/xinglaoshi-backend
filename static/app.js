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
  let qf = { kw: "", type: "", kpId: "", fav: false, cat: "" };   // 题库筛选：关键词/题型/知识点/好题/我的分类
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
  // 图片签名：图片接口需要「限时票据」，登录后领一张拼到 <img src> 上（24 小时有效）。
  // 票据不是登录 token，泄露影响有界；过期后重新进页面/切回前台会自动续。
  let MT = "";
  async function loadMediaTicket() {
    try {
      const r = await api("GET", "/api/media/ticket");
      MT = (r && r.tk) ? ("e=" + encodeURIComponent(r.exp) + "&tk=" + encodeURIComponent(r.tk)) : "";
    } catch (e) { MT = ""; }
  }
  document.addEventListener("visibilitychange", function () {
    if (!document.hidden) loadMediaTicket();
  });
  // 网络恢复后，把之前失败的图片重新拉一遍（手机切后台/弱网很常见）
  window.addEventListener("online", function () {
    loadMediaTicket();
    document.querySelectorAll("img.img-fail").forEach(function (el) {
      el.classList.remove("img-fail");
      el.dataset.r = "0";
      if (el.dataset.src) el.src = el.dataset.src + (el.dataset.src.indexOf("?") >= 0 ? "&" : "?") + "r=" + Date.now();
    });
  });
  function mediaUrl(p) {
    const base = localStorage.getItem(LS_BASE) || "";
    if (MT) return base + "/api/media/" + p + (p.indexOf("?") >= 0 ? "&" : "?") + MT;
    const t = token || "";
    return base + "/api/media/" + p + (t ? "?token=" + encodeURIComponent(t) : "");
  }
  // 图片加载失败自动重试一次：弱网/慢网下首次加载常超时，
  // 直接隐藏会让"纯图片题"在手机上看起来是一道空题（电脑端本地文件秒开无此问题）。
  function imgRetry(el) {
    if (!el.dataset.src) el.dataset.src = el.src || "";
    const n = parseInt(el.dataset.r || "0", 10);
    if (n < 2 && el.dataset.src) {
      el.dataset.r = String(n + 1);
      // 第一次很快重试，第二次等 2 秒（弱网下给服务器缓一口气）
      const delay = n === 0 ? 600 : 2000;
      setTimeout(function () {
        if (el.dataset.ok) return;
        el.src = el.dataset.src + (el.dataset.src.indexOf("?") >= 0 ? "&" : "?") + "r=" + Date.now();
      }, delay);
    } else {
      // 关键：不再 hidden。纯图片题一旦隐藏，在手机上就是"一道空题"，
      // 让人以为题库丢了题。改为显示可点重试的占位块。
      el.classList.add("img-fail");
      el.removeAttribute("src");
      el.alt = "图片加载失败 · 点按重试";
      el.onclick = function () {
        el.classList.remove("img-fail");
        el.dataset.r = "0";
        if (el.dataset.src) el.src = el.dataset.src;
      };
    }
  }
  function imgOk(el) {
    el.dataset.ok = "1";
    el.classList.remove("img-fail");
    el.removeAttribute("alt");
  }
  window.imgOk = imgOk;
  window.imgRetry = imgRetry;
  // 把 media://questions/<id>/{c,a}/img_1.png 改成可访问的图片标签
  // 捕获组必须带 questions/ 前缀：服务端媒体路径是 questions/<qid>/<kind>/img_N.png，
  // 丢掉该段会拼出 /api/media/<qid>/... 导致 404（表现为手机端看不到题目/答案图片）。
  function renderMedia(text) {
    if (!text) return "";
    return esc(text).replace(/media:\/\/(questions\/[^\s)]+)/g,
      (m, p) => `<img class="qimg" loading="lazy" decoding="async" src="${mediaUrl(p)}" onload="imgOk(this)" onerror="imgRetry(this)">`);
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
              .replace(/<img(?![^>]*onerror)/gi, '<img loading="lazy" decoding="async" onload="imgOk(this)" onerror="imgRetry(this)"')
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
    await loadMediaTicket();   // 先领图片签名票据，后面渲染的图片才带签名
    await loadPull(true);
    switchMain("questions");
    startAutoSync(); // 启动自动同步（手机端改动无需手动下拉刷新）
  }

  // ---------- 题库（题型/知识点/关键词 筛选 + 本地分页） ----------
  function applyFilter() {
    qf.kw = ($("#qSearch").value || "").trim().toLowerCase();
    const all = DB.data.questions || [];
    const kpIds = qf.kpId ? kpSubtreeIds(qf.kpId) : null;
    qFiltered = all.filter(it => {
      const b = it.body || {};
      if (qf.type && (b.type || "") !== qf.type) return false;
      if (kpIds && !kpIds.has(b.kpId || "")) return false;
      if (qf.fav && !b.favorite) return false;
      if (qf.cat) {
        const sub = myCatSubtree(qf.cat);
        if (!(b.catIds || []).some(c => sub.has(c))) return false;
      }
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
    renderQfChips();
  }
  // 题库筛选 chips：全部 / ★好题 / 按我的分类（与电脑端一致）
  function renderQfChips() {
    const box = $("#qfChips");
    if (!box) return;
    const cats = myCats();
    const favCnt = (DB.data.questions || []).filter(it => (it.body || {}).favorite).length;
    let h = '<span class="ep-chip-m' + (!qf.fav && !qf.cat ? " on" : "") + '" onclick="setFavFilter(false)">全部</span>'
          + '<span class="ep-chip-m' + (qf.fav ? " on" : "") + '" onclick="setFavFilter(true)">★ 好题 ' + favCnt + "</span>";
    cats.forEach(c => {
      h += '<span class="ep-chip-m' + (qf.cat === c.id ? " on" : "") + '" onclick="setCatFilter(\'' + c.id + "','" + esc(c.name) + "')\">🏷️ " + esc(c.name) + "</span>";
    });
    box.innerHTML = h;
  }
  function setFavFilter(on) { qf.fav = !!on; if (on) qf.cat = ""; applyFilter(); }
  function setCatFilter(id, name) { qf.cat = (qf.cat === id ? "" : id); qf.fav = false; applyFilter(); }
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
    const fav = !!b.favorite;
    const cats = (b.catIds || []).map(myCatName).filter(Boolean);
    const div = document.createElement("div");
    div.className = "card q";
    div.innerHTML =
      '<div class="q-body-wrap" data-act="detail" data-id="' + it.id + '">' +
        (cats.length ? '<div style="margin-bottom:6px">' + cats.map(n => '<span class="ep-chip-m" style="font-size:11px;padding:1px 8px;cursor:default">🏷️ ' + esc(n) + "</span>").join(" ") + "</div>" : "") +
        '<div class="q-content">' + renderRich((b.content || "").trim()) + "</div></div>" +
      '<div class="q-actions">' +
        '<button class="q-link' + (fav ? " on" : "") + '" data-act="fav" data-id="' + it.id + '">' + (fav ? "★ 已收藏" : "☆ 收藏") + "</button>" +
        '<button class="q-link" data-act="cat" data-id="' + it.id + '">归分类</button>' +
        '<button class="q-link" data-act="answer" data-id="' + it.id + '">查看解析</button>' +
        '<button class="q-link" data-act="detail" data-id="' + it.id + '">详情</button>' +
        '<button class="q-link' + (inCompose ? " on" : "") + '" data-act="compose" data-id="' + it.id + '">' + (inCompose ? "✕ 取消组卷" : "加入组卷") + "</button>" +
      "</div>" +
      '<div class="q-ans-box" id="ans-' + it.id + '"><div class="ans-label">答案 / 解析</div>' + (renderRich((b.answer || "").trim()) || "—") + (b.analysis ? '<div style="margin-top:6px">' + renderRich((b.analysis || "").trim()) + "</div>" : "") + "</div>";
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
    else if (act === "fav") toggleFav(id);
    else if (act === "cat") openCatPicker(id);
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
  // ---------- 图片灯箱：支持放大（双指/双击/滚轮）、拖动、旋转（参照训练学生端） ----------
  var LB = { scale:1, tx:0, ty:0, rot:0, natW:0, natH:0, baseW:0, baseH:0, moved:false, lastTap:0, quiet:0, bound:false };
  function lbApply() {
    var img = document.getElementById("lightboxImg"); if (!img) return;
    img.style.transform = "translate(" + LB.tx + "px," + LB.ty + "px) rotate(" + LB.rot + "deg) scale(" + LB.scale + ")";
  }
  function lbLayout() {
    var img = document.getElementById("lightboxImg"); if (!img || !img.naturalWidth) return;
    LB.natW = img.naturalWidth; LB.natH = img.naturalHeight;
    var st = document.getElementById("lbStage");
    var VW = Math.max(120, (st ? st.clientWidth : window.innerWidth) - 8);
    var VH = Math.max(120, (st ? st.clientHeight : window.innerHeight) - 8);
    var rotated = (LB.rot % 180) !== 0;
    var f = rotated ? Math.min(VW / LB.natH, VH / LB.natW) : Math.min(VW / LB.natW, VH / LB.natH);
    LB.baseW = LB.natW * f; LB.baseH = LB.natH * f;
    img.style.width = LB.baseW + "px";
    img.style.height = LB.baseH + "px";
    lbApply();
  }
  function lbReset() { LB.scale = 1; LB.tx = 0; LB.ty = 0; lbApply(); }
  function lbZoom(k) {
    LB.scale = Math.min(8, Math.max(1, LB.scale * k));
    if (LB.scale <= 1.001) { LB.tx = 0; LB.ty = 0; }
    lbApply();
  }
  function lbRotate() { LB.rot = (LB.rot + 90) % 360; LB.scale = 1; LB.tx = 0; LB.ty = 0; lbLayout(); }
  function lbHide() {
    var ov = document.getElementById("lightbox"); if (ov) ov.classList.add("hidden");
    try { document.documentElement.style.overflow = ""; document.body.style.overflow = ""; } catch (e) {}
  }
  function lbBind() {
    if (LB.bound) return; LB.bound = true;
    var ov = document.getElementById("lightbox"), stage = document.getElementById("lbStage");
    document.getElementById("lbClose").onclick = function (e) { e.stopPropagation(); lbHide(); };
    document.getElementById("lbZin").onclick = function (e) { e.stopPropagation(); lbZoom(1.25); };
    document.getElementById("lbZout").onclick = function (e) { e.stopPropagation(); lbZoom(0.8); };
    document.getElementById("lbRot").onclick = function (e) { e.stopPropagation(); lbRotate(); };
    document.getElementById("lbReset").onclick = function (e) { e.stopPropagation(); lbReset(); };
    ov.addEventListener("click", function (e) {
      if (Date.now() - LB.quiet < 400) return;              // 刚拖过/划过，防误关
      if (e.target === ov || e.target.id === "lbStage") lbHide();
    });
    // 手势（指针事件统一鼠标/触摸）
    var pts = new Map(), startDist = 0, startScale = 1, startTx = 0, startTy = 0, startMid = { x:0, y:0 };
    var lastX = 0, lastY = 0, dragging = false, sx = 0, sy = 0, downTarget = null;
    function dist(a, b) { return Math.hypot(a.x - b.x, a.y - b.y); }
    function mid(a, b) { return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }; }
    stage.addEventListener("pointerdown", function (e) {
      if (e.pointerType === "mouse" && e.button !== 0) return;
      try { stage.setPointerCapture(e.pointerId); } catch (_) {}
      pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
      LB.moved = false;
      if (pts.size === 1) { dragging = true; lastX = sx = e.clientX; lastY = sy = e.clientY; downTarget = e.target; }
      else if (pts.size === 2) {
        dragging = false;
        var a = Array.from(pts.values());
        startDist = dist(a[0], a[1]); startScale = LB.scale;
        startMid = mid(a[0], a[1]); startTx = LB.tx; startTy = LB.ty;
      }
    });
    stage.addEventListener("pointermove", function (e) {
      if (!pts.has(e.pointerId)) return;
      pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (pts.size === 2) {
        var a = Array.from(pts.values()), d = dist(a[0], a[1]);
        if (startDist > 0) LB.scale = Math.min(8, Math.max(1, startScale * d / startDist));
        var m = mid(a[0], a[1]);
        LB.tx = startTx + (m.x - startMid.x);
        LB.ty = startTy + (m.y - startMid.y);
        lbApply(); LB.moved = true;
        if (e.cancelable) e.preventDefault();
      } else if (pts.size === 1 && dragging) {
        var dx = e.clientX - lastX, dy = e.clientY - lastY;
        lastX = e.clientX; lastY = e.clientY;
        if (Math.abs(dx) + Math.abs(dy) > 4) LB.moved = true;
        if (LB.scale > 1.001) { LB.tx += dx; LB.ty += dy; lbApply(); if (e.cancelable) e.preventDefault(); }
      }
    });
    function endPt(e) {
      if (!pts.has(e.pointerId)) return;
      pts.delete(e.pointerId);
      if (pts.size < 2) startDist = 0;
      if (pts.size > 0) return;
      dragging = false;
      // 只有真正拖动/双指缩放后，才刷新 quiet 以防误关；
      // 否则「点击空白」会被下面的 click 兜底当成"刚拖过"而永远关不掉（原 bug）
      if (LB.moved) { LB.quiet = Date.now(); return; }
      var onImg = downTarget && downTarget.id === "lightboxImg";
      if (onImg) {                                           // 双击图片：放大 / 还原
        var now = Date.now();
        if (now - LB.lastTap < 300) {
          LB.scale = LB.scale > 1.5 ? 1 : 2.4;
          if (LB.scale === 1) { LB.tx = 0; LB.ty = 0; }
          lbApply(); LB.lastTap = 0; return;
        }
        LB.lastTap = now;
        return;
      }
      // 点图片外的空白处 → 关闭（不依赖 click 事件，兼容各 WebView / 微信内核）
      LB.quiet = Date.now();
      lbHide();
    }
    stage.addEventListener("pointerup", endPt);
    stage.addEventListener("pointercancel", endPt);
    stage.addEventListener("wheel", function (e) {           // 电脑浏览器：滚轮缩放
      if (e.cancelable) e.preventDefault();
      lbZoom(e.deltaY < 0 ? 1.12 : 0.89);
    }, { passive: false });
    // 兜底：不依赖 touch-action，阻止底层页面跟着手指滚（微信/QQ 的 X5 内核支持差）
    ov.addEventListener("touchmove", function (e) { if (e.cancelable) e.preventDefault(); }, { passive: false });
    window.addEventListener("resize", function () {
      if (!ov.classList.contains("hidden")) lbLayout();
    });
  }
  function showLightbox(src, caption) {
    var ov = document.getElementById("lightbox");
    var img = document.getElementById("lightboxImg");
    if (!ov || !img || !src) return;
    lbBind();
    LB.scale = 1; LB.tx = 0; LB.ty = 0; LB.rot = 0; LB.lastTap = 0;
    img.style.width = ""; img.style.height = ""; img.style.transform = "";
    img.onload = function () { lbLayout(); };
    img.src = src;
    if (img.complete && img.naturalWidth) lbLayout();
    var cap = document.getElementById("lightboxCap");
    if (cap) cap.textContent = caption || "";
    ov.classList.remove("hidden");
    try { document.documentElement.style.overflow = "hidden"; document.body.style.overflow = "hidden"; } catch (e) {}
    setTimeout(lbLayout, 30);
  }

  // ---------- 知识点选择抽屉 ----------
  // kpSheet 抽屉复用模式：null=题库筛选；"add"=添加题目表单选知识点
  let kpSheetFor = null;
  let addQKp = ""; // 添加题目表单当前选中的知识点
  let modKpParent = ""; // 知识点编辑表单当前选中的父级（知识点树选择）
  let kpFocusId = ""; // 刚创建的知识点（在树中高亮并展开其祖先）
  let kpOpen = new Set();  // 用户点开的节点（默认全部收起，逐级点开，避免整棵树被摊平）
  function openKpSheet(forWhat) {
    kpSheetFor = forWhat || null;
    kpFocusId = "";
    kpOpen = new Set();          // 每次打开都从「只显示第一级」开始
    $("#kpSearch").value = "";
    renderKpTree();
    $("#kpSheet").classList.remove("hidden");
  }
  // 点箭头：展开/收起该节点的下一级（只影响这一层）
  function toggleKpNode(id) {
    if (kpOpen.has(id)) kpOpen.delete(id); else kpOpen.add(id);
    renderKpTree();
  }
  window.toggleKpNode = toggleKpNode;
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
    // 只有「搜索命中」或「刚新建知识点」时才自动展开；
    // 平时完全按用户点开的状态显示（点高中只出它的下一级）。
    const autoOpen = new Set();
    if (kw) Object.keys(kpKids).forEach(k => autoOpen.add(k));
    if (kpFocusId) kpAncestors(kpFocusId).forEach(x => autoOpen.add(x));
    const anc = autoOpen;
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
      const expanded = hasKids && (anc.has(id) || kpOpen.has(id));
      return '<div><div class="kp-row' + (curSel === id || kpFocusId === id ? " sel" : "") + '" data-kp="' + esc(id) + '" onclick="pickKp(\'' + esc(id) + '\')">' +
        '<span class="kp-toggle' + (hasKids ? "" : " leaf") + (expanded ? " open" : "") + '" onclick="event.stopPropagation();toggleKpNode(\'' + esc(id) + '\')">' + (hasKids ? "▶" : "") + "</span>" +
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
        <div class="dt-sec"><span class="dt-label">题干</span><div class="dt-content">${renderRich((b.content || "").trim()) || "—"}</div></div>
        <div class="dt-sec"><span class="dt-label ans">答案</span><div class="dt-content ans-box">${renderRich((b.answer || "").trim()) || "—"}</div></div>
        ${b.analysis ? '<div class="dt-sec"><span class="dt-label">解析</span><div class="dt-content">' + renderRich((b.analysis || "").trim()) + "</div></div>" : ""}
      </div>
      <div class="modal-footer">
        <div class="row-2" style="margin-bottom:8px">
          <button class="btn ${b.favorite ? 'ok' : 'sec'}" onclick="toggleFav('${id}');openDetail('${id}')">${b.favorite ? "★ 已收藏" : "☆ 收藏为好题"}</button>
          <button class="btn sec" onclick="openCatPicker('${id}')">🏷️ 归入我的分类</button>
        </div>
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
    let qs = "";
    for (const qid of ids.slice(0, 50)) {
      const q = qMap[qid];
      if (q) {
        const qb = q.body || {};
        qs += `<div class="card" style="margin:6px 0">${renderRich(qb.content)}` +
          `<div class="muted">答：${renderRich(qb.answer) || "—"}</div>` +
          `</div>`;
      } else {
        qs += `<div class="muted">（题 ${esc(qid)} 未同步）</div>`;
      }
    }
    $("#modalBox").innerHTML = `<div class="modal-header"><span class="modal-title">📄 ${esc(b.title || "试卷")}</span><button class="modal-close" onclick="closeModal()">✕</button></div>
      <div class="modal-body"><div class="muted">${esc(b.note || "")}</div>${qs}</div>
      <div class="modal-footer" style="flex-wrap:wrap;gap:8px">
        <button class="btn ok" style="flex:1 1 100%" onclick="downloadPaper('${esc(id)}')">⬇ 下载 Word 试卷</button>
        <button class="btn sec" style="flex:1 1 100%" onclick="closeModal()">关闭</button>
      </div>`;
    openModal();
    // 微信/企业微信等 webview 常拦截自动下载，提示用浏览器打开本页再下载
    const ua = navigator.userAgent || "";
    if (/MicroMessenger|WXWork|QQ\/|Weibo|Alipay/i.test(ua))
      toast("若没自动保存，点右上角 ⋯ 选「用浏览器打开」本页后再下载", 2600);
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
  }
  function switchMain(m) {
    mainTab = m;
    ["questions", "schedule", "students", "train", "settings"].forEach(id =>
      $("#view-" + id).classList.toggle("hidden", id !== m));
    document.querySelectorAll(".tab-btn").forEach(b => b.classList.toggle("active", b.dataset.main === m));
    if (m === "questions") qSub(qSubPane);
    else if (m === "schedule") schedSub(schedSubPane);
    else if (m === "students") renderStudents();
    else if (m === "settings") renderSettings();
    else if (m === "train") loadTrain();
  }
  // 错题训练：首次进入时按需加载内嵌老师端训练台（带时间戳避开 WebView 缓存），之后保留页面状态
  function loadTrain(){
    const f = document.getElementById("trainFrame");
    if(!f) return;
    if(f.dataset.loaded !== "1"){ f.src = "/train?v=" + Date.now(); f.dataset.loaded = "1"; }
  }
  function qSub(s) {
    qSubPane = s;
    document.querySelectorAll("#qSubTabs .subtab").forEach(b => b.classList.toggle("on", b.dataset.sub === s));
    ["q", "fav", "compose", "paper", "add"].forEach(id => $("#sub-" + id).classList.toggle("hidden", id !== s));
    if (s === "q") applyFilter();
    else if (s === "fav") renderFavView();
    else if (s === "compose") renderMyPapers();
    else if (s === "paper") renderAllPapers();
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

  // ===================== 好题收藏 & 我的分类（与电脑端一致） =====================
  // ---- 分类树工具 ----
  function myCats() {
    return (DB.data.myCategories || []).map(it => it.body || it).filter(c => c && c.id);
  }
  function myCatName(id) {
    const c = myCats().find(x => x.id === id);
    return c ? (c.name || "") : "";
  }
  function myCatChildren(pid) {
    const arr = myCats().filter(c => (c.parentId || "") === (pid || ""));
    arr.sort((a, b) => (a.order == null ? 0 : a.order) - (b.order == null ? 0 : b.order));
    return arr;
  }
  function myCatSubtree(id) {
    const out = new Set([id]);
    let grew = true;
    while (grew) {
      grew = false;
      for (const c of myCats()) {
        if (c.parentId && out.has(c.parentId) && !out.has(c.id)) { out.add(c.id); grew = true; }
      }
    }
    return out;
  }
  // ---- 题目写回（收藏 / 分类）----
  async function saveQBody(id, patch) {
    let it = qMap[id];
    const cur = (it && it.body) || {};
    const body = Object.assign({}, cur, patch, { id: id, updatedAt: Date.now() });
    await api("PUT", "/api/questions/" + id, body);
    if (it) { it.body = body; it.updated_at = body.updatedAt; }
    else {
      it = { id: id, updated_at: body.updatedAt, body: body };
      qMap[id] = it;
      DB.data.questions = DB.data.questions || [];
      DB.data.questions.push(it);
    }
    cachePut("pull", DB);
    return body;
  }
  async function toggleFav(id) {
    const b = (qMap[id] && qMap[id].body) || {};
    try {
      const nb = await saveQBody(id, { favorite: !b.favorite });
      document.querySelectorAll('button[data-act="fav"][data-id="' + id + '"]').forEach(btn => {
        btn.classList.toggle("on", !!nb.favorite);
        btn.textContent = nb.favorite ? "★ 已收藏" : "☆ 收藏";
      });
      toast(nb.favorite ? "已收藏为好题 ★" : "已取消收藏");
      renderQfChips();
      if (qSubPane === "fav") renderFavView();
      if ($("#modalBox").classList.contains("open")) openDetail(id);
    } catch (e) { toast("操作失败：" + e.message); }
  }
  // ---- 归入分类（多选）----
  let _catDraftId = "", _catDraft = [];
  function openCatPicker(id) {
    const b = (qMap[id] && qMap[id].body) || {};
    _catDraftId = id; _catDraft = (b.catIds || []).slice();
    $("#modalBox").innerHTML =
      '<div class="modal-header"><span class="modal-title">🏷️ 归入「我的分类」</span><button class="modal-close" onclick="closeModal()">✕</button></div>' +
      '<div class="modal-body"><div id="catPickBox"></div>' +
      '<div class="row" style="margin-top:12px"><input id="catNewName" class="f-search" style="flex:1" placeholder="新建一个分类"><button class="btn sec" onclick="catPickCreate()">＋ 新建</button></div></div>' +
      '<div class="modal-footer"><div class="row-2"><button class="btn ok" onclick="catPickSave()">保存</button><button class="btn sec" onclick="closeModal()">取消</button></div></div>';
    renderCatPickBox();
    openModal();
  }
  function renderCatPickBox() {
    const box = $("#catPickBox");
    if (!box) return;
    if (!myCats().length) { box.innerHTML = '<div class="center">还没有分类，用下面输入框先建一个</div>'; return; }
    const rows = [];
    (function walk(pid, depth) {
      myCatChildren(pid).forEach(c => {
        rows.push('<label style="display:flex;align-items:center;gap:8px;padding:9px 4px;padding-left:' + (8 + depth * 16) + 'px;border-bottom:1px solid var(--border)">' +
          '<input type="checkbox" value="' + c.id + '"' + (_catDraft.indexOf(c.id) >= 0 ? " checked" : "") + ' onchange="catPickToggle(this)">' +
          '<span>' + esc(c.name) + "</span></label>");
        walk(c.id, depth + 1);
      });
    })("", 0);
    box.innerHTML = rows.join("");
  }
  function catPickToggle(el) {
    const id = el.value;
    if (el.checked) { if (_catDraft.indexOf(id) < 0) _catDraft.push(id); }
    else _catDraft = _catDraft.filter(x => x !== id);
  }
  async function catPickCreate() {
    const name = ($("#catNewName").value || "").trim();
    if (!name) return toast("请输入分类名");
    try {
      await api("POST", "/api/myCategories", { name: name, parentId: "", order: myCats().length });
      $("#catNewName").value = "";
      await loadPull(true);
      renderCatPickBox(); renderQfChips();
      toast("已新建分类");
    } catch (e) { toast("新建失败：" + e.message); }
  }
  async function catPickSave() {
    try {
      await saveQBody(_catDraftId, { catIds: _catDraft.slice() });
      toast("已更新分类"); closeModal();
      if (qSubPane === "fav") renderFavView(); else applyFilter();
      renderQfChips();
    } catch (e) { toast("保存失败：" + e.message); }
  }
  // ---- 分类管理 ----
  function manageMyCats() {
    $("#modalBox").innerHTML =
      '<div class="modal-header"><span class="modal-title">🏷️ 我的分类管理</span><button class="modal-close" onclick="closeModal()">✕</button></div>' +
      '<div class="modal-body"><div id="catMgrBox"></div>' +
      '<div class="row" style="margin-top:12px"><input id="catMgrName" class="f-search" style="flex:1" placeholder="新分类名"><button class="btn sec" onclick="catMgrCreate()">＋ 新建</button></div></div>' +
      '<div class="modal-footer"><button class="btn sec" onclick="closeModal()">关闭</button></div>';
    renderCatMgrBox();
    openModal();
  }
  function renderCatMgrBox() {
    const box = $("#catMgrBox");
    if (!box) return;
    const rows = [];
    (function walk(pid, depth) {
      myCatChildren(pid).forEach(c => {
        rows.push('<div style="display:flex;align-items:center;gap:2px;padding:6px 2px;padding-left:' + (depth * 16) + 'px;border-bottom:1px solid var(--border)">' +
          '<span style="flex:1">' + esc(c.name) + "</span>" +
          '<button class="q-link" onclick="catMgrAddChild(\'' + c.id + "','" + esc(c.name) + "')\">＋子类</button>" +
          '<button class="q-link" onclick="catMgrRename(\'' + c.id + "')\">改名</button>" +
          '<button class="q-link" onclick="catMgrDel(\'' + c.id + "','" + esc(c.name) + "')\">删除</button></div>");
        walk(c.id, depth + 1);
      });
    })("", 0);
    box.innerHTML = rows.join("") || '<div class="center">还没有分类</div>';
  }
  async function catMgrCreate() {
    const n = ($("#catMgrName").value || "").trim();
    if (!n) return toast("请输入分类名");
    $("#catMgrName").value = "";
    try {
      await api("POST", "/api/myCategories", { name: n, parentId: "", order: myCats().length });
      await loadPull(true); renderCatMgrBox(); renderQfChips(); toast("已新建分类");
    } catch (e) { toast("失败：" + e.message); }
  }
  async function catMgrAddChild(pid, pname) {
    const n = (prompt("在「" + pname + "」下新建子类", "") || "").trim();
    if (!n) return;
    try {
      await api("POST", "/api/myCategories", { name: n, parentId: pid, order: myCatChildren(pid).length });
      await loadPull(true); renderCatMgrBox(); renderQfChips(); toast("已新建子类");
    } catch (e) { toast("失败：" + e.message); }
  }
  async function catMgrRename(id) {
    const cur = myCats().find(c => c.id === id) || {};
    const n = (prompt("重命名分类", cur.name || "") || "").trim();
    if (!n || n === cur.name) return;
    try {
      await api("PUT", "/api/myCategories/" + id, Object.assign({}, cur, { name: n, updatedAt: Date.now() }));
      await loadPull(true); renderCatMgrBox(); renderQfChips(); toast("已重命名");
    } catch (e) { toast("失败：" + e.message); }
  }
  async function catMgrDel(id, name) {
    if (!confirm("删除分类「" + name + "」？\n其下的题目只是移出该分类，题目本身不会被删除。")) return;
    try {
      await api("DELETE", "/api/myCategories/" + id);
      await loadPull(true); renderCatMgrBox(); renderQfChips();
      if (qSubPane === "fav") renderFavView();
      toast("已删除分类");
    } catch (e) { toast("失败：" + e.message); }
  }
  // ---- 好题集 / 我的分类 视图 ----
  let _favMode = "all", _favCat = "";
  function favMode(m) {
    _favMode = m;
    $("#favModeBtnAll").classList.toggle("on", m === "all");
    $("#favModeBtnCat").classList.toggle("on", m === "cat");
    renderFavView();
  }
  function favPickCat(id) { _favCat = (_favCat === id ? "" : id); renderFavView(); }
  function renderFavView() {
    const list = $("#favList"), chips = $("#favCatChips"), cnt = $("#favCount");
    if (!list) return;
    if (_favMode === "cat") {
      const cats = myCats();
      chips.innerHTML = cats.length
        ? cats.map(c => '<span class="ep-chip-m' + (_favCat === c.id ? " on" : "") + '" onclick="favPickCat(\'' + c.id + "')\">🏷️ " + esc(c.name) + "</span>").join(" ")
        : '<div class="center" style="padding:10px">还没有分类，点右上「管理」新建</div>';
    } else chips.innerHTML = "";
    const all = DB.data.questions || [];
    let items;
    if (_favMode === "cat" && _favCat) {
      const sub = myCatSubtree(_favCat);
      items = all.filter(it => ((it.body || {}).catIds || []).some(c => sub.has(c)));
    } else {
      items = all.filter(it => (it.body || {}).favorite);
    }
    const tsOf = it => {
      let t = it.updated_at || (it.body && (it.body.updatedAt || it.body.createdAt)) || 0;
      if (t && t < 1e11) t *= 1000;
      return t;
    };
    items = items.slice().sort((a, b) => tsOf(b) - tsOf(a));
    cnt.textContent = "共 " + items.length + " 题";
    list.innerHTML = "";
    if (!items.length) {
      list.innerHTML = '<div class="center">' +
        (_favMode === "cat" && _favCat ? "这个分类下还没有题目<br><span style=\"font-size:12px\">在题库点题目上的「归分类」" :
          "还没有收藏的好题<br><span style=\"font-size:12px\">在题库点题目上的「☆ 收藏」") + "</span></div>";
      return;
    }
    const frag = document.createDocumentFragment();
    items.slice(0, 200).forEach(it => frag.appendChild(qCard(it)));
    list.appendChild(frag);
  }


  // ---------- 组卷（在题库点「加入组卷」收集，底部浮条保存） ----------
  let composeSet = [];   // 已选题目 id（有序）
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
    renderExamPapersM();
  }

  // ---------- 试卷库（examPapers，与电脑端「试卷中心·试卷库」一致：类型/年级/年份筛选） ----------
  const EP_TYPES = ["高考", "期末试题", "期中试题", "月考试题", "单元测验", "同步练习"];
  const EP_GRADES = ["八上", "八下", "九上", "九下", "高一上", "高一下", "高二上", "高二下", "高三上", "高三下"];
  let epFilterM = { kw: "", type: "", grade: "", year: "" };
  function epYearOptsM() {
    const y = new Date().getFullYear();
    return ["" + y, "" + (y - 1), "" + (y - 2), "" + (y - 3), "" + (y - 4), "更早"];
  }
  function epYearMatchM(p, sel) {
    if (!sel) return true;
    const y = String((p && p.year) || "");
    if (sel === "更早") { const n = parseInt(y, 10); return !n || n < new Date().getFullYear() - 4; }
    return y === sel;
  }
  function epChipsHtmlM(label, key, val, opts) {
    let h = '<div style="display:flex;flex-wrap:wrap;gap:6px;align-items:center;margin-bottom:6px">' +
      '<span class="muted" style="font-size:12px;min-width:52px">' + label + '</span>';
    h += '<span class="ep-chip-m' + (val === "" ? " on" : "") + '" onclick="epSetFilterM(\'' + key + '\',\'\')">全部</span>';
    opts.forEach(o => {
      h += '<span class="ep-chip-m' + (val === o ? " on" : "") + '" onclick="epSetFilterM(\'' + key + '\',\'' + o + '\')">' + o + '</span>';
    });
    return h + "</div>";
  }
  function renderExamPapersM() {
    const chips = $("#epChipsM"), list = $("#epListM");
    if (!chips || !list) return;
    chips.innerHTML =
      epChipsHtmlM("试卷类型", "type", epFilterM.type, EP_TYPES) +
      epChipsHtmlM("年级", "grade", epFilterM.grade, EP_GRADES) +
      epChipsHtmlM("年份", "year", epFilterM.year, epYearOptsM()) +
      '<div style="text-align:right;margin:-2px 0 4px"><span class="ep-chip-m" style="color:#888" onclick="epClearFilterM()">✕ 清除筛选</span></div>';
    const kw = epFilterM.kw.trim().toLowerCase();
    // 同步回的每条是 {id, updated_at, body}，业务字段在 body 里
    const all = (DB.data.examPapers || []).map(it => Object.assign({ id: it.id }, it.body || {}));
    const items = all.filter(p => {
      if (epFilterM.type && (p.type || "") !== epFilterM.type) return false;
      if (epFilterM.grade && (p.grade || "") !== epFilterM.grade) return false;
      if (!epYearMatchM(p, epFilterM.year)) return false;
      if (kw) {
        const hay = [p.title, p.school, p.source, p.region].filter(Boolean).join(" ").toLowerCase();
        if (!hay.includes(kw)) return false;
      }
      return true;
    });
    $("#epCountM").textContent = "（" + items.length + "份）";
    if (!items.length) { list.innerHTML = '<div class="center" style="padding:10px">没有符合条件的试卷</div>'; return; }
    list.innerHTML = items.map(p => {
      const n = (p.questionIds || []).length;
      const badges = [p.type, p.grade, p.year].filter(Boolean)
        .map(t => '<span class="badge">' + esc(t) + "</span>").join(" ");
      return '<div class="card" style="margin:8px 0;padding:12px" onclick="openExamPaperM(\'' + esc(p.id) + '\')">' +
        '<div style="font-weight:700;margin-bottom:4px">' + esc(p.title || "未命名试卷") + "</div>" +
        '<div class="muted" style="font-size:12px">' + badges + (badges ? " · " : "") + "共 " + n + " 题</div></div>";
    }).join("");
  }
  function epSetFilterM(key, val) {
    if (key === "kw") epFilterM.kw = val || "";
    else epFilterM[key] = val || "";
    renderExamPapersM();
    // 关键词输入后同步回输入框以外的状态时保持焦点在输入框
    if (key !== "kw") { const inp = $("#epKwM"); if (inp) inp.value = epFilterM.kw; }
  }
  function epKwInput(v) { clearTimeout(epKwInput._t); epKwInput._t = setTimeout(() => epSetFilterM("kw", v), 350); }
  function epClearFilterM() {
    epFilterM = { kw: "", type: "", grade: "", year: "" };
    const inp = $("#epKwM"); if (inp) inp.value = "";
    renderExamPapersM();
  }
  function openExamPaperM(id) {
    const raw = (DB.data.examPapers || []).find(x => x.id === id);
    if (!raw) return toast("未找到试卷");
    const p = Object.assign({ id: raw.id }, raw.body || {});
    const map = {};
    (DB.data.questions || []).forEach(q => { map[q.id] = q; });
    const qs = (p.questionIds || []).map(qid => map[qid]).filter(Boolean)
      .map((q, i) => ({ q, i, n: (v => (isNaN(v) || v <= 0) ? Infinity : v)(parseInt((q.body || {}).qno, 10)) }))
      .sort((a, b) => (a.n === b.n ? a.i - b.i : a.n - b.n))
      .map(x => x.q);
    let body = "";
    qs.forEach(q => {
      const b = q.body || {};
      body += '<div class="card" style="margin:6px 0">' + renderRich(b.content) +
        '<div class="muted">答：' + (renderRich(b.answer) || "—") + "</div></div>";
    });
    if (!qs.length) body = '<div class="center muted">该卷题目尚未同步到手机端</div>';
    $("#modalBox").innerHTML = '<div class="modal-header"><span class="modal-title">📄 ' + esc(p.title || "试卷") + '</span><button class="modal-close" onclick="closeModal()">✕</button></div>' +
      '<div class="modal-body">' + body + "</div>" +
      '<div class="modal-footer"><button class="btn sec" style="flex:1 1 100%" onclick="closeModal()">关闭</button></div>';
    openModal();
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
  window.quickCompose = quickCompose;
  window.showLightbox = showLightbox;
  window.openDetail = openDetail; window.openEditor = openEditor; window.saveQ = saveQ;
  // 好题收藏 / 我的分类
  window.toggleFav = toggleFav; window.openCatPicker = openCatPicker;
  window.catPickToggle = catPickToggle; window.catPickCreate = catPickCreate; window.catPickSave = catPickSave;
  window.manageMyCats = manageMyCats; window.renderCatMgrBox = renderCatMgrBox;
  window.catMgrCreate = catMgrCreate; window.catMgrAddChild = catMgrAddChild;
  window.catMgrRename = catMgrRename; window.catMgrDel = catMgrDel;
  window.favMode = favMode; window.favPickCat = favPickCat; window.renderFavView = renderFavView;
  window.setFavFilter = setFavFilter; window.setCatFilter = setCatFilter; window.renderQfChips = renderQfChips;
  window.delQ = delQ; window.closeModal = closeModal; window.openPaper = openPaper;
  window.downloadPaper = downloadPaper;
  window.switchMain = switchMain; window.qSub = qSub; window.schedSub = schedSub;
  window.renderStudents = renderStudents; window.openStudentEditor = openStudentEditor; window.saveStudentEditor = saveStudentEditor; window.doRecharge = doRecharge;
  window.doComposeSave = doComposeSave; window.commitComposeSave = commitComposeSave; window.clearComposeSel = clearComposeSel; window.openComposeModal = openComposeModal;
  window.renderMyPapers = renderMyPapers; window.renderAllPapers = renderAllPapers;
  window.epSetFilterM = epSetFilterM; window.epClearFilterM = epClearFilterM; window.epKwInput = epKwInput; window.openExamPaperM = openExamPaperM;
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

  // 接收内嵌「错题训练」iframe 的 Word 下载请求：内嵌页无法直接下载文件，
  // 训练页会把文件(base64)postMessage 给父窗口，由这里触发保存。
  window.addEventListener("message", (e) => {
    const d = e.data || {};
    if (d.type !== "xls-save-file" || !d.name || !d.b64) return;
    try {
      const bin = atob(d.b64);
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      const blob = new Blob([bytes], {type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document"});
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob); a.download = d.name;
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(a.href), 5000);
      try { toast("已开始下载：" + d.name); } catch (_) {}
    } catch (_) {}
  });

  // 全局事件委托：题库卡片（详情/答案/组卷/错题/知识点/图片放大）
  document.getElementById("qList").addEventListener("click", qListClick);
  // 顶部菜单左右滑动切换（题库 / 好题 / 组卷 / 试卷 / 添加题目）
  (function () {
    const sec = document.getElementById("view-questions");
    if (!sec) return;
    const order = ["q", "fav", "compose", "paper", "add"];
    let sx = 0, sy = 0, tracking = false;
    function inHScroll(el) {
      while (el && el !== document.body && el !== document.documentElement) {
        const cs = getComputedStyle(el);
        if ((cs.overflowX === "auto" || cs.overflowX === "scroll") && el.scrollWidth > el.clientWidth + 4) return true;
        el = el.parentElement;
      }
      return false;
    }
    sec.addEventListener("touchstart", function (e) {
      if (e.touches.length !== 1) { tracking = false; return; }
      const t = e.target;
      // 顶部 tab 自身、弹窗/抽屉/灯箱、以及可横向滚动区域上不响应切换，避免误触
      if (t && t.closest && (t.closest(".subtabs") || t.closest(".modal") ||
          t.closest(".sheet-overlay") || t.closest(".lightbox") || t.closest("select") || inHScroll(t))) {
        tracking = false; return;
      }
      sx = e.touches[0].clientX; sy = e.touches[0].clientY; tracking = true;
    }, { passive: true });
    sec.addEventListener("touchend", function (e) {
      if (!tracking) return; tracking = false;
      const t = e.changedTouches && e.changedTouches[0]; if (!t) return;
      const dx = t.clientX - sx, dy = t.clientY - sy;
      if (Math.abs(dx) < 60 || Math.abs(dx) < Math.abs(dy) * 1.4) return;   // 太短或偏竖直＝滚动，忽略
      let i = order.indexOf(qSubPane); if (i < 0) i = 0;
      if (dx < 0 && i < order.length - 1) qSub(order[i + 1]);               // 左滑 → 下一个
      else if (dx > 0 && i > 0) qSub(order[i - 1]);                          // 右滑 → 上一个
    }, { passive: true });
  })();
  const _favList = document.getElementById("favList");
  if (_favList) _favList.addEventListener("click", qListClick);
  document.getElementById("modalBox").addEventListener("click", (e) => {
    const img = e.target.closest("img");
    if (img) showLightbox(img.src);
  });

  // 开屏淡出：首屏就绪后收起；最少显示 0.8s（避免一闪而过），另有 5s 兜底
  function splashOut() {
    const el = document.getElementById("appSplash");
    if (!el || el._out) return;
    el._out = true;
    const wait = Math.max(0, 800 - (window.performance && performance.now ? performance.now() : 0));
    setTimeout(() => { el.classList.add("gone"); setTimeout(() => el.remove(), 450); }, wait);
  }
  (async function boot() {
    try {
      if (token) await enterMain();
    } catch (e) { try { toast("启动失败：" + e.message); } catch (_) {} }
    finally { splashOut(); }
  })();
})();
