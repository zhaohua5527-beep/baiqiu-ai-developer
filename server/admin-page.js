function adminPage() {
  return String.raw`<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>白球 AI 管理后台</title>
  <style>
    :root { font-family: "Microsoft YaHei", "Segoe UI", Arial, sans-serif; color: #1f2933; background: #f3f5f7; }
    * { box-sizing: border-box; }
    body { margin: 0; min-width: 320px; background: #f3f5f7; }
    button, input, select, textarea { font: inherit; }
    button { cursor: pointer; }
    .app { min-height: 100vh; display: grid; grid-template-columns: 224px minmax(0, 1fr); }
    .side { padding: 24px 16px; background: #17212b; color: #d9e2ec; display: flex; flex-direction: column; gap: 28px; }
    .brand { display: flex; align-items: center; gap: 10px; padding: 0 8px; color: #fff; font-size: 17px; font-weight: 700; }
    .brand-mark { width: 30px; height: 30px; border-radius: 7px; display: grid; place-items: center; background: #0fbb8d; color: #072b25; font-weight: 800; }
    .brand small { display: block; margin-top: 2px; color: #92a5b7; font-size: 11px; font-weight: 500; }
    nav { display: grid; gap: 6px; }
    .nav { min-height: 42px; padding: 0 12px; display: flex; align-items: center; gap: 10px; border: 0; border-radius: 6px; background: transparent; color: #b8c7d5; text-align: left; }
    .nav:hover, .nav.active { background: #243342; color: #fff; }
    .nav i { width: 16px; height: 16px; border: 2px solid currentColor; border-radius: 4px; opacity: .82; }
    .nav[data-view="customers"] i { border-radius: 50%; box-shadow: 8px 0 0 -4px #17212b, 8px 0 0 -2px currentColor; }
    .nav[data-view="releases"] i { border-radius: 2px; border-top-width: 6px; }
    .side-footer { margin-top: auto; padding: 12px 8px; border-top: 1px solid #2b3d4e; color: #91a4b5; font-size: 12px; line-height: 1.65; }
    .workspace { min-width: 0; }
    .topbar { min-height: 72px; padding: 14px 32px; border-bottom: 1px solid #dde3e9; background: #fff; display: flex; align-items: center; justify-content: space-between; gap: 18px; }
    .topbar h1 { margin: 0; font-size: 19px; }
    .topbar p { margin: 4px 0 0; color: #6b7785; font-size: 12px; }
    .auth { display: flex; align-items: center; gap: 8px; }
    .auth input { width: 176px; height: 36px; padding: 0 10px; border: 1px solid #cbd5df; border-radius: 5px; color: #273444; }
    .content { max-width: 1540px; margin: 0 auto; padding: 28px 32px 48px; }
    .view { display: none; }
    .view.active { display: block; }
    .section-head { margin-bottom: 20px; display: flex; align-items: flex-end; justify-content: space-between; gap: 16px; }
    .section-head h2 { margin: 0; font-size: 22px; }
    .section-head p { margin: 6px 0 0; color: #697785; font-size: 13px; }
    .primary, .secondary, .danger-btn { min-height: 36px; padding: 0 13px; border: 1px solid transparent; border-radius: 5px; font-weight: 600; }
    .primary { background: #087f5b; color: #fff; border-color: #087f5b; }
    .primary:hover { background: #066c4d; }
    .secondary { background: #fff; color: #34495e; border-color: #cbd5df; }
    .secondary:hover { background: #f4f7f9; }
    .danger-btn { background: #fff4f3; color: #b73a31; border-color: #f0b9b4; }
    .kpis { display: grid; grid-template-columns: repeat(5, minmax(130px, 1fr)); gap: 14px; margin-bottom: 22px; }
    .kpi { min-height: 118px; padding: 17px; border: 1px solid #dde3e9; border-radius: 7px; background: #fff; }
    .kpi span { display: block; color: #6d7b88; font-size: 12px; }
    .kpi strong { display: block; margin-top: 12px; color: #1f2d3d; font-size: 29px; line-height: 1; }
    .kpi small { display: block; margin-top: 9px; color: #8492a0; font-size: 11px; }
    .kpi.emphasis { border-top: 3px solid #0fbb8d; }
    .kpi.warning { border-top: 3px solid #f2a93b; }
    .grid { display: grid; grid-template-columns: minmax(0, 1.45fr) minmax(300px, .9fr); gap: 18px; }
    .panel { min-width: 0; border: 1px solid #dde3e9; border-radius: 7px; background: #fff; }
    .panel-head { min-height: 57px; padding: 0 17px; display: flex; align-items: center; justify-content: space-between; gap: 10px; border-bottom: 1px solid #e7ebef; }
    .panel-head h3 { margin: 0; font-size: 15px; }
    .panel-head span { color: #798794; font-size: 12px; }
    .queue, .risk-list { padding: 2px 17px 12px; }
    .queue-row, .risk-row { padding: 13px 0; display: grid; grid-template-columns: 10px minmax(0, 1fr) auto; align-items: center; gap: 10px; border-bottom: 1px solid #edf0f2; }
    .queue-row:last-child, .risk-row:last-child { border: 0; }
    .dot { width: 8px; height: 8px; border-radius: 50%; background: #ccd6dd; }
    .dot.pending { background: #f2a93b; }.dot.progress { background: #2684c7; }.dot.done { background: #0fbb8d; }.dot.risk { background: #df5b57; }
    .queue-row b, .risk-row b { display: block; font-size: 13px; }
    .queue-row small, .risk-row small { display: block; margin-top: 4px; color: #788694; font-size: 12px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .queue-row button { border: 0; background: transparent; color: #087f5b; font-size: 12px; font-weight: 600; }
    .notice { padding: 16px 17px; color: #778592; font-size: 13px; }
    .tools { margin-bottom: 15px; display: flex; gap: 8px; flex-wrap: wrap; }
    .tools input, .tools select { height: 36px; padding: 0 10px; border: 1px solid #cbd5df; border-radius: 5px; background: #fff; color: #34495e; }
    .tools input { min-width: 230px; flex: 1 1 280px; }
    .table-wrap { overflow: auto; }
    table { width: 100%; min-width: 900px; border-collapse: collapse; }
    th, td { padding: 13px 14px; border-bottom: 1px solid #e7ebef; text-align: left; vertical-align: middle; font-size: 13px; }
    th { color: #758391; background: #f8fafb; font-size: 12px; font-weight: 600; white-space: nowrap; }
    tr:last-child td { border-bottom: 0; }
    tbody tr:hover { background: #fbfcfd; }
    .identity b { display: block; color: #263748; }.identity small { display: block; margin-top: 4px; color: #7d8a97; }
    .code { font-family: Consolas, monospace; color: #405264; font-size: 12px; }
    .tag { display: inline-flex; min-height: 22px; align-items: center; padding: 0 7px; border-radius: 4px; background: #edf2f5; color: #526270; font-size: 11px; white-space: nowrap; }
    .tag.pending { background: #fff4df; color: #9b6512; }.tag.progress { background: #eaf3fb; color: #2474ab; }.tag.done { background: #e8f7f1; color: #087f5b; }.tag.muted { background: #eef1f4; color: #687684; }.tag.risk { background: #fff0ef; color: #c74740; }
    .row-action { border: 0; background: transparent; color: #087f5b; font-weight: 600; font-size: 12px; }
    .customer-layout { display: grid; grid-template-columns: minmax(0, 1.45fr) 340px; gap: 18px; }
    .detail { position: sticky; top: 20px; align-self: start; }
    .detail-body { padding: 17px; }
    .detail-empty { color: #7b8894; line-height: 1.7; font-size: 13px; }
    .detail-title { margin: 0 0 5px; font-size: 18px; }.detail-sub { margin: 0 0 17px; color: #788694; font-size: 12px; }
    .field { display: grid; gap: 6px; margin-top: 13px; color: #657482; font-size: 12px; }
    .field input, .field select, .field textarea { width: 100%; padding: 8px 9px; border: 1px solid #cbd5df; border-radius: 5px; background: #fff; color: #273444; }
    .field input, .field select { min-height: 36px; }.field textarea { min-height: 92px; resize: vertical; line-height: 1.5; }
    .detail-meta { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; margin: 17px 0; }.detail-meta div { padding: 9px; border-radius: 5px; background: #f5f7f8; }.detail-meta span { display: block; color: #7a8894; font-size: 11px; }.detail-meta b { display: block; margin-top: 4px; color: #384a5b; font-size: 12px; word-break: break-all; }
    .form-grid { display: grid; grid-template-columns: 150px minmax(160px, 1fr) minmax(190px, 1.2fr) auto; align-items: end; gap: 10px; padding: 17px; }
    .form-grid label { display: grid; gap: 6px; color: #677684; font-size: 12px; }.form-grid input { height: 36px; padding: 0 9px; border: 1px solid #cbd5df; border-radius: 5px; }
    .release-note { max-width: 320px; color: #637383; line-height: 1.5; }.download { color: #087f5b; font-weight: 600; text-decoration: none; }
    .status { min-height: 20px; margin-top: 10px; color: #087f5b; font-size: 13px; }.status.error { color: #c74740; }
    .modal { position: fixed; inset: 0; z-index: 5; display: none; place-items: center; padding: 20px; background: rgba(23, 33, 43, .42); }.modal.show { display: grid; }.modal-box { width: min(650px, 100%); border-radius: 7px; background: #fff; box-shadow: 0 18px 55px rgba(17, 28, 38, .25); }.modal-head { padding: 17px; display: flex; align-items: center; justify-content: space-between; border-bottom: 1px solid #e4e9ed; }.modal-head h3 { margin: 0; font-size: 16px; }.modal-head button { border: 0; background: transparent; font-size: 22px; color: #72808c; }.modal-footer { padding: 0 17px 17px; display: flex; justify-content: flex-end; gap: 8px; }
    @media (max-width: 1120px) { .kpis { grid-template-columns: repeat(3, 1fr); }.customer-layout { grid-template-columns: 1fr; }.detail { position: static; }.grid { grid-template-columns: 1fr; } }
    @media (max-width: 720px) { .app { grid-template-columns: 1fr; }.side { padding: 12px; flex-direction: row; align-items: center; gap: 10px; }.brand { flex: 1; }.brand small, .side-footer { display: none; }nav { display: flex; gap: 3px; }.nav { min-height: 34px; padding: 0 8px; font-size: 0; }.nav i { width: 14px; height: 14px; }.topbar { padding: 13px 16px; }.topbar p { display: none; }.auth input { width: 125px; }.content { padding: 20px 16px 36px; }.kpis { grid-template-columns: repeat(2, 1fr); }.kpi { min-height: 100px; }.section-head { align-items: flex-start; flex-direction: column; }.form-grid { grid-template-columns: 1fr; }.form-grid button { width: 100%; } }
  </style>
</head>
<body>
  <div class="app">
    <aside class="side">
      <div class="brand"><span class="brand-mark">B</span><span>白球 AI<small>客户运营中心</small></span></div>
      <nav>
        <button class="nav active" data-view="overview"><i></i>运营总览</button>
        <button class="nav" data-view="customers"><i></i>客户跟进</button>
        <button class="nav" data-view="releases"><i></i>版本发布</button>
      </nav>
      <div class="side-footer">只展示已有授权与激活数据<br>跟进记录保存在授权库</div>
    </aside>
    <div class="workspace">
      <header class="topbar"><div><h1 id="pageTitle">运营总览</h1><p id="pageDesc">掌握客户状态，优先处理今天需要联系的人。</p></div><div class="auth"><input id="token" type="password" placeholder="管理员令牌" autocomplete="current-password"><button class="secondary" id="refreshBtn">刷新数据</button></div></header>
      <main class="content">
        <section class="view active" id="overviewView">
          <div class="section-head"><div><h2>今天的客户运营</h2><p id="overviewTime">正在读取授权数据...</p></div><button class="primary" data-go-customers>处理跟进队列</button></div>
          <div class="kpis" id="kpis"></div>
          <div class="grid"><section class="panel"><header class="panel-head"><h3>优先跟进</h3><span id="queueCount"></span></header><div class="queue" id="queue"></div></section><section class="panel"><header class="panel-head"><h3>风险提醒</h3><span id="riskCount"></span></header><div class="risk-list" id="risks"></div></section></div>
        </section>
        <section class="view" id="customersView">
          <div class="section-head"><div><h2>客户跟进</h2><p>在这里记录联系结果，安排下一次跟进，并快速识别沉默或临期客户。</p></div><button class="primary" id="newLicenseBtn">生成授权码</button></div>
          <div class="customer-layout"><section class="panel"><div class="panel-head"><h3>客户列表</h3><span id="customerCount"></span></div><div class="tools"><input id="customerSearch" placeholder="搜索姓名、手机号、授权码或设备"><select id="customerFilter"><option value="all">全部状态</option><option value="pending">待跟进</option><option value="progress">跟进中</option><option value="done">已完成</option><option value="none">未安排</option></select></div><div class="table-wrap"><table><thead><tr><th>客户</th><th>跟进状态</th><th>下次联系</th><th>授权 / 设备</th><th>最近活跃</th><th></th></tr></thead><tbody id="customerRows"></tbody></table></div></section><aside class="panel detail"><header class="panel-head"><h3>客户档案</h3><span id="detailState">未选择</span></header><div class="detail-body" id="detail"></div></aside></div>
        </section>
        <section class="view" id="releasesView">
          <div class="section-head"><div><h2>版本发布</h2><p>上传完整安装包或热更新包。客户下载地址保持不变。</p></div><a class="secondary download" href="/download" target="_blank">打开下载页</a></div>
          <section class="panel"><header class="panel-head"><h3>发布新版本</h3><span>支持 .exe 与 .zip</span></header><div class="form-grid"><label>版本号<input id="releaseVersion" placeholder="例如 3.0.19"></label><label>更新说明<input id="releaseNotes" placeholder="本次更新内容"></label><label>安装包 / 更新包<input id="releaseFile" type="file" accept=".exe,.zip"></label><button class="primary" id="uploadReleaseBtn">上传并发布</button></div></section><div class="status" id="releaseStatus"></div>
          <section class="panel" style="margin-top:18px"><header class="panel-head"><h3>已发布版本</h3><span id="releaseCount"></span></header><div class="table-wrap"><table><thead><tr><th>版本</th><th>文件</th><th>大小</th><th>发布时间</th><th>更新说明</th><th>下载</th></tr></thead><tbody id="releaseRows"></tbody></table></div></section>
        </section>
        <div class="status" id="status"></div>
      </main>
    </div>
  </div>
  <div class="modal" id="licenseModal"><div class="modal-box"><div class="modal-head"><h3>生成授权码</h3><button type="button" data-close-modal aria-label="关闭">×</button></div><div class="form-grid"><label>生成数量<input id="licenseCount" type="number" min="1" max="500" value="1"></label><label>到期时间<input id="licenseExpires" value="2099-12-31T23:59:59Z"></label><label>备注<input id="licenseNotes" placeholder="例如：渠道、客户来源"></label></div><div class="modal-footer"><button class="secondary" data-close-modal>取消</button><button class="primary" id="createLicenseBtn">生成</button></div></div></div>
  <script>
    const state = { licenses: [], releases: [], activeCode: "", currentView: "overview" };
    const views = { overview: ["运营总览", "掌握客户状态，优先处理今天需要联系的人。"], customers: ["客户跟进", "让每一位客户都有清晰的下一步。"], releases: ["版本发布", "统一管理客户端安装包与更新包。"] };
    const $ = (id) => document.getElementById(id);
    const escapeHtml = (value) => String(value == null ? "" : value).replace(/[&<>\"']/g, (char) => ({ "&":"&amp;", "<":"&lt;", ">":"&gt;", "\"":"&quot;", "'":"&#39;" })[char]);
    const fmtTime = (value) => { if (!value) return "--"; const date = new Date(value); return Number.isNaN(date.getTime()) ? String(value) : date.toLocaleString("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }); };
    const fmtDateInput = (value) => { if (!value) return ""; const d = new Date(value); if (Number.isNaN(d.getTime())) return ""; const off = d.getTimezoneOffset() * 60000; return new Date(d - off).toISOString().slice(0, 16); };
    const fmtSize = (size) => { const n = Number(size || 0); return n > 1048576 ? (n / 1048576).toFixed(1) + " MB" : n > 1024 ? (n / 1024).toFixed(1) + " KB" : n + " B"; };
    const tracking = (item) => item.customerTracking || {};
    const statusLabel = (value) => ({ pending: "待跟进", progress: "跟进中", done: "已完成", none: "未安排" })[value] || "未安排";
    const statusClass = (value) => ["pending", "progress", "done"].includes(value) ? value : "muted";
    const deviceLastSeen = (item) => Math.max(0, ...(item.devices || []).map((device) => Number(device.lastSeenAt || device.activatedAt || 0)));
    const daysUntil = (value) => { const t = Date.parse(value || ""); return Number.isFinite(t) ? Math.ceil((t - Date.now()) / 86400000) : null; };
    function authHeaders(extra) { return Object.assign({ "x-admin-token": $("token").value.trim() }, extra || {}); }
    function message(text, error) { const el = $("status"); el.textContent = text || ""; el.className = error ? "status error" : "status"; }
    async function api(path, options) { const opts = options || {}; const res = await fetch(path, Object.assign({}, opts, { headers: authHeaders(opts.headers) })); const data = await res.json().catch(() => ({})); if (!res.ok || data.success === false) throw new Error(data.message || "请求失败，请检查管理员令牌。"); return data; }
    function customerName(item) { return item.customer && item.customer.name ? item.customer.name : "未填写姓名"; }
    function customerPhone(item) { return item.customer && item.customer.phone ? item.customer.phone : "未填写手机号"; }
    function customerRisk(item) { const days = daysUntil(item.expiresAt); const lastSeen = deviceLastSeen(item); if (item.status === "banned") return "已停用"; if (days !== null && days >= 0 && days <= 7 && !String(item.expiresAt).startsWith("2099-")) return "即将到期"; if (lastSeen && Date.now() - lastSeen > 14 * 86400000) return "14 天未活跃"; if (!item.customer || !item.customer.name || !item.customer.phone) return "资料未完善"; return ""; }
    function renderOverview() {
      const list = state.licenses; const now = Date.now(); const active = list.filter((item) => item.status === "used"); const pending = list.filter((item) => tracking(item).status === "pending" || tracking(item).status === "progress"); const risks = list.filter(customerRisk); const today = list.filter((item) => (item.activationHistory || []).some((entry) => new Date(entry.activatedAt).toDateString() === new Date().toDateString()));
      const kpis = [["已授权客户", active.length, "已完成设备激活"], ["待跟进", pending.length, "含跟进中客户"], ["今日激活", today.length, "按激活记录统计"], ["风险提醒", risks.length, "临期、沉默或资料缺失"], ["授权码总数", list.length, "包含未使用授权码"]];
      $("kpis").innerHTML = kpis.map((item, index) => "<article class='kpi " + (index === 1 ? "warning" : index === 0 ? "emphasis" : "") + "'><span>" + item[0] + "</span><strong>" + item[1] + "</strong><small>" + item[2] + "</small></article>").join("");
      const queue = pending.slice().sort((a, b) => Number(tracking(a).followUpAt || 0) - Number(tracking(b).followUpAt || 0));
      $("queueCount").textContent = queue.length + " 位客户";
      $("queue").innerHTML = queue.length ? queue.slice(0, 8).map((item) => { const t = tracking(item); return "<div class='queue-row'><span class='dot " + statusClass(t.status) + "'></span><div><b>" + escapeHtml(customerName(item)) + " <span class='tag " + statusClass(t.status) + "'>" + statusLabel(t.status) + "</span></b><small>" + (t.followUpAt ? "下次联系：" + fmtTime(t.followUpAt) : "尚未安排下次联系") + "</small></div><button data-open='" + escapeHtml(item.code) + "'>查看</button></div>"; }).join("") : "<div class='notice'>暂无待跟进客户。生成授权码或完成一次激活后，客户会出现在这里。</div>";
      $("riskCount").textContent = risks.length + " 项";
      $("risks").innerHTML = risks.length ? risks.slice(0, 8).map((item) => "<div class='risk-row'><span class='dot risk'></span><div><b>" + escapeHtml(customerName(item)) + "</b><small>" + escapeHtml(customerRisk(item)) + " · " + escapeHtml(item.code) + "</small></div><button data-open='" + escapeHtml(item.code) + "'>处理</button></div>").join("") : "<div class='notice'>当前没有需要优先处理的客户风险。</div>";
      $("overviewTime").textContent = "最后刷新：" + new Date(now).toLocaleString("zh-CN") + " · 共 " + list.length + " 个授权记录";
    }
    function filteredCustomers() { const q = $("customerSearch").value.trim().toLowerCase(); const filter = $("customerFilter").value; return state.licenses.filter((item) => { const t = tracking(item); const text = [customerName(item), customerPhone(item), item.code, ...(item.devices || []).map((d) => d.deviceId)].join(" ").toLowerCase(); return (!q || text.includes(q)) && (filter === "all" || (filter === "none" ? !t.status : t.status === filter)); }); }
    function renderCustomers() { const list = filteredCustomers(); $("customerCount").textContent = list.length + " 位记录"; $("customerRows").innerHTML = list.length ? list.map((item) => { const t = tracking(item); const last = deviceLastSeen(item); return "<tr><td class='identity'><b>" + escapeHtml(customerName(item)) + "</b><small>" + escapeHtml(customerPhone(item)) + "</small></td><td><span class='tag " + statusClass(t.status) + "'>" + statusLabel(t.status) + "</span></td><td>" + (t.followUpAt ? fmtTime(t.followUpAt) : "--") + "</td><td><span class='code'>" + escapeHtml(item.code) + "</span><br><small>" + (item.devices || []).length + " / 3 台设备</small></td><td>" + fmtTime(last) + "</td><td><button class='row-action' data-open='" + escapeHtml(item.code) + "'>跟进</button></td></tr>"; }).join("") : "<tr><td colspan='6' class='notice'>没有找到匹配客户。</td></tr>"; renderDetail(); }
    function renderDetail() { const item = state.licenses.find((row) => row.code === state.activeCode); const host = $("detail"); if (!item) { $("detailState").textContent = "未选择"; host.innerHTML = "<div class='detail-empty'>从左侧客户列表选择一位客户，记录本次联系和下一步安排。</div>"; return; } const t = tracking(item); $("detailState").textContent = statusLabel(t.status); host.innerHTML = "<h3 class='detail-title'>" + escapeHtml(customerName(item)) + "</h3><p class='detail-sub'>" + escapeHtml(customerPhone(item)) + " · " + escapeHtml(item.code) + "</p><div class='detail-meta'><div><span>设备数量</span><b>" + (item.devices || []).length + " / 3</b></div><div><span>最近活跃</span><b>" + fmtTime(deviceLastSeen(item)) + "</b></div><div><span>授权到期</span><b>" + escapeHtml(String(item.expiresAt || "--").slice(0, 10)) + "</b></div><div><span>风险状态</span><b>" + escapeHtml(customerRisk(item) || "正常") + "</b></div></div><label class='field'>跟进状态<select id='trackingStatus'><option value='none'>未安排</option><option value='pending'>待跟进</option><option value='progress'>跟进中</option><option value='done'>已完成</option></select></label><label class='field'>下次联系<input id='trackingTime' type='datetime-local'></label><label class='field'>本次跟进备注<textarea id='trackingNotes' maxlength='2000' placeholder='例如：已电话沟通，周五确认续费方案'></textarea></label><label class='field'>最后联系时间<input id='contactedTime' type='datetime-local'></label><div style='margin-top:16px;display:flex;gap:8px'><button class='primary' id='saveTrackingBtn'>保存跟进记录</button><button class='secondary' id='copyCodeBtn'>复制授权码</button></div>"; $("trackingStatus").value = t.status || "none"; $("trackingTime").value = fmtDateInput(t.followUpAt); $("trackingNotes").value = t.notes || ""; $("contactedTime").value = fmtDateInput(t.lastContactedAt); }
    function renderReleases() { $("releaseCount").textContent = state.releases.length + " 个版本"; $("releaseRows").innerHTML = state.releases.length ? state.releases.map((item) => "<tr><td class='code'>" + escapeHtml(item.version) + "</td><td>" + escapeHtml(item.installerFile || item.file || "--") + "</td><td>" + fmtSize(item.fileSize) + "</td><td>" + fmtTime(item.publishedAt) + "</td><td class='release-note'>" + escapeHtml(item.notes || "--") + "</td><td><a class='download' target='_blank' href='" + escapeHtml(item.downloadUrl) + "'>下载</a></td></tr>").join("") : "<tr><td colspan='6' class='notice'>暂无发布版本。</td></tr>"; }
    function renderAll() { renderOverview(); renderCustomers(); renderReleases(); }
    async function loadData() { try { message("正在刷新数据..."); const results = await Promise.all([api("/admin/licenses"), api("/admin/releases")]); state.licenses = results[0].licenses || []; state.releases = results[1].releases || []; renderAll(); message("数据已刷新。"); } catch (error) { message(error.message, true); } }
    function openCustomer(code) { state.activeCode = code; switchView("customers"); renderCustomers(); }
    function switchView(view) { state.currentView = view; document.querySelectorAll(".view").forEach((el) => el.classList.toggle("active", el.id === view + "View")); document.querySelectorAll(".nav").forEach((el) => el.classList.toggle("active", el.dataset.view === view)); $("pageTitle").textContent = views[view][0]; $("pageDesc").textContent = views[view][1]; }
    document.querySelectorAll(".nav").forEach((button) => button.addEventListener("click", () => switchView(button.dataset.view)));
    document.querySelectorAll("[data-go-customers]").forEach((button) => button.addEventListener("click", () => switchView("customers")));
    $("refreshBtn").addEventListener("click", loadData); $("token").addEventListener("keydown", (event) => { if (event.key === "Enter") loadData(); }); $("customerSearch").addEventListener("input", renderCustomers); $("customerFilter").addEventListener("change", renderCustomers);
    document.addEventListener("click", (event) => { const open = event.target.closest("[data-open]"); if (open) openCustomer(open.dataset.open); });
    $("detail").addEventListener("click", async (event) => { if (event.target.id === "copyCodeBtn") { await navigator.clipboard.writeText(state.activeCode); message("授权码已复制。"); } if (event.target.id === "saveTrackingBtn") { try { const body = { code: state.activeCode, status: $("trackingStatus").value, followUpAt: $("trackingTime").value ? new Date($("trackingTime").value).toISOString() : "", notes: $("trackingNotes").value.trim(), lastContactedAt: $("contactedTime").value ? new Date($("contactedTime").value).toISOString() : "" }; await api("/admin/licenses/tracking", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }); await loadData(); message("跟进记录已保存。"); } catch (error) { message(error.message, true); } } });
    $("newLicenseBtn").addEventListener("click", () => $("licenseModal").classList.add("show")); document.querySelectorAll("[data-close-modal]").forEach((button) => button.addEventListener("click", () => $("licenseModal").classList.remove("show")));
    $("createLicenseBtn").addEventListener("click", async () => { try { const data = await api("/admin/licenses/create", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ count: Number($("licenseCount").value || 1), expiresAt: $("licenseExpires").value.trim(), notes: $("licenseNotes").value.trim() }) }); $("licenseModal").classList.remove("show"); await loadData(); message("已生成 " + (data.licenses || []).length + " 个授权码。"); } catch (error) { message(error.message, true); } });
    $("uploadReleaseBtn").addEventListener("click", async () => { const file = $("releaseFile").files[0]; const version = $("releaseVersion").value.trim(); if (!version || !file) { $("releaseStatus").textContent = "请填写版本号并选择安装包或更新包。"; $("releaseStatus").className = "status error"; return; } try { $("releaseStatus").textContent = "正在上传 " + file.name + "..."; const params = new URLSearchParams({ version: version, notes: $("releaseNotes").value.trim(), fileName: file.name }); const response = await fetch("/admin/releases/upload?" + params.toString(), { method: "POST", headers: authHeaders({ "Content-Type": "application/octet-stream" }), body: file }); const data = await response.json(); if (!response.ok || data.success === false) throw new Error(data.message || "上传失败"); $("releaseStatus").textContent = "版本 " + data.release.version + " 已发布。"; $("releaseStatus").className = "status"; await loadData(); } catch (error) { $("releaseStatus").textContent = error.message; $("releaseStatus").className = "status error"; } });
    renderAll();
  </script>
</body>
</html>`;
}

module.exports = { adminPage };
