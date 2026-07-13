/**
 * API 请求封装模块
 * 统一处理前后端 HTTP 通信，含错误拦截、Token 注入、请求队列
 */
const Api = (() => {
  // 后端 API 基础地址（开发环境）
  const BASE_URL = 'http://localhost:5000';

  // 请求超时时间（毫秒）
  const TIMEOUT = 15000;

  /**
   * 核心请求方法
   * @param {string} endpoint - API 路径（如 /api/products）
   * @param {object} options - fetch 配置（额外支持 options.timeout 自定义超时毫秒）
   * @returns {Promise<object>} 解析后的 JSON 响应数据
   */
  async function request(endpoint, options = {}) {
    const url = `${BASE_URL}${endpoint}`;
    const controller = new AbortController();
    const timeoutMs = options.timeout || TIMEOUT;
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

    // 默认请求头
    const headers = {
      'Content-Type': 'application/json',
      ...options.headers,
    };

    // 自动注入 Token
    const token = Store?.getToken?.();
    if (token) {
      headers['Authorization'] = `Bearer ${token}`;
    }

    try {
      const fetchOpts = { ...options };
      delete fetchOpts.timeout;
      const response = await fetch(url, {
        ...fetchOpts,
        headers,
        signal: controller.signal,
      });

      clearTimeout(timeoutId);

      // 处理非 JSON 响应
      const contentType = response.headers.get('content-type') || '';
      if (!contentType.includes('json')) {
        throw new Error(`服务器返回非 JSON 数据 (${response.status})`);
      }

      const data = await response.json();

      // 业务层错误码处理
      if (data.code !== 200) {
        console.warn(`[API] ${options.method || 'GET'} ${endpoint} → 错误:`, data.msg);
        return data; // 返回错误信息，由调用方决定如何展示
      }

      return data;
    } catch (error) {
      clearTimeout(timeoutId);
      if (error.name === 'AbortError') {
        console.error(`[API] 请求超时: ${url}`);
        return { code: -1, msg: '请求超时，请检查网络连接', data: null };
      }
      // 后端未连接时只返回错误，不伪造业务数据
      if (error.message.includes('Failed to fetch') || error.message.includes('NetworkError')) {
        console.warn(`[API] 后端服务未运行 (${BASE_URL})`);
        return { code: -2, msg: '后端未连接', data: null };
      }
      console.error(`[API] 请求异常:`, error);
      return { code: -1, msg: error.message, data: null };
    }
  }

  /* ========== 商品相关接口 ========== */

  /** 获取商品列表 */
  function getProducts(params = {}) {
    const query = new URLSearchParams({
      page: params.page || 1,
      pageSize: params.pageSize || 50,
      status: params.status || '',
      keyword: params.keyword || '',
      group: params.group || '',
    }).toString();
    return request(`/api/products?${query}`);
  }

  /** 获取商品状态统计 */
  function getProductStats() {
    return request('/api/products/stats');
  }

  /** 获取单个商品详情 */
  function getProduct(id) {
    return request(`/api/products/${id}`);
  }

  /** 新增商品采集（含类目自动匹配，可能触发 AI 匹配，需要较长超时） */
  function collectProduct(productData) {
    return request('/api/products/collect', {
      method: 'POST',
      body: JSON.stringify(productData),
      timeout: 90000, // 采集时会同步执行类目匹配（含 AI 回退），给 90 秒
    });
  }

  /** 更新商品 */
  function updateProduct(id, productData) {
    return request(`/api/products/${id}`, {
      method: 'PUT',
      body: JSON.stringify(productData),
    });
  }

  /** 删除商品 */
  function deleteProduct(id) {
    return request(`/api/products/${id}`, { method: 'DELETE' });
  }

  /** 批量删除商品 */
  function batchDeleteProducts(ids) {
    return request('/api/products/batch/delete', {
      method: 'POST',
      body: JSON.stringify({ ids }),
    });
  }

  /** 批量更新商品 */
  function batchUpdateProducts(ids, updates) {
    return request('/api/products/batch/update', {
      method: 'POST',
      body: JSON.stringify({ ids, updates }),
    });
  }

  /* ========== 发布相关接口 ========== */

  /** 提交发布任务 */
  function submitPublish(taskData) {
    return request('/api/publish', {
      method: 'POST',
      body: JSON.stringify(taskData),
    });
  }

  /** 查询发布状态 */
  function getPublishStatus(taskId) {
    return request(`/api/publish/${taskId}/status`);
  }

  /** 重试失败的发布任务（支持断点续传） */
  function retryPublishTask(taskId) {
    return request(`/api/publish/${taskId}/retry`, { method: 'POST' });
  }

  /* ========== 上架记录接口 ========== */

  /** 获取上架记录列表 */
  function getPublishRecords(params = {}) {
    const query = new URLSearchParams({
      page: params.page || 1,
      pageSize: params.pageSize || 20,
      status: params.status || '',
      keyword: params.keyword || '',
      storeId: params.storeId || '',
    }).toString();
    return request(`/api/publish-records?${query}`);
  }

  /** 获取上架记录统计 */
  function getPublishRecordStats() {
    return request('/api/publish-records/stats');
  }

  /** 创建上架记录 */
  function createPublishRecord(data) {
    return request('/api/publish-records', {
      method: 'POST',
      body: JSON.stringify(data),
    });
  }

  /** 批量创建上架记录 */
  function batchCreatePublishRecords(data) {
    return request('/api/publish-records/batch', {
      method: 'POST',
      body: JSON.stringify(data),
    });
  }

  /** 获取单条上架记录 */
  function getPublishRecord(id) {
    return request(`/api/publish-records/${id}`);
  }

  /** 更新上架记录 */
  function updatePublishRecord(id, data) {
    return request(`/api/publish-records/${id}`, {
      method: 'PUT',
      body: JSON.stringify(data),
    });
  }

  /** 删除上架记录 */
  function deletePublishRecord(id) {
    return request(`/api/publish-records/${id}`, { method: 'DELETE' });
  }

  /** 提交上架记录到 Ozon */
  function submitPublishRecord(id) {
    return request(`/api/publish-records/${id}/submit`, { method: 'POST' });
  }

  /** 刷新上架记录状态 */
  function refreshPublishRecord(id) {
    return request(`/api/publish-records/${id}/refresh`, { method: 'POST' });
  }

  /** 批量删除上架记录 */
  function batchDeletePublishRecords(ids) {
    return request('/api/publish-records/batch/delete', {
      method: 'POST',
      body: JSON.stringify({ ids }),
    });
  }

  /** 批量提交上架记录 */
  function batchSubmitPublishRecords(ids) {
    return request('/api/publish-records/batch/submit', {
      method: 'POST',
      body: JSON.stringify({ ids }),
    });
  }

  /* ========== AI 相关接口 ========== */

  /** AI 内容生成 */
  function aiGenerate(params) {
    return request('/api/ai/generate', {
      method: 'POST',
      body: JSON.stringify(params),
    });
  }

  /** 获取所有 AI 模型配置 */
  function getAIModels() {
    return request('/api/ai/models');
  }

  /** 获取当前激活的 AI 提供商状态 */
  function getAIModelsStatus() {
    return request('/api/ai/models/status');
  }

  /** 更新单个 AI 提供商配置 */
  function updateAIModel(providerKey, data) {
    return request(`/api/ai/models/${providerKey}`, {
      method: 'PUT',
      body: JSON.stringify(data),
    });
  }

  /** 设置当前激活的 AI 提供商 */
  function setActiveAIModel(providerKey) {
    return request('/api/ai/models/active', {
      method: 'PUT',
      body: JSON.stringify({ provider: providerKey }),
    });
  }

  /** 删除自定义 AI 提供商 */
  function deleteAIModel(providerKey) {
    return request(`/api/ai/models/${providerKey}`, { method: 'DELETE' });
  }

  /** 测试 AI 提供商连接 */
  function testAIModelConnection(params) {
    return request('/api/ai/models/test', {
      method: 'POST',
      body: JSON.stringify(params),
    });
  }

  /* ========== 公告接口 ========== */

  /** 获取公告列表 */
  function getNotices(params = {}) {
    const query = new URLSearchParams({
      page: params.page || 1,
      pageSize: params.pageSize || 10,
    }).toString();
    return request(`/api/notices?${query}`);
  }

  /* ========== 工作台仪表盘接口 ========== */

  /** 获取工作台聚合统计数据（统计卡 / 最近活动 / 系统状态） */
  function getDashboardStats() {
    return request('/api/dashboard/stats');
  }

  /* ========== 用户/认证接口 ========== */

  /** 用户登录 */
  function login(credentials) {
    return request('/api/auth/login', {
      method: 'POST',
      body: JSON.stringify(credentials),
    });
  }

  /** 获取当前用户信息 */
  function getUserInfo() {
    return request('/api/user/info');
  }

  /* ========== 店铺管理接口 ========== */

  /** 获取店铺列表 */
  function getStores(params = {}) {
    const query = new URLSearchParams({
      authStatus: params.authStatus || '',
      group: params.group || '',
      keyword: params.keyword || '',
      notify: params.notify || '',
      accountId: params.accountId || '',
    }).toString();
    return request(`/api/stores?${query}`);
  }

  /** 添加店铺 */
  function createStore(storeData) {
    return request('/api/stores', {
      method: 'POST',
      body: JSON.stringify(storeData),
    });
  }

  /** 更新店铺 */
  function updateStore(id, storeData) {
    return request(`/api/stores/${id}`, {
      method: 'PUT',
      body: JSON.stringify(storeData),
    });
  }

  /** 删除店铺 */
  function deleteStore(id) {
    return request(`/api/stores/${id}`, { method: 'DELETE' });
  }

  /** 批量设置分组 */
  function batchSetGroup(ids, group) {
    return request('/api/stores/batch/group', {
      method: 'PUT',
      body: JSON.stringify({ ids, group }),
    });
  }

  /** 批量设置币种 */
  function batchSetCurrency(ids, currency) {
    return request('/api/stores/batch/currency', {
      method: 'PUT',
      body: JSON.stringify({ ids, currency }),
    });
  }

  /** 批量删除店铺 */
  function batchDeleteStores(ids) {
    return request('/api/stores/batch/delete', {
      method: 'POST',
      body: JSON.stringify({ ids }),
    });
  }

  /** 更新店铺授权 */
  function refreshStoreAuth(id) {
    return request(`/api/stores/${id}/refresh-auth`, { method: 'POST' });
  }

  /** 获取分组列表 */
  function getStoreGroups() {
    return request('/api/stores/groups');
  }

  /* ========== 类目接口 ========== */

  /** 获取 Ozon 真实类目树 */
  function getCategories(refresh = false) {
    let url = '/api/categories';
    if (refresh) url += '?refresh=1';
    return request(url);
  }

  /** 根据原始分类名称自动匹配 Ozon 类目 */
  function matchCategory(category, platform = 'ozon', title = '') {
    return request('/api/categories/match', {
      method: 'POST',
      body: JSON.stringify({ category, platform, title }),
    });
  }

  /** 使用 AI 强制重新匹配类目 */
  function aiMatchCategory(category, title, description = '') {
    return request('/api/categories/ai-match', {
      method: 'POST',
      body: JSON.stringify({ category, title, description }),
    });
  }

  /** 获取类目下的特征（属性） */
  function getCategoryAttributes(descriptionCategoryId, typeId, lang = 'ZH_HANS') {
    return request(`/api/categories/attributes?description_category_id=${descriptionCategoryId}&type_id=${typeId}&lang=${lang}`);
  }

  /** 搜索属性字典值（适用于品牌等大字典，不需要全量加载） */
  function searchAttributeValues(descriptionCategoryId, typeId, attributeId, query, lang = 'ZH_HANS') {
    const q = encodeURIComponent(query);
    return request(`/api/categories/attribute-values/search?description_category_id=${descriptionCategoryId}&type_id=${typeId}&attribute_id=${attributeId}&query=${q}&lang=${lang}`, {
      timeout: 15000,
    });
  }

  /** 获取特征的可选值（字典值），支持异步同步轮询 */
  function getAttributeValues(descriptionCategoryId, typeId, attributeId, lang = 'ZH_HANS', maxRetries = 15) {
    return _getAttributeValuesWithRetry(descriptionCategoryId, typeId, attributeId, lang, maxRetries);
  }

  /** 内部：带轮询重试的属性值获取（后端异步同步时返回 syncing=true） */
  function _getAttributeValuesWithRetry(descriptionCategoryId, typeId, attributeId, lang, retriesLeft) {
    return request(`/api/categories/attribute-values?description_category_id=${descriptionCategoryId}&type_id=${typeId}&attribute_id=${attributeId}&lang=${lang}`, {
      timeout: 10000,
    }).then(res => {
      // 后端返回 syncing=true 表示正在后台同步，需轮询重试
      if (res.code === 200 && res.syncing === true && retriesLeft > 0) {
        return new Promise(resolve => setTimeout(resolve, 2000)).then(() =>
          _getAttributeValuesWithRetry(descriptionCategoryId, typeId, attributeId, lang, retriesLeft - 1)
        );
      }
      return res;
    });
  }

  /** 批量预加载多个属性的字典值，支持异步同步轮询 */
  function batchGetAttributeValues(descriptionCategoryId, typeId, attributeIds, lang = 'ZH_HANS', maxRetries = 15) {
    return _batchGetAttributeValuesWithRetry(descriptionCategoryId, typeId, attributeIds, lang, maxRetries);
  }

  /** 内部：带轮询重试的批量属性值获取 */
  function _batchGetAttributeValuesWithRetry(descriptionCategoryId, typeId, attributeIds, lang, retriesLeft) {
    return request('/api/categories/attribute-values/batch', {
      method: 'POST',
      body: JSON.stringify({
        description_category_id: descriptionCategoryId,
        type_id: typeId,
        attribute_ids: attributeIds,
        lang,
      }),
      timeout: 15000,
    }).then(res => {
      // 后端返回 syncing=true 表示部分属性正在后台同步，需轮询重试
      if (res.code === 200 && res.syncing === true && retriesLeft > 0) {
        return new Promise(resolve => setTimeout(resolve, 2000)).then(() =>
          _batchGetAttributeValuesWithRetry(descriptionCategoryId, typeId, attributeIds, lang, retriesLeft - 1)
        );
      }
      return res;
    });
  }

  /* ========== 类目映射库同步管理 ========== */

  /** 获取类目映射库同步状态 */
  function getCategorySyncStatus() {
    return request('/api/categories/sync/status');
  }

  /** 触发后台异步同步类目映射库 */
  function triggerCategorySync(force = false) {
    return request('/api/categories/sync', {
      method: 'POST',
      body: JSON.stringify({ force }),
    });
  }

  /** 同步执行类目同步（阻塞等待完成） */
  function runCategorySync(force = false) {
    return request('/api/categories/sync/run', {
      method: 'POST',
      body: JSON.stringify({ force }),
      timeout: 120000, // 同步可能较慢，给 120 秒
    });
  }

  /** 获取同步历史记录 */
  function getCategorySyncHistory(limit = 10) {
    return request(`/api/categories/sync/history?limit=${limit}`);
  }

  /** 搜索 Ozon 类目（从数据库映射库查询） */
  function searchCategories(keyword, limit = 20) {
    return request(`/api/categories/search?keyword=${encodeURIComponent(keyword)}&limit=${limit}`);
  }

  /* ========== 类目属性库同步管理 ========== */

  /** 获取属性库同步状态 */
  function getAttrSyncStatus() {
    return request('/api/categories/attributes/sync/status');
  }

  /** 触发后台批量同步所有类目属性 */
  function triggerAttrSync() {
    return request('/api/categories/attributes/sync', { method: 'POST' });
  }

  /** 同步单个类目的属性 */
  function syncSingleCategoryAttrs(descriptionCategoryId, typeId, force = false) {
    return request('/api/categories/attributes/sync/single', {
      method: 'POST',
      body: JSON.stringify({
        description_category_id: descriptionCategoryId,
        type_id: typeId,
        force,
      }),
      timeout: 30000,
    });
  }

  // ===== 图片上传/转存接口 =====
  // Ozon API 只接受公网可访问的图片 URL，发布前必须将本地/防盗链图片转存到后端托管

  /** 上传单张图片（base64 或 File 对象）到后端托管 */
  function uploadImage(fileOrBase64) {
    // 如果是 File 对象，使用 multipart 上传
    if (fileOrBase64 instanceof File) {
      const formData = new FormData();
      formData.append('file', fileOrBase64);
      return fetch(BASE_URL + '/api/images/upload', {
        method: 'POST',
        body: formData,
      }).then(r => r.json()).catch(() => ({ code: -2, msg: '后端未连接' }));
    }
    // 否则按 base64 JSON 上传
    return request('/api/images/upload', {
      method: 'POST',
      body: JSON.stringify({ image: fileOrBase64 }),
      timeout: 30000,
    });
  }

  /** 批量转存外部图片 URL 到后端托管（用于发布前预处理 1688/淘宝防盗链图片） */
  function transferImages(images) {
    return request('/api/images/transfer', {
      method: 'POST',
      body: JSON.stringify({ images }),
      timeout: 60000,
    });
  }

  // ===== 定价 / 利润计算 =====

  /** 计算给定售价的利润分解（前端利润计算器使用） */
  function calculateProfit(params) {
    return request('/api/pricing/profit', {
      method: 'POST',
      body: JSON.stringify(params),
    });
  }

  /** 根据成本反推建议售价 */
  function calculatePrice(params) {
    return request('/api/pricing/calculate', {
      method: 'POST',
      body: JSON.stringify(params),
    });
  }

  /** 获取定价配置（持久化版本，从 pricing_config 表读取） */
  function getPricingConfig() {
    return request('/api/config/pricing');
  }

  /** 更新定价配置（持久化） */
  function updatePricingConfig(data) {
    return request('/api/config/pricing', {
      method: 'PUT',
      body: JSON.stringify(data),
    });
  }

  /** 查询类目佣金率（含 3 档默认回退） */
  function getCategoryCommission(categoryId, typeId) {
    const qs = typeId ? `?typeId=${typeId}` : '';
    return request(`/api/categories/${categoryId}/commission${qs}`);
  }

  /** 查询定价历史记录 */
  function getPricingHistory(productId, limit = 20, offset = 0) {
    const qs = new URLSearchParams({ limit, offset });
    if (productId) qs.set('productId', productId);
    return request(`/api/pricing/history?${qs.toString()}`);
  }

  /* ========== 在线商品接口（同步自 Ozon 店铺的在售商品）========== */

  /** 获取在线商品列表（分页 + 筛选） */
  function getOnlineProducts(params = {}) {
    const query = new URLSearchParams({
      page: params.page || 1,
      pageSize: params.pageSize || 50,
      status: params.status || '',
      group: params.group || '',
      rating: params.rating || '',
      store: params.store || '',
      storeId: params.storeId || '',
      keyword: params.keyword || '',
    }).toString();
    return request(`/api/online-products?${query}`);
  }

  /** 获取在线商品各状态统计 */
  function getOnlineProductStats() {
    return request('/api/online-products/stats');
  }

  /** 获取单个在线商品详情 */
  function getOnlineProduct(id) {
    return request(`/api/online-products/${id}`);
  }

  function getOnlineProductEditData(id) {
    return request(`/api/online-products/${id}/edit-data`, { timeout: 60000 });
  }

  function saveOnlineProductEditData(id, data) {
    return request(`/api/online-products/${id}/edit-data`, {
      method: 'PUT', body: JSON.stringify(data), timeout: 180000,
    });
  }

  /** 全量同步店铺商品（从 Ozon 拉取并 upsert 到本地，可能较慢） */
  function syncOnlineProducts(data = {}) {
    return request('/api/online-products/sync', {
      method: 'POST',
      body: JSON.stringify(data),
      timeout: 180000, // 同步可能涉及大量商品，给 3 分钟
    });
  }

  /** 同步单个在线商品（从 Ozon 拉取最新信息） */
  function syncOnlineProduct(id) {
    return request(`/api/online-products/${id}/sync`, {
      method: 'POST',
      timeout: 30000,
    });
  }

  function syncOnlineProductContentScores() {
    return request('/api/online-products/sync-content-scores', {
      method: 'POST', timeout: 180000,
    });
  }

  /** 更新在线商品本地字段（不推送 Ozon） */
  function updateOnlineProduct(id, data) {
    return request(`/api/online-products/${id}`, {
      method: 'PUT',
      body: JSON.stringify(data),
    });
  }

  /** 更新在线商品价格并推送到 Ozon（双向同步） */
  function updateOnlineProductPrice(id, data) {
    return request(`/api/online-products/${id}/price`, {
      method: 'PUT',
      body: JSON.stringify(data),
      timeout: 30000,
    });
  }

  /** 更新在线商品库存并推送到 Ozon（双向同步） */
  function updateOnlineProductStock(id, data) {
    return request(`/api/online-products/${id}/stock`, {
      method: 'PUT',
      body: JSON.stringify(data),
      timeout: 30000,
    });
  }

  /** 批量更新在线商品（仅本地字段） */
  function batchUpdateOnlineProducts(ids, updates) {
    return request('/api/online-products/batch/update', {
      method: 'POST',
      body: JSON.stringify({ ids, updates }),
    });
  }

  /** 批量删除在线商品（仅本地，不影响 Ozon 店铺） */
  function batchDeleteOnlineProducts(ids) {
    return request('/api/online-products/batch/delete', {
      method: 'POST',
      body: JSON.stringify({ ids }),
    });
  }

  /** 删除单个在线商品（仅本地） */
  function deleteOnlineProduct(id) {
    return request(`/api/online-products/${id}`, { method: 'DELETE' });
  }

  function getGallery(params = {}) {
    const qs = new URLSearchParams(params).toString();
    return request(`/api/gallery${qs ? '?' + qs : ''}`);
  }

  async function uploadGallery(files, tags = '') {
    const form = new FormData();
    Array.from(files || []).forEach(file => form.append('files', file));
    form.append('tags', tags);
    try {
      const response = await fetch(`${BASE_URL}/api/gallery/upload`, { method: 'POST', body: form });
      return await response.json();
    } catch (error) {
      return { code: -1, msg: error.message, data: null };
    }
  }

  function updateGalleryAsset(id, data) {
    return request(`/api/gallery/${id}`, { method: 'PUT', body: JSON.stringify(data) });
  }

  function deleteGalleryAsset(id) {
    return request(`/api/gallery/${id}`, { method: 'DELETE' });
  }

  function generateAIImages(data) {
    return request('/api/ai/images/generate', {
      method: 'POST', body: JSON.stringify(data), timeout: 240000,
    });
  }

  // 公开接口
  return {
    BASE_URL,
    getProducts,
    uploadImage,
    transferImages,
    getProductStats,
    getProduct,
    collectProduct,
    updateProduct,
    deleteProduct,
    batchDeleteProducts,
    batchUpdateProducts,
    submitPublish,
    getPublishStatus,
    retryPublishTask,
    getPublishRecords,
    getPublishRecordStats,
    createPublishRecord,
    batchCreatePublishRecords,
    getPublishRecord,
    updatePublishRecord,
    deletePublishRecord,
    submitPublishRecord,
    refreshPublishRecord,
    batchDeletePublishRecords,
    batchSubmitPublishRecords,
    aiGenerate,
    getAIModels,
    getAIModelsStatus,
    updateAIModel,
    setActiveAIModel,
    deleteAIModel,
    testAIModelConnection,
    getNotices,
    getDashboardStats,
    login,
    getUserInfo,
    getStores,
    createStore,
    updateStore,
    deleteStore,
    batchSetGroup,
    batchSetCurrency,
    batchDeleteStores,
    refreshStoreAuth,
    getStoreGroups,
    getCategories,
    matchCategory,
    aiMatchCategory,
    getCategoryAttributes,
    getAttributeValues,
    searchAttributeValues,
    batchGetAttributeValues,
    getCategorySyncStatus,
    triggerCategorySync,
    runCategorySync,
    getCategorySyncHistory,
    searchCategories,
    getAttrSyncStatus,
    triggerAttrSync,
    syncSingleCategoryAttrs,
    calculateProfit,
    calculatePrice,
    getPricingConfig,
    updatePricingConfig,
    getCategoryCommission,
    getPricingHistory,
    getOnlineProducts,
    getOnlineProductStats,
    getOnlineProduct,
    getOnlineProductEditData,
    saveOnlineProductEditData,
    syncOnlineProducts,
    syncOnlineProduct,
    syncOnlineProductContentScores,
    updateOnlineProduct,
    updateOnlineProductPrice,
    updateOnlineProductStock,
    batchUpdateOnlineProducts,
    batchDeleteOnlineProducts,
    deleteOnlineProduct,
    getGallery,
    uploadGallery,
    updateGalleryAsset,
    deleteGalleryAsset,
    generateAIImages,
    request,
  };
})();
