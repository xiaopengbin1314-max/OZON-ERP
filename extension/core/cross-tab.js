/**
 * GeekOzon 扩展 - 跨 tab 借权
 * 通过 service worker 向 seller.ozon.ru 标签页发起 API 请求
 * 实现机制：CROSS_TAB_OZON_REQUEST 消息通道 + seller-bridge.js 桥接
 */
;(function () {
  'use strict';

  const G = window.GeekOzon;
  if (!G || G.isLoaded('cross-tab')) return;

  const Config = G.core.Config;
  const MSG = Config.MSG;
  const OZON_API_TYPE = Config.OZON_API_TYPE;

  /**
   * 带超时的 chrome.runtime.sendMessage
   * Manifest V3 的 service worker 会休眠，可能导致回调永不触发
   * @param {object} message
   * @param {number} [timeout=8000] 超时毫秒
   */
  function sendMessageWithTimeout(message, timeout) {
    timeout = timeout || 8000;
    return new Promise(function (resolve) {
      let resolved = false;
      const timer = setTimeout(function () {
        if (resolved) return;
        resolved = true;
        resolve({ success: false, error: 'TIMEOUT', message: 'chrome.runtime 超时' });
      }, timeout);
      try {
        chrome.runtime.sendMessage(message, function (resp) {
          if (resolved) return;
          resolved = true;
          clearTimeout(timer);
          // 检查 chrome.runtime.lastError（service worker 不存在/已休眠）
          const lastErr = chrome.runtime.lastError;
          if (lastErr) {
            resolve({ success: false, error: 'RUNTIME_ERROR', message: lastErr.message });
            return;
          }
          resolve(resp || { success: false, error: 'NO_RESPONSE' });
        });
      } catch (e) {
        if (resolved) return;
        resolved = true;
        clearTimeout(timer);
        resolve({ success: false, error: e.message });
      }
    });
  }

  const CrossTab = {
    /**
     * 检查 seller.ozon.ru 标签页是否打开
     * @returns {Promise<{hasSellerTab: boolean, tabId?: number}>}
     */
    checkSellerTab: function () {
      return sendMessageWithTimeout({ type: MSG.CHECK_SELLER_TAB }, 5000)
        .then(function (resp) {
          return resp || { hasSellerTab: false };
        });
    },

    /**
     * 跨 tab 调用 seller.ozon.ru API
     * @param {string} sku - Ozon 商品 SKU
     * @param {string} apiType - OZON_API_TYPE 枚举值
     * @returns {Promise<{success: boolean, data?: object, error?: string}>}
     */
    request: function (sku, apiType) {
      return sendMessageWithTimeout({
        type: MSG.CROSS_TAB_OZON_REQUEST,
        sku: sku,
        apiType: apiType,
        requestId: Date.now() + '_' + Math.random().toString(36).slice(2),
      }, 10000);
    },

    /** 拉取销量数据（旧版 /api/v4/product/sales，保留兜底） */
    fetchSales: function (sku) {
      return this.request(sku, OZON_API_TYPE.SALES);
    },

    /**
     * 拉取"该卖什么"分析数据（对齐 maozi 主接口）
     * 端点：/api/site/seller-analytics/what_to_sell/data/v3
     * 返回 24+ 字段：月销量/月销售额/月周转动态/日销量/日销售额/广告费占比/
     *               参与促销天数/折扣/促销转化率/付费推广天数/商品卡浏览量/
     *               加购率/搜索目录浏览量/搜索加购率/展示转化率/发货模式/
     *               退货取消率/长宽高/重量/上架时间/类目/rFBS佣金/FBP佣金/跟卖列表
     * @param {string} sku
     */
    fetchWhatToSell: function (sku) {
      return this.request(sku, OZON_API_TYPE.WHAT_TO_SELL);
    },

    /** 拉取变体搜索（旧版 /api/v1/product/variant） */
    fetchVariant: function (sku) {
      return this.request(sku, OZON_API_TYPE.VARIANT);
    },

    /**
     * 拉取变体型号搜索（对齐 maozi）
     * 端点：/api/v1/search-variant-model
     * @param {string} name - 变体名称/SKU
     */
    fetchVariantModels: function (name) {
      return this.request(name, OZON_API_TYPE.SEARCH_VARIANT_MODEL);
    },

    /** 拉取变体详情 */
    fetchVariantV2: function (sku, variantId) {
      return this.request(sku + ':' + variantId, OZON_API_TYPE.VARIANT_V2);
    },

    /**
     * 强制跟卖 - 按 variant_id 创建 bundle（对齐 maozi）
     * 端点：/api/site/seller-prototype/create-bundle-by-variant-id
     * @param {string} sku - 商品 SKU（仅用于日志/透传）
     * @param {string} variantId - 变体 ID
     */
    createBundle: function (sku, variantId) {
      return this.request(sku + ':' + variantId, OZON_API_TYPE.CREATE_BUNDLE);
    },

    /** 拉取 SKU 基础搜索 */
    fetchSkuBase: function (sku) {
      return this.request(sku, OZON_API_TYPE.SEARCH_SKU_BASE);
    },

    /**
     * 获取指定 URL 的 cookie
     * @param {string} url
     * @param {string} name - cookie 名（可选，不传返回全部）
     */
    getCookies: function (url, name) {
      return new Promise(function (resolve) {
        try {
          chrome.runtime.sendMessage({
            type: MSG.GET_COOKIES,
            url: url,
            name: name,
          }, function (resp) {
            resolve(resp || []);
          });
        } catch (e) {
          resolve([]);
        }
      });
    },

    /** 从 sc_company_id cookie 获取 Ozon 公司 ID */
    getOzonCompanyId: function () {
      return this.getCookies('https://seller.ozon.ru', 'sc_company_id').then(function (cookies) {
        if (cookies && cookies.length > 0) {
          return cookies[0].value;
        }
        return null;
      });
    },
  };

  G.core.CrossTab = CrossTab;
  G.markLoaded('cross-tab');
})();
