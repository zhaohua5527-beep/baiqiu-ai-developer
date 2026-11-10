function createHermesStrategy(input, services) {
  return {
    name: "hermes_strategy",
    async canHandle() {
      return services.canUseHermes(input);
    },
    async execute() {
      return services.executeHermes(input);
    }
  };
}

module.exports = { createHermesStrategy };
