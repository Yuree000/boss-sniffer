// BOSS Sniffer - judge.js (v0.12.0)
// LLM-only 候选人判别
// 给定 candidate + JD 模板（BossJD v0.12.0 格式）+ LLM 配置 → 调 LLM → 输出动态 breakdown + 二态决策
//
// v0.12.0 重构：从「固定 7 维」改成「必要条件 + 可选条件」动态结构
//   JD: { mustConditions: [{id, text}], optionalConditions: [{id, text}], optionalThreshold }
//   LLM 输出: mustBreakdown + optionalBreakdown 按 M1..M_n / O1..O_n key 索引
//
// 输出 schema：
// {
//   decision: '符合' | 'pass',
//   mustBreakdown: { "M1": { value, reason }, "M2": { value, reason }, ... },
//   optionalBreakdown: { "O1": { value, reason }, "O2": { value, reason }, ... },
//   reason: '一句话最终理由',
//   judgedAt, jdTitle, jdId, provider, modelId, usage, attempts
// }
//
// 失败：抛错让上层（background.js）写"评估失败"状态

(function (global) {
  'use strict';

  const VALID_DECISIONS = ['符合', 'pass'];  // 业务逻辑 §3 二态决策

  // 校验单个 breakdown 子组（mustBreakdown 或 optionalBreakdown）
  //   group: LLM 输出的 { M1: {...}, M2: {...} } 对象
  //   conditions: JD 的 mustConditions 或 optionalConditions 数组
  //   prefix: 'M' 或 'O'
  //   groupName: 错误信息里的字段名
  //
  // 校验规则：
  //   1. group 必须是对象
  //   2. group 必须含且仅含 prefix + 1..n 这 n 个 key
  //   3. 每个 item.value ∈ [true, false, 'unknown']
  function validateBreakdownGroup(group, conditions, prefix, groupName) {
    if (group === undefined || group === null) {
      throw makeErr('JudgeSchemaError', '缺 ' + groupName);
    }
    if (typeof group !== 'object' || Array.isArray(group)) {
      throw makeErr('JudgeSchemaError', groupName + ' 必须是对象');
    }
    // 期望的 key 集合
    for (let i = 1; i <= conditions.length; i++) {
      const key = prefix + i;
      const item = group[key];
      if (!item || typeof item !== 'object') {
        throw makeErr('JudgeSchemaError', groupName + ' 缺 ' + key);
      }
      if (item.value !== true && item.value !== false && item.value !== 'unknown') {
        throw makeErr('JudgeSchemaError', groupName + '.' + key + ' value 非法：' + JSON.stringify(item.value));
      }
    }
    // 校验不能多出
    const groupKeys = Object.keys(group);
    if (groupKeys.length !== conditions.length) {
      throw makeErr('JudgeSchemaError',
        groupName + ' 键数不匹配：期望 ' + conditions.length + ' 项，实际 ' + groupKeys.length + ' 项');
    }
    // 每个 key 形如 prefix + 数字 且在 [1, n] 范围
    const re = new RegExp('^' + prefix + '(\\d+)$');
    for (let i = 0; i < groupKeys.length; i++) {
      const k = groupKeys[i];
      const m = k.match(re);
      if (!m) {
        throw makeErr('JudgeSchemaError', groupName + ' 含非法 key: ' + k);
      }
      const n = parseInt(m[1], 10);
      if (n < 1 || n > conditions.length) {
        throw makeErr('JudgeSchemaError', groupName + ' key 超出范围: ' + k);
      }
    }
  }

  // 校验 LLM 输出 schema（v0.12.0 动态）
  //   入参：parsed = LLM 输出的 JSON 对象；jd = 当前评估用的 JD 模板
  //   不通过抛 JudgeSchemaError，由 judgeCandidate 重试逻辑接住
  function validateOutput(parsed, jd) {
    if (!parsed || typeof parsed !== 'object') {
      throw makeErr('JudgeSchemaError', 'LLM 输出不是对象');
    }
    if (VALID_DECISIONS.indexOf(parsed.decision) === -1) {
      throw makeErr('JudgeSchemaError', 'decision 非法：' + parsed.decision);
    }
    const must = (jd && Array.isArray(jd.mustConditions)) ? jd.mustConditions : [];
    const opt = (jd && Array.isArray(jd.optionalConditions)) ? jd.optionalConditions : [];
    validateBreakdownGroup(parsed.mustBreakdown, must, 'M', 'mustBreakdown');
    validateBreakdownGroup(parsed.optionalBreakdown, opt, 'O', 'optionalBreakdown');
    return parsed;
  }

  // 把 candidate 序列化为对 LLM 友好的紧凑文本（剥噪、去 null、保字段路径）
  function serializeCandidate(c) {
    if (!c) return '(空)';
    const basic = c.basic || {};
    const exp = c.expectation || {};
    const works = c.workHistory || [];
    const edus = c.education || [];
    const signals = c.bossSignals || {};
    const chats = c.chatHistory || [];

    const lines = [];
    lines.push('# 候选人');
    lines.push('candidateId: ' + (c.candidateId || ''));
    lines.push('');
    lines.push('## basic（基础）');
    if (basic.name) lines.push('- name: ' + basic.name);
    if (basic.gender) lines.push('- gender: ' + basic.gender);
    if (basic.age) lines.push('- age: ' + basic.age);
    if (basic.education) lines.push('- education: ' + basic.education);
    if (basic.yearsOfExperience) lines.push('- yearsOfExperience: ' + basic.yearsOfExperience);
    if (basic.city) lines.push('- city: ' + basic.city);
    if (basic.activeStatus) lines.push('- activeStatus: ' + basic.activeStatus);
    if (basic.desc) lines.push('- desc: ' + basic.desc);
    // v0.15.4：应届标志（BOSS 原始枚举，先不解码，让 LLM 从上下文推断）
    if (basic.freshGraduate !== undefined && basic.freshGraduate !== null) {
      lines.push('- freshGraduate（BOSS 原始枚举）: ' + basic.freshGraduate);
    }
    // v0.17.0.9 POC A6 回灌：BOSS 沟通页推的简历卡片消息含 applyStatus(在校-月内到岗等)
    // 这是 LLM 评估「何时能到岗」的关键证据,主扩展之前没用
    const resumeCard = signals.resumeCard || null;
    if (resumeCard && resumeCard.applyStatus) {
      lines.push('- applyStatus（来自 BOSS 简历卡片消息）: ' + resumeCard.applyStatus);
    }

    lines.push('');
    lines.push('## expectation（期望）');
    if (exp.candidateOwn) lines.push('- candidateOwn: ' + exp.candidateOwn);
    // v0.15.2：不再序列化 exp.jobAligned 给 LLM。
    // 该字段是"HR 当前 JD 名"（HR 自己选的，候选人没填），但字段名"jobAligned"
    // 字面暗示"对齐意向"，LLM 容易当作候选人意向 → 污染 M3 / M4 判断
    // （例：印尼语实习生 JD 下，LLM 看到 jobAligned: 印尼语实习生 会暗示
    //   ① 候选人会印尼语 ② 候选人想做实习，但实际两条都没证据）。
    // 字段在 candidate.expectation.jobAligned 中保留，供 sidepanel / 调试用。
    if (exp.salaryDesc) lines.push('- salaryDesc: ' + exp.salaryDesc);
    if (exp.cityName) lines.push('- cityName（期望城市）: ' + exp.cityName);
    // v0.15.4：候选人求职意向类型（全职 / 实习 等的 BOSS 枚举）
    if (exp.expectType !== undefined && exp.expectType !== null) {
      lines.push('- expectType（BOSS 原始枚举）: ' + exp.expectType);
    }

    if (works.length) {
      lines.push('');
      lines.push('## workHistory（工作经历）');
      works.forEach(function (w, i) {
        const parts = [];
        if (w.timeDesc) parts.push(w.timeDesc);
        else if (w.from || w.to) parts.push((w.from || '?') + '-' + (w.to || '?'));
        if (w.company) parts.push('@' + w.company);
        if (w.title) parts.push(w.title);
        lines.push('- [' + i + '] ' + parts.join(' / '));
        if (w.description) lines.push('    描述: ' + w.description);
        // v0.15.4：补 3 个工作元信息字段（industry / workType / workMonths）
        const meta = [];
        if (w.industry) meta.push('industry: ' + w.industry);
        if (w.workType !== undefined && w.workType !== null) {
          meta.push('workType（BOSS 原始枚举）: ' + w.workType);
        }
        if (w.workMonths !== undefined && w.workMonths !== null) {
          meta.push('workMonths: ' + w.workMonths);
        }
        if (meta.length) lines.push('    ' + meta.join(' / '));
      });
    }

    if (edus.length) {
      lines.push('');
      lines.push('## education（教育）');
      edus.forEach(function (e, i) {
        const parts = [];
        if (e.from || e.to) parts.push((e.from || '?') + '-' + (e.to || '?'));
        if (e.school) parts.push(e.school);
        if (e.major) parts.push(e.major);
        if (e.degree) parts.push(e.degree);
        lines.push('- [' + i + '] ' + parts.join(' / '));
        // v0.15.4：留学经历 / GPA 等强证据（核心字段）
        if (e.eduDescription) lines.push('    eduDescription: ' + e.eduDescription);
        if (e.eduType !== undefined && e.eduType !== null) {
          lines.push('    eduType（BOSS 原始枚举）: ' + e.eduType);
        }
      });
    }

    const bossWords = []
      .concat(signals.highlightWords || [])
      .concat(signals.markWords || [])
      .filter(Boolean);
    const card = signals.resumeCard || null;
    const hasCardSummary = card && (card.content1 || card.content2 || card.bottomText || card.position);
    // v0.17.0.9 POC A6 回灌(P1):lastCompany / lastPosition / everWorkPositionNameList
    // workHistory 为空时这些是 LLM 唯一的工作经历线索
    const hasLastJob = signals.lastCompany || signals.lastPosition ||
                       (Array.isArray(signals.everWorkPositionNameList) && signals.everWorkPositionNameList.length);
    if (bossWords.length || signals.recommendReason || hasCardSummary || hasLastJob) {
      lines.push('');
      lines.push('## bossSignals（Boss 算法标的，最低优先级）');
      if (bossWords.length) lines.push('- highlightWords: ' + bossWords.join(' / '));
      if (signals.recommendReason) lines.push('- recommendReason: ' + signals.recommendReason);
      // 最近工作公司 + 岗位(workHistory 缺时补)
      if (signals.lastCompany) lines.push('- lastCompany: ' + signals.lastCompany);
      if (signals.lastPosition) lines.push('- lastPosition: ' + signals.lastPosition);
      if (Array.isArray(signals.everWorkPositionNameList) && signals.everWorkPositionNameList.length) {
        lines.push('- everWorkPositionNameList: ' + signals.everWorkPositionNameList.join(' / '));
      }
      // v0.17.0.9 POC A6 回灌：BOSS 简历卡片消息的排版文字行(content1/2/bottomText)
      // 一般是 BOSS 整理过的关键信息,如 "求职期望  咨询/翻译" / "毕业于 XX 大学 | XX 专业"
      // 与 chat/geek/info 字段可能重复,LLM 看到重复信息会增强置信
      if (card && card.content1) lines.push('- bossResumeCard.content1: ' + card.content1);
      if (card && card.content2) lines.push('- bossResumeCard.content2: ' + card.content2);
      if (card && card.bottomText) lines.push('- bossResumeCard.bottomText: ' + card.bottomText);
      if (card && card.position) lines.push('- bossResumeCard.position: ' + card.position);
      // 简版教育经历(BOSS 卡片下方那几行,若 chat/geek/info 教育有缺则作补充)
      if (card && Array.isArray(card.experiences) && card.experiences.length) {
        card.experiences.forEach(function (e, i) {
          const parts = [];
          if (e.startDate || e.endDate) parts.push((e.startDate || '?') + '-' + (e.endDate || '?'));
          if (e.organization) parts.push(e.organization);
          if (e.occupation) parts.push(e.occupation);
          if (parts.length) lines.push('- bossResumeCard.experiences[' + i + ']: ' + parts.join(' / '));
        });
      }
    }

    if (chats.length) {
      lines.push('');
      lines.push('## chatHistory（聊天，最高优先级）');
      chats.forEach(function (m, i) {
        const role = m.role || (m.from ? 'sender:' + m.from.uid : '?');
        const text = m.text || (m.body && m.body.text) || '';
        if (text) lines.push('- [' + i + '] ' + role + ': ' + text);
      });
    }

    // v0.17.0.10 POC A7 回灌：沟通页详情面板 DOM 实际渲染的文本
    // 优先级位于 chatHistory 之下、简历字段之上（信息源优先级段已声明）
    // 关键场景：补全接口层"死路"的 desc / workExp.description / eduExp.eduDescription 三个长文本 + 多城市原文
    const dom = signals.domDetail || null;
    if (dom) {
      // v0.18.0：hasContent 判断不再含 dom.desc / dom.skillTags（详情面板永远没这两字段）
      //   简介+技能信息现在通过 resumeFullText（在线简历 iframe）传递
      const hasContent = dom.expect || dom.workEduText || dom.baseStats ||
                        dom.resumeCardText || dom.resumeFullText;
      if (hasContent) {
        lines.push('');
        lines.push('## domDetail（沟通页详情面板 DOM 实际显示，次高优先级）');
        if (dom.baseStats) lines.push('- baseStats（DOM 摘要）: ' + dom.baseStats);
        if (dom.expect) {
          const e = dom.expect;
          if (e.prefix) lines.push('- expect.prefix: ' + e.prefix + '（"期望" = 候选人主动填；"最近关注" = 候选人没填、BOSS 推算）');
          if (e.cityRaw) lines.push('- expect.cityRaw（期望工作城市原文）: ' + e.cityRaw);
          if (Array.isArray(e.cities) && e.cities.length > 1) {
            lines.push('- expect.cities（拆分后多城市数组）: ' + e.cities.join(' | '));
          }
          if (e.jobRaw) lines.push('- expect.jobRaw: ' + e.jobRaw);
          if (e.salaryRaw) lines.push('- expect.salaryRaw: ' + e.salaryRaw);
        }
        if (dom.workEduText) lines.push('- workEduText（工作+教育混合，BOSS UI 完整文本）: ' + dom.workEduText);
        if (dom.resumeCardText) lines.push('- resumeCard（BOSS 简历卡片消息）: ' + dom.resumeCardText);
        // v0.17.1.2：在线简历弹窗 iframe 的完整简历文本（含个人简介 / 语言能力 / 完整工作教育经历）
        //   这是详情面板 desc/skillTags 字段全为 null 时的主要信息源
        //   原文是 iframe.contentDocument.body.textContent，未做结构化解析，LLM 自行从中抽取证据
        if (dom.resumeFullText) {
          lines.push('- resumeFullText（在线简历弹窗完整文本，**最丰富信息源**）:');
          lines.push(dom.resumeFullText);
        }
      }
    }

    return lines.join('\n');
  }

  function makeErr(name, message, extras) {
    const e = new Error(message);
    e.name = name;
    if (extras) Object.assign(e, extras);
    return e;
  }

  // 截断长字符串,避免 IDB 里堆太多文本(导出诊断包时单条占用过大)
  function truncate(text, maxLen) {
    if (text === null || text === undefined) return null;
    const s = typeof text === 'string' ? text : String(text);
    return s.length > maxLen ? s.slice(0, maxLen) + '…(截断,原长 ' + s.length + ')' : s;
  }

  // 从一次尝试的 error 抽取结构化字段,生成 perAttempt 条目
  // ok=true 时 error 应为 null,其余字段也都为 null
  function buildAttemptEntry(attemptAt, latencyMs, error, parsedSnapshot) {
    if (!error) {
      return {
        attemptAt: attemptAt,
        latencyMs: latencyMs,
        error: null,
        errorName: null,
        httpStatus: null,
        errorBody: null,
        rawLlmText: null
      };
    }
    // JudgeSchemaError 没有 rawText,但 parsedSnapshot(已 parse 的 JSON)能反映 LLM 实际输出
    let rawLlmText = error.rawText || null;
    if (!rawLlmText && error.name === 'JudgeSchemaError' && parsedSnapshot) {
      try { rawLlmText = JSON.stringify(parsedSnapshot); } catch (_e) { rawLlmText = null; }
    }
    return {
      attemptAt: attemptAt,
      latencyMs: latencyMs,
      error: String(error.message || error.name || 'unknown'),
      errorName: error.name || 'Error',
      httpStatus: (typeof error.status === 'number') ? error.status : null,
      errorBody: truncate(error.body, 1024),
      rawLlmText: truncate(rawLlmText, 2048)
    };
  }

  // 重试策略：
  //   - 可重试：超时 / 5xx / 429 rate limit / 网络层错 / JSON 解析失败 / schema 错
  //   - 不可重试：4xx 其他（鉴权 401/403、参数 400）/ 配置缺失 / 输入不完整
  //   - 最多 3 次尝试（首次 + 2 重试），指数退避 1s → 2s + 抖动
  const MAX_RETRY_ATTEMPTS = 3;
  const RETRY_BASE_DELAY_MS = 1000;

  function isRetryableError(err) {
    if (!err) return false;
    if (err.name === 'LLMHttpError') {
      if (err.status === 429) return true;                                  // rate limit
      if (typeof err.status === 'number' && err.status >= 500) return true; // 5xx
      if (err.status === undefined || err.status === 0) return true;        // 网络层错
      if (/超时/.test(err.message || '')) return true;
      return false;                                                          // 4xx 其余（鉴权 / 参数）
    }
    return err.name === 'LLMResponseError' || err.name === 'JudgeSchemaError';
  }

  function sleep(ms) {
    return new Promise(function (r) { setTimeout(r, ms); });
  }

  // 主入口：异步评估单个候选人（带重试）
  // jd: BossJD 模板格式 { jdId, name, base, educationMin, language, ageMax, experienceHard, bonus, veto, specialRules, jdText }
  async function judgeCandidate(candidate, jd, llmConfig) {
    if (!candidate || !candidate.basic) {
      throw makeErr('JudgeInputError', '候选人对象不完整');
    }
    if (!jd || !jd.name) {
      throw makeErr('JudgeInputError', 'JD 模板缺失或无 name 字段');
    }
    if (!llmConfig || !llmConfig.apiKey) {
      throw makeErr('LLMNotConfigured', '未配置 LLM API Key（请在扩展设置页填入）');
    }
    if (!llmConfig.model) {
      throw makeErr('LLMNotConfigured', '未配置 LLM Model');
    }
    if (!self.BossPromptBuilder) {
      throw makeErr('JudgeInputError', 'BossPromptBuilder 未加载');
    }

    const systemPrompt = self.BossPromptBuilder.build(jd);
    const userPrompt = serializeCandidate(candidate);
    const startedAt = Date.now();
    const perAttempt = [];  // 每次尝试一条:成功 error=null,失败附带 errName/httpStatus/errorBody/rawLlmText

    let lastErr;
    for (let attempt = 0; attempt < MAX_RETRY_ATTEMPTS; attempt++) {
      const attemptStart = Date.now();
      let parsed = null;
      try {
        const resp = await self.BossLLM.callLlm(llmConfig, {
          system: systemPrompt,
          user: userPrompt,
          maxTokens: 2048
        });
        parsed = self.BossLLM.parseJsonOutput(resp.text);
        validateOutput(parsed, jd);

        perAttempt.push(buildAttemptEntry(attemptStart, Date.now() - attemptStart, null, null));
        return {
          decision: parsed.decision,
          mustBreakdown: parsed.mustBreakdown,
          optionalBreakdown: parsed.optionalBreakdown,
          reason: String(parsed.reason || ''),
          judgedAt: Date.now(),
          latencyMs: Date.now() - startedAt,
          jdTitle: jd.name,
          jdId: jd.jdId || '',
          // jdSnapshot：评估时刻的 JD 快照，sidepanel / dashboard 渲染时无需异步查 BossJD
          // HR 切 JD 后历史评估卡片仍能正确展示对应 must.text
          jdSnapshot: {
            name: jd.name,
            mustConditions: Array.isArray(jd.mustConditions) ? jd.mustConditions.slice() : [],
            optionalConditions: Array.isArray(jd.optionalConditions) ? jd.optionalConditions.slice() : [],
            optionalThreshold: Number(jd.optionalThreshold) || 0
          },
          provider: llmConfig.providerName || llmConfig.protocol || '',
          modelId: llmConfig.model,
          usage: resp.usage || null,
          attempts: attempt + 1,
          perAttempt: perAttempt.slice()
        };
      } catch (e) {
        perAttempt.push(buildAttemptEntry(attemptStart, Date.now() - attemptStart, e, parsed));
        lastErr = e;
        if (!isRetryableError(e)) break;                       // 鉴权/输入错 → 立刻抛
        if (attempt === MAX_RETRY_ATTEMPTS - 1) break;          // 用完次数
        const delay = RETRY_BASE_DELAY_MS * Math.pow(2, attempt) + Math.floor(Math.random() * 500);
        if (self.BossDiag) {
          self.BossDiag.log('warn', 'judge.retry', '尝试失败,即将重试', {
            candidateId: candidate.candidateId || '?',
            attempt: attempt + 1,
            delayMs: delay,
            errName: e.name || 'Error',
            errMsg: e.message || ''
          });
        } else {
          console.warn(
            '[BOSS-Sniffer judge] candidate=' + (candidate.candidateId || '?') +
            ' 第' + (attempt + 1) + '次失败，' + delay + 'ms 后重试 — ' +
            (e.name || 'Error') + ': ' + (e.message || '')
          );
        }
        await sleep(delay);
      }
    }
    // 把轨迹挂到 err 上,让 background.js 失败路径能写进 evaluation
    if (lastErr) {
      lastErr.perAttempt = perAttempt;
      lastErr.totalLatencyMs = Date.now() - startedAt;
      lastErr.attempts = perAttempt.length;
    }
    throw lastErr;
  }

  global.BossJudge = {
    judgeCandidate: judgeCandidate,
    serializeCandidate: serializeCandidate,
    validateOutput: validateOutput,
    VALID_DECISIONS: VALID_DECISIONS
  };
})(self);
