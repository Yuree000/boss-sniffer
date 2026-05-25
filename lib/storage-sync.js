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

  /**
   * Promise 化的 chrome.storage.sync.get,把 callback 错误转成 reject
   *
   * 参数:
   *   - keys: 字符串 / 字符串数组 / 对象(默认值映射) — 同 chrome.storage.sync.get 入参
   *
   * 返回: Promise<{ key: value }>
   */
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

  /**
   * Promise 化的 chrome.storage.sync.set,写入前每条做配额预检
   *
   * 参数:
   *   - obj: { key: value } 多键写入对象
   *
   * 返回: Promise(无返回值);超配额 / chrome 错抛 Error
   */
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

  /**
   * 从 chrome.storage.local 一次性迁移指定 key 到 chrome.storage.sync(per-key 幂等)
   * 用于早期版本用 local 存的 JD/招呼语/LLM 配置,新版统一迁到 sync 跨设备同步
   *
   * 迁移规则:
   *   - sync 已有对应 key → skip(已迁)
   *   - per-key _migratedToSync_<key> 已 true → skip(避免重复)
   *   - sync 空 + local 有 → 复制到 sync,local 留副本作回滚兜底
   *
   * 参数:
   *   - keys: 要迁移的 key 字符串数组
   *
   * 返回: Promise<{ migrated, skipped, errors }> 迁移结果统计
   */
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
