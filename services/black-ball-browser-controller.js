"use strict";

const fs = require("node:fs");
const path = require("node:path");

const HIGH_RISK_PATTERN = /(delete|remove|erase|destroy|purchase|buy now|pay|checkout|place order|submit order|confirm payment|unsubscribe|close account|删除|移除|清空|付款|支付|购买|下单|提交订单|确认订单|注销|销户|退订)/i;

function actionRisk(target = {}) {
  const inputType = String(target.inputType || "").toLowerCase();
  if (inputType === "password") return { blocked: true, reason: "密码框必须由用户本人填写" };
  const label = [target.text, target.ariaLabel, target.title, target.value, target.name, target.formAction]
    .filter(Boolean)
    .join(" ");
  if (HIGH_RISK_PATTERN.test(label)) return { confirmationRequired: true, reason: `高风险网页操作：${label.slice(0, 120)}` };
  return { confirmationRequired: false, reason: "" };
}

function targetResolverSource() {
  return `
    const isVisible = (element) => {
      if (!element || !(element instanceof Element)) return false;
      const style = getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return style.visibility !== "hidden" && style.display !== "none" && Number(style.opacity || 1) > 0 && rect.width > 0 && rect.height > 0;
    };
    const labelFor = (element) => String(
      element.innerText || element.getAttribute("aria-label") || element.getAttribute("title") ||
      element.getAttribute("placeholder") || element.value || element.name || ""
    ).replace(/\\s+/g, " ").trim();
    const candidates = () => [...document.querySelectorAll("a[href],button,input,textarea,select,[role='button'],[role='link'],[contenteditable='true'],[tabindex]")]
      .filter(isVisible);
    const locate = (target) => {
      if (target.ref) {
        const escaped = CSS.escape(String(target.ref));
        const byRef = document.querySelector('[data-baiqiu-browser-ref="' + escaped + '"]');
        if (isVisible(byRef)) return byRef;
      }
      if (target.selector) {
        try {
          const bySelector = document.querySelector(String(target.selector));
          if (isVisible(bySelector)) return bySelector;
        } catch {}
      }
      if (target.text) {
        const expected = String(target.text).replace(/\\s+/g, " ").trim().toLowerCase();
        const items = candidates();
        return items.find((item) => labelFor(item).toLowerCase() === expected)
          || items.find((item) => labelFor(item).toLowerCase().includes(expected));
      }
      return null;
    };
    const ensureRef = (element) => {
      if (!element.getAttribute("data-baiqiu-browser-ref")) {
        window.__baiqiuBrowserRefSequence = Number(window.__baiqiuBrowserRefSequence || 0) + 1;
        element.setAttribute("data-baiqiu-browser-ref", "bb-live-" + window.__baiqiuBrowserRefSequence);
      }
      return element.getAttribute("data-baiqiu-browser-ref");
    };
    const describe = (element) => {
      const rect = element.getBoundingClientRect();
      return {
        ref: ensureRef(element),
        tag: element.tagName.toLowerCase(),
        role: element.getAttribute("role") || "",
        text: labelFor(element).slice(0, 240),
        ariaLabel: element.getAttribute("aria-label") || "",
        title: element.getAttribute("title") || "",
        value: element.type === "password" ? "" : String(element.value || "").slice(0, 240),
        name: element.getAttribute("name") || "",
        inputType: String(element.getAttribute("type") || "").toLowerCase(),
        formAction: element.form?.action || "",
        disabled: Boolean(element.disabled || element.getAttribute("aria-disabled") === "true"),
        checked: typeof element.checked === "boolean" ? element.checked : undefined,
        href: element.href || "",
        rect: { x: Math.round(rect.x), y: Math.round(rect.y), width: Math.round(rect.width), height: Math.round(rect.height) }
      };
    };
  `;
}

function targetScript(target = {}) {
  const payload = JSON.stringify({ ref: target.ref || "", selector: target.selector || "", text: target.text || "" });
  return `(() => { ${targetResolverSource()} const element = locate(${payload}); return element ? describe(element) : null; })()`;
}

class BlackBallBrowserController {
  constructor(options = {}) {
    this.getWebContents = options.getWebContents;
    this.screenshotRoot = options.screenshotRoot;
    this.now = options.now || (() => Date.now());
  }

  contents() {
    const contents = this.getWebContents?.();
    if (!contents || contents.isDestroyed?.()) throw new Error("黑球浏览器尚未就绪");
    return contents;
  }

  async inspect(params = {}) {
    const maxElements = Math.max(1, Math.min(120, Number(params.maxElements) || 60));
    const includeText = params.includeText !== false;
    const script = `(() => {
      ${targetResolverSource()}
      const elements = candidates().slice(0, ${maxElements}).map(describe);
      return {
        url: location.href,
        title: document.title || location.hostname,
        viewport: { width: innerWidth, height: innerHeight, scrollX, scrollY },
        elements,
        text: ${includeText ? "String((document.querySelector('main,article,[role=main]') || document.body)?.innerText || '').replace(/\\n{3,}/g, '\\n\\n').trim().slice(0, 20000)" : "''"}
      };
    })()`;
    return this.contents().executeJavaScript(script, true);
  }

