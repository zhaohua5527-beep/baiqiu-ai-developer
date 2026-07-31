const fs = require("node:fs");
const CLOUD_MODEL_DEFAULTS = {
  deepseek: {
    name: "DeepSeek",
    baseURL: "https://api.deepseek.com/v1",
    model: "deepseek-chat",
    apiKeyUrl: "https://platform.deepseek.com/"
  }
};

module.exports = { CLOUD_MODEL_DEFAULTS };

