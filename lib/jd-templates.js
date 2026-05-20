// BOSS Sniffer - jd-templates.js (v0.21.0)
// JD 模板 CRUD + 持久化（chrome.storage.sync；v0.17.0 起跨设备）
//
// v0.12.0 重构：从「固定 8 字段」改为「必要条件 + 可选条件 + 阈值」模型
// v0.21.0 (Phase 1 · 1a)：schema 新增 bossJobNames 字段，用于沟通页多岗位 JD 路由
// v0.25.1：删除 bossJobNames 字段。HR 约定 JD.name 与 BOSS 端「沟通职位」名称完全一致，
//   沟通页 JD 路由改用 JD.name 严格相等匹配（jd-router.js v0.25.1）。
// v0.25.2：话术从独立模板集成进 JD（greetTemplates 内嵌 + defaultGreetTemplateId）+
//   HR 自定义 prompt（customPrompt 字段，judge.js 优先使用）
//
// JD schema：
//   {
//     jdId, name,
//     mustConditions: [{id, text}], optionalConditions: [{id, text}], optionalThreshold,
//     greetTemplates: [{ id, name, text }],   // v0.25.2 新增 — 本 JD 的话术模板（一对多内嵌）
//                                              //   评估「符合」时按 defaultGreetTemplateId 取话术发送
//     defaultGreetTemplateId: string,         // v0.25.2 新增 — 默认话术 ID（必须在 greetTemplates 内）
//     customPrompt: string | null             // v0.25.2 新增 — HR 自定义 prompt（覆盖 prompt-builder）
//                                              //   null = 走 prompt-builder.build(jd) 自动生成
//                                              //   string = LLM 评估时直接用此值作 SYSTEM_PROMPT
//   }
//
// v0.12.1 回填：业务文档 5.6 §11.1 / v1 验收 checklist 1.1-1.2 要求 MVP 单岗位 = 印尼语实习生，
//   v0.12.0 SEED 重置时把它打没了，本次以 4 必要 + 0 可选 + K=0 严格主义重写回填，排第一。
//
// 同时在 service worker（background.js importScripts）和 admin 页面（<script>）加载。
//
// 公开 API：self.BossJD
//   - listTemplates()
//   - getTemplate(jdId)
//   - saveTemplate(template)      // 含 jdId 则更新；不含则新建
//   - deleteTemplate(jdId)
//   - getCurrentJdId()
//   - setCurrentJdId(jdId)
//   - ensureSeeded()              // 首启 / 检测到旧 schema → 重置为三条 SEED（印尼语实习生 + 测试工程师 + AI CX）
//   - genConditionId(prefix)      // 给新增 must/opt 行用
//   - SEED_INDONESIA_INTERN / SEED_QA_ENGINEER / SEED_AI_CX   // 兜底常量

