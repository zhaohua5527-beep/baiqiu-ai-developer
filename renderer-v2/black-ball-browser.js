"use strict";

const api = window.blackBallBrowser;
const addressForm = document.getElementById("addressForm");
const addressInput = document.getElementById("addressInput");
const backBtn = document.getElementById("backBtn");
const forwardBtn = document.getElementById("forwardBtn");
const reloadBtn = document.getElementById("reloadBtn");
const homeBtn = document.getElementById("homeBtn");
const bookmarkBtn = document.getElementById("bookmarkBtn");
const savedBtn = document.getElementById("savedBtn");
const savedPanel = document.getElementById("savedPanel");
const bookmarkList = document.getElementById("bookmarkList");
const credentialList = document.getElementById("credentialList");
const saveCredentialBtn = document.getElementById("saveCredentialBtn");
const credentialDialog = document.getElementById("credentialDialog");
const credentialForm = document.getElementById("credentialForm");
const credentialOrigin = document.getElementById("credentialOrigin");
const credentialUsername = document.getElementById("credentialUsername");
const credentialPassword = document.getElementById("credentialPassword");
const credentialCancelBtn = document.getElementById("credentialCancelBtn");
const analyzeBtn = document.getElementById("analyzeBtn");
const externalBtn = document.getElementById("externalBtn");
const loadingState = document.getElementById("loadingState");
const securityState = document.getElementById("securityState");
const errorBar = document.getElementById("errorBar");
const browserTabs = document.getElementById("browserTabs");
const newTabBtn = document.getElementById("newTabBtn");
let currentState = {};

function escapeHtml(value = "") {
  return String(value).replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[character]));
}

function applyTheme(theme = {}) {
  const variables = { background: "--browser-background", surface: "--browser-surface", panel: "--browser-panel", text: "--browser-text", muted: "--browser-muted", accent: "--browser-accent", line: "--browser-line", lineStrong: "--browser-line-strong", accentSoft: "--browser-accent-soft" };
  Object.entries(variables).forEach(([key, variable]) => { if (theme[key]) document.documentElement.style.setProperty(variable, theme[key]); });
  if (theme.scheme === "dark" || theme.scheme === "light") document.documentElement.style.colorScheme = theme.scheme;
}

function renderSavedPanel() {
  const bookmarks = Array.isArray(currentState.bookmarks) ? currentState.bookmarks : [];
  bookmarkList.innerHTML = bookmarks.length ? bookmarks.map((item) => `<button type="button" data-bookmark-url="${escapeHtml(item.url)}"><strong>${escapeHtml(item.title || item.url)}</strong><small>${escapeHtml(item.url)}</small></button>`).join("") : "<p>还没有收藏</p>";
  bookmarkList.querySelectorAll("[data-bookmark-url]").forEach((button) => button.addEventListener("click", async () => {
    await api.navigate(button.dataset.bookmarkUrl);
    savedPanel.hidden = true;
  }));
  api.listCredentials().then((credentials) => {
    credentialList.innerHTML = credentials.length ? credentials.map((item) => `<div><button type="button" data-credential-fill="${escapeHtml(item.id)}"><strong>${escapeHtml(item.username)}</strong><small>${escapeHtml(item.origin)}</small></button><button type="button" class="delete" data-credential-delete="${escapeHtml(item.id)}" title="删除账号" aria-label="删除账号">×</button></div>`).join("") : "<p>当前网站没有保存账号</p>";
    credentialList.querySelectorAll("[data-credential-fill]").forEach((button) => button.addEventListener("click", async () => { await api.fillCredential(button.dataset.credentialFill); savedPanel.hidden = true; }));
    credentialList.querySelectorAll("[data-credential-delete]").forEach((button) => button.addEventListener("click", async () => { await api.deleteCredential(button.dataset.credentialDelete); renderSavedPanel(); }));
  }).catch(() => { credentialList.innerHTML = "<p>账号库暂时不可用</p>"; });
}

