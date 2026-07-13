/**
 * GeekOzon 扩展 - API 客户端
 * 统一封装 fetch 请求，免鉴权模式
 * 所有业务模块通过 GeekOzon.core.ApiClient 调用后端
 */
;(function () {
  'use strict';

  const G = window.GeekOzon;
  if (!G || G.isLoaded('api-client')) return;

  const Config = G.core.Config;

  /** 上一次请求时间（用于限流日志） */
  let _lastRequestAt = 0;

  const ApiClient = {
    /**
     * 发起 API 请求
     * @param {string} path - 路径，如 '/api/ozon/sku_data'
     * @param {object} options - { method, body, headers, signal, timeout }
     * @returns {Promise<object>} - { code, msg, data }
     */
    request: async function (path, options) {
      options = options || {};
      const base = await Config.getApiBaseUrl();
      const url = base + path;
      const method = options.method || 'GET';

      const headers = {
        'Content-Type': 'application/json',
      };
      if (options.headers) Object.assign(headers, options.headers);

      const fetchOpts = {
        method: method,
        headers: headers,
        credentials: 'omit',  // 免鉴权，不带 cookie
      };
      if (options.body != null) {
        fetchOpts.body = JSON.stringify(options.body);
      }
      if (options.signal) fetchOpts.signal = options.signal;

      // 默认超时（防止 backend 不响应导致 await 永久挂起）。计时器属于
      // ApiClient，不能作为自定义字段塞进 fetch options。
      let timeoutTimer = null;
      let timeoutController = null;
      const timeoutMs = Number(options.timeout) || 10000;
      if (!fetchOpts.signal) {
        timeoutController = new AbortController();
        timeoutTimer = setTimeout(function () {
          timeoutController.abort();
        }, timeoutMs);
        fetchOpts.signal = timeoutController.signal;
      }

      _lastRequestAt = Date.now();

      try {
        const res = await fetch(url, fetchOpts);
        const text = await res.text();
        let json;
        try { json = JSON.parse(text); }
        catch (_) { json = { code: -1, msg: '响应非 JSON: ' + text.slice(0, 200), data: null }; }
        return json;
      } catch (err) {
        const timedOut = !!(timeoutController && timeoutController.signal.aborted);
        const aborted = timedOut || (err && (err.name === 'AbortError' || /aborted/i.test(String(err.message || ''))));
        const message = timedOut
          ? `ERP 请求超时（${Math.round(timeoutMs / 1000)}秒）：${path}`
          : (aborted ? `ERP 请求已取消：${path}` : (err.message || '网络请求失败'));
        console.error('[GeekOzon] API 请求失败:', path, message, err);
        return { code: -1, msg: message, data: null, errorType: timedOut ? 'timeout' : (aborted ? 'aborted' : 'network') };
      } finally {
        if (timeoutTimer) clearTimeout(timeoutTimer);
      }
    },

    /** GET 请求 */
    get: function (path, options) {
      const opts = options || {};
      opts.method = 'GET';
      delete opts.body;
      return this.request(path, opts);
    },

    /** POST 请求 */
    post: function (path, body, options) {
      const opts = options || {};
      opts.method = 'POST';
      opts.body = body;
      return this.request(path, opts);
    },

    /** PUT 请求 */
    put: function (path, body, options) {
      const opts = options || {};
      opts.method = 'PUT';
      opts.body = body;
      return this.request(path, opts);
    },

    /** DELETE 请求 */
    del: function (path, options) {
      const opts = options || {};
      opts.method = 'DELETE';
      delete opts.body;
      return this.request(path, opts);
    },

    /** 判断响应是否成功 */
    isOk: function (resp) {
      return resp && resp.code === 200;
    },

    /** 从响应取 data，失败返回 fallback */
    data: function (resp, fallback) {
      if (this.isOk(resp) && resp.data != null) return resp.data;
      return fallback !== undefined ? fallback : null;
    },

    // ===== 业务接口快捷方法 =====

    /** 读取定价配置 */
    fetchPricing: function () {
      return this.get('/api/config/pricing');
    },

    /** 更新定价配置 */
    updatePricing: function (config) {
      return this.put('/api/config/pricing', config);
    },

    /** 定价计算 */
    calculatePrice: function (params) {
      return this.post('/api/pricing/calculate', params);
    },

    /** 利润计算 */
    calculateProfit: function (params) {
      return this.post('/api/pricing/profit', params);
    },

    /** 店铺列表 */
    fetchShops: function () {
      return this.get('/api/shops/lists');
    },

    /** 采集商品（后端可能涉及类目匹配、属性清洗和字典匹配） */
    collectProduct: function (data) {
      return this.post('/api/products/collect', data, { timeout: 45000 });
    },

    /** 发布商品 */
    publishProducts: function (data) {
      return this.post('/api/publish', data, { timeout: 20000 });
    },

    fetchPublishStatus: function (taskId) {
      return this.get('/api/publish/' + encodeURIComponent(taskId) + '/status');
    },

    /** Ozon SKU 数据 - 批量获取 */
    batchGetSkuData: function (skus) {
      return this.post('/api/ozon/sku_data/batch_get', { skus: skus });
    },

    /** Ozon SKU 数据 - 写入缓存 */
    upsertSkuData: function (sku, title, data) {
      return this.post('/api/ozon/sku_data', {
        sku: sku, title: title || '', data: data, source: 'extension',
      });
    },

    /** 收藏 - 切换 */
    toggleFavorite: function (sku) {
      return this.post('/api/products/favorite/toggle', { sku: sku });
    },

    /** 选品规则 - 列表 */
    fetchSelectionRules: function () {
      return this.get('/api/selection/rules');
    },

    /** 水印模板 - 列表 */
    fetchWatermarkTemplates: function () {
      return this.get('/api/watermark/templates');
    },

    /** 汇率 */
    fetchExchangeRate: function () {
      return this.get('/api/exchange_rate');
    },
  };

  G.core.ApiClient = ApiClient;
  G.markLoaded('api-client');
})();
