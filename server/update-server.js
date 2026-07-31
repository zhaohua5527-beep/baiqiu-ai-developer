const fs = require("node:fs");
const path = require("node:path");
const http = require("node:http");
const crypto = require("node:crypto");

const PORT = Number(process.env.PORT || 3000);
const ROOT = __dirname;
const RELEASES_DIR = path.join(ROOT, "releases");
const DOWNLOADS_DIR = path.join(ROOT, "downloads");
const MANIFEST_PATH = path.join(ROOT, "updates.json");
const UPDATE_JSON_PATH = path.join(ROOT, "update.json");
const LATEST_JSON_PATH = path.join(ROOT, "latest.json");

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, "utf8").replace(/^\uFEFF/, "")); } catch { return fallback; }
}

function compareVersion(a, b) {
  const normalize = (value) => String(value || "0.0.0")
    .trim()
    .replace(/^v/i, "")
    .split(/[+-]/)[0]
    .split(".")
    .map((part) => {
      const match = String(part || "0").match(/^\d+/);
      return match ? Number(match[0]) : 0;
    });
  const pa = normalize(a);
  const pb = normalize(b);
  for (let i = 0; i < Math.max(pa.length, pb.length, 3); i++) {
    if ((pa[i] || 0) > (pb[i] || 0)) return 1;
    if ((pa[i] || 0) < (pb[i] || 0)) return -1;
  }
  return 0;
}

function checksum(file) {
  return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

function parseByteRange(rangeHeader, size) {
  if (!rangeHeader) return null;
  const match = String(rangeHeader).trim().match(/^bytes=(\d*)-(\d*)$/i);
  if (!match) return { unsatisfied: true };
  const startText = match[1];
  const endText = match[2];
  let start = startText === "" ? null : Number(startText);
  let end = endText === "" ? null : Number(endText);
  if ((start !== null && (!Number.isInteger(start) || start < 0)) || (end !== null && (!Number.isInteger(end) || end < 0))) {
    return { unsatisfied: true };
  }
  if (start === null && end === null) return { unsatisfied: true };
  if (start === null) {
    if (end <= 0) return { unsatisfied: true };
    start = Math.max(size - end, 0);
    end = size - 1;
  } else {
    if (start >= size) return { unsatisfied: true };
    end = end === null || end >= size ? size - 1 : end;
    if (end < start) return { unsatisfied: true };
  }
  return { start, end };
}

function sendFileWithRange(req, res, file, contentType, downloadName) {
  const stat = fs.statSync(file);
  const size = stat.size;
  const range = parseByteRange(req.headers.range, size);
  const baseHeaders = {
    "Accept-Ranges": "bytes",
    "Content-Type": contentType,
    "Content-Disposition": `attachment; filename="${downloadName}"`
  };
  if (range?.unsatisfied) {
    res.writeHead(416, { ...baseHeaders, "Content-Range": `bytes */${size}` });
    res.end();
    return;
  }
  if (range) {
    const chunkSize = range.end - range.start + 1;
    res.writeHead(206, {
      ...baseHeaders,
      "Content-Range": `bytes ${range.start}-${range.end}/${size}`,
      "Content-Length": chunkSize
    });
    if (req.method === "HEAD") {
      res.end();
      return;
    }
    fs.createReadStream(file, { start: range.start, end: range.end }).pipe(res);
    return;
  }
  res.writeHead(200, { ...baseHeaders, "Content-Length": size });
  if (req.method === "HEAD") {
    res.end();
    return;
  }
  fs.createReadStream(file).pipe(res);
}

function latestRelease(channel = "stable") {
  const manifest = readJson(MANIFEST_PATH, { channels: {} });
  const list = manifest.channels?.[channel] || manifest.channels?.stable || [];
  return [...list].sort((a, b) => compareVersion(b.version, a.version))[0] || null;
}

function publicManifest() {
  const latest = readJson(LATEST_JSON_PATH, null);
  if (!latest?.version) return null;
  const downloadUrl = String(latest.downloadUrl || "").trim();
  const sha256 = String(latest.sha256 || latest.checksum || "").trim().toLowerCase();
  const size = Number(latest.size || latest.fileSize || 0);
  if (!/^https:\/\//i.test(downloadUrl) || !/^[a-f0-9]{64}$/i.test(sha256) || !Number.isFinite(size) || size <= 0) return null;
  return {
    version: String(latest.version),
    releaseNotes: String(latest.releaseNotes || latest.updateNote || latest.notes || ""),
    downloadUrl,
    sha256,
    size,
    packageType: String(latest.packageType || "full-client")
  };
}

function sendJson(res, data, status = 200) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(data));
}

function writeJson(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(data, null, 2), "utf8");
}

