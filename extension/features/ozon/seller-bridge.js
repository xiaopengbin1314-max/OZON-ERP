/**
 * GeekOzon 扩展 - seller.ozon.ru 跨 tab 借权执行端
 *
 * 仅在 seller.ozon.ru 加载（依赖：namespace.js + config.js + dom-utils.js）
 *
 * 监听 chrome.runtime.onMessage 的 SELLER_BRIDGE_REQUEST 消息，
 * 根据消息中的 apiType 调用 seller.ozon.ru 的 7 个 API（对齐 maozi ERP）：
 *   - sales                  x-o3-language=zh-Hans  /api/v4/product/sales
 *   - variant                x-o3-language=RU       /api/v1/product/variant
 *   - variant_v2             x-o3-language=RU       /api/v1/product/variant_v2
 *   - search-sku-base        x-o3-language=RU       /api/v1/product/search-sku-base
 *   - what_to_sell           x-o3-language=zh-Hans  /api/site/seller-analytics/what_to_sell/data/v3
 *   - search-variant-model   x-o3-language=RU       /api/v1/search-variant-model
 *   - create-bundle          x-o3-language=RU       /api/site/seller-prototype/create-bundle-by-variant-id
 *
 * company_id 从 cookie sc_company_id 获取（domain: seller.ozon.ru）
 * 缓存到 localStorage 'ozon_company_id'
 *
 * 防重复注入：window.__geekOzonSellerBridgeLoaded
 */
