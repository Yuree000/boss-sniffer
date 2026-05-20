// BOSS Sniffer - inject.js
// 运行在主世界 (MAIN world)，document_start 注入
// 职责：劫持 fetch 与 XMLHttpRequest，把响应原样转发给 content.js
//
// v0.3.5：相对 v0.3.4 的最小化改造——
//   ✗ 不再 hook XMLHttpRequest.prototype.setRequestHeader（v0.3.4 触发了未知副作用）
//   ✗ 不在 xhr 实例上挂 __bs_reqHeaders 属性
//   ✓ fetch hook 读 init.body / init.headers（纯 passive read，无新 hook）
//   ✓ XHR send hook 用闭包捕获 body 参数（不动 open）
//   → 代价：XHR 拿不到请求头；好处：与 v0.3.3 的差异面极小

(function () {
  'use strict';

  // v0.1.5：修复 v0.1.4 过滤导致 XHR 全漏的 bug。
  // 修复：用 URL API 解析（相对路径会被 location.origin 补全），再按 hostname 和 pathname 判断。
  const HOST_PATTERNS = ['zhipin.com'];

  // 排除埋点/监控（只看 path，不看 host）
  const EXCLUDE_PATTERNS = [
    '/wapi/zptrack/',
    '/wapi/zplog/',
    '/wapi/zpCommon/actionLog/',
    '/wapi/zpApm/'
  ];

  // 静态资源扩展名
  const STATIC_RE = /\.(js|css|png|jpe?g|gif|svg|webp|ico|woff2?|ttf|otf|eot|mp4|webm|mp3|wav|pdf|map)(\?|#|$)/i;

  // 敏感请求头：在 inject 内硬编码脱敏，永不写入 IndexedDB
  const SENSITIVE_HEADER_RE = /^(cookie|set-cookie|authorization|proxy-authorization)$/i;

  function shouldCapture(url) {
    if (!url) return false;
    let parsed;
    try {
      parsed = new URL(String(url), location.origin);
    } catch (e) {
      return false;
    }
    if (!HOST_PATTERNS.some((h) => parsed.hostname.endsWith(h))) return false;
    const pathAndQuery = parsed.pathname + parsed.search;
    if (EXCLUDE_PATTERNS.some((p) => pathAndQuery.includes(p))) return false;
    if (STATIC_RE.test(parsed.pathname)) return false;
    return true;
  }

  function safeJsonParse(text) {
    try {
      return JSON.parse(text);
    } catch (e) {
      return null;
    }
  }

  // 严格类型守护：返回值始终是 string / null / 普通对象（结构化克隆安全）
  // 不放任何 raw 不明对象出去，避免 postMessage 静默失败
  function safeStringifyBody(body) {
    if (body === null || body === undefined) return null;
    try {
      if (typeof body === 'string') return body;
      if (typeof body !== 'object') return String(body);
      if (body instanceof URLSearchParams) return body.toString();
      if (typeof FormData !== 'undefined' && body instanceof FormData) {
        const obj = {};
        body.forEach(function (v, k) {
          obj[k] = typeof v === 'string' ? v : '<File:' + (v.name || '?') + '>';
        });
        return { __formData: obj };
      }
      if (typeof Blob !== 'undefined' && body instanceof Blob) {
        return '<Blob:' + body.size + 'B,' + (body.type || '?') + '>';
      }
      if (body instanceof ArrayBuffer) {
        return '<ArrayBuffer:' + body.byteLength + 'B>';
      }
      if (ArrayBuffer.isView && ArrayBuffer.isView(body)) {
        return '<TypedArray:' + body.byteLength + 'B>';
      }
      // 未知 object：JSON 序列化兜底；失败返回类型名占位
      try {
        return JSON.stringify(body);
      } catch (e) {
        return '<' + ((body.constructor && body.constructor.name) || 'object') + '>';
      }
    } catch (e) {
      return '<unstringifiable>';
    }
  }

  function normalizeHeaders(headers) {
    if (!headers) return null;
    const out = {};
    try {
      if (typeof Headers !== 'undefined' && headers instanceof Headers) {
        headers.forEach(function (v, k) {
          out[k] = SENSITIVE_HEADER_RE.test(k) ? '<REDACTED>' : v;
        });
      } else if (Array.isArray(headers)) {
        for (let i = 0; i < headers.length; i++) {
          const k = headers[i][0];
          const v = headers[i][1];
          out[k] = SENSITIVE_HEADER_RE.test(k) ? '<REDACTED>' : v;
        }
      } else if (typeof headers === 'object') {
        const keys = Object.keys(headers);
        for (let i = 0; i < keys.length; i++) {
          const k = keys[i];
          out[k] = SENSITIVE_HEADER_RE.test(k) ? '<REDACTED>' : headers[k];
        }
      }
    } catch (e) {
      return null;
    }
    return out;
  }

  function postCapture(payload) {
    try {
      window.postMessage(
        { __bossSniffer: true, kind: 'capture', payload: payload },
        '*'
      );
    } catch (e) {
      // 某些响应体过大序列化失败时静默忽略
    }
  }

  // ============ 0.5. 沟通页详情面板 DOM 扫描（v0.17.0.10 POC A7 回灌）============
  // 触发：BOSS 自调 chat/geek/info 后延迟 500ms 扫一次（详情面板那时已渲染）。
  // 输出：纯对象（rawScan），inject 不解析，extractor.extractFromDetailPanel 在 BG 侧做标准化。
  // 风控：被动扫描，零模拟点击，零额外接口请求，HR 自己点开候选人才触发。

  // v0.18.0：删除 description / tagItem 两个永远 miss 的 selector 字典项
  //   POC A7/A9/A10 实测：BOSS 沟通页详情面板**没有**简介 / 技能字段，
  //   v0.17.1.2 起改在「在线简历」弹窗的 iframe 里抓 resumeFullText（含简介+技能+完整经历）
  //   原 .geek-desc / .self-introduction / .tag-item / .skill-tag 等 class 是 PoC A7 v0.1 阶段
  //   按竞品 v1.3.4 字典抄过来的猜测值，实测 BOSS 未使用，全是 dead selector
  const DETAIL_SELECTORS = {
    detailRoot: ['.base-info-single-container', '.base-info-single'],
    name: [
      '.base-info-single-top .base-info-item',
      '.base-info-single-top-detail .base-info-item',
      '.base-info-item'
    ],
    baseStats: ['.base-info-single-detial', '.base-info-single-detail'],
    expectContent: ['.expect'],
    workEduList: ['.detail-list', '.work-content'],
    resumeCard: ['.item-resume', '.message-card-wrap']
  };

  function _detailFindOne(root, candidates) {
    if (!root) return { node: null, selector: null };
    for (let i = 0; i < candidates.length; i++) {
      try {
        const node = root.querySelector(candidates[i]);
        if (node) return { node: node, selector: candidates[i] };
      } catch (e) {}
    }
    return { node: null, selector: null };
  }

  function _detailFindAll(root, candidates) {
    if (!root) return { nodes: [], selector: null };
    for (let i = 0; i < candidates.length; i++) {
      try {
        const list = root.querySelectorAll(candidates[i]);
        if (list && list.length) return { nodes: Array.from(list), selector: candidates[i] };
      } catch (e) {}
    }
    return { nodes: [], selector: null };
  }

  function _detailTxt(node) {
    if (!node) return '';
    return String(node.textContent || '').replace(/\s+/g, ' ').trim();
  }

  function scanDetailPanelDom() {
    const rootHit = _detailFindOne(document, DETAIL_SELECTORS.detailRoot);
    if (!rootHit.node) return null;
    const root = rootHit.node;

    const nameHit = _detailFindOne(root, DETAIL_SELECTORS.name);
    const statsHit = _detailFindOne(root, DETAIL_SELECTORS.baseStats);
    const expectHit = _detailFindOne(root, DETAIL_SELECTORS.expectContent);
    const workEduHit = _detailFindOne(root, DETAIL_SELECTORS.workEduList);
    let rcHit = _detailFindOne(root, DETAIL_SELECTORS.resumeCard);
    if (!rcHit.node) rcHit = _detailFindOne(document, DETAIL_SELECTORS.resumeCard);

    // v0.18.0：descText / skillTags 字段删除——详情面板永远没这些，简介+技能改由在线简历 iframe 提供
    return {
      scannedAt: Date.now(),
      candidateName: nameHit.node ? _detailTxt(nameHit.node) : null,
      baseStats: statsHit.node ? _detailTxt(statsHit.node) : null,
      expectRaw: expectHit.node ? _detailTxt(expectHit.node) : null,
      workEduListRaw: workEduHit.node ? _detailTxt(workEduHit.node) : null,
      resumeCardRaw: rcHit.node ? _detailTxt(rcHit.node) : null,
      domHits: {
        detailRoot: rootHit.selector,
        name: nameHit.selector,
        baseStats: statsHit.selector,
        expect: expectHit.selector,
        workEduList: workEduHit.selector,
        resumeCard: rcHit.selector
      }
    };
  }

  // v0.17.0.10 POC A7 阶段 b：模拟点击候选人 + 等详情面板渲染 + 扫 DOM
  // 用于"一键评估"批量流程中每个候选人评估前补字段
  // 风控约束：每次点击间隔由 BG 控制（2-3s 抖动），本函数只做单人操作
  //
  // 流程：
  //   1. 找 .geek-item[uid=X] 卡片
  //   2. 记录点击前 .base-info-single-container 的文本片段（用于检测切换）
  //   3. 模拟点击卡片（BOSS 自调 chat/geek/info → 详情面板异步渲染）
  //   4. 用 _waitFor 等"详情面板文本变化"（候选人切换的信号），超时 timeoutMs
  //   5. 调 scanDetailPanelDom → rawScan
  //   6. v0.17.1.2：尝试点击「在线简历」按钮 → 等弹窗 → 拿 iframe.contentDocument.body.textContent → ESC 关闭
  //      失败时静默 fallback（rawScan.resumeFullText=null），仍返回 ok:true
  //
  // 错误返回：{ ok: false, error: 'card-not-found' | 'detail-panel-not-rendered' | 'scan-empty', uid }

  // v0.17.1.2 在线简历 iframe 扫描 helpers
  // POC A10 验证：「在线简历」按钮 span 含文本「在线简历」，点击后弹 .boss-dialog.resume-container，
  //              里面有 .iframe-resume-detail > iframe[src*="c-resume"]，同源可直接读 contentDocument

  // 找「在线简历」按钮：限定在 detailRoot 内、纯文本「在线简历」、可见可点
  function _findOnlineResumeButton() {
    const roots = document.querySelectorAll('.base-info-single-container, .base-info-single');
    const scopes = roots.length ? Array.from(roots) : [document.body];
    for (let i = 0; i < scopes.length; i++) {
      try {
        const walker = document.createTreeWalker(scopes[i], NodeFilter.SHOW_TEXT, null);
        let node;
        while ((node = walker.nextNode())) {
          if ((node.textContent || '').trim() !== '在线简历') continue;
          const el = node.parentElement;
          if (!el) continue;
          const r = el.getBoundingClientRect();
          if (!r.width || !r.height) continue;
          return el;
        }
      } catch (e) {}
    }
    return null;
  }

  // 等待简历弹窗出现 + iframe 加载完成；返回 iframe.contentDocument 或 null
  async function _waitForResumeIframe(timeoutMs) {
    const start = Date.now();
    // 第一阶段：等 .boss-dialog.resume-container 出现
    const dialog = await _waitFor(function () {
      return document.querySelector('.boss-dialog.resume-container') ||
             document.querySelector('[class*="resume-container"]');
    }, timeoutMs || 4000, 150);
    if (!dialog) return { ok: false, error: 'resume-dialog-not-appear', waited: Date.now() - start };
    // 第二阶段：找弹窗内的 iframe（POC A10 验证 src 含 c-resume）
    const iframe = await _waitFor(function () {
      return dialog.querySelector('iframe[src*="c-resume"]') ||
             dialog.querySelector('.iframe-resume-detail iframe') ||
             dialog.querySelector('iframe');
    }, 3000, 150);
    if (!iframe) return { ok: false, error: 'resume-iframe-not-found', waited: Date.now() - start };
    // 第三阶段：等 iframe.contentDocument.body 有实际内容（不是空 body / loading）
    const doc = await _waitFor(function () {
      try {
        const cd = iframe.contentDocument;
        if (!cd || !cd.body) return null;
        if (cd.readyState && cd.readyState !== 'complete' && cd.readyState !== 'interactive') return null;
        const text = (cd.body.textContent || '').replace(/\s+/g, ' ').trim();
        if (text.length < 50) return null;  // 还没渲染完
        return cd;
      } catch (e) {
        // 跨域访问（理论上不会，同源 zhipin.com，但兜底）
        return null;
      }
    }, 4000, 200);
    if (!doc) return { ok: false, error: 'resume-iframe-empty', waited: Date.now() - start };
    return { ok: true, iframe: iframe, contentDoc: doc, dialog: dialog, waitedMs: Date.now() - start };
  }

  // 关闭简历弹窗：ESC 主路径 + click .boss-popup__close / dialog 外部 overlay 兜底
  async function _closeResumeDialog() {
    // 主路径：ESC
    try {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', keyCode: 27, which: 27, bubbles: true }));
      document.dispatchEvent(new KeyboardEvent('keyup', { key: 'Escape', code: 'Escape', keyCode: 27, which: 27, bubbles: true }));
    } catch (e) {}
    // 等 200ms 看 dialog 是否消失
    const gone = await _waitFor(function () {
      return !document.querySelector('.boss-dialog.resume-container');
    }, 800, 80);
    if (gone) return { ok: true, via: 'esc' };
    // 兜底：找 dialog 内 close-like 按钮（span.close / .boss-popup__close / svg use=#icon-close）
    const dialog = document.querySelector('.boss-dialog.resume-container');
    if (dialog) {
      let closeEl = null;
      const candidates = dialog.querySelectorAll('.boss-popup__close, [class*="dialog__close"], [class*="popup-close"], .close-icon, .icon-close');
      for (let i = 0; i < candidates.length; i++) {
        const r = candidates[i].getBoundingClientRect();
        if (r.width && r.height) { closeEl = candidates[i]; break; }
      }
      if (closeEl) {
        try { closeEl.click(); } catch (e) {}
        const gone2 = await _waitFor(function () {
          return !document.querySelector('.boss-dialog.resume-container');
        }, 800, 80);
        if (gone2) return { ok: true, via: 'click-close-icon' };
      }
    }
    return { ok: false, via: null };
  }

  // 扫在线简历 iframe 的完整文本：返回 { ok, resumeFullText, error, waitedMs, viaClose }
  // 失败时不抛错，调用方决定是否 fallback 到详情面板字段
  async function _scanResumeIframe() {
    const btn = _findOnlineResumeButton();
    if (!btn) return { ok: false, error: 'online-resume-button-not-found' };
    try { btn.click(); } catch (e) { return { ok: false, error: 'click-online-resume-threw: ' + ((e && e.message) || e) }; }
    const w = await _waitForResumeIframe(4000);
    if (!w.ok) {
      // 失败也要尝试关掉（可能弹窗出来一半）
      await _closeResumeDialog();
      return { ok: false, error: w.error, waited: w.waited };
    }
    let resumeFullText = '';
    try {
      resumeFullText = (w.contentDoc.body.textContent || '').replace(/\s+/g, ' ').trim();
    } catch (e) {
      await _closeResumeDialog();
      return { ok: false, error: 'read-iframe-text-threw: ' + ((e && e.message) || e) };
    }
    const closeResult = await _closeResumeDialog();
    return {
      ok: true,
      resumeFullText: resumeFullText,
      resumeTextLen: resumeFullText.length,
      waitedMs: w.waitedMs,
      viaClose: closeResult.via || null
    };
  }

  async function _clickAndScanDetail(uid, timeoutMs) {
    timeoutMs = typeof timeoutMs === 'number' ? timeoutMs : 3000;
    if (!uid) return { ok: false, error: 'no-uid', uid: '' };

    const card = _findSayhiCardByUid(uid);
    if (!card) return { ok: false, error: 'card-not-found', uid: String(uid) };

    // 记录点击前的状态（检测切换）
    const prevContainer = document.querySelector('.base-info-single-container');
    const prevText = prevContainer ? (prevContainer.textContent || '').replace(/\s+/g, ' ').slice(0, 120) : '';

    // 模拟点击：先用 el.click()（无 DevTools 黄条）
    try {
      card.scrollIntoView({ block: 'center', behavior: 'instant' });
    } catch (e) { /* scrollIntoView 不支持就忽略 */ }
    try {
      card.click();
    } catch (e) {
      return { ok: false, error: 'click-threw: ' + (e && e.message), uid: String(uid) };
    }

    // 等详情面板渲染/切换：文本变化 + 至少存在 .base-info-single-container
    const clickedAt = Date.now();
    const container = await _waitFor(function () {
      const cur = document.querySelector('.base-info-single-container');
      if (!cur) return null;
      const curText = (cur.textContent || '').replace(/\s+/g, ' ').slice(0, 120);
      // 文本相同且时间很近 → 切换尚未发生，继续等
      if (curText === prevText && Date.now() - clickedAt < 800) return null;
      return cur;
    }, timeoutMs, 150);

    if (!container) {
      return { ok: false, error: 'detail-panel-not-rendered', uid: String(uid), waited: Date.now() - clickedAt };
    }

    const rawScan = scanDetailPanelDom();
    if (!rawScan) {
      return { ok: false, error: 'scan-empty', uid: String(uid) };
    }

    // v0.17.1.2 在线简历 iframe 扫描：失败不影响主流程，rawScan.resumeFullText=null 即可
    let resumeScan = null;
    try {
      resumeScan = await _scanResumeIframe();
    } catch (e) {
      resumeScan = { ok: false, error: 'scan-resume-iframe-threw: ' + ((e && e.message) || e) };
    }
    if (resumeScan && resumeScan.ok) {
      rawScan.resumeFullText = resumeScan.resumeFullText;
      rawScan.resumeTextLen = resumeScan.resumeTextLen;
    } else {
      rawScan.resumeFullText = null;
      rawScan.resumeScanError = (resumeScan && resumeScan.error) || 'unknown';
    }

    return { ok: true, uid: String(uid), scan: rawScan, waitedMs: Date.now() - clickedAt };
  }

  // 在 chat/geek/info 响应到达后触发：BOSS 这时正在异步渲染详情面板，500ms 后 DOM 已稳定
  // 失败静默（不影响 fetch 主路径，不打扰 HR）
  function _maybeTriggerDetailScan(url, responseData) {
    try {
      if (!url || url.indexOf('/chat/geek/info') === -1) return;
      // 拿 candidate uid：优先从 URL ?uid=xxx，fallback 从响应体
      let uid = null;
      try {
        const u = new URL(url, location.origin);
        uid = u.searchParams.get('uid');
      } catch (e) {}
      if (!uid && responseData && responseData.zpData && responseData.zpData.data) {
        uid = String(responseData.zpData.data.uid || '');
      }
      if (!uid) return;
      // 延迟 500ms 等 BOSS 渲染详情面板（实测：候选人切换后渲染 ≈ 200-400ms）
      setTimeout(function () {
        try {
          const rawScan = scanDetailPanelDom();
          if (!rawScan) return;
          window.postMessage({
            __bossSniffer: true,
            kind: 'detail-panel-scan',
            candidateId: String(uid),
            payload: rawScan
          }, '*');
        } catch (e) {}
      }, 500);
    } catch (e) {}
  }

  // ============ 1. 劫持 fetch ============
  const originalFetch = window.fetch;

  function hookedFetch() {
    const args = arguments;
    const reqUrl =
      typeof args[0] === 'string'
        ? args[0]
        : args[0] && args[0].url
        ? args[0].url
        : '';
    const reqMethod = (args[1] && args[1].method) || 'GET';

    // v0.3.5：passive read 请求体/请求头（不安装新 hook）
    let reqBody = null;
    let reqHeaders = null;
    try {
      if (args[1]) {
        if (args[1].body !== undefined) reqBody = safeStringifyBody(args[1].body);
        if (args[1].headers) reqHeaders = normalizeHeaders(args[1].headers);
      }
      if (!reqHeaders && args[0] && typeof args[0] === 'object' && args[0].headers) {
        reqHeaders = normalizeHeaders(args[0].headers);
      }
    } catch (e) {
      // 任何读取异常都吞掉，绝不影响 fetch 主流程
    }

    return originalFetch.apply(this, args).then(function (response) {
      try {
        const finalUrl = response.url || reqUrl;
        if (shouldCapture(finalUrl) && response.ok) {
          const cloned = response.clone();
          cloned
            .text()
            .then(function (text) {
              const data = safeJsonParse(text);
              if (data !== null) {
                postCapture({
                  via: 'fetch',
                  url: finalUrl,
                  method: reqMethod,
                  status: response.status,
                  data: data,
                  requestBody: reqBody,
                  requestHeaders: reqHeaders,
                  capturedAt: Date.now()
                });
                // v0.17.0.10 POC A7 回灌：chat/geek/info 响应后延迟扫详情面板 DOM
                _maybeTriggerDetailScan(finalUrl, data);
              }
            })
            .catch(function () {});
        }
      } catch (e) {}
      return response;
    });
  }

  // ============ 2. 劫持 XMLHttpRequest ============
  // 注意：v0.3.5 故意不 hook setRequestHeader（v0.3.4 引入了不明副作用）
  // 不在 xhr 实例上加新属性，仅复用 v0.3.3 已有的 __bs_url / __bs_method
  const originalXHROpen = XMLHttpRequest.prototype.open;
  const originalXHRSend = XMLHttpRequest.prototype.send;

  function hookedXHROpen(method, url) {
    try {
      this.__bs_url = url;
      this.__bs_method = method;
    } catch (e) {}
    return originalXHROpen.apply(this, arguments);
  }

  function hookedXHRSend() {
    const xhr = this;
    const url = xhr.__bs_url;
    const method = xhr.__bs_method;

    // v0.3.5：闭包内捕获 body 参数；不写到 xhr 实例属性上
    let capturedBody = null;
    try {
      if (arguments.length > 0 && arguments[0] !== null && arguments[0] !== undefined) {
        capturedBody = safeStringifyBody(arguments[0]);
      }
    } catch (e) {}

    if (shouldCapture(url)) {
      xhr.addEventListener('load', function () {
        try {
          if (xhr.status >= 200 && xhr.status < 300) {
            let data = null;
            const rt = xhr.responseType;
            if (rt === '' || rt === 'text') {
              data = safeJsonParse(xhr.responseText);
            } else if (rt === 'json') {
              data = xhr.response;
            }
            if (data !== null) {
              postCapture({
                via: 'xhr',
                url: url,
                method: method,
                status: xhr.status,
                data: data,
                requestBody: capturedBody,
                requestHeaders: null, // v0.3.5：故意为 null，未 hook setRequestHeader
                capturedAt: Date.now()
              });
              // v0.17.0.10 POC A7 回灌
              _maybeTriggerDetailScan(url, data);
            }
          }
        } catch (e) {}
      });
    }
    return originalXHRSend.apply(this, arguments);
  }

  // ============ 3. 反劫持 toString，伪装成 native ============
  // Boss 风控可能调用 window.fetch.toString() 检测是否被改写
  const NATIVE_FETCH_STR = 'function fetch() { [native code] }';
  const NATIVE_OPEN_STR = 'function open() { [native code] }';
  const NATIVE_SEND_STR = 'function send() { [native code] }';

  hookedFetch.toString = function () {
    return NATIVE_FETCH_STR;
  };
  hookedXHROpen.toString = function () {
    return NATIVE_OPEN_STR;
  };
  hookedXHRSend.toString = function () {
    return NATIVE_SEND_STR;
  };

  const originalFnToString = Function.prototype.toString;
  Function.prototype.toString = new Proxy(originalFnToString, {
    apply: function (target, thisArg, argumentsList) {
      if (thisArg === hookedFetch) return NATIVE_FETCH_STR;
      if (thisArg === hookedXHROpen) return NATIVE_OPEN_STR;
      if (thisArg === hookedXHRSend) return NATIVE_SEND_STR;
      return Reflect.apply(target, thisArg, argumentsList);
    }
  });

  // ============ 4. 安装 hook ============
  window.fetch = hookedFetch;
  XMLHttpRequest.prototype.open = hookedXHROpen;
  XMLHttpRequest.prototype.send = hookedXHRSend;

  // ============ 5. WebSocket hook (v0.12.10 Step A：沟通页新招呼) ============
  // 业务背景：BOSS 沟通页候选人列表通过 WebSocket 推送（详见 POC A4-沟通页WebSocket验证）
  // Step A 仅把业务 WS message 落库到 captures store（kind: 'ws'），不解析、不进评估流水线
  // Step B 在 service worker 加 ws-parser 后再接通沟通页评估

  const OriginalWebSocket = window.WebSocket;
  if (OriginalWebSocket) {
    // 业务 WS URL 锁定：只抓 BOSS IM 主通道（wss://ws*.zhipin.com/chatws）
    // POC 验证：DevTools 127.0.0.1:9222 等噪音直接 bypass
    function isBusinessWsUrl(url) {
      if (!url) return false;
      const s = String(url);
      return s.indexOf('zhipin.com') !== -1 && s.indexOf('chatws') !== -1;
    }

    // 心跳过滤：≤ 8 字节丢弃（典型 hex c0 00 / d0 00 等保活帧）
    const WS_MIN_BYTES = 9;

    function abToHex(buf) {
      const view = new Uint8Array(buf);
      const len = view.length;
      let out = '';
      for (let i = 0; i < len; i++) {
        const h = view[i].toString(16);
        out += h.length === 1 ? '0' + h : h;
      }
      return out;
    }

    let wsIdSeq = 0;
    const NATIVE_WS_STR = 'function WebSocket() { [native code] }';

    function HookedWebSocket(url, protocols) {
      const ws = protocols === undefined
        ? new OriginalWebSocket(url)
        : new OriginalWebSocket(url, protocols);
      if (!isBusinessWsUrl(url)) return ws;  // 非业务 WS 直接 bypass，零开销

      const myId = ++wsIdSeq;

      function emit(wsEvent, extra) {
        try {
          postCapture(Object.assign({
            via: 'ws',
            url: String(url),
            wsId: myId,
            wsEvent: wsEvent,
            capturedAt: Date.now()
          }, extra || {}));
        } catch (e) {}
      }

      ws.addEventListener('open', function () { emit('open'); });
      ws.addEventListener('close', function (event) {
        emit('close', { wsCloseCode: event.code, wsCloseReason: event.reason || '' });
      });
      ws.addEventListener('message', function (event) {
        const d = event.data;
        if (typeof d === 'string') {
          if (d.length < WS_MIN_BYTES) return;
          emit('message', { wsData: { kind: 'text', len: d.length, text: d } });
        } else if (d instanceof ArrayBuffer) {
          if (d.byteLength < WS_MIN_BYTES) return;
          emit('message', { wsData: { kind: 'arraybuffer', byteLength: d.byteLength, hex: abToHex(d) } });
        } else {
          emit('message', { wsData: { kind: 'unsupported', ctor: (d && d.constructor && d.constructor.name) || '?' } });
        }
      });

      return ws;
    }

    // 复制 prototype + 常量（让 ws instanceof WebSocket 仍为 true）
    HookedWebSocket.prototype = OriginalWebSocket.prototype;
    HookedWebSocket.CONNECTING = OriginalWebSocket.CONNECTING;
    HookedWebSocket.OPEN = OriginalWebSocket.OPEN;
    HookedWebSocket.CLOSING = OriginalWebSocket.CLOSING;
    HookedWebSocket.CLOSED = OriginalWebSocket.CLOSED;

    // 反劫持
    HookedWebSocket.toString = function () { return NATIVE_WS_STR; };

    window.WebSocket = HookedWebSocket;
  }

  // ============ 6. 沟通页 DOM/Vue 扫描（v0.13.0：沟通页新招呼 MVP）============
  // 业务背景：BOSS 沟通页列表数据不走 HTTP fetch/XHR，也不走 WS 业务推送（WS 只跑心跳）
  //   → 候选人列表数据存在前端 SPA 的 Vue 实例 props 里
  //   → 借鉴竞品 zhipinai v1.3.4 §5.3 的 Vue 反射技巧，扩展到批量扫描
  // POC A5 v0.3.0 验证：.geek-item 选择器命中卡片 + __vue__ 含 20 字段明文 props
  // 由 content.js 通过 window.postMessage 触发，扫描结果回传

  // v0.13.1：BOSS 沟通页用虚拟列表（DOM 同时只渲染 ~40 张，远离视口的卸载），
  // 单次 querySelectorAll 只能扫到 DOM 当前存在的卡片。
  // 解决：滚 .user-list 容器多次 + 每次扫一遍 + 按 uid 去重。
  // 同时按 offsetWidth/offsetHeight > 0 过滤当前 sub-tab 不可见的卡片。

  function isCardVisible(card) {
    if (!card) return false;
    // v0.13.2：去掉 offsetWidth/offsetHeight === 0 检查 —— 虚拟列表里未渲染的卡片
    // 可能占位 0 高度，会被误过滤导致整张扫描返回 0。
    // 只过滤明确"隐藏"的（display:none / visibility:hidden）。
    try {
      const style = window.getComputedStyle(card);
      if (style.display === 'none' || style.visibility === 'hidden') return false;
    } catch (e) {}
    return true;
  }

  function scanSayhiCardsOnce(scope, dedup) {
    let cards = [];
    try { cards = Array.from(scope.querySelectorAll('.geek-item')); } catch (e) {}
    if (!cards.length) {
      try { cards = Array.from(scope.querySelectorAll('.geek-item-wrap')); } catch (e) {}
    }
    let added = 0;
    for (let i = 0; i < cards.length; i++) {
      const card = cards[i];
      if (!isCardVisible(card)) continue;
      const vue = findGeekVueData(card);
      if (!vue || !vue.uid) continue;
      const uid = String(vue.uid);
      if (dedup.has(uid)) continue;
      const visibleText = (card.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 500);
      dedup.set(uid, {
        uid: uid,
        encryptUid: vue.encryptUid || null,
        securityId: vue.securityId || null,
        encryptJobId: vue.encryptJobId || null,
        name: vue.name || null,
        avatar: vue.avatar || null,
        jobName: vue.jobName || null,
        lastWorkExpr: vue.lastWorkExpr || null,
        degree: vue.degree || null,
        expectSalary: vue.expectSalary || null,
        sourceTitle: vue.sourceTitle || null,
        relationType: vue.relationType || null,
        visibleText: visibleText,
        indexInBatch: dedup.size  // 按扫到顺序赋 index
      });
      added++;
    }
    return added;
  }

  function findScrollContainer(scope) {
    // BOSS 沟通页滚动容器：.user-list（POC A5 v0.3.0 确认）
    let els;
    try { els = scope.querySelectorAll('.user-list'); } catch (e) { return null; }
    for (let i = 0; i < els.length; i++) {
      const el = els[i];
      if (el.scrollHeight > el.clientHeight + 5) return el;
    }
    // fallback：找 .user-container 或 .chat-user
    try { els = scope.querySelectorAll('.user-container, .chat-user'); } catch (e) { return null; }
    for (let i = 0; i < els.length; i++) {
      const el = els[i];
      if (el.scrollHeight > el.clientHeight + 5) return el;
    }
    return null;
  }

  function sleep(ms) {
    return new Promise(function (r) { setTimeout(r, ms); });
  }

  async function scanSayhiCards() {
    const roots = [document];
    const iframes = document.querySelectorAll('iframe');
    for (let i = 0; i < iframes.length; i++) {
      try { if (iframes[i].contentDocument) roots.push(iframes[i].contentDocument); } catch (e) {}
    }

    const dedup = new Map();

    for (let r = 0; r < roots.length; r++) {
      const root = roots[r];
      const scope = root.body || root.documentElement;
      if (!scope) continue;

      // v0.13.2：先用 DOM 数量判断 root 有无候选人卡片（不依赖首次扫的入池数）
      // 之前用 "firstAdded === 0 continue"，虚拟列表里所有卡片可能 offsetHeight=0
      // 被旧版 isCardVisible 过滤掉 → 首扫为 0 → 跳过 root → 永远不滚动
      let cardDomCount = 0;
      try { cardDomCount = scope.querySelectorAll('.geek-item').length; } catch (e) {}
      if (cardDomCount === 0) {
        try { cardDomCount = scope.querySelectorAll('.geek-item-wrap').length; } catch (e) {}
      }
      if (cardDomCount === 0) continue;  // 这个 root 没有候选人卡片 DOM

      // 第一次扫（即使因可见性过滤为 0 也照样进滚动流程）
      scanSayhiCardsOnce(scope, dedup);

      // 找滚动容器，没找到就退化为单次扫描（不滚）
      const scrollEl = findScrollContainer(scope);
      if (!scrollEl) break;

      // v0.13.2：滚动容器可能用了非原生 scroll 库（class 含 b-scroll-stable），
      // 设 scrollTop 后主动 dispatch scroll 事件触发其内部监听
      function applyScroll(top) {
        try { scrollEl.scrollTop = top; } catch (e) {}
        try { scrollEl.dispatchEvent(new Event('scroll', { bubbles: true })); } catch (e) {}
      }

      // 滚动 + 多次扫描
      const origScrollTop = scrollEl.scrollTop;
      applyScroll(0);
      await sleep(300);
      scanSayhiCardsOnce(scope, dedup);

      const MAX_STEPS = 40;            // 防止无限循环（40 * 250 = 10s 上限）
      const STEP_RATIO = 0.7;          // 每次滚 70% 视口高度
      let lastScrollTop = -1;
      let stableCount = 0;
      for (let s = 0; s < MAX_STEPS; s++) {
        const prevTop = scrollEl.scrollTop;
        const target = Math.min(
          prevTop + scrollEl.clientHeight * STEP_RATIO,
          scrollEl.scrollHeight - scrollEl.clientHeight
        );
        applyScroll(target);
        await sleep(250);

        const added = scanSayhiCardsOnce(scope, dedup);

        // 滚动停止判定：scrollTop 不再增加 + 已到 scrollHeight 底部 + 多次扫描无新增
        if (Math.abs(scrollEl.scrollTop - lastScrollTop) < 1) {
          stableCount++;
        } else {
          stableCount = 0;
        }
        lastScrollTop = scrollEl.scrollTop;

        const atBottom = scrollEl.scrollTop + scrollEl.clientHeight >= scrollEl.scrollHeight - 5;
        if (atBottom && stableCount >= 1) break;
        if (added === 0 && stableCount >= 2) break;
      }

      // 回滚到原位置
      applyScroll(origScrollTop);
      break;  // 找到含候选人 DOM 的 root 就结束
    }

    // v0.13.2 诊断：扫到 0 时给 sidepanel 一些 stats 反馈
    let domTotal = 0;
    try { domTotal = document.querySelectorAll('.geek-item').length; } catch (e) {}
    return {
      candidates: Array.from(dedup.values()),
      stats: {
        domTotal: domTotal,
        url: location.href,
        scrollContainerFound: roots.length > 0  // 简化标记，详细在 candidates 长度上看
      }
    };
  }

  function findGeekVueData(el) {
    // 沿 parentElement 找 __vue__ 实例，再沿 $parent 链展开 5 层
    const vues = [];
    const seen = new Set();
    let cur = el;
    while (cur) {
      if (cur.__vue__ && !seen.has(cur.__vue__)) {
        seen.add(cur.__vue__);
        vues.push(cur.__vue__);
      }
      cur = cur.parentElement;
    }
    const expand = [];
    for (let i = 0; i < vues.length; i++) {
      let p = vues[i];
      let d = 0;
      while (p && d < 5) {
        if (!seen.has(p)) { seen.add(p); expand.push(p); }
        p = p.$parent || null;
        d++;
      }
    }
    const all = vues.concat(expand);
    for (let i = 0; i < all.length; i++) {
      const vue = all[i];
      if (!vue) continue;
      const cands = [
        vue.$props && vue.$props.dataSource, vue.dataSource,
        vue.$props && vue.$props.item, vue.item,
        vue.$props && vue.$props.personInfo, vue.personInfo,
        vue.$props && vue.$props.geek, vue.geek,
        vue.$data
      ];
      for (let j = 0; j < cands.length; j++) {
        const obj = cands[j];
        if (obj && typeof obj === 'object' && obj.uid) return obj;
      }
    }
    return null;
  }

  // ============ 7. 沟通页字段补全 — 主动 fetch chat/geek/info（v0.13.3） ============
  // BOSS 沟通页 DOM/Vue 字段不足（缺现居城市 / 工作年限 / 工作经历完整 / 教育经历等），
  // 评估前主动调 chat/geek/info × N 补全。
  //
  // 节奏：5 人一批 × 2-4s 抖动 + 批次间 3-5s 停顿，模拟"HR 看一批停一下"的人类节奏，降风控。
  // 响应被现有 fetch hook 自动 capture → background.js 识别 uid 在 sayhi_pool 走合并流而非推荐页评估。

  async function fetchGeekInfoBatch(items) {
    const results = [];
    const BATCH = 5;
    for (let i = 0; i < items.length; i += BATCH) {
      const slice = items.slice(i, i + BATCH);
      for (let j = 0; j < slice.length; j++) {
        const it = slice[j];
        try {
          const url = '/wapi/zpjob/chat/geek/info?uid=' + encodeURIComponent(it.uid) +
                      '&geekSource=' + (it.geekSource || 0) +
                      '&securityId=' + encodeURIComponent(it.securityId || '');
          const resp = await window.fetch(url, { credentials: 'include' });
          results.push({ uid: it.uid, ok: resp.ok, status: resp.status });
        } catch (e) {
          results.push({ uid: it.uid, ok: false, error: String((e && e.message) || e) });
        }
        // 单人间抖动 2-4 秒
        await sleep(2000 + Math.random() * 2000);
      }
      // 批次间停顿 3-5 秒
      if (i + BATCH < items.length) {
        await sleep(3000 + Math.random() * 2000);
      }
    }
    return results;
  }

  // ============ 8. 沟通页一键操作 — 求简历 / 标不合适（v0.14.0-pre） ============
  // 业务目标：评估结果 → 自动执行 BOSS UI 操作
  //   - decision="符合" → 求简历（两步：点求简历按钮 → 等弹窗 → 点确定）
  //   - decision="pass" → 标不合适（一步：点不合适按钮 → 等卡片从列表消失）
  // 关键设计：
  //   - 先用 el.click()（无"正在调试此浏览器"黄条）。若 BOSS 检测 isTrusted 拒绝，
  //     则后续升级 chrome.debugger（PoC 阶段先看 el.click 行为）
  //   - 文本选择器优先，绕开 BOSS 混淆的 class 名（如 __className__1AbC）
  //   - 每步带超时 + debug 日志，失败立即中止（不盲点下一步）
  //   - 不合适弹窗按用户决策跳过（直接点按钮即可，BOSS 不强制选原因）
  // 风险：BOSS 端 UI 变化 / 频率风控 / isTrusted 校验，全在 sidepanel debug log 暴露

  function _logStep(logs, step, ok, detail) {
    const entry = { t: Date.now(), step: step, ok: !!ok };
    if (detail !== undefined && detail !== null) entry.detail = detail;
    logs.push(entry);
    return entry;
  }

  function _waitFor(predFn, timeoutMs, intervalMs) {
    intervalMs = intervalMs || 250;
    return new Promise(function (resolve) {
      const start = Date.now();
      (function tick() {
        let value = null;
        try { value = predFn(); } catch (e) {}
        if (value) { resolve(value); return; }
        if (Date.now() - start >= timeoutMs) { resolve(null); return; }
        setTimeout(tick, intervalMs);
      })();
    });
  }

  // 文本选择器：找最叶子的纯文本节点的父元素（不会命中父容器的"按钮组"汇总文本）
  // v0.24.6 BUG fix：找到文本节点后，向上 4 层找最近的"真正可点击元素"
  //   起因：HR 反馈批量评估时 autoMark 'wait-card-gone' partial=true（click 调了但
  //   BOSS 没真标）。根因：BOSS 工具栏 DOM 类似 <div class="op"><span class="text">
  //   不合适</span></div>，文本节点的 parentElement 是 span.text，BOSS 的 @click
  //   handler 绑在外层 div.op 上。click span.text 时事件理论上冒泡到 div.op，
  //   但某些 Vue/React 实现用 event.target 严格匹配或外层 stopPropagation，
  //   导致 BOSS 业务未触发。
  //   Fix：找到文本节点后，向上找最近的 [button-like] 祖先元素再 click。
  //   兼容旧行为：若找不到 button-like 祖先，回退到文本节点 parentElement（不破坏现有 work 的路径如「求简历」）。
  function _isButtonLike(el) {
    if (!el || el.nodeType !== 1) return false;
    const tag = el.tagName;
    if (tag === 'BUTTON' || tag === 'A') return true;
    const role = el.getAttribute && el.getAttribute('role');
    if (role === 'button' || role === 'link') return true;
    const cls = (el.className && typeof el.className === 'string') ? el.className : '';
    // BOSS 常见按钮 class：.btn / .operate-btn / .icon-btn / .op-btn / .action-btn
    if (/\b(btn|button|operate|op-?btn|action|icon-btn|clickable)\b/i.test(cls)) return true;
    // [data-v-*] 元素 + cursor:pointer 也算（Vue 编译产物）
    try {
      const cursor = window.getComputedStyle(el).cursor;
      if (cursor === 'pointer') return true;
    } catch (e) {}
    return false;
  }

  function _findClickableByText(text, root) {
    root = root || document;
    let result = null;
    try {
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, null);
      let node;
      while ((node = walker.nextNode())) {
        const t = (node.textContent || '').trim();
        if (t !== text) continue;
        const baseEl = node.parentElement;
        if (!baseEl) continue;
        const r = baseEl.getBoundingClientRect();
        if (!r.width || !r.height) continue;
        const style = window.getComputedStyle(baseEl);
        if (style.display === 'none' || style.visibility === 'hidden') continue;
        if (style.pointerEvents === 'none') continue;
        // v0.24.6 fix：向上找最近的 button-like 祖先（最多 4 层）
        //   命中则返回该祖先；找不到则回退到 baseEl（兼容旧行为）
        let clickTarget = baseEl;
        let cursor = baseEl;
        for (let depth = 0; depth < 4 && cursor; depth++) {
          if (_isButtonLike(cursor)) {
            clickTarget = cursor;
            break;
          }
          cursor = cursor.parentElement;
        }
        result = clickTarget;
        break;
      }
    } catch (e) {}
    return result;
  }

  // 按 uid 查找左侧 .user-list 中的 .geek-item（沿用 scanSayhiCards 的 findGeekVueData）
  function _findSayhiCardByUid(uid) {
    const targetUid = String(uid);
    let cards = [];
    try { cards = Array.from(document.querySelectorAll('.geek-item')); } catch (e) {}
    if (!cards.length) {
      try { cards = Array.from(document.querySelectorAll('.geek-item-wrap')); } catch (e) {}
    }
    for (let i = 0; i < cards.length; i++) {
      const card = cards[i];
      const vue = findGeekVueData(card);
      if (vue && vue.uid && String(vue.uid) === targetUid) return card;
    }
    return null;
  }

  async function _selectSayhiCard(uid, logs) {
    const card = _findSayhiCardByUid(uid);
    if (!card) {
      _logStep(logs, 'findCard', false, '未在左侧列表找到 uid=' + uid + ' 的卡片（可能虚拟列表已卸载，需先扫描）');
      return null;
    }
    _logStep(logs, 'findCard', true);
    // 滚到可见
    try { card.scrollIntoView({ block: 'center', behavior: 'instant' }); } catch (e) {
      try { card.scrollIntoView(); } catch (e2) {}
    }
    await new Promise(function (r) { setTimeout(r, 300); });
    // 触发点击
    try {
      card.click();
      _logStep(logs, 'clickCard', true);
    } catch (e) {
      _logStep(logs, 'clickCard', false, String((e && e.message) || e));
      return null;
    }
    // 等聊天工具栏出现 —— 用工具栏的"求简历"或"不合适"按钮存在作为信号
    const ready = await _waitFor(function () {
      return _findClickableByText('求简历') || _findClickableByText('不合适');
    }, 5000);
    if (!ready) {
      _logStep(logs, 'waitChatToolbar', false, '5s 内未检测到工具栏按钮');
      return null;
    }
    _logStep(logs, 'waitChatToolbar', true);
    // 给 BOSS 一点时间完成聊天面板内的 vue 渲染
    await new Promise(function (r) { setTimeout(r, 400); });
    return card;
  }

  // v0.24.7：请求 BG 用 chrome.debugger 在指定坐标真用户点击（isTrusted=true）
  // 链路：inject postMessage 'real-click-request' → content → BG → 真点击 → BG response → content postMessage 'real-click-result' → inject resolve
  // 12s 超时（attach + 2 dispatchMouseEvent + detach 正常 <2s，留 buffer）
  function _requestRealClick(x, y) {
    return new Promise(function (resolve) {
      const reqId = 'rc-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8);
      let settled = false;
      function handler(ev) {
        if (ev.source !== window) return;
        const m = ev.data;
        if (!m || !m.__bossSniffer) return;
        if (m.kind !== 'real-click-result') return;
        if (m.requestId !== reqId) return;
        if (settled) return;
        settled = true;
        window.removeEventListener('message', handler);
        resolve({ ok: !!m.ok, error: m.error || null });
      }
      window.addEventListener('message', handler);
      window.postMessage({ __bossSniffer: true, kind: 'real-click-request', requestId: reqId, x: x, y: y }, '*');
      setTimeout(function () {
        if (settled) return;
        settled = true;
        window.removeEventListener('message', handler);
        resolve({ ok: false, error: 'real-click-timeout-12s' });
      }, 12000);
    });
  }

  // v0.18.0：原 executeSayhiAction(uid, action) 简化为 executeMarkUnsuitable(uid)
  //   v0.14.0-pre 原本支持 action='request-resume' 走老路径，
  //   v0.17.1.1 起符合决策已改走 executeGreetThenRequestResume（话术+求简历），
  //   request-resume 分支再无调用方 → v0.18.0 删除整段死代码
  //   函数功能现在只剩「标不合适」一种，名字也精简
  async function executeSayhiAction(uid, action) {
    const logs = [];
    const result = { ok: false, action: action, uid: String(uid || ''), logs: logs };
    if (action !== 'mark-unsuitable') {
      result.error = '未知 action: ' + action + '（v0.18.0 起仅支持 mark-unsuitable；request-resume 改走 executeGreetThenRequestResume）';
      return result;
    }
    const card = await _selectSayhiCard(uid, logs);
    if (!card) {
      result.error = '选中卡片失败（详见 logs）';
      result.failedStep = 'find-card';  // v0.24.5：补齐 failedStep（与 executeGreetThenRequestResume 对齐）
      return result;
    }

    // mark-unsuitable
    const btn = _findClickableByText('不合适');
    if (!btn) {
      _logStep(logs, 'findUnsuitableBtn', false);
      result.error = '工具栏未找到不合适按钮';
      result.failedStep = 'find-unsuitable-btn';  // v0.22.4 · 3b：BOSS UI 改名信号 → bg 立即停整批
      return result;
    }
    _logStep(logs, 'findUnsuitableBtn', true, (btn.outerHTML || '').slice(0, 120));
    // v0.24.7：用 chrome.debugger 真用户 click（isTrusted=true）
    //   起因：HR 反馈 v0.24.6 仍 partial=true（合成 click 事件被 BOSS 拒绝业务）。
    //   HR 确认真用户 click 直接生效，无需二级菜单。
    //   方案：取按钮中心坐标 → 经 content → BG → chrome.debugger Input.dispatchMouseEvent
    //   滚到可见以确保坐标在视口内
    try { btn.scrollIntoView({ block: 'center', behavior: 'instant' }); } catch (e) {
      try { btn.scrollIntoView(); } catch (e2) {}
    }
    await new Promise(function (r) { setTimeout(r, 200); });
    const rect = btn.getBoundingClientRect();
    const cx = Math.round(rect.x + rect.width / 2);
    const cy = Math.round(rect.y + rect.height / 2);
    if (!rect.width || !rect.height || cx < 0 || cy < 0) {
      _logStep(logs, 'realClickUnsuitableBtn', false, '按钮坐标无效 rect=' + JSON.stringify({x:rect.x,y:rect.y,w:rect.width,h:rect.height}));
      result.error = '按钮坐标无效（可能滚动失败）';
      result.failedStep = 'click-unsuitable-btn';
      return result;
    }
    const realClickResp = await _requestRealClick(cx, cy);
    if (!realClickResp.ok) {
      _logStep(logs, 'realClickUnsuitableBtn', false, 'real-click failed: ' + (realClickResp.error || 'unknown'));
      result.error = 'chrome.debugger 真点击失败: ' + (realClickResp.error || 'unknown');
      result.failedStep = 'click-unsuitable-btn';
      return result;
    }
    _logStep(logs, 'realClickUnsuitableBtn', true, { x: cx, y: cy });
    // 等左侧卡片消失（操作成功标志，按用户描述）
    // v0.24.6：6s → 15s（HR 反馈 BOSS 后端有时刷新慢，6s 超时过严，partial=true 误判）
    const gone = await _waitFor(function () {
      return !_findSayhiCardByUid(uid);
    }, 15000);
    if (!gone) {
      _logStep(logs, 'waitCardGone', false, '15s 内卡片未消失（可能 BOSS 仍在刷新，或 click 未触发 BOSS 业务）');
      result.ok = true;  // 不算硬失败：标 partial
      result.partial = true;
      result.failedStep = 'wait-card-gone';  // v0.22.4 · 3b：UI 未刷新，bg partial-continue
      return result;
    }
    _logStep(logs, 'waitCardGone', true);
    result.ok = true;
    return result;
  }

  // ============ 8.5 v0.17.1.0：评估「符合」→ 输入话术 + 求简历 ============
  // 业务目标：评估完得到 decision='符合'，先在聊天框输入预设话术（独立消息），再走求简历两步
  // DOM 锚点（POC A8 探明）：
  //   - 聊天输入框: #boss-chat-editor-input (div contenteditable=true)
  //   - 发送按钮:   .submit-content .submit (textContent='发送')
  //   - 聊天历史:   .chat-message-list .message-item
  //   - 求简历:     <span class="operate-btn">求简历</span>（沿用 v0.14 文本选择器）
  // 输入策略：主用 execCommand('insertText') 触发 isTrusted=true 真 input 事件
  //          退用 textContent + dispatchEvent(InputEvent)，Vue v-model 不响应则 abort
  // 风控：与 executeSayhiAction 同等节奏；dryRun 模式跑完所有定位但不点最终按钮

  function _findChatInputEditor() {
    const el = document.getElementById('boss-chat-editor-input');
    if (!el) return null;
    const r = el.getBoundingClientRect();
    if (!r.width || !r.height) return null;
    if (el.getAttribute('contenteditable') !== 'true') return null;
    return el;
  }

  function _findSubmitButton() {
    // 限定在 .submit-content 容器里找 textContent='发送' 的元素，避免误选其他「发送」字眼
    try {
      const containers = document.querySelectorAll('.submit-content');
      for (let i = 0; i < containers.length; i++) {
        const c = containers[i];
        const walker = document.createTreeWalker(c, NodeFilter.SHOW_TEXT, null);
        let node;
        while ((node = walker.nextNode())) {
          if ((node.textContent || '').trim() !== '发送') continue;
          const el = node.parentElement;
          if (!el) continue;
          const r = el.getBoundingClientRect();
          if (!r.width || !r.height) continue;
          return el;
        }
      }
    } catch (e) {}
    return null;
  }

  function _isSubmitDisabled(submitBtn) {
    if (!submitBtn) return true;
    const cn = String(submitBtn.className || '').toLowerCase();
    if (/disabled|is-disabled|btn-disabled/.test(cn)) return true;
    if (submitBtn.disabled) return true;
    // 父元素可能挂 disabled class（如 .submit-content.disabled）
    let p = submitBtn.parentElement;
    for (let d = 0; d < 3 && p; d++, p = p.parentElement) {
      const pcn = String(p.className || '').toLowerCase();
      if (/\bdisabled\b|\bis-disabled\b/.test(pcn)) return true;
    }
    return false;
  }

  // 等输入框内容反映成功（contenteditable + Vue v-model 同步判定）
  // 双判：editor.textContent 含 text；submit 按钮不再 disabled
  async function _waitForEditorEnabled(editor, text, timeoutMs) {
    const expected = String(text || '').trim();
    return _waitFor(function () {
      const got = String(editor.textContent || '').trim();
      if (got.indexOf(expected) < 0) return false;
      const submit = _findSubmitButton();
      if (!submit) return false;
      if (_isSubmitDisabled(submit)) return false;
      return true;
    }, timeoutMs || 1500, 100);
  }

  // 设置 editor 内容：主路径 execCommand('insertText') 失败则退路 textContent + InputEvent
  // 返回 { ok, via: 'execCommand' | 'textContent' | null }
  async function _setEditorText(editor, text, logs) {
    if (!editor) return { ok: false, via: null };
    // 步 1：focus + 全选清空
    try {
      editor.focus();
      // 选中现有全部内容然后 delete（避免文本叠加）
      const range = document.createRange();
      range.selectNodeContents(editor);
      const sel = window.getSelection();
      sel.removeAllRanges();
      sel.addRange(range);
    } catch (e) {
      _logStep(logs, 'editorFocus', false, String((e && e.message) || e));
    }
    // 步 2：主路径 execCommand insertText
    let viaExec = false;
    try {
      // 先 delete 旧内容
      document.execCommand('delete', false, null);
      viaExec = document.execCommand('insertText', false, text);
    } catch (e) {
      _logStep(logs, 'execCommandException', false, String((e && e.message) || e));
    }
    if (viaExec) {
      const ok = await _waitForEditorEnabled(editor, text, 1500);
      if (ok) {
        _logStep(logs, 'setEditorText', true, { via: 'execCommand' });
        return { ok: true, via: 'execCommand' };
      }
      _logStep(logs, 'setEditorTextViaExec', false, 'execCommand 返回 true 但 editor/submit 状态不对');
    } else {
      _logStep(logs, 'setEditorTextViaExec', false, 'execCommand insertText 返回 false');
    }
    // 步 3：退路 textContent + InputEvent
    try {
      editor.textContent = text;
      editor.dispatchEvent(new InputEvent('input', { bubbles: true, cancelable: true }));
      editor.dispatchEvent(new Event('change', { bubbles: true }));
    } catch (e) {
      _logStep(logs, 'setEditorTextViaTextContent', false, String((e && e.message) || e));
      return { ok: false, via: null };
    }
    const ok2 = await _waitForEditorEnabled(editor, text, 1500);
    if (ok2) {
      _logStep(logs, 'setEditorText', true, { via: 'textContent' });
      return { ok: true, via: 'textContent' };
    }
    _logStep(logs, 'setEditorTextViaTextContent', false, 'textContent 赋值后 editor/submit 状态仍不对');
    return { ok: false, via: null };
  }

  // 等消息出现在历史区
  // 判定：message-item 数量 > beforeCount 且新 item 无 pending/sending class
  // 满足后再硬延迟 600ms，留 BOSS 后端 ack 时间
  async function _waitForMessageSent(beforeCount, timeoutMs) {
    const reached = await _waitFor(function () {
      const items = document.querySelectorAll('.chat-message-list .message-item');
      if (items.length <= beforeCount) return false;
      // 检查最后一项不在 pending 状态
      const last = items[items.length - 1];
      const cn = String(last.className || '').toLowerCase();
      if (/pending|sending|loading|is-sending/.test(cn)) return false;
      // 子元素也排查一遍（spinner / loading 子节点）
      if (last.querySelector && last.querySelector('.loading, .sending, .pending, [class*=loading], [class*=sending]')) {
        return false;
      }
      return last;
    }, timeoutMs || 3000, 150);
    if (!reached) return null;
    // hard floor：给 BOSS 后端 ack 时间
    await new Promise(function (r) { setTimeout(r, 600); });
    return reached;
  }

  // 在 dialog 范围内找含 dialogTexts 任一文案的「确定」按钮，避免误选页面其他位置的「确定」
  // v0.17.1.3：dialog-scope 找不到时 fallback 到 v0.14 实测可靠的「全文档扫『确定』叶子 → 上溯祖先含 dialogText」
  // v0.17.1.4：dialogTexts 改为**多文案数组**（BOSS 把「请求简历」改成「索取简历」，单字符串会 miss）
  //   入参字符串自动包成数组 [str]，向后兼容
  function _findConfirmInDialogScope(dialogTexts) {
    if (typeof dialogTexts === 'string') dialogTexts = [dialogTexts];
    if (!Array.isArray(dialogTexts) || !dialogTexts.length) return null;

    // 任一 text 在 container.textContent 里匹配 → 视为命中该 dialog
    function ancestorMatchesAny(el) {
      let p = el;
      for (let d = 0; d < 8 && p; d++, p = p.parentElement) {
        const t = p.textContent || '';
        for (let i = 0; i < dialogTexts.length; i++) {
          if (t.indexOf(dialogTexts[i]) >= 0) return true;
        }
      }
      return false;
    }

    function containerMatchesAny(el) {
      const t = el.textContent || '';
      for (let i = 0; i < dialogTexts.length; i++) {
        if (t.indexOf(dialogTexts[i]) >= 0) return true;
      }
      return false;
    }

    // 步 1：dialog-scope 优先（避免多弹窗叠加时误点）
    try {
      const candidates = [];
      const dialogSelectors = ['.boss-dialog', '[role="dialog"]', '.modal', '.dialog',
                                '.boss-message-box', '.boss-confirm', '.confirm-pop'];
      dialogSelectors.forEach(function (sel) {
        try {
          document.querySelectorAll(sel).forEach(function (el) {
            if (candidates.indexOf(el) < 0) candidates.push(el);
          });
        } catch (e) {}
      });
      // z-index>1000 兜底
      try {
        const all = document.querySelectorAll('div, section, aside');
        for (let i = 0; i < all.length; i++) {
          const el = all[i];
          try {
            const z = parseInt(window.getComputedStyle(el).zIndex || '0', 10);
            if (z > 1000 && candidates.indexOf(el) < 0) candidates.push(el);
          } catch (e) {}
        }
      } catch (e) {}

      for (let i = 0; i < candidates.length; i++) {
        const dlg = candidates[i];
        if (!containerMatchesAny(dlg)) continue;
        const walker = document.createTreeWalker(dlg, NodeFilter.SHOW_TEXT, null);
        let node;
        while ((node = walker.nextNode())) {
          if ((node.textContent || '').trim() !== '确定') continue;
          const el = node.parentElement;
          if (!el) continue;
          const r = el.getBoundingClientRect();
          if (!r.width || !r.height) continue;
          const style = window.getComputedStyle(el);
          if (style.display === 'none' || style.visibility === 'hidden') continue;
          return el;
        }
      }
    } catch (e) {}

    // 步 2：fallback 到 v0.14 全文档扫描（实测可靠）
    // 全 document 找所有「确定」叶子 → 上溯 8 层任一 dialogText 命中即返回
    try {
      const walker = document.createTreeWalker(document, NodeFilter.SHOW_TEXT, null);
      let node;
      while ((node = walker.nextNode())) {
        if ((node.textContent || '').trim() !== '确定') continue;
        const el = node.parentElement;
        if (!el) continue;
        const r = el.getBoundingClientRect();
        if (!r.width || !r.height) continue;
        const style = window.getComputedStyle(el);
        if (style.display === 'none' || style.visibility === 'hidden') continue;
        if (ancestorMatchesAny(el)) return el;
      }
    } catch (e) {}
    return null;
  }

  // 主流程：执行话术 + 求简历
  // 返回 { ok, action:'greet-then-resume', uid, dryRun, logs, error, partial }
  async function executeGreetThenRequestResume(uid, greetText, dryRun) {
    const logs = [];
    const result = {
      ok: false,
      action: 'greet-then-resume',
      uid: String(uid || ''),
      dryRun: !!dryRun,
      logs: logs
    };
    if (!greetText || String(greetText).trim().length < 5) {
      result.error = '话术文本太短或缺失';
      result.failedStep = 'validate-greet-text';  // v0.22.4 · 3b
      _logStep(logs, 'validateGreetText', false, { len: (greetText && greetText.length) || 0 });
      return result;
    }
    // 1) 选中候选人卡片（复用 _selectSayhiCard，含等工具栏出现）
    const card = await _selectSayhiCard(uid, logs);
    if (!card) {
      result.error = '选中候选人卡片失败';
      result.failedStep = 'find-card';  // v0.22.4 · 3b：与 mark-unsuitable 共用
      return result;
    }
    // 2) 找输入框
    const editor = await _waitFor(_findChatInputEditor, 3000);
    if (!editor) {
      _logStep(logs, 'findEditor', false);
      result.error = '聊天输入框 #boss-chat-editor-input 未找到（聊天面板未渲染好？）';
      result.failedStep = 'find-editor';  // v0.22.4 · 3b：环境/DOM 渲染问题
      return result;
    }
    _logStep(logs, 'findEditor', true);
    // 3) 记发送前消息数
    const beforeCount = document.querySelectorAll('.chat-message-list .message-item').length;
    _logStep(logs, 'recordBeforeCount', true, { beforeCount: beforeCount });
    // 4) 写话术 — v0.22.4 · 3b：重试 1 次（spec §3.3·3 "话术输入失败 → 重试 1 次再失败则跳过候选人"）
    //    第一次 _setEditorText 已含 execCommand + textContent 两路径退路；这层 retry 是整体重试
    //    （包括 focus / delete / 重新 insertText），针对偶发 Vue v-model 不响应
    let setResult = await _setEditorText(editor, String(greetText).trim(), logs);
    if (!setResult.ok) {
      _logStep(logs, 'editorInputRetry', true, { reason: '首次 _setEditorText 失败，500ms 后 retry attempt 2' });
      await new Promise(function (r) { setTimeout(r, 500); });
      setResult = await _setEditorText(editor, String(greetText).trim(), logs);
    }
    if (!setResult.ok) {
      result.error = '输入话术失败（execCommand 和 textContent 退路都不响应 Vue v-model，已 retry 1 次）';
      result.failedStep = 'editor-input';  // v0.22.4 · 3b：bg skip-candidate（不计 actionFailStreak）
      return result;
    }
    // 5) 找发送按钮 + 校验未 disabled
    const submitBtn = _findSubmitButton();
    if (!submitBtn) {
      _logStep(logs, 'findSubmitBtn', false);
      result.error = '未找到发送按钮';
      result.failedStep = 'find-submit-btn';  // v0.22.4 · 3b
      return result;
    }
    if (_isSubmitDisabled(submitBtn)) {
      _logStep(logs, 'findSubmitBtn', false, '发送按钮 disabled');
      result.error = '发送按钮 disabled（话术未触发启用）';
      result.failedStep = 'find-submit-btn';  // v0.22.4 · 3b：同 find-submit-btn 类
      return result;
    }
    _logStep(logs, 'findSubmitBtn', true);
    // 6) dryRun 检查点 1：跳过点击
    if (dryRun) {
      _logStep(logs, 'wouldClickSubmit', true, { text: greetText });
    } else {
      try { submitBtn.click(); _logStep(logs, 'clickSubmit', true); }
      catch (e) {
        _logStep(logs, 'clickSubmit', false, String((e && e.message) || e));
        result.error = '点击发送失败';
        result.failedStep = 'click-submit';  // v0.22.4 · 3b
        return result;
      }
      // 7) 等消息出现在历史区
      const sent = await _waitForMessageSent(beforeCount, 4000);
      if (!sent) {
        _logStep(logs, 'waitMessageSent', false, '4s 内消息未出现 / 一直 pending');
        result.error = '话术发送验证失败（消息未出现在历史区）';
        result.partial = true;
        result.failedStep = 'wait-message-sent';  // v0.22.4 · 3b：已点 submit，bg partial-continue
        return result;
      }
      _logStep(logs, 'waitMessageSent', true);
      // v0.17.1.3 拟人冷却：发完消息后停 1-2s 再点求简历，避免 BOSS 风控觉得是脚本连点
      //   真人 HR 发完话术也会看一眼消息再下个动作，这个停顿成本低且明显降低风控嫌疑
      const cooldownMs = 1000 + Math.random() * 1000;
      _logStep(logs, 'humanCooldownBeforeRequest', true, { cooldownMs: Math.round(cooldownMs) });
      await new Promise(function (r) { setTimeout(r, cooldownMs); });
    }
    // 8) 找求简历按钮（复用 v0.14 文本选择器）
    const requestBtn = _findClickableByText('求简历');
    if (!requestBtn) {
      _logStep(logs, 'findRequestBtn', false);
      result.error = '工具栏未找到求简历按钮';
      result.partial = !dryRun;  // 话术已发出，但求简历失败 → partial
      result.failedStep = 'find-request-btn';  // v0.22.4 · 3b：BOSS UI 改名信号 → bg 立即停整批
      return result;
    }
    _logStep(logs, 'findRequestBtn', true);
    // 9) dryRun 检查点 2：点求简历后弹窗会出现，dryRun 也照常点（不会真发送），只跳过 confirm
    try { requestBtn.click(); _logStep(logs, 'clickRequestBtn', true); }
    catch (e) {
      _logStep(logs, 'clickRequestBtn', false, String((e && e.message) || e));
      result.error = '点击求简历失败';
      result.partial = !dryRun;
      result.failedStep = 'click-request-btn';  // v0.22.4 · 3b：bg partial-continue
      return result;
    }
    // 10) 等求简历确认弹窗（dialog-scope 限定 + v0.14 全文 fallback）
    //   v0.17.1.3 超时 4s → 6s：用户反馈卡在弹窗，可能渲染稍慢
    //   v0.17.1.4 多文案数组：BOSS 把弹窗标题从「请求简历」改成「索取简历」
    //     原 v0.14 / v0.17.1.0-.3 都硬编码 '请求简历'，新版会 miss
    const confirmBtn = await _waitFor(function () {
      return _findConfirmInDialogScope(['请求简历', '索取简历']);
    }, 6000);
    if (!confirmBtn) {
      _logStep(logs, 'waitConfirmDialog', false, '6s 内未出现确认弹窗（搜索文案：请求简历 / 索取简历）');
      result.error = '未出现求简历确认弹窗';
      result.partial = !dryRun;
      result.failedStep = 'wait-confirm-dialog';  // v0.22.4 · 3b：bg partial-continue
      return result;
    }
    _logStep(logs, 'waitConfirmDialog', true);
    // 11) dryRun 检查点 2：跳过 confirm 点击
    if (dryRun) {
      _logStep(logs, 'wouldClickConfirm', true);
      result.ok = true;
      return result;
    }
    try { confirmBtn.click(); _logStep(logs, 'clickConfirm', true); }
    catch (e) {
      _logStep(logs, 'clickConfirm', false, String((e && e.message) || e));
      result.error = '点击确认失败';
      // v0.22.4 · 3b：clickConfirm 失败语义改半成功（话术已发+求简历已点+弹窗已显示，仅最后一击失败）
      //   与 'wait-card-gone' 对齐 (ok=true + partial=true)，bg STEP_POLICY partial-continue
      result.ok = true;
      result.partial = true;
      result.failedStep = 'click-confirm';
      return result;
    }
    // 12) 等弹窗消失（不强求）
    //   v0.17.1.4：BOSS 改文案「请求简历」→「索取简历」，两个变体都要检测
    const gone = await _waitFor(function () {
      try {
        const walker = document.createTreeWalker(document, NodeFilter.SHOW_TEXT, null);
        let node;
        while ((node = walker.nextNode())) {
          const t = node.textContent || '';
          if (t.indexOf('确定向牛人请求简历') >= 0 || t.indexOf('确定向牛人索取简历') >= 0) {
            const el = node.parentElement;
            if (!el) continue;
            const r = el.getBoundingClientRect();
            if (r.width && r.height) return false;
          }
        }
        return true;
      } catch (e) { return true; }
    }, 5000);
    _logStep(logs, 'waitDialogGone', !!gone);
    result.ok = true;
    return result;
  }

  // v0.16.0：找 BOSS iframe 内「最新」tab 的 DOM + 模拟 click
  // PoC 验证：<ul class="tab-list"><li class="tab-item" title="新牛人">最新</li></ul>
  // .click() 真触发 /wapi/zprelation/interaction/bossGetGeek
  async function _clickLatestTab() {
    const tab = await _waitFor(function () {
      // 首选：title 属性精确匹配（PoC 验证最稳）
      let el = document.querySelector('ul.tab-list li[title="新牛人"]');
      if (!el) {
        // fallback：按文本 trim==='最新' 找 li.tab-item
        const w = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
        let n;
        while ((n = w.nextNode())) {
          if (n.nodeValue && n.nodeValue.trim() === '最新') {
            const c = n.parentElement;
            if (c && c.matches && c.matches('li.tab-item')) { el = c; break; }
          }
        }
      }
      if (!el) return null;
      const r = el.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) return null;
      return el;
    }, 8000, 200);
    if (!tab) throw new Error('「最新」tab DOM 8 秒内未出现');
    tab.click();
  }

  // 监听 content.js 发来的扫描请求（v0.13.1：scanSayhiCards 改 async，要 Promise）
  window.addEventListener('message', function (event) {
    if (event.source !== window) return;
    const msg = event.data;
    if (!msg || msg.__bossSniffer !== true) return;
    if (msg.kind === 'scan-sayhi-request') {
      const requestId = msg.requestId || '';
      scanSayhiCards().then(function (result) {
        // v0.13.2：result 是 { candidates, stats } 对象
        window.postMessage({
          __bossSniffer: true,
          kind: 'scan-sayhi-result',
          requestId: requestId,
          ok: true,
          candidates: (result && result.candidates) || [],
          stats: (result && result.stats) || null
        }, '*');
      }).catch(function (e) {
        window.postMessage({
          __bossSniffer: true,
          kind: 'scan-sayhi-result',
          requestId: requestId,
          ok: false,
          error: String((e && e.message) || e)
        }, '*');
      });
    } else if (msg.kind === 'fetch-geek-info-batch-request') {
      // v0.13.3：主动 fetch chat/geek/info 补全沟通页池子字段
      const requestId = msg.requestId || '';
      const items = msg.items || [];
      fetchGeekInfoBatch(items).then(function (results) {
        window.postMessage({
          __bossSniffer: true,
          kind: 'fetch-geek-info-batch-result',
          requestId: requestId,
          ok: true,
          results: results
        }, '*');
      }).catch(function (e) {
        window.postMessage({
          __bossSniffer: true,
          kind: 'fetch-geek-info-batch-result',
          requestId: requestId,
          ok: false,
          error: String((e && e.message) || e)
        }, '*');
      });
    } else if (msg.kind === 'execute-sayhi-action-request') {
      // v0.14.0-pre：沟通页一键操作（求简历 / 标不合适）
      const requestId = msg.requestId || '';
      const uid = msg.uid || '';
      const action = msg.action || '';
      executeSayhiAction(uid, action).then(function (result) {
        window.postMessage({
          __bossSniffer: true,
          kind: 'execute-sayhi-action-result',
          requestId: requestId,
          ok: !!result.ok,
          result: result
        }, '*');
      }).catch(function (e) {
        window.postMessage({
          __bossSniffer: true,
          kind: 'execute-sayhi-action-result',
          requestId: requestId,
          ok: false,
          error: String((e && e.message) || e),
          result: { ok: false, error: String((e && e.message) || e), logs: [] }
        }, '*');
      });
    } else if (msg.kind === 'execute-greet-then-resume-request') {
      // v0.17.1.0：评估「符合」→ 输入话术 + 求简历
      const requestId = msg.requestId || '';
      const uid = msg.uid || '';
      const greetText = msg.greetText || '';
      const dryRun = !!msg.dryRun;
      executeGreetThenRequestResume(uid, greetText, dryRun).then(function (result) {
        window.postMessage({
          __bossSniffer: true,
          kind: 'execute-greet-then-resume-result',
          requestId: requestId,
          ok: !!result.ok,
          result: result
        }, '*');
      }).catch(function (e) {
        window.postMessage({
          __bossSniffer: true,
          kind: 'execute-greet-then-resume-result',
          requestId: requestId,
          ok: false,
          error: String((e && e.message) || e),
          result: { ok: false, error: String((e && e.message) || e), logs: [] }
        }, '*');
      });
    } else if (msg.kind === 'click-latest-tab-request') {
      // v0.16.0：BG 触发的「最新」tab 切换
      const requestId = msg.requestId || '';
      _clickLatestTab().then(function () {
        window.postMessage({
          __bossSniffer: true,
          kind: 'click-latest-tab-result',
          requestId: requestId,
          ok: true
        }, '*');
      }).catch(function (e) {
        window.postMessage({
          __bossSniffer: true,
          kind: 'click-latest-tab-result',
          requestId: requestId,
          ok: false,
          error: String((e && e.message) || e)
        }, '*');
      });
    } else if (msg.kind === 'click-and-scan-detail-request') {
      // v0.17.0.10 POC A7 阶段 b：BG 触发的"点击候选人 + 扫详情面板"
      const requestId = msg.requestId || '';
      const uid = msg.uid || '';
      const timeoutMs = typeof msg.timeoutMs === 'number' ? msg.timeoutMs : 3000;
      _clickAndScanDetail(uid, timeoutMs).then(function (result) {
        window.postMessage({
          __bossSniffer: true,
          kind: 'click-and-scan-detail-result',
          requestId: requestId,
          ok: !!result.ok,
          uid: result.uid,
          scan: result.scan || null,
          error: result.error || null,
          waitedMs: result.waitedMs || null
        }, '*');
      }).catch(function (e) {
        window.postMessage({
          __bossSniffer: true,
          kind: 'click-and-scan-detail-result',
          requestId: requestId,
          ok: false,
          uid: uid,
          scan: null,
          error: String((e && e.message) || e)
        }, '*');
      });
    }
  });

  // 通知 content.js 注入成功
  window.postMessage({ __bossSniffer: true, kind: 'ready' }, '*');
})();
