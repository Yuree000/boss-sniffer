// BOSS Sniffer · lib/debugger-click.js (v1.0.12)
// chrome.debugger Input.dispatchMouseEvent 真用户点击(autoMark "不合适" 场景)
//
// 提取自 background.js Sprint C 阶段 2(v1.0.5 → v1.0.6)。
//
// 背景:
//   v0.24.6 HR 反馈 btn.click() 合成事件 BOSS 拒绝("不合适" click 后 BOSS 端没标);
//   HR 确认真用户 click 直接生效,无需二级菜单。
// 方案:
//   chrome.debugger Input.dispatchMouseEvent 派 mouseMoved + mousePressed + mouseReleased,
//   event.isTrusted=true,BOSS 业务接受。
// 代价:
//   会出现"正在调试此浏览器"黄条(每次 attach/detach)。
// 时序细节(v0.24.10 教训):
//   mouseMoved 后**立即** mousePressed(不留 sleep),避免 BOSS 的 hover 二级菜单弹出覆盖按钮。
//   保留 mousePressed → mouseReleased 30-60ms sleep(click hold,不触发 UI 变化)。
//   推荐页打招呼按钮无 hover 菜单,sayHi.js 用 30-110ms 节奏 work;沟通页「不合适」按钮有
//   hover 菜单,必须省略 mouseMoved → mousePressed 之间的 sleep。
//
// v1.0.12 增强诊断（不动业务逻辑）:
//   HR 反馈连续 mark 时偶发失败,失败现象是「按钮高亮但没点下去」(mouseMoved 命中 / mousePressed
//   未触发 BOSS 业务)。怀疑 BOSS DOM 在 mouseMoved 触发 hover 后变动(弹二级菜单/重布局),
//   导致 mousePressed 派到的坐标不再是「不合适」按钮。
//   v1.0.12 加入逐步 BossDiag log + mouseReleased 后查 elementFromPoint(cx, cy),
//   下次失败可从诊断包看到完整时序 + 派发结束时该坐标实际承载的元素。
//
// 公开 API(挂在 self.BossDebuggerClick):
//   realClickAtCoords(tabId, x, y) → Promise<{ ok, error?, diag? }>
//   diag 字段(v1.0.12 起):{ attachMs, dispatchMs, elementAtClick: { tag, text, classes } | null }
//
// 依赖:
//   self.BossDebuggerUtil(v1.0.4 Sprint B,自愈接入/脱离)
//   self.BossDiag(可选,诊断 log)

