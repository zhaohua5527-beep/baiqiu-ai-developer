(function exposeTaskBoardEdgePosition(root, factory) {
  const api = factory();
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  if (root) root.BaiqiuTaskBoardEdgePosition = api;
})(typeof window !== "undefined" ? window : globalThis, () => {
  const EDGES = new Set(["top", "right", "bottom", "left"]);

  function clamp(value, minimum, maximum) {
    return Math.min(maximum, Math.max(minimum, Number(value) || 0));
  }

  function normalizePosition(value = {}) {
    return {
      edge: EDGES.has(value?.edge) ? value.edge : "right",
      ratio: clamp(value?.ratio ?? 0.5, 0, 1)
    };
  }

  function edgeMetrics({ viewportWidth, viewportHeight, elementWidth, elementHeight, titlebarHeight = 42, gap = 8 } = {}) {
    const width = Math.max(1, Number(viewportWidth) || 1);
    const height = Math.max(1, Number(viewportHeight) || 1);
    const itemWidth = Math.max(1, Number(elementWidth) || 1);
    const itemHeight = Math.max(1, Number(elementHeight) || 1);
    const safeTop = clamp(titlebarHeight + gap, 0, height);
    const safeBottom = Math.max(safeTop, height - gap);
    return {
      width,
      height,
      itemWidth,
      itemHeight,
      safeTop,
      sideTravel: Math.max(0, safeBottom - safeTop - itemHeight),
      horizontalStart: Math.min(gap, Math.max(0, width - itemWidth)),
      horizontalTravel: Math.max(0, width - (gap * 2) - itemWidth),
      top: clamp(titlebarHeight, 0, Math.max(0, height - itemHeight)),
      bottom: Math.max(0, height - itemHeight)
    };
  }

  function calculateDockPosition(options = {}) {
    const position = normalizePosition(options);
    const metrics = edgeMetrics(options);
    const vertical = position.edge === "left" || position.edge === "right";
    const left = vertical
      ? (position.edge === "left" ? 0 : Math.max(0, metrics.width - metrics.itemWidth))
      : metrics.horizontalStart + (metrics.horizontalTravel * position.ratio);
    const top = vertical
      ? metrics.safeTop + (metrics.sideTravel * position.ratio)
      : (position.edge === "top" ? metrics.top : metrics.bottom);
    return { edge: position.edge, ratio: position.ratio, left: Math.round(left), top: Math.round(top) };
  }

  function closestEdge({ clientX, clientY, viewportWidth, viewportHeight, titlebarHeight = 42 } = {}) {
    const x = clamp(clientX, 0, Math.max(1, Number(viewportWidth) || 1));
    const y = clamp(clientY, 0, Math.max(1, Number(viewportHeight) || 1));
    const width = Math.max(1, Number(viewportWidth) || 1);
    const height = Math.max(1, Number(viewportHeight) || 1);
    return Object.entries({ left: x, right: width - x, top: Math.abs(y - titlebarHeight), bottom: height - y })
      .sort((a, b) => a[1] - b[1])[0][0];
  }

  function positionFromPointer(options = {}) {
    const edge = closestEdge(options);
    const metrics = edgeMetrics(options);
    const vertical = edge === "left" || edge === "right";
    const pointer = vertical
      ? (Number(options.clientY) || 0) - metrics.safeTop - (metrics.itemHeight / 2)
      : (Number(options.clientX) || 0) - metrics.horizontalStart - (metrics.itemWidth / 2);
    const travel = vertical ? metrics.sideTravel : metrics.horizontalTravel;
    return normalizePosition({ edge, ratio: travel > 0 ? pointer / travel : 0.5 });
  }

  return { normalizePosition, calculateDockPosition, closestEdge, positionFromPointer };
});
