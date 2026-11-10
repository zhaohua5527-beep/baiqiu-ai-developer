const { ProductExecutionServices } = require("../product-execution-services");
const { createHermesStrategy } = require("./hermes-strategy");

function buildProductExecutionStrategies(input, deps) {
  const services = deps instanceof ProductExecutionServices ? deps : new ProductExecutionServices(deps);
  return [createHermesStrategy(input, services)];
}

module.exports = { buildProductExecutionStrategies };
