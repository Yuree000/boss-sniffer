// BOSS Sniffer · lib/schemas/candidate.js (v1.1.22)
// 候选人对象字段权威清单 + drift 防御
//
// === 用途 ===
// 这是 candidate 对象所有字段的"单一权威清单"。extractor / judge / UI render / CSV 导出
// 引用的字段路径都必须在这里登记。tests/v1_1_22-candidate-schema.test.js 强制完整性。
//
// === 加新字段流程 ===
// 1. 这里 SCHEMA 加一条 path → { type, llmFeed, source, note }
// 2. lib/extractor.js 在对应 extractFromXxx() 加抽取
// 3. (可选)lib/judge.js serializeCandidate() 加 LLM 喂入逻辑(若 llmFeed: true)
// 4. (可选)sidepanel.js / dashboard.js 加 UI 展示
// 5. 跑 tests/v1_1_22-candidate-schema.test.js,失败会告诉你哪个 consumer 没跟上
//
// === Path 语法 ===
//   'a'              单段顶层字段(candidateId / encryptUid)
//   'a.b'            嵌套对象字段(basic.name / expectation.salaryDesc)
//   'a[].b'          数组每个元素的字段(workHistory[].company)
//   'a.b.c' / 'a.b[].c'  多级嵌套(bossSignals.resumeCard.applyStatus)
//
// === Spec 字段 ===
//   type: 'string' | 'number' | 'boolean' | 'array' | 'object' | 'enum'
//   required: boolean (默认 false;仅 candidateId 必填)
//   llmFeed: boolean (默认 false;true 表示该字段会通过 serializeCandidate 喂给 LLM)
//   source: string (主要数据来源:'common'(多接口)/'rec-list'/'chat/geek/info'/'history-msg'/'detail-panel-DOM'/'online-resume-iframe')
//   note: string (语义/历史背景注释,可选)

