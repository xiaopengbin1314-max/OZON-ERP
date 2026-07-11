/**
 * GeekOzon 扩展 - 全局配置
 * API 基础地址、平台映射、消息类型常量
 */
;(function () {
  'use strict';

  const G = window.GeekOzon;
  if (!G || G.isLoaded('config')) return;

  /** 默认 API 基础地址（本地 GeekOzon 后端） */
  const DEFAULT_API_BASE = 'http://localhost:5000';

  /** chrome.storage.local 的设置键名 */
  const SETTINGS_KEY = 'geekOzonSettings';

  /** 平台标识枚举 */
  const PLATFORM = {
    OZON: 'ozon',
    SELLER_OZON: 'seller.ozon.ru',
    ALIBABA: '1688',
    TAOBAO: 'taobao',
    TMALL: 'tmall',
    PDD: 'pdd',
    JD: 'jd',
    ALIEXPRESS: 'aliexpress',
    WILDBERRIES: 'wildberries',
  };

  /** 消息类型常量（service worker 通信） */
  const MSG = {
    // 跨 tab 借权
    CROSS_TAB_OZON_REQUEST: 'CROSS_TAB_OZON_REQUEST',
    CHECK_SELLER_TAB: 'CHECK_SELLER_TAB',
    TEST_SELLER_TAB_COMMUNICATION: 'TEST_SELLER_TAB_COMMUNICATION',
    REFRESH_SELLER_TAB: 'REFRESH_SELLER_TAB',
    // Cookie
    GET_COOKIES: 'GET_COOKIES',
    // Ozon SKU API（直接调用，不走 seller.ozon.ru 桥接）
    OZON_SKU_API_REQUEST: 'OZON_SKU_API_REQUEST',
    // 采集
    COLLECT_PRODUCT: 'COLLECT_PRODUCT',
    // 心跳
    PING_TEST: 'PING_TEST',
  };

  /** 跨 tab 借权的 7 种 apiType（对齐 maozi ERP） */
  const OZON_API_TYPE = {
    // 旧版销量数据（保留兜底）
    SALES: 'sales',                       // /api/v4/product/sales  (zh-Hans)
    VARIANT: 'variant',                   // /api/v1/product/variant  (RU)
    VARIANT_V2: 'variant_v2',             // /api/v1/product/variant_v2  (RU)
    SEARCH_SKU_BASE: 'search-sku-base',   // /api/v1/product/search-sku-base  (RU)
    // 新增：对齐 maozi ERP（关键分析接口）
    WHAT_TO_SELL: 'what_to_sell',         // /api/site/seller-analytics/what_to_sell/data/v3  (zh-Hans)
    SEARCH_VARIANT_MODEL: 'search-variant-model',  // /api/v1/search-variant-model  (RU)
    CREATE_BUNDLE: 'create-bundle',       // /api/site/seller-prototype/create-bundle-by-variant-id  (RU，强制跟卖)
  };

  /** 缓存键 */
  const STORAGE_KEYS = {
    SETTINGS: SETTINGS_KEY,
    FIELD_SETTINGS: 'geekOzonFieldSettings',
    PROFIT_CALC_PARAMS: 'geekOzon-profit-calc-params',
    DRAWER_WIDTH: 'geekOzon-drawer-width',
    OZON_COMPANY_ID: 'ozon_company_id',
  };

  G.core.Config = {
    DEFAULT_API_BASE,
    SETTINGS_KEY,
    PLATFORM,
    MSG,
    OZON_API_TYPE,
    STORAGE_KEYS,

    /** 读取完整设置（带缓存，60 秒过期） */
    getSettings: function () {
      const now = Date.now();
      if (G.runtime.settings && now - G.runtime.settingsLoadedAt < 60000) {
        return Promise.resolve(G.runtime.settings);
      }
      return new Promise(function (resolve) {
        try {
          chrome.storage.local.get(SETTINGS_KEY, function (items) {
            const s = (items && items[SETTINGS_KEY]) || {};
            G.runtime.settings = s;
            G.runtime.settingsLoadedAt = Date.now();
            resolve(s);
          });
        } catch (e) {
          resolve({});
        }
      });
    },

    /** 读取 API 基础地址（去掉末尾斜杠） */
    getApiBaseUrl: function () {
      return this.getSettings().then(function (s) {
        return (s.apiBaseUrl || DEFAULT_API_BASE).replace(/\/+$/, '');
      });
    },

    /** 读取单项设置 */
    getSetting: function (key, fallback) {
      return this.getSettings().then(function (s) {
        return s[key] !== undefined ? s[key] : fallback;
      });
    },

    /** 写入设置（合并） */
    setSettings: function (patch) {
      const self = this;
      return this.getSettings().then(function (old) {
        const merged = Object.assign({}, old, patch);
        return new Promise(function (resolve) {
          const obj = {};
          obj[SETTINGS_KEY] = merged;
          try {
            chrome.storage.local.set(obj, function () {
              G.runtime.settings = merged;
              G.runtime.settingsLoadedAt = Date.now();
              resolve(merged);
            });
          } catch (e) {
            resolve(merged);
          }
        });
      });
    },

    /** 清除设置缓存（强制下次重新读取） */
    invalidateCache: function () {
      G.runtime.settings = null;
      G.runtime.settingsLoadedAt = 0;
    },
  };

  G.markLoaded('config');
})();
