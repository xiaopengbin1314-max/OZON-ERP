/**
 * GeekOzon 扩展 - DOM 工具
 * 选择器、Shadow DOM 创建、URL 解析、SPA 路由监听
 */
;(function () {
  'use strict';

  const G = window.GeekOzon;
  if (!G || G.isLoaded('dom-utils')) return;

  const DomUtils = {
    /**
     * 创建 Shadow DOM 宿主
     * @param {string} id - 宿主元素 ID
     * @param {string} styles - CSS 文本
     * @param {object} opts - { position, top, right, zIndex }
     * @returns {{host: HTMLElement, shadow: ShadowRoot}} - 宿主与影子根
     */
    createShadowHost: function (id, styles, opts) {
      opts = opts || {};
      // 已存在则先移除
      const old = document.getElementById(id);
      if (old) old.remove();

      const host = document.createElement('div');
      host.id = id;
      if (opts.position === 'fixed' || opts.position === 'absolute') {
        host.style.position = opts.position;
        if (opts.top != null) host.style.top = opts.top + 'px';
        if (opts.right != null) host.style.right = opts.right + 'px';
        if (opts.left != null) host.style.left = opts.left + 'px';
        if (opts.bottom != null) host.style.bottom = opts.bottom + 'px';
      }
      if (opts.zIndex != null) host.style.zIndex = opts.zIndex;
      (document.body || document.documentElement).appendChild(host);

      const shadow = host.attachShadow({ mode: 'open' });
      if (styles) {
        const styleEl = document.createElement('style');
        styleEl.textContent = styles;
        shadow.appendChild(styleEl);
      }
      return { host: host, shadow: shadow };
    },

    /** 移除 Shadow DOM 宿主 */
    removeShadowHost: function (id) {
      const el = document.getElementById(id);
      if (el) el.remove();
    },

    /**
     * 等待元素出现（MutationObserver + 超时）
     * @param {string} selector
     * @param {number} timeout - 毫秒，默认 10 秒
     * @returns {Promise<HTMLElement|null>}
     */
    waitForElement: function (selector, timeout) {
      timeout = timeout || 10000;
      return new Promise(function (resolve) {
        const existing = document.querySelector(selector);
        if (existing) return resolve(existing);

        const observer = new MutationObserver(function () {
          const el = document.querySelector(selector);
          if (el) {
            observer.disconnect();
            resolve(el);
          }
        });
        observer.observe(document.documentElement, { childList: true, subtree: true });

        setTimeout(function () {
          observer.disconnect();
          resolve(null);
        }, timeout);
      });
    },

    /** 从 URL 提取 Ozon SKU（/product/xxx） */
    getOzonSkuFromUrl: function (url) {
      const u = url || window.location.pathname;
      const m = u.match(/\/product\/([^/?#]+)/i);
      return m ? m[1] : '';
    },

    /** 判断当前是否 Ozon 商品详情页 */
    isOzonProductPage: function () {
      return /\/product\//i.test(window.location.pathname);
    },

    /** 判断当前是否 Ozon 类目/搜索页 */
    isOzonListPage: function () {
      const p = window.location.pathname;
      return /\/(category|search|brand|seller)\//i.test(p);
    },

    /** 判断是否 seller.ozon.ru */
    isSellerOzon: function () {
      return /seller\.ozon\.ru/i.test(window.location.hostname);
    },

    /**
     * 监听 SPA 路由变化（history.pushState / replaceState / popstate）
     * @param {function} cb - 回调 (newUrl, oldUrl)
     * @returns {function} 取消监听函数
     */
    onUrlChange: function (cb) {
      const wrap = function (fn) {
        return function () {
          const old = location.href;
          const ret = fn.apply(this, arguments);
          const next = location.href;
          if (old !== next) {
            // 延迟回调，等 SPA 渲染
            setTimeout(function () { cb(next, old); }, 50);
          }
          return ret;
        };
      };
      const origPush = history.pushState;
      const origReplace = history.replaceState;
      history.pushState = wrap(origPush);
      history.replaceState = wrap(origReplace);
      const onPop = function () { cb(location.href, ''); };
      window.addEventListener('popstate', onPop);
      window.addEventListener('hashchange', onPop);

      return function () {
        history.pushState = origPush;
        history.replaceState = origReplace;
        window.removeEventListener('popstate', onPop);
        window.removeEventListener('hashchange', onPop);
      };
    },

    /**
     * 查找包含指定链接的最近商品卡片祖先
     * @param {HTMLAnchorElement} linkEl - 链接元素
     * @param {number} maxDepth - 最大向上查找层数
     */
    findCardAncestor: function (linkEl, maxDepth) {
      maxDepth = maxDepth || 6;
      let cur = linkEl;
      for (let i = 0; i < maxDepth && cur; i++) {
        cur = cur.parentElement;
        if (!cur) break;
        const dw = cur.getAttribute('data-widget') || '';
        if (/searchResults|tile|skuGrid|skuTile/i.test(dw)) return cur;
        if (cur.closest('[data-widget="searchResultsV2"]')) return cur;
      }
      // 兜底：链接父元素的父元素
      return linkEl.parentElement ? linkEl.parentElement.parentElement : null;
    },
  };

  G.core.DomUtils = DomUtils;
  G.markLoaded('dom-utils');
})();