function applyState(state = {}) {
  currentState = { ...currentState, ...state };
  applyTheme(currentState.theme);
  if (currentState.url && document.activeElement !== addressInput) addressInput.value = currentState.url.startsWith("baiqiu://") ? "" : currentState.url;
  backBtn.disabled = !currentState.canGoBack;
  forwardBtn.disabled = !currentState.canGoForward;
  reloadBtn.textContent = currentState.loading ? "×" : "↻";
  reloadBtn.title = currentState.loading ? "停止加载" : "刷新";
  bookmarkBtn.textContent = currentState.isBookmarked ? "★" : "☆";
  bookmarkBtn.title = currentState.isBookmarked ? "取消收藏" : "加入收藏";
  bookmarkBtn.disabled = !/^https?:\/\//i.test(currentState.url || "");
  loadingState.textContent = currentState.loading ? "加载中" : "";
  securityState.dataset.secure = String(currentState.url || "").startsWith("https:") ? "true" : "false";
  errorBar.hidden = !currentState.error;
  errorBar.textContent = currentState.error || "";
  renderTabs();
  if (currentState.title) document.title = `${currentState.title} - 黑球浏览器`;
  if (!savedPanel.hidden) renderSavedPanel();
}

function renderTabs() {
  if (!browserTabs) return;
  const tabs = Array.isArray(currentState.tabs) ? currentState.tabs : [];
  browserTabs.querySelectorAll("[data-browser-tab]").forEach((node) => node.remove());
  tabs.forEach((tab) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = `browser-tab${tab.active ? " active" : ""}`;
    button.dataset.browserTab = tab.id;
    button.title = tab.title || "新标签页";
    button.innerHTML = `<span>${escapeHtml(tab.title || "新标签页")}</span><i data-browser-tab-close="${escapeHtml(tab.id)}" title="关闭标签页" aria-label="关闭标签页">×</i>`;
    button.addEventListener("click", (event) => {
      if (event.target.closest("[data-browser-tab-close]")) return;
      void api.selectTab(tab.id);
    });
    button.querySelector("[data-browser-tab-close]")?.addEventListener("click", (event) => {
      event.stopPropagation();
      void api.closeTab(tab.id);
    });
    browserTabs.insertBefore(button, newTabBtn);
  });
}

addressForm.addEventListener("submit", async (event) => { event.preventDefault(); await api.navigate(addressInput.value); });
newTabBtn?.addEventListener("click", () => api.newTab());
backBtn.addEventListener("click", () => api.back());
forwardBtn.addEventListener("click", () => api.forward());
reloadBtn.addEventListener("click", async () => { const state = await api.getState(); await (state.loading ? api.stop() : api.reload()); });
homeBtn.addEventListener("click", () => api.home());
bookmarkBtn.addEventListener("click", () => api.toggleBookmark());
savedBtn.addEventListener("click", () => { savedPanel.hidden = !savedPanel.hidden; if (!savedPanel.hidden) renderSavedPanel(); });
externalBtn.addEventListener("click", () => api.openExternal());
analyzeBtn.addEventListener("click", async () => {
  analyzeBtn.disabled = true;
  try { await api.analyze(); } finally { setTimeout(() => { analyzeBtn.disabled = false; }, 700); }
});
saveCredentialBtn.addEventListener("click", () => {
  if (!/^https?:\/\//i.test(currentState.url || "")) return;
  credentialOrigin.textContent = new URL(currentState.url).origin;
  credentialUsername.value = "";
  credentialPassword.value = "";
  credentialDialog.showModal();
  credentialUsername.focus();
});
credentialCancelBtn.addEventListener("click", () => credentialDialog.close());
credentialForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const result = await api.saveCredential({ username: credentialUsername.value, password: credentialPassword.value });
  if (result?.success) { credentialDialog.close(); renderSavedPanel(); }
  else credentialOrigin.textContent = result?.error || "保存失败";
});
document.addEventListener("pointerdown", (event) => { if (!savedPanel.hidden && !savedPanel.contains(event.target) && !savedBtn.contains(event.target)) savedPanel.hidden = true; });

api.onState(applyState);
api.getState().then(applyState);
