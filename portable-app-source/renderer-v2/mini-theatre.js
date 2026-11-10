"use strict";

(function attachMiniTheatre(root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root) root.BaiqiuMiniTheatre = api;
})(typeof window !== "undefined" ? window : globalThis, () => {
  const cast = ['孙悟空', '哪吒', '小狐狸', '纸片龙', '月亮邮差', '墨水精灵', '云朵大盗', '白胡子猫', '标点骑士', '风筝船长'];
  const places = ['花果山', '倒着下雨的街', '云端书摊', '月亮渡口', '折纸森林', '会打嗝的城堡', '标点小镇', '星光集市'];
  const treasures = ['会飞的桃子', '星星钥匙', '半张藏宝图', '月光邮票', '迷路的逗号', '装着雷声的瓶子', '隐身斗篷', '会唱歌的石头'];
  const effects = {
    dash: ['咻——', '嗖！', '唰！'],
    hit: ['BOM～', '砰！', '嘭——'],
    tumble: ['咕噜咕噜', '哎哟！', '扑通！'],
    dodge: ['唰——', '嘿！', '嗖～'],
    hop: ['嘿咻！', '蹦！', '叮～'],
    float: ['呼——', '飘呀飘', '呜呼～'],
    shake: ['轰隆！', '哗啦！', '咚咚！'],
    join: ['啪！', '成交～', '叮！'],
    sparkle: ['锵锵！', '叮——', '哇！'],
    rest: ['呼噜～', '嘘……', '呼～']
  };
  const pick = (items, random) => items[Math.min(items.length - 1, Math.max(0, Math.floor(random() * items.length)))];

  function createStory(random = Math.random, previousOpening = '') {
    const memory = { chapter: 0, beat: 0, next: 'opening', rival: '', place: '', item: '', encountered: [] };
    let lastOpening = previousOpening;
    function next() {
      const beat = memory.next;
      if (beat === 'opening') {
        memory.chapter++;
        memory.rival = pick(cast.filter(name => name !== lastOpening), random);
        lastOpening = memory.rival;
        memory.place = pick(places.filter(place => place !== memory.place), random);
        memory.item = pick(treasures.filter(item => item !== memory.item), random);
      }
      memory.beat++;
      const { rival, place, item } = memory;
      const returning = memory.encountered.includes(rival);
      let line;
      let choices;
      const tell = (before, verb, after, action, target = rival) => ({ before, verb, after, action, actor: '黑球', target });
      switch (beat) {
        case 'opening':
          line = pick([
            tell(`刚到${place}，`, '拦住了', `：“你手里的${item}，能借我看看吗？”`, 'hop'),
            tell(`${place}传来一声响。`, '撞见了', `，${item}正从对方口袋里探头。`, 'dodge'),
            tell(`故事落在${place}。`, '追上了', `：“等等！那枚会发光的，是${item}吗？”`, 'dash')
          ], random);
          if (returning) line.before = `绕到${place}，竟又遇见老熟人。`;
          memory.encountered = [...memory.encountered.filter(name => name !== rival), rival].slice(-cast.length);
          choices = ['challenge', 'race', 'bargain'];
          break;
        case 'challenge':
          line = tell(`想借${item}？先过这一招！`, '迎面冲向', '，两个名字撞得字边都冒出了火星。', 'hit');
          choices = ['win', 'stumble', 'dodge'];
          break;
        case 'race':
          line = tell(`${rival}把${item}一举：“追上我就借你！”`, '飞奔追赶', '，连句号都被甩在了后面。', 'dash');
          choices = ['win', 'stumble'];
          break;
        case 'bargain':
          line = tell(`硬抢不行，得换个办法。`, '悄悄靠近', `：“我有一段笑话，换你的${item}，如何？”`, 'join');
          choices = ['alliance', 'trick'];
          break;
        case 'win':
          line = tell('最后一下，胜负分晓！', '一跃越过', `，稳稳接住${item}。对方愣住：“你这小黑球，还挺厉害！”`, 'hop');
          choices = ['truce'];
          break;
        case 'stumble':
          line = tell('眼看就要追上，脚下却多了一个逗号。', '翻滚着擦过', `，咕噜滚了半圈。${item}还在对方手里。`, 'tumble');
          choices = ['recover'];
          break;
        case 'recover':
          line = tell('先把歪掉的字扶正。', '重新站到', '面前：“刚才不算，再来！或者……我们谈谈？”', 'hop');
          choices = ['challenge', 'bargain'];
          break;
        case 'dodge':
          line = tell('对方突然变招！', '侧身闪过', '，刚才站的地方只剩一个大大的惊叹号。', 'dodge');
          choices = ['challenge', 'bargain'];
          break;
        case 'trick':
          line = tell(`笑话才讲一半，${rival}已经抱着${item}溜了。`, '急忙追向', '：“喂！包袱还没抖完呢！”', 'dash');
          choices = ['race'];
          break;
        case 'truce':
          line = tell(`到手的${item}忽然指向远处。`, '回头招呼', '：“一起去看看？”刚才的对手揉揉脑袋，跟了上来。', 'join');
          choices = ['travel'];
          break;
        case 'alliance':
          line = tell(`${rival}笑得直不起腰，终于拿出${item}。`, '轻轻碰了碰', '：“成交！接下来一起走。”', 'join');
          choices = ['travel'];
          break;
        case 'travel':
          line = tell(`${item}一路发光，指向地平线。`, '并肩跟着', '，踩上一座由省略号搭成的小桥。桥那边，会有什么？', 'float');
          choices = ['storm', 'gate', 'camp'];
          break;
        case 'storm':
          line = tell('走到桥中央，一阵风把省略号吹散了！', '一把拉住', `，两人挂在最后一个点上。${item}还好好护在怀里。`, 'shake');
          choices = ['rescue'];
          break;
        case 'rescue':
          line = tell(`${rival}抛出一根长长的破折号。`, '荡到岸边接住', '，两人落地，互相拍拍身上的风。', 'hop');
          choices = ['camp', 'gate'];
          break;
        case 'gate':
          line = tell(`前面是一扇写着“请笑一下”的门。`, '转头望着', `：“试试${item}？”门缝里传来憋笑声。`, 'rest');
          choices = ['unlock', 'bounce'];
          break;
        case 'bounce':
          line = tell(`门把${item}轻轻弹了回来。`, '撞回了', '怀里。“它好像真的想听笑话。”两人面面相觑。', 'tumble');
          choices = ['unlock'];
          break;
        case 'unlock':
          line = tell('于是，一个讲笑话，一个负责挠门缝。', '和身旁的', '笑成一团。大门终于忍不住，笑着打开了！', 'shake');
          choices = ['treasure'];
          break;
        case 'treasure':
          line = tell(`门后是一片星海，${item}找到了它的归处。`, '拉着', '跳上流星。“下一站呢？”风翻开了新的一页……', 'sparkle');
          choices = ['opening'];
          break;
        case 'camp':
          line = tell(`先在路边歇一会儿。${item}在掌心微微发亮。`, '靠着', '听风讲了半段故事。“后半段呢？”“往前走就知道了。”', 'rest');
          choices = ['travel', 'visitor'];
          break;
        case 'visitor': {
          const guest = pick(cast.filter(name => name !== rival), random);
          line = tell(`${guest}路过，留下一句：“发光的东西会认路。”`, '赶紧叫醒', `，顺着${item}指的方向，继续出发。`, 'hop');
          choices = ['travel'];
          break;
        }
        default:
          throw new Error('Unknown local story beat');
      }
      memory.next = pick(choices, random);
      return { ...line, id: beat, chapter: memory.chapter, beat: memory.beat, place, item, rival,
        effect: pick(effects[line.action], random), flourish: pick(['burst', 'wobble', 'echo'], random),
        duration: 6200 + Math.floor(random() * 1400) };
    }
    return { next };
  }

  function markup() {
    return '<header class="mt-header"><span>黑球小剧场</span><time class="mt-time">0s</time></header>'
      + '<div class="mt-previous" aria-hidden="true"></div><div class="mt-stage"></div><div class="mt-caption" hidden></div>';
  }

  function create(host, environment = {}) {
    const doc = host.ownerDocument;
    const now = environment.now || Date.now;
    const later = environment.setTimeout || setTimeout;
    const cancel = environment.clearTimeout || clearTimeout;
    const records = new Map();
    const random = environment.random || Math.random;
    let previousOpening = '';
    let selectedSessionId = '';
    let timer = null;
    let listening = false;
    let destroyed = false;
    let visible = null;
    const reduced = environment.reducedMotion ?? Boolean(doc.defaultView?.matchMedia?.('(prefers-reduced-motion: reduce)').matches);
    function clearTimer() {
      if (timer !== null) cancel(timer);
      timer = null;
    }
    function running(record) { return record && record.state !== 'FROZEN'; }
    function visibilityChanged() {
      if (doc.hidden && visible?.state.startsWith('ENDING_')) {
        visible.state = 'FROZEN';
        paint(visible);
      }
      refresh();
    }
    function syncListener() {
      const needed = [...records.values()].some(running);
      if (needed && !listening) doc.addEventListener('visibilitychange', visibilityChanged);
      if (!needed && listening) doc.removeEventListener('visibilitychange', visibilityChanged);
      listening = needed;
    }
    function paint(record) {
      const elapsed = Math.max(0, (record.endedAt ?? now()) - record.startedAt);
      record.node.querySelector('.mt-time').textContent = `${Math.floor(elapsed / 1000)}s`;
      record.node.dataset.state = record.state;
      record.node.dataset.outcome = record.outcome || '';
      record.node.dataset.paused = doc.hidden ? '1' : '0';
    }
    function measure(record) {
      const duet = record.node.querySelector('.mt-duet');
      const actor = record.node.querySelector('.mt-actor');
      const target = record.node.querySelector('.mt-target');
      if (duet && actor && target) {
        duet.style?.setProperty('--mt-distance', `${Math.max(0, target.offsetLeft - actor.offsetLeft - actor.offsetWidth + 6)}px`);
      }
    }
    function setScene(record) {
      const scene = record.story.next();
      const stage = record.node.querySelector('.mt-stage');
      record.node.querySelector('.mt-previous').textContent = record.lastLine || '';
      record.scene = scene;
      record.node.dataset.scene = scene.id;
      record.node.dataset.beat = String(scene.beat);
      record.node.dataset.chapter = String(scene.chapter);
      record.node.dataset.action = scene.action;
      record.node.dataset.effect = scene.flourish;
      const line = doc.createElement('div');
      line.className = 'mt-line';
      line.innerHTML = '<span class="mt-before"></span><span class="mt-duet"><span class="mt-actor"></span><span class="mt-verb"></span><span class="mt-target"></span><span class="mt-fx" aria-hidden="true"></span></span><span class="mt-after"></span>';
      for (const [selector, value] of Object.entries({
        '.mt-before': scene.before, '.mt-actor': scene.actor, '.mt-verb': scene.verb,
        '.mt-target': scene.target, '.mt-fx': scene.effect, '.mt-after': scene.after
      })) line.querySelector(selector).textContent = value;
      stage.replaceChildren(line);
      record.lastLine = scene.before + scene.actor + scene.verb + scene.target + '，' + scene.effect + ' ' + scene.after;
      measure(record);
    }
    function tick() {
      timer = null;
      if (destroyed) return;
      const record = visible;
      if (record && !doc.hidden) {
        const time = now();
        if (record.state.startsWith('ENDING_') && time >= record.freezeAt) record.state = 'FROZEN';
        if (record.state === 'SCENE_TRANSITION' && time >= record.transitionAt) {
          setScene(record);
          record.state = 'RUNNING';
          record.nextSceneAt = time + record.scene.duration;
        } else if (record.state === 'RUNNING' && time >= record.nextSceneAt) {
          record.state = 'SCENE_TRANSITION';
          record.transitionAt = time + (reduced ? 0 : 300);
        }
        paint(record);
      }
      syncListener();
      if (running(visible) && !doc.hidden) timer = later(tick, 200);
    }
    function refresh() {
      clearTimer();
      const record = [...records.values()].find(item => item.sessionId === selectedSessionId) || null;
      host.hidden = !record;
      if (visible !== record) {
        if (visible) {
          visible.node.dataset.paused = '1';
          if (visible.state.startsWith('ENDING_')) {
            visible.state = 'FROZEN';
            paint(visible);
          }
        }
        visible = record;
        host.replaceChildren(...(record ? [record.node] : []));
        if (record) measure(record);
      }
      tick();
    }
    function start({ taskId, sessionId, startedAt }) {
      if (destroyed || !taskId || !sessionId) return;
      if (records.has(taskId)) return records.get(taskId).node;
      for (const [id, record] of records) {
        if (record.sessionId === sessionId) {
          record.node.remove();
          records.delete(id);
        }
      }
      const node = doc.createElement('section');
      node.className = 'black-ball-mini-theatre';
      node.dataset.taskId = taskId;
      node.dataset.reduced = reduced ? '1' : '0';
      node.setAttribute('aria-label', '黑球小剧场，本地陪伴动画，不代表实际执行步骤');
      node.innerHTML = markup();
      const record = { taskId, sessionId, node, startedAt: Number.isFinite(startedAt) ? startedAt : now(), state: 'RUNNING', story: createStory(random, previousOpening) };
      records.set(taskId, record);
      setScene(record);
      previousOpening = record.scene.rival;
      record.nextSceneAt = now() + record.scene.duration;
      refresh();
      return node;
    }
    function finish(taskId, outcome, endedAt = now()) {
      const record = records.get(taskId);
      if (!record || record.endedAt !== undefined) return;
      record.outcome = ['success', 'failure', 'cancelled', 'waiting'].includes(outcome) ? outcome : 'cancelled';
      record.endedAt = Math.max(record.startedAt, endedAt);
      record.state = record.outcome === 'waiting' || reduced ? 'FROZEN' : `ENDING_${record.outcome.toUpperCase()}`;
      record.freezeAt = now() + 1400;
      const caption = record.node.querySelector('.mt-caption');
      caption.hidden = false;
      caption.textContent = { success: '黑球合上故事书：这一页，刚刚好。', failure: '黑球夹好书签：先停在这里。', cancelled: '黑球按住翻动的书页：下回再续。', waiting: '黑球留了一盏小灯，等你回来。' }[record.outcome];
      if (record !== visible || doc.hidden) record.state = 'FROZEN';
      paint(record);
      const frozen = [...records.values()].filter(item => item.state === 'FROZEN' && item !== visible);
      for (const old of frozen.slice(0, Math.max(0, frozen.length - 24))) records.delete(old.taskId);
      refresh();
    }
    function select(sessionId) {
      selectedSessionId = sessionId;
      refresh();
    }
    function destroy() {
      destroyed = true;
      clearTimer();
      if (listening) doc.removeEventListener('visibilitychange', visibilityChanged);
      listening = false;
      records.clear();
      visible = null;
      host.replaceChildren();
      host.hidden = true;
    }
    return { start, finish, select, destroy };
  }
  return { create, createStory };
});
