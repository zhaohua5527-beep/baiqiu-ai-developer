const fs = require("node:fs");
const path = require("node:path");

// 工作区根：默认白球工作区；实际由配置的保存位置决定（runtime 注入）
const WORKSPACE_ROOT = path.join("D:\\BaiQiuAI", "data", "workspace");

function cleanName(value = "") {
  return String(value || "新建文件夹")
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, "")
    .replace(/\s+/g, "")
    .slice(0, 80) || "新建文件夹";
}

function pathInside(target, root) {
  const relative = path.relative(path.resolve(root), path.resolve(target));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function permissionDenied(target) {
  const error = new Error(`路径不在允许的工作区内：${target}`);
  error.code = "PERMISSION_DENIED";
  return error;
}

function resolveFolder(params = {}) {
  const name = cleanName(params.name || params.folderName || "白球文件夹");
  const rawPath = String(params.path || "").trim();
  const root = WORKSPACE_ROOT;
  const desktop = path.join(process.env.USERPROFILE || root, "Desktop");
  fs.mkdirSync(root, { recursive: true });
  if (!rawPath) return path.join(root, name);
  if (/^desktop[\\/]/i.test(rawPath)) {
    // desktop 前缀也必须解析后校验，`desktop\..\..\` 同样能逃逸到桌面外
    const resolved = path.resolve(desktop, rawPath.replace(/^desktop[\\/]/i, ""));
    if (!pathInside(resolved, desktop)) throw permissionDenied(resolved);
    return resolved;
  }
  if (path.isAbsolute(rawPath)) {
    // 绝对路径必须落在允许根内（桌面/工作区），否则拒绝——防止任意建目录
    const resolved = path.resolve(rawPath);
    const allowed = [root, desktop].filter(Boolean);
    if (!allowed.some((base) => pathInside(resolved, base))) throw permissionDenied(resolved);
    return resolved;
  }
  // 相对路径同样要归一化后校验：path.resolve 折叠 `..`，杜绝 `../../Windows` 逃逸
  const resolved = path.resolve(root, rawPath);
  if (!pathInside(resolved, root)) throw permissionDenied(resolved);
  return resolved;
}

function createTools() {
  return [
    {
      id: "create_folder",
      name: "创建文件夹",
      description: "在白球允许的工作区内真实创建文件夹，并返回目录路径。",
      category: "file",
      supportedIntent: ["file.create", "system.open"],
      riskLevel: "low",
      requirePermission: false,
      parameters: {
        type: "object",
        properties: {
          path: { type: "string" },
          name: { type: "string" }
        }
      },
      permission: { level: "filesystem.write", scope: "app.desktop.saveLocation" },
      async execute(params = {}, context = {}) {
        // 路径校验优先用 runtime 注入的 safeActionPath（与 write_xlsx 等一致，
        // 享受 fullLocalAccess 放行语义），否则回退到本地"工作区+桌面"安全默认。
        const runtime = context.runtime || {};
        let folder;
        if (typeof runtime.safeActionPath === "function" && params.path) {
          folder = runtime.safeActionPath(String(params.path || ""), {});
        } else {
          folder = resolveFolder(params);
        }
        fs.mkdirSync(folder, { recursive: true });
        const stat = fs.statSync(folder);
        return {
          success: stat.isDirectory(),
          result: {
            success: stat.isDirectory(),
            path: folder,
            folder,
            created: true
          },
          error: null,
          evidence: [{ type: "folder", tool: "create_folder", path: folder }]
        };
      }
    }
  ];
}

module.exports = { createTools, resolveFolder };
