/**
 * GeekOzon 扩展 - Ozon 类目页/搜索页批量迷你卡片（MutationObserver 自愈）
 *
 * 【对齐 maozi ERP v2.4.3 列表页按钮组】
 *
 * 在商品列表每个商品卡片注入迷你数据卡片（180px 宽）
 * 内容：
 *   - SKU(点击复制)/月销售额/跟卖最低价/黑标价估算/退货率
 *   - 收藏按钮（独立心形）
 *   - 5 圆形操作按钮组：一键上架 / 编辑上架 / 计算利润 / 1688找同款 / 设置显示字段
 *
 * 数据加载流程：
 *   1. 先 batchGetSkuData 批量查缓存，命中直接展示
 *   2. 未命中走 CrossTab.fetchWhatToSell（并发限制 3，对齐 maozi 主接口）
 *
 * 收藏：POST /api/products/favorite/toggle
 * 缓存回写：POST /api/ozon/sku_data
 *
 * 防重复注入：
 *   - data-geekozon-injected 标记（每个商品卡片）
 *   - window.__geekOzonListCardsLoaded（全局）
 *
 * 性能：
 *   - debounce 200ms + requestIdleCallback
 *   - setInterval 监听新商品卡片自动注入（替代 MutationObserver）
 *   - URL 变化重新扫描（DomUtils.onUrlChange）
 *
 * 暴露：window.__geekOzonRefreshListCards()
 */
