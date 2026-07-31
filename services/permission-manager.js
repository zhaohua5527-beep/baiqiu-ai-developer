class PermissionManager {
  constructor(options = {}) {
    this.mainWindow = options.mainWindow || null;
    this.ownerDevice = options.ownerDevice || false;
    this.advancedMode = options.advancedMode || false;
    this.isUnlocked = options.isUnlocked || false;
    this.accessMode = options.accessMode || "full";
    this.permissionModes = options.permissionModes || {};
    this.trustedTools = new Set(options.trustedTools || []);
    this.saveTrustedTools = typeof options.saveTrustedTools === "function" ? options.saveTrustedTools : null;
    this.savePermissionMode = typeof options.savePermissionMode === "function" ? options.savePermissionMode : null;
  }

  check(tool, context = {}) {
    const required = String(tool?.permission?.level || tool?.permission || "read").toLowerCase();
    const scope = this.scopeFor(tool);
    const mode = this.modeFor(tool);
    const current = required === "admin" ? "admin" : required === "write" ? "write" : "read";

    const internalSkillVerification = context.skillVerification === true
      && context.globalSkillPool === true
      && /^skill_[a-z0-9_]+$/i.test(String(tool?.id || ""));
    if (internalSkillVerification) {
      return {
        allowed: true,
        required,
        current: "internal_verification",
        trusted: false,
        scope,
        mode: "verify",
        message: ""
      };
    }

    if (tool?.id === "update_profile" || tool?.id === "get_profile") {
      return {
        allowed: true,
        required,
        current: "local_profile",
        trusted: true,
        scope,
        mode: "allow_always",
        message: ""
      };
    }

    return {
      allowed: true,
      required,
      current,
      trusted: true,
      scope,
      mode,
      message: ""
    };
  }

  requiresConfirmation(tool) {
    return false;
  }

  trustTool(toolId) {
    const id = String(toolId || "").trim();
    if (!id) return false;
    this.trustedTools.add(id);
    this._persistTrustedTools();
    return true;
  }

  revokeTrust(toolId) {
    const id = String(toolId || "").trim();
    if (!id) return false;
    const removed = this.trustedTools.delete(id);
    if (removed) this._persistTrustedTools();
    return removed;
  }

  isTrusted(toolId) {
    return this.trustedTools.has(String(toolId || "").trim());
  }

  scopeFor(tool) {
    const raw = String(tool?.permissionScope || tool?.permission?.scope || tool?.scope || "").toLowerCase();
    const id = String(tool?.id || "").toLowerCase();
    const level = String(tool?.permission?.level || tool?.permission || "").toLowerCase();
    if (raw.includes("network") || id.includes("web") || id.includes("search")) return "network";
    if (raw.includes("file") || raw.includes("desktop") || raw.includes("filesystem") || level.includes("write") || level.includes("move") || level.includes("recycle")) return "file";
    if (level.includes("admin") || level.includes("execute") || id.includes("command") || id.includes("shell")) return "system";
    return "tool";
  }

  modeFor(tool) {
    const scope = this.scopeFor(tool);
    const toolMode = this.permissionModes?.[tool?.id]?.mode;
    const scopeMode = this.permissionModes?.[scope]?.mode;
    return toolMode || scopeMode || "ask";
  }

  rememberMode(scope, mode) {
    const normalizedScope = String(scope || "tool").trim() || "tool";
    const normalizedMode = ["ask", "allow_once", "allow_always", "deny"].includes(mode) ? mode : "ask";
    this.permissionModes = {
      ...(this.permissionModes || {}),
      [normalizedScope]: { mode: normalizedMode, scope: normalizedScope }
    };
    if (this.savePermissionMode) this.savePermissionMode(normalizedScope, normalizedMode);
  }

  async requestConfirmation(tool, params, context) {
    return { confirmed: true, remembered: this.isTrusted(tool?.id), pending: false, tool, params, context };
  }

  _persistTrustedTools() {
    if (this.saveTrustedTools) this.saveTrustedTools([...this.trustedTools]);
  }

  updateState(options = {}) {
    if (options.ownerDevice !== undefined) this.ownerDevice = options.ownerDevice;
    if (options.advancedMode !== undefined) this.advancedMode = options.advancedMode;
    if (options.isUnlocked !== undefined) this.isUnlocked = options.isUnlocked;
    if (options.mainWindow !== undefined) this.mainWindow = options.mainWindow;
    if (options.accessMode !== undefined) this.accessMode = options.accessMode || "full";
    if (options.permissionModes !== undefined) this.permissionModes = options.permissionModes || {};
    if (options.trustedTools !== undefined) this.trustedTools = new Set(options.trustedTools || []);
    if (typeof options.saveTrustedTools === "function") this.saveTrustedTools = options.saveTrustedTools;
    if (typeof options.savePermissionMode === "function") this.savePermissionMode = options.savePermissionMode;
  }
}

module.exports = PermissionManager;
