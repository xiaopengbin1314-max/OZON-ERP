/**
 * GeekOzon 扩展 - Ozon 商品详情页浮动数据卡片（Shadow DOM）
 *
 * 【对齐 maozi ERP v2.4.3 数据卡片 24+ 字段】
 *
 * 右上角浮动卡片，展示：
 *   基础信息 / 价格分析 / 销量数据（24+ 字段，对齐 maozi what_to_sell/data/v3 接口）
 *
 * 字段清单（按出现顺序）：
 *   类目 / rFBS佣金 / FBP佣金 / SKU / 品牌 / 月销量 / 月销售额 / 月周转动态 /
 *   日销量 / 日销售额 / 广告费占比 / 参与促销天数 / 参与促销折扣 / 促销转化率 /
 *   付费推广天数 / 商品卡浏览量 / 商品卡加购率 / 搜索目录浏览量 / 搜索目录加购率 /
 *   展示转化率 / 商品点击率 / 发货模式 / 退货取消率 / 长宽高 / 重量 / 上架时间 /
 *   跟卖列表 / 跟卖最低价 / 跟卖最高价
 *
 * 数据来源：
 *   - 主：CrossTab.fetchWhatToSell(sku)（/api/site/seller-analytics/what_to_sell/data/v3）
 *   - 兜底：CrossTab.fetchSales(sku)（旧版 /api/v4/product/sales）
 *   - 跟卖：fetchSellerOffers(productId)（/modal/otherOffersFromSellers）
 *
 * 提交缓存：POST /api/ozon/sku_data
 * 底部按钮：采集/一键上架/计算利润/定价工具/复制SKU/刷新
 * 折叠按钮：图表图标，圆形按钮
 *
 * 防重复注入：window.__geekOzonDataCardLoaded
 * 暴露：window.__geekOzonRefreshDataCard()
 */
