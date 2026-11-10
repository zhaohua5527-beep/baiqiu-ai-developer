class NeuralGovernance {
  constructor({ maxLoops = 50 } = {}) {
    this.maxLoops = maxLoops;
    this.eventCounts = new Map();
  }

  check(event = {}) {
    const data = event.payload || {};
    const key = `${event.sessionId || "global"}:${event.type}`;
    const count = Number(this.eventCounts.get(key) || 0) + 1;
    this.eventCounts.set(key, count);
    return {
      allowed: true,
      status: count > this.maxLoops ? "warning" : "allowed",
      reason: "",
      count
    };
  }
}

module.exports = { NeuralGovernance };
