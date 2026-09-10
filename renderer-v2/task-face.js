(() => {
  const assetPath = 'assets/natural-task-faces/';
  const names = ['neutral', 'smile', 'happy', 'surprised', 'wink', 'sad', 'worried', 'tired', 'calm', 'focused', 'listening', 'puzzled', 'sad-quiet', 'worried-quiet', 'tired-quiet'];

  function expressionForEvent(event) {
    const types = [event.type, event.eventType, event.kind, event.semanticType, event.semantic_type].map(value => String(value || '').toLowerCase());
    const status = String(event.status || event.outcome || '').toLowerCase();
    const has = (...values) => values.some(value => types.includes(value));
    if (['failed', 'failure', 'error', 'rejected', 'denied'].includes(status) || has('tool_failed', 'error', 'failed')) return 'worried';
    if (['cancelled', 'canceled', 'aborted'].includes(status) || has('cancelled', 'canceled')) return 'sad-quiet';
    if (has('warning', 'approval_required')) return 'surprised';
    if (has('cross_check')) return 'puzzled';
    if (['waiting', 'needs_input', 'awaiting_input'].includes(status) || has('clarification_required', 'waiting', 'model_request_dispatched')) return 'listening';
    if (has('tool_result', 'stage_result', 'cross') || ['completed', 'success', 'succeeded'].includes(status)) return 'neutral';
    if (has('thinking', 'reasoning_delta', 'reasoning', 'reasoning_note', 'public_reasoning', 'thought', 'action', 'tool', 'tool_started', 'tool_call', 'executing')) return 'focused';
    return null;
  }

  function create(container) {
    let active = null;
    let timer = null;
    let visible = false;
    let ready = false;
    let loading = null;
    let nextBlink = 0;
    let closedUntil = 0;
    let blinksRemaining = 0;
    let groupsUntilDouble = 2 + Math.floor(Math.random() * 2);
    let queued = false;
    let destroyed = false;
    const completions = new Map();
    const progress = new WeakMap();
    const interval = () => 1800 + Math.random() * 1200;
    const owner = (face) => face?.closest('.streaming-activity, .thinking-message');
    const paint = (face, expression = 'neutral', closed = false) => {
      const image = face?.querySelector('.execution-short-task-features');
      if (!image) return;
      const filename = `${assetPath}${expression}${closed ? '-closed' : ''}.png`;
      if (image.getAttribute('src') !== filename) image.setAttribute('src', filename);
      face.dataset.faceState = expression;
    };
    const stop = () => {
      clearTimeout(timer);
      timer = null;
      closedUntil = 0;
      blinksRemaining = 0;
      if (active) {
        active.dataset.animating = '0';
        paint(active);
      }
    };
    const reaction = () => {
      const root = owner(active);
      if (root && root.dataset.lifecycle !== 'completed') {
        const current = progress.get(root);
        return { expression: current?.expression || 'listening', remaining: Infinity };
      }
      const completion = completions.get(root?.dataset.faceTaskId);
      const elapsed = Date.now() - Number(completion?.timestamp || 0);
      if (elapsed < 0 || elapsed >= 4000) return { expression: 'neutral', remaining: Infinity };
      const mood = completion?.mood;
      if (mood === 'success') return { expression: 'neutral', remaining: 4000 - elapsed };
      const expression = { worried: 'worried', cancelled: 'sad-quiet', waiting: 'listening', attention: 'puzzled' }[mood] || 'neutral';
      return { expression, remaining: 4000 - elapsed };
    };
    const tick = () => {
      clearTimeout(timer);
      timer = null;
      if (!active?.isConnected || !visible || document.hidden || !ready || destroyed) {
        stop();
        return;
      }
      const now = Date.now();
      if (closedUntil && now >= closedUntil) {
        closedUntil = 0;
        blinksRemaining -= 1;
        nextBlink = now + (blinksRemaining > 0 ? 180 : interval());
      } else if (!closedUntil && now >= nextBlink) {
        if (blinksRemaining === 0) {
          groupsUntilDouble -= 1;
          blinksRemaining = groupsUntilDouble === 0 ? 2 : 1;
          if (groupsUntilDouble === 0) groupsUntilDouble = 2 + Math.floor(Math.random() * 2);
        }
        closedUntil = now + 150 + Math.random() * 50;
      }
      const current = reaction();
      paint(active, current.expression, closedUntil > now);
      active.dataset.animating = '1';
      timer = setTimeout(tick, Math.max(16, Math.min(current.remaining, (closedUntil || nextBlink) - now)));
    };
    const resume = () => {
      if (!active || !visible || document.hidden || !ready) return;
      nextBlink = Date.now() + interval();
      tick();
    };
    const viewport = new IntersectionObserver((entries) => {
      const entry = entries.find((item) => item.target === active);
      if (!entry) return;
      visible = entry.isIntersecting && active.getClientRects().length > 0;
      if (visible) resume();
      else stop();
    }, { root: container });
    const preload = () => {
      loading ||= Promise.all(names.flatMap((name) => ['', '-closed'].map((suffix) => {
        const image = new Image();
        image.src = `${assetPath}${name}${suffix}.png`;
        return image.decode();
      }))).then(() => { ready = true; resume(); }).catch(() => {});
    };
    const sync = () => {
      queued = false;
      if (destroyed) return;
      const candidates = [...container.querySelectorAll('.execution-short-task-face')]
        .filter((face) => !face.closest('[hidden], [aria-hidden="true"].streaming-activity'));
      const running = candidates.filter((face) => owner(face)?.dataset.lifecycle !== 'completed');
      const completed = candidates.filter((face) => owner(face)?.dataset.lifecycle === 'completed');
      const next = running.at(-1) || completed.at(-1) || null;
      if (next === active) {
        if (visible && !document.hidden && ready) tick();
        return;
      }
      stop();
      if (active) viewport.unobserve(active);
      active = next;
      visible = false;
      if (active) {
        viewport.observe(active);
        preload();
      }
    };
    const schedule = () => {
      if (queued || destroyed) return;
      queued = true;
      queueMicrotask(sync);
    };
    const mutations = new MutationObserver((records) => {
      if (records.some((record) => record.type === 'attributes'
        || [...record.addedNodes, ...record.removedNodes].some((node) => node.nodeType === 1
          && (node.matches?.('.execution-short-task-face, [data-lifecycle]') || node.querySelector?.('.execution-short-task-face'))))) schedule();
    });
    mutations.observe(container, { childList: true, subtree: true, attributes: true, attributeFilter: ['data-lifecycle', 'hidden'] });
    const visibilityChanged = () => { if (document.hidden) stop(); else resume(); };
    document.addEventListener('visibilitychange', visibilityChanged);
    const preventDrag = (event) => { if (event.target.closest?.('.execution-activity-toggle')) event.preventDefault(); };
    container.addEventListener('dragstart', preventDrag);
    schedule();
    return {
      sync: schedule,
      progress(root, event) {
        if (!root || !event || typeof event !== 'object') return;
        root = root.querySelector?.('.execution-short-task-face')?.closest('.streaming-activity, .thinking-message') || root;
        if (root.dataset.lifecycle === 'completed') return;
        const taskId = event.turnId || '';
        if (taskId && root.dataset.faceTaskId && root.dataset.faceTaskId !== taskId) return;
        if (taskId) root.dataset.faceTaskId = taskId;
        const expression = expressionForEvent(event);
        if (!expression) return;
        const sequence = Number(event.turnSequence || event.sequence || event.seq || 0);
        const previous = progress.get(root);
        if (sequence && previous?.sequence && sequence <= previous.sequence) return;
        if (event.eventId && event.eventId === previous?.eventId) return;
        progress.set(root, { expression, sequence: sequence || previous?.sequence || 0, eventId: event.eventId });
        schedule();
        if (owner(active) === root && visible && !document.hidden) tick();
      },
      complete(root, mood, timestamp, taskId) {
        if (!root) return;
        root.dataset.faceTaskId = taskId || root.dataset.faceTaskId || '';
        if (taskId && !completions.has(taskId)) {
          completions.set(taskId, { mood, timestamp });
          if (completions.size > 100) completions.delete(completions.keys().next().value);
        }
        root.dataset.faceMood = mood;
        root.dataset.faceReactionAt ||= String(timestamp);
        schedule();
        if (owner(active) === root && visible && !document.hidden) tick();
      },
      destroy() {
        destroyed = true;
        stop();
        viewport.disconnect();
        mutations.disconnect();
        document.removeEventListener('visibilitychange', visibilityChanged);
        container.removeEventListener('dragstart', preventDrag);
        active = null;
        completions.clear();
      }
    };
  }
  window.BaiqiuTaskFace = {
    create,
    expressionForEvent,
    markup: () => `<span class="execution-short-task-face" data-face-state="neutral" aria-hidden="true"><img class="execution-short-task-body" src="${assetPath}body.png" draggable="false" alt=""><img class="execution-short-task-features" src="${assetPath}neutral.png" draggable="false" alt=""></span>`
  };
})();
