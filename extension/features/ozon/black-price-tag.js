/**
 * GeekOzon 扩展 - Ozon 商品页黑标价估算标签 + 跟卖列表 Popover
 *
 * 【对齐 maozi ERP v2.4.3 黑标价公式】
 *   - 有 cardPrice（绿标）：(price − cardPrice) × 2.25 + price
 *   - 无 cardPrice：price ÷ 1.0715
 *   - price ≤ 0 时返回 null
 *   数据来自 webPrice widget 的 price / cardPrice 字段（通过 ozon-scanner 或直接 fetch）
 *
 * 【副信息】
 *   保留"跟卖最低价 × 系数"作为副估算（黑价跟卖定价参考），显示在 popover 内
 *
 * 【UI 风格】
 *   黑底金边卡片 + 流光动画 + 公式说明 + "结果仅供参考，准确率≥90%" 提示
 *
 * 点击标签弹出 Popover 显示跟卖卖家列表
 *   字段：店铺名/价格/配送时效/评分
 *   排序：按价格升序，最低绿、最高红
 *
 * 锚点：[data-widget="webPrice"] 或 [data-widget="webProductHeading"] 或 h1
 * 跟卖数据：fetch /modal/otherOffersFromSellers?product_id={id}
 *
 * SPA 路由变化用 DomUtils.onUrlChange 监听
 * 防重复注入：window.__geekOzonBlackTagLoaded
 * 暴露：window.__geekOzonRefreshBlackTag()
 */
