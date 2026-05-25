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

  // v1.1.15:全 JD 默认招呼语 + 迁移机制。
  //   任何已创建/新建的 JD 默认带 1 条招呼语(此文本),HR 可在 admin 改 / 删。
  //   HR 删空后,迁移逻辑不会再加回(看 greetSeededAt 字段判断"已迁移过")。
  //   文本沿用 v0.17.1.0 SEED_GENERIC(已 HR 验证过的语气,无缝迁移)。
  const DEFAULT_GREET_TEXT = '您好，看了您的简历，跟我们这边的岗位挺契合，方便聊聊吗？';
  const DEFAULT_GREET_ID = 'gt_default_v1';
  const DEFAULT_GREET_NAME = '默认招呼';

  // 构造一条默认话术(给 SEED JD / migrateGreetTemplates / admin 新建 JD 三处共用)
  function buildDefaultGreetTemplate() {
    return { id: DEFAULT_GREET_ID, name: DEFAULT_GREET_NAME, text: DEFAULT_GREET_TEXT };
  }

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
    // v1.1.15：默认注入 1 条招呼语（HR 可在 admin 改 / 删）
    greetTemplates: [{ id: DEFAULT_GREET_ID, name: DEFAULT_GREET_NAME, text: DEFAULT_GREET_TEXT }],
    defaultGreetTemplateId: DEFAULT_GREET_ID,
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
    // v1.1.15：默认注入 1 条招呼语
    greetTemplates: [{ id: DEFAULT_GREET_ID, name: DEFAULT_GREET_NAME, text: DEFAULT_GREET_TEXT }],
    defaultGreetTemplateId: DEFAULT_GREET_ID,
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
    // v1.1.15：默认注入 1 条招呼语
    greetTemplates: [{ id: DEFAULT_GREET_ID, name: DEFAULT_GREET_NAME, text: DEFAULT_GREET_TEXT }],
    defaultGreetTemplateId: DEFAULT_GREET_ID,
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

  /**
   * 列出 storage.sync 里所有 JD 模板(只读,返回浅拷贝)
   * 返回: Promise<JD 数组>(没数据返回空数组)
   */
  async function listTemplates() {
    const obj = await self.BossStorageSync.get(KEY_TEMPLATES);
    const list = obj[KEY_TEMPLATES];
    return Array.isArray(list) ? list.slice() : [];
  }

  /**
   * 按 jdId 查一条 JD 模板
   *
   * 参数:
   *   - jdId: JD 唯一标识(SEED 是固定字符串如 'indonesia-intern-2026',自定义是 'jd_xxx')
   *
   * 返回: JD 对象;找不到 / jdId 空返回 null
   */
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

  // v1.1.22 P2-6:JD 内容 hash — 用于 evaluation dedup 第 6 道门(同 jdId 但内容变了 → 重评)
  //
  // 设计要点(2026-05-24 P2-6 业务约束):
  //   - 只 hash 4 个评估相关字段:mustConditions / optionalConditions / optionalThreshold / customPrompt
  //   - 不 hash:name / greetTemplates / createdAt / updatedAt / defaultGreetTemplateId
  //     (这些字段变化不影响 LLM 判断结果,改名 / 改话术不应该作废历史评估)
  //   - mustConditions / optionalConditions 是 [{id, text}] 数组,内部按 id 字典序排序后再序列化
  //     (id 是稳定唯一标识;text 可能重复,按 id 排序更可靠)
  //   - 同步函数:用 FNV-1a 32-bit 字符串 hash,**不**用 crypto.subtle(异步会污染 saveTemplate
  //     调用方,也防止 evalSayhiCore dedup 分支被迫加 await)
  //   - 返回 8 位 hex string(2^32 空间对 JD 数量级足够,碰撞概率极低)
  //
  // 兼容性:老 JD 记录无 contentHash → saveTemplate 下次写入会补;evaluation 端按"空 hash"
  //   兜底处理(见 background.js evalSayhiCore P2-6 第 6 道门)
  function computeContentHash(template) {
    if (!template || typeof template !== 'object') return '00000000';

    // 规范化 4 个评估相关字段
    // - 数组元素按 id 排序(id 缺失时 fallback 到 text,极少见但稳定)
    // - null/undefined 字段统一为 '' / 0,保证两个语义等价但表层不同的 JD hash 相等
    function normCondList(arr) {
      if (!Array.isArray(arr)) return [];
      // 浅拷贝避免污染原数组,然后按 id 排序
      return arr.slice().sort(function (a, b) {
        const ka = (a && a.id) || (a && a.text) || '';
        const kb = (b && b.id) || (b && b.text) || '';
        if (ka < kb) return -1;
        if (ka > kb) return 1;
        return 0;
      }).map(function (c) {
        return { id: (c && c.id) || '', text: (c && c.text) || '' };
      });
    }

    const payload = {
      must: normCondList(template.mustConditions),
      opt: normCondList(template.optionalConditions),
      thr: Number.isFinite(Number(template.optionalThreshold))
        ? Number(template.optionalThreshold) : 0,
      cp: (template.customPrompt == null) ? '' : String(template.customPrompt)
    };

    const str = JSON.stringify(payload);

    // FNV-1a 32-bit:简单 / 同步 / 无依赖 / 雪崩效果对短字符串够用
    //   不用于密码学,只用于 dedup key —— 碰撞概率在 JD 量级(< 1000)可忽略
    let h = 0x811c9dc5; // FNV offset basis
    for (let i = 0; i < str.length; i++) {
      h ^= str.charCodeAt(i);
      // 等价于 h *= 16777619,用位移 + 加法避免 32-bit 溢出问题
      h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
    }
    // 转 8 位 hex(不足前面补 0,保证长度稳定)
    return ('00000000' + h.toString(16)).slice(-8);
  }

  // 入参支持两种：
  //   - 含 jdId → 更新（找不到则当新建处理，保留传入 jdId）
  //   - 不含 jdId → 新建（自动生成 jdId）
  // v1.1.22 P2-6:写入前算 contentHash,evaluation dedup 用这个判断"JD 内容是否变了"
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
    // v1.1.22 P2-6:在写入 storage 前最后一刻计算 contentHash
    //   放在所有字段 merge 之后,确保 hash 反映**最终**入库的 4 字段值
    saved.contentHash = computeContentHash(saved);
    await self.BossStorageSync.set({ [KEY_TEMPLATES]: list });
    return saved;
  }

  // v1.1.22 P2-7:JD 模板复制(CX 业务方诉求:一个 BOSS JD 对应多个细分筛选条件)
  //
  // 设计要点(2026-05-24 P2-7 业务约束):
  //   - 深拷贝 4 个评估相关字段 + greetTemplates,保证改副本不影响源(共享引用陷阱大坑)
  //   - mustConditions / optionalConditions 的 id **重新生成** —— 若沿用源 id,
  //     HR 之后在某一份上删条件,另一份的 dedup hash 计算可能因 id 冲突出现误判
  //     (computeContentHash 按 id 排序;同 jdId 范围内 id 应当稳定唯一即可,
  //     但 admin UI 也借这个 id 做行 key,保险起见重新生成更稳)
  //   - greetTemplates 的 id 也重新生成,并把 defaultGreetTemplateId 映射到新 id;
  //     源的 defaultGreetTemplateId 找不到对应原 greet 则置 null(防止悬空引用)
  //   - 名称按 "{源 name}(副本)" 起步,若已存在则升级到 (副本2) / (副本3) / ...
  //     —— 用 listTemplates() 做唯一性检查,确保 HR 不会看到两条同名 JD 难以区分
  //   - jdId / createdAt / contentHash 全部留空,交给 saveTemplate 统一生成(包括
  //     P2-6 加的 contentHash 自动计算 —— 副本和源会自然共享 hash,正确反映"内容相同")
  //
  // 调用方:admin.js loadJDList 的 .btn-jd-clone click handler;复制完跳编辑器,
  //   HR 改一两个字段就能开始用,3 秒上手新副本。
  //
  // 参数:
  //   - sourceId: 源 JD 的 jdId
  // 返回: Promise<新 JD 对象>(已经入库,含 saveTemplate 分配的 jdId / createdAt / contentHash)
  // 抛错:'jd_not_found'(源不存在)
  async function cloneTemplate(sourceId) {
    const source = await getTemplate(sourceId);
    if (!source) {
      throw new Error('jd_not_found');
    }

    // 名称去重:基础 "(副本)";已存在则升级到 "(副本2)" / "(副本3)" / ...
    //   注:第一次冲突直接跳到 "副本2",符合 HR 习惯("副本1" 就叫"副本"足够区分了)
    const allTemplates = await listTemplates();
    const existingNames = allTemplates.map(function (t) { return t.name; });
    const baseName = (source.name || '未命名') + '(副本)';
    let newName = baseName;
    let counter = 2;
    while (existingNames.indexOf(newName) !== -1) {
      newName = (source.name || '未命名') + '(副本' + counter + ')';
      counter++;
    }

    // 深拷贝 must/opt 条件 + 重新生成 id
    //   id 重新生成的理由:见函数头注释("ID 冲突陷阱"段)
    const clonedMust = (Array.isArray(source.mustConditions) ? source.mustConditions : [])
      .map(function (c) {
        return { id: genConditionId('must'), text: (c && c.text) || '' };
      });
    const clonedOpt = (Array.isArray(source.optionalConditions) ? source.optionalConditions : [])
      .map(function (c) {
        return { id: genConditionId('opt'), text: (c && c.text) || '' };
      });

    // 深拷贝 greetTemplates + 重新生成 id + 构造旧→新 id 映射表
    //   defaultGreetTemplateId 通过映射表跳到新 id;找不到 → null(防悬空引用)
    const greetIdMap = {};
    const clonedGreets = (Array.isArray(source.greetTemplates) ? source.greetTemplates : [])
      .map(function (g) {
        const newId = genGreetTemplateId();
        if (g && g.id) greetIdMap[g.id] = newId;
        return {
          id: newId,
          name: (g && g.name) || '',
          text: (g && g.text) || ''
        };
      });
    const newDefaultGreetId = (source.defaultGreetTemplateId
      && greetIdMap[source.defaultGreetTemplateId]) || null;

    // 构造副本对象 —— jdId / createdAt / updatedAt / contentHash 全部不设,
    //   交给 saveTemplate(P2-6 已升级)统一处理
    const clone = {
      // 注意:**不**传 jdId,saveTemplate 走"新建"分支自动 genId()
      name: newName,
      mustConditions: clonedMust,
      optionalConditions: clonedOpt,
      optionalThreshold: Number.isInteger(Number(source.optionalThreshold))
        ? Number(source.optionalThreshold) : 0,
      customPrompt: (typeof source.customPrompt === 'string' && source.customPrompt)
        ? source.customPrompt : null,
      greetTemplates: clonedGreets,
      defaultGreetTemplateId: newDefaultGreetId
    };

    return await saveTemplate(clone);
  }

  /**
   * 按 jdId 删除一条 JD 模板;若被删的是当前激活 JD,顺便把 activeJdId 清空
   *
   * 参数:
   *   - jdId: 要删的 JD 唯一标识
   *
   * 返回: Promise<boolean>;true=找到并删;false=空入参 / 未找到
   */
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

  /**
   * 拿当前激活的 JD ID(LOOP 启动时按此 JD 评估候选人)
   * 返回: Promise<string>;未设返回空串
   */
  async function getCurrentJdId() {
    const obj = await self.BossStorageSync.get(KEY_CURRENT);
    return obj[KEY_CURRENT] || '';
  }

  /**
   * 设置当前激活 JD ID(HR 在 admin 切 JD 时调)
   *
   * 参数:
   *   - jdId: JD 标识;传空串等于"未选 JD"
   */
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

  // v1.1.15:一次性迁移 — 给"老 JD"(SW 启动时已存在、greetTemplates 为空、greetSeededAt 未设)
  //   注入 1 条默认招呼语,同时打 greetSeededAt 时间戳标记"已迁移过"。
  //
  // 幂等性:
  //   - greetSeededAt 已存在 → skip(HR 后续即使删空话术,也不会再被加回 — 尊重 HR 自主)
  //   - greetTemplates 非空 → skip + 顺手打 greetSeededAt(老 JD 自己有话术,标记不需要迁移)
  //   - 否则注入 buildDefaultGreetTemplate() + 设默认 + 打 greetSeededAt
  //
  // 返回:实际迁移的 JD 数(用于 diag log)
  async function migrateGreetTemplates() {
    const list = await listTemplates();
    if (!list.length) return 0;  // 没 JD 时 ensureSeeded 会处理,这里 noop
    let migrated = 0;
    let touched = false;
    const now = Date.now();
    for (let i = 0; i < list.length; i++) {
      const t = list[i];
      if (!t) continue;
      // 已迁移过 → skip(尊重 HR 删空意愿)
      if (t.greetSeededAt) continue;
      // 已有话术 → 不动话术,只打迁移标记
      if (Array.isArray(t.greetTemplates) && t.greetTemplates.length > 0) {
        t.greetSeededAt = now;
        touched = true;
        continue;
      }
      // 没话术 + 没迁移过 → 注入默认
      t.greetTemplates = [buildDefaultGreetTemplate()];
      t.defaultGreetTemplateId = DEFAULT_GREET_ID;
      t.greetSeededAt = now;
      t.updatedAt = now;
      migrated++;
      touched = true;
    }
    if (touched) {
      await self.BossStorageSync.set({ [KEY_TEMPLATES]: list });
    }
    if (migrated > 0) {
      console.info('[BOSS-Sniffer JD] v1.1.15 默认招呼语迁移完成,注入 ' + migrated + '/' + list.length + ' 个 JD');
    }
    return migrated;
  }

  global.BossJD = {
    listTemplates: listTemplates,
    getTemplate: getTemplate,
    saveTemplate: saveTemplate,
    cloneTemplate: cloneTemplate,  // v1.1.22 P2-7:JD 模板复制(CX 业务方诉求,一对多筛选)
    deleteTemplate: deleteTemplate,
    getCurrentJdId: getCurrentJdId,
    setCurrentJdId: setCurrentJdId,
    ensureSeeded: ensureSeeded,
    migrateGreetTemplates: migrateGreetTemplates,  // v1.1.15:默认招呼语一次性迁移
    buildDefaultGreetTemplate: buildDefaultGreetTemplate,  // v1.1.15:admin 新建 JD 用
    genConditionId: genConditionId,
    genGreetTemplateId: genGreetTemplateId,  // v0.25.2：JD 内嵌话术 ID 生成器
    isOldSchema: isOldSchema,
    isNewSchema: isNewSchema,
    computeContentHash: computeContentHash,  // v1.1.22 P2-6:JD 内容指纹(dedup 用)
    DEFAULT_GREET_TEXT: DEFAULT_GREET_TEXT,  // v1.1.15:对外暴露给 admin/测试
    DEFAULT_GREET_ID: DEFAULT_GREET_ID,
    SEED_INDONESIA_INTERN: SEED_INDONESIA_INTERN,
    SEED_QA_ENGINEER: SEED_QA_ENGINEER,
    SEED_AI_CX: SEED_AI_CX
  };
})(typeof self !== 'undefined' ? self : window);
