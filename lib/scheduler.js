// BOSS Sniffer - scheduler.js (S6)
// 推荐页全自动循环状态机 + tick 调度器
//
// 5 态：IDLE / RUNNING / RESTING / PAUSED / STOPPED
// 公开 API：self.BossScheduler.{ start, stop, resume, getState, runTick, setScrollFn }
//
// 设计见 相关文档/specs/2026-05-09-S6-推荐页全自动循环-design.md

(function (global) {
  'use strict';

  const STATES = {
    IDLE: 'IDLE',
    RUNNING: 'RUNNING',
    RESTING: 'RESTING',
    PAUSED: 'PAUSED',
    STOPPED: 'STOPPED'
  };

  let loopState = {
    status: STATES.IDLE,
    goalN: null,
    goalK: null,
    sayhiCount: 0,
    roundCount: 0,
    loopStartedAt: 0,    // S6 fix v6：本次 LOOP 启动时刻，作为 sayhi/pending 时间窗口起点
    batchStartedAt: 0,
    restEndsAt: 0,
    hint: ''
  };

  // tick 主循环的句柄（async 函数 promise），用于 stop 时知道是否还在跑
  let tickRunning = false;

  function getState() {
    return Object.assign({}, loopState);
  }

  function setState(patch) {
    Object.assign(loopState, patch);
  }

  // v1.1.22 提到 lib/runtime-utils.js;makeErr 是旧名,保留 alias 不改 3 处 caller
  const makeErr = self.BossRuntimeUtils.err;
  const sleep = self.BossRuntimeUtils.sleep;

  // S6 fix v5（方案 E）：扫 evaluations 表全表统计 status='pending' 的条目数
  // S6 fix v6：加时间窗口参数 since，只算 evaluation.startedAt >= since 的 pending
  //   防止历史遗留 pending（崩溃/超时未清理）污染本次 LOOP 的判定
  //
  // 替换 fix v4 之前的 batchIds 思路（把 candidate_pool 事件 filter 后的 ids 作为本批）：
  // 那个思路有双重 race —— ② 步取 batchIds 时 candidate_pool 串行写未完整 + ③ 步
  // checkBatchDone 看 r=undefined 误判已完成（evaluations 表此时还没批量写 pending）。
  //
  // 新方案语义：
  // - 上一轮 ④ 等 sayHi 队列空 → 必然本 LOOP pending=0
  // - 第二轮入口时本 LOOP pending=0，等 > 0 即 background 已写入新 batch
  // - ③ 等本 LOOP pending == 0 即本批所有 LLM 评估完成
  // - 不再依赖 candidate_pool 事件采样，跟 batchIds race 完全解耦
  /**
   * 扫 evaluations IDB 表统计本 LOOP 启动后还在 pending 的评估条目数
   * 是 scheduler ②/③/④' 三步判"本批是否处理完"的关键信号
   *
   * 参数:
   *   - since: 时间窗起点(只算 evaluation.startedAt >= since 的 pending)
   *
   * 返回: number,pending 评估条数;IDB 不可用时返回 0
   */
  async function countPendingEvaluationsSince(since) {
    if (!self.BOSS_OPEN_DB) return 0;
    const sinceTs = since || 0;
    const db = await self.BOSS_OPEN_DB();
    const storeName = self.BOSS_STORE_EVALUATIONS || 'evaluations';
    return new Promise(function (resolve) {
      const tx = db.transaction(storeName, 'readonly');
      const store = tx.objectStore(storeName);
      let pending = 0;
      const req = store.openCursor();
      req.onsuccess = function (e) {
        const cursor = e.target.result;
        if (cursor) {
          const r = cursor.value;
          if (r && r.evaluation && r.evaluation.status === 'pending' &&
              (r.evaluation.startedAt || 0) >= sinceTs) {
            pending += 1;
          }
          cursor.continue();
        } else {
          resolve(pending);
        }
      };
      req.onerror = function () { resolve(0); };
    });
  }

  // 等 sayHi 队列空 + 同步 RESTING 状态
  /**
   * 阻塞等到 sayHi 队列清空(并把 sayHi 的 isResting 状态镜像到 scheduler 的 RESTING)
   * 是 scheduler ④ 步:进下一轮滚动前确保上一批的招呼都打完了
   *
   * 返回: Promise(无返回值;遇 STOPPED 立即返回不再等)
   */
  async function waitSayHiDrain() {
    while (true) {
      if (loopState.status === STATES.STOPPED) return;
      const s = self.BossSayHi ? self.BossSayHi.getStatus() : { queueLength: 0, isResting: false };
      // sayHi 进入休息 → scheduler 同步 RESTING
      if (s.isResting) {
        if (loopState.status !== STATES.RESTING) {
          setState({
            status: STATES.RESTING,
            restEndsAt: Date.now() + (s.restRemainingMs || 0),
            hint: '休息中'
          });
        }
      } else if (loopState.status === STATES.RESTING) {
        setState({ status: STATES.RUNNING, hint: '', restEndsAt: 0 });
      }
      if (s.queueLength === 0 && !s.isResting) return;
      await sleep(1000);
    }
  }

  // S6 fix v6: 加 since 时间窗口，只算本次 LOOP 启动以来的 sayhi_sent
  // 修 bug：之前没窗口，把历史所有 sayhi_sent 累计算进 sayhiCount（HR 看到"已招呼 14"明明这次没开 sayHi）
  /**
   * 统计本 LOOP 启动后实际发出的 sayhi_sent 事件数(给 goalN 判终止用)
   *
   * 参数:
   *   - since: 时间窗起点(只算 ts >= since 的事件)
   *
   * 返回: number,本 LOOP 已发招呼数
   */
  async function countSayhiSentSince(since) {
    if (!self.BossEvents) return 0;
    const sinceTs = since || 0;
    const recent = await self.BossEvents.getRecentEvents(1000);
    return recent.filter(function (e) {
      return e.stage === 'sayhi_sent' && e.ts >= sinceTs;
    }).length;
  }

  // 滚动触发函数：默认是 mock，由 background.js 启动段替换为真发 chrome.tabs.sendMessage
  let scrollFn = async function () {
    console.warn('[Scheduler] scrollFn 是 mock，无效；等 background 启动段接通');
  };

  /**
   * 注入真实"滚动 BOSS 推荐页"实现(由 background.js 启动时传 chrome.tabs.sendMessage 包装)
   *
   * 参数:
   *   - fn: async 函数,无参,触发 BOSS 页面滚动加载下一批候选人
   */
  function setScrollFn(fn) {
    scrollFn = fn;
  }

  // S6 fix v4: 自然终止 (STOPPED / PAUSED) 时通知 background 同步 enabled=false
  // 避免 sidepanel 状态徽章 fallback 到 "运行中（手动）" 路径（loop=STOPPED 但 enabled=true 时）
  let onStoppedCallback = null;
  /**
   * 注册"自然终止(STOPPED)时的回调",由 background.js 用于同步 enabled=false
   *
   * 参数:
   *   - fn: function(reason) — reason 为 'reached_goal_n' / 'reached_goal_k' / 'paused_failed' 等
   */
  function setOnStopped(fn) {
    onStoppedCallback = fn;
  }
  function fireOnStopped(reason) {
    if (typeof onStoppedCallback === 'function') {
      try { onStoppedCallback(reason); } catch (e) {
        console.warn('[Scheduler] onStopped callback err:', e);
      }
    }
  }

  // PAUSED 中的轻量轮询：5s 一次查 evaluations.pending 是否出现新条目
  // 有 → 自动 resume（HR 手动滚 BOSS 真页面 → 新 fetch → 写 pending → 触发恢复）
  // 跟 tick ②/③ 步保持一致用 evaluations.pending 信号（避免 candidate_pool/evaluations 不同步带来的 race）
  let pausedWatchdog = null;
  /**
   * PAUSED 状态下 5s 轮询一次:发现 evaluations.pending > 0 → 自动 resume + 重启 tick
   * HR 手动滚 BOSS 页面 → 新 fetch → 写 pending → 本 watchdog 抓到 → 续跑
   */
  function startPausedWatchdog() {
    if (pausedWatchdog) return;
    pausedWatchdog = setInterval(async function () {
      if (loopState.status !== STATES.PAUSED) {
        clearInterval(pausedWatchdog);
        pausedWatchdog = null;
        return;
      }
      const cur = await countPendingEvaluationsSince(loopState.loopStartedAt);
      if (cur > 0) {
        console.info('[Scheduler] PAUSED 中检测到新评估 pending，自动恢复 RUNNING');
        clearInterval(pausedWatchdog);
        pausedWatchdog = null;
        setState({ status: STATES.RUNNING, hint: '' });
        runTick();
      }
    }, 5000);
  }

  // tick 主循环：仅当 RUNNING 时跑；遇 STOPPED / PAUSED break
  /**
   * 调度主循环:每轮 = 滚动 → 等新 pending → 等评估完 → 等 sayHi 清空 → 计数 → 判终止 → 随机延迟
   * 通过 evaluations.pending 计数串联各阶段,避免和 candidate_pool 写入产生 race
   *
   * 返回: Promise(无返回值;状态机驱动,STOPPED/PAUSED 时退出)
   */
  async function runTick() {
    if (tickRunning) {
      console.warn('[Scheduler] tick 已在跑，重复调用忽略');
      return;
    }
    tickRunning = true;
    // 第一轮特殊：背景 START_LOOP 已 reload BOSS tab 触发首批 /rec/geek/list 抓取，
    // BOSS reload + inject 抓 + background 写 evaluations.pending 全在 background
    // START_LOOP 内的 2.5s 等待里完成，无需 scrollFn
    let firstRound = true;
    console.info('[Scheduler] tick start');
    try {
      while (loopState.status === STATES.RUNNING) {
        if (firstRound) {
          setState({ batchStartedAt: Date.now(), hint: '处理 reload 触发的首批' });
          console.info('[Scheduler] 第一轮 — 跳过 scroll，等 reload 触发的首批 pending 写入');
        } else {
          setState({ batchStartedAt: Date.now(), hint: '滚动中' });
          // ① 派滚动事件 → BOSS infinite scroll 触发新 fetch
          try { await scrollFn(); } catch (e) { console.warn('[Scheduler] scrollFn err:', e); }
        }

        // ② 等本批 evaluations.pending 写入：8s 内本 LOOP 的 pending 计数从 0 变 > 0
        //    时间窗口 = loopStartedAt（fix v6 隔离历史遗留 pending）
        let gotNew = false;
        const newBatchDeadline = Date.now() + 8000;
        while (Date.now() < newBatchDeadline) {
          const cur = await countPendingEvaluationsSince(loopState.loopStartedAt);
          setState({ hint: firstRound ? ('等 reload 触发的首批 (pending=' + cur + ')') : ('等翻页加载 (pending=' + cur + ')') });
          if (cur > 0) { gotNew = true; break; }
          await sleep(300);
        }
        if (!gotNew) {
          setState({ status: STATES.PAUSED, hint: '翻页失败 — 请手动滚动 BOSS 推荐页确认还有候选人，再点继续' });
          console.warn('[Scheduler] 翻页超时 8s（evaluations.pending 未出现），进入 PAUSED');
          startPausedWatchdog();
          // PAUSED 不调 fireOnStopped — HR 可能点继续，需要保持 enabled=true 让 watchdog 抓新 pending
          break;
        }

        // ③ 等本批所有评估完成：60s 内 pending 计数回到 0（hint 实时显示当前 pending 数）
        const evalDeadline = Date.now() + 60000;
        let allDone = false;
        while (Date.now() < evalDeadline) {
          if (loopState.status !== STATES.RUNNING && loopState.status !== STATES.RESTING) return;
          const cur = await countPendingEvaluationsSince(loopState.loopStartedAt);
          setState({ hint: '评估中 (待完成 ' + cur + ')' });
          if (cur === 0) { allDone = true; break; }
          await sleep(1000);
        }
        if (!allDone) {
          console.warn('[Scheduler] 评估 60s 超时，pending 仍 > 0，跳过该批继续');
          setState({ hint: '评估超时，已跳过该批' });
        }

        // ④ 等 sayHi 队列清空 + 同步 RESTING（RESTING 内嵌处理）
        setState({ hint: '等 sayHi 队列' });
        await waitSayHiDrain();

        // ④' final pending check：防 ④ 期间 BOSS 又有新 fetch 写入新 pending
        //   （比如 sayHi 触发的 BOSS 副作用、heartbeat fetch 等）
        //   STOPPED 显示前必须保证本 LOOP 没有 pending，避免"评估中却已停止"
        const finalCheckDeadline = Date.now() + 30000;
        while (Date.now() < finalCheckDeadline) {
          if (loopState.status !== STATES.RUNNING && loopState.status !== STATES.RESTING) return;
          const cur = await countPendingEvaluationsSince(loopState.loopStartedAt);
          setState({ hint: '收尾确认 (待完成 ' + cur + ')' });
          if (cur === 0) break;
          await sleep(1000);
        }

        // ⑤ 计数（fix v6: 时间窗口 loopStartedAt 隔离历史 sayhi_sent）
        const sayhiSentCount = await countSayhiSentSince(loopState.loopStartedAt);
        const newRoundCount = loopState.roundCount + 1;
        setState({
          sayhiCount: sayhiSentCount,
          roundCount: newRoundCount,
          hint: ''
        });

        // ⑥ 终止条件
        if (loopState.goalN !== null && sayhiSentCount >= loopState.goalN) {
          setState({ status: STATES.STOPPED, hint: '已达 N=' + loopState.goalN });
          console.info('[Scheduler] 自然终止 — 达 N=' + loopState.goalN);
          fireOnStopped('reached_goal_n');
          break;
        }
        if (loopState.goalK !== null && newRoundCount >= loopState.goalK) {
          setState({ status: STATES.STOPPED, hint: '已达 K=' + loopState.goalK });
          console.info('[Scheduler] 自然终止 — 达 K=' + loopState.goalK);
          fireOnStopped('reached_goal_k');
          break;
        }

        // ⑦ tick 间随机延迟（复用 sayHi 节流参数）
        const cfg = (self.BOSS_SAYHI_CONFIG_GETTER && self.BOSS_SAYHI_CONFIG_GETTER()) || {};
        const dMin = cfg.delayMin || 1500;
        const dMax = cfg.delayMax || 5000;
        const delay = dMin + Math.random() * (dMax - dMin);
        await sleep(delay);

        firstRound = false;  // 第一轮处理完，后续都走 scroll 路径
      }
    } finally {
      tickRunning = false;
      console.info('[Scheduler] tick end — final state ' + loopState.status);
    }
  }

  // 校验：HR 必须先选 JD（appConfig.jd.activeJdId）+ 配 LLM key + 至少一个目标非空
  // 校验逻辑由 background.js 的 START_LOOP route 做（能拿到 appConfig），
  // scheduler 这层只检查"goalN/goalK 至少一个非空"
  /**
   * 启动一轮调度循环:重置计数 + 进 RUNNING 状态(实际 tick 由 background 在调完此函数后调 runTick)
   *
   * 参数:
   *   - opts: { goalN, goalK } 至少一个 > 0 — N = 发出招呼数,K = 滚动轮数
   *
   * 返回: 无返回值;状态机非法或参数缺失抛错
   */
  function start(opts) {
    if (loopState.status !== STATES.IDLE && loopState.status !== STATES.STOPPED) {
      throw makeErr('SchedulerStateError', '当前状态 ' + loopState.status + ' 不能 start');
    }
    const goalN = (typeof opts.goalN === 'number' && opts.goalN > 0) ? opts.goalN : null;
    const goalK = (typeof opts.goalK === 'number' && opts.goalK > 0) ? opts.goalK : null;
    if (goalN === null && goalK === null) {
      throw makeErr('SchedulerInputError', 'goalN 和 goalK 至少一个必填');
    }
    const now = Date.now();
    setState({
      status: STATES.RUNNING,
      goalN: goalN,
      goalK: goalK,
      sayhiCount: 0,
      roundCount: 0,
      loopStartedAt: now,    // S6 fix v6：作为 sayhi/pending 时间窗口起点，隔离历史数据
      batchStartedAt: now,
      restEndsAt: 0,
      hint: ''
    });
    console.info('[Scheduler] start — goalN=' + goalN + ' goalK=' + goalK + ' loopStartedAt=' + now);
  }

  /**
   * 强制停止调度(HR 点"停止"或 background 关掉 enabled);状态机进 STOPPED,tick 自然退出
   */
  function stop() {
    if (loopState.status === STATES.IDLE || loopState.status === STATES.STOPPED) return;
    if (pausedWatchdog) {
      clearInterval(pausedWatchdog);
      pausedWatchdog = null;
    }
    setState({ status: STATES.STOPPED, hint: '' });
    console.info('[Scheduler] stop');
  }

  /**
   * 从 PAUSED 状态手动恢复 RUNNING(HR 在 dashboard 点"继续"按钮触发)
   * 仅切状态;后续 tick 调用由 background 在 PAUSED watchdog 抓到 pending 时拉起
   */
  function resume() {
    if (loopState.status !== STATES.PAUSED) {
      throw makeErr('SchedulerStateError', '只能从 PAUSED 状态 resume，当前 ' + loopState.status);
    }
    setState({ status: STATES.RUNNING, hint: '' });
    console.info('[Scheduler] resume');
  }

  global.BossScheduler = {
    STATES: STATES,
    getState: getState,
    start: start,
    stop: stop,
    resume: resume,
    runTick: runTick,
    setScrollFn: setScrollFn,
    setOnStopped: setOnStopped
  };
})(self);
