// BOSS Sniffer - boss-positions.js (v1.1.23)
//
// BOSS 岗位(Position)= "工具里的 BOSS 招聘岗位概念",对应 BOSS 端的招聘职位名。
// 一个 BOSS 岗位下挂多个**筛选模板**(Template,旧名 JD 模板),每个模板有独立 must/optional 条件。
//
// === 为什么引入这一层(v1.1.23 P3-1)===
// HR 业务现状(2026-05-22 会议确认):
//   - BOSS 上只发 1 个职位(如 "AI Builder")
//   - HR 工具内部要 N 个细分筛选模板(偏前端 / 偏后端 / 偏产品...)
// v1.1.22 P2-4/6/7 解决了"换 JD 重评""内容变重评""复制 JD",但**没**解决
// 同名 JD 同时存在时 jd-router 只取第一个 → 第二第三个 JD 形同虚设。
// 引入 BOSS Position 层后:
//   - 沟通页路由按 position.name 匹配候选人 jobAligned,命中后**对该 position 下所有 templates 逐个跑 LLM**
//   - 推荐页 HR 选 position → 再选具体 template (单个 / 全部 / 多选)
//   - 评估结果按 (candidateId, templateId) 隔离,候选人在不同 template 下独立评估
//
// === 数据模型(chrome.storage.sync) ===
// boss_positions: BossPosition[]
//   { positionId, name, sortOrder, createdAt, updatedAt }
// jd_templates: Template[] (复用,但加 positionId FK 字段)
//   { jdId (templateId), name, positionId, mustConditions, optionalConditions, ..., contentHash, sortOrder }
//
// === 老数据迁移 ===
// ensureSeeded() 调用时:
//   - 老 template 无 positionId → 自动建 1 BossPosition (name = template.name),
//     positionId = 'pos_' + jdId,template.positionId = positionId
//   - 一对一兜底,HR 后续手动合并 / 重构
//
// === API (self.BossPositions) ===
//   listPositions()                     → BossPosition[] (含 sortOrder 排序)
//   getPosition(positionId)             → BossPosition | null
//   savePosition(position)              → 含 positionId 则更新,否则新建
//   deletePosition(positionId, opts)    → 删 position + 该 position 下所有 templates (opts.cascade=true 强制)
//   listPositionsWithTemplates()        → [{ position, templates[] }] (给 admin 渲染用)
//   listTemplatesForPosition(positionId)→ Template[] (按 sortOrder)
//   reorderPositions(orderedIds)        → 重排 positions
//   reorderTemplatesInPosition(positionId, orderedIds) → 重排 position 下的 templates
//   ensureSeeded()                      → 老数据自动迁移 + 幂等
//   genPositionId()                     → 'pos_xxx'