(function (global) {
  'use strict';

  function diagLog(level, key, msg, extras) {
    if (global.BossDiag && typeof global.BossDiag.log === 'function') {
      global.BossDiag.log(level, key, msg, extras || {});
    }
  }

  /**
   * 在指定坐标真用户点击(走 chrome.debugger CDP 派发,isTrusted=true,BOSS 不拒绝)
   * 主要给 autoMark"不合适"按钮用;sayHi 自己有时序更长版本(见 lib/sayHi.js clickAt)
   *
   * 参数:
   *   - tabId: chrome tab id
   *   - x / y: 顶层 frame 视口坐标
   *   - opts: 可选 { hoverDelayMinMs, hoverDelayMaxMs } — mouseMoved → mousePressed 间隔(默认 30-110ms)
   *
   * 返回: Promise<{ ok, error?, diag? }> — diag 含 attach/dispatch 耗时 + 点击点 elementAtClick 探测
   */
  async function realClickAtCoords(tabId, x, y, opts) {
    // v1.0.14：opts.hoverDelayMinMs / hoverDelayMaxMs 可选,默认 30 / 110(对齐 sayHi.js 时序)
    const o = opts || {};
    const hMin = (typeof o.hoverDelayMinMs === 'number' && o.hoverDelayMinMs >= 0) ? o.hoverDelayMinMs : 30;
    const hMaxRaw = (typeof o.hoverDelayMaxMs === 'number' && o.hoverDelayMaxMs >= hMin) ? o.hoverDelayMaxMs : Math.max(110, hMin);
    const hRange = Math.max(0, hMaxRaw - hMin);
    const target = { tabId: tabId };
    function dispatch(params) {
      return new Promise(function (resolve, reject) {
        chrome.debugger.sendCommand(target, 'Input.dispatchMouseEvent', params, function () {
          if (chrome.runtime.lastError) { reject(new Error(chrome.runtime.lastError.message)); return; }
          resolve();
        });
      });
    }
    // v1.0.12：派发完成后用 Runtime.evaluate 查 elementFromPoint(x, y) 看坐标承载的实际元素
    //   若返回元素不是「不合适」按钮的祖先/自身,说明 BOSS DOM 在 mouseMoved 后变了
    function probeElementAtPoint() {
      return new Promise(function (resolve) {
        const expr = '(function(){var el=document.elementFromPoint(' + x + ',' + y + ');' +
          'if(!el)return null;' +
          'return {tag:el.tagName,text:(el.textContent||"").trim().slice(0,40),classes:(el.className||"").toString().slice(0,80)};' +
          '})()';
        chrome.debugger.sendCommand(target, 'Runtime.evaluate', {
          expression: expr,
          returnByValue: true,
          awaitPromise: false
        }, function (result) {
          if (chrome.runtime.lastError) { resolve(null); return; }
          resolve(result && result.result && result.result.value);
        });
      });
    }

    const t0 = Date.now();
    diagLog('info', 'debugger-click.start', 'realClickAtCoords 开始', { tabId: tabId, x: x, y: y });

    let attached = false;
    let tAttached = 0, tDispatched = 0;
    let elementAtClick = null;
    try {
      await self.BossDebuggerUtil.attachWithSelfHeal(tabId);
      attached = true;
      tAttached = Date.now();
      diagLog('info', 'debugger-click.attached', 'attach 成功', { attachMs: tAttached - t0 });

      // v1.0.13/v1.0.14:mouseMoved → mousePressed 之间加回拟人 sleep(对齐 lib/sayHi.js 推荐页打招呼时序)
      //   v1.0.14：sleep 区间从硬编码 30-110ms 改为 opts.hoverDelayMin/MaxMs 可配置(admin UI 暴露)
      //   背景见 v1.0.13 commit：v0.24.10 当年 0ms 间隔让 BOSS 把它识别为非真人 click → 业务概率性拒绝。
      await dispatch({ type: 'mouseMoved', x: x, y: y, button: 'none' });
      diagLog('info', 'debugger-click.dispatched_moved', 'mouseMoved 派发完成', { hoverDelayMin: hMin, hoverDelayMax: hMin + hRange });
      await new Promise(function (r1) { setTimeout(r1, hMin + Math.random() * hRange); });
      await dispatch({ type: 'mousePressed', x: x, y: y, button: 'left', clickCount: 1 });
      diagLog('info', 'debugger-click.dispatched_pressed', 'mousePressed 派发完成');
      await new Promise(function (r2) { setTimeout(r2, 30 + Math.random() * 30); });  // 30-60ms click hold
      await dispatch({ type: 'mouseReleased', x: x, y: y, button: 'left', clickCount: 1 });
      tDispatched = Date.now();
      diagLog('info', 'debugger-click.dispatched_released', 'mouseReleased 派发完成', { dispatchMs: tDispatched - tAttached });

      // v1.0.12 诊断：查派发后该坐标实际承载的元素
      //   若 text 不是"不合适"且 classes 不含 op-btn/不合适相关,说明 BOSS DOM 变了 → 解释 click miss
      try { elementAtClick = await probeElementAtPoint(); } catch (_e) {}
      diagLog('info', 'debugger-click.probe', '派发后坐标元素探测', {
        x: x, y: y,
        element: elementAtClick,
        isLikelyUnsuitableBtn: !!(elementAtClick && (
          (elementAtClick.text || '').indexOf('不合适') !== -1 ||
          /op-btn|operate|btn-bar/.test(elementAtClick.classes || '')
        ))
      });

      return {
        ok: true,
        diag: {
          attachMs: tAttached - t0,
          dispatchMs: tDispatched - tAttached,
          elementAtClick: elementAtClick
        }
      };
    } catch (e) {
      const errMsg = (e && e.message) || String(e);
      diagLog('warn', 'debugger-click.error', 'realClickAtCoords 失败', {
        attached: attached,
        attachMs: tAttached ? (tAttached - t0) : null,
        dispatchMs: tDispatched ? (tDispatched - tAttached) : null,
        error: errMsg
      });
      return { ok: false, error: errMsg };
    } finally {
      // 始终 detach(自愈策略下永远是自己 attach 的,detach 是干净退出)
      if (attached) {
        await self.BossDebuggerUtil.detach(tabId);
        diagLog('info', 'debugger-click.detached', 'detach 完成', { totalMs: Date.now() - t0 });
      }
    }
  }

  global.BossDebuggerClick = {
    realClickAtCoords: realClickAtCoords
  };
})(self);
