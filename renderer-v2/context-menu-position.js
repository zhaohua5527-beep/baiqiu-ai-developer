(function exposeContextMenuPosition(root, factory) {
  const api = factory();
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  if (root) root.BaiqiuContextMenuPosition = api;
})(typeof window !== "undefined" ? window : globalThis, () => {
  function clamp(value, minimum, maximum) {
    return Math.min(maximum, Math.max(minimum, Number(value) || 0));
  }

  function calculatePosition(options = {}) {
    const margin = Math.max(0, Number(options.margin) || 0);
    const viewportWidth = Math.max(1, Number(options.viewportWidth) || 1);
    const viewportHeight = Math.max(1, Number(options.viewportHeight) || 1);
    const menuWidth = Math.max(1, Number(options.menuWidth) || 1);
    const menuHeight = Math.max(1, Number(options.menuHeight) || 1);
    const pointerX = clamp(options.pointerX, 0, viewportWidth);
    const pointerY = clamp(options.pointerY, 0, viewportHeight);
    const maxLeft = Math.max(margin, viewportWidth - menuWidth - margin);
    const maxTop = Math.max(margin, viewportHeight - menuHeight - margin);
    const opensLeft = pointerX + menuWidth + margin > viewportWidth;
    const opensUp = pointerY + menuHeight + margin > viewportHeight;

    return {
      left: Math.round(clamp(opensLeft ? pointerX - menuWidth : pointerX, margin, maxLeft)),
      top: Math.round(clamp(opensUp ? pointerY - menuHeight : pointerY, margin, maxTop)),
      opensLeft,
      opensUp
    };
  }

  return { calculatePosition };
});
