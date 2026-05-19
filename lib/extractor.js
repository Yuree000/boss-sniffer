// BOSS Sniffer - extractor.js
// 把 Boss 原始 API 响应归一化为标准"候选人对象"
//
// v0.2.1 起 extractFromCapture 统一返回数组（场景 1 = 单元素数组，场景 2 = N 元素数组）
// 让下游 background.js 用统一循环处理。

(function (global) {
  'use strict';

  function pickTimeRange(timeDesc) {
    if (!timeDesc) return { from: null, to: null };
    const parts = String(timeDesc).split(/[-—~至到]/);
    return {
      from: (parts[0] || '').trim() || null,
      to: (parts[1] || '').trim() || null
    };
  }

  function nz(v) {
    return v === undefined || v === null || v === '' ? null : v;
  }

  // v0.15.5：城市编码字典反查（间接依赖，字典未加载时降级 null）
  function lookupRegionCode(code) {
    if (code === undefined || code === null || code === '') return null;
    const dict = global.BossCityCodes;
    if (dict && typeof dict.lookupCityCode === 'function') {
      return dict.lookupCityCode(code);
    }
    return null;
  }

  // 抽取 markWords / matches / hlmatches 这种"Boss 标记的高亮词"为字符串数组
  function pickHighlightWords(arr) {
    if (!Array.isArray(arr)) return null;
    const words = arr
      .map(function (x) {
        if (typeof x === 'string') return x;
        if (x && typeof x === 'object' && x.content) return x.content;
        return null;
      })
      .filter(Boolean);
    return words.length ? words : null;
  }

  // ========== 场景 1：chat/geek/info ==========
  function extractFromGeekInfo(apiResponse) {
    const data = apiResponse && apiResponse.zpData && apiResponse.zpData.data;
    if (!data || !data.uid) return null;

    return {
      candidateId: String(data.uid),
      encryptUid: nz(data.encryptUid),
      basic: {
        name: nz(data.name),
        age: nz(data.ageDesc),
        gender: data.gender,
        education: nz(data.edu),
        yearsOfExperience: nz(data.year),
        city: nz(data.city),
        activeStatus: nz(data.activeTimeDesc),
        avatar: nz(data.largeAvatar || data.avatar),
        desc: null
      },
      expectation: {
        candidateOwn: nz(data.position),
        jobAligned: nz(data.toPosition),
        salaryDesc: nz(data.salaryDesc),
        salaryLow: data.lowSalary,
        salaryHigh: data.highSalary,
        // v0.15.5：BOSS regionCode 是公开的"中国气象局新编码"（非加密），
        // 走 city-codes 字典反查。精确命中 → 市名；miss → "XX 省（粗）"；
        // 都不命中 → null（兼容老行为）。字典加载失败时降级 null。
        cityName: lookupRegionCode(data.regionCode)
      },
      workHistory: (data.workExpList || []).map(function (w) {
        const t = pickTimeRange(w.timeDesc);
        return {
          from: t.from,
          to: t.to,
          timeDesc: nz(w.timeDesc),
          company: nz(w.company),
          title: nz(w.positionName),
          description: null // 场景 1 接口不返回工作描述
        };
      }),
      education: (data.eduExpList || []).map(function (e) {
        const t = pickTimeRange(e.timeDesc);
        return {
          from: t.from,
          to: t.to,
          school: nz(e.school),
          major: nz(e.major),
          degree: nz(e.degree),
          degreeCode: e.degreeCode
        };
      }),
      bossSignals: {
        highlightWords: data.highLightGeekResumeWords || null,
        markWords: null,
        lastTime: nz(data.lastTime),
        bothTalked: !!data.bothTalked,
        applyStatus: nz(data.applyStatusDes),
        relationType: data.relationType,
        viewed: null,
        recommendReason: null,
        // v0.17.0.9 POC A6 回灌(P1):chat/geek/info 字段查漏 — 主扩展之前没用的字段
        // workHistory 为空或缺 description 时,这些字段是关键弥补
        lastCompany: nz(data.lastCompany || data.lastCompany2),
        lastPosition: nz(data.lastPosition || data.lastPosition2),
        // 候选人做过的所有岗位名(BOSS 字典化),给 LLM 一个"履历职业线"概览
        everWorkPositionNameList: Array.isArray(data.everWorkPositionNameList) && data.everWorkPositionNameList.length
          ? data.everWorkPositionNameList
          : null
      },
      source: {
        scenario: 'chat',
        apiPath: '/wapi/zpjob/chat/geek/info',
        batchAt: Date.now(),
        indexInBatch: 0
      }
    };
  }

  // ========== 场景 2：rec/geek/list 列表里的单个候选人 ==========
  // batchAt: 同一批 15 个候选人共享的时间戳（保证整批一起排序）
  // indexInBatch: 候选人在 Boss 推荐流里的视觉位置（0 = 页面最顶部）
  function extractOneFromRecList(item, batchAt, indexInBatch) {
    if (!item || !item.geekCard) return null;
    const card = item.geekCard;
    const lastWork = item.geekLastWork || null;

    // 工作经历：优先 showWorks（更全），否则 geekCard.geekWorks
    const worksRaw = (item.showWorks && item.showWorks.length ? item.showWorks
                      : card.geekWorks) || [];
    const workHistory = worksRaw.map(function (w) {
      return {
        from: nz(w.startDate),
        to: nz(w.endDate),
        timeDesc: w.startDate && w.endDate ? (w.startDate + '-' + w.endDate) : null,
        company: nz(w.company),
        title: nz(w.positionName || w.positionCategory),
        description: nz(w.responsibility), // ⭐ 场景 1 缺、场景 2 有
        // v0.15.4：补 3 个字段。原始枚举值原样保留，让 LLM 从上下文推断；后续如发现
        // 推断不稳再加 prompt-builder 解码层。
        industry: nz(w.industry),          // 行业（字符串，如"互联网/IT"）
        workType: nz(w.workType),          // 工作类型枚举（1=全职 等）
        workMonths: nz(w.workMonths)       // 工作月数（number）
      };
    });

    // 教育经历：优先 showEdus，否则 geekCard.geekEdus
    const edusRaw = (item.showEdus && item.showEdus.length ? item.showEdus
                     : card.geekEdus) || [];
    const education = edusRaw.map(function (e) {
      return {
        from: nz(e.startDate),
        to: nz(e.endDate),
        school: nz(e.school),
        major: nz(e.major),
        degree: nz(e.degreeName || e.degree),
        degreeCode: e.degree,
        // v0.15.4：补 2 个字段
        eduDescription: nz(e.eduDescription), // ⭐ 留学经历 / GPA 等强证据
        eduType: nz(e.eduType)                // 学历类型枚举（全日制 / 非全日制）
      };
    });

    // city：场景 2 没有"现居城市"，用期望地
    const expectCity = nz(card.expectLocationName);

    // geekDesc 是个 {content, ...} 对象
    const geekDescContent = (card.geekDesc && card.geekDesc.content) || null;

    return {
      candidateId: String(card.geekId || ''),
      encryptUid: nz(item.encryptGeekId || card.encGeekId),
      basic: {
        name: nz(card.geekName),
        age: nz(card.ageDesc),
        gender: card.geekGender,
        education: nz(card.geekDegree),
        yearsOfExperience: nz(card.geekWorkYear),
        city: expectCity,
        activeStatus: nz(item.activeTimeDesc),
        avatar: nz(card.geekAvatar),
        desc: geekDescContent,
        // v0.15.4：应届标志，判 M4 实习意向 / 学历阶段
        freshGraduate: nz(card.freshGraduate)
      },
      expectation: {
        candidateOwn: nz(card.expectPositionName),
        jobAligned: null,
        salaryDesc: nz(card.salary),
        salaryLow: card.lowSalary,
        salaryHigh: card.highSalary,
        cityName: expectCity,
        // v0.15.4：求职意向类型枚举（全职 / 实习等），M4 直接判
        expectType: nz(card.expectType)
      },
      workHistory: workHistory,
      education: education,
      bossSignals: {
        // matches 是 Boss 算法挑出来的"亮点"，对 LLM 判断价值最高
        highlightWords: pickHighlightWords(card.matches),
        markWords: pickHighlightWords(card.markWords),
        lastTime: null,
        bothTalked: !!item.haveChatted,
        applyStatus: nz(card.applyStatusDesc),
        relationType: null,
        viewed: !!card.viewed,
        recommendReason: nz(item.recommendReason || card.webRecommendReason)
      },
      source: {
        scenario: 'recommend',
        apiPath: '/wapi/zpjob/rec/geek/list',
        batchAt: batchAt,
        indexInBatch: indexInBatch
      }
    };
  }

  function extractFromRecList(apiResponse) {
    const list = apiResponse && apiResponse.zpData && apiResponse.zpData.geekList;
    if (!Array.isArray(list)) return [];
    // 同一批 15 个候选人共享同一时间戳，避免循环里 Date.now() 微秒抖动
    // 让批次能整体排序、内部按 index 排序
    const batchAt = Date.now();
    const result = [];
    for (let i = 0; i < list.length; i++) {
      const c = extractOneFromRecList(list[i], batchAt, i);
      if (c && c.candidateId) result.push(c);
    }
    return result;
  }

  // ========== 场景 2b：最新 tab — /wapi/zprelation/interaction/bossGetGeek ==========
  // 与 rec/geek/list 的关键差异：
  //   1. item.geekLastWork 始终为空 — 工作经历只能从 card.geekWorks 取
  //   2. 没有 item.showWorks / item.showEdus — 都得从 card.geekWorks / card.geekEdus 取
  //   3. 没有 markWords，只有 highLightMatches（语义近似，作高亮词替代）
  //   4. apiPath 在 /zprelation/ 命名空间下（与 zpjob 平级）
  function extractOneFromLatestList(item, batchAt, indexInBatch) {
    if (!item || !item.geekCard) return null;
    const card = item.geekCard;

    const worksRaw = card.geekWorks || [];
    const workHistory = worksRaw.map(function (w) {
      return {
        from: nz(w.startDate),
        to: nz(w.endDate),
        timeDesc: w.startDate && w.endDate ? (w.startDate + '-' + w.endDate) : null,
        company: nz(w.company),
        title: nz(w.positionName || w.positionCategory),
        description: nz(w.responsibility),
        // v0.15.4：与 rec/geek/list 保持一致的 7 字段集
        industry: nz(w.industry),
        workType: nz(w.workType),
        workMonths: nz(w.workMonths)
      };
    });

    const edusRaw = card.geekEdus || [];
    const education = edusRaw.map(function (e) {
      return {
        from: nz(e.startDate),
        to: nz(e.endDate),
        school: nz(e.school),
        major: nz(e.major),
        degree: nz(e.degreeName || e.degree),
        degreeCode: e.degree,
        eduDescription: nz(e.eduDescription),
        eduType: nz(e.eduType)
      };
    });

    const expectCity = nz(card.expectLocationName);
    const geekDescContent = (card.geekDesc && card.geekDesc.content) || null;

    return {
      candidateId: String(card.geekId || ''),
      encryptUid: nz(item.encryptGeekId || card.encryptGeekId),
      basic: {
        name: nz(card.geekName),
        age: nz(card.ageDesc),
        gender: card.geekGender,
        education: nz(card.geekDegree),
        yearsOfExperience: nz(card.geekWorkYear),
        city: expectCity,
        activeStatus: nz(item.activeTimeDesc || item.talkTimeDesc),
        avatar: nz(card.geekAvatar),
        desc: geekDescContent,
        freshGraduate: nz(card.freshGraduate)
      },
      expectation: {
        candidateOwn: nz(card.expectPositionName),
        jobAligned: null,
        salaryDesc: nz(card.salary),
        salaryLow: card.lowSalary,
        salaryHigh: card.highSalary,
        cityName: expectCity,
        expectType: nz(card.expectType)
      },
      workHistory: workHistory,
      education: education,
      bossSignals: {
        highlightWords: pickHighlightWords(card.matches),
        markWords: pickHighlightWords(card.highLightMatches),
        lastTime: null,
        bothTalked: !!item.haveChatted,
        applyStatus: nz(card.applyStatusDesc),
        relationType: null,
        viewed: !!card.viewed,
        recommendReason: null
      },
      source: {
        scenario: 'latest',
        apiPath: '/wapi/zprelation/interaction/bossGetGeek',
        batchAt: batchAt,
        indexInBatch: indexInBatch
      }
    };
  }

  function extractFromLatestList(apiResponse) {
    const list = apiResponse && apiResponse.zpData && apiResponse.zpData.geekList;
    if (!Array.isArray(list)) return [];
    const batchAt = Date.now();
    const result = [];
    for (let i = 0; i < list.length; i++) {
      const c = extractOneFromLatestList(list[i], batchAt, i);
      if (c && c.candidateId) result.push(c);
    }
    return result;
  }

  // ========== 场景 3：沟通页「新招呼」DOM 扫描（v0.13.0） ==========
  // 数据来源：content.js 扫描 .geek-item 卡片 → __vue__ 反射拿 props
  //
  // Vue $props 已验证字段（POC A5 v0.3.0）：
  //   name / avatar / encryptUid / securityId / encryptJobId / jobName
  //   friendSource / friendId / uid / uniqueId / lastWorkExpr / degree
  //   expectSalary / isTop / isStar / isFiltered / del / relationType
  //   sourceTitle / goldGeekStatus
  //
  // visibleText 是卡片可见文本，含候选人主动招呼文本（"BOSS你好，我是..."）
  //
  // 招呼文本提取启发：
  //   - 文本中含"您好/BOSS"等开头的段落为招呼正文
  //   - 时间戳（"14:53"等）和岗位名（jobName）作为锚点剥离前缀
  function extractGreetingFromVisibleText(visibleText, name, jobName) {
    if (!visibleText) return null;
    let text = String(visibleText).replace(/\s+/g, ' ').trim();
    // 剥前缀：去掉时间戳（HH:MM 或"昨天"等）+ 候选人名 + 岗位名
    text = text.replace(/^\d+\s+/, '');  // 未读数
    text = text.replace(/^\d{1,2}:\d{2}\s+/, '');  // 时间
    text = text.replace(/^(昨天|前天|星期[一二三四五六日])\s+/, '');
    if (name) text = text.replace(new RegExp('^' + name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s+'), '');
    if (jobName) text = text.replace(new RegExp('^' + jobName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s+'), '');
    text = text.trim();
    return text.length > 2 ? text : null;
  }

  function extractFromGeekItem(item) {
    if (!item || !item.uid) return null;
    const greeting = extractGreetingFromVisibleText(item.visibleText, item.name, item.jobName);
    return {
      candidateId: String(item.uid),
      encryptUid: nz(item.encryptUid),
      basic: {
        name: nz(item.name),
        // v0.13.0：以下字段 Vue 不提供，留 null；HR 点开候选人时 chat/geek/info 会补
        age: null,
        gender: null,
        education: nz(item.degree),       // Vue 提供 degree
        yearsOfExperience: null,
        city: null,
        activeStatus: null,
        avatar: nz(item.avatar),
        desc: greeting  // 候选人主动招呼文本，作 self-report 进 desc
      },
      expectation: {
        candidateOwn: null,
        jobAligned: nz(item.jobName),     // 我方岗位名
        salaryDesc: nz(item.expectSalary),
        salaryLow: null,
        salaryHigh: null,
        cityName: null
      },
      workHistory: item.lastWorkExpr
        ? [{
            from: null, to: null, timeDesc: null,
            company: null, title: nz(item.lastWorkExpr), description: null
          }]
        : [],
      education: [],
      bossSignals: {
        highlightWords: null,
        markWords: null,
        lastTime: null,
        bothTalked: true,                 // 沟通页候选人都已建立会话
        applyStatus: nz(item.sourceTitle),
        relationType: nz(item.relationType),
        viewed: null,
        recommendReason: null
      },
      // 沟通页特有：候选人主动招呼内容
      greeting: greeting ? { content: greeting, sentAt: null } : null,
      source: {
        scenario: 'sayhi-tab',
        apiPath: 'dom:.geek-item',
        batchAt: item.batchAt || Date.now(),
        indexInBatch: typeof item.indexInBatch === 'number' ? item.indexInBatch : 0,
        // 沟通页特有：保留 securityId/encryptJobId 供未来主动调 chat/geek/info 用
        securityId: nz(item.securityId),
        encryptJobId: nz(item.encryptJobId)
      }
    };
  }

  function extractFromGeekItems(items) {
    if (!Array.isArray(items)) return [];
    const batchAt = Date.now();
    const out = [];
    for (let i = 0; i < items.length; i++) {
      const it = Object.assign({}, items[i], { batchAt: batchAt, indexInBatch: i });
      const c = extractFromGeekItem(it);
      if (c && c.candidateId) out.push(c);
    }
    return out;
  }

  // ========== 场景 4：沟通历史消息 — /wapi/zpchat/boss/historyMsg ==========
  // 与 candidate 抽取不同：historyMsg 返回的是消息列表，对应"一段会话"而非"一个人"。
  // extractor 这一层不知道哪个 uid 是 HR、哪个是候选人，所以：
  //   - 收集所有出现过的 uid → 返回 uids 候选列表
  //   - 由 background.js 拿这个 uid 列表去 evaluations / sayhi_pool 里查匹配
  //   - 找到匹配 uid 后再回填 role: 'candidate' | 'hr' 字段
  //
  // 消息归一化：保留 from / to 对象（judge.js line 164 期望 m.from.uid），
  // 仅精简到 uid / name 两个字段。body.text / body.resume / body.hyperLink / body.action
  // 提取成统一 text + kind 两个字段。
  //
  // 已识别 type / bizType 组合（见 可抓取字段清单.md §2.6.1）：
  //   type=1, bizType=null/13/105 → 普通文本（含 HR 模板招呼 / 链接卡片）
  //   type=3, bizType=21050004    → 简历卡片
  //   type=4, bizType=21050069    → 附件链接（邮箱已发简历）
  function extractMessageBody(msg) {
    const body = msg && msg.body;
    if (!body || typeof body !== 'object') return { text: '', kind: 'unknown' };
    if (body.text) return { text: String(body.text), kind: 'text' };
    if (body.resume && typeof body.resume === 'object') {
      // 简历卡片摘要(给 chatHistory 显示用)
      // POC A6 实测 v0.17.0.9:BOSS 改了字段名 — 兼容新旧两版
      const r = body.resume;
      const parts = [];
      const name = (r.user && r.user.name) || r.name;
      if (name) parts.push(name);
      const age = r.age || r.ageDesc;
      if (age) parts.push(age + '岁');
      if (r.gender !== undefined && r.gender !== null) {
        parts.push(r.gender === 1 ? '女' : (r.gender === 0 ? '男' : ''));
      }
      const edu = r.education || r.degree || r.eduDesc;
      if (edu) parts.push(edu);
      if (r.workYear) parts.push(r.workYear);
      if (r.city) parts.push(r.city);
      const salary = r.salary || r.salaryDesc || r.jobSalary;
      if (salary) parts.push(salary);
      if (r.position) parts.push(r.position);
      if (r.applyStatus) parts.push('[' + r.applyStatus + ']');
      const summary = parts.filter(Boolean).join(' / ');
      return { text: '[简历卡片] ' + (summary || '(无摘要)'), kind: 'resume' };
    }
    if (body.hyperLink && typeof body.hyperLink === 'object') {
      const h = body.hyperLink;
      return { text: '[链接] ' + (h.text || h.url || ''), kind: 'hyperLink' };
    }
    if (body.action && typeof body.action === 'object') {
      const a = body.action;
      return { text: '[交互卡] ' + (a.text || a.title || ''), kind: 'action' };
    }
    return { text: '', kind: 'unknown' };
  }

  // POC A6 v0.17.0.9 回灌:从 historyMsg messages 数组提取 BOSS 推的简历卡片
  // (type=3, bizType=21050004),返回结构化字段数组。
  //
  // 这部分数据**主扩展之前完全没用**,只把摘要塞进 chatHistory 文本。新版回灌后:
  //   - basic.applyStatus(在校-月内到岗等)→ LLM 关键判断信号
  //   - bossSignals.bossResumeCard 含 content1/content2/bottomText/position 等
  //
  // BOSS 实际字段(POC A6 真机验证):
  //   { user: {uid,name,avatar,...}, age, gender, education, city, workYear, salary,
  //     jobSalary, position, positionCategory, applyStatus, bottomText,
  //     content1, content2, content3, experiences: [{organization, occupation, startDate, endDate, type}],
  //     description (BOSS 自己也常为空), securityId, expectId, jobId, lid }
  function extractResumeCards(rawMessages) {
    if (!Array.isArray(rawMessages)) return [];
    const cards = [];
    for (let i = 0; i < rawMessages.length; i++) {
      const m = rawMessages[i];
      if (!m || m.type !== 3 || m.bizType !== 21050004) continue;
      const r = m && m.body && m.body.resume;
      if (!r || typeof r !== 'object') continue;
      // candidateId 优先 user.uid;fallback messages.from.uid
      const userUid = (r.user && r.user.uid) || (m.from && m.from.uid);
      if (!userUid) continue;
      cards.push({
        candidateId: String(userUid),
        // 候选人状态(关键 — LLM 想知道"何时到岗")
        applyStatus: nz(r.applyStatus),
        // 基础(都是兼容新旧 BOSS 字段名)
        name: nz((r.user && r.user.name) || r.name),
        age: nz(r.age || r.ageDesc),
        gender: r.gender,
        education: nz(r.education || r.degree),
        workYear: nz(r.workYear),
        city: nz(r.city),
        // 期望
        salary: nz(r.salary || r.salaryDesc),
        jobSalary: nz(r.jobSalary),       // HR JD 薪资,不喂 LLM
        position: nz(r.position),         // "期望:咨询/翻译(行业)"
        positionCategory: nz(r.positionCategory),
        // BOSS 推卡片的文案行(给 LLM 简历摘要用)
        content1: nz(r.content1),         // 例如 "求职期望  咨询/翻译"
        content2: nz(r.content2),         // 例如 "毕业于 大连外国语大学 | 印度尼西亚语"
        content3: nz(r.content3),
        bottomText: nz(r.bottomText),     // "5月12日 沟通的职位-印尼语实习生"
        // 简版教育经历(BOSS 截图里简历卡片下方那几行)
        experiences: Array.isArray(r.experiences) ? r.experiences.map(function (e) {
          return {
            organization: nz(e.organization),
            occupation: nz(e.occupation),
            startDate: nz(e.startDate),
            endDate: nz(e.endDate),
            type: e.type
          };
        }) : null,
        // ID 字段(给主动 fetch / 关联用,不喂 LLM)
        securityId: nz(r.securityId),
        expectId: r.expectId,
        jobId: r.jobId
      });
    }
    return cards;
  }

  function extractFromHistoryMsg(apiResponse) {
    const data = apiResponse && apiResponse.zpData;
    const rawMessages = data && data.messages;
    if (!Array.isArray(rawMessages) || rawMessages.length === 0) {
      return { uids: [], messages: [], lastMessageAt: 0, resumeCards: [] };
    }

    const uidSet = {};
    const messages = [];
    let lastMessageAt = 0;

    for (let i = 0; i < rawMessages.length; i++) {
      const m = rawMessages[i];
      if (!m || !m.from || !m.to) continue;
      const fromUid = String(m.from.uid || '');
      const toUid = String(m.to.uid || '');
      if (!fromUid || !toUid) continue;

      // HR 模板招呼语（type=1 + bizType=105）：BOSS 替 HR 发的固定话术，
      // 不是候选人陈述，且非 HR 主动撰写，进 chatHistory 会污染 LLM（类似 jobAligned）。
      if (m.type === 1 && m.bizType === 105) continue;

      const body = extractMessageBody(m);
      if (!body.text) continue;  // 空消息（保活类）跳过

      uidSet[fromUid] = true;
      uidSet[toUid] = true;
      const time = Number(m.time) || 0;
      if (time > lastMessageAt) lastMessageAt = time;

      messages.push({
        mid: m.mid ? String(m.mid) : '',
        time: time,
        from: { uid: fromUid, name: nz(m.from.name) },
        to: { uid: toUid, name: nz(m.to.name) },
        text: body.text,
        kind: body.kind,
        // 保留 type / bizType 给下游过滤用（如想去掉 HR 模板 bizType=105）
        type: typeof m.type === 'number' ? m.type : null,
        bizType: typeof m.bizType === 'number' ? m.bizType : null
      });
    }

    // 按 time 升序（candidate.chatHistory 习惯：旧 → 新）
    messages.sort(function (a, b) { return a.time - b.time; });

    return {
      uids: Object.keys(uidSet),
      messages: messages,
      lastMessageAt: lastMessageAt,
      // v0.17.0.9 POC A6 回灌:简历卡片消息结构化字段(主扩展之前未利用)
      resumeCards: extractResumeCards(rawMessages)
    };
  }

  // ========== 路由：返回数组（统一接口，便于下游循环处理）==========
  function extractFromCapture(apiPath, apiResponse) {
    if (!apiPath) return [];
    if (apiPath.indexOf('/zpjob/chat/geek/info') !== -1) {
      const c = extractFromGeekInfo(apiResponse);
      return c ? [c] : [];
    }
    if (apiPath.indexOf('/zpjob/rec/geek/list') !== -1) {
      return extractFromRecList(apiResponse);
    }
    if (apiPath.indexOf('/zprelation/interaction/bossGetGeek') !== -1) {
      return extractFromLatestList(apiResponse);
    }
    // historyMsg 不走 extractFromCapture，接口形态是"会话消息"而非"候选人"。
    // background.js 单独路由 → 调 extractFromHistoryMsg → merge 到对应 candidate。
    // TODO: view/geek/info/v2（字段加密，业务上可绕过）
    return [];
  }

  // ========== 场景 5：沟通页候选人详情面板 DOM 路线（v0.17.0.10 POC A7 回灌）==========
  // 背景：chat/geek/info 接口不返回 desc / workExp.description / eduExp.eduDescription
  // 三个长文本字段；regionCode 也常为 null（候选人没填期望地）。POC A7 真机验证
  // BOSS 沟通页右侧详情面板的 DOM 里**这些字段都能拿到**（含多城市原文如"玉林 & 南宁"）。
  //
  // 设计：DOM 解析在 inject.js 那侧做（依赖 querySelector），返回纯对象传到 BG；
  // extractor 这一侧只做"纯对象 → 标准化字段"，便于单测。
  //
  // 输入 rawScan（inject 扫完传过来）：
  //   { scannedAt, candidateName, baseStats, expectRaw, workEduListRaw,
  //     descText, skillTags[], resumeCardRaw, domHits {...} }
  //
  // 输出 domDetail（挂到 candidate.bossSignals.domDetail）：
  //   { scannedAt, candidateName, baseStats, expect: {prefix, cityRaw, cities[], jobRaw, salaryRaw},
  //     workEduText, desc, skillTags[], resumeCardText, domHits }
  function parseExpectText(rawText) {
    if (!rawText) return null;
    let text = String(rawText).replace(/\s+/g, ' ').trim();
    // 兼容三种已观察前缀（POC A7 v0.2 真机验证）：
    //   "期望：..."（候选人主动填了期望）
    //   "最近关注：..."（候选人没填，BOSS 用算法推算）
    //   兜底：意向 / 期望职位 / 关注
    const prefixMatch = text.match(/^(期望|最近关注|期望职位|意向|关注)[：:]\s*/);
    const prefix = prefixMatch ? prefixMatch[1] : null;
    if (prefixMatch) text = text.slice(prefixMatch[0].length);
    // 按中点拆分：城市段 / 职位+薪资段
    const parts = text.split(/\s*·\s*/).map(function (s) { return s.trim(); }).filter(Boolean);
    const cityRaw = parts[0] || null;
    const jobSalaryRaw = parts[1] || null;
    // 二次拆 jobSalary：薪资格式在尾部 "5-6K" / "2-3K" / "130-180元/天"
    let jobRaw = null, salaryRaw = null;
    if (jobSalaryRaw) {
      const m = jobSalaryRaw.match(/^(.+?)\s+(\d+[\d\-K元\/天\.]*?)\s*$/);
      if (m) { jobRaw = m[1].trim(); salaryRaw = m[2].trim(); }
      else { jobRaw = jobSalaryRaw; }
    }
    // 多城市拆分：BOSS 用 ` & ` 分多城市（"玉林 & 南宁"），兼容中文逗号/英文逗号
    let cities = null;
    if (cityRaw) {
      cities = cityRaw.split(/\s*[&、,，]\s*/).map(function (s) { return s.trim(); }).filter(Boolean);
      if (cities.length === 0) cities = null;
    }
    return {
      prefix: prefix,
      original: text,
      parts: parts,
      cityRaw: cityRaw,
      cities: cities,
      jobRaw: jobRaw,
      salaryRaw: salaryRaw
    };
  }

  function extractFromDetailPanel(rawScan) {
    if (!rawScan || typeof rawScan !== 'object') return null;
    // v0.18.0：原 desc / skillTags 字段删除——详情面板永远不含简介+技能，
    //   v0.17.1.2 起这两类信息全部由 resumeFullText（在线简历 iframe）覆盖
    return {
      scannedAt: rawScan.scannedAt || Date.now(),
      candidateName: nz(rawScan.candidateName),
      baseStats: nz(rawScan.baseStats),
      expect: parseExpectText(rawScan.expectRaw),
      workEduText: nz(rawScan.workEduListRaw),
      resumeCardText: nz(rawScan.resumeCardRaw),
      // v0.17.1.2：在线简历弹窗 iframe.contentDocument.body.textContent
      //   detailPanel 字段稀疏的候选人简介长文本主要靠这个
      //   失败时 null，rawScan.resumeScanError 记录原因（点不到按钮 / iframe 没加载 等）
      resumeFullText: nz(rawScan.resumeFullText),
      resumeScanError: nz(rawScan.resumeScanError),
      // 备查：哪些 selector 命中了（追踪 BOSS UI 变化用）
      domHits: rawScan.domHits || null
    };
  }

  global.BossExtractor = {
    extractFromCapture: extractFromCapture,
    extractFromGeekInfo: extractFromGeekInfo,
    extractFromRecList: extractFromRecList,
    extractFromLatestList: extractFromLatestList,
    extractFromGeekItem: extractFromGeekItem,
    extractFromGeekItems: extractFromGeekItems,
    extractFromHistoryMsg: extractFromHistoryMsg,
    extractResumeCards: extractResumeCards,        // v0.17.0.9 暴露给测试用
    extractFromDetailPanel: extractFromDetailPanel, // v0.17.0.10 POC A7 DOM 路线
    parseExpectText: parseExpectText                // v0.17.0.10 暴露给测试用
  };
})(self);