;(function () {
  'use strict';

  const G = window.GeekOzon;
  if (!G || G.isLoaded('list-cards')) return;

  const DomUtils = G.core.DomUtils;
  const ApiClient = G.core.ApiClient;
  const CrossTab = G.core.CrossTab;
  const EventBus = G.core.EventBus;
  const Config = G.core.Config;
  const Tokens = G.components.DesignTokens;
  const EVENTS = EventBus.EVENTS;

  /** 注入标记属性 */
  const INJECT_FLAG = 'data-geekozon-injected';

  /** 商品卡片选择器（主） */
  const PRIMARY_CONTAINER = '[data-widget="searchResultsV2"]';
  /** 商品链接选择器 */
  const PRODUCT_LINK = 'a[href*="/product/"]';

  /** 默认黑标价系数 */
  const DEFAULT_RATIO = 0.95;

  /** 默认迷你卡片宽度 */
  const CARD_WIDTH = 180;

  /** 内存级数据缓存（避免重复请求） */
  const dataCache = {};

  /** 已采集 SKU 集合（避免重复提交） */
  const collectedSkus = new Set();

  /**
   * 列表迷你卡片管理器
   */
  class ListCardsManager {
    constructor() {
      this.pollTimer = null;
      this.urlUnsub = null;
      this.scanScheduled = false;
      this.scanning = false; // 防重入锁
      this.activeSalesTasks = 0;
      this.lastRatio = DEFAULT_RATIO;
    }

    // ===== 内联样式（注入到每个迷你卡片） =====
    getCardStyles() {
      return `
        .go-mini-card {
          width: ${CARD_WIDTH}px;
          background: ${Tokens.color.bgBase};
          border-radius: ${Tokens.radius.base};
          box-shadow: ${Tokens.shadow.card};
          font-family: ${Tokens.font.family};
          font-size: ${Tokens.font.sizeXs};
          color: ${Tokens.color.textPrimary};
          padding: 6px 8px;
          margin: 4px auto;
          border: 1px solid ${Tokens.color.border};
        }
        .go-mini-row {
          display: flex; justify-content: space-between; align-items: center;
          padding: 2px 0;
        }
        .go-mini-label { color: ${Tokens.color.textSecondary}; }
        .go-mini-value { font-weight: ${Tokens.font.weightMedium}; }
        .go-mini-value.success { color: ${Tokens.color.success}; font-weight: ${Tokens.font.weightBold}; }
        .go-mini-value.warn { color: ${Tokens.color.warning}; }
        .go-mini-value.danger { color: ${Tokens.color.danger}; }
        .go-mini-sku {
          cursor: pointer;
          color: ${Tokens.color.info};
          text-decoration: underline dotted;
          font-size: ${Tokens.font.sizeXs};
          overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
          max-width: 120px;
        }
        /* 收藏按钮（独立心形） */
        .go-mini-fav-row {
          display: flex; justify-content: flex-end; margin-top: 4px;
        }
        .go-mini-fav-btn {
          background: transparent; border: none;
          cursor: pointer;
          padding: 2px 4px;
          color: ${Tokens.color.textMuted};
          font-family: inherit;
          transition: all ${Tokens.animation.durationFast} ${Tokens.animation.easing};
        }
        .go-mini-fav-btn:hover { color: ${Tokens.color.accentRedSolid}; transform: scale(1.15); }
        .go-mini-fav-btn.fav-active { color: ${Tokens.color.accentRedSolid}; }
        .go-mini-fav-btn.fav-active svg { fill: currentColor; }

        /* 5 圆形操作按钮组（对齐 maozi CategoryWidget） */
        .go-mini-actions {
          display: flex; justify-content: space-between; align-items: center; gap: 2px;
          margin-top: 4px;
          border-top: 1px dashed ${Tokens.color.border}; padding-top: 4px;
        }
        .go-mini-circle-btn {
          width: 24px; height: 24px;
          border-radius: 50%;
          background: ${Tokens.color.bgBase};
          border: 1px solid ${Tokens.color.borderStrong};
          cursor: pointer;
          color: ${Tokens.color.textPrimary};
          display: inline-flex; align-items: center; justify-content: center;
          padding: 0;
          transition: all ${Tokens.animation.durationFast} ${Tokens.animation.easing};
          font-family: inherit;
        }
        .go-mini-circle-btn:hover {
          background: ${Tokens.color.primary};
          color: ${Tokens.color.textInverse};
          border-color: ${Tokens.color.primary};
          transform: scale(1.1);
        }
        .go-mini-circle-btn svg { display: block; }

        /* 旧版矩形按钮样式（保留兜底） */
        .go-mini-btn {
          background: transparent; border: 1px solid ${Tokens.color.borderStrong};
          border-radius: ${Tokens.radius.sm};
          padding: 2px 6px;
          font-size: ${Tokens.font.sizeXs};
          cursor: pointer;
          color: ${Tokens.color.textPrimary};
          font-family: inherit;
          transition: all ${Tokens.animation.durationFast} ${Tokens.animation.easing};
        }
        .go-mini-btn:hover {
          background: ${Tokens.color.primary};
          color: ${Tokens.color.textInverse};
          border-color: ${Tokens.color.primary};
        }
        .go-mini-btn.fav-active {
          background: ${Tokens.color.accentRedSolid};
          color: ${Tokens.color.textInverse};
          border-color: ${Tokens.color.accentRedSolid};
        }
        .go-mini-loading {
          text-align: center; padding: 4px;
          color: ${Tokens.color.textMuted};
        }
        .go-mini-btn svg { vertical-align: middle; display: inline-block; }
        .go-mini-btn.fav-active svg { fill: currentColor; }
        @keyframes goMiniSpin { to { transform: rotate(360deg); } }
        .go-mini-spin { animation: goMiniSpin 0.8s linear infinite; display: inline-block; }
      `;
    }

    /** 注入全局样式（仅一次） */
    injectGlobalStyles() {
      if (document.getElementById('geekozon-list-cards-style')) return;
      const style = document.createElement('style');
      style.id = 'geekozon-list-cards-style';
      style.textContent = this.getCardStyles();
      document.head.appendChild(style);
    }

    /** 找到所有商品卡片 */
    findProductCards() {
      // 主容器内的商品链接
      const primaryContainer = document.querySelector(PRIMARY_CONTAINER);
      let links = [];
      if (primaryContainer) {
        links = Array.prototype.slice.call(primaryContainer.querySelectorAll(PRODUCT_LINK));
      }
      // 兜底：全页扫描
      if (!links.length) {
        links = Array.prototype.slice.call(document.querySelectorAll(PRODUCT_LINK));
      }
      // 去重（按 href）+ 找卡片祖先
      const seen = Object.create(null);
      const cards = [];
      for (let i = 0; i < links.length; i++) {
        const link = links[i];
        const href = link.href || link.getAttribute('href') || '';
        if (seen[href]) continue;
        seen[href] = 1;
        const card = DomUtils.findCardAncestor(link, 6);
        if (card && !card.hasAttribute(INJECT_FLAG)) {
          cards.push({ link: link, card: card, href: href });
        }
      }
      return cards;
    }

    /** 从 href 提取 SKU */
    getSkuFromHref(href) {
      const m = String(href || '').match(/\/product\/([^/?#]+)/i);
      return m ? m[1] : '';
    }

    /** 从 SKU 提取 productId（数字部分） */
    getProductIdFromSku(sku) {
      const m = String(sku).match(/(\d+)$/);
      return m ? m[1] : '';
    }

    /** 扫描并注入所有未注入的卡片 */
    async scanAndInject() {
      if (this.scanScheduled) return;
      this.scanScheduled = true;

      // 用 idleRun + debounce 让出主线程
      await new Promise(function (r) { G.utils.idleRun(r, 500); });
      this.scanScheduled = false;

      // 读取黑标价系数（一次即可）
      if (!this.ratioLoaded) {
        this.lastRatio = await this.readRatio();
        this.ratioLoaded = true;
      }

      const cards = this.findProductCards();
      if (!cards.length) return;

      // 1. 先收集所有 SKU
      const skuList = cards.map(function (c) { return c.sku; });
      cards.forEach(function (c) { c.sku = this.getSkuFromHref(c.href); }, this);
      const skus = cards.map(function (c) { return c.sku; }).filter(Boolean);

      // 2. 批量查缓存
      let cachedMap = {};
      if (skus.length) {
        const resp = await ApiClient.batchGetSkuData(skus);
        const items = (ApiClient.data(resp, {}) || {}).items || [];
        items.forEach(function (it) {
          cachedMap[it.sku] = it;
        });
      }

      // 3. 注入卡片 + 异步加载未命中的数据
      const pendingSkus = [];
      for (let i = 0; i < cards.length; i++) {
        const c = cards[i];
        c.card.setAttribute(INJECT_FLAG, '1');
        const cached = cachedMap[c.sku];
        if (cached && cached.data) {
          // 命中缓存：直接渲染
          this.renderMiniCard(c.card, c.sku, cached.data);
        } else {
          // 未命中：先渲染骨架，再异步加载
          this.renderMiniCardLoading(c.card, c.sku);
          pendingSkus.push({ card: c.card, sku: c.sku });
        }
      }

      // 4. 异步加载未命中的数据（并发限制 3）
      this.loadSalesWithConcurrency(pendingSkus);
    }

    /** 读取黑标价系数 */
    async readRatio() {
      try {
        const s = await Config.getSettings();
        const r = Number(s.blackPriceRatio);
        return (!isNaN(r) && r > 0 && r < 2) ? r : DEFAULT_RATIO;
      } catch (_) {
        return DEFAULT_RATIO;
      }
    }

    /** 并发限制的销量数据加载 */
    async loadSalesWithConcurrency(pendingSkus) {
      const queue = pendingSkus.slice();
      const self = this;
      const maxConcurrency = 3;

      async function worker() {
        while (queue.length) {
          const item = queue.shift();
          if (!item) break;
          self.activeSalesTasks++;
          try {
            await self.loadOne(item.card, item.sku);
          } catch (e) {
            console.warn('[GeekOzon] loadSales 异常:', item.sku, e.message);
          } finally {
            self.activeSalesTasks--;
          }
        }
      }

      const workers = [];
      for (let i = 0; i < maxConcurrency; i++) {
        workers.push(worker());
      }
      await Promise.all(workers);
    }

    /** 加载单个商品的数据 */
    async loadOne(card, sku) {
      // 命中内存缓存
      if (dataCache[sku]) {
        this.renderMiniCard(card, sku, dataCache[sku]);
        return;
      }

      // 跨 tab 拉 sales
      const salesResp = await CrossTab.fetchSales(sku);
      let sales = null;
      if (salesResp && salesResp.success && salesResp.data) {
        sales = this.aggregateSalesData(salesResp.data);
      }

      // 跟卖报价（fetch /modal/otherOffersFromSellers）
      const productId = this.getProductIdFromSku(sku);
      let offers = [];
      if (productId) {
        offers = await this.fetchSellerOffers(productId);
      }

      // 计算黑标价
      const prices = offers.map(function (o) { return o.price; }).filter(Boolean);
      const minOffer = prices.length ? Math.min.apply(null, prices) : null;
      const blackPrice = minOffer ? Math.round(minOffer * this.lastRatio) : null;

      const data = {
        sku: sku,
        sales: sales,
        offers: offers,
        minOffer: minOffer,
        blackPrice: blackPrice,
        favorited: false,
        loadedAt: Date.now(),
      };

      // 写内存缓存
      dataCache[sku] = data;

      // 写后端缓存
      ApiClient.upsertSkuData(sku, '', {
        minOffer: minOffer,
        blackPrice: blackPrice,
        sales: sales,
        offers: offers,
        updatedAt: Date.now(),
      }).catch(function () {});

      // 渲染
      this.renderMiniCard(card, sku, data);
    }

    /** 拉跟卖报价 */
    async fetchSellerOffers(productId) {
      if (!productId) return [];
      const url = '/api/entrypoint-api.bx/page/json/v2?url=/modal/otherOffersFromSellers%3Fproduct_id%3D' + encodeURIComponent(productId);
      try {
        const fullUrl = location.origin + url;
        const resp = await fetch(fullUrl, {
          method: 'GET',
          credentials: 'include',
          headers: { 'Accept': 'application/json' },
        });
        const json = await resp.json();
        return this.extractOfferItems(json);
      } catch (e) {
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

    /** 从 sales API 返回中聚合 8 字段 */
    aggregateSalesData(resp) {
      let items = [];
      if (Array.isArray(resp)) items = resp;
      else if (resp && Array.isArray(resp.items)) items = resp.items;
      else if (resp && resp.result && Array.isArray(resp.result.items)) items = resp.result.items;
      else if (resp && resp.result && Array.isArray(resp.result)) items = resp.result;
      if (!items.length) items = [resp];
      const item = items[0] || {};
      const soldSum = item.sum_gmv != null ? item.sum_gmv
        : (item.sold_sum != null ? item.sold_sum
          : (item.sales_sum != null ? item.sales_sum : null));
      let dimensions = '';
      if (item.dimensions) {
        const d = item.dimensions;
        dimensions = (d.length || d.l || '') + '×' + (d.width || d.w || '') + '×' + (d.height || d.h || '');
      }
      return {
        soldSum: soldSum,
        brand: item.brand || item.brand_name || '',
        category: item.category_name || item.category || '',
        clickRate: item.click_rate != null ? item.click_rate : (item.ctr != null ? item.ctr : null),
        createDate: item.created_at || item.create_date || item.creation_date || '',
        redemptionRate: item.redemption_rate != null ? item.redemption_rate : (item.return_rate != null ? item.return_rate : null),
        dimensions: dimensions || item.dimensions_string || '',
        weight: item.weight != null ? item.weight : (item.weight_g != null ? item.weight_g : ''),
      };
    }

    /** 渲染迷你卡片骨架（loading） */
    renderMiniCardLoading(card, sku) {
      const el = this.findOrCreateSlot(card, sku);
      el.innerHTML = '<div class="go-mini-loading"><svg class="go-mini-spin" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" style="vertical-align:middle;margin-right:3px;"><path d="M21 12a9 9 0 1 1-6.219-8.56"/></svg>加载中...</div>';
    }

    /** 找或创建插入点 */
    findOrCreateSlot(card, sku) {
      let slot = card.querySelector('.geekozon-mini-slot');
      if (!slot) {
        slot = document.createElement('div');
        slot.className = 'geekozon-mini-slot';
        slot.setAttribute('data-sku', sku);
        card.appendChild(slot);
      }
      return slot;
    }

    /** 渲染迷你卡片（对齐 maozi 5 圆形按钮组 + 独立收藏心形） */
    renderMiniCard(card, sku, data) {
      const slot = this.findOrCreateSlot(card, sku);
      const sales = data.sales || {};
      const rub = function (n) {
        if (n == null) return '-';
        return '₽' + Number(n).toLocaleString('ru-RU');
      };

      const favIcon = G.components.Icon('heart', 13);
      const favClass = data.favorited ? 'go-mini-fav-btn fav-active' : 'go-mini-fav-btn';

      const html = `
        <div class="go-mini-card">
          <div class="go-mini-row">
            <span class="go-mini-label">SKU</span>
            <span class="go-mini-sku" title="点击复制" data-action="copy">${G.utils.escapeHtml(sku)}</span>
          </div>
          <div class="go-mini-row">
            <span class="go-mini-label">月销售</span>
            <span class="go-mini-value success">${G.utils.escapeHtml(rub(sales.soldSum))}</span>
          </div>
          <div class="go-mini-row">
            <span class="go-mini-label">跟卖最低</span>
            <span class="go-mini-value">${G.utils.escapeHtml(rub(data.minOffer))}</span>
          </div>
          <div class="go-mini-row">
            <span class="go-mini-label">黑标估价</span>
            <span class="go-mini-value warn">${G.utils.escapeHtml(rub(data.blackPrice))}</span>
          </div>
          <div class="go-mini-row">
            <span class="go-mini-label">退货率</span>
            <span class="go-mini-value ${sales.nullableRedemptionRate != null && Number(sales.nullableRedemptionRate) > 10 ? 'danger' : ''}">${sales.nullableRedemptionRate != null ? (sales.nullableRedemptionRate + '%') : (sales.redemptionRate != null ? (sales.redemptionRate + '%') : '-')}</span>
          </div>
          <div class="go-mini-fav-row">
            <button class="${favClass}" data-action="fav" title="${data.favorited ? '取消收藏' : '收藏'}">${favIcon}</button>
          </div>
          <div class="go-mini-actions">
            <button class="go-mini-circle-btn" data-action="publish" title="一键上架">${G.components.Icon('send', 12)}</button>
            <button class="go-mini-circle-btn" data-action="editPublish" title="编辑上架">${G.components.Icon('edit', 12)}</button>
            <button class="go-mini-circle-btn" data-action="profit" title="计算利润">${G.components.Icon('calculator', 12)}</button>
            <button class="go-mini-circle-btn" data-action="findSource" title="1688找同款">${G.components.Icon('search', 12)}</button>
            <button class="go-mini-circle-btn" data-action="fieldSettings" title="设置显示字段">${G.components.Icon('settings', 12)}</button>
          </div>
        </div>
      `;
      slot.innerHTML = html;

      // 绑定事件
      const self = this;
      const copyEl = slot.querySelector('[data-action="copy"]');
      if (copyEl) {
        copyEl.addEventListener('click', function (e) {
          e.preventDefault();
          e.stopPropagation();
          G.utils.copyToClipboard(sku);
          copyEl.style.color = Tokens.color.success;
          setTimeout(function () { copyEl.style.color = ''; }, 1000);
        });
      }
      const favBtn = slot.querySelector('[data-action="fav"]');
      if (favBtn) {
        favBtn.addEventListener('click', function (e) {
          e.preventDefault();
          e.stopPropagation();
          self.toggleFav(sku, favBtn);
        });
      }
      // 一键上架
      const publishBtn = slot.querySelector('[data-action="publish"]');
      if (publishBtn) {
        publishBtn.addEventListener('click', function (e) {
          e.preventDefault();
          e.stopPropagation();
          self.triggerPublish(sku, publishBtn);
        });
      }
      // 编辑上架
      const editBtn = slot.querySelector('[data-action="editPublish"]');
      if (editBtn) {
        editBtn.addEventListener('click', function (e) {
          e.preventDefault();
          e.stopPropagation();
          self.triggerEditPublish(sku, editBtn);
        });
      }
      // 计算利润
      const profitBtn = slot.querySelector('[data-action="profit"]');
      if (profitBtn) {
        profitBtn.addEventListener('click', function (e) {
          e.preventDefault();
          e.stopPropagation();
          self.triggerProfit(sku, profitBtn);
        });
      }
      // 1688找同款
      const findBtn = slot.querySelector('[data-action="findSource"]');
      if (findBtn) {
        findBtn.addEventListener('click', function (e) {
          e.preventDefault();
          e.stopPropagation();
          self.triggerFindSource(sku, findBtn);
        });
      }
      // 设置显示字段
      const settingsBtn = slot.querySelector('[data-action="fieldSettings"]');
      if (settingsBtn) {
        settingsBtn.addEventListener('click', function (e) {
          e.preventDefault();
          e.stopPropagation();
          self.triggerFieldSettings();
        });
      }
    }

    /** 一键上架（打开上架弹窗，对齐 maozi followProductFromList） */
    async triggerPublish(sku, btn) {
      // 加载商品数据
      const productInfo = await this.loadProductInfo(sku);
      if (typeof window.__geekOzonOpenPublishModal === 'function') {
        window.__geekOzonOpenPublishModal(productInfo);
      } else {
        console.warn('[GeekOzon] __geekOzonOpenPublishModal 未注入');
      }
    }

    /**
     * 编辑上架（采集商品 + 打开上架弹窗，对齐 maozi editFollowProductFromList）
     * 注：maozi 调 /api.selection.follow/edit 跳转 AI 编辑页，GeekOzon 后端暂无对应接口，
     *     此处简化为采集后打开上架弹窗（让用户在弹窗内编辑）
     */
    async triggerEditPublish(sku, btn) {
      const original = btn.innerHTML;
      btn.innerHTML = G.components.Icon('loading', 12);
      btn.classList.add('go-mini-spin');
      try {
        // 触发采集
        if (typeof window.__geekOzonCollect === 'function') {
          await window.__geekOzonCollect({ sku: sku, source: 'list_edit_publish' });
        } else {
          await ApiClient.collectProduct({
            platform: 'ozon',
            sku: sku,
            sourceUrl: location.href,
            collectedAt: new Date().toISOString(),
          });
        }
        // 加载商品详情
        const productInfo = await this.loadProductInfo(sku);
        if (typeof window.__geekOzonOpenPublishModal === 'function') {
          window.__geekOzonOpenPublishModal(Object.assign({}, productInfo, { _editMode: true }));
        }
      } catch (e) {
        console.warn('[GeekOzon] 编辑上架失败:', e.message);
      } finally {
        btn.innerHTML = original;
        btn.classList.remove('go-mini-spin');
      }
    }

    /** 计算利润（打开利润计算器，对齐 maozi openProfitCalculator） */
    async triggerProfit(sku, btn) {
      const productInfo = await this.loadProductInfo(sku);
      if (typeof window.__geekOzonOpenProfitCalculator === 'function') {
        window.__geekOzonOpenProfitCalculator(productInfo);
      } else {
        console.warn('[GeekOzon] __geekOzonOpenProfitCalculator 未注入');
      }
    }

    /**
     * 1688找同款（对齐 maozi searchSimilarProduct）
     * 用 1688 官方以图搜图：aibuy.1688.com/landingpage/home/inventory/products.html
     */
    async triggerFindSource(sku, btn) {
      const productInfo = await this.loadProductInfo(sku);
      const imageUrl = productInfo && (productInfo.mainImage || (productInfo.images && productInfo.images[0]));
      if (!imageUrl) {
        console.warn('[GeekOzon] 未找到主图，无法 1688 找同款');
        return;
      }
      const url = 'https://aibuy.1688.com/landingpage/home/inventory/products.html?bizType=ERP&customerId=zhijian&outImageAddress=' + encodeURIComponent(imageUrl);
      window.open(url, '_blank');
    }

    /** 设置显示字段（对齐 maozi openFieldSettings） */
    triggerFieldSettings() {
      if (typeof window.__geekOzonOpenFieldSettings === 'function') {
        window.__geekOzonOpenFieldSettings();
      } else {
        console.warn('[GeekOzon] __geekOzonOpenFieldSettings 未注入');
      }
    }

    /**
     * 加载商品信息（先查本地缓存，再查 mini-card 数据，最后兜底）
     * @param {string} sku
     * @returns {Promise<object>}
     */
    async loadProductInfo(sku) {
      // 1. 先查 mini-card 数据缓存
      if (dataCache[sku]) {
        const d = dataCache[sku];
        return {
          sku: sku,
          platform: 'ozon',
          mainImage: '',
          images: [],
          price: d.minOffer,
          sourceUrl: location.href,
          minOffer: d.minOffer,
          blackPrice: d.blackPrice,
          sales: d.sales,
        };
      }
      // 2. 兜底：仅传 sku，让 publish-modal 自行采集
      return {
        sku: sku,
        platform: 'ozon',
        sourceUrl: location.href,
      };
    }

    /** 切换收藏 */
    async toggleFav(sku, btn) {
      const resp = await ApiClient.toggleFavorite(sku);
      const ok = ApiClient.isOk(resp);
      const favorited = ok ? (resp.data && resp.data.favorited) : false;
      if (dataCache[sku]) {
        dataCache[sku].favorited = favorited;
      }
      btn.innerHTML = G.components.Icon('heart', 13);
      btn.classList.toggle('fav-active', favorited);
      EventBus.emit(EVENTS.FAVORITE_TOGGLED, { sku: sku, favorited: favorited });
    }

    /** 触发采集 */
    async triggerCollect(sku, btn) {
      if (collectedSkus.has(sku)) {
        btn.innerHTML = G.components.Icon('check', 13);
        return;
      }
      btn.innerHTML = '<svg class="go-mini-spin" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><path d="M21 12a9 9 0 1 1-6.219-8.56"/></svg>';
      // 复用 ozon-scanner，但列表页可能不在商品详情页
      // 这里只发送消息给当前 tab 的 scanner（如果存在），否则提示
      if (typeof window.__geekOzonCollect === 'function') {
        await window.__geekOzonCollect();
      } else {
        // 在列表页直接用 SKU 提交
        await ApiClient.collectProduct({
          platform: 'ozon',
          sku: sku,
          sourceUrl: location.href,
          collectedAt: new Date().toISOString(),
        });
      }
      collectedSkus.add(sku);
      btn.innerHTML = G.components.Icon('check', 13);
      setTimeout(function () { btn.innerHTML = G.components.Icon('package', 13); }, 1500);
    }

    /**
     * 启动定时轮询（替代 MutationObserver）
     * - MutationObserver 监听整个 documentElement 会捕获页面所有 DOM 变化
     *   （图片懒加载、tooltip 弹出、自身插入的迷你卡片等），形成慢循环 → 卡死
     * - 改为 setInterval 每 2s 检查一次，无循环触发风险
     * - scanAndInject 内部已用 INJECT_FLAG 防重复注入
     */
    startObserver() {
      const self = this;
      if (this.pollTimer) clearInterval(this.pollTimer);
      this.pollTimer = setInterval(function () {
        G.utils.safeRun(function () {
          if (!DomUtils.isOzonListPage()) return;
          if (self.scanning) return; // 防重入
          // 检查是否还有未注入的商品卡片
          const cards = document.querySelectorAll('.tile-root, [data-widget="tile"]');
          if (!cards.length) return;
          let hasUninjected = false;
          for (let i = 0; i < cards.length; i++) {
            if (!cards[i].hasAttribute(INJECT_FLAG)) { hasUninjected = true; break; }
          }
          if (hasUninjected) {
            G.utils.idleRun(function () {
              G.utils.safeRun(function () { self.scanAndInject(); }, null, 'list-cards.scan');
            }, 500);
          }
        }, null, 'list-cards.poll');
      }, 2000);
    }

    /** 启动 URL 监听 */
    startUrlWatcher() {
      const self = this;
      this.urlUnsub = DomUtils.onUrlChange(function () {
        // URL 变化后重置已注入标记并重新扫描
        const cards = document.querySelectorAll('[' + INJECT_FLAG + ']');
        cards.forEach(function (c) { c.removeAttribute(INJECT_FLAG); });
        // 清空迷你卡片（DOM 可能被替换）
        G.utils.idleRun(function () { self.scanAndInject(); }, 500);
      });
    }

    /** 销毁 */
    destroy() {
      if (this.pollTimer) { clearInterval(this.pollTimer); this.pollTimer = null; }
      if (this.urlUnsub) { this.urlUnsub(); this.urlUnsub = null; }
      const slots = document.querySelectorAll('.geekozon-mini-slot');
      slots.forEach(function (s) { s.remove(); });
      const cards = document.querySelectorAll('[' + INJECT_FLAG + ']');
      cards.forEach(function (c) { c.removeAttribute(INJECT_FLAG); });
    }
  }

  // ===== 单例 =====
  let instance = null;

  function init() {
    if (!DomUtils.isOzonListPage()) return;
    if (window.__geekOzonListCardsLoaded) return;
    window.__geekOzonListCardsLoaded = true;

    instance = new ListCardsManager();
    instance.injectGlobalStyles();

    // 延迟扫描，等列表渲染
    setTimeout(function () {
      instance.scanAndInject();
      instance.startObserver();
      instance.startUrlWatcher();
    }, 800);

    // 监听 EventBus 刷新
    EventBus.on(EVENTS.LIST_CARDS_REFRESH, function () {
      if (instance) {
        const cards = document.querySelectorAll('[' + INJECT_FLAG + ']');
        cards.forEach(function (c) { c.removeAttribute(INJECT_FLAG); });
        instance.scanAndInject();
      }
    });

    // 离开列表页时清理
    DomUtils.onUrlChange(function () {
      if (!DomUtils.isOzonListPage()) {
        if (instance) {
          instance.destroy();
          instance = null;
          window.__geekOzonListCardsLoaded = false;
        }
      }
    });
  }

  /** 对外刷新入口 */
  window.__geekOzonRefreshListCards = function () {
    if (instance) {
      const cards = document.querySelectorAll('[' + INJECT_FLAG + ']');
      cards.forEach(function (c) { c.removeAttribute(INJECT_FLAG); });
      return instance.scanAndInject();
    }
    init();
    return Promise.resolve();
  };

  /** 暴露 class */
  G.features.ListCardsManager = ListCardsManager;

  G.markLoaded('list-cards');
  console.log('[GeekOzon] list-cards 已加载');

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