(function (global) {
  'use strict';

  const KEY_TEMPLATES = 'jd_templates';
  const KEY_CURRENT = 'current_jd_id';

  // === 内置 SEED 1：印尼语实习生（业务文档 5.6 §3.1 / v0.12.1 回填）===
  // 4 必要 + 0 可选 + K=0：必要全 true → 符合；任一 false 或 unknown → pass。
  // 印尼籍豁免规则吸收进 M2 / M4 的 text，由 LLM 推理执行。
  const SEED_INDONESIA_INTERN = {
    jdId: 'indonesia-intern-2026',
    name: '印尼语实习生',
    mustConditions: [
      { id: 'm_in_base',  text: '简历地址或工作 base 在南京或南宁' },
      { id: 'm_in_edu',   text: '本科及以上学历（印尼籍候选人豁免此条）' },
      { id: 'm_in_lang',  text: '会印尼语（口语 / 书面 / 印尼留学经历可证）' },
      { id: 'm_in_stage', text: '教育阶段符合实习要求：大四有实习意向，或大三有海外留学经历，或毕业生有实习 / 兼职意向；大一大二不接受；印尼籍候选人豁免此条' }
    ],
    optionalConditions: [],
    optionalThreshold: 0,
    // v0.25.2 新增字段（首启用 SEED 默认值，HR 在 admin 编辑）
    greetTemplates: [],          // 空数组 = HR 升级后需自己在 admin 配置话术
    defaultGreetTemplateId: '',  // 空 = 无默认（autoGreet 时跳过）
    customPrompt: null,          // null = 走 prompt-builder.build(jd) 自动生成
    createdAt: 0,
    updatedAt: 0
  };

  // === 内置 SEED 2：测试工程师 ===
  const SEED_QA_ENGINEER = {
    jdId: 'qa-engineer-2026',
    name: '测试工程师',
    mustConditions: [
      { id: 'm_qa_edu',   text: '本科及以上学历' },
      { id: 'm_qa_age',   text: '年龄不超过 34 岁' },
      { id: 'm_qa_skill', text: '简历里同时出现 Python 和 Linux' }
    ],
    optionalConditions: [
      { id: 'o_qa_auto',    text: '自动化测试' },
      { id: 'o_qa_pytest',  text: 'pytest' },
      { id: 'o_qa_api',     text: '接口测试' },
      { id: 'o_qa_ai_test', text: 'AI 测试' },
      { id: 'o_qa_ai_tool', text: 'AI 工具（Claude Code / Cursor / Codex 等）' }
    ],
    optionalThreshold: 3,
    greetTemplates: [],
    defaultGreetTemplateId: '',
    customPrompt: null,
    createdAt: 0,
    updatedAt: 0
  };

  // === 内置 SEED 3：AI CX ===
  const SEED_AI_CX = {
    jdId: 'ai-cx-2026',
    name: 'AI CX',
    mustConditions: [
      { id: 'm_cx_edu',  text: '本科及以上学历' },
      { id: 'm_cx_age',  text: '年龄不超过 28 岁' },
      { id: 'm_cx_lang', text: '简历里有西班牙语或葡萄牙语' }
    ],
    optionalConditions: [
      { id: 'o_cx_major', text: '西班牙语/葡萄牙语专业' },
      { id: 'o_cx_cert',  text: '语言相关等级证书' },
      { id: 'o_cx_exp',   text: '有翻译/运营相关经验' }
    ],
    optionalThreshold: 1,
    greetTemplates: [],
    defaultGreetTemplateId: '',
    customPrompt: null,
    createdAt: 0,
    updatedAt: 0
  };

  // v0.25.2：话术模板 ID 生成器（内嵌在 JD 内）
  function genGreetTemplateId() {
    return 'gt_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  }

  function genId() {
    return 'jd_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
  }

  // 给 must / opt 条目生成稳定 id（admin UI 加新行时用）
  // 不重排：删除某条不会改其他条的 id
  function genConditionId(prefix) {
    const p = prefix || 'c';
    return p + '_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  }

  // 判断 storage 里的某条记录是否是旧 schema（含已废弃字段）
  // 旧字段：base / educationMin / language / ageMax / experienceHard / bonus / veto / specialRules / jdText
  function isOldSchema(t) {
    if (!t || typeof t !== 'object') return false;
    return t.base !== undefined
        || t.educationMin !== undefined
        || t.language !== undefined
        || t.ageMax !== undefined
        || t.experienceHard !== undefined
        || t.bonus !== undefined
        || t.veto !== undefined
        || t.specialRules !== undefined
        || t.jdText !== undefined;
  }

  // 判断是否符合新 schema（至少 mustConditions / optionalConditions / optionalThreshold 字段存在）
  function isNewSchema(t) {
    if (!t || typeof t !== 'object') return false;
    return Array.isArray(t.mustConditions) || Array.isArray(t.optionalConditions);
  }

  async function listTemplates() {
    const obj = await self.BossStorageSync.get(KEY_TEMPLATES);
    const list = obj[KEY_TEMPLATES];
    return Array.isArray(list) ? list.slice() : [];
  }

  async function getTemplate(jdId) {
    if (!jdId) return null;
    const list = await listTemplates();
    return list.find(function (t) { return t.jdId === jdId; }) || null;
  }

  // 校验新 schema 的入参
  function validateTemplate(template) {
    if (!template || typeof template !== 'object') {
      throw new Error('saveTemplate: 入参必须是对象');
    }
    if (!template.name || !String(template.name).trim()) {
      throw new Error('saveTemplate: name 必填');
    }
    const must = Array.isArray(template.mustConditions) ? template.mustConditions : [];
    const opt = Array.isArray(template.optionalConditions) ? template.optionalConditions : [];
    if (must.length === 0 && opt.length === 0) {
      throw new Error('saveTemplate: 必要条件和可选条件至少要有一项');
    }
    // 每条 text 非空
    for (let i = 0; i < must.length; i++) {
      if (!must[i] || !String(must[i].text || '').trim()) {
        throw new Error('saveTemplate: 必要条件第 ' + (i + 1) + ' 项 text 不能为空');
      }
    }
    for (let i = 0; i < opt.length; i++) {
      if (!opt[i] || !String(opt[i].text || '').trim()) {
        throw new Error('saveTemplate: 可选条件第 ' + (i + 1) + ' 项 text 不能为空');
      }
    }
    // 阈值校验
    const K = Number(template.optionalThreshold);
    if (!Number.isInteger(K) || K < 0) {
      throw new Error('saveTemplate: optionalThreshold 必须是非负整数');
    }
    if (K > opt.length) {
      throw new Error('saveTemplate: 阈值 (' + K + ') 不能大于可选条件数量 (' + opt.length + ')');
    }
    // v0.25.1：删除 bossJobNames 校验（字段已废弃，JD.name 严格相等匹配）
    // v0.25.2：greetTemplates / defaultGreetTemplateId 校验
    //   - greetTemplates 可省略 / 空数组（HR 升级后还没配话术 = autoGreet 跳过）
    //   - 若提供：每条必须含 id + name + text（id 由 admin UI 用 genGreetTemplateId 生成）
    //   - defaultGreetTemplateId 必须存在于 greetTemplates ID 列表里（或空 = 无默认）
    if (template.greetTemplates !== undefined && template.greetTemplates !== null) {
      if (!Array.isArray(template.greetTemplates)) {
        throw new Error('saveTemplate: greetTemplates 必须是数组');
      }
      for (let i = 0; i < template.greetTemplates.length; i++) {
        const g = template.greetTemplates[i];
        if (!g || typeof g !== 'object') {
          throw new Error('saveTemplate: greetTemplates 第 ' + (i + 1) + ' 项必须是对象');
        }
        if (!g.id || typeof g.id !== 'string') {
          throw new Error('saveTemplate: greetTemplates 第 ' + (i + 1) + ' 项缺 id');
        }
        if (!g.name || !String(g.name).trim()) {
          throw new Error('saveTemplate: greetTemplates 第 ' + (i + 1) + ' 项 name 不能为空');
        }
        if (!g.text || !String(g.text).trim()) {
          throw new Error('saveTemplate: greetTemplates 第 ' + (i + 1) + ' 项 text 不能为空');
        }
      }
      // defaultGreetTemplateId 必须在列表里（或为空）
      if (template.defaultGreetTemplateId) {
        const ids = template.greetTemplates.map(function (g) { return g.id; });
        if (ids.indexOf(template.defaultGreetTemplateId) === -1) {
          throw new Error('saveTemplate: defaultGreetTemplateId 不在 greetTemplates 列表中');
        }
      }
    }
    // customPrompt 校验：null / 字符串都可（字符串可为长文本，不限长度）
    if (template.customPrompt !== undefined && template.customPrompt !== null
        && typeof template.customPrompt !== 'string') {
      throw new Error('saveTemplate: customPrompt 必须是 null 或字符串');
    }
  }

  // 入参支持两种：
  //   - 含 jdId → 更新（找不到则当新建处理，保留传入 jdId）
  //   - 不含 jdId → 新建（自动生成 jdId）
  async function saveTemplate(template) {
    validateTemplate(template);
    const list = await listTemplates();
    const now = Date.now();
    let saved;
    if (template.jdId) {
      const idx = list.findIndex(function (t) { return t.jdId === template.jdId; });
      if (idx === -1) {
        saved = Object.assign({ createdAt: now }, template, { updatedAt: now });
        list.push(saved);
      } else {
        saved = Object.assign({}, list[idx], template, { updatedAt: now });
        list[idx] = saved;
      }
    } else {
      saved = Object.assign({}, template, {
        jdId: genId(),
        createdAt: now,
        updatedAt: now
      });
      list.push(saved);
    }
    await self.BossStorageSync.set({ [KEY_TEMPLATES]: list });
    return saved;
  }

  async function deleteTemplate(jdId) {
    if (!jdId) return false;
    const list = await listTemplates();
    const idx = list.findIndex(function (t) { return t.jdId === jdId; });
    if (idx === -1) return false;
    list.splice(idx, 1);
    await self.BossStorageSync.set({ [KEY_TEMPLATES]: list });
    // 删的是当前 → 当前置空（admin 应该提示用户重选）
    const cur = await getCurrentJdId();
    if (cur === jdId) await setCurrentJdId('');
    return true;
  }

  async function getCurrentJdId() {
    const obj = await self.BossStorageSync.get(KEY_CURRENT);
    return obj[KEY_CURRENT] || '';
  }

  async function setCurrentJdId(jdId) {
    await self.BossStorageSync.set({ [KEY_CURRENT]: jdId || '' });
  }

  // 首启迁移 / 旧 schema 一次性覆盖
  //
  // 三种情况：
  //   1) storage 空 → 写入三个 SEED（印尼语实习生 + 测试工程师 + AI CX），当前 JD 默认 = 印尼语实习生
  //   2) storage 含旧 schema 条目（任一 JD 有 base/educationMin/bonus 等字段）
  //      → 一次性清空，写入三个 SEED（用户已确认：不做迁移，旧 JD 全弃）
  //   3) storage 已是新 schema → 幂等，啥也不做
  //
  // 当前 JD 处理：覆盖时若 currentJdId 指向已删 JD，重置为 SEED_INDONESIA_INTERN.jdId
  //   注意：v0.12.0 → v0.12.1 升级路径下，旧 currentJdId 若是 'indonesia-intern-2026' 仍然有效
  //   （新 SEED 沿用同一 jdId），所以从 v0.11 升级上来的用户不会被切走当前 JD。
  async function ensureSeeded() {
    await self.BossStorageSync.migrateFromLocal([KEY_TEMPLATES, KEY_CURRENT]);
    const list = await listTemplates();
    const hasOldSchema = list.some(isOldSchema);
    const allNew = list.length > 0 && list.every(function (t) { return !isOldSchema(t); });
    if (allNew) return;  // 情况 3：幂等

    // 情况 1 / 2：清空重写
    const now = Date.now();
    const seeds = [
      Object.assign({}, SEED_INDONESIA_INTERN, { createdAt: now, updatedAt: now }),
      Object.assign({}, SEED_QA_ENGINEER,      { createdAt: now, updatedAt: now }),
      Object.assign({}, SEED_AI_CX,            { createdAt: now, updatedAt: now })
    ];
    await self.BossStorageSync.set({ [KEY_TEMPLATES]: seeds });

    const cur = await getCurrentJdId();
    const stillValid = cur && seeds.find(function (s) { return s.jdId === cur; });
    if (!stillValid) {
      await setCurrentJdId(seeds[0].jdId);  // 默认指向印尼语实习生（MVP 单岗位）
    }

    if (hasOldSchema) {
      console.info('[BOSS-Sniffer JD] 检测到旧 schema，已重置为三条 SEED（印尼语实习生 + 测试工程师 + AI CX）');
    }
  }

  global.BossJD = {
    listTemplates: listTemplates,
    getTemplate: getTemplate,
    saveTemplate: saveTemplate,
    deleteTemplate: deleteTemplate,
    getCurrentJdId: getCurrentJdId,
    setCurrentJdId: setCurrentJdId,
    ensureSeeded: ensureSeeded,
    genConditionId: genConditionId,
    genGreetTemplateId: genGreetTemplateId,  // v0.25.2：JD 内嵌话术 ID 生成器
    isOldSchema: isOldSchema,
    isNewSchema: isNewSchema,
    SEED_INDONESIA_INTERN: SEED_INDONESIA_INTERN,
    SEED_QA_ENGINEER: SEED_QA_ENGINEER,
    SEED_AI_CX: SEED_AI_CX
  };
})(typeof self !== 'undefined' ? self : window);
