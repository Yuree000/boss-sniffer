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
  // v1.1.15:5 → 0 彻底放开话术长度门槛(原 5 字符无任何业务/风控理由,纯开发者自我保护代码)。
  //   理由跟 inject.js executeGreetThenRequestResume 改动同源:HR 在 admin 手填话术,
  //   1-4 字符的「您好」「在吗」「请问」是 HR 真实使用场景,不该被工具挡。
  //   注:这个 lib/greet-templates.js 在 v0.25.2 话术内嵌进 JD 后已实质孤儿,
  //   主路径走 lib/jd-templates.js,但本 lib 的 SEED_GENERIC 文本仍被 v1.1.15 默认话术沿用。
  const MIN_TEXT_LEN = 0;

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

  /**
   * 列出 storage.sync 里所有招呼语模板(浅拷贝)
   * 返回: Promise<招呼模板数组>
   */
  async function listTemplates() {
    const obj = await self.BossStorageSync.get(KEY_TEMPLATES);
    const list = obj[KEY_TEMPLATES];
    return Array.isArray(list) ? list.slice() : [];
  }

  /**
   * 按 greetId 查一条招呼模板
   *
   * 参数:
   *   - greetId: 招呼模板 ID
   *
   * 返回: 模板对象;找不到 / 空 ID 返回 null
   */
  async function getTemplate(greetId) {
    if (!greetId) return null;
    const list = await listTemplates();
    return list.find(function (t) { return t.greetId === greetId; }) || null;
  }

  /**
   * 校验招呼模板入参(name 必填 / text trim 后非空)
   * 注:v1.1.15 起放开"长度 >= 5"门槛,HR 写"在吗"也允许
   *
   * 参数:
   *   - template: 待校验的招呼模板对象
   *
   * 返回: 无返回值;不合法直接 throw Error
   */
  function validateTemplate(template) {
    if (!template || typeof template !== 'object') {
      throw new Error('saveTemplate: 入参必须是对象');
    }
    if (!template.name || !String(template.name).trim()) {
      throw new Error('saveTemplate: name 必填');
    }
    // v1.1.15:删除 text < MIN_TEXT_LEN throw。保留 trim 为空时报错(name 同款),区分"HR 没填"vs"短话术"。
    const text = String(template.text || '').trim();
    if (text.length === 0) {
      throw new Error('saveTemplate: text 不能为空');
    }
  }

  /**
   * 保存招呼模板(自动判断新建还是更新)
   *   - 入参含 greetId → 更新(若找不到则当新建,保留传入 greetId)
   *   - 入参不含 greetId → 新建(自动生成 greetId)
   *
   * 参数:
   *   - template: 待保存的模板对象(必须含 name + text)
   *
   * 返回: Promise<保存后的完整模板对象(含 createdAt/updatedAt)>
   */
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

  /**
   * 按 greetId 删除招呼模板;若删的正是当前激活的,顺便清空 current_greet_id
   *
   * 参数:
   *   - greetId: 招呼模板 ID
   *
   * 返回: Promise<boolean>;true=删除成功,false=空入参 / 未找到
   */
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

  /**
   * 拿当前激活的招呼模板 ID
   * 返回: Promise<string>;未设返回空串
   */
  async function getCurrentGreetId() {
    const obj = await self.BossStorageSync.get(KEY_CURRENT);
    return obj[KEY_CURRENT] || '';
  }

  /**
   * 设置当前激活的招呼模板 ID(HR 在 admin 切换默认招呼语时调)
   *
   * 参数:
   *   - greetId: 招呼模板 ID;传空串表示不选
   */
  async function setCurrentGreetId(greetId) {
    await self.BossStorageSync.set({ [KEY_CURRENT]: greetId || '' });
  }

  /**
   * 首启迁移:storage 空 → 写入三条 SEED 招呼模板;否则幂等不动
   *   1) storage 空 → 写入 SEED_GENERIC / SEED_BRIEF / SEED_INTRO,当前 = 通用礼貌型
   *   2) storage 已有内容 → 不覆盖,直接返回
   *
   * 返回: Promise(无返回值)
   */
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
