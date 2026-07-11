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

      // 默认 6s 超时（防止 backend 不响应导致 await 永久挂起）
      if (!fetchOpts.signal) {
        const ctrl = new AbortController();
        const timer = setTimeout(function () { ctrl.abort(); }, options.timeout || 6000);
        fetchOpts.signal = ctrl.signal;
        // 保存 timer 引用以便 finally 清理
        fetchOpts._abortTimer = timer;
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
        console.error('[GeekOzon] API 请求失败:', path, err.message);
        return { code: -1, msg: err.message, data: null };
      } finally {
        // 清理超时 timer
        if (fetchOpts._abortTimer) clearTimeout(fetchOpts._abortTimer);
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

    /** 采集商品（超时 20s，因后端可能涉及类目匹配+AI 调用） */
    collectProduct: function (data) {
      return this.post('/api/products/collect', data, { timeout: 20000 });
    },

    /** 发布商品 */
    publishProducts: function (data) {
      return this.post('/api/publish', data);
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