  async click(params = {}, options = {}) {
    const contents = this.contents();
    const target = await contents.executeJavaScript(targetScript(params), true);
    if (!target) return { ok: false, error: "没有找到可点击元素", target: null };
    if (target.disabled) return { ok: false, error: "目标元素当前不可用", target };
    const risk = actionRisk(target);
    if (risk.blocked) return { ok: false, blocked: true, error: risk.reason, target };
    if (risk.confirmationRequired && options.confirmed !== true) {
      return { ok: false, confirmationRequired: true, error: risk.reason, target };
    }
    const script = `(() => {
      ${targetResolverSource()}
      const element = locate(${JSON.stringify({ ref: target.ref })});
      if (!element || !isVisible(element)) return { ok: false, error: "元素在点击前已消失" };
      element.scrollIntoView({ block: "center", inline: "center", behavior: "instant" });
      element.focus({ preventScroll: true });
      element.click();
      return { ok: true, target: describe(element), url: location.href, title: document.title || location.hostname };
    })()`;
    return contents.executeJavaScript(script, true);
  }

  async type(params = {}) {
    const contents = this.contents();
    const target = await contents.executeJavaScript(targetScript(params), true);
    if (!target) return { ok: false, error: "没有找到可输入元素", target: null };
    const risk = actionRisk(target);
    if (risk.blocked) return { ok: false, blocked: true, error: risk.reason, target };
    const text = String(params.value ?? params.input ?? "").slice(0, 20000);
    const replace = params.replace !== false;
    const script = `(() => {
      ${targetResolverSource()}
      const element = locate(${JSON.stringify({ ref: target.ref })});
      if (!element || !isVisible(element)) return { ok: false, error: "元素在输入前已消失" };
      if (String(element.type || "").toLowerCase() === "password") return { ok: false, blocked: true, error: "密码框必须由用户本人填写" };
      const value = ${JSON.stringify(text)};
      element.scrollIntoView({ block: "center", inline: "center", behavior: "instant" });
      element.focus({ preventScroll: true });
      if (element.isContentEditable) {
        if (${replace}) element.textContent = value; else element.textContent += value;
      } else if ("value" in element) {
        const nextValue = ${replace} ? value : String(element.value || "") + value;
        const prototype = element instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
        const setter = Object.getOwnPropertyDescriptor(prototype, "value")?.set;
        if (setter) setter.call(element, nextValue); else element.value = nextValue;
      } else return { ok: false, error: "目标元素不支持文字输入" };
      element.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: value }));
      element.dispatchEvent(new Event("change", { bubbles: true }));
      return { ok: true, target: describe(element), url: location.href, title: document.title || location.hostname };
    })()`;
    return contents.executeJavaScript(script, true);
  }

  async scroll(params = {}) {
    const x = Math.max(-10000, Math.min(10000, Number(params.x) || 0));
    const y = Math.max(-10000, Math.min(10000, Number(params.y) || 600));
    const target = { ref: params.ref || "", selector: params.selector || "", text: params.text || "" };
    const script = `(() => {
      ${targetResolverSource()}
      const target = ${JSON.stringify(target)};
      const element = target.ref || target.selector || target.text ? locate(target) : null;
      if (element) element.scrollIntoView({ block: "center", inline: "center", behavior: "smooth" });
      else window.scrollBy({ left: ${x}, top: ${y}, behavior: "smooth" });
      return { ok: true, url: location.href, title: document.title || location.hostname, scrollX, scrollY, target: element ? describe(element) : null };
    })()`;
    return this.contents().executeJavaScript(script, true);
  }

  async wait(params = {}) {
    const timeoutMs = Math.max(0, Math.min(15000, Number(params.timeoutMs) || 5000));
    const intervalMs = 200;
    const expectedText = String(params.text || "").trim();
    const selector = String(params.selector || "").trim();
    const hidden = params.hidden === true;
    const startedAt = this.now();
    do {
      const state = await this.contents().executeJavaScript(`(() => {
        let selectorMatch = true;
        if (${JSON.stringify(selector)}) {
          try { selectorMatch = Boolean(document.querySelector(${JSON.stringify(selector)})); } catch { selectorMatch = false; }
        }
        const textMatch = ${JSON.stringify(expectedText)} ? String(document.body?.innerText || "").includes(${JSON.stringify(expectedText)}) : true;
        const matched = selectorMatch && textMatch;
        return { matched: ${hidden} ? !matched : matched, url: location.href, title: document.title || location.hostname, readyState: document.readyState };
      })()`, true);
      if (state.matched) return { ok: true, ...state, waitedMs: this.now() - startedAt };
      if (this.now() - startedAt >= timeoutMs) return { ok: false, error: "等待网页状态超时", ...state, waitedMs: this.now() - startedAt };
      await new Promise((resolve) => setTimeout(resolve, intervalMs));
    } while (true);
  }

  async screenshot(params = {}) {
    const contents = this.contents();
    const image = await contents.capturePage();
    if (!image || image.isEmpty?.()) return { ok: false, error: "浏览器截图为空" };
    const root = path.resolve(this.screenshotRoot());
    fs.mkdirSync(root, { recursive: true });
    const file = path.join(root, `browser-${this.now()}.png`);
    fs.writeFileSync(file, image.toPNG());
    const size = image.getSize?.() || {};
    return { ok: true, path: file, sourcePath: file, width: size.width || 0, height: size.height || 0, url: contents.getURL?.() || "" };
  }
}

module.exports = { BlackBallBrowserController, actionRisk };