;(function () {
  'use strict';

  const G = window.GeekOzon;
  if (!G || G.isLoaded('seller-bridge')) return;

  const Config = G.core.Config;
  const OZON_API_TYPE = Config.OZON_API_TYPE;
  const STORAGE_KEYS = Config.STORAGE_KEYS;

  /** SELLER_BRIDGE_REQUEST 消息类型（service worker 转发用） */
  const MSG_TYPE = 'SELLER_BRIDGE_REQUEST';

  /** seller.ozon.ru API 基础地址 */
  const SELLER_BASE = 'https://seller.ozon.ru';

  /** localStorage 中缓存 company_id 的键 */
  const LS_COMPANY_KEY = STORAGE_KEYS.OZON_COMPANY_ID;

  /**
   * 从 document.cookie 解析指定 cookie 名的值
   * @param {string} name
   * @returns {string}
   */
  function readCookie(name) {
    const cookies = document.cookie ? document.cookie.split(';') : [];
    for (let i = 0; i < cookies.length; i++) {
      const parts = cookies[i].split('=');
      if (parts.length < 2) continue;
      const k = parts[0].trim();
      if (k === name) {
        // 值中可能含 '='，拼接剩余部分
        return parts.slice(1).join('=').trim();
      }
    }
    return '';
  }

  /**
   * 获取 Ozon 公司 ID
   * 优先 cookie sc_company_id，失败回退 localStorage 缓存
   * @returns {string}
   */
  function getCompanyId() {
    let cid = readCookie('sc_company_id') || '';
    if (cid) {
      // 命中 cookie，刷新缓存
      try { localStorage.setItem(LS_COMPANY_KEY, cid); } catch (_) {}
      return cid;
    }
    try { cid = localStorage.getItem(LS_COMPANY_KEY) || ''; } catch (_) {}
    return cid;
  }

  /** 缓存 company_id 到 localStorage */
  function cacheCompanyId(cid) {
    if (!cid) return;
    try { localStorage.setItem(LS_COMPANY_KEY, cid); } catch (_) {}
  }

  /**
   * 构造各 apiType 的请求体（对齐 maozi ERP）
   * @param {string} sku - Ozon SKU
   * @param {string} companyId - 公司 ID
   * @returns {object} body
   */
  function buildRequestBody(apiType, sku, companyId) {
    if (apiType === OZON_API_TYPE.SALES) {
      // 销量数据（月维度，旧版接口）
      return {
        limit: '50',
        offset: '0',
        filter: {
          stock: 'any_stock',
          period: 'monthly',
          categories: [],
          sku: [sku],
        },
        sort: { key: 'sum_gmv_desc' },
      };
    }
    if (apiType === OZON_API_TYPE.WHAT_TO_SELL) {
      // 对齐 maozi：关键分析接口（销量/销售额/广告/促销/浏览/加购/佣金等 24+ 字段）
      // 端点：/api/site/seller-analytics/what_to_sell/data/v3
      return {
        limit: '50',
        offset: '0',
        filter: {
          stock: 'any_stock',
          period: 'monthly',
          categories: [],
          sku: [sku],
        },
        sort: { key: 'sum_gmv_desc' },
      };
    }
    if (apiType === OZON_API_TYPE.VARIANT) {
      // 变体搜索（按 SKU 名查询，旧版）
      return {
        name: sku,
        limit: '50',
      };
    }
    if (apiType === OZON_API_TYPE.SEARCH_VARIANT_MODEL) {
      // 对齐 maozi：变体型号搜索（按 name 搜，limit 50）
      // 端点：/api/v1/search-variant-model
      return {
        name: sku,
        limit: '50',
      };
    }
    if (apiType === OZON_API_TYPE.VARIANT_V2) {
      // 变体详情（需 variant_id，sku 字段约定为 "sku:variantId" 形式由调用方传入）
      const parts = String(sku).split(':');
      const variantId = parts[1] || '';
      return {
        company_id: companyId,
        variant_id: variantId,
        source: 'SOURCE_UI_COPY_MERGED',
      };
    }
    if (apiType === OZON_API_TYPE.CREATE_BUNDLE) {
      // 对齐 maozi：强制跟卖 - 按 variant_id 创建 bundle
      // 端点：/api/site/seller-prototype/create-bundle-by-variant-id
      // sku 字段约定为 "sku:variantId" 形式由调用方传入
      const parts = String(sku).split(':');
      const variantId = parts[1] || '';
      return {
        company_id: companyId,
        variant_id: variantId,
        source: 'SOURCE_UI_COPY_MERGED',
      };
    }
    if (apiType === OZON_API_TYPE.SEARCH_SKU_BASE) {
      // SKU 基础搜索（按 SKU 过滤）
      return {
        company_id: companyId,
        need_total: true,
        filter: {
          children_nodes: {
            children_nodes: [{
              input_leaf: {
                sku: { values: [sku] },
              },
            }],
            operator: 'AND',
          },
        },
        pagination: { limit: '50' },
        is_copy_allowed: false,
      };
    }
    return {};
  }

  /**
   * 构造请求头
   * - sales / what_to_sell: x-o3-language = zh-Hans
   * - 其他: x-o3-language = RU
   * - x-o3-company-id: company_id
   * @param {string} apiType
   * @param {string} companyId
   */
  function buildHeaders(apiType, companyId) {
    const lang = (apiType === OZON_API_TYPE.SALES || apiType === OZON_API_TYPE.WHAT_TO_SELL)
      ? 'zh-Hans' : 'RU';
    return {
      'Content-Type': 'application/json',
      'x-o3-language': lang,
      'x-o3-company-id': companyId || '',
      'Accept': 'application/json',
    };
  }

  /**
   * 构造 API 端点 URL（对齐 maozi ERP）
   * - sales:                  /api/v4/product/sales
   * - what_to_sell:           /api/site/seller-analytics/what_to_sell/data/v3
   * - variant:                /api/v1/product/variant
   * - variant_v2:             /api/v1/product/variant_v2
   * - search-sku-base:        /api/v1/product/search-sku-base
   * - search-variant-model:   /api/v1/search-variant-model
   * - create-bundle:          /api/site/seller-prototype/create-bundle-by-variant-id
   * @param {string} apiType
   */
  function buildEndpoint(apiType) {
    if (apiType === OZON_API_TYPE.SALES) {
      return SELLER_BASE + '/api/v4/product/sales';
    }
    if (apiType === OZON_API_TYPE.WHAT_TO_SELL) {
      return SELLER_BASE + '/api/site/seller-analytics/what_to_sell/data/v3';
    }
    if (apiType === OZON_API_TYPE.SEARCH_VARIANT_MODEL) {
      return SELLER_BASE + '/api/v1/search-variant-model';
    }
    if (apiType === OZON_API_TYPE.CREATE_BUNDLE) {
      return SELLER_BASE + '/api/site/seller-prototype/create-bundle-by-variant-id';
    }
    if (apiType === OZON_API_TYPE.VARIANT || apiType === OZON_API_TYPE.VARIANT_V2) {
      return SELLER_BASE + '/api/v1/product/' + apiType;
    }
    if (apiType === OZON_API_TYPE.SEARCH_SKU_BASE) {
      return SELLER_BASE + '/api/v1/product/' + apiType;
    }
    return SELLER_BASE + '/api/v1/product/' + apiType;
  }

  /**
   * 执行 seller.ozon.ru API 调用
   * @param {string} sku
   * @param {string} apiType
   * @returns {Promise<{success:boolean, data?:object, error?:string}>}
   */
  async function callSellerApi(sku, apiType) {
    const companyId = getCompanyId();
    if (!companyId) {
      return {
        success: false,
        error: 'NO_COMPANY_ID',
        message: '未登录 seller.ozon.ru 或 cookie 已失效',
      };
    }

    const url = buildEndpoint(apiType);
    const headers = buildHeaders(apiType, companyId);
    const body = buildRequestBody(apiType, sku, companyId);

    try {
      const resp = await fetch(url, {
        method: 'POST',
        headers: headers,
        body: JSON.stringify(body),
        credentials: 'include',  // 必须带 cookie（CSRF / 鉴权）
        mode: 'cors',
      });
      const text = await resp.text();
      let json;
      try { json = JSON.parse(text); }
      catch (_) { json = { raw: text }; }

      if (!resp.ok) {
        return {
          success: false,
          error: 'HTTP_' + resp.status,
          status: resp.status,
          data: json,
        };
      }
      return { success: true, data: json, status: resp.status };
    } catch (e) {
      return { success: false, error: 'FETCH_FAILED', message: e.message };
    }
  }

  /**
   * 监听 service worker 转发的 SELLER_BRIDGE_REQUEST 消息
   * 消息格式：{ type:'SELLER_BRIDGE_REQUEST', sku, apiType, requestId }
   */
  chrome.runtime.onMessage.addListener(function (message, sender, sendResponse) {
    if (!message || message.type !== MSG_TYPE) return false;

    const sku = message.sku;
    const apiType = message.apiType;

    if (!sku || !apiType) {
      sendResponse({
        success: false,
        error: 'INVALID_PARAMS',
        message: '缺少 sku 或 apiType',
      });
      return false;
    }

    // 异步执行，返回 true 保持消息通道开启
    callSellerApi(sku, apiType).then(function (result) {
      // 透传 requestId 方便调用方匹配
      result.requestId = message.requestId;
      result.apiType = apiType;
      sendResponse(result);
    }).catch(function (e) {
      sendResponse({
        success: false,
        error: 'BRIDGE_ERROR',
        message: e.message,
        requestId: message.requestId,
      });
    });
    return true;
  });

  // ===== PING 心跳（用于 service worker 测试桥接是否就绪） =====
  chrome.runtime.onMessage.addListener(function (message, sender, sendResponse) {
    if (message && message.type === 'PING') {
      const cid = getCompanyId();
      sendResponse({
        success: true,
        pong: Date.now(),
        hasCompanyId: !!cid,
        companyId: cid ? cid.slice(0, 4) + '****' : '',
      });
      return false;
    }
    return false;
  });

  // ===== 启动时预取 company_id 写入缓存 =====
  const cid0 = getCompanyId();
  if (cid0) cacheCompanyId(cid0);

  // ===== 防重复注入标志 =====
  window.__geekOzonSellerBridgeLoaded = true;

  // ===== 暴露调试入口（不挂到 GeekOzon.features，因依赖少） =====
  window.__geekOzonSellerBridge = {
    getCompanyId: getCompanyId,
    callSellerApi: callSellerApi,
    buildRequestBody: buildRequestBody,
    buildHeaders: buildHeaders,
    buildEndpoint: buildEndpoint,
  };

  G.markLoaded('seller-bridge');
  console.log('[GeekOzon] seller-bridge 已加载, companyId=' + (cid0 ? cid0.slice(0, 4) + '****' : '(空)'));
})();
