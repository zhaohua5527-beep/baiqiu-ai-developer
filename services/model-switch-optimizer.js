"use strict";

/**
 * ModelSwitchOptimizer - Phase 3 换骨架计划
 * 
 * 功能：
 * - Provider 健康检查（周期性 ping）
 * - 性能追踪（响应时间、成功率）
 * - 智能自动回退（模型失败时自动切换备用）
 * - 模型能力标签（tools/vision/reasoning）
 * - 快速切换建议
 */

const { normalizeProvider, listProviderModels, probeProvider } = require("./model-adapter");
const { isConfiguredProvider, isLocalProvider, candidateProviders } = require("./model-route-policy");

// 模型能力定义
const MODEL_CAPABILITIES = {
  // DeepSeek
  "deepseek-chat": { tools: true, vision: false, reasoning: true, contextWindow: 64000 },
  "deepseek-reasoner": { tools: false, vision: false, reasoning: true, contextWindow: 64000 },
  // OpenAI
  "gpt-4.1": { tools: true, vision: true, reasoning: true, contextWindow: 128000 },
  "gpt-4.1-mini": { tools: true, vision: true, reasoning: false, contextWindow: 128000 },
  "gpt-4o": { tools: true, vision: true, reasoning: false, contextWindow: 128000 },
  // Claude
  "claude-3-5-sonnet-latest": { tools: true, vision: true, reasoning: true, contextWindow: 200000 },
  "claude-3-5-haiku-latest": { tools: true, vision: true, reasoning: false, contextWindow: 200000 },
  // Kimi
  "moonshot-v1-128k": { tools: true, vision: false, reasoning: false, contextWindow: 128000 },
  // Qwen
  "qwen-plus": { tools: true, vision: true, reasoning: true, contextWindow: 131072 },
  "qwen-max": { tools: true, vision: true, reasoning: true, contextWindow: 32768 },
  // Baidu
  "ernie-4.0-turbo-8k": { tools: true, vision: false, reasoning: false, contextWindow: 8192 },
  // Zhipu
  "glm-4-plus": { tools: true, vision: true, reasoning: false, contextWindow: 128000 }
};

class ModelSwitchOptimizer {
  constructor() {
    // 健康状态缓存: { providerId: { healthy, lastCheck, latency, errorCount } }
    this.healthStatus = new Map();
    // 性能指标: { providerId: { totalCalls, successCount, avgLatency, lastCallAt } }
    this.performanceMetrics = new Map();
    // 健康检查定时器
    this.healthCheckInterval = null;
    // 回退历史: 记录最近的回退事件
    this.fallbackHistory = [];
  }

  /**
   * 获取模型能力
   */
  getModelCapabilities(modelName) {
    const key = String(modelName || "").toLowerCase().trim();
    // 精确匹配
    if (MODEL_CAPABILITIES[key]) return MODEL_CAPABILITIES[key];
    // 模糊匹配
    for (const [model, caps] of Object.entries(MODEL_CAPABILITIES)) {
      if (key.includes(model) || model.includes(key)) return caps;
    }
    // 默认能力
    return { tools: true, vision: false, reasoning: false, contextWindow: 32000 };
  }

  /**
   * 检查单个 Provider 健康状态
   */
  async checkProviderHealth(providerId, provider, options = {}) {
    const { timeout = 8000 } = options;
    const normalized = normalizeProvider(providerId, provider);
    
    if (!normalized.baseURL) {
      return { healthy: false, latency: -1, error: "缺少 Base URL", checkedAt: Date.now() };
    }

    if (normalized.requiresApiKey && !normalized.apiKey) {
      return { healthy: false, latency: -1, error: "缺少 API Key", checkedAt: Date.now() };
    }

    const startTime = Date.now();
    
    try {
      let evidence = "model_catalog";
      let statusCode = 200;
      try {
        await listProviderModels({
          providerId,
          provider: normalized,
          signal: AbortSignal.timeout(timeout)
        });
      } catch {
        evidence = "inference_probe";
        const probe = await probeProvider({
          providerId,
          provider: normalized,
          signal: AbortSignal.timeout(timeout)
        });
        statusCode = probe.statusCode || 200;
      }
      const result = {
        healthy: true,
        latency: Date.now() - startTime,
        error: null,
        checkedAt: Date.now(),
        statusCode,
        evidence
      };
      this.healthStatus.set(providerId, result);
      return result;
    } catch (error) {
      const latency = Date.now() - startTime;
      const result = { 
        healthy: false, 
        latency, 
        error: error.name === "AbortError" ? "超时" : error.message,
        checkedAt: Date.now()
      };
      this.healthStatus.set(providerId, result);
      return result;
    }
  }

  /**
   * 批量健康检查所有已配置的 Provider
   */
  async checkAllProviders(settings = {}, options = {}) {
    const providers = settings.providers || {};
    const results = {};
    const minimumAgeMs = Math.max(0, Number(options.minimumAgeMs) || 0);
    
    const checks = Object.entries(providers)
      .filter(([id, provider]) => isConfiguredProvider(id, provider))
      .map(async ([id, provider]) => {
        const cached = this.healthStatus.get(id);
        if (cached && minimumAgeMs > 0 && Date.now() - cached.checkedAt < minimumAgeMs) {
          results[id] = cached;
          return;
        }
        const result = await this.checkProviderHealth(id, provider);
        results[id] = result;
      });
    
    await Promise.allSettled(checks);
    return results;
  }

