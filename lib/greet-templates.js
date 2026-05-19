// BOSS Sniffer - greet-templates.js (v0.17.1.0)
// 话术模板 CRUD + 持久化（chrome.storage.sync；与 JD 模板平行）
//
// 用途：v0.17.1.0 评估「符合」→ 自动输入话术 + 求简历闭环。HR 在 admin 管理模板，
//   sidepanel 选当前模板，evalSayhiCore 在 decision='符合' 时取当前话术作为聊天消息发出。
//
// 同时在 service worker（background.js importScripts）和 admin 页面（<script>）加载。
//
// 公开 API：self.BossGreetTemplates
//   - listTemplates()
//   - getTemplate(greetId)
//   - saveTemplate(template)      // 含 greetId 则更新；不含则新建
//   - deleteTemplate(greetId)
//   - getCurrentGreetId()
//   - setCurrentGreetId(greetId)
//   - ensureSeeded()              // 首启 → 写入三条 SEED
//   - SEED_GENERIC / SEED_BRIEF / SEED_INTRO   // 兜底常量

(function (global) {
  'use strict';

  const KEY_TEMPLATES = 'greet_templates';
  const KEY_CURRENT = 'current_greet_id';
  const MIN_TEXT_LEN = 5;  // text.trim().length 下限，避免 BOSS 反垃圾

  // === SEED 1：通用礼貌型 ===
  const SEED_GENERIC = {
    greetId: 'greet-generic-2026',
    name: '通用礼貌型',
    text: '您好，看了您的简历，跟我们这边的岗位挺契合，方便聊聊吗？',
    createdAt: 0,
    updatedAt: 0
  };

  // === SEED 2：简洁型 ===
  const SEED_BRIEF = {
    greetId: 'greet-brief-2026',
    name: '简洁型',
    text: '您好，对您的背景比较感兴趣，可以详细沟通下吗？',
    createdAt: 0,
    updatedAt: 0
  };

  // === SEED 3：自我介绍型 ===
  const SEED_INTRO = {
    greetId: 'greet-intro-2026',
    name: '自我介绍型',
    text: '您好，我是 HR，看了您的资料感觉很合适我们的岗位，方便深入聊聊吗？',
    createdAt: 0,
    updatedAt: 0
  };

  function genId() {
    return 'greet_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
  }

  async function listTemplates() {
    const obj = await self.BossStorageSync.get(KEY_TEMPLATES);
    const list = obj[KEY_TEMPLATES];
    return Array.isArray(list) ? list.slice() : [];
  }

  async function getTemplate(greetId) {
    if (!greetId) return null;
    const list = await listTemplates();
    return list.find(function (t) { return t.greetId === greetId; }) || null;
  }

  // 校验入参
  function validateTemplate(template) {
    if (!template || typeof template !== 'object') {
      throw new Error('saveTemplate: 入参必须是对象');
    }
    if (!template.name || !String(template.name).trim()) {
      throw new Error('saveTemplate: name 必填');
    }
    const text = String(template.text || '').trim();
    if (text.length < MIN_TEXT_LEN) {
      throw new Error('saveTemplate: text 至少需要 ' + MIN_TEXT_LEN + ' 字符（当前 ' + text.length + '），避免 BOSS 反垃圾');
    }
  }

  // 入参支持两种：
  //   - 含 greetId → 更新（找不到则当新建处理，保留传入 greetId）
  //   - 不含 greetId → 新建（自动生成 greetId）
  async function saveTemplate(template) {
    validateTemplate(template);
    const list = await listTemplates();
    const now = Date.now();
    let saved;
    if (template.greetId) {
      const idx = list.findIndex(function (t) { return t.greetId === template.greetId; });
      if (idx === -1) {
        saved = Object.assign({ createdAt: now }, template, { updatedAt: now });
        list.push(saved);
      } else {
        saved = Object.assign({}, list[idx], template, { updatedAt: now });
        list[idx] = saved;
      }
    } else {
      saved = Object.assign({}, template, {
        greetId: genId(),
        createdAt: now,
        updatedAt: now
      });
      list.push(saved);
    }
    await self.BossStorageSync.set({ [KEY_TEMPLATES]: list });
    return saved;
  }

  async function deleteTemplate(greetId) {
    if (!greetId) return false;
    const list = await listTemplates();
    const idx = list.findIndex(function (t) { return t.greetId === greetId; });
    if (idx === -1) return false;
    list.splice(idx, 1);
    await self.BossStorageSync.set({ [KEY_TEMPLATES]: list });
    // 删的是当前 → 当前置空
    const cur = await getCurrentGreetId();
    if (cur === greetId) await setCurrentGreetId('');
    return true;
  }

  async function getCurrentGreetId() {
    const obj = await self.BossStorageSync.get(KEY_CURRENT);
    return obj[KEY_CURRENT] || '';
  }

  async function setCurrentGreetId(greetId) {
    await self.BossStorageSync.set({ [KEY_CURRENT]: greetId || '' });
  }

  // 首启迁移：
  //   1) storage 空 → 写入三条 SEED，当前 = 通用礼貌型
  //   2) storage 已有内容 → 幂等
  async function ensureSeeded() {
    await self.BossStorageSync.migrateFromLocal([KEY_TEMPLATES, KEY_CURRENT]);
    const list = await listTemplates();
    if (list.length > 0) return;  // 幂等

    const now = Date.now();
    const seeds = [
      Object.assign({}, SEED_GENERIC, { createdAt: now, updatedAt: now }),
      Object.assign({}, SEED_BRIEF,   { createdAt: now, updatedAt: now }),
      Object.assign({}, SEED_INTRO,   { createdAt: now, updatedAt: now })
    ];
    await self.BossStorageSync.set({ [KEY_TEMPLATES]: seeds });

    const cur = await getCurrentGreetId();
    const stillValid = cur && seeds.find(function (s) { return s.greetId === cur; });
    if (!stillValid) {
      await setCurrentGreetId(seeds[0].greetId);  // 默认指向通用礼貌型
    }
  }

  global.BossGreetTemplates = {
    listTemplates: listTemplates,
    getTemplate: getTemplate,
    saveTemplate: saveTemplate,
    deleteTemplate: deleteTemplate,
    getCurrentGreetId: getCurrentGreetId,
    setCurrentGreetId: setCurrentGreetId,
    ensureSeeded: ensureSeeded,
    MIN_TEXT_LEN: MIN_TEXT_LEN,
    SEED_GENERIC: SEED_GENERIC,
    SEED_BRIEF: SEED_BRIEF,
    SEED_INTRO: SEED_INTRO
  };
})(typeof self !== 'undefined' ? self : window);