function validInvite(inviteCode) {
  return Boolean(String(inviteCode || "").trim());
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }

  if (url.pathname === "/latest.json" && req.method === "GET") {
    const latest = publicManifest();
    res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate");
    if (!latest?.version) return sendJson(res, { message: "latest.json is missing or invalid" }, 500);
    return sendJson(res, latest);
  }

  if ((url.pathname === "/baiqiu-update.json" || url.pathname === "/manifest.json") && req.method === "GET") {
    const latest = publicManifest();
    if (!latest) return sendJson(res, { message: "latest.json is missing or invalid" }, 500);
    return sendJson(res, {
      name: "白球 AI",
      ...latest,
      latestVersion: latest.version,
      packageUrl: latest.downloadUrl,
      checksum: latest.sha256,
      fileSize: latest.size,
      notes: latest.releaseNotes ? [latest.releaseNotes] : []
    });
  }

  if (url.pathname === "/update.json" && req.method === "GET") {
    const latest = publicManifest();
    if (!latest) return sendJson(res, { message: "latest.json is missing or invalid" }, 500);
    return sendJson(res, {
      ...latest,
      checksum: latest.sha256,
      fileSize: latest.size,
      forceUpdate: false,
      changelog: latest.releaseNotes
    });
  }

  if (url.pathname === "/downloads/baiqiu-update.zip" && req.method === "GET") {
    const file = path.join(DOWNLOADS_DIR, "baiqiu-update.zip");
    if (!fs.existsSync(file)) return sendJson(res, { message: "更新包不存在" }, 404);
    sendFileWithRange(req, res, file, "application/zip", "baiqiu-update.zip");
    return;
  }

  const directZipMatch = url.pathname.match(/^\/baiqiu-([^/]+)\.zip$/i);
  if (directZipMatch && req.method === "GET") {
    const version = decodeURIComponent(directZipMatch[1]);
    const release = (readJson(MANIFEST_PATH, { channels: {} }).channels?.stable || [])
      .find((item) => item.version === version);
    if (!release?.file) return sendJson(res, { message: "暂无更新包" }, 404);
    const file = path.join(RELEASES_DIR, release.file);
    if (!fs.existsSync(file)) return sendJson(res, { message: "更新包不存在" }, 404);
    sendFileWithRange(req, res, file, "application/zip", `baiqiu-${release.version}.zip`);
    return;
  }

  if (url.pathname === "/api/activate" && req.method === "POST") {
    let body = "";
    req.on("data", (chunk) => { body += chunk; });
    req.on("end", () => {
      try {
        const data = JSON.parse(body || "{}");
        const file = path.join(ROOT, "data", "activations.json");
        const records = readJson(file, []);
        const existing = records.find((item) => item.machineId === data.machineId);
        if (existing) {
          Object.assign(existing, data, { status: "active", lastSeen: new Date().toISOString() });
        } else {
          records.push({ ...data, status: "active", lastSeen: new Date().toISOString() });
        }
        writeJson(file, records);
        console.log(`[激活] ${data.userName || "客户"} (${String(data.machineId || "").slice(0, 8)})`);
        sendJson(res, { ok: true });
      } catch (error) {
        sendJson(res, { ok: false, error: error.message || String(error) }, 400);
      }
    });
    return;
  }

  if (url.pathname === "/api/activations" && req.method === "GET") {
    const records = readJson(path.join(ROOT, "data", "activations.json"), []);
    return sendJson(res, {
      total: records.length,
      active: records.filter((item) => item.status === "active").length,
      records: records.slice(-100)
    });
  }

  if (url.pathname === "/api/update/check") {
    const version = url.searchParams.get("version") || "0.0.0";
    const latest = publicManifest();
    if (!latest) return sendJson(res, { hasUpdate: false, latestVersion: version, message: "latest.json is missing or invalid" }, 500);
    const hasUpdate = compareVersion(latest.version, version) > 0;
    return sendJson(res, {
      hasUpdate,
      latestVersion: latest.version,
      releaseNotes: latest.releaseNotes,
      downloadUrl: hasUpdate ? latest.downloadUrl : "",
      fileSize: latest.size,
      checksum: latest.sha256,
      packageType: latest.packageType
    });
  }

  if (url.pathname === "/api/update/download") {
    const latest = publicManifest();
    if (!latest) return sendJson(res, { message: "latest.json is missing or invalid" }, 500);
    res.writeHead(302, { Location: latest.downloadUrl, "Cache-Control": "no-store" });
    res.end();
    return;
  }

  sendJson(res, { ok: true, service: "Baiqiu update server" });
});

server.listen(PORT, () => {
  fs.mkdirSync(RELEASES_DIR, { recursive: true });
  fs.mkdirSync(DOWNLOADS_DIR, { recursive: true });
  console.log(`[更新服务器] 运行在 http://localhost:${PORT}`);
});
