// BOSS Sniffer - content.js
// 运行在隔离世界 (ISOLATED world)，document_start 注入
// 职责：把主世界 inject.js 通过 window.postMessage 发出的捕获数据
//       转发到扩展的 service worker (background.js)

// 安全发消息：
// 1. 检查 chrome.runtime.id 是否存在——如果扩展被重载/卸载，这里会 undefined
// 2. try/catch 吞掉同步抛错（Extension context invalidated）
// 3. .catch 吞掉异步 rejection（service worker 唤醒失败、receiving end 不存在等）
function safeSend(message) {
  if (!chrome || !chrome.runtime || !chrome.runtime.id) {
    // extension context 已失效，旧 content script 不应该再尝试通信
    return;
  }
  try {
    const ret = chrome.runtime.sendMessage(message);
    if (ret && typeof ret.catch === 'function') {
      ret.catch(function () {});
    }
  } catch (e) {
    // "Extension context invalidated" 等同步异常
  }
}

// v0.13.0：沟通页扫描请求-响应配对
const pendingSayhiScans = {};
// v0.13.3：沟通页字段补全 fetch 请求-响应配对
const pendingFetchBatches = {};
// v0.14.0-pre：沟通页一键操作请求-响应配对
const pendingSayhiActions = {};
// v0.17.1.0：评估「符合」→ 输入话术 + 求简历 请求-响应配对
const pendingGreetThenResume = {};
// v0.16.0：tab 切换请求-响应配对
const pendingTabClicks = {};
// v0.17.0.10 POC A7：点击候选人 + 扫详情面板 请求-响应配对
const pendingClickAndScans = {};

window.addEventListener('message', function (event) {
  // 只接受同窗口的消息
  if (event.source !== window) return;
  const msg = event.data;
  if (!msg || msg.__bossSniffer !== true) return;

  if (msg.kind === 'capture') {
    safeSend({ type: 'CAPTURE', payload: msg.payload });
  } else if (msg.kind === 'detail-panel-scan') {
    // v0.17.0.10 POC A7 回灌：沟通页详情面板 DOM 扫描结果转发给 BG
    safeSend({
      type: 'DETAIL_PANEL_SCAN',
      candidateId: msg.candidateId,
      payload: msg.payload
    });
  } else if (msg.kind === 'ready') {
    safeSend({ type: 'INJECT_READY', url: location.href });
  } else if (msg.kind === 'scan-sayhi-result') {
    const cb = pendingSayhiScans[msg.requestId];
    if (cb) {
      delete pendingSayhiScans[msg.requestId];
      cb({
        ok: !!msg.ok,
        candidates: Array.isArray(msg.candidates) ? msg.candidates : [],
        stats: msg.stats || null,  // v0.13.2 诊断信息透传
        error: msg.error || null
      });
    }
  } else if (msg.kind === 'fetch-geek-info-batch-result') {
    // v0.13.3：沟通页字段补全 fetch 完成
    const cb = pendingFetchBatches[msg.requestId];
    if (cb) {
      delete pendingFetchBatches[msg.requestId];
      cb({
        ok: !!msg.ok,
        results: Array.isArray(msg.results) ? msg.results : [],
        error: msg.error || null
      });
    }
  } else if (msg.kind === 'execute-sayhi-action-result') {
    // v0.14.0-pre：沟通页一键操作完成
    const cb = pendingSayhiActions[msg.requestId];
    if (cb) {
      delete pendingSayhiActions[msg.requestId];
      cb({
        ok: !!msg.ok,
        result: msg.result || { ok: !!msg.ok, error: msg.error || null, logs: [] },
        error: msg.error || null
      });
    }
  } else if (msg.kind === 'execute-greet-then-resume-result') {
    // v0.17.1.0：输入话术 + 求简历 完成
    const cb = pendingGreetThenResume[msg.requestId];
    if (cb) {
      delete pendingGreetThenResume[msg.requestId];
      cb({
        ok: !!msg.ok,
        result: msg.result || { ok: !!msg.ok, error: msg.error || null, logs: [] },
        error: msg.error || null
      });
    }
  } else if (msg.kind === 'click-latest-tab-result') {
    // v0.16.0：最新 tab 切换完成
    const cb = pendingTabClicks[msg.requestId];
    if (cb) {
      delete pendingTabClicks[msg.requestId];
      cb({ ok: !!msg.ok, error: msg.error || null });
    }
  } else if (msg.kind === 'click-and-scan-detail-result') {
    // v0.17.0.10 POC A7：点击候选人 + 扫详情面板 完成
    const cb = pendingClickAndScans[msg.requestId];
    if (cb) {
      delete pendingClickAndScans[msg.requestId];
      cb({
        ok: !!msg.ok,
        uid: msg.uid || '',
        scan: msg.scan || null,
        error: msg.error || null,
        waitedMs: msg.waitedMs || null
      });
    }
  } else if (msg.kind === 'real-click-request') {
    // v0.24.7：inject.js 请求 chrome.debugger 真点击（isTrusted=true）
    // inject → content → BG → debugger 真点击 → BG response → content → inject
    const requestId = msg.requestId || '';
    chrome.runtime.sendMessage({
      type: 'REAL_CLICK_AT_COORDS',
      x: msg.x,
      y: msg.y
    }, function (resp) {
      const ok = !!(resp && resp.ok);
      const errMsg = (resp && resp.error)
        || (chrome.runtime.lastError && chrome.runtime.lastError.message)
        || (ok ? null : 'no-response');
      window.postMessage({
        __bossSniffer: true,
        kind: 'real-click-result',
        requestId: requestId,
        ok: ok,
        error: errMsg
      }, '*');
    });
  }
});

