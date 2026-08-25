"use strict";

const REPAIR_LEVELS = Object.freeze([
  Object.freeze({ id: "L0", name: "运行恢复", mode: "automatic", scope: "重连黑球、重建会话、恢复运行状态" }),
  Object.freeze({ id: "L1", name: "状态修复", mode: "automatic", scope: "证据对账、状态归并、幂等去重" }),
  Object.freeze({ id: "L2", name: "安全本地修复", mode: "guarded_local", scope: "renderer-v2、缓存、索引及新增工具；必须备份、验证和回滚" }),
  Object.freeze({ id: "L3", name: "核心缺陷", mode: "signed_patch_only", scope: "门禁、路由、TaskBrain、主进程和核心服务只能安装签名补丁" }),
  Object.freeze({ id: "FORBIDDEN", name: "绝对禁区", mode: "never", scope: "会员、授权、支付、试用、签名私钥和安全护栏" })
]);

function repairPolicy() {
  return {
    authority: "independent_repair_supervisor",
    levels: REPAIR_LEVELS.map((item) => ({ ...item })),
    corePatchTrust: ["embedded_public_key", "signed_manifest", "sha256", "anti_downgrade", "atomic_install", "rollback"]
  };
}

module.exports = { REPAIR_LEVELS, repairPolicy };
