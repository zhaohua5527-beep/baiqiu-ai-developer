"use strict";

const crypto = require("node:crypto");
const test = require("node:test");
const assert = require("node:assert/strict");

const {
  checkOnlineUpdate,
  downloadUrlReachable,
  signOnlineManifest,
  verifyOnlineManifest
} = require("../services/online-update-checker");

const pair = crypto.generateKeyPairSync("ed25519");
const privateKey = pair.privateKey.export({ type: "pkcs8", format: "pem" });
const publicKey = pair.publicKey.export({ type: "spki", format: "pem" });

function signedManifest(overrides = {}) {
  return signOnlineManifest({
    schemaVersion: 1,
    manifestType: "baiqiu-online-update",
    version: "3.0.8",
    downloadUrl: "http://47.108.191.67/baiqiu-3.0.8.zip",
    sha256: "a".repeat(64),
    size: 1024,
    packageType: "full-client",
    forceUpdate: false,
    ...overrides
  }, privateKey);
}

test("signed reachable update is accepted before URL probing", async () => {
  let headCalled = false;
  const manifest = signedManifest();
  const info = await checkOnlineUpdate({
    manifestUrl: "http://47.108.191.67/update.json",
    currentVersion: "3.0.7",
    source: "test",
    publicKey,
    fetchImpl: async (url) => {
      if (url.endsWith("update.json")) return { ok: true, json: async () => manifest };
      headCalled = true;
      return { ok: true, status: 200 };
    }
  });
  assert.equal(info.hasUpdate, true);
  assert.equal(info.signatureVerified, true);
  assert.equal(info.forceUpdate, false);
  assert.ok(headCalled);
});

test("unsigned and tampered manifests are rejected before package probing", async () => {
  let headCalled = false;
  const unsigned = { ...signedManifest() };
  delete unsigned.signature;
  await assert.rejects(() => checkOnlineUpdate({
    manifestUrl: "http://47.108.191.67/update.json",
    currentVersion: "3.0.7",
    publicKey,
    fetchImpl: async () => ({ ok: true, json: async () => unsigned })
  }), /unsigned/i);

  const tampered = signedManifest();
  tampered.forceUpdate = true;
  assert.throws(() => verifyOnlineManifest(tampered, { publicKey, currentVersion: "3.0.7" }), /signature/i);
  assert.equal(headCalled, false);
});

test("signed downgrade is blocked and signed same-version manifest is harmless", () => {
  assert.throws(() => verifyOnlineManifest(signedManifest({ version: "3.0.6" }), {
    publicKey,
    currentVersion: "3.0.7"
  }), /downgrade/i);
  assert.doesNotThrow(() => verifyOnlineManifest(signedManifest({
    version: "3.0.7",
    downloadUrl: "",
    sha256: ""
  }), { publicKey, currentVersion: "3.0.7" }));
});

test("reachable check blocks a signed update whose package URL is unavailable", async () => {
  const manifest = signedManifest();
  const info = await checkOnlineUpdate({
    manifestUrl: "http://47.108.191.67/update.json",
    currentVersion: "3.0.7",
    publicKey,
    fetchImpl: async (url) => url.endsWith("update.json")
      ? { ok: true, json: async () => manifest }
      : { ok: false, status: 404 }
  });
  assert.equal(info.hasUpdate, false);
  assert.equal(info.updateBlocked, true);
});

test("downloadUrlReachable returns false for bad URLs", async () => {
  assert.equal(await downloadUrlReachable(""), false);
  assert.equal(await downloadUrlReachable("not-a-url"), false);
});