// === S6 推荐页循环：scheduler 触发滚动 ===
// 节流 1200ms（借鉴竞品 zhipinai-plugin v1.3.4 实测值）
let lastScrollAt = 0;
const SCROLL_THROTTLE_MS = 1200;

chrome.runtime.onMessage.addListener(function (msg, sender, sendResponse) {
  if (!msg || !msg.type) return false;

  if (msg.type === 'SCROLL_RECOMMEND_LIST') {
    const now = Date.now();
    if (now - lastScrollAt < SCROLL_THROTTLE_MS) {
      sendResponse({ ok: false, throttled: true });
      return false;
    }
    lastScrollAt = now;
    try {
      // BOSS 推荐流可能有自己的 overflow:scroll 容器（不是 window 滚），
      // window.scrollBy 对内部容器无效。改用 scrollIntoView 让浏览器自动
      // 找到最近可滚动祖先并 scroll —— 把"最后一张候选人卡片"推进视口
      // 即可触发 BOSS infinite scroll 的 IntersectionObserver / MutationObserver
      //
      // 选择器复用 sayHi.js:454-464 已验证过的卡片选择器集
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
      let foundCards = null;
      let foundSel = null;
      for (let i = 0; i < cardSelectors.length; i++) {
        const sel = cardSelectors[i];
        let els;
        try { els = document.querySelectorAll(sel); } catch (e) { continue; }
        if (els && els.length >= 3) {  // 至少 3 张才认为是候选人列表（防误识别）
          foundCards = els;
          foundSel = sel;
          break;
        }
      }

      if (foundCards && foundCards.length > 0) {
        // 滚到最后一张卡片让它进入视口底部（触发 sentinel）
        const lastCard = foundCards[foundCards.length - 1];
        lastCard.scrollIntoView({ behavior: 'smooth', block: 'end' });
        sendResponse({
          ok: true,
          method: 'scrollIntoView',
          selector: foundSel,
          cardCount: foundCards.length
        });
      } else {
        // 兜底：找不到卡片时 fallback window.scrollBy
        const dy = Math.max(320, Math.floor(window.innerHeight * 0.72));
        window.scrollBy({ top: dy, behavior: 'smooth' });
        sendResponse({ ok: true, method: 'scrollBy fallback', dy: dy });
      }
    } catch (e) {
      sendResponse({ ok: false, error: String(e) });
    }
    return false;
  }

  // v0.12.5：sidepanel 点候选人名字 → 在 BOSS 页面定位并滚动到对应卡片
  // 跨 frame：BOSS 把推荐流放在 iframe (/web/frame/recommend) 时也要能找到
  // 匹配策略：任意 attribute value 包含 candidateId 或 encryptUid
  // 与 sayHi.js:pageScript_scrollIntoView 同源同策略，不同点：
  //   - 走 chrome.runtime 消息而非 chrome.debugger（不弹"正在调试"黄条）
  //   - 找到后 1.5s 高亮闪烁，给 HR 视觉确认
  if (msg.type === 'SCROLL_TO_CANDIDATE') {
    try {
      const ids = [String(msg.candidateId || ''), String(msg.encryptUid || '')].filter(Boolean);
      if (ids.length === 0) { sendResponse({ ok: false, error: '缺 candidateId/encryptUid' }); return false; }

      // 收集 root：top + 同源 iframe
      const roots = [document];
      const iframes = document.querySelectorAll('iframe');
      for (let i = 0; i < iframes.length; i++) {
        try {
          const innerDoc = iframes[i].contentDocument;
          if (innerDoc) roots.push(innerDoc);
        } catch (_e) {}  // 跨域 iframe，跳过
      }

      // 在 root 内按 attribute value 包含 ID 找元素
      function findMatchEl(doc) {
        const all = doc.querySelectorAll('*');
        for (let i = 0; i < all.length; i++) {
          const el = all[i];
          const attrs = el.attributes;
          for (let j = 0; j < attrs.length; j++) {
            const v = attrs[j].value;
            if (!v || v.length < 4) continue;
            for (let k = 0; k < ids.length; k++) {
              if (v === ids[k] || v.indexOf(ids[k]) !== -1) return el;
            }
          }
        }
        return null;
      }

      // 从匹配元素往上找"卡片"祖先（用于高亮整张卡而不是单一 span）
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
        '.recommend-card',
        '.card-inner'
      ];
      function findCardAncestor(el) {
        let cur = el;
        for (let d = 0; d < 12 && cur; d++) {
          for (let s = 0; s < cardSelectors.length; s++) {
            try {
              if (cur.matches && cur.matches(cardSelectors[s])) return cur;
            } catch (_e) {}
          }
          cur = cur.parentElement;
        }
        // 找不到卡片祖先就用匹配元素本身
        return el;
      }

      let target = null;
      let foundIn = '';
      for (let r = 0; r < roots.length; r++) {
        const m = findMatchEl(roots[r]);
        if (m) { target = findCardAncestor(m); foundIn = r === 0 ? 'top' : 'iframe[' + (r - 1) + ']'; break; }
      }
      if (!target) {
        sendResponse({ ok: false, error: 'not-found', hint: '候选人可能已被虚拟列表回收，请滚动推荐流后重试' });
        return false;
      }

      target.scrollIntoView({ behavior: 'smooth', block: 'center' });

      // 高亮 1.5s：注入一次性 style + class
      try {
        const ownerDoc = target.ownerDocument || document;
        const STYLE_ID = 'boss-sniffer-locate-style';
        if (!ownerDoc.getElementById(STYLE_ID)) {
          const style = ownerDoc.createElement('style');
          style.id = STYLE_ID;
          style.textContent = '@keyframes bossSnifferLocate { 0% { box-shadow: 0 0 0 3px rgba(36,103,240,0.9); } 60% { box-shadow: 0 0 0 6px rgba(36,103,240,0.4); } 100% { box-shadow: 0 0 0 0 rgba(36,103,240,0); } } .boss-sniffer-locate-hit { animation: bossSnifferLocate 1.5s ease-out; border-radius: 6px; }';
          (ownerDoc.head || ownerDoc.documentElement).appendChild(style);
        }
        target.classList.add('boss-sniffer-locate-hit');
        setTimeout(function () {
          try { target.classList.remove('boss-sniffer-locate-hit'); } catch (_e) {}
        }, 1600);
      } catch (_e) { /* 高亮失败不影响主功能 */ }

      sendResponse({ ok: true, foundIn: foundIn });
    } catch (e) {
      sendResponse({ ok: false, error: String(e) });
    }
    return false;
  }

  // S6 fix: HR 在已加载完的 BOSS 页面开扩展点开始时，需要触发首次 fetch
  // location.reload() 在 page 上下文执行，等价于 F5
  // chrome.tabs.reload (扩展进程触发) 在某些场景下不灵，所以走 page 端
  if (msg.type === 'REFRESH_RECOMMEND_PAGE') {
    sendResponse({ ok: true });
    // 50ms 让 sendResponse 先返回，再 reload 杀掉 content
    setTimeout(function () {
      try { location.reload(); } catch (e) {}
    }, 50);
    return false;
  }

  // v0.16.0：BG 触发 inject 模拟点击 iframe 内的「最新」tab
  if (msg.type === 'CLICK_LATEST_TAB') {
    // 只在推荐 iframe 内处理；主页 / 其他 frame noop（让另一个 frame 响应）
    if (location.pathname.indexOf('/web/frame/recommend') === -1) {
      sendResponse({ ok: false, error: 'not in recommend iframe' });
      return false;
    }
    const reqId = 'tab-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8);
    let done = false;
    pendingTabClicks[reqId] = function (result) {
      if (done) return;
      done = true;
      sendResponse(result);
    };
    setTimeout(function () {
      if (pendingTabClicks[reqId]) {
        delete pendingTabClicks[reqId];
        if (!done) { done = true; sendResponse({ ok: false, error: 'click-latest-tab timeout' }); }
      }
    }, 10000);  // 10s 上限（inject _waitFor 8s + 缓冲）
    window.postMessage({
      __bossSniffer: true,
      kind: 'click-latest-tab-request',
      requestId: reqId
    }, '*');
    return true;  // async sendResponse
  }

  // v0.17.0.10 POC A7 阶段 b：BG 触发"点击候选人 + 扫详情面板"
  // BG → content → inject 点卡片 + 等渲染 + 扫 DOM → 完成回传
  if (msg.type === 'CLICK_AND_SCAN_DETAIL') {
    const reqId = 'cas-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8);
    let done = false;
    pendingClickAndScans[reqId] = function (result) {
      if (done) return;
      done = true;
      sendResponse(result);
    };
    // 5 秒超时（inject _waitFor 3s + 500ms scrollIntoView + 缓冲）
    setTimeout(function () {
      if (pendingClickAndScans[reqId]) {
        delete pendingClickAndScans[reqId];
        if (!done) { done = true; sendResponse({ ok: false, error: 'timeout', scan: null }); }
      }
    }, 5000);
    window.postMessage({
      __bossSniffer: true,
      kind: 'click-and-scan-detail-request',
      requestId: reqId,
      uid: msg.uid || '',
      timeoutMs: msg.timeoutMs || 3000
    }, '*');
    return true;  // async sendResponse
  }

  // v0.14.0-pre：沟通页一键操作触发
  // BG → content → inject 执行（点卡片+点按钮+等弹窗/卡片消失）→ 完成回传
  if (msg.type === 'EXECUTE_SAYHI_ACTION') {
    const reqId = 'act-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8);
    let done = false;
    pendingSayhiActions[reqId] = function (result) {
      if (done) return;
      done = true;
      sendResponse(result);
    };
    // 30 秒超时（求简历两步 + 等弹窗消失最多 ~14s，留 buffer）
    setTimeout(function () {
      if (pendingSayhiActions[reqId]) {
        delete pendingSayhiActions[reqId];
        if (!done) { done = true; sendResponse({ ok: false, result: { ok: false, error: 'timeout', logs: [] }, error: 'timeout' }); }
      }
    }, 30000);
    window.postMessage({
      __bossSniffer: true,
      kind: 'execute-sayhi-action-request',
      requestId: reqId,
      uid: msg.uid || '',
      action: msg.action || ''
    }, '*');
    return true;  // async sendResponse
  }

  // v0.17.1.0：评估「符合」→ 输入话术 + 求简历
  // BG → content → inject 执行（选卡片 → 输入话术 → 发送 → 求简历两步）→ 完成回传
  if (msg.type === 'EXECUTE_GREET_THEN_RESUME') {
    const reqId = 'gtr-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8);
    let done = false;
    pendingGreetThenResume[reqId] = function (result) {
      if (done) return;
      done = true;
      sendResponse(result);
    };
    // 45 秒超时（执行链路：选卡片 ~5s + 写话术 ~2s + 发送+等 ~4s + 求简历两步 ~9s = 20s 实际，留 buffer 应对慢加载）
    setTimeout(function () {
      if (pendingGreetThenResume[reqId]) {
        delete pendingGreetThenResume[reqId];
        if (!done) { done = true; sendResponse({ ok: false, result: { ok: false, error: 'timeout', logs: [] }, error: 'timeout' }); }
      }
    }, 45000);
    window.postMessage({
      __bossSniffer: true,
      kind: 'execute-greet-then-resume-request',
      requestId: reqId,
      uid: msg.uid || '',
      greetText: msg.greetText || '',
      dryRun: !!msg.dryRun
    }, '*');
    return true;  // async sendResponse
  }

  // v0.13.3：沟通页字段补全 fetch 触发
  // BG → content → inject 主动 fetch chat/geek/info × N（节流）→ 完成回传
  if (msg.type === 'TRIGGER_FETCH_GEEK_INFO_BATCH') {
    const reqId = 'fetch-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8);
    let done = false;
    pendingFetchBatches[reqId] = function (result) {
      if (done) return;
      done = true;
      sendResponse(result);
    };
    // 90 秒超时：13 人 × 4s 抖动 + 2 批次间停顿 ≈ 60s，留 buffer
    setTimeout(function () {
      if (pendingFetchBatches[reqId]) {
        delete pendingFetchBatches[reqId];
        if (!done) { done = true; sendResponse({ ok: false, results: [], error: 'timeout' }); }
      }
    }, 90000);
    window.postMessage({
      __bossSniffer: true,
      kind: 'fetch-geek-info-batch-request',
      requestId: reqId,
      items: msg.items || []
    }, '*');
    return true;  // async sendResponse
  }

  // v0.13.0：沟通页扫描请求
  // BG → content → inject (MAIN world) → 扫描 → 回 content → 回 BG
  // v0.13.1：inject 的 scanSayhiCards 改 async（要滚动 .user-list 扫虚拟列表），
  //         超时从 2s → 15s 给足时间扫完所有候选人
  if (msg.type === 'SCAN_SAYHI_TAB') {
    const reqId = 'scan-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8);
    let done = false;
    pendingSayhiScans[reqId] = function (result) {
      if (done) return;
      done = true;
      sendResponse(result);
    };
    setTimeout(function () {
      if (pendingSayhiScans[reqId]) {
        delete pendingSayhiScans[reqId];
        if (!done) { done = true; sendResponse({ ok: false, candidates: [], error: 'timeout' }); }
      }
    }, 15000);
    window.postMessage({
      __bossSniffer: true,
      kind: 'scan-sayhi-request',
      requestId: reqId
    }, '*');
    return true;  // async sendResponse
  }

  return false;
});
