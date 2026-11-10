"use strict";

const DEVELOPMENT_CAPABILITIES = Object.freeze([
  Object.freeze({
    capabilityId: "development_analysis",
    name: "Development analysis",
    description: "Analyze a development goal and establish a bounded change strategy.",
    allowedActions: Object.freeze(["analyze", "scope", "identify_risk"]),
    requiredPermission: "allowTools",
    tools: Object.freeze([]),
    status: "declared"
  }),
  Object.freeze({
    capabilityId: "code_search",
    name: "Code search",
    description: "Locate relevant source files and symbols without changing files.",
    allowedActions: Object.freeze(["analyze", "search", "locate"]),
    requiredPermission: "allowTools",
    tools: Object.freeze([]),
    status: "declared"
  }),
  Object.freeze({
    capabilityId: "code_read",
    name: "Code read",
    description: "Read relevant source context before a change is prepared.",
    allowedActions: Object.freeze(["inspect", "read", "compare"]),
    requiredPermission: "allowTools",
    tools: Object.freeze([]),
    status: "declared"
  }),
  Object.freeze({
    capabilityId: "code_modify",
    name: "Code modify",
    description: "Modify an approved project source file through the guarded file-write path.",
    allowedActions: Object.freeze(["modify", "edit"]),
    requiredPermission: "allowFileWrite",
    tools: Object.freeze([]),
    status: "declared"
  }),
  Object.freeze({
    capabilityId: "patch_apply",
    name: "Patch apply",
    description: "Apply a prepared source patch through the guarded file-write path.",
    allowedActions: Object.freeze(["patch", "apply_patch"]),
    requiredPermission: "allowFileWrite",
    tools: Object.freeze([]),
    status: "declared"
  }),
  Object.freeze({
    capabilityId: "test_execute",
    name: "Test execute",
    description: "Run focused automated tests after a source change.",
    allowedActions: Object.freeze(["test", "execute_test"]),
    requiredPermission: "allowTools",
    tools: Object.freeze([]),
    status: "declared"
  }),
  Object.freeze({
    capabilityId: "build_verify",
    name: "Build verify",
    description: "Run build or syntax verification without granting new permissions.",
    allowedActions: Object.freeze(["verify", "build", "syntax_check"]),
    requiredPermission: "allowTools",
    tools: Object.freeze([]),
    status: "declared"
  })
]);

function cleanId(value = "") {
  return String(value || "").trim().toLowerCase();
}

function declaredToolCapabilities(tool = {}) {
  return Array.isArray(tool.capabilities)
    ? tool.capabilities.map(cleanId).filter(Boolean)
    : [];
}

class DevelopmentCapabilityRegistry {
  constructor({ toolProvider = () => [] } = {}) {
    this.toolProvider = typeof toolProvider === "function" ? toolProvider : () => [];
    this.definitions = new Map(DEVELOPMENT_CAPABILITIES.map((item) => [item.capabilityId, item]));
  }

  get(capabilityId = "", { permissions = {}, tools = null } = {}) {
    const definition = this.definitions.get(cleanId(capabilityId));
    if (!definition) return null;
    const availableTools = Array.isArray(tools) ? tools : this.toolProvider();
    const matches = (Array.isArray(availableTools) ? availableTools : [])
      .filter((tool) => declaredToolCapabilities(tool).includes(definition.capabilityId))
      .map((tool) => String(tool.id || "").trim())
      .filter(Boolean);
    const permissionGranted = permissions?.[definition.requiredPermission] === true;
    const status = !permissionGranted ? "permission_denied" : (matches.length ? "available" : "missing");
    return Object.freeze({
      ...definition,
      allowedActions: Object.freeze([...definition.allowedActions]),
      tools: Object.freeze(matches),
      status,
      permissionGranted,
      reason: status === "permission_denied"
        ? `Permission denied: ${definition.requiredPermission}`
        : status === "missing"
          ? `Missing capability: ${definition.capabilityId}`
          : ""
    });
  }

  list(options = {}) {
    return [...this.definitions.keys()].map((id) => this.get(id, options));
  }

  resolveRequired(capabilityIds = [], options = {}) {
    const capabilities = capabilityIds.map((id) => this.get(id, options)).filter(Boolean);
    return Object.freeze({
      capabilities: Object.freeze(capabilities),
      missing: Object.freeze(capabilities.filter((item) => item.status !== "available").map((item) => item.capabilityId)),
      available: capabilities.every((item) => item.status === "available")
    });
  }
}

module.exports = {
  DEVELOPMENT_CAPABILITIES,
  DevelopmentCapabilityRegistry,
  declaredToolCapabilities
};