  /**
   * 启动周期性健康检查（每 60 秒）
   */
  startPeriodicHealthCheck(settings, intervalMs = 60000) {
    if (this.healthCheckInterval) return;
    
    this.healthCheckInterval = setInterval(async () => {
      try {
        await this.checkAllProviders(settings, { minimumAgeMs: 5 * 60 * 1000 });
      } catch (e) {
        // 忽略
      }
    }, intervalMs);
    
    // 首次立即检查
    this.checkAllProviders(settings, { minimumAgeMs: 5 * 60 * 1000 }).catch(() => null);
  }

  /**
   * 停止周期性健康检查
   */
  stopPeriodicHealthCheck() {
    if (this.healthCheckInterval) {
      clearInterval(this.healthCheckInterval);
      this.healthCheckInterval = null;
    }
  }

  /**
   * 记录一次模型调用性能数据
   */
  recordCall(providerId, { success, latencyMs, error }) {
    let metrics = this.performanceMetrics.get(providerId);
    if (!metrics) {
      metrics = { totalCalls: 0, successCount: 0, failCount: 0, totalLatency: 0, lastCallAt: 0 };
      this.performanceMetrics.set(providerId, metrics);
    }
    
    metrics.totalCalls++;
    metrics.lastCallAt = Date.now();
    if (success) {
      metrics.successCount++;
      metrics.totalLatency += latencyMs || 0;
    } else {
      metrics.failCount++;
    }
  }

  /**
   * 获取 Provider 性能评分 (0-100)
   */
  getPerformanceScore(providerId) {
    const metrics = this.performanceMetrics.get(providerId);
    if (!metrics || metrics.totalCalls === 0) return 50; // 无数据默认 50
    
    const successRate = metrics.successCount / metrics.totalCalls;
    const avgLatency = metrics.successCount > 0 ? metrics.totalLatency / metrics.successCount : 10000;
    
    // 成功率权重 70%，速度权重 30%
    const successScore = successRate * 100;
    const speedScore = Math.max(0, 100 - (avgLatency / 100)); // 10s 以上得 0 分
    
    return Math.round(successScore * 0.7 + speedScore * 0.3);
  }

  /**
   * 智能选择回退 Provider
   * @param {Object} settings - 当前设置
   * @param {string} failedProviderId - 失败的 Provider ID
   * @param {Object} constraints - 约束条件
   * @returns {{ providerId: string, model: string, reason: string } | null}
   */
  selectFallback(settings = {}, failedProviderId = "", constraints = {}) {
    const candidates = candidateProviders(settings);
    
    for (const { id, provider } of candidates) {
      // 跳过失败的 provider
      if (id === failedProviderId) continue;
      
      // 必须已配置
      if (!isConfiguredProvider(id, provider)) continue;
      
      // 检查健康状态
      const health = this.healthStatus.get(id);
      if (health && health.healthy === false && Date.now() - health.checkedAt < 120000) {
        continue; // 最近 2 分钟内不健康，跳过
      }
      
      // 检查约束
      if (constraints.requireTools) {
        const caps = this.getModelCapabilities(provider.model);
        if (!caps.tools) continue;
      }
      
      if (constraints.requireVision) {
        const caps = this.getModelCapabilities(provider.model);
        if (!caps.vision) continue;
      }
      
      if (constraints.disallowLocal && isLocalProvider(id, provider)) continue;
      
      const normalized = normalizeProvider(id, provider);
      const reason = `从 ${failedProviderId} 回退到 ${id}`;
      
      // 记录回退事件
      this.fallbackHistory.push({
        from: failedProviderId,
        to: id,
        reason,
        timestamp: Date.now()
      });
      
      // 只保留最近 50 条记录
      if (this.fallbackHistory.length > 50) {
        this.fallbackHistory = this.fallbackHistory.slice(-50);
      }
      
      return { providerId: id, model: normalized.model, reason };
    }
    
    return null; // 没有可用的回退
  }

  /**
   * 获取所有 Provider 的综合状态报告
   */
  getStatusReport(settings = {}) {
    const providers = settings.providers || {};
    const report = [];
    
    for (const [id, provider] of Object.entries(providers)) {
      const configured = isConfiguredProvider(id, provider);
      const health = this.healthStatus.get(id) || { healthy: null, latency: -1, error: null, checkedAt: 0 };
      const score = this.getPerformanceScore(id);
      const caps = this.getModelCapabilities(provider.model);
      const isDefault = settings.defaultProvider === id;
      const metrics = this.performanceMetrics.get(id);
      
      report.push({
        id,
        name: provider.name || id,
        model: provider.model || "",
        isDefault,
        configured,
        healthy: health.healthy,
        latency: health.latency,
        lastError: health.error,
        lastChecked: health.checkedAt,
        performanceScore: score,
        successRate: metrics?.totalCalls ? metrics.successCount / metrics.totalCalls : null,
        capabilities: caps,
        isLocal: isLocalProvider(id, provider)
      });
    }
    
    // 按评分排序，默认 Provider 优先
    report.sort((a, b) => {
      if (a.isDefault !== b.isDefault) return a.isDefault ? -1 : 1;
      return b.performanceScore - a.performanceScore;
    });
    
    return report;
  }

