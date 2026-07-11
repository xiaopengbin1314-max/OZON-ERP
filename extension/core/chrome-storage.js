/**
 * GeekOzon 扩展 - chrome.storage 封装
 * 提供 Promise 化的存储读写 + 跨标签页同步
 */
;(function () {
  'use strict';

  const G = window.GeekOzon;
  if (!G || G.isLoaded('chrome-storage')) return;

  const Storage = {
    /**
     * 读取本地存储
     * @param {string|Array} keys - 键名或键名数组
     * @returns {Promise<object>}
     */
    get: function (keys) {
      return new Promise(function (resolve) {
        try {
          chrome.storage.local.get(keys, function (items) {
            resolve(items || {});
          });
        } catch (e) {
          console.error('[GeekOzon] storage.get 失败:', e);
          resolve({});
        }
      });
    },

    /** 读取单个键 */
    getOne: function (key, fallback) {
      return this.get(key).then(function (items) {
        const v = items && items[key];
        return v !== undefined ? v : fallback;
      });
    },

    /**
     * 写入本地存储
     * @param {object} obj - 键值对
     */
    set: function (obj) {
      return new Promise(function (resolve) {
        try {
          chrome.storage.local.set(obj, function () {
            resolve();
          });
        } catch (e) {
          console.error('[GeekOzon] storage.set 失败:', e);
          resolve();
        }
      });
    },

    /** 写入单个键 */
    setOne: function (key, value) {
      const obj = {};
      obj[key] = value;
      return this.set(obj);
    },

    /** 删除键 */
    remove: function (keys) {
      return new Promise(function (resolve) {
        try {
          chrome.storage.local.remove(keys, function () {
            resolve();
          });
        } catch (e) {
          resolve();
        }
      });
    },

    /** 清空 */
    clear: function () {
      return new Promise(function (resolve) {
        try {
          chrome.storage.local.clear(function () {
            resolve();
          });
        } catch (e) {
          resolve();
        }
      });
    },

    /**
     * 监听存储变化（跨标签页同步）
     * @param {string} key - 监听的键
     * @param {function} cb - 回调 (newValue, oldValue)
     */
    onChanged: function (key, cb) {
      try {
        chrome.storage.onChanged.addListener(function (changes, area) {
          if (area !== 'local') return;
          if (changes[key]) {
            cb(changes[key].newValue, changes[key].oldValue);
          }
        });
      } catch (e) {
        console.warn('[GeekOzon] storage.onChanged 注册失败:', e);
      }
    },
  };

  G.core.Storage = Storage;
  G.markLoaded('chrome-storage');
})();