;(function () {
  'use strict';

  const G = window.GeekOzon;
  if (!G || G.isLoaded('data-card')) return;

  const DomUtils = G.core.DomUtils;
  const ApiClient = G.core.ApiClient;
  const CrossTab = G.core.CrossTab;
  const EventBus = G.core.EventBus;
  const Tokens = G.components.DesignTokens;
  const EVENTS = EventBus.EVENTS;

  /** Shadow Host ID */
  const HOST_ID = 'geekozon-data-card-host';
  /** 卡片折叠态 host ID */
  const TOGGLE_HOST_ID = 'geekozon-data-card-toggle';

  /**
   * 数据卡片组件
   */
  class DataCard {
    constructor() {
      this.host = null;
      this.shadow = null;
      this.mounted = false;
      this.collapsed = false;
      this.lastData = null;
      this.lastSales = null;
      this.lastOffers = null;
      this.refreshing = false;
    }

    // ===== 样式（毛子设计系统） =====
    getStyles() {
      return `
        :host { all: initial; }

        .card {
          position: fixed; top: 80px; right: 20px;
          width: 320px;
          background: ${Tokens.color.bgBase};
          border-radius: ${Tokens.radius.lg};
          box-shadow: ${Tokens.shadow.card};
          font-family: ${Tokens.font.family};
          font-size: ${Tokens.font.sizeBase};
          color: ${Tokens.color.textPrimary};
          overflow: hidden;
          animation: goSlideIn 0.3s ${Tokens.animation.easing};
          z-index: ${Tokens.z.card};
        }
        .card-header {
          background: ${Tokens.color.gradientYellowTop};
          padding: ${Tokens.space.md} ${Tokens.space.base};
          border-bottom: 1px solid ${Tokens.color.border};
          display: flex; justify-content: space-between; align-items: center;
        }
        .card-title {
          font-size: ${Tokens.font.sizeTitle};
          font-weight: ${Tokens.font.weightBold};
          color: ${Tokens.color.textPrimary};
          display: flex; align-items: center; gap: 6px;
        }
        .card-title-dot {
          width: 8px; height: 8px; border-radius: 50%;
          background: ${Tokens.color.primary};
          box-shadow: 0 0 6px 1px ${Tokens.color.accentRedStrong};
        }
        .card-body {
          max-height: 60vh; overflow-y: auto;
          padding: ${Tokens.space.base};
        }
        .row {
          display: flex; justify-content: space-between; align-items: flex-start;
          padding: 6px 0; border-bottom: 1px dashed ${Tokens.color.border};
          gap: 8px;
        }
        .row:last-child { border-bottom: none; }
        .row-label {
          color: ${Tokens.color.textSecondary};
          font-size: ${Tokens.font.sizeSm};
          flex-shrink: 0;
        }
        .row-value {
          color: ${Tokens.color.textPrimary};
          font-weight: ${Tokens.font.weightMedium};
          text-align: right; word-break: break-word;
        }
        .section-title {
          margin-top: ${Tokens.space.base};
          margin-bottom: ${Tokens.space.xs};
          font-size: ${Tokens.font.sizeSm};
          color: ${Tokens.color.primaryActive};
          font-weight: ${Tokens.font.weightSemi};
          border-left: 3px solid ${Tokens.color.primary};
          padding-left: 6px;
        }
        .section-title:first-child { margin-top: 0; }

        .value-success { color: ${Tokens.color.success}; font-weight: ${Tokens.font.weightBold}; }
        .value-info    { color: ${Tokens.color.info}; }
        .value-warning { color: ${Tokens.color.warning}; }
        .value-danger  { color: ${Tokens.color.danger}; }
        .value-muted   { color: ${Tokens.color.textMuted}; }

        .card-footer {
          padding: ${Tokens.space.sm} ${Tokens.space.base};
          border-top: 1px solid ${Tokens.color.border};
          background: ${Tokens.color.bgSubtle};
          display: grid;
          grid-template-columns: repeat(3, 1fr);
          gap: 4px;
        }
        .btn {
          padding: 6px 4px;
          border: 1px solid ${Tokens.color.borderStrong};
          background: ${Tokens.color.bgBase};
          border-radius: ${Tokens.radius.sm};
          font-size: ${Tokens.font.sizeXs};
          color: ${Tokens.color.textPrimary};
          cursor: pointer;
          display: inline-flex; align-items: center; justify-content: center; gap: 3px;
          transition: all ${Tokens.animation.durationFast} ${Tokens.animation.easing};
          font-family: inherit;
        }
        .btn svg { flex-shrink: 0; }
        .btn:hover {
          background: ${Tokens.color.primary};
          color: ${Tokens.color.textInverse};
          border-color: ${Tokens.color.primary};
          box-shadow: ${Tokens.shadow.buttonPrimary};
        }
        .btn-collect {
          grid-column: span 3;
          background: ${Tokens.color.primary};
          color: ${Tokens.color.textInverse};
          border-color: ${Tokens.color.primary};
          box-shadow: ${Tokens.shadow.buttonPrimary};
        }
        .btn-collect:hover { background: ${Tokens.color.primaryHover}; }

        .seller-status {
          display: inline-flex; align-items: center; gap: 3px;
          padding: 2px 8px;
          border-radius: ${Tokens.radius.pill};
          font-size: ${Tokens.font.sizeXs};
          font-weight: ${Tokens.font.weightSemi};
        }
        .seller-status svg { flex-shrink: 0; }
        .seller-ok   { background: rgba(0,176,80,0.15); color: ${Tokens.color.success}; }
        .seller-fail { background: rgba(255,77,79,0.15); color: ${Tokens.color.danger}; }

        /* 折叠按钮：图表图标，圆形按钮 */
        .toggle-btn {
          position: fixed; top: 80px; right: 20px;
          width: 48px; height: 48px;
          border-radius: 50%;
          background: ${Tokens.color.primary};
          border: 2px solid ${Tokens.color.primaryHover};
          color: ${Tokens.color.textInverse};
          cursor: pointer;
          display: flex; align-items: center; justify-content: center;
          box-shadow: ${Tokens.shadow.buttonPrimary};
          z-index: ${Tokens.z.toggle};
          transition: transform ${Tokens.animation.durationFast} ${Tokens.animation.easing};
        }
        .toggle-btn:hover {
          transform: scale(1.1);
          box-shadow: ${Tokens.shadow.buttonPrimaryHover};
        }

        .img-thumbs { display: flex; gap: 4px; flex-wrap: wrap; margin-top: 4px; }
        .img-thumbs img {
          width: 32px; height: 32px; object-fit: cover;
          border-radius: ${Tokens.radius.sm};
          border: 1px solid ${Tokens.color.border};
        }

        /* 佣金阶梯展示 */
        .rate-tier {
          font-size: ${Tokens.font.sizeXs};
          color: ${Tokens.color.textSecondary};
          font-weight: ${Tokens.font.weightMedium};
        }

        @keyframes spin { to { transform: rotate(360deg); } }
        .refreshing { animation: spin 1s linear infinite; display: inline-block; }
      `;
    }

    // ===== 渲染（对齐 maozi 24+ 字段） =====
    render() {
      const d = this.lastData || {};
      const sales = this.lastSales || {};
      const offers = this.lastOffers || [];
      const sellerStatus = this.lastSellerStatus || { hasSellerTab: false };

      const self = this;
      const formatNum = function (n) {
        const v = Number(n);
        if (isNaN(v)) return n || '-';
        return v.toLocaleString('ru-RU');
      };
      const rub = function (n) {
        return '₽' + formatNum(n);
      };
      // 百分比字段渲染：>0 绿、<0 红、=0 灰
      const pct = function (v) {
        if (v == null || v === '') return '-';
        const n = Number(v);
        if (isNaN(n)) return G.utils.escapeHtml(String(v));
        if (n > 0) return '<span class="value-success">+' + n.toFixed(2) + '%</span>';
        if (n < 0) return '<span class="value-danger">' + n.toFixed(2) + '%</span>';
        return '<span class="value-muted">' + n.toFixed(2) + '%</span>';
      };
      // 通用值显示
      const val = function (v, suffix) {
        if (v == null || v === '') return '-';
        const s = suffix ? (G.utils.escapeHtml(String(v)) + suffix) : G.utils.escapeHtml(String(v));
        return s;
      };
      // 佣金阶梯渲染
      const rateTier = function (rate) {
        if (!rate) return '-';
        const r = rate.leq1500 != null ? rate : null;
        if (!r) return G.utils.escapeHtml(String(rate));
        const fmt = function (v) { return v > 0 ? v + '%' : '-'; };
        return '<span class="rate-tier">≤1500: ' + fmt(r.leq1500) + ' / ≤5000: ' + fmt(r.leq5000) + ' / >5000: ' + fmt(r.gt5000) + '</span>';
      };

      // 跟卖最低价
      const offerPrices = offers.map(function (o) { return Number(o.price) || 0; }).filter(Boolean);
      const minOffer = offerPrices.length ? Math.min.apply(null, offerPrices) : null;
      const maxOffer = offerPrices.length ? Math.max.apply(null, offerPrices) : null;
      const blackPrice = minOffer ? Math.round(minOffer * 0.95) : null;

      const imgThumbs = (d.images || []).slice(0, 6).map(function (src) {
        return '<img src="' + G.utils.escapeHtml(src) + '" alt="" />';
      }).join('');

      const sellerBadge = sellerStatus.hasSellerTab
        ? '<span class="seller-status seller-ok">' + G.components.Icon('check', 11) + ' Seller</span>'
        : '<span class="seller-status seller-fail">' + G.components.Icon('close', 11) + ' Seller</span>';

      return `
        <div class="card">
          <div class="card-header">
            <div class="card-title">
              <span class="card-title-dot"></span>
              <span>Ozon 数据卡片</span>
            </div>
            ${sellerBadge}
          </div>
          <div class="card-body">
            <div class="section-title">基础信息</div>
            <div class="row"><span class="row-label">SKU</span><span class="row-value">${G.utils.escapeHtml(d.sku || sales.sku || '-')}</span></div>
            <div class="row"><span class="row-label">标题</span><span class="row-value">${G.utils.escapeHtml((d.title || '').slice(0, 60))}${(d.title||'').length>60?'...':''}</span></div>
            <div class="row"><span class="row-label">价格</span><span class="row-value value-success">${G.utils.escapeHtml(d.price ? rub(d.price) : '-')}</span></div>
            <div class="row"><span class="row-label">类目</span><span class="row-value">${G.utils.escapeHtml(sales.category || d.category || '-')}</span></div>
            <div class="row"><span class="row-label">品牌</span><span class="row-value">${G.utils.escapeHtml(d.brand || sales.brand || '-')}</span></div>
            <div class="row"><span class="row-label">主图数</span><span class="row-value">${(d.images||[]).length}</span></div>
            <div class="row"><span class="row-label">SKU 数</span><span class="row-value">${(d.skuList||[]).length}</span></div>
            <div class="row"><span class="row-label">rFBS 佣金</span><span class="row-value">${rateTier(sales.rfbs_rate)}</span></div>
            <div class="row"><span class="row-label">FBP 佣金</span><span class="row-value">${rateTier(sales.fbp_rate)}</span></div>
            <div class="row"><span class="row-label">发货模式</span><span class="row-value">${val(sales.salesSchema)}</span></div>
            ${imgThumbs ? '<div class="row"><span class="row-label">缩略</span><div class="img-thumbs">' + imgThumbs + '</div></div>' : ''}

            <div class="section-title">价格分析</div>
            <div class="row"><span class="row-label">当前售价</span><span class="row-value value-info">${d.price ? rub(d.price) : '-'}</span></div>
            <div class="row"><span class="row-label">跟卖最低</span><span class="row-value value-success">${minOffer != null ? rub(minOffer) : '-'}</span></div>
            <div class="row"><span class="row-label">跟卖最高</span><span class="row-value value-danger">${maxOffer != null ? rub(maxOffer) : '-'}</span></div>
            <div class="row"><span class="row-label">黑标估价</span><span class="row-value value-warning">${blackPrice != null ? rub(blackPrice) : '-'}</span></div>
            <div class="row"><span class="row-label">跟卖卖家数</span><span class="row-value">${offers.length}</span></div>

            <div class="section-title">销量数据（月维度）</div>
            <div class="row"><span class="row-label">月销量</span><span class="row-value value-info">${val(sales.soldCount)}</span></div>
            <div class="row"><span class="row-label">月销售额</span><span class="row-value value-success">${sales.soldSum != null ? rub(sales.soldSum) : '-'}</span></div>
            <div class="row"><span class="row-label">月周转动态</span><span class="row-value">${pct(sales.salesDynamics)}</span></div>
            <div class="row"><span class="row-label">日销量</span><span class="row-value value-info">${val(sales.avgOrdersOnAccDays)}</span></div>
            <div class="row"><span class="row-label">日销售额</span><span class="row-value value-info">${sales.avgGmvOnAccDays != null ? rub(sales.avgGmvOnAccDays) : '-'}</span></div>
            <div class="row"><span class="row-label">广告费占比</span><span class="row-value">${pct(sales.drr)}</span></div>
            <div class="row"><span class="row-label">参与促销天数</span><span class="row-value">${val(sales.daysInPromo)}</span></div>
            <div class="row"><span class="row-label">参与促销折扣</span><span class="row-value">${pct(sales.discount)}</span></div>
            <div class="row"><span class="row-label">促销转化率</span><span class="row-value">${pct(sales.promoRevenueShare)}</span></div>
            <div class="row"><span class="row-label">付费推广天数</span><span class="row-value">${val(sales.daysWithTrafarets)}</span></div>
            <div class="row"><span class="row-label">商品卡浏览量</span><span class="row-value value-info">${val(sales.qtyViewPdp)}</span></div>
            <div class="row"><span class="row-label">商品卡加购率</span><span class="row-value">${pct(sales.convToCartPdp)}</span></div>
            <div class="row"><span class="row-label">搜索目录浏览量</span><span class="row-value value-info">${val(sales.sessionCountSearch)}</span></div>
            <div class="row"><span class="row-label">搜索目录加购率</span><span class="row-value">${pct(sales.convToCartSearch)}</span></div>
            <div class="row"><span class="row-label">展示转化率</span><span class="row-value">${pct(sales.convViewToOrder)}</span></div>
            <div class="row"><span class="row-label">商品点击率</span><span class="row-value value-warning">${val(sales.custom_click_rate, sales.custom_click_rate != null && String(sales.custom_click_rate).indexOf('%') === -1 ? '%' : '')}</span></div>
            <div class="row"><span class="row-label">退货取消率</span><span class="row-value ${sales.nullableRedemptionRate != null && Number(sales.nullableRedemptionRate) > 10 ? 'value-danger' : 'value-warning'}">${sales.nullableRedemptionRate != null ? (sales.nullableRedemptionRate + '%') : '-'}</span></div>
            <div class="row"><span class="row-label">长 宽 高</span><span class="row-value">${G.utils.escapeHtml(sales.custom_volume || '-')}</span></div>
            <div class="row"><span class="row-label">重 量</span><span class="row-value">${G.utils.escapeHtml(sales.custom_weight || '-')}</span></div>
            <div class="row"><span class="row-label">上架时间</span><span class="row-value">${G.utils.escapeHtml(sales.nullableCreateDate || sales.createDate || '-')}</span></div>
          </div>
          <div class="card-footer">
            <button class="btn btn-collect" id="goCollectBtn">${G.components.Icon('package', 13)} 采集商品</button>
            <button class="btn" id="goPublishBtn">${G.components.Icon('send', 13)} 上架</button>
            <button class="btn" id="goProfitBtn">${G.components.Icon('calculator', 13)} 利润</button>
            <button class="btn" id="goPricingBtn">${G.components.Icon('chart', 13)} 定价</button>
            <button class="btn" id="goCopySkuBtn">${G.components.Icon('copy', 13)} 复制SKU</button>
            <button class="btn" id="goRefreshBtn">${G.components.Icon('refresh', 13)} 刷新</button>
          </div>
        </div>
      `;
    }

    // ===== 渲染折叠按钮 =====
    renderToggle() {
      return `<button class="toggle-btn" id="goToggleBtn" title="展开 GeekOzon 数据卡片">${G.components.Icon('chart', 22)}</button>`;
    }

    // ===== 绑定事件 =====
    bindEvents() {
      const self = this;
      const root = this.shadow;

      // 采集
      const collectBtn = root.querySelector('#goCollectBtn');
      if (collectBtn) {
        collectBtn.onclick = function () {
          self.triggerCollect();
        };
      }
      // 上架
      const publishBtn = root.querySelector('#goPublishBtn');
      if (publishBtn) {
        publishBtn.onclick = function () {
          if (typeof window.__geekOzonOpenPublishModal === 'function') {
            window.__geekOzonOpenPublishModal(self.lastData);
          } else {
            console.warn('[GeekOzon] __geekOzonOpenPublishModal 未注入');
          }
        };
      }
      // 利润
      const profitBtn = root.querySelector('#goProfitBtn');
      if (profitBtn) {
        profitBtn.onclick = function () {
          if (typeof window.__geekOzonOpenProfitCalculator === 'function') {
            window.__geekOzonOpenProfitCalculator(self.lastData);
          } else {
            console.warn('[GeekOzon] __geekOzonOpenProfitCalculator 未注入');
          }
        };
      }
      // 定价
      const pricingBtn = root.querySelector('#goPricingBtn');
      if (pricingBtn) {
        pricingBtn.onclick = function () {
          if (typeof window.__geekOzonOpenPricingTool === 'function') {
            window.__geekOzonOpenPricingTool(self.lastData);
          } else {
            console.warn('[GeekOzon] __geekOzonOpenPricingTool 未注入');
          }
        };
      }
      // 复制 SKU
      const copyBtn = root.querySelector('#goCopySkuBtn');
      if (copyBtn) {
        copyBtn.onclick = function () {
          const sku = (self.lastData && self.lastData.sku) || '';
          if (!sku) return;
          G.utils.copyToClipboard(sku).then(function () {
            copyBtn.innerHTML = G.components.Icon('check', 13) + ' 已复制';
            setTimeout(function () { copyBtn.innerHTML = G.components.Icon('copy', 13) + ' 复制SKU'; }, 1500);
          });
        };
      }
      // 刷新
      const refreshBtn = root.querySelector('#goRefreshBtn');
      if (refreshBtn) {
        refreshBtn.onclick = function () {
          self.refreshData();
        };
      }
    }

    // ===== 触发采集（调 ozon-scanner） =====
    async triggerCollect() {
      if (typeof window.__geekOzonCollect !== 'function') {
        console.warn('[GeekOzon] __geekOzonCollect 未注入');
        return;
      }
      const resp = await window.__geekOzonCollect();
      if (resp && resp.code === 200) {
        EventBus.emit(EVENTS.CARD_DATA_UPDATED, resp.data);
      }
    }

    // ===== 挂载 =====
    mount() {
      if (this.mounted) return this;
      const result = DomUtils.createShadowHost(HOST_ID, '', {
        position: 'fixed', top: 80, right: 20, zIndex: Tokens.z.card,
      });
      this.host = result.host;
      this.shadow = result.shadow;
      // 注入样式
      const styleEl = document.createElement('style');
      styleEl.textContent = Tokens.baseStyles + '\n' + this.getStyles();
      this.shadow.appendChild(styleEl);
      // 容器
      this.container = document.createElement('div');
      this.shadow.appendChild(this.container);
      this.mounted = true;
      return this;
    }

    // ===== 显示 =====
    show() {
      if (!this.mounted) this.mount();
      this.host.style.display = '';
      this.collapsed = false;
      this.removeToggle();
      return this;
    }

    // ===== 隐藏（折叠为按钮） =====
    hide() {
      if (this.host) this.host.style.display = 'none';
      this.collapsed = true;
      this.renderToggleBtn();
      return this;
    }

    // ===== 渲染折叠按钮 =====
    renderToggleBtn() {
      this.removeToggle();
      const result = DomUtils.createShadowHost(TOGGLE_HOST_ID, '', {
        position: 'fixed', top: 80, right: 20, zIndex: Tokens.z.toggle,
      });
      this.toggleHost = result.host;
      this.toggleShadow = result.shadow;
      const styleEl = document.createElement('style');
      styleEl.textContent = Tokens.baseStyles + '\n' + this.getStyles();
      this.toggleShadow.appendChild(styleEl);
      const div = document.createElement('div');
      div.innerHTML = this.renderToggle();
      this.toggleShadow.appendChild(div);
      const self = this;
      const btn = this.toggleShadow.querySelector('#goToggleBtn');
      if (btn) {
        btn.onclick = function () { self.show(); };
      }
    }

    removeToggle() {
      const old = document.getElementById(TOGGLE_HOST_ID);
      if (old) old.remove();
      this.toggleHost = null;
      this.toggleShadow = null;
    }

    // ===== 重渲染 =====
    rerender() {
      if (!this.mounted) return this;
      this.container.innerHTML = this.render();
      this.bindEvents();
      return this;
    }

    // ===== 主刷新流程（并行执行 + 整体超时保护） =====
    async refreshData() {
      if (this.refreshing) return;
      this.refreshing = true;

      // 整体超时兜底：20s 后强制释放锁，避免永久卡死
      const deadline = new Promise(function (resolve) {
        setTimeout(function () { resolve('__DEADLINE__'); }, 20000);
      });

      const work = (async function () {
        // 1. 调 ozon-scanner 提取 DOM 数据（同步）
        const scan = (typeof window.__geekOzonScan === 'function')
          ? window.__geekOzonScan()
          : null;
        if (scan) this.lastData = scan;

        const sku = (this.lastData && this.lastData.sku) || '';
        const productId = (this.lastData && this.lastData.productId) || '';

        // 2-5. 并行发起所有异步请求（各自已有超时保护）
        const tasks = [];
        // 定价配置
        tasks.push(ApiClient.fetchPricing().then(function (r) {
          this.lastPricing = ApiClient.data(r, null);
        }.bind(this)).catch(function () { this.lastPricing = null; }.bind(this)));
        // seller.ozon.ru 标签页状态
        tasks.push(CrossTab.checkSellerTab().then(function (s) {
          this.lastSellerStatus = s;
        }.bind(this)).catch(function () { this.lastSellerStatus = { hasSellerTab: false }; }.bind(this)));
        // 跟卖价
        if (productId) {
          tasks.push(this.fetchSellerOffers(productId).then(function (o) {
            this.lastOffers = o;
          }.bind(this)).catch(function () { this.lastOffers = []; }.bind(this)));
        }
        // 跨 tab 销量数据（优先使用 what_to_sell/data/v3，对齐 maozi 24+ 字段；失败回退到旧版 sales API）
        if (sku) {
          tasks.push((async function () {
            try {
              // 先尝试 what_to_sell/data/v3（数据更全）
              const resp = await CrossTab.fetchWhatToSell(sku);
              if (resp && resp.success && resp.data) {
                this.lastSales = this.aggregateSalesData(resp.data);
                this.lastSalesSource = 'what_to_sell';
                return;
              }
              // 回退到旧版 sales API
              const resp2 = await CrossTab.fetchSales(sku);
              if (resp2 && resp2.success && resp2.data) {
                this.lastSales = this.aggregateSalesData(resp2.data);
                this.lastSalesSource = 'sales';
              }
            } catch (_) {
              /* 静默 */
            }
          }).bind(this)());
        }
        await Promise.all(tasks);

        // 6. 提交缓存到后端（非阻塞，失败不影响 UI）
        if (sku) {
          ApiClient.upsertSkuData(sku, this.lastData.title, {
            price: this.lastData.price,
            brand: this.lastData.brand,
            category: this.lastData.category,
            images: this.lastData.images,
            sales: this.lastSales,
            offers: this.lastOffers,
            pricing: this.lastPricing,
            updatedAt: Date.now(),
          }).catch(function () { /* 静默 */ });
        }

        // 7. 重渲染
        this.rerender();

        // 8. 通知其他组件
        EventBus.emit(EVENTS.CARD_DATA_UPDATED, {
          sku: sku,
          data: this.lastData,
          sales: this.lastSales,
          offers: this.lastOffers,
        });
        return '__DONE__';
      }).bind(this));

      try {
        const result = await Promise.race([work(), deadline]);
        if (result === '__DEADLINE__') {
          console.warn('[GeekOzon] refreshData 整体超时 20s');
        }
      } catch (e) {
        console.error('[GeekOzon] data-card refreshData 异常:', e);
      } finally {
        this.refreshing = false;
      }
    }

    /**
     * 拉取跟卖卖家报价（/modal/otherOffersFromSellers）
     * @param {string} productId
     * @returns {Promise<Array>}
     */
    async fetchSellerOffers(productId) {
      if (!productId) return [];
      const url = '/api/entrypoint-api.bx/page/json/v2?url=/modal/otherOffersFromSellers%3Fproduct_id%3D' + encodeURIComponent(productId);
      try {
        // 此接口在 www.ozon.ru 域内调用，直接走 fetch（同域）
        const fullUrl = location.origin + url;
        // AbortController 8s 超时（防止 fetch 永久挂起）
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
          console.warn('[GeekOzon] fetchSellerOffers 响应过大，跳过:', text.length);
          return [];
        }
        const json = JSON.parse(text);
        // 解析跟卖列表（widget 内的 items）
        const items = this.extractOfferItems(json);
        return items;
      } catch (e) {
        console.warn('[GeekOzon] fetchSellerOffers 失败:', e.message);
        return [];
      }
    }

    /** 从 modal 响应中提取跟卖列表 */
    extractOfferItems(json) {
      if (!json) return [];
      // Ozon modal 响应结构：{ widgetStates: { '...otherOffers...' : JSON 字符串 } }
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
                  shopName: it.shopName || it.sellerName || it.merchantName || '',
                  price: it.price || (it.priceValue) || (it.salePrice) || 0,
                  deliveryTime: it.deliveryTime || it.delivery || it.shippingDays || '',
                  rating: it.rating || (it.sellerRating) || 0,
                };
              });
            }
          } catch (_) {}
        }
      }
      return [];
    }

    /**
     * 从 what_to_sell/data/v3 或 sales API 返回的 item 提取 24+ 字段
     * 对齐 maozi ERP 字段映射
     * @param {object} resp - 接口响应
     * @returns {object} 24+ 字段对象
     */
    aggregateSalesData(resp) {
      // 兼容 {result:{items:[...]}} / {items:[...]} / 直接 item
      // what_to_sell/data/v3 返回 { code:1, data:{ data:{...字段}, category_commission:{...} } }
      let items = [];
      let categoryCommission = null;

      if (Array.isArray(resp)) items = resp;
      else if (resp && Array.isArray(resp.items)) items = resp.items;
      else if (resp && resp.result && Array.isArray(resp.result.items)) items = resp.result.items;
      else if (resp && resp.result && Array.isArray(resp.result)) items = resp.result;
      else if (resp && resp.data && resp.data.data) {
        // what_to_sell/data/v3 响应结构
        items = [resp.data.data];
        categoryCommission = resp.data.category_commission || null;
      } else if (resp && resp.data && Array.isArray(resp.data.items)) {
        items = resp.data.items;
      }

      if (!items.length) {
        // 兜底：把整个 resp 当作单个 item
        items = [resp];
      }
      const item = items[0] || {};

      // 类目拼装：category1/category3 或 category_name
      let categoryStr = '';
      if (item.category1 || item.category3) {
        categoryStr = [item.category1, item.category3].filter(Boolean).join('/');
      } else if (item.category_name) {
        categoryStr = item.category_name;
      } else if (item.category) {
        categoryStr = item.category;
      }

      // 长 宽 高（从 attributes 数组提取，对齐 maozi custom_volume）
      let volumeStr = '';
      if (Array.isArray(item.attributes)) {
        let l = 0, w = 0, h = 0;
        for (let i = 0; i < item.attributes.length; i++) {
          const a = item.attributes[i] || {};
          const v = Number(a.value) || 0;
          if (a.key === '9454') h = v;
          else if (a.key === '9455') l = v;
          else if (a.key === '9456') w = v;
        }
        if (l > 0 && w > 0 && h > 0) {
          volumeStr = h + ' x ' + l + ' x ' + w + 'mm';
        }
      }
      if (!volumeStr && item.dimensions) {
        const d = item.dimensions;
        volumeStr = (d.length || d.l || '') + '×' + (d.width || d.w || '') + '×' + (d.height || d.h || '');
      }
      if (!volumeStr && item.dimensions_string) {
        volumeStr = item.dimensions_string;
      }

      // 重量（从 attributes 提取 key=4497）
      let weightStr = '';
      if (Array.isArray(item.attributes)) {
        for (let i = 0; i < item.attributes.length; i++) {
          if (String(item.attributes[i].key) === '4497') {
            const g = Number(item.attributes[i].value) || 0;
            if (g > 0) { weightStr = g + 'g'; break; }
          }
        }
      }
      if (!weightStr) {
        const w = item.weight != null ? item.weight : (item.weight_g != null ? item.weight_g : '');
        weightStr = w !== '' ? String(w) : '';
      }

      // 上架时间 + 天数
      let createDateStr = '';
      let createDays = 0;
      if (item.nullableCreateDate) {
        const dt = new Date(item.nullableCreateDate);
        if (!isNaN(dt.getTime())) {
          const diffDays = Math.floor(Math.abs(Date.now() - dt.getTime()) / (24 * 60 * 60 * 1000));
          createDays = diffDays;
          createDateStr = dt.toISOString().slice(0, 10) + '(' + diffDays + '天)';
        }
      } else {
        createDateStr = item.created_at || item.create_date || item.creation_date || '';
      }

      // 商品点击率（custom_click_rate = qtyViewPdp / views × 100%）
      let clickRate = null;
      if (item.custom_click_rate != null) {
        clickRate = item.custom_click_rate;
      } else if (item.views != null && item.qtyViewPdp != null && Number(item.views) > 0) {
        clickRate = ((Number(item.qtyViewPdp) / Number(item.views) * 100)).toFixed(2) + '%';
      } else if (item.click_rate != null) {
        clickRate = item.click_rate;
      } else if (item.ctr != null) {
        clickRate = item.ctr;
      }

      // 退货取消率（对齐 maozi nullableRedemptionRate：100 - 原值）
      let redemptionRate = null;
      if (item.nullableRedemptionRate != null) {
        const v = Number(item.nullableRedemptionRate) || 0;
        redemptionRate = v === 0 ? null : (100 - v).toFixed(1);
      } else if (item.redemption_rate != null) {
        redemptionRate = item.redemption_rate;
      } else if (item.return_rate != null) {
        redemptionRate = item.return_rate;
      }

      // 月销售额
      const soldSum = item.sum_gmv != null ? item.sum_gmv
        : (item.sold_sum != null ? item.sold_sum
          : (item.sales_sum != null ? item.sales_sum : null));

      // 佣金阶梯
      const rfbsRate = categoryCommission ? {
        leq1500: categoryCommission.rfbs_leq_1500 || 0,
        leq5000: categoryCommission.rfbs_leq_5000 || 0,
        gt5000: categoryCommission.rfbs_gt_5000 || 0,
      } : (item.rfbs_rate || null);
      const fbpRate = categoryCommission ? {
        leq1500: categoryCommission.fbp_leq_1500 || 0,
        leq5000: categoryCommission.fbp_leq_5000 || 0,
        gt5000: categoryCommission.fbp_gt_5000 || 0,
      } : (item.fbp_rate || null);

      return {
        // 基础
        category: categoryStr,
        sku: item.sku || '',
        brand: item.brand || item.brand_name || '',
        // 销量
        soldCount: item.soldCount != null ? item.soldCount : (item.sold_count != null ? item.sold_count : null),
        soldSum: soldSum,
        salesDynamics: item.salesDynamics != null ? item.salesDynamics : null,
        avgOrdersOnAccDays: item.avgOrdersOnAccDays != null ? item.avgOrdersOnAccDays : null,
        avgGmvOnAccDays: item.avgGmvOnAccDays != null ? item.avgGmvOnAccDays : null,
        // 广告/促销
        drr: item.drr != null ? item.drr : null,                                  // 广告费占比
        daysInPromo: item.daysInPromo != null ? item.daysInPromo : null,         // 参与促销天数
        discount: item.discount != null ? item.discount : null,                   // 参与促销折扣
        promoRevenueShare: item.promoRevenueShare != null ? item.promoRevenueShare : null,  // 促销转化率
        daysWithTrafarets: item.daysWithTrafarets != null ? item.daysWithTrafarets : null,  // 付费推广天数
        // 浏览/加购
        qtyViewPdp: item.qtyViewPdp != null ? item.qtyViewPdp : null,             // 商品卡浏览量
        convToCartPdp: item.convToCartPdp != null ? item.convToCartPdp : null,    // 商品卡加购率
        sessionCountSearch: item.sessionCountSearch != null ? item.sessionCountSearch : null,  // 搜索目录浏览量
        convToCartSearch: item.convToCartSearch != null ? item.convToCartSearch : null,        // 搜索目录加购率
        convViewToOrder: item.convViewToOrder != null ? item.convViewToOrder : null,           // 展示转化率
        custom_click_rate: clickRate,                                             // 商品点击率
        // 物流
        salesSchema: item.salesSchema != null ? item.salesSchema : (item.sales_schema != null ? item.sales_schema : null),  // 发货模式
        nullableRedemptionRate: redemptionRate,                                    // 退货取消率
        custom_volume: volumeStr,                                                  // 长宽高
        custom_weight: weightStr,                                                  // 重量
        nullableCreateDate: createDateStr,                                          // 上架时间
        createDays: createDays || (item.createDays != null ? item.createDays : null),
        // 旧字段兼容
        clickRate: clickRate,
        createDate: createDateStr,
        redemptionRate: redemptionRate,
        dimensions: volumeStr,
        weight: weightStr,
        // 佣金
        rfbs_rate: rfbsRate,
        fbp_rate: fbpRate,
      };
    }

    // ===== 销毁 =====
    destroy() {
      DomUtils.removeShadowHost(HOST_ID);
      this.removeToggle();
      this.mounted = false;
    }
  }

  // ===== 单例 + 自动启动 =====
  let instance = null;

  /** 初始化（仅商品详情页） */
  function init() {
    if (!DomUtils.isOzonProductPage()) return;
    if (window.__geekOzonDataCardLoaded) return;
    window.__geekOzonDataCardLoaded = true;

    instance = new DataCard();
    // mount/show 错误被 safeRun 捕获，不会扩散到其他模块
    G.utils.safeRun(function () { instance.mount(); }, null, 'data-card.mount');
    G.utils.safeRun(function () { instance.show(); }, null, 'data-card.show');

    // 延迟一帧后刷新数据（等 SPA 渲染），用 idleRun 避免抢占首屏
    G.utils.idleRun(function () {
      G.utils.safeRun(function () { instance.refreshData(); }, null, 'data-card.refresh');
    }, 1000);

    // 监听 URL 变化（SPA 路由切换重新初始化）
    DomUtils.onUrlChange(function (newUrl) {
      G.utils.safeRun(function () {
        if (DomUtils.isOzonProductPage()) {
          // 重新刷新
          if (instance && instance.mounted) {
            instance.refreshData();
          } else {
            init();
          }
        } else {
          // 离开商品页：销毁
          if (instance) {
            instance.destroy();
            instance = null;
            window.__geekOzonDataCardLoaded = false;
          }
        }
      }, null, 'data-card.urlChange');
    });

    // 监听 EventBus：其他组件请求刷新卡片
    EventBus.on(EVENTS.CARD_REFRESH, function () {
      if (instance) G.utils.safeRun(function () { instance.refreshData(); }, null, 'data-card.eventRefresh');
    });
  }

  /** 对外暴露的刷新入口 */
  window.__geekOzonRefreshDataCard = function () {
    if (instance) return instance.refreshData();
    init();
    return Promise.resolve();
  };

  /** 暴露 class */
  G.features.DataCard = DataCard;

  G.markLoaded('data-card');
  console.log('[GeekOzon] data-card 已加载');

  // 自动启动
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
