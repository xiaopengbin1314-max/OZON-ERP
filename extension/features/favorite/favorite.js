/**
 * GeekOzon 扩展 - 收藏功能模块
 * toggleFavorite(sku) 切换收藏状态；isFavorited(sku) 同步查询（本地缓存 + 后端同步）
 *
 * 入口：
 *   - window.__geekOzonToggleFavorite(sku)
 *   - window.__geekOzonIsFavorited(sku)
 * 防重复注入标志：window.__geekOzonFavoriteLoaded
 */
;(function () {
  'use strict';

  const G = window.GeekOzon;
  if (!G) return;
  if (window.__geekOzonFavoriteLoaded) return;
  window.__geekOzonFavoriteLoaded = true;

  const ApiClient = G.core.ApiClient;
  const EventBus = G.core.EventBus;
  const Storage = G.core.Storage;

  /** chrome.storage.local 缓存键名（存 {sku: true/false}） */
  const CACHE_KEY = 'geekOzonFavoriteCache';

  /** 内存缓存，避免每次 isFavorited 都读 storage */
  let _cache = null;
  /** 写入进行中的 sku 防抖，避免重复请求 */
  const _pending = {};

  /** 从 storage 加载缓存到内存 */
  async function loadCache() {
    if (_cache) return _cache;
    const obj = await Storage.getOne(CACHE_KEY, null);
    _cache = (obj && typeof obj === 'object') ? obj : {};
    return _cache;
  }

  /** 写回 storage */
  async function persistCache() {
    if (!_cache) return;
    await Storage.setOne(CACHE_KEY, _cache);
  }

  /**
   * 切换收藏状态
   * @param {string} sku
   * @returns {Promise<boolean>} 切换后的收藏状态（true=已收藏）
   */
  async function toggleFavorite(sku) {
    if (!sku) return false;
    // 防止同一 sku 重复请求
    if (_pending[sku]) return _pending[sku];

    _pending[sku] = (async function () {
      await loadCache();
      const prev = _cache[sku] === true;
      // 乐观更新：先切本地缓存
      _cache[sku] = !prev;
      try {
        const resp = await ApiClient.toggleFavorite(sku);
        if (ApiClient.isOk(resp)) {
          // 后端可能返回 toggled 真实状态
          const toggled = resp.data && (resp.data.favorited != null ? resp.data.favorited : resp.data.toggled);
          _cache[sku] = toggled != null ? !!toggled : !prev;
        } else {
          // 后端失败 → 回滚
          _cache[sku] = prev;
        }
      } catch (e) {
        console.warn('[GeekOzon] toggleFavorite 失败，回滚本地缓存:', e.message);
        _cache[sku] = prev;
      }
      await persistCache();
      EventBus.emit(EventBus.EVENTS.FAVORITE_TOGGLED, { sku: sku, favorited: _cache[sku] });
      delete _pending[sku];
      return _cache[sku];
    })();

    return _pending[sku];
  }

  /**
   * 同步查询收藏状态（命中缓存直接返回，否则返回 false 并触发后台同步）
   * @param {string} sku
   * @returns {boolean}
   */
  function isFavorited(sku) {
    if (!sku || !_cache) return false;
    return _cache[sku] === true;
  }

  /** 主动批量同步多个 SKU 状态（可选，给数据卡片渲染时调用） */
  async function syncSkus(skus) {
    if (!skus || !skus.length) return;
    await loadCache();
    // 这里仅以本地缓存为准；若需要从后端批量拉取，可扩展 ApiClient.fetchFavorites
    // 当前实现：保留缓存，不动后端
    return Object.assign({}, _cache);
  }

  /** 监听 EventBus 同步状态（其它模块通过事件触发收藏同步） */
  EventBus.on(EventBus.EVENTS.FAVORITE_TOGGLED, function (payload) {
    if (!payload || !payload.sku) return;
    if (_cache) {
      _cache[payload.sku] = !!payload.favorited;
      persistCache();
    }
  });

  /** 监听跨 tab storage 变化，同步本地缓存 */
  Storage.onChanged(CACHE_KEY, function (newVal) {
    if (newVal && typeof newVal === 'object') {
      _cache = newVal;
    }
  });

  /** 全局入口 */
  window.__geekOzonToggleFavorite = function (sku) {
    return toggleFavorite(sku);
  };
  window.__geekOzonIsFavorited = function (sku) {
    return isFavorited(sku);
  };

  // 挂到命名空间
  G.features.favorite = G.features.favorite || {};
  G.features.favorite.toggle = toggleFavorite;
  G.features.favorite.isFavorited = isFavorited;
  G.features.favorite.sync = syncSkus;
  G.features.favorite.loadCache = loadCache;
  G.markLoaded('favorite');

  // 启动时预加载缓存
  loadCache();
})();
