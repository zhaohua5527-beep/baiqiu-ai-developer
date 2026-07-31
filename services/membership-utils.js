(function exposeMembershipUtils(root) {
  function membershipDurationDays(plan) {
    if (plan === "yearly") return 372;
    if (plan === "six_months") return 186;
    return 31;
  }

  function membershipExpiresAt(plan, now = Date.now()) {
    return new Date(Number(now) + membershipDurationDays(plan) * 86400 * 1000).toISOString();
  }

  function formatMembershipCountdown(status, now = Date.now()) {
    const expiresAtMs = Date.parse(status?.expiresAt || "");
    const fallback = Number(status?.membershipRemainingSeconds || 0);
    const total = Number.isFinite(expiresAtMs)
      ? Math.max(0, Math.floor((expiresAtMs - Number(now)) / 1000))
      : Math.max(0, Math.floor(fallback));
    const days = Math.floor(total / 86400);
    const hours = Math.floor((total % 86400) / 3600);
    const minutes = Math.floor((total % 3600) / 60);
    const seconds = total % 60;
    return `${days}天 ${String(hours).padStart(2, "0")}时 ${String(minutes).padStart(2, "0")}分 ${String(seconds).padStart(2, "0")}秒`;
  }

  const api = { membershipDurationDays, membershipExpiresAt, formatMembershipCountdown };
  root.BaiqiuMembershipUtils = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