(function (global) {
  'use strict';

  const KEY_POSITIONS = 'boss_positions';
  const KEY_TEMPLATES = 'jd_templates';   // 复用 jd-templates 的 key (一份数据,两个 API 视角)

  function genPositionId() {
    return 'pos_' + Date.now().toString(36) + '_' +
      Math.floor(Math.random() * 1e6).toString(36);
  }

  /**
   * 列出所有 BOSS 岗位,按 sortOrder 升序(无 sortOrder 的排末尾)
   * 返回: Promise<BossPosition[]>
   */
  async function listPositions() {
    const obj = await self.BossStorageSync.get(KEY_POSITIONS);
    const list = Array.isArray(obj[KEY_POSITIONS]) ? obj[KEY_POSITIONS].slice() : [];
    list.sort(function (a, b) {
      const sa = (a && typeof a.sortOrder === 'number') ? a.sortOrder : Number.MAX_SAFE_INTEGER;
      const sb = (b && typeof b.sortOrder === 'number') ? b.sortOrder : Number.MAX_SAFE_INTEGER;
      if (sa !== sb) return sa - sb;
      // sortOrder 相同时按 createdAt 兜底
      return (a.createdAt || 0) - (b.createdAt || 0);
    });
    return list;
  }

  /**
   * 按 positionId 查一条
   * 返回: Promise<BossPosition | null>
   */
  async function getPosition(positionId) {
    if (!positionId) return null;
    const list = await listPositions();
    return list.find(function (p) { return p.positionId === positionId; }) || null;
  }

  function validatePosition(position) {
    if (!position || typeof position !== 'object') {
      throw new Error('savePosition: 入参必须是对象');
    }
    if (!position.name || !String(position.name).trim()) {
      throw new Error('savePosition: name 必填');
    }
  }

  /**
   * 保存 BOSS 岗位 — 含 positionId 则更新,不含则新建并自动生成 ID
   *
   * 参数:
   *   - position: { positionId?, name, sortOrder? }
   * 返回: Promise<BossPosition>(已入库,含最终 positionId/createdAt/updatedAt)
   */
  async function savePosition(position) {
    validatePosition(position);
    const list = await listPositions();
    const now = Date.now();
    let saved;
    if (position.positionId) {
      const idx = list.findIndex(function (p) { return p.positionId === position.positionId; });
      if (idx === -1) {
        // 找不到 → 当新建处理但保留传入 ID
        saved = Object.assign({ createdAt: now, sortOrder: list.length }, position, { updatedAt: now });
        list.push(saved);
      } else {
        saved = Object.assign({}, list[idx], position, { updatedAt: now });
        list[idx] = saved;
      }
    } else {
      saved = Object.assign({}, position, {
        positionId: genPositionId(),
        createdAt: now,
        updatedAt: now,
        sortOrder: typeof position.sortOrder === 'number' ? position.sortOrder : list.length
      });
      list.push(saved);
    }
    await self.BossStorageSync.set({ [KEY_POSITIONS]: list });
    return saved;
  }

  /**
   * 删除 BOSS 岗位,**默认级联删该岗位下所有 templates** (cascade=false 时仅删 position 留孤儿 templates,
   * 但孤儿 templates 在下次 ensureSeeded 会被自动重新挂回某个 position,所以默认 cascade=true)
   *
   * 参数:
   *   - positionId
   *   - opts.cascade: 默认 true,级联删 templates
   *
   * 返回: Promise<{ deleted: boolean, deletedTemplatesCount: number }>
   */
  async function deletePosition(positionId, opts) {
    const cascade = !opts || opts.cascade !== false;
    if (!positionId) return { deleted: false, deletedTemplatesCount: 0 };
    const list = await listPositions();
    const idx = list.findIndex(function (p) { return p.positionId === positionId; });
    if (idx === -1) return { deleted: false, deletedTemplatesCount: 0 };
    list.splice(idx, 1);
    await self.BossStorageSync.set({ [KEY_POSITIONS]: list });

    let deletedTemplatesCount = 0;
    if (cascade) {
      const templatesObj = await self.BossStorageSync.get(KEY_TEMPLATES);
      const templates = Array.isArray(templatesObj[KEY_TEMPLATES]) ? templatesObj[KEY_TEMPLATES] : [];
      const keep = templates.filter(function (t) {
        if (t && t.positionId === positionId) {
          deletedTemplatesCount++;
          return false;
        }
        return true;
      });
      if (deletedTemplatesCount > 0) {
        await self.BossStorageSync.set({ [KEY_TEMPLATES]: keep });
      }
    }
    return { deleted: true, deletedTemplatesCount: deletedTemplatesCount };
  }

  /**
   * 列出 position 下所有 templates,按 sortOrder 升序
   * 返回: Promise<Template[]>
   */
  async function listTemplatesForPosition(positionId) {
    if (!positionId) return [];
    const obj = await self.BossStorageSync.get(KEY_TEMPLATES);
    const templates = Array.isArray(obj[KEY_TEMPLATES]) ? obj[KEY_TEMPLATES] : [];
    const filtered = templates.filter(function (t) { return t && t.positionId === positionId; });
    filtered.sort(function (a, b) {
      const sa = (a && typeof a.sortOrder === 'number') ? a.sortOrder : Number.MAX_SAFE_INTEGER;
      const sb = (b && typeof b.sortOrder === 'number') ? b.sortOrder : Number.MAX_SAFE_INTEGER;
      if (sa !== sb) return sa - sb;
      return (a.createdAt || 0) - (b.createdAt || 0);
    });
    return filtered;
  }

  /**
   * 给 admin UI 渲染用 — 返回所有 positions 含其 templates 的嵌套结构
   * 返回: Promise<[{ position: BossPosition, templates: Template[] }]>
   */
  async function listPositionsWithTemplates() {
    const positions = await listPositions();
    const obj = await self.BossStorageSync.get(KEY_TEMPLATES);
    const allTemplates = Array.isArray(obj[KEY_TEMPLATES]) ? obj[KEY_TEMPLATES] : [];
    return positions.map(function (p) {
      const templates = allTemplates
        .filter(function (t) { return t && t.positionId === p.positionId; })
        .sort(function (a, b) {
          const sa = (a && typeof a.sortOrder === 'number') ? a.sortOrder : Number.MAX_SAFE_INTEGER;
          const sb = (b && typeof b.sortOrder === 'number') ? b.sortOrder : Number.MAX_SAFE_INTEGER;
          if (sa !== sb) return sa - sb;
          return (a.createdAt || 0) - (b.createdAt || 0);
        });
      return { position: p, templates: templates };
    });
  }

  /**
   * 重排 positions(批量更新 sortOrder)
   * 参数: orderedIds — 从前到后的 positionId 数组
   */
  async function reorderPositions(orderedIds) {
    if (!Array.isArray(orderedIds) || !orderedIds.length) return;
    const list = await listPositions();
    const now = Date.now();
    orderedIds.forEach(function (id, i) {
      const p = list.find(function (x) { return x.positionId === id; });
      if (p) {
        p.sortOrder = i;
        p.updatedAt = now;
      }
    });
    await self.BossStorageSync.set({ [KEY_POSITIONS]: list });
  }

  /**
   * 重排某 position 下的 templates(批量更新 sortOrder)
   * 参数: positionId, orderedIds — 从前到后的 templateId(jdId)数组
   */
  async function reorderTemplatesInPosition(positionId, orderedIds) {
    if (!positionId || !Array.isArray(orderedIds) || !orderedIds.length) return;
    const obj = await self.BossStorageSync.get(KEY_TEMPLATES);
    const templates = Array.isArray(obj[KEY_TEMPLATES]) ? obj[KEY_TEMPLATES] : [];
    const now = Date.now();
    orderedIds.forEach(function (id, i) {
      const t = templates.find(function (x) { return x && x.jdId === id && x.positionId === positionId; });
      if (t) {
        t.sortOrder = i;
        t.updatedAt = now;
      }
    });
    await self.BossStorageSync.set({ [KEY_TEMPLATES]: templates });
  }

  /**
   * 老数据自动迁移 + 幂等
   *
   * 三种情况:
   *   1) boss_positions 已有数据 + 所有 templates 都有 positionId → 幂等,直接返回
   *   2) templates 中存在 positionId 缺失的(老 v1.1.22 数据)→
   *      对每个孤儿 template 自动建一个 BossPosition (name = template.name),
   *      template.positionId 设为该 position.positionId
   *      同名 template 合并到同一个 position(name 严格相等去重),实现"同名 JD 自动归集"
   *   3) boss_positions 为空但所有 templates 都已有 positionId → 异常状态,补 boss_positions 从 templates 反推
   *
   * 返回: Promise<{ migratedTemplates: number, createdPositions: number }>
   */
  async function ensureSeeded() {
    // 防御性 migrate from local (跟 jd-templates 一致)
    await self.BossStorageSync.migrateFromLocal([KEY_POSITIONS]);

    const positions = await listPositions();
    const templatesObj = await self.BossStorageSync.get(KEY_TEMPLATES);
    const templates = Array.isArray(templatesObj[KEY_TEMPLATES]) ? templatesObj[KEY_TEMPLATES] : [];

    // 情况 1:幂等 — 所有 template 都已挂 positionId
    const orphans = templates.filter(function (t) { return t && !t.positionId; });
    if (orphans.length === 0 && positions.length > 0) {
      return { migratedTemplates: 0, createdPositions: 0 };
    }

    // 情况 2/3:开始迁移
    const now = Date.now();
    let createdPositions = 0;
    let migratedTemplates = 0;

    // 按 template name 分组 → 同名 templates 合并到同一个 position(实现"复制出来的同名 JD 自动归集")
    // 若已有 position 的 name 匹配某个 orphan,直接复用(不重复建)
    const positionsByName = {};
    positions.forEach(function (p) { positionsByName[String(p.name).trim()] = p; });

    orphans.forEach(function (t) {
      const tname = String(t.name || '').trim() || '未命名';
      let pos = positionsByName[tname];
      if (!pos) {
        pos = {
          positionId: genPositionId(),
          name: tname,
          sortOrder: positions.length + createdPositions,
          createdAt: now,
          updatedAt: now
        };
        positions.push(pos);
        positionsByName[tname] = pos;
        createdPositions++;
      }
      t.positionId = pos.positionId;
      // 同 position 下,template 按 createdAt 兜底排序 — 不破坏既有 sortOrder
      if (typeof t.sortOrder !== 'number') {
        const siblings = templates.filter(function (x) { return x && x.positionId === pos.positionId; });
        t.sortOrder = siblings.length - 1;
      }
      t.updatedAt = now;
      migratedTemplates++;
    });

    if (createdPositions > 0) {
      await self.BossStorageSync.set({ [KEY_POSITIONS]: positions });
    }
    if (migratedTemplates > 0) {
      await self.BossStorageSync.set({ [KEY_TEMPLATES]: templates });
      console.info('[BOSS-Sniffer Position] v1.1.23 自动迁移: 创建 ' + createdPositions +
        ' 个 BOSS 岗位, 关联 ' + migratedTemplates + ' 个模板');
    }

    return { migratedTemplates: migratedTemplates, createdPositions: createdPositions };
  }

  global.BossPositions = {
    listPositions: listPositions,
    getPosition: getPosition,
    savePosition: savePosition,
    deletePosition: deletePosition,
    listTemplatesForPosition: listTemplatesForPosition,
    listPositionsWithTemplates: listPositionsWithTemplates,
    reorderPositions: reorderPositions,
    reorderTemplatesInPosition: reorderTemplatesInPosition,
    ensureSeeded: ensureSeeded,
    genPositionId: genPositionId,
    KEY_POSITIONS: KEY_POSITIONS
  };
})(typeof window !== 'undefined' ? window : self);
