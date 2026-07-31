"use strict";

const api = window.blackBallBrowser;
const addressForm = document.getElementById("addressForm");
const addressInput = document.getElementById("addressInput");
const backBtn = document.getElementById("backBtn");
const forwardBtn = document.getElementById("forwardBtn");
const reloadBtn = document.getElementById("reloadBtn");
const homeBtn = document.getElementById("homeBtn");
const analyzeBtn = document.getElementById("analyzeBtn");
const externalBtn = document.getElementById("externalBtn");
const loadingState = document.getElementById("loadingState");
const securityState = document.getElementById("securityState");
const errorBar = document.getElementById("errorBar");

function applyTheme(theme = {}) {
  const variables = {
    background: "--browser-background",
    surface: "--browser-surface",
    panel: "--browser-panel",
    text: "--browser-text",
    muted: "--browser-muted",
    accent: "--browser-accent",
    line: "--browser-line",
    lineStrong: "--browser-line-strong",
    accentSoft: "--browser-accent-soft"
  };
  Object.entries(variables).forEach(([key, variable]) => {
    if (theme[key]) document.documentElement.style.setProperty(variable, theme[key]);
  });
  if (theme.scheme === "dark" || theme.scheme === "light") document.documentElement.style.colorScheme = theme.scheme;
}

function applyState(state = {}) {
  applyTheme(state.theme);
  if (state.url && document.activeElement !== addressInput) addressInput.value = state.url;
  backBtn.disabled = !state.canGoBack;
  forwardBtn.disabled = !state.canGoForward;
  reloadBtn.innerHTML = state.loading ? "&#x2715;" : "&#x21bb;";
  reloadBtn.title = state.loading ? "停止" : "刷新";
  loadingState.textContent = state.loading ? "加载中" : "";
  securityState.dataset.secure = String(state.url || "").startsWith("https:") ? "true" : "false";
  errorBar.hidden = !state.error;
  errorBar.textContent = state.error || "";
  if (state.title) document.title = `${state.title} - 黑球浏览器`;
}

addressForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  await api.navigate(addressInput.value);
});
backBtn.addEventListener("click", () => api.back());
forwardBtn.addEventListener("click", () => api.forward());
reloadBtn.addEventListener("click", async () => {
  const state = await api.getState();
  if (state.loading) await api.stop();
  else await api.reload();
});
homeBtn.addEventListener("click", () => api.home());
externalBtn.addEventListener("click", () => api.openExternal());
analyzeBtn.addEventListener("click", async () => {
  analyzeBtn.disabled = true;
  const previous = analyzeBtn.textContent;
  analyzeBtn.textContent = "正在提取";
  try {
    const result = await api.analyze();
    analyzeBtn.textContent = result?.success ? "已发送" : "提取失败";
  } finally {
    setTimeout(() => {
      analyzeBtn.disabled = false;
      analyzeBtn.textContent = previous;
    }, 1200);
  }
});

api.onState(applyState);
api.getState().then(applyState);
