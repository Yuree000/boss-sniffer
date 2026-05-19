// BOSS Sniffer - storage-sync.js (v0.17.0)
// chrome.storage.sync 读写 + 配额预检 + storage.local → sync 一次性迁移
//
// 国内未登录账号场景：chrome.storage.sync API 不报错，自动退化为本地存储。
// 配额：8KB/item，100KB/total。3 条 SEED JD 模板共约 1.6KB，远低于限额。

(function (global) {
  'use strict';

  const QUOTA_BYTES = 102400;
  const QUOTA_BYTES_PER_ITEM = 8192;
  const SAFETY_MARGIN = 1024;  // 留 1KB 余量

  function byteSize(value) {
    return new Blob([JSON.stringify(value)]).size;
  }

  // 预检：在写入前确认不超配额，抛业务错误而不是 sync 写 quota_bytes 抛底层错
  function precheckSize(key, value) {
    const itemBytes = byteSize({ [key]: value });
    if (itemBytes > QUOTA_BYTES_PER_ITEM - SAFETY_MARGIN) {
      const e = new Error('单条数据过大（' + itemBytes + ' 字节，上限 ' + (QUOTA_BYTES_PER_ITEM - SAFETY_MARGIN) + '）');
      e.name = 'SyncQuotaPerItemError';
      throw e;
    }
  }

  async function get(keys) {
    return new Promise(function (resolve, reject) {
      chrome.storage.sync.get(keys, function (res) {
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message));
        } else {
          resolve(res || {});
        }
      });
    });
  }

  async function set(obj) {
    // 多 key 写入前对每条做预检
    for (const k in obj) {
      if (Object.prototype.hasOwnProperty.call(obj, k)) precheckSize(k, obj[k]);
    }
    return new Promise(function (resolve, reject) {
      chrome.storage.sync.set(obj, function () {
        if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
        else resolve();
      });
    });
  }

  // local → sync 一次性迁移（per-key flag，跨 key set 调用互不干扰）
  // - 若 sync 已有对应 key 数据 → 跳过（已迁过）
  // - 若 per-key _migratedToSync_<key> 为 true → 跳过（此 key 已迁过，即使 sync 被清也不重复）
  // - 若 sync 为空且 local 有 → 复制到 sync，local 留副本 + 写 per-key 标记（回滚兜底）
  async function migrateFromLocal(keys) {
    const result = { migrated: [], skipped: [], errors: [] };
    const syncBefore = await get(keys);

    // 读 local，同时读所有 per-key 迁移标志
    const flagKeys = keys.map(function (k) { return '_migratedToSync_' + k; });
    const localBefore = await new Promise(function (resolve) {
      chrome.storage.local.get(keys.concat(flagKeys), function (r) { resolve(r || {}); });
    });

    const toWrite = {};
    const flagsToSet = {};
    for (let i = 0; i < keys.length; i++) {
      const k = keys[i];
      const flagKey = '_migratedToSync_' + k;
      if (syncBefore[k] !== undefined) {
        result.skipped.push(k);
        continue;
      }
      if (localBefore[flagKey] === true) {
        // 此 key 已迁过但 sync 现在空了（用户清过 sync？） → 仍然 skip 避免重复迁
        result.skipped.push(k);
        continue;
      }
      if (localBefore[k] !== undefined) {
        try {
          precheckSize(k, localBefore[k]);
          toWrite[k] = localBefore[k];
          flagsToSet[flagKey] = true;
          result.migrated.push(k);
        } catch (err) {
          result.errors.push({ key: k, error: err.message });
        }
      } else {
        // local 也没有 → 标记已"尝试过"，避免下次再走读 local 流程
        flagsToSet[flagKey] = true;
      }
    }

    if (Object.keys(toWrite).length > 0) {
      await set(toWrite);
    }
    if (Object.keys(flagsToSet).length > 0) {
      // 标记 local 已迁，留 local 副本作回滚（不删）
      await new Promise(function (resolve) {
        chrome.storage.local.set(flagsToSet, resolve);
      });
    }
    return result;
  }

  global.BossStorageSync = {
    get: get,
    set: set,
    precheckSize: precheckSize,
    migrateFromLocal: migrateFromLocal,
    QUOTA_BYTES: QUOTA_BYTES,
    QUOTA_BYTES_PER_ITEM: QUOTA_BYTES_PER_ITEM,
    SAFETY_MARGIN: SAFETY_MARGIN
  };
})(self);
