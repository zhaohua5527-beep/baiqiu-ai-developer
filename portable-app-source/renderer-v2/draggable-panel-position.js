(function exposeDraggablePanelPosition(root, factory) {
  const api = factory();
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  if (root) root.BaiqiuDraggablePanelPosition = api;
})(typeof window !== "undefined" ? window : globalThis, () => {
  function clamp(value, minimum, maximum) {
    return Math.min(maximum, Math.max(minimum, Number(value) || 0));
  }

  function normalizePosition(value = {}) {
    return {
      xRatio: clamp(value?.xRatio ?? 1, 0, 1),
      yRatio: clamp(value?.yRatio ?? 1, 0, 1)
    };
  }

  function panelMetrics(options = {}) {
    const containerWidth = Math.max(1, Number(options.containerWidth) || 1);
    const containerHeight = Math.max(1, Number(options.containerHeight) || 1);
    const elementWidth = Math.max(1, Number(options.elementWidth) || 1);
    const elementHeight = Math.max(1, Number(options.elementHeight) || 1);
    const leftInset = clamp(options.leftInset ?? 8, 0, containerWidth);
    const rightInset = clamp(options.rightInset ?? 18, 0, containerWidth);
    const topInset = clamp(options.topInset ?? 8, 0, containerHeight);
    const bottomInset = clamp(options.bottomInset ?? 0, 0, containerHeight);
    const maxLeft = Math.max(leftInset, containerWidth - elementWidth - rightInset);
    const maxTop = Math.max(topInset, containerHeight - elementHeight - bottomInset);
    return {
      leftInset,
      topInset,
      maxLeft,
      maxTop,
      xTravel: Math.max(0, maxLeft - leftInset),
      yTravel: Math.max(0, maxTop - topInset)
    };
  }

  function calculatePosition(options = {}) {
    const position = normalizePosition(options);
    const metrics = panelMetrics(options);
    return {
      ...position,
      left: Math.round(metrics.leftInset + metrics.xTravel * position.xRatio),
      top: Math.round(metrics.topInset + metrics.yTravel * position.yRatio)
    };
  }

  function positionFromCoordinates(options = {}) {
    const metrics = panelMetrics(options);
    const left = clamp(options.left, metrics.leftInset, metrics.maxLeft);
    const top = clamp(options.top, metrics.topInset, metrics.maxTop);
    return normalizePosition({
      xRatio: metrics.xTravel ? (left - metrics.leftInset) / metrics.xTravel : 1,
      yRatio: metrics.yTravel ? (top - metrics.topInset) / metrics.yTravel : 1
    });
  }

  return { normalizePosition, panelMetrics, calculatePosition, positionFromCoordinates };
});