  /**
   * 获取最近的回退历史
   */
  getFallbackHistory(limit = 10) {
    return this.fallbackHistory.slice(-limit).reverse();
  }

  /**
   * 清理过期数据
   */
  cleanup() {
    this.stopPeriodicHealthCheck();
    this.healthStatus.clear();
    this.performanceMetrics.clear();
    this.fallbackHistory = [];
  }

  /**
   * 智能推荐最佳模型
   * @param {Object} settings - 用户设置
   * @param {string} taskType - 任务类型: coding/writing/analysis/vision/conversation
   * @returns {Object} 推荐结果
   */
  recommendModel(settings, taskType = 'conversation') {
    const providers = Object.entries(settings.providers || {});
    if (!providers.length) return { recommended: null, reason: '暂无已配置模型' };

    const TASK_REQUIREMENTS = {
      coding: { tools: 3, reasoning: 2, vision: 0, contextWindow: 64000, speedWeight: 0.3 },
      writing: { tools: 0, reasoning: 1, vision: 0, contextWindow: 128000, speedWeight: 0.5 },
      analysis: { tools: 1, reasoning: 3, vision: 0, contextWindow: 128000, speedWeight: 0.2 },
      vision: { tools: 1, reasoning: 1, vision: 3, contextWindow: 32000, speedWeight: 0.4 },
      conversation: { tools: 0, reasoning: 1, vision: 0, contextWindow: 32000, speedWeight: 0.6 }
    };
    const req = TASK_REQUIREMENTS[taskType] || TASK_REQUIREMENTS.conversation;

    const candidates = [];
    for (const [key, provider] of providers) {
      if (provider.enabled === false) continue;
      const model = provider.model || '';
      const caps = this.getModelCapabilities(model);
      const perf = this.getPerformanceScore(key);
      let score = 0;
      if (req.tools > 0 && caps.tools) score += req.tools * 10;
      if (req.reasoning > 0 && caps.reasoning) score += req.reasoning * 10;
      if (req.vision > 0 && caps.vision) score += req.vision * 10;
      if (caps.contextWindow >= req.contextWindow) score += 15;
      else score += Math.round((caps.contextWindow / req.contextWindow) * 10);
      score += Math.round(perf.score * req.speedWeight);
      const health = this.healthStatus.get(key);
      if (health && health.healthy) score += 5;
      if (settings.defaultProvider === key) score += 3;
      candidates.push({
        providerId: key,
        name: provider.name || key,
        model: model,
        score,
        perfScore: perf.score,
        caps,
        healthy: health ? health.healthy : null
      });
    }

    if (!candidates.length) return { recommended: null, reason: '无可用模型' };
    candidates.sort((a, b) => b.score - a.score);
    const top = candidates[0];
    const reasons = [];
    if (taskType === 'coding' && top.caps.tools) reasons.push('支持工具调用');
    if (taskType === 'coding' && top.caps.reasoning) reasons.push('具备推理能力');
    if (taskType === 'vision' && top.caps.vision) reasons.push('支持视觉理解');
    if (taskType === 'writing' && top.caps.contextWindow >= 128000) reasons.push('超大上下文窗口');
    if (taskType === 'analysis' && top.caps.reasoning) reasons.push('强推理能力');
    if (top.perfScore >= 70) reasons.push(`性能评分 ${top.perfScore}`);
    if (top.healthy) reasons.push('连接健康');
    return {
      recommended: top,
      alternatives: candidates.slice(1, 3),
      reason: reasons.join('，') || '综合评分最高',
      taskType
    };
  }

  /**
   * 根据消息内容自动检测任务类型
   */
  detectTaskType(message) {
    if (!message || typeof message !== 'string') return 'conversation';
    const text = message.toLowerCase();
    const codeSignals = ['function', 'class', 'import', 'def ', 'const ', 'let ', 'var ', '```', 'bug', 'error', '代码', '编程', '修复', '开发', '函数', '接口'];
    const visionSignals = ['图片', '截图', '照片', '看看', '识别图', 'image', 'photo', 'screenshot'];
    const analysisSignals = ['分析', '对比', '评估', '优化', '策略', '方案', 'analyze', 'compare', 'evaluate'];
    const writingSignals = ['写文章', '撰写', '文案', '报告', '文档', '翻译', 'write', 'article', 'essay', 'translate'];
    if (codeSignals.some(s => text.includes(s))) return 'coding';
    if (visionSignals.some(s => text.includes(s))) return 'vision';
    if (analysisSignals.some(s => text.includes(s))) return 'analysis';
    if (writingSignals.some(s => text.includes(s))) return 'writing';
    return 'conversation';
  }
}

module.exports = { ModelSwitchOptimizer, MODEL_CAPABILITIES };