;(function () {
  'use strict';

  const G = window.GeekOzon;
  if (!G || G.isLoaded('black-price-tag')) return;

  const DomUtils = G.core.DomUtils;
  const ApiClient = G.core.ApiClient;
  const EventBus = G.core.EventBus;
  const Config = G.core.Config;
  const Tokens = G.components.DesignTokens;
  const EVENTS = EventBus.EVENTS;

  /** Shadow Host ID */
  const HOST_ID = 'geekozon-black-tag-host';
  /** Popover Host ID */
  const POPOVER_HOST_ID = 'geekozon-black-tag-popover-host';

  /** 默认黑标价系数（仅用于副估算：跟卖最低价 × 系数） */
  const DEFAULT_RATIO = 0.95;

  /** 锚点选择器（按优先级） */
  const ANCHOR_SELECTORS = [
    '[data-widget="webPrice"]',
    '[data-widget="webProductHeading"]',
    'h1',
  ];

  /** 缓存：避免重复 fetch */
  const offerCache = {};
  /** 缓存：商品 webPrice 数据（price + cardPrice） */
  const priceCache = {};

  /**
   * 解析 Ozon 价格文本为数字（对齐 maozi W 函数）
   * 处理 "1 299 ₽" / "1290.50 ₽" / "1 299,50 ₽" 等格式
   */
  function parsePrice(text) {
    if (text == null) return 0;
    if (typeof text === 'number') return text;
    const s = String(text).replace(/[^\d,.]/g, '');
    if (!s) return 0;
    return parseFloat(s.replace(',', '.')) || 0;
  }

  /**
   * 安全解析 widgetStates 中的 widget JSON
   */
  function parseWidget(json, keyPrefix) {
    if (!json || !json.widgetStates) return null;
    const key = Object.keys(json.widgetStates).find(function (k) {
      return k.indexOf(keyPrefix) === 0;
    });
    if (!key) return null;
    const raw = json.widgetStates[key];
    try { return typeof raw === 'string' ? JSON.parse(raw) : raw; }
    catch (_) { return null; }
  }

  /**
   * 黑标价标签组件
   */
  class BlackPriceTag {
    constructor() {
      this.host = null;
      this.shadow = null;
      this.mounted = false;
      // 主黑标价（maozi 公式：基于商品自身 price + cardPrice）
      this.lastBlackPrice = null;
      this.lastFormula = '';        // 当前使用的公式文本
      // 副估算（跟卖最低价 × 系数）
      this.lastFollowEstimate = null;
      this.lastOffers = [];
      this.lastRatio = DEFAULT_RATIO;
      this.lastProductId = '';
      this.lastSku = '';
      this.popoverOpen = false;
    }

    // ===== 样式（黑底金边 + 流光动画，对齐 maozi） =====
    getStyles() {
      return `
        :host { all: initial; }
        * { margin: 0; padding: 0; box-sizing: border-box; }

        @keyframes goShine {
          0% { left: -80%; }
          100% { left: 130%; }
        }

        .black-tag {
          display: inline-flex; align-items: center; gap: 6px;
          background: linear-gradient(135deg, #1e1b0e 0%, #0d0d0d 40%, #141008 70%, #1a1510 100%);
          background-color: #111;
          color: #ffd700;
          padding: 6px 12px;
          border-radius: ${Tokens.radius.base};
          font-family: ${Tokens.font.family};
          font-size: ${Tokens.font.sizeMd};
          font-weight: ${Tokens.font.weightBold};
          cursor: pointer;
          position: relative; overflow: hidden;
          border: 1px solid rgba(255,215,0,0.25);
          box-shadow: inset 0 1px 0 rgba(255,215,0,0.1), 0 2px 8px rgba(0,0,0,0.4);
          transition: transform ${Tokens.animation.durationFast} ${Tokens.animation.easing};
          vertical-align: middle;
          margin-left: 10px;
        }
        .black-tag:hover { transform: translateY(-2px); }
        .black-tag-label { font-size: ${Tokens.font.sizeXs}; opacity: 0.85; }
        .black-tag-price { font-size: ${Tokens.font.sizeLg}; }
        .black-tag-formula {
          font-size: 10px;
          color: rgba(255,215,0,0.6);
          margin-left: 4px;
          cursor: help;
        }
        .black-tag-shine {
          position: absolute; top: 0; left: -80%;
          width: 60%; height: 100%;
          background: linear-gradient(105deg, transparent 0%, rgba(255,215,0,0.08) 30%, rgba(255,255,255,0.35) 50%, rgba(255,215,0,0.08) 70%, transparent 100%);
          animation: goShine 2.5s ease-in-out infinite;
          pointer-events: none;
        }

        /* Popover */
        .popover {
          position: fixed;
          background: ${Tokens.color.bgBase};
          border-radius: ${Tokens.radius.lg};
          box-shadow: ${Tokens.shadow.modal};
          font-family: ${Tokens.font.family};
          font-size: ${Tokens.font.sizeBase};
          color: ${Tokens.color.textPrimary};
          width: 380px;
          max-height: 520px; overflow-y: auto;
          z-index: ${Tokens.z.popover};
          animation: goZoomIn 0.18s ${Tokens.animation.easing};
        }
        .popover-header {
          padding: ${Tokens.space.md} ${Tokens.space.base};
          background: ${Tokens.color.accentRedSolid};
          color: ${Tokens.color.textInverse};
          font-weight: ${Tokens.font.weightBold};
          border-radius: ${Tokens.radius.lg} ${Tokens.radius.lg} 0 0;
          display: flex; justify-content: space-between; align-items: center;
        }
        .popover-close {
          background: transparent; border: none; color: ${Tokens.color.textInverse};
          cursor: pointer; font-size: 18px; font-weight: ${Tokens.font.weightBold};
        }
        .popover-sub {
          padding: ${Tokens.space.sm} ${Tokens.space.base};
          background: ${Tokens.color.bgSubtle};
          border-bottom: 1px solid ${Tokens.color.border};
          font-size: ${Tokens.font.sizeSm};
          color: ${Tokens.color.textSecondary};
        }
        .popover-sub strong { color: ${Tokens.color.warning}; }
        .offer-row {
          display: grid;
          grid-template-columns: 1.5fr 1fr 0.8fr 0.6fr;
          gap: 6px; padding: 8px ${Tokens.space.base};
          border-bottom: 1px solid ${Tokens.color.border};
          align-items: center;
        }
        .offer-row:last-child { border-bottom: none; }
        .offer-row.header {
          background: ${Tokens.color.bgMuted};
          font-weight: ${Tokens.font.weightSemi};
          font-size: ${Tokens.font.sizeSm};
          color: ${Tokens.color.textSecondary};
          position: sticky; top: 0; z-index: 1;
        }
        .offer-shop { font-weight: ${Tokens.font.weightMedium}; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
        .offer-price { font-weight: ${Tokens.font.weightBold}; }
        .offer-min { color: ${Tokens.color.success}; }
        .offer-max { color: ${Tokens.color.danger}; }
        .offer-empty { padding: ${Tokens.space.xl}; text-align: center; color: ${Tokens.color.textMuted}; }
      `;
    }

    // ===== 找注入锚点 =====
    findAnchor() {
      for (let i = 0; i < ANCHOR_SELECTORS.length; i++) {
        const el = document.querySelector(ANCHOR_SELECTORS[i]);
        if (el) return el;
      }
      return null;
    }

    // ===== 从 URL 提取 productId =====
    getProductId() {
      const sku = DomUtils.getOzonSkuFromUrl();
      if (!sku) return '';
      const m = String(sku).match(/(\d+)$/);
      return m ? m[1] : '';
    }

    // ===== 读取黑标价系数（仅用于副估算） =====
    async readRatio() {
      try {
        const s = await Config.getSettings();
        const r = Number(s.blackPriceRatio);
        return (!isNaN(r) && r > 0 && r < 2) ? r : DEFAULT_RATIO;
      } catch (_) {
        return DEFAULT_RATIO;
      }
    }

    /**
     * 拉取商品 webPrice widget 数据（price + cardPrice）
     * 对齐 maozi ERP oe() 函数：从 /product/{sku}/ 接口解析 webPrice widget
     * @param {string} sku
     * @returns {Promise<{price:number, cardPrice:number, originalPrice:number}|null>}
     */
    async fetchProductPrice(sku) {
      if (!sku) return null;
      if (priceCache[sku]) return priceCache[sku];
      const url = location.origin +
        '/api/entrypoint-api.bx/page/json/v2?url=' +
        encodeURIComponent('/product/' + sku + '/');
      const ctrl = new AbortController();
      const timer = setTimeout(function () { ctrl.abort(); }, 8000);
      try {
        const resp = await fetch(url, {
          method: 'GET',
          credentials: 'include',
          headers: { 'Accept': 'application/json' },
          signal: ctrl.signal,
        });
        clearTimeout(timer);
        const text = await resp.text();
        if (text.length > 5 * 1024 * 1024) {
          console.warn('[GeekOzon] fetchProductPrice 响应过大，跳过:', text.length);
          return null;
        }
        const json = JSON.parse(text);
        const priceWidget = parseWidget(json, 'webPrice-');
        if (!priceWidget) return null;
        const result = {
          price: parsePrice(priceWidget.price),
          cardPrice: parsePrice(priceWidget.cardPrice),
          originalPrice: parsePrice(priceWidget.originalPrice),
        };
        priceCache[sku] = result;
        return result;
      } catch (e) {
        console.warn('[GeekOzon] fetchProductPrice 失败:', e.message);
        return null;
      }
    }

    /**
     * 计算 maozi 黑标价公式
     * @param {number} price - 商品当前售价（"黑"）
     * @param {number} cardPrice - Ozon 卡价（"绿"）
     * @returns {{value:number, formula:string}|null}
     */
    calcMaoziBlackPrice(price, cardPrice) {
      if (!price || price <= 0) return null;
      if (cardPrice && cardPrice > 0) {
        // 有 cardPrice：(price − cardPrice) × 2.25 + price
        const v = +(((price - cardPrice) * 2.25 + price).toFixed(2));
        return { value: v, formula: '(黑 − 绿) × 2.25 + 黑' };
      }
      // 无 cardPrice：price ÷ 1.0715
      const v = +(price / 1.0715).toFixed(2);
      return { value: v, formula: '黑 ÷ 1.0715' };
    }

    // ===== 拉跟卖报价（带 8s 超时，避免永久挂起） =====
    async fetchOffers(productId) {
      if (!productId) return [];
      if (offerCache[productId]) return offerCache[productId];
      const url = '/api/entrypoint-api.bx/page/json/v2?url=/modal/otherOffersFromSellers%3Fproduct_id%3D' + encodeURIComponent(productId);
      try {
        const fullUrl = location.origin + url;
        // AbortController 8s 超时
        const ctrl = new AbortController();
        const timer = setTimeout(function () { ctrl.abort(); }, 8000);
        const resp = await fetch(fullUrl, {
          method: 'GET',
          credentials: 'include',
          headers: { 'Accept': 'application/json' },
          signal: ctrl.signal,
        });
        clearTimeout(timer);
        const text = await resp.text();
        // 限制 JSON.parse 大小（>5MB 跳过，防止主线程阻塞）
        if (text.length > 5 * 1024 * 1024) {
          console.warn('[GeekOzon] fetchOffers 响应过大，跳过:', text.length);
          return [];
        }
        const json = JSON.parse(text);
        const items = this.extractOfferItems(json);
        offerCache[productId] = items;
        return items;
      } catch (e) {
        console.warn('[GeekOzon] fetchOffers 失败:', e.message);
        return [];
      }
    }

    /** 从 modal 响应中提取跟卖列表 */
    extractOfferItems(json) {
      if (!json) return [];
      const states = json.widgetStates || json.widgets || {};
      const keys = Object.keys(states);
      for (let i = 0; i < keys.length; i++) {
        if (keys[i].indexOf('otherOffersFromSellers') !== -1 || keys[i].indexOf('otherOffers') !== -1) {
          try {
            const inner = typeof states[keys[i]] === 'string'
              ? JSON.parse(states[keys[i]])
              : states[keys[i]];
            const items = inner.items || inner.offers || inner;
            if (Array.isArray(items)) {
              return items.map(function (it) {
                return {
                  shopName: it.shopName || it.sellerName || it.merchantName || '-',
                  price: Number(it.price) || Number(it.priceValue) || Number(it.salePrice) || 0,
                  deliveryTime: it.deliveryTime || it.delivery || it.shippingDays || '-',
                  rating: it.rating || it.sellerRating || 0,
                };
              });
            }
          } catch (_) {}
        }
      }
      return [];
    }

    // ===== 渲染标签（黑底金边 + 流光动画 + 公式说明） =====
    renderTag() {
      const priceText = this.lastBlackPrice != null
        ? '₽' + Number(this.lastBlackPrice).toLocaleString('ru-RU')
        : '--';
      const formula = this.lastFormula || '';
      return `<span class="black-tag" id="goBlackTag" title="结果仅供参考，准确率≥90%">
        <span class="black-tag-label">黑标价：</span>
        <span class="black-tag-price">${G.utils.escapeHtml(priceText)}</span>
        ${formula ? '<span class="black-tag-formula">' + G.utils.escapeHtml(formula) + '</span>' : ''}
        <span class="black-tag-shine"></span>
      </span>`;
    }

    // ===== 渲染 Popover（含副估算信息） =====
    renderPopover() {
      const offers = this.lastOffers.slice().sort(function (a, b) {
        return (a.price || 0) - (b.price || 0);
      });

      // 副估算行：跟卖最低价 × 系数
      const followEstimateHtml = this.lastFollowEstimate != null
        ? `<div class="popover-sub">
            副估算（跟卖最低价 × ${this.lastRatio}）：<strong>₽${Number(this.lastFollowEstimate).toLocaleString('ru-RU')}</strong>
          </div>`
        : '';

      if (!offers.length) {
        return `${followEstimateHtml}<div class="offer-empty">暂无跟卖数据</div>`;
      }
      const minPrice = offers[0].price;
      const maxPrice = offers[offers.length - 1].price;

      const rows = offers.map(function (o) {
        const cls = o.price === minPrice ? 'offer-min'
          : (o.price === maxPrice ? 'offer-max' : '');
        return `<div class="offer-row">
          <span class="offer-shop">${G.utils.escapeHtml(o.shopName)}</span>
          <span class="offer-price ${cls}">₽${Number(o.price).toLocaleString('ru-RU')}</span>
          <span>${G.utils.escapeHtml(String(o.deliveryTime))}</span>
          <span>${o.rating ? G.components.Icon('star', 11) + ' ' + o.rating : '-'}</span>
        </div>`;
      }).join('');

      return `<div class="popover">
        <div class="popover-header">
          <span>跟卖卖家 (${offers.length})</span>
          <button class="popover-close" id="goPopoverClose">×</button>
        </div>
        ${followEstimateHtml}
        <div class="offer-row header">
          <span>店铺</span><span>价格</span><span>配送</span><span>评分</span>
        </div>
        ${rows}
      </div>`;
    }

    // ===== 挂载标签 =====
    mount() {
      if (this.mounted) return this;
      const anchor = this.findAnchor();
      if (!anchor) return this;

      // 移除旧 host
      DomUtils.removeShadowHost(HOST_ID);
      DomUtils.removeShadowHost(POPOVER_HOST_ID);

      // 创建标签 Shadow Host（插入到锚点后面，作为兄弟元素）
      const host = document.createElement('span');
      host.id = HOST_ID;
      host.style.display = 'inline-block';
      host.style.verticalAlign = 'middle';
      host.style.marginLeft = '8px';
      anchor.parentElement.insertBefore(host, anchor.nextSibling);

      const shadow = host.attachShadow({ mode: 'open' });
      const styleEl = document.createElement('style');
      styleEl.textContent = Tokens.baseStyles + '\n' + this.getStyles();
      shadow.appendChild(styleEl);

      const div = document.createElement('div');
      div.innerHTML = this.renderTag();
      shadow.appendChild(div);

      this.host = host;
      this.shadow = shadow;
      this.mounted = true;

      // 绑定点击事件
      const tag = shadow.querySelector('#goBlackTag');
      if (tag) {
        const self = this;
        tag.addEventListener('click', function () {
          self.togglePopover();
        });
      }
      return this;
    }

    // ===== 切换 Popover =====
    togglePopover() {
      if (this.popoverOpen) {
        this.closePopover();
      } else {
        this.openPopover();
      }
    }

    openPopover() {
      this.closePopover();
      const popoverHost = document.createElement('div');
      popoverHost.id = POPOVER_HOST_ID;
      popoverHost.style.position = 'fixed';
      popoverHost.style.top = '120px';
      popoverHost.style.right = '30px';
      popoverHost.style.zIndex = Tokens.z.popover;
      document.body.appendChild(popoverHost);

      const shadow = popoverHost.attachShadow({ mode: 'open' });
      const styleEl = document.createElement('style');
      styleEl.textContent = Tokens.baseStyles + '\n' + this.getStyles();
      shadow.appendChild(styleEl);
      const div = document.createElement('div');
      div.innerHTML = this.renderPopover();
      shadow.appendChild(div);

      const self = this;
      const closeBtn = shadow.querySelector('#goPopoverClose');
      if (closeBtn) {
        closeBtn.addEventListener('click', function () {
          self.closePopover();
        });
      }

      // 点击外部关闭
      const outsideClick = function (e) {
        if (!popoverHost.contains(e.target) && !self.host.contains(e.target)) {
          self.closePopover();
          document.removeEventListener('click', outsideClick, true);
        }
      };
      setTimeout(function () {
        document.addEventListener('click', outsideClick, true);
      }, 50);

      this.popoverHost = popoverHost;
      this.popoverShadow = shadow;
      this.popoverOpen = true;
    }

    closePopover() {
      DomUtils.removeShadowHost(POPOVER_HOST_ID);
      this.popoverHost = null;
      this.popoverShadow = null;
      this.popoverOpen = false;
    }

    // ===== 更新数据 =====
    async refresh() {
      const productId = this.getProductId();
      if (!productId) {
        this.unmount();
        return;
      }
      this.lastProductId = productId;
      this.lastSku = DomUtils.getOzonSkuFromUrl() || '';
      this.lastRatio = await this.readRatio();

      // 并行拉取：商品 webPrice 数据 + 跟卖报价
      const [priceData, offers] = await Promise.all([
        this.fetchProductPrice(this.lastSku),
        this.fetchOffers(productId),
      ]);
      this.lastOffers = offers;

      // 主黑标价：maozi 公式（基于商品自身 price + cardPrice）
      if (priceData && priceData.price > 0) {
        const r = this.calcMaoziBlackPrice(priceData.price, priceData.cardPrice);
        if (r) {
          this.lastBlackPrice = r.value;
          this.lastFormula = r.formula;
        } else {
          this.lastBlackPrice = null;
          this.lastFormula = '';
        }
      } else {
        this.lastBlackPrice = null;
        this.lastFormula = '';
      }

      // 副估算：跟卖最低价 × 系数（保留旧逻辑作为参考）
      const prices = offers.map(function (o) { return o.price; }).filter(Boolean);
      if (prices.length) {
        const min = Math.min.apply(null, prices);
        this.lastFollowEstimate = Math.round(min * this.lastRatio);
      } else {
        this.lastFollowEstimate = null;
      }

      // 重新挂载（DOM 可能因 SPA 重渲染）
      if (!this.mounted || !document.getElementById(HOST_ID)) {
        this.mounted = false;
        this.mount();
      } else {
        // 只更新标签内容
        const tag = this.shadow.querySelector('#goBlackTag');
        if (tag) {
          tag.outerHTML = this.renderTag();
          const newTag = this.shadow.querySelector('#goBlackTag');
          if (newTag) {
            const self = this;
            newTag.addEventListener('click', function () { self.togglePopover(); });
          }
        }
      }

      EventBus.emit(EVENTS.BLACK_TAG_REFRESH, {
        productId: productId,
        sku: this.lastSku,
        blackPrice: this.lastBlackPrice,
        formula: this.lastFormula,
        followEstimate: this.lastFollowEstimate,
        offers: this.lastOffers,
        priceData: priceData,
      });
    }

    unmount() {
      DomUtils.removeShadowHost(HOST_ID);
      this.closePopover();
      this.mounted = false;
    }
  }

  // ===== 单例 =====
  let instance = null;

  function init() {
    if (!DomUtils.isOzonProductPage()) return;
    if (window.__geekOzonBlackTagLoaded) {
      if (instance) instance.refresh();
      return;
    }
    window.__geekOzonBlackTagLoaded = true;

    instance = new BlackPriceTag();
    instance.mount();

    // 延迟刷新等页面渲染
    setTimeout(function () {
      instance.refresh();
    }, 800);

    // 监听 URL 变化
    DomUtils.onUrlChange(function () {
      if (DomUtils.isOzonProductPage()) {
        if (instance) {
          instance.unmount();
          instance = new BlackPriceTag();
          instance.mount();
          setTimeout(function () { instance.refresh(); }, 600);
        }
      } else {
        if (instance) {
          instance.unmount();
          window.__geekOzonBlackTagLoaded = false;
        }
      }
    });

    // 定时轮询：锚点丢失时重新挂载（替代 MutationObserver，避免循环触发）
    // MutationObserver 监听 documentElement 会捕获页面所有 DOM 变化（图片懒加载等），
    // 且 mount 本身又触发 DOM 变化 → 形成慢循环 → 页面卡死
    // 频率 5s（从 2s 降低，减少 main thread 唤醒）
    let pollTimer = setInterval(function () {
      if (!DomUtils.isOzonProductPage()) return;
      if (!instance || !instance.mounted || !document.getElementById(HOST_ID)) {
        if (instance) instance.unmount();
        instance = new BlackPriceTag();
        instance.mount();
        // refresh 延迟到空闲时执行，避免抢占主线程
        G.utils.idleRun(function () {
          if (instance) G.utils.safeRun(function () { instance.refresh(); }, null, 'black-tag.poll.refresh');
        }, 1000);
      }
    }, 5000);
    // 页面卸载时清理
    window.addEventListener('pagehide', function () {
      if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
    });

    // 监听 EventBus 刷新请求
    EventBus.on(EVENTS.BLACK_TAG_REFRESH, function () {
      if (instance) instance.refresh();
    });
  }

  /** 对外刷新入口 */
  window.__geekOzonRefreshBlackTag = function () {
    if (instance) return instance.refresh();
    init();
    return Promise.resolve();
  };

  /** 暴露 class */
  G.features.BlackPriceTag = BlackPriceTag;

  G.markLoaded('black-price-tag');
  console.log('[GeekOzon] black-price-tag 已加载');

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