(function (global) {
  'use strict';

  const SCHEMA = Object.freeze({
    // ===== 顶层标识 =====
    'candidateId':        { type: 'string',  required: true,  llmFeed: true,  source: 'common' },
    'encryptUid':         { type: 'string',  required: false, llmFeed: false, source: 'common', note: 'BOSS 加密版 ID,sayHi 真点击 / 滚定位用' },

    // ===== basic.* 基础人口学 =====
    'basic.name':              { type: 'string',  llmFeed: true,  source: 'common' },
    'basic.age':               { type: 'string',  llmFeed: true,  source: 'common', note: '原文如"21岁"或"27岁应届生"' },
    'basic.gender':            { type: 'number',  llmFeed: true,  source: 'common', note: 'BOSS 性别枚举' },
    'basic.education':         { type: 'string',  llmFeed: true,  source: 'common' },
    'basic.yearsOfExperience': { type: 'string',  llmFeed: true,  source: 'common', note: '原文如"3-5年"或"应届生"' },
    'basic.city':              { type: 'string',  llmFeed: true,  source: 'chat/geek/info', note: '现居城市' },
    'basic.activeStatus':      { type: 'string',  llmFeed: true,  source: 'common' },
    'basic.avatar':            { type: 'string',  llmFeed: false, source: 'chat/geek/info' },
    'basic.desc':              { type: 'string',  llmFeed: true,  source: 'detail-panel-DOM', note: '候选人自我简介,接口路径没有,DOM 拿' },
    'basic.freshGraduate':     { type: 'enum',    llmFeed: true,  source: 'rec-list', note: 'BOSS 应届标志枚举,v0.15.4 加' },

    // ===== expectation.* 求职期望 =====
    'expectation.candidateOwn': { type: 'string',  llmFeed: true,  source: 'common' },
    'expectation.jobAligned':   { type: 'string',  llmFeed: false, source: 'common', note: '故意不喂 LLM,见 judge.js:128 注释 — 是"HR 当前 JD 名"易污染 LLM' },
    'expectation.salaryDesc':   { type: 'string',  llmFeed: true,  source: 'common' },
    'expectation.salaryLow':    { type: 'number',  llmFeed: false, source: 'chat/geek/info' },
    'expectation.salaryHigh':   { type: 'number',  llmFeed: false, source: 'chat/geek/info' },
    'expectation.cityName':     { type: 'string',  llmFeed: true,  source: 'common', note: '期望城市,regionCode 查 city-codes 字典' },
    'expectation.expectType':   { type: 'enum',    llmFeed: true,  source: 'rec-list', note: 'BOSS 求职类型(全职/实习等),v0.15.4 加' },

    // ===== workHistory[] 工作经历(数组) =====
    'workHistory[].from':        { type: 'string', llmFeed: true,  source: 'common' },
    'workHistory[].to':          { type: 'string', llmFeed: true,  source: 'common' },
    'workHistory[].timeDesc':    { type: 'string', llmFeed: true,  source: 'common' },
    'workHistory[].company':     { type: 'string', llmFeed: true,  source: 'common' },
    'workHistory[].title':       { type: 'string', llmFeed: true,  source: 'common' },
    'workHistory[].description': { type: 'string', llmFeed: true,  source: 'rec-list', note: '场景 1 接口不返回,场景 2 / DOM 有' },
    'workHistory[].industry':    { type: 'string', llmFeed: true,  source: 'rec-list', note: 'v0.15.4 加' },
    'workHistory[].workType':    { type: 'enum',   llmFeed: true,  source: 'rec-list', note: 'BOSS 工作类型枚举(全职/兼职/实习)' },
    'workHistory[].workMonths':  { type: 'number', llmFeed: true,  source: 'rec-list', note: '工作月数' },

    // ===== education[] 教育经历(数组) =====
    'education[].from':           { type: 'string', llmFeed: true,  source: 'common' },
    'education[].to':             { type: 'string', llmFeed: true,  source: 'common' },
    'education[].school':         { type: 'string', llmFeed: true,  source: 'common' },
    'education[].major':          { type: 'string', llmFeed: true,  source: 'common' },
    'education[].degree':         { type: 'string', llmFeed: true,  source: 'common' },
    'education[].degreeCode':     { type: 'number', llmFeed: false, source: 'common' },
    'education[].eduDescription': { type: 'string', llmFeed: true,  source: 'rec-list', note: '留学经历 / GPA 等强证据,v0.15.4 加' },
    'education[].eduType':        { type: 'enum',   llmFeed: true,  source: 'rec-list', note: '全日制 / 非全日制 枚举' },

    // ===== bossSignals.* BOSS 算法 / 卡片信号 =====
    'bossSignals.highlightWords':           { type: 'array',   llmFeed: true,  source: 'common' },
    'bossSignals.markWords':                { type: 'array',   llmFeed: true,  source: 'rec-list' },
    'bossSignals.lastTime':                 { type: 'string',  llmFeed: false, source: 'chat/geek/info' },
    'bossSignals.bothTalked':               { type: 'boolean', llmFeed: false, source: 'chat/geek/info' },
    'bossSignals.applyStatus':              { type: 'string',  llmFeed: true,  source: 'common' },
    'bossSignals.relationType':             { type: 'number',  llmFeed: false, source: 'chat/geek/info' },
    'bossSignals.viewed':                   { type: 'boolean', llmFeed: false, source: 'rec-list' },
    'bossSignals.recommendReason':          { type: 'string',  llmFeed: true,  source: 'rec-list' },
    'bossSignals.lastCompany':              { type: 'string',  llmFeed: true,  source: 'chat/geek/info', note: 'workHistory 缺时补,v0.17.0.9 加' },
    'bossSignals.lastPosition':             { type: 'string',  llmFeed: true,  source: 'chat/geek/info' },
    'bossSignals.everWorkPositionNameList': { type: 'array',   llmFeed: true,  source: 'chat/geek/info', note: '候选人做过的所有岗位名(BOSS 字典化)' },
    'bossSignals.resumeCard':               { type: 'object',  llmFeed: true,  source: 'history-msg', note: 'BOSS 沟通页简历卡片消息;子字段 content1/2/bottomText/applyStatus/position/experiences[]' },
    'bossSignals.domDetail':                { type: 'object',  llmFeed: true,  source: 'detail-panel-DOM', note: 'POC A7 沟通页 DOM;子字段 expect/workEduText/baseStats/resumeCardText/resumeFullText/skillTags' },

    // ===== chatHistory[] 聊天记录(数组) =====
    'chatHistory[].role': { type: 'string', llmFeed: true,  source: 'history-msg' },
    'chatHistory[].text': { type: 'string', llmFeed: true,  source: 'history-msg' },

    // ===== source.* 元数据(不喂 LLM) =====
    'source.scenario':     { type: 'string', llmFeed: false, source: 'common', note: 'recommend / chat' },
    'source.apiPath':      { type: 'string', llmFeed: false, source: 'common' },
    'source.batchAt':      { type: 'number', llmFeed: false, source: 'common', note: '同一批 15 个候选人共享' },
    'source.indexInBatch': { type: 'number', llmFeed: false, source: 'common', note: 'BOSS 推荐流视觉位置(0=最顶部)' }
  });

  // ---------- 工具 API ----------

  function paths() {
    return Object.keys(SCHEMA);
  }

  function spec(path) {
    return SCHEMA[path] || null;
  }

  function getLlmFedPaths() {
    return paths().filter(function (p) { return SCHEMA[p].llmFeed; });
  }

  function getRequiredPaths() {
    return paths().filter(function (p) { return SCHEMA[p].required; });
  }

  // 把顶层段(如 'basic' / 'expectation')下的所有 leaf path 列出
  function getSectionPaths(section) {
    const prefix = section + '.';
    const arrPrefix = section + '[].';
    return paths().filter(function (p) {
      return p.indexOf(prefix) === 0 || p.indexOf(arrPrefix) === 0;
    });
  }

  // 校验 path 语法是否合法(测试用)
  const PATH_REGEX = /^[a-z][a-zA-Z0-9]*(?:\[\])?(?:\.[a-z][a-zA-Z0-9]*(?:\[\])?)*$/;
  function isValidPathSyntax(path) {
    return typeof path === 'string' && PATH_REGEX.test(path);
  }

  global.BossCandidateSchema = {
    SCHEMA: SCHEMA,
    paths: paths,
    spec: spec,
    getLlmFedPaths: getLlmFedPaths,
    getRequiredPaths: getRequiredPaths,
    getSectionPaths: getSectionPaths,
    isValidPathSyntax: isValidPathSyntax
  };
})(typeof window !== 'undefined' ? window : self);
