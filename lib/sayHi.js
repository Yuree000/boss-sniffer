// BOSS Sniffer - sayHi.js (M3)
// 全自动打招呼模块：
//   1. 评估"符合"的候选人入队
//   2. 节流消费（随机延迟 + 连续 N 人后强制休息）
//   3. 通过 chrome.debugger 协议在 BOSS 页面 DOM 上模拟点击"打招呼"按钮
//      （不调用 BOSS API，免疫 encryptSecurityId / CSRF / 限频参数）
//
// 状态持久化到 chrome.storage.local.sayHiState，SW 重启后恢复
//
// 全部公共方法挂在 self.BossSayHi
// 依赖：sayHi 配置（self.BOSS_SAYHI_CONFIG_GETTER 由 background.js 提供）
//      最近 BOSS tabId（self.BOSS_LAST_TAB_GETTER）
//      候选人原始数据（self.BOSS_CANDIDATE_GETTER），用于评估卡片状态联动

(function (global) {
  'use strict';

  const STATE_STORAGE_KEY = 'sayHiState';

  // ===== 内部状态（内存 + 持久化镜像） =====
  let state = {
    queue: [],                // [{ candidateId, tabId, queuedAt }]
    processedSinceRest: 0,    // 累计已消费数（休息后清零）
    restUntil: 0,             // 当前是否在休息：> Date.now() 表示在休息
    lastSaidAt: 0,            // 上一次 sayHi 完成时间戳（仅用于诊断展示）
    consumerOn: false         // 消费器是否启用（与 sayHi.enabled 联动）
  };
  let consumerTimer = null;
  let consuming = false;       // 防止 setInterval 重入

  // ===== 工具 =====
  // v1.1.22 sleep/err 提到 lib/runtime-utils.js
  const sleep = self.BossRuntimeUtils.sleep;
  const err = self.BossRuntimeUtils.err;

  function rand(min, max) {
    if (min === max) return min;
    if (min > max) { const t = min; min = max; max = t; }
    return min + Math.floor(Math.random() * (max - min + 1));
  }

  // v1.0.4 Sprint B：自愈 attach / detach 逻辑提到 lib/debugger-util.js，与 background.js
  //   realClickAtCoords 共用同一份实现。下面薄包装保留供本 lib 内部 6 处调用方便。
  function attachDebugger(tabId) {
    return self.BossDebuggerUtil.attachWithSelfHeal(tabId);
  }
  function detachDebugger(tabId) {
    return self.BossDebuggerUtil.detach(tabId);
  }
  function sendCmd(target, method, params) {
    return new Promise(function (resolve, reject) {
      chrome.debugger.sendCommand(target, method, params || {}, function (result) {
        if (chrome.runtime.lastError) {
          reject(err('DebuggerCmdError', chrome.runtime.lastError.message));
        } else { resolve(result); }
      });
    });
  }

  // ===== 持久化 =====
  /**
   * 把当前内存里的 sayHi 状态(队列/休息计时/已发数等)写回 chrome.storage.local
   * Service Worker 随时可能被回收,每次状态变化都得持久化,否则重启就丢
   *
   * 返回: Promise(无返回值)
   */
  function saveState() {
    const obj = {};
    obj[STATE_STORAGE_KEY] = {
      queue: state.queue,
      processedSinceRest: state.processedSinceRest,
      restUntil: state.restUntil,
      lastSaidAt: state.lastSaidAt
    };
    return new Promise(function (resolve) {
      chrome.storage.local.set(obj, resolve);
    });
  }
  /**
   * 启动时从 chrome.storage.local 把上次的 sayHi 状态恢复回内存
   * consumerOn 不持久化,需要 background.js 按 sayHi.enabled 显式启动
   *
   * 返回: Promise(无返回值,state 已就地更新)
   */
  function loadState() {
    return new Promise(function (resolve) {
      chrome.storage.local.get([STATE_STORAGE_KEY], function (res) {
        const s = res[STATE_STORAGE_KEY];
        if (s && typeof s === 'object') {
          state.queue = Array.isArray(s.queue) ? s.queue : [];
          state.processedSinceRest = s.processedSinceRest || 0;
          state.restUntil = s.restUntil || 0;
          state.lastSaidAt = s.lastSaidAt || 0;
        }
        resolve();
      });
    });
  }

  // ===== 注入到 BOSS 页面执行的「找按钮」函数 =====
  // 注意：此函数会被 toString()，不能闭包外部变量
  //
  // 跨 frame：BOSS 聊天工作台把候选人列表放在 iframe (/web/frame/recommend) 里
  // → 必须遍历所有同源 iframe 的 contentDocument
  // → frame 内的 getBoundingClientRect 给的是 frame-local 坐标，要叠加 iframe.getBoundingClientRect()
  //   把坐标翻译到顶层 frame 的 viewport（chrome.debugger Input.dispatchMouseEvent 用顶层坐标）
  //
  // 候选人定位 3 路兜底：
  //   ① 竞品 selector：.card-inner[data-geekid="X"] / [data-geek="X"]（X 可以是 candidateId 或 encryptUid）
  //   ② 全局 attr 扫描：任意 attribute value 含目标 ID
  //   ③ Vue 组件实例挖掘（罕见场景兜底）
  function pageScript_findCardAndButton(candidateId, encryptUid) {
    const idStr = String(candidateId || '');
    const eidStr = String(encryptUid || '');
    const ids = [idStr, eidStr].filter(Boolean);

    // 收集所有可访问的 root：顶层 + 同源 iframe，每个带 (offsetX, offsetY) 用于坐标翻译
    function collectRoots() {
      const roots = [{ doc: document, offsetX: 0, offsetY: 0, label: 'top' }];
      const iframes = document.querySelectorAll('iframe');
      for (let i = 0; i < iframes.length; i++) {
        const f = iframes[i];
        try {
          const innerDoc = f.contentDocument;
          if (!innerDoc) continue;
          const r = f.getBoundingClientRect();
          if (r.width === 0 || r.height === 0) continue;  // 跳过 0 尺寸的隐形 iframe
          roots.push({ doc: innerDoc, offsetX: r.x, offsetY: r.y, label: 'iframe[' + i + ']:' + (f.src || '').slice(-40) });
        } catch (_e) {}  // 跨域 iframe，跳过
      }
      return roots;
    }

    function isClickable(b) {
      if (!b) return false;
      if (b.disabled || b.getAttribute('aria-disabled') === 'true') return false;
      const r = b.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) return false;
      const win = b.ownerDocument && b.ownerDocument.defaultView;
      if (win) {
        const st = win.getComputedStyle(b);
        if (st.display === 'none' || st.visibility === 'hidden' || st.pointerEvents === 'none') return false;
      }
      return true;
    }

    let matchStrategy = '';
    let foundRootLabel = '';

    // 在每个 root 上跑 3 路兜底
    const roots = collectRoots();
    for (let ri = 0; ri < roots.length; ri++) {
      const root = roots[ri];
      const doc = root.doc;
      const candidates = [];
      const seen = new Set();
      function pushCandidate(el) {
        if (el && !seen.has(el)) { seen.add(el); candidates.push(el); }
      }

      // ① 竞品精确 selector
      if (idStr || eidStr) {
        const sels = [];
        if (idStr) {
          sels.push('.card-inner[data-geekid="' + idStr + '"]');
          sels.push('.card-inner[data-geek="' + idStr + '"]');
          sels.push('[data-geekid="' + idStr + '"]');
          sels.push('[data-geek="' + idStr + '"]');
        }
        if (eidStr) {
          sels.push('.card-inner[data-geekid="' + eidStr + '"]');
          sels.push('.card-inner[data-geek="' + eidStr + '"]');
          sels.push('[data-geekid="' + eidStr + '"]');
          sels.push('[data-geek="' + eidStr + '"]');
        }
        for (let s = 0; s < sels.length; s++) {
          try { doc.querySelectorAll(sels[s]).forEach(pushCandidate); } catch (_e) {}
        }
        if (candidates.length > 0 && !matchStrategy) matchStrategy = 'data-attr';
      }

      // ② 全局 attribute value 扫描
      if (candidates.length === 0) {
        const all = doc.querySelectorAll('*');
        for (let i = 0; i < all.length; i++) {
          const el = all[i];
          const attrs = el.attributes;
          for (let j = 0; j < attrs.length; j++) {
            const v = attrs[j].value;
            if (!v || v.length < 4) continue;
            for (let k = 0; k < ids.length; k++) {
              if (v === ids[k] || v.indexOf(ids[k]) !== -1) {
                pushCandidate(el);
                break;
              }
            }
          }
        }
        if (candidates.length > 0 && !matchStrategy) matchStrategy = 'attr-scan';
      }

      // ③ Vue 组件挖掘（罕见兜底）
      if (candidates.length === 0) {
        const all = doc.querySelectorAll('*');
        for (let i = 0; i < all.length; i++) {
          const el = all[i];
          const vue = el.__vue__ || (el.__vue_app__ && el.__vue_app__._instance);
          if (!vue) continue;
          const paths = [];
          try { paths.push(vue.$props && vue.$props.dataSource); } catch (_e) {}
          try { paths.push(vue.dataSource); } catch (_e) {}
          try { paths.push(vue.personInfo); } catch (_e) {}
          try { paths.push(vue.resumeInfo); } catch (_e) {}
          for (let p = 0; p < paths.length; p++) {
            const ds = paths[p];
            if (!ds || typeof ds !== 'object') continue;
            const cid = String(ds.securityId || ds.geekId || ds.uid || ds.geekid || '');
            const eid = String(ds.encryptSecurityId || ds.encryptUid || ds.encGeekId || ds.encryptGeekId || '');
            if ((idStr && (cid === idStr || eid === idStr)) ||
                (eidStr && (cid === eidStr || eid === eidStr))) {
              pushCandidate(el);
              break;
            }
          }
        }
        if (candidates.length > 0 && !matchStrategy) matchStrategy = 'vue-instance';
      }

      if (candidates.length === 0) continue;

      // 在这 root 找到候选人 → 在卡片祖先 subtree 里找按钮
      const visited = new Set();
      for (let i = 0; i < candidates.length; i++) {
        let card = candidates[i];
        for (let depth = 0; depth < 12 && card; depth++) {
          if (visited.has(card)) break;
          visited.add(card);

          let btn = card.querySelector(
            'button.btn-greet, .btn-greet, button.btn-chat, [class*="btn-greet"], [class*="btn-comm"]'
          );
          if (!btn || !isClickable(btn)) {
            const all = card.querySelectorAll('button, [role="button"], .btn, a');
            for (let k = 0; k < all.length; k++) {
              const b = all[k];
              const t = (b.textContent || b.innerText || '').trim();
              if (!/^(打招呼|继续沟通|沟通|聊一聊|发起沟通)$/.test(t)) continue;
              if (/已沟通|已打招呼|已发送/.test(t)) continue;
              if (!isClickable(b)) continue;
              btn = b; break;
            }
          }

          if (btn) {
            // frame-local 坐标 → 顶层 viewport 坐标
            const r = btn.getBoundingClientRect();
            const topX = root.offsetX + r.x;
            const topY = root.offsetY + r.y;
            foundRootLabel = root.label;
            return {
              ok: true,
              x: topX + r.width / 2,
              y: topY + r.height / 2,
              buttonText: (btn.textContent || '').trim(),
              buttonClass: (btn.className && typeof btn.className === 'string') ? btn.className.slice(0, 60) : '',
              cardClass: (card.className && typeof card.className === 'string') ? card.className.slice(0, 80) : '',
              inView: topY >= 0 && (topY + r.height) <= window.innerHeight && topX >= 0 && (topX + r.width) <= window.innerWidth,
              matchStrategy: matchStrategy + ' (' + root.label + ')',
              foundRoot: root.label
            };
          }
          card = card.parentElement;
        }
      }
    }

    return {
      ok: false,
      error: '未找到候选人卡片或"打招呼"按钮（已扫描 ' + roots.length + ' 个 frame：top + iframe）',
      hint: '可能：候选人不在当前页 DOM；卡片 selector 又变了；或 ID 不对（注意 data-geekid 存的是 encryptUid 加密版）',
      matchStrategy: matchStrategy,
      rootsScanned: roots.map(function (r) { return r.label; })
    };
  }

  // 注入到 BOSS 页面 — 找确认弹窗内的"确认/发送"按钮（跨 frame）
  // 竞品观察：点 .btn-greet 后会弹一个 dialog（class 含 dialog-wrap / dialog-chat-greeting）
  // 弹窗可能在 iframe 内（continue 在该上下文）或顶层 portal
  function pageScript_findConfirmButton() {
    const dialogSelectors = [
      '.dialog-chat-greeting button.btn',
      '.dialog-wrap.active button.btn-sure',
      '.dialog-wrap.active button.btn-primary',
      '.dialog-wrap.active button.btn',
      '.dialog-wrap button.btn-primary',
      '.dialog-wrap button.btn',
      '.dialog button.btn-primary',
      '.boss-dialog button.btn-sure',
      '.boss-dialog button.btn-primary',
      '[class*="dialog"][class*="greet"] button',
      '[class*="modal"] button.btn-primary',
      '[class*="popup"] button.btn-primary'
    ];
    // 收集所有可访问 root（顶层 + 同源 iframe）
    const roots = [{ doc: document, offsetX: 0, offsetY: 0 }];
    const iframes = document.querySelectorAll('iframe');
    for (let i = 0; i < iframes.length; i++) {
      try {
        const innerDoc = iframes[i].contentDocument;
        if (!innerDoc) continue;
        const r = iframes[i].getBoundingClientRect();
        if (r.width === 0 || r.height === 0) continue;
        roots.push({ doc: innerDoc, offsetX: r.x, offsetY: r.y });
      } catch (_e) {}
    }

    for (let r = 0; r < roots.length; r++) {
      const root = roots[r];
      for (let i = 0; i < dialogSelectors.length; i++) {
        const els = root.doc.querySelectorAll(dialogSelectors[i]);
        for (let j = 0; j < els.length; j++) {
          const btn = els[j];
          const text = (btn.textContent || '').trim();
          if (/取消|关闭|cancel/i.test(text)) continue;
          if (/发送|确认|确定|打招呼|确定发送/.test(text)) {
            const rect = btn.getBoundingClientRect();
            if (rect.width === 0 || rect.height === 0) continue;
            return {
              ok: true,
              x: root.offsetX + rect.x + rect.width / 2,
              y: root.offsetY + rect.y + rect.height / 2,
              buttonText: text,
              foundIn: r === 0 ? 'top' : 'iframe'
            };
          }
        }
      }
    }
    return { ok: false, hasDialog: false };
  }

  // 注入到 BOSS 页面 — 把目标元素滚到视口中心（跨 frame）
  function pageScript_scrollIntoView(candidateId, encryptUid) {
    const ids = [String(candidateId || ''), String(encryptUid || '')].filter(Boolean);
    const docs = [document];
    const iframes = document.querySelectorAll('iframe');
    for (let i = 0; i < iframes.length; i++) {
      try {
        if (iframes[i].contentDocument) docs.push(iframes[i].contentDocument);
      } catch (_e) {}
    }
    for (let d = 0; d < docs.length; d++) {
      const doc = docs[d];
      const all = doc.querySelectorAll('*');
      for (let i = 0; i < all.length; i++) {
        const el = all[i];
        const attrs = el.attributes;
        for (let j = 0; j < attrs.length; j++) {
          const v = attrs[j].value;
          if (!v || v.length < 4) continue;
          for (let k = 0; k < ids.length; k++) {
            if (v === ids[k] || v.indexOf(ids[k]) !== -1) {
              el.scrollIntoView({ behavior: 'instant', block: 'center' });
              return { ok: true };
            }
          }
        }
      }
    }
    return { ok: false };
  }

  // 诊断函数：dump BOSS 当前页面 DOM 结构 — 帮助定位 selector
  function pageScript_diagnose(candidateId, encryptUid) {
    const idStr = String(candidateId || '');
    const eidStr = String(encryptUid || '');
    const result = {
      url: location.href,
      title: document.title,
      idMatchCount: { byCandidateId: 0, byEncryptUid: 0 },
      attrFrequency: [],
      idMatchedAttrs: [],
      cardSamples: [],
      greetButtons: [],      // 所有"打招呼"按钮 + 祖先链
      scopedIdSamples: [],   // 高频 Vue 组件样本（这一定是候选人卡）
      kaValues: []           // 所有 ka= 属性值（BOSS 追踪 ID）
    };

    // 先扫一遍：找所有 attribute value 含目标 ID 的元素 → 那个 attr 就是 BOSS 的 ID 字段
    const all = document.querySelectorAll('*');
    const matchingAttrSet = new Map(); // attrName → count
    for (let i = 0; i < all.length; i++) {
      const el = all[i];
      const attrs = el.attributes;
      for (let j = 0; j < attrs.length; j++) {
        const a = attrs[j];
        if (!a.value) continue;
        if (idStr && (a.value === idStr || a.value.indexOf(idStr) !== -1)) {
          result.idMatchCount.byCandidateId++;
          matchingAttrSet.set(a.name, (matchingAttrSet.get(a.name) || 0) + 1);
        }
        if (eidStr && (a.value === eidStr || a.value.indexOf(eidStr) !== -1)) {
          result.idMatchCount.byEncryptUid++;
          matchingAttrSet.set(a.name, (matchingAttrSet.get(a.name) || 0) + 1);
        }
      }
    }
    matchingAttrSet.forEach(function (cnt, name) {
      result.idMatchedAttrs.push({ attr: name, count: cnt });
    });

    // attribute 频率（看 BOSS 用什么命名风格）
    const attrCount = new Map();
    for (let i = 0; i < all.length; i++) {
      const attrs = all[i].attributes;
      for (let j = 0; j < attrs.length; j++) {
        const n = attrs[j].name;
        if (n.startsWith('data-') || n === 'ka' || n === 'lid' || n === 'id') {
          attrCount.set(n, (attrCount.get(n) || 0) + 1);
        }
      }
    }
    const sorted = [];
    attrCount.forEach(function (cnt, name) { sorted.push({ attr: name, count: cnt }); });
    sorted.sort(function (a, b) { return b.count - a.count; });
    result.attrFrequency = sorted.slice(0, 20);

    // 候选人卡片样本：找疑似卡片容器并 dump 第一个的 outerHTML
    const cardSelectors = [
      '[ka^="search_geek-card"]',
      '[ka^="recommend-card"]',
      '[ka^="search-card"]',
      '[ka*="card"]',
      'li[ka]',
      'li.card-list-item',
      'li[class*="card"]',
      '.candidate-card-wrap',
      '.geek-card',
      '.recommend-card'
    ];
    const seenSel = new Set();
    for (let i = 0; i < cardSelectors.length; i++) {
      const sel = cardSelectors[i];
      let els;
      try { els = document.querySelectorAll(sel); } catch (e) { continue; }
      if (els.length >= 1 && !seenSel.has(els[0])) {
        seenSel.add(els[0]);
        result.cardSamples.push({
          selector: sel,
          count: els.length,
          first2000: els[0].outerHTML.slice(0, 2000)
        });
        if (result.cardSamples.length >= 3) break;
      }
    }

    // 关键：dump 所有"打招呼"按钮 + 它们的祖先链 + 卡片 outerHTML
    // 这是反推 selector 的金矿 — 不需要 ID 匹配
    const buttonLikeAll = document.querySelectorAll('button, a, [role="button"], .btn, [class*="btn"]');
    for (let i = 0; i < buttonLikeAll.length && result.greetButtons.length < 5; i++) {
      const btn = buttonLikeAll[i];
      const text = (btn.textContent || btn.innerText || '').trim();
      if (!/打招呼|沟通|聊一聊|发起沟通/.test(text)) continue;
      if (text.length > 30) continue;  // 太长大概率是父容器文本
      const r = btn.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) continue;

      // 祖先链 8 层
      const chain = [];
      let cur = btn;
      for (let d = 0; d < 8 && cur; d++) {
        chain.push({
          tag: cur.tagName.toLowerCase(),
          cls: (cur.className && typeof cur.className === 'string') ? cur.className.slice(0, 60) : '',
          attrs: Array.prototype.slice.call(cur.attributes)
            .filter(function (a) { return a.name !== 'style'; })
            .map(function (a) { return a.name + '=' + (a.value || '').slice(0, 50); })
            .slice(0, 6)
        });
        cur = cur.parentElement;
      }

      // 找它"看起来像卡片"的祖先（width > 200 && 含其他文本如姓名/学历）
      let cardEl = null;
      let walk = btn.parentElement;
      for (let d = 0; d < 8 && walk; d++) {
        const wr = walk.getBoundingClientRect();
        if (wr.width > 200 && wr.height > 50) {
          cardEl = walk;
          break;
        }
        walk = walk.parentElement;
      }

      result.greetButtons.push({
        buttonText: text,
        buttonClass: (btn.className && typeof btn.className === 'string') ? btn.className : '',
        buttonRect: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) },
        ancestorChain: chain,
        cardOuterHTML: cardEl ? cardEl.outerHTML.slice(0, 1500) : null
      });
    }

    // 高频 Vue 组件 dump（一定是候选人卡）
    const scopedAttrs = result.attrFrequency.filter(function (x) {
      return x.attr.indexOf('data-v-') === 0 && x.count >= 8;
    }).slice(0, 3);
    for (let i = 0; i < scopedAttrs.length; i++) {
      const sa = scopedAttrs[i];
      const els = document.querySelectorAll('[' + sa.attr + ']');
      // 找 size > 200x50 + 含 button 的，最多 2 个样本
      let added = 0;
      for (let j = 0; j < els.length && added < 2; j++) {
        const el = els[j];
        const r = el.getBoundingClientRect();
        if (r.width < 200 || r.height < 50) continue;
        const hasBtn = el.querySelector('button, a, [role="button"], .btn, [class*="btn"]');
        if (!hasBtn) continue;
        result.scopedIdSamples.push({
          scopedAttr: sa.attr,
          tag: el.tagName.toLowerCase(),
          cls: (el.className && typeof el.className === 'string') ? el.className.slice(0, 80) : '',
          size: Math.round(r.width) + 'x' + Math.round(r.height),
          attrs: Array.prototype.slice.call(el.attributes)
            .filter(function (a) { return a.name !== 'style'; })
            .map(function (a) { return a.name + '=' + (a.value || '').slice(0, 50); })
            .slice(0, 8),
          outerHTML: el.outerHTML.slice(0, 1500)
        });
        added++;
      }
    }

    // 所有 ka= 值（最多 30 个）
    const kaSet = new Set();
    document.querySelectorAll('[ka]').forEach(function (el) {
      kaSet.add(el.getAttribute('ka'));
    });
    result.kaValues = Array.from(kaSet).slice(0, 30);

    // ===== iframe 检查 — 候选人列表很可能在子 frame 里 =====
    const iframes = document.querySelectorAll('iframe');
    result.iframes = [];
    for (let i = 0; i < iframes.length; i++) {
      const f = iframes[i];
      const r = f.getBoundingClientRect();
      const info = {
        src: f.src || f.getAttribute('src') || '(none)',
        name: f.name || f.getAttribute('name') || '(none)',
        rect: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) },
        sameOrigin: false,
        innerCounts: null,
        innerSamples: null
      };
      // 尝试同源访问 iframe 内的 DOM
      try {
        const doc = f.contentDocument;
        if (doc) {
          info.sameOrigin = true;
          // 数 iframe 内的关键元素
          info.innerCounts = {
            totalElements: doc.querySelectorAll('*').length,
            cardInner: doc.querySelectorAll('.card-inner').length,
            dataGeekid: doc.querySelectorAll('[data-geekid]').length,
            dataGeek: doc.querySelectorAll('[data-geek]').length,
            btnGreet: doc.querySelectorAll('button.btn-greet, .btn-greet').length,
            ka: doc.querySelectorAll('[ka]').length
          };
          // 在 iframe 内找候选人 ID 命中
          info.innerCounts.idMatchInIframe = 0;
          const innerAll = doc.querySelectorAll('*');
          for (let j = 0; j < innerAll.length; j++) {
            const el = innerAll[j];
            const attrs = el.attributes;
            for (let k = 0; k < attrs.length; k++) {
              const v = attrs[k].value;
              if (!v) continue;
              if ((idStr && v.indexOf(idStr) !== -1) || (eidStr && v.indexOf(eidStr) !== -1)) {
                info.innerCounts.idMatchInIframe++;
                break;
              }
            }
          }
          // dump 第一个 .card-inner 或 button.btn-greet 的 outerHTML
          const sample = doc.querySelector('.card-inner, button.btn-greet, [data-geekid]');
          if (sample) {
            info.innerSamples = sample.outerHTML.slice(0, 1000);
          }
        }
      } catch (e) {
        info.sameOrigin = false;
        info.crossOriginError = e.message;
      }
      result.iframes.push(info);
    }

    // 找一个具体匹配 ID 的元素 dump 它和它的祖先
    if (idStr || eidStr) {
      for (let i = 0; i < all.length; i++) {
        const el = all[i];
        const attrs = el.attributes;
        let hit = false;
        for (let j = 0; j < attrs.length; j++) {
          const v = attrs[j].value;
          if (!v) continue;
          if ((idStr && v.indexOf(idStr) !== -1) || (eidStr && v.indexOf(eidStr) !== -1)) {
            hit = true;
            break;
          }
        }
        if (hit) {
          // dump 它本身 + 祖先链
          let cur = el;
          const chain = [];
          for (let d = 0; d < 8 && cur; d++) {
            chain.push({
              tag: cur.tagName.toLowerCase(),
              cls: (cur.className && typeof cur.className === 'string') ? cur.className.slice(0, 80) : '',
              attrs: Array.prototype.slice.call(cur.attributes).map(function (a) {
                return a.name + '=' + (a.value || '').slice(0, 60);
              }).slice(0, 6)
            });
            cur = cur.parentElement;
          }
          result.matchedElementChain = chain;
          break;
        }
      }
    }

    return result;
  }

  // ===== 核心：单次 sayHi =====
  /**
   * 把一个函数+参数序列化成 Runtime.evaluate 能执行的字符串表达式
   * 形如 "(function(...){...})(arg1,arg2)";不能闭包外部变量(函数 toString 不带闭包)
   *
   * 参数:
   *   - fn: 要在页面里执行的函数(独立函数,不能引用外部变量)
   *   - args: 调用参数数组(必须可 JSON 序列化)
   *
   * 返回: 可被 chrome.debugger Runtime.evaluate 执行的表达式字符串
   */
  function buildExpression(fn, args) {
    const argList = (args || []).map(function (a) { return JSON.stringify(a); }).join(',');
    return '(' + fn.toString() + ')(' + argList + ')';
  }

  /**
   * 通过 chrome.debugger 在指定 tab 页面里执行一个函数,并取回返回值
   * 是 sayHi 注入 DOM 操作的核心通道(找按钮/滚动/诊断 都走这里)
   *
   * 参数:
   *   - target: { tabId } chrome.debugger 目标
   *   - fn: 在页面里执行的函数(不能闭包)
   *   - args: 调用参数数组
   *
   * 返回: 函数的返回值(已反序列化);页面里抛错统一变 PageEvalError
   */
  async function evalInPage(target, fn, args) {
    const result = await sendCmd(target, 'Runtime.evaluate', {
      expression: buildExpression(fn, args),
      returnByValue: true,
      awaitPromise: false
    });
    if (result.exceptionDetails) {
      throw err('PageEvalError', 'Runtime.evaluate 异常: ' + (result.exceptionDetails.text || JSON.stringify(result.exceptionDetails)));
    }
    return result.result && result.result.value;
  }

  /**
   * 用 chrome.debugger Input.dispatchMouseEvent 模拟一次"人类"鼠标点击
   * 拆成 mouseMoved → mousePressed → mouseReleased 三步,中间随机停顿,绕开 BOSS 反爬
   *
   * 参数:
   *   - target: { tabId } chrome.debugger 目标
   *   - x / y: 点击坐标(顶层 frame 视口坐标系)
   *
   * 返回: Promise(无返回值)
   */
  async function clickAt(target, x, y) {
    // 模拟人类操作的 3 步：mouseMoved → mousePressed → mouseReleased，中间随机停顿
    await sendCmd(target, 'Input.dispatchMouseEvent', {
      type: 'mouseMoved',
      x: x, y: y,
      button: 'none'
    });
    await sleep(30 + Math.random() * 80);
    await sendCmd(target, 'Input.dispatchMouseEvent', {
      type: 'mousePressed',
      x: x, y: y,
      button: 'left',
      clickCount: 1
    });
    await sleep(40 + Math.random() * 60);
    await sendCmd(target, 'Input.dispatchMouseEvent', {
      type: 'mouseReleased',
      x: x, y: y,
      button: 'left',
      clickCount: 1
    });
  }

  /**
   * 单次 sayHi 流程:attach → 找按钮 → 滚动到可视 → 再找一次 → 点击 → 找确认弹窗 → 二次点击 → detach
   *
   * 参数:
   *   - tabId: 当前 BOSS 浏览器 tab 的 id
   *   - candidateId: 候选人 uid(明文)
   *   - encryptUid: BOSS 加密 uid(可选,有些场景候选人卡 attr 只挂这个)
   *
   * 返回: { ok, candidateId, clickedAt, buttonText, ... };找不到卡片抛 SayHiCardNotFound
   */
  async function sayHiOnce(tabId, candidateId, encryptUid) {
    if (!tabId) throw err('SayHiInputError', '缺 tabId');
    if (!candidateId) throw err('SayHiInputError', '缺 candidateId');

    const target = { tabId: tabId };
    await attachDebugger(tabId);
    try {
      const args = [String(candidateId), String(encryptUid || '')];
      let found = await evalInPage(target, pageScript_findCardAndButton, args);
      if (!found || !found.ok) {
        throw err('SayHiCardNotFound', (found && found.error) || '找不到卡片', { hint: found && found.hint });
      }
      // 不在视口 → 滚动 → 再找一次（坐标会变）
      if (!found.inView) {
        await evalInPage(target, pageScript_scrollIntoView, args);
        await sleep(400 + Math.random() * 200); // 滚动动画完成
        found = await evalInPage(target, pageScript_findCardAndButton, args);
        if (!found || !found.ok) {
          throw err('SayHiCardNotFound', '滚动后再找仍失败：' + ((found && found.error) || ''));
        }
      }

      // 第一步：点"打招呼"按钮
      await clickAt(target, found.x, found.y);
      await sleep(500 + Math.random() * 300);  // 给 BOSS 弹确认对话框留时间

      // 第二步：找确认对话框 — 找到 → 二次点击；没找到 → 假定 BOSS 直接发出
      const confirm = await evalInPage(target, pageScript_findConfirmButton, []);
      let confirmClicked = false;
      if (confirm && confirm.ok) {
        await clickAt(target, confirm.x, confirm.y);
        await sleep(300);
        confirmClicked = true;
      }

      return {
        ok: true,
        candidateId: String(candidateId),
        clickedAt: Date.now(),
        buttonText: found.buttonText,
        buttonClass: found.buttonClass,
        cardClass: found.cardClass,
        matchStrategy: found.matchStrategy,
        confirmClicked: confirmClicked,
        confirmButtonText: confirm && confirm.buttonText
      };
    } finally {
      await detachDebugger(tabId);
    }
  }

  // ===== 队列管理 =====
  /**
   * 把一个评估"符合"的候选人塞进打招呼队列(去重 + 持久化)
   * 由 background.js 在 judge 出 PASS 结果后调用
   *
   * 参数:
   *   - item: { candidateId, encryptUid, tabId } 候选人入队信息
   *
   * 返回: Promise(无返回值;已在队列中则静默跳过)
   */
  async function enqueue(item) {
    if (!item || !item.candidateId) return;
    const cid = String(item.candidateId);
    // 已在队列里 / 已经处理过 → 跳过
    for (let i = 0; i < state.queue.length; i++) {
      if (state.queue[i].candidateId === cid) return;
    }
    state.queue.push({
      candidateId: cid,
      encryptUid: item.encryptUid || '',
      tabId: item.tabId || null,
      queuedAt: Date.now()
    });
    await saveState();
  }

  /**
   * 把指定候选人从队列里手动移除(HR 在 dashboard 点"撤回打招呼"用)
   *
   * 参数:
   *   - candidateId: 候选人 uid
   *
   * 返回: Promise(无返回值)
   */
  async function dequeue(candidateId) {
    const cid = String(candidateId);
    state.queue = state.queue.filter(function (q) { return q.candidateId !== cid; });
    await saveState();
  }

  /**
   * 返回当前 sayHi 状态快照(给 dashboard / sidepanel 展示用)
   * 含队列长度/前 10 条预览/是否休息中/还剩多久休息完
   *
   * 返回: { consumerOn, queueLength, queue, processedSinceRest, isResting, restRemainingMs, lastSaidAt }
   */
  function getStatus() {
    const now = Date.now();
    return {
      consumerOn: state.consumerOn,
      queueLength: state.queue.length,
      queue: state.queue.slice(0, 10),
      processedSinceRest: state.processedSinceRest,
      isResting: state.restUntil > now,
      restRemainingMs: Math.max(0, state.restUntil - now),
      lastSaidAt: state.lastSaidAt
    };
  }

  // ===== 消费器 =====
  // 设计：setInterval 每 1.5s 检查一次队首
  // - 在休息中 → 跳过
  // - 上一次还在跑 → 跳过（重入保护）
  // - 否则取队首：随机延迟 [delayMin, delayMax] 后执行
  /**
   * 消费器主体:取队首候选人发一次招呼,处理成功 / 失败 / 休息 三种结果
   * setInterval 每 1.5s 调一次,内部有 consuming 重入保护
   *
   * 返回: Promise(无返回值;所有异常已内部 catch 写回 evaluation,不抛上层)
   */
  async function consumeOne() {
    if (consuming) return;
    if (!state.consumerOn) return;
    if (state.queue.length === 0) return;
    if (state.restUntil > Date.now()) return;

    consuming = true;
    const item = state.queue[0];

    // 拿配置
    const cfg = (typeof self.BOSS_SAYHI_CONFIG_GETTER === 'function')
      ? self.BOSS_SAYHI_CONFIG_GETTER()
      : { delayMin: 1500, delayMax: 5000, restAfter: 30, restMinutes: [5, 10] };

    try {
      // 单次随机延迟（人类操作仿真）
      const delay = rand(cfg.delayMin || 1500, cfg.delayMax || 5000);
      await sleep(delay);
      // 再次确认还有意愿（消费期间用户可能关掉了）
      if (!state.consumerOn) { consuming = false; return; }

      const tabId = item.tabId || (typeof self.BOSS_LAST_TAB_GETTER === 'function' ? self.BOSS_LAST_TAB_GETTER() : null);
      if (!tabId) {
        await markCandidateGreeting(item.candidateId, {
          status: 'failed',
          error: '没有可用的 BOSS tab — 请打开 zhipin.com 推荐页',
          failedAt: Date.now()
        });
        // 出队，避免死锁
        state.queue.shift();
        await saveState();
        return;
      }

      const r = await sayHiOnce(tabId, item.candidateId, item.encryptUid);
      // 成功
      state.queue.shift();
      state.lastSaidAt = r.clickedAt;
      state.processedSinceRest += 1;
      await markCandidateGreeting(item.candidateId, {
        status: 'sent',
        sentAt: r.clickedAt,
        buttonText: r.buttonText
      });

      // 触发休息？
      const restAfter = cfg.restAfter || 30;
      if (state.processedSinceRest >= restAfter) {
        const rm = cfg.restMinutes || [5, 10];
        const restMin = (Array.isArray(rm) ? rm[0] : rm) || 5;
        const restMax = (Array.isArray(rm) ? rm[1] : rm) || 10;
        const restMins = restMin + Math.random() * (restMax - restMin);
        state.restUntil = Date.now() + Math.floor(restMins * 60000);
        state.processedSinceRest = 0;
        console.info('[SayHi] 进入休息模式 ' + restMins.toFixed(1) + ' 分钟');
      }
      await saveState();
    } catch (e) {
      console.error('[SayHi] 消费失败:', e);
      // 单个候选人失败 → 出队（不阻塞后续）+ 写失败状态
      state.queue.shift();
      await saveState();
      await markCandidateGreeting(item.candidateId, {
        status: 'failed',
        error: e.name + ': ' + e.message + (e.hint ? ' [' + e.hint + ']' : ''),
        failedAt: Date.now()
      });
    } finally {
      consuming = false;
    }
  }

  /**
   * 启动消费器:打开 consumerOn 标志 + 起 setInterval 定时器
   * 用户在 dashboard 打开"自动打招呼"开关时被 background.js 调用
   */
  function startConsumer() {
    state.consumerOn = true;
    if (consumerTimer) return;
    consumerTimer = setInterval(function () {
      consumeOne().catch(function (e) { console.error('[SayHi] consumer error:', e); });
    }, 1500);
  }
  /**
   * 停止消费器:关 consumerOn + 清定时器,但内存队列保留(下次开继续跑)
   */
  function stopConsumer() {
    state.consumerOn = false;
    if (consumerTimer) { clearInterval(consumerTimer); consumerTimer = null; }
  }

  /**
   * 把 sayHi 结果(sent/failed)写回对应候选人的评估记录,让 sidepanel 能渲染状态
   * 实际写库逻辑在 background.js 注册的 BOSS_EVAL_GREETING_PATCHER 里
   *
   * 参数:
   *   - candidateId: 候选人 uid
   *   - greeting: 招呼状态对象 { status, sentAt, error, failedAt, buttonText }
   *
   * 返回: Promise(无返回值;失败只打日志,不影响主流程)
   */
  async function markCandidateGreeting(candidateId, greeting) {
    const fn = self.BOSS_EVAL_GREETING_PATCHER;
    if (typeof fn === 'function') {
      try { await fn(String(candidateId), greeting); }
      catch (e) { console.error('[SayHi] greeting patcher failed:', e); }
    }
  }

  // ===== PoC 测试入口 =====
  // 测试 1：最小 attach + Runtime.evaluate（只验证 chrome.debugger 可用）
  async function testDebuggerAttach(tabId) {
    if (!tabId) throw err('TestError', '缺 tabId — 请确保有活动的 BOSS tab');
    const target = { tabId: tabId };
    await attachDebugger(tabId);
    try {
      const r = await sendCmd(target, 'Runtime.evaluate', {
        expression: 'JSON.stringify({ url: location.href, title: document.title })',
        returnByValue: true
      });
      const v = r.result && r.result.value;
      let parsed = null;
      try { parsed = JSON.parse(v); } catch (_e) {}
      return { ok: true, page: parsed || v };
    } finally {
      await detachDebugger(tabId);
    }
  }

  // 测试 2：完整 sayHi 一次（输入 candidateId + 可选 encryptUid）
  async function testSayHi(tabId, candidateId, encryptUid) {
    return await sayHiOnce(tabId, candidateId, encryptUid);
  }

  // 测试 3：诊断 BOSS DOM —— 当 sayHi 找不到卡片时用，dump 出 BOSS 实际 attr 命名
  async function testDiagnose(tabId, candidateId, encryptUid) {
    if (!tabId) throw err('TestError', '缺 tabId');
    const target = { tabId: tabId };
    await attachDebugger(tabId);
    try {
      return await evalInPage(target, pageScript_diagnose, [String(candidateId || ''), String(encryptUid || '')]);
    } finally {
      await detachDebugger(tabId);
    }
  }

  // ===== 启动 =====
  /**
   * 模块初始化:加载持久化状态(队列/休息计时)恢复到内存
   * 注意:不主动 startConsumer,由 background.js 按用户开关决定何时启动消费
   */
  async function init() {
    await loadState();
    // SW 重启后，状态恢复但队列消费需要 background 显式调 startConsumer / stopConsumer
    // 这里不主动启动，由 background.js 根据 sayHi.enabled 决定
  }

  global.BossSayHi = {
    init: init,
    enqueue: enqueue,
    dequeue: dequeue,
    getStatus: getStatus,
    startConsumer: startConsumer,
    stopConsumer: stopConsumer,
    sayHiOnce: sayHiOnce,
    testDebuggerAttach: testDebuggerAttach,
    testSayHi: testSayHi,
    testDiagnose: testDiagnose
  };
})(self);
