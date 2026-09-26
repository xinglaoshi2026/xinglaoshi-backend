// 每日一题 · 学生端（独立纯净版，仅含每日一题：今日答题 + 错题本）
// 与老师端（邢老师工作台）共用同一后端 / 同一套数据，仅渲染学生视角。
(function () {
  const $ = (s) => document.querySelector(s);
  const LS_TOKEN = "xls_stoken", LS_USER = "xls_suser", LS_BASE = "xls_sbase";
  let token = localStorage.getItem(LS_TOKEN);
  let user = localStorage.getItem(LS_USER);
  let DB = { data: {} };
  let stuSub = "practice";
  let meName = "", meId = "";

  // ---------- 基础工具 ----------
  function api(method, path, body) {
    const base = localStorage.getItem(LS_BASE) || "";
    let url = base + path;
    const opt = { method, headers: {} };
    if (token) opt.headers["Authorization"] = "Bearer " + token;
    if (method === "DELETE" && token) url += (url.includes("?") ? "&" : "?") + "token=" + encodeURIComponent(token);
    if (body !== undefined) { opt.headers["Content-Type"] = "application/json"; opt.body = JSON.stringify(body); }
    return fetch(url, opt).then(async (r) => {
      let t = ""; try { t = await r.text(); } catch (e) {}
      if (!r.ok) { let m = "HTTP " + r.status; try { m = (t && JSON.parse(t).error) || m; } catch (e) {} throw new Error(m); }
      return t ? JSON.parse(t) : {};
    });
  }
  function esc(s) { return (s == null ? "" : String(s)).replace(/[&<>]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c])); }
  function mediaUrl(p) {
    const base = localStorage.getItem(LS_BASE) || "";
    return base + "/api/media/" + p + (token ? "?token=" + encodeURIComponent(token) : "");
  }
  function imgRetry(el) {
    if (!el.dataset.r) { el.dataset.r = "1"; el.src = el.src + (el.src.includes("?") ? "&" : "?") + "r=" + Date.now(); }
    else { el.style.display = "none"; }
  }
  window.imgRetry = imgRetry;
  function renderMedia(text) {
    if (!text) return "";
    return esc(text).replace(/media:\/\/((?:dailyQuestions|questions)\/[^\s)]+)/g,
      (m, p) => `<img class="qimg" loading="lazy" src="${mediaUrl(p)}" onerror="imgRetry(this)">`);
  }
  function renderRich(html) {
    if (!html) return "";
    const s = String(html);
    if (/<[a-z][\s\S]*>/i.test(s)) {
      return s.replace(/<div class="qb-meta">[\s\S]*?<\/div>/gi, "")
              .replace(/(src\s*=\s*["'])media:\/\/([^\s"'>]+)/gi, (m, pre, p) => pre + mediaUrl(p))
              .replace(/<img(?![^>]*onerror)/gi, '<img loading="lazy" onerror="imgRetry(this)"')
              .replace(/<img(?![^>]*\bclass=)/gi, '<img class="qimg"');
    }
    return renderMedia(s);
  }
  function toast(msg) {
    const el = $("#toast"); el.textContent = msg; el.classList.add("show");
    clearTimeout(toast._t); toast._t = setTimeout(() => el.classList.remove("show"), 1800);
  }
  // 二进制上传（图片/文档）到 /api/media，返回 rel（去掉 /api/media/ 前缀）
  async function uploadMedia(sub, file) {
    const base = localStorage.getItem(LS_BASE) || "";
    const url = base + "/api/media?sub=" + encodeURIComponent(sub) + "&name=" + encodeURIComponent(file.name);
    const r = await fetch(url, {
      method: "POST",
      headers: token ? { "Authorization": "Bearer " + token } : {},
      body: file,
    });
    if (!r.ok) { let m = "HTTP " + r.status; try { m = (await r.json()).error || m; } catch (e) {} throw new Error(m); }
    const j = await r.json();
    return (j.url || "").replace(/^\/api\/media\//, "");
  }
  // 答案图片预览
  window.previewDailyImg = function (qid, input) {
    const el = $("#dqImgPrev_" + qid); if (!el) return;
    const f = input.files && input.files[0];
    if (!f) { el.innerHTML = ""; return; }
    const u = URL.createObjectURL(f);
    el.innerHTML = `<div style="margin-top:6px"><img src="${u}" style="max-width:100%;border-radius:8px;border:1px solid #eee"></div>`;
  };
  function pad(n) { return (n < 10 ? "0" : "") + n; }
  function todayStr() { const d = new Date(); return d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate()); }

  // ---------- 登录 / 同步 ----------
  async function doLogin() {
    const base = ($("#baseUrl").value.trim() || location.origin).replace(/\/+$/, "");
    const u = $("#username").value.trim(), p = $("#password").value.trim();
    if (!u || !p) { $("#loginMsg").textContent = "请填写账号和密码"; return; }
    $("#loginMsg").textContent = "登录中…";
    try {
      const r = await api("POST", "/api/auth/login", { username: u, password: p });
      token = r.token; user = JSON.stringify(r.user);
      meName = (r.user && r.user.username) || u;
      meId = (r.user && r.user.id) || "";
      localStorage.setItem(LS_TOKEN, token); localStorage.setItem(LS_USER, user); localStorage.setItem(LS_BASE, base);
      enterMain();
    } catch (e) { $("#loginMsg").textContent = "登录失败：" + e.message; }
  }
  function logout() {
    token = null; localStorage.removeItem(LS_TOKEN);
    $("#mainView").classList.add("hidden"); $("#loginView").classList.remove("hidden");
  }
  async function loadPull(force) {
    const since = (DB.server_ts || 0) && !force ? DB.server_ts : 0;
    const d = await api("GET", "/api/sync/pull?since=" + since);
    DB.data = Object.assign(DB.data, d.data || {});
    DB.server_ts = d.server_ts || DB.server_ts;
  }
  async function enterMain() {
    $("#loginView").classList.add("hidden"); $("#mainView").classList.remove("hidden");
    $("#stuName").textContent = meName || "";
    try { await loadPull(true); } catch (e) { toast("同步失败：" + e.message); }
    renderDaily();
  }

  // ---------- 学生：每日一题 ----------
  function _myDaily() {
    return (DB.data.dailyAnswers || []).filter(a => {
      const b = a.body || {};
      return (b.studentId && b.studentId === meId) || (b.studentName && b.studentName === meName);
    });
  }
  function renderDaily() {
    const tabs = [["practice", "今日一题"], ["wrong", "我的错题本"]];
    if (!tabs.find(t => t[0] === stuSub)) stuSub = "practice";
    $("#dailySubTabs").innerHTML = tabs.map(t =>
      `<button class="subtab ${t[0] === stuSub ? "on" : ""}" onclick="stuSub('${t[0]}')">${t[1]}</button>`).join("");
    $("#sub-practice").classList.toggle("hidden", stuSub !== "practice");
    $("#sub-wrong").classList.toggle("hidden", stuSub !== "wrong");
    if (stuSub === "practice") renderPractice();
    else renderWrong();
  }
  window.stuSub = (s) => { stuSub = s; renderDaily(); };

  function dailyDocLinks(docs) {
    if (!docs || !docs.length) return "";
    return `<div style="margin:6px 0"><div class="muted" style="margin-bottom:4px">📎 附件文档</div>` +
      docs.map(f => `<a class="btn sec sm" style="margin:3px 6px 3px 0;display:inline-block" href="${mediaUrl(encodeURIComponent(f.rel))}" target="_blank">📄 ${esc(f.name || f.rel)}</a>`).join("") +
      `</div>`;
  }
  function renderPractice() {
    const today = todayStr();
    const items = (DB.data.dailyQuestions || []).filter(x => (x.body && x.body.date) === today);
    const mine = _myDaily();
    const box = $("#sub-practice");
    if (!items.length) {
      box.innerHTML = `<div class="center">今天还没有出题～<br><span style="font-size:12px">老师会在老师端录入每日一题</span></div>`;
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
        body = `<textarea id="dqInput_${it.id}" placeholder="输入你的答案…（也可拍照/传图）" style="min-height:72px;margin-top:8px"></textarea>
          <label class="btn sec" for="dqImg_${it.id}" style="display:block;text-align:center;padding:9px;margin-top:8px">📷 上传答案图片（拍照/选图）<input type="file" id="dqImg_${it.id}" accept="image/*" style="display:none" onchange="previewDailyImg('${it.id}',this)"></label>
          <div id="dqImgPrev_${it.id}"></div>
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
          ${rec.body.answerImage ? `<div class="q-ans-box open" style="margin-top:6px"><div class="ans-label">我的答案图片</div><img class="qimg" src="${mediaUrl(rec.body.answerImage)}" onerror="imgRetry(this)" style="max-width:100%;border-radius:8px"></div>` : ""}
          ${tail}`;
      }
      const badge = !done ? `<span class="badge-gray">未答</span>`
        : correct === 1 ? `<span class="badge-success">已答对</span>`
        : correct === 0 ? `<span class="badge-danger">答错</span>`
        : `<span class="badge-gray">已提交</span>`;
      return `<div class="card">
        <div class="row" style="justify-content:space-between;align-items:center">
          <span class="badge-info">${esc(b.date || "")}</span>${badge}
        </div>
        <div class="q-content" style="margin-top:6px">${renderRich(b.stem || "")}</div>
        ${dailyDocLinks(b.docs)}
        ${body}
      </div>`;
    }).join("");
  }
  window.submitDailyAnswer = async function (qid) {
    const val = ($("#dqInput_" + qid).value || "").trim();
    const imgInput = $("#dqImg_" + qid);
    const file = imgInput && imgInput.files && imgInput.files[0];
    if (!val && !file) { toast("请先输入答案或上传图片"); return; }
    try {
      let answerImage = "";
      if (file) {
        toast("上传图片中…");
        answerImage = await uploadMedia("dailyAnswers/" + qid + "/" + (meId || meName), file);
      }
      await api("POST", "/api/daily/answer", { qId: qid, answer: val, answerImage });
      await loadPull(true); renderDaily(); toast("已提交 ✓");
    } catch (e) { toast("提交失败：" + e.message); }
  };
  window.markDaily = async function (qid, correct) {
    try {
      await api("POST", "/api/daily/answer", { qId: qid, correct });
      await loadPull(true); renderDaily(); toast(correct ? "已记为答对" : "已记为答错");
    } catch (e) { toast("提交失败：" + e.message); }
  };

  function renderWrong() {
    const box = $("#sub-wrong");
    const wrong = _myDaily().filter(a => a.body && a.body.correct === 0);
    if (!wrong.length) { box.innerHTML = `<div class="center">还没有错题，继续保持！</div>`; return; }
    box.innerHTML = wrong.map(a => {
      const q = (DB.data.dailyQuestions || []).find(x => x.id === a.body.qId);
      const b = q ? (q.body || {}) : {};
      return `<div class="card">
        <div class="row" style="justify-content:space-between;align-items:center">
          <span class="badge-info">${esc(b.date || "")}</span>
          <span class="badge-danger">答错</span>
        </div>
        <div class="q-content" style="margin-top:6px">${renderRich(b.stem || "")}</div>
        ${a.body.answer ? `<div class="muted" style="margin-top:4px">你的答案：${esc(a.body.answer)}</div>` : ""}
        ${a.body.answerImage ? `<div style="margin-top:4px"><img class="qimg" src="${mediaUrl(a.body.answerImage)}" onerror="imgRetry(this)" style="max-width:100%;border-radius:8px"></div>` : ""}
        <div class="q-ans-box open" style="margin-top:8px"><div class="ans-label">正确答案</div>${esc(b.answer || "（开放题，无标准答案）")}</div>
        ${b.analysis ? `<div class="q-ans-box open" style="margin-top:6px;border-left-color:var(--primary)"><div class="ans-label" style="color:var(--primary)">解析</div>${esc(b.analysis)}</div>` : ""}
      </div>`;
    }).join("");
  }

  // ---------- 启动 ----------
  window.doLogin = doLogin;
  window.logout = logout;
  (function init() {
    const base = localStorage.getItem(LS_BASE);
    if (base) $("#baseUrl").value = base;
    else $("#baseUrl").value = location.origin;
    if (token && user) {
      try { meName = (JSON.parse(user).username) || ""; meId = (JSON.parse(user).id) || ""; } catch (e) {}
      enterMain();
    }
  })();
})();
