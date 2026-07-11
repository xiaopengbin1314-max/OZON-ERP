/**
 * GeekOzon 扩展 - 利润计算器 + 定价工具抽屉
 * 两个 Tab：计算利润（给定售价算利润）/ 定价工具（反推建议售价）
 *
 * 入口：
 *   - window.__geekOzonOpenProfitCalculator(params)  打开默认「计算利润」Tab
 *   - window.__geekOzonOpenPricingTool(params)       打开默认「定价工具」Tab
 * 防重复注入标志：window.__geekOzonProfitCalcLoaded
 */
;(function () {
  'use strict';

  const G = window.GeekOzon;
  if (!G) return;
  if (window.__geekOzonProfitCalcLoaded) return;
  window.__geekOzonProfitCalcLoaded = true;

  const Tokens = G.components.DesignTokens;
  const BaseComponent = G.components.BaseComponent;
  const ApiClient = G.core.ApiClient;
  const Config = G.core.Config;
  const utils = G.utils;

  /** localStorage 键 */
  const LS_PARAMS = 'geekOzon-profit-calc-params';
  const LS_DRAWER_W = 'geekOzon-drawer-width';

  /** 默认抽屉宽度 */
  const DEFAULT_WIDTH = 460;

  /** 物流模式 */
  const LOGISTICS_MODES = [
    { value: 'fbo',     label: 'FBO（ozon 仓）' },
    { value: 'fbs',     label: 'FBS（自配送）' },
    { value: 'realFBS', label: 'realFBS（真实 FBS）' },
  ];

  /** 跟卖价锚定策略 */
  const COMPETITOR_STRATEGIES = [
    { value: 'below_market', label: '低于市场价（最低）' },
    { value: 'in_range',     label: '市场价区间内' },
    { value: 'above_market', label: '高于市场价' },
  ];

  /** 默认参数 */
  const DEFAULT_PARAMS = {
    // 基础
    costCny: 0,
    weightG: 0,
    lengthMm: 0, widthMm: 0, heightMm: 0,
    logisticsMode: 'fbo',
    descriptionCategoryId: 0,
    typeId: 0,
    targetMargin: 25,           // 目标毛利率 %
    storeCurrency: 'RUB',
    exchangeRate: 12.5,         // CNY -> RUB
    // 跟卖价
    competitorPriceMin: 0,
    competitorPriceMax: 0,
    oldPriceRatio: 1.2,         // 划线价倍数
    competitorStrategy: 'in_range',
    // 计算利润 tab 专用
    sellPriceRub: 0,
    // 高级
    vatRate: 0,                 // VAT %
    incomeTaxRate: 0,           // 个税 %
    returnRate: 0,              // 退货率 %
    lossRate: 0,                // 损耗率 %
    packagingFee: 0,            // 包装费
    otherCost: 0,               // 其他成本
  };

  /** 从 localStorage 读参数 */
  function loadParams() {
    try {
      const raw = localStorage.getItem(LS_PARAMS);
      if (!raw) return Object.assign({}, DEFAULT_PARAMS);
      const parsed = JSON.parse(raw);
      return Object.assign({}, DEFAULT_PARAMS, parsed);
    } catch (_) {
      return Object.assign({}, DEFAULT_PARAMS);
    }
  }

  /** 写参数到 localStorage */
  function saveParams(params) {
    try { localStorage.setItem(LS_PARAMS, JSON.stringify(params || {})); }
    catch (_) {}
  }

  /** 读抽屉宽度 */
  function loadWidth() {
    const v = Number(localStorage.getItem(LS_DRAWER_W));
    return (v && v > 320 && v < 900) ? v : DEFAULT_WIDTH;
  }

  /** 写抽屉宽度 */
  function saveWidth(w) {
    try { localStorage.setItem(LS_DRAWER_W, String(w)); } catch (_) {}
  }

  /**
   * 利润计算器抽屉
   */
  class ProfitCalculator extends BaseComponent {
    constructor() {
      super();
      this.params = loadParams();
      this.activeTab = 'profit';  // 'profit' | 'pricing'
      this.advancedOpen = false;
      this.pricingConfig = null;
      this.drawerWidth = loadWidth();
    }

    getHostId() { return 'geekozon-profit-calc-host'; }
    getHostPosition() { return { position: 'fixed', top: 0, right: 0, zIndex: Tokens.z.drawer }; }

    getStyles() {
      return `
        ${this.getCommonStyles()}
        .go-overlay {
          position: fixed; inset: 0; background: ${Tokens.color.bgOverlayLight};
          z-index: ${Tokens.z.drawer};
          animation: goFadeIn ${Tokens.animation.duration} ${Tokens.animation.easing};
        }
        .go-drawer {
          position: fixed; top: 0; right: 0;
          height: 100vh; width: ${this.drawerWidth}px;
          background: ${Tokens.color.bgBase};
          box-shadow: ${Tokens.shadow.drawer};
          display: flex; flex-direction: column;
          z-index: ${Tokens.z.drawer};
          animation: goSlideIn ${Tokens.animation.duration} ${Tokens.animation.easing};
        }
        @keyframes goSlideIn { from { transform: translateX(60px); opacity: 0; } to { transform: translateX(0); opacity: 1; } }
        .go-resizer {
          position: absolute; top: 0; left: 0; width: 4px; height: 100%;
          background: ${Tokens.color.border};
          cursor: ew-resize;
        }
        .go-resizer:hover { background: ${Tokens.color.primary}; }
        .go-drawer-header {
          padding: ${Tokens.space.lg} ${Tokens.space.xl};
          display: flex; align-items: center; justify-content: space-between;
          background: ${Tokens.color.gradientYellowTop};
          border-bottom: 1px solid ${Tokens.color.border};
        }
        .go-drawer-title { font-size: ${Tokens.font.sizeTitle}; font-weight: ${Tokens.font.weightBold}; }
        .go-tabs { display: flex; padding: ${Tokens.space.sm} ${Tokens.space.xl} 0; gap: ${Tokens.space.sm}; border-bottom: 1px solid ${Tokens.color.border}; }
        .go-tab {
          padding: ${Tokens.space.sm} ${Tokens.space.base}; cursor: pointer;
          font-size: ${Tokens.font.sizeLg}; color: ${Tokens.color.textSecondary};
          border-bottom: 2px solid transparent;
        }
        .go-tab.active { color: ${Tokens.color.primaryActive}; border-bottom-color: ${Tokens.color.primary}; font-weight: ${Tokens.font.weightSemi}; }
        .go-drawer-body { padding: ${Tokens.space.lg} ${Tokens.space.xl}; overflow-y: auto; flex: 1; }
        .go-drawer-footer {
          padding: ${Tokens.space.md} ${Tokens.space.xl};
          display: flex; gap: ${Tokens.space.md}; justify-content: flex-end;
          border-top: 1px solid ${Tokens.color.border}; background: ${Tokens.color.bgSubtle};
        }
        .go-section { margin-bottom: ${Tokens.space.lg}; }
        .go-section-title {
          font-size: ${Tokens.font.sizeLg}; font-weight: ${Tokens.font.weightSemi};
          color: ${Tokens.color.textPrimary}; margin-bottom: ${Tokens.space.md};
          padding-left: ${Tokens.space.sm}; border-left: 3px solid ${Tokens.color.primary};
        }
        .go-field { display: flex; flex-direction: column; gap: 4px; margin-bottom: ${Tokens.space.md}; }
        .go-field label { font-size: ${Tokens.font.sizeSm}; color: ${Tokens.color.textSecondary}; }
        .go-input, .go-select {
          padding: 6px 8px; border: 1px solid ${Tokens.color.borderStrong};
          border-radius: ${Tokens.radius.base}; font-size: ${Tokens.font.sizeBase};
          background: ${Tokens.color.bgBase}; color: ${Tokens.color.textPrimary};
        }
        .go-input:focus, .go-select:focus { border-color: ${Tokens.color.borderFocus}; }
        .go-row { display: flex; gap: ${Tokens.space.md}; flex-wrap: wrap; }
        .go-row > .go-field { flex: 1; min-width: 120px; }
        .go-result {
          padding: ${Tokens.space.base}; border-radius: ${Tokens.radius.base};
          background: ${Tokens.color.gradientGreenTop}; margin-top: ${Tokens.space.md};
          font-size: ${Tokens.font.sizeLg};
        }
        .go-result-big { font-size: 22px; font-weight: ${Tokens.font.weightBold}; color: ${Tokens.color.success}; }
        .go-result-meta { color: ${Tokens.color.textSecondary}; font-size: ${Tokens.font.sizeSm}; margin-top: 4px; }
        .go-advanced-toggle {
          cursor: pointer; color: ${Tokens.color.info};
          font-size: ${Tokens.font.sizeBase}; margin-top: ${Tokens.space.sm};
          display: inline-block;
        }
        .go-advanced-panel {
          padding: ${Tokens.space.base}; margin-top: ${Tokens.space.sm};
          background: ${Tokens.color.bgSubtle}; border-radius: ${Tokens.radius.base};
          border: 1px solid ${Tokens.color.border};
        }
        .go-muted { color: ${Tokens.color.textMuted}; font-size: ${Tokens.font.sizeSm}; }
        .go-toast {
          position: fixed; top: 16px; left: 50%; transform: translateX(-50%);
          padding: ${Tokens.space.sm} ${Tokens.space.base}; border-radius: ${Tokens.radius.base};
          color: ${Tokens.color.textInverse}; font-size: ${Tokens.font.sizeBase}; z-index: ${Tokens.z.toast};
        }
        .go-toast-ok { background: ${Tokens.color.success}; }
        .go-toast-err { background: ${Tokens.color.danger}; }
      `;
    }

    /** 打开抽屉，可指定 tab 与初始参数 */
    open(opts) {
      opts = opts || {};
      if (opts.tab === 'pricing') this.activeTab = 'pricing';
      else if (opts.tab === 'profit') this.activeTab = 'profit';
      if (opts.params) {
        this.params = Object.assign({}, this.params, opts.params);
        saveParams(this.params);
      }
      this.mount();
      this.rerender();
      this._loadPricingConfig();
      this.show();
      return this;
    }

    /** 加载后端定价配置填充高级参数 */
    async _loadPricingConfig() {
      const resp = await ApiClient.fetchPricing();
      if (ApiClient.isOk(resp) && resp.data) {
        this.pricingConfig = resp.data;
        // 后端字段优先，不覆盖用户已填非默认值
        const merged = Object.assign({}, this.params, {
          targetMargin: resp.data.targetMargin != null ? resp.data.targetMargin : this.params.targetMargin,
          exchangeRate: resp.data.exchangeRate != null ? resp.data.exchangeRate : this.params.exchangeRate,
          vatRate: resp.data.vatRate != null ? resp.data.vatRate : this.params.vatRate,
          incomeTaxRate: resp.data.incomeTaxRate != null ? resp.data.incomeTaxRate : this.params.incomeTaxRate,
          returnRate: resp.data.returnRate != null ? resp.data.returnRate : this.params.returnRate,
          lossRate: resp.data.lossRate != null ? resp.data.lossRate : this.params.lossRate,
          packagingFee: resp.data.packagingFee != null ? resp.data.packagingFee : this.params.packagingFee,
          otherCost: resp.data.otherCost != null ? resp.data.otherCost : this.params.otherCost,
        });
        this.params = merged;
        saveParams(this.params);
        this.rerender();
      }
    }

    render() {
      const p = this.params;
      const tab = this.activeTab;
      const modeOpts = LOGISTICS_MODES.map(function (m) {
        return `<option value="${m.value}"${p.logisticsMode === m.value ? ' selected' : ''}>${m.label}</option>`;
      }).join('');
      const stratOpts = COMPETITOR_STRATEGIES.map(function (s) {
        return `<option value="${s.value}"${p.competitorStrategy === s.value ? ' selected' : ''}>${s.label}</option>`;
      }).join('');

      const commonFields = `
        <div class="go-row">
          <div class="go-field"><label>成本价 CNY ¥</label><input type="number" data-p="costCny" step="0.01" value="${p.costCny}" class="go-input" /></div>
          <div class="go-field"><label>汇率 CNY→RUB</label><input type="number" data-p="exchangeRate" step="0.01" value="${p.exchangeRate}" class="go-input" /></div>
        </div>
        <div class="go-row">
          <div class="go-field"><label>重量 g</label><input type="number" data-p="weightG" value="${p.weightG}" class="go-input" /></div>
          <div class="go-field"><label>长 mm</label><input type="number" data-p="lengthMm" value="${p.lengthMm}" class="go-input" /></div>
          <div class="go-field"><label>宽 mm</label><input type="number" data-p="widthMm" value="${p.widthMm}" class="go-input" /></div>
          <div class="go-field"><label>高 mm</label><input type="number" data-p="heightMm" value="${p.heightMm}" class="go-input" /></div>
        </div>
        <div class="go-row">
          <div class="go-field"><label>物流模式</label><select data-p="logisticsMode" class="go-select">${modeOpts}</select></div>
          <div class="go-field"><label>类目 ID</label><input type="number" data-p="descriptionCategoryId" value="${p.descriptionCategoryId}" class="go-input" /></div>
          <div class="go-field"><label>商品类型 ID</label><input type="number" data-p="typeId" value="${p.typeId}" class="go-input" /></div>
        </div>
        <div class="go-row">
          <div class="go-field"><label>跟卖价最低 ₽</label><input type="number" data-p="competitorPriceMin" step="0.01" value="${p.competitorPriceMin}" class="go-input" /></div>
          <div class="go-field"><label>跟卖价最高 ₽</label><input type="number" data-p="competitorPriceMax" step="0.01" value="${p.competitorPriceMax}" class="go-input" /></div>
          <div class="go-field"><label>跟卖价锚定</label><select data-p="competitorStrategy" class="go-select">${stratOpts}</select></div>
        </div>
        <div class="go-row">
          <div class="go-field"><label>划线价倍数</label><input type="number" data-p="oldPriceRatio" step="0.01" value="${p.oldPriceRatio}" class="go-input" /></div>
        </div>
      `;

      const advancedPanel = this.advancedOpen ? `
        <div class="go-advanced-panel">
          <div class="go-row">
            <div class="go-field"><label>VAT %</label><input type="number" data-p="vatRate" step="0.01" value="${p.vatRate}" class="go-input" /></div>
            <div class="go-field"><label>个税 %</label><input type="number" data-p="incomeTaxRate" step="0.01" value="${p.incomeTaxRate}" class="go-input" /></div>
            <div class="go-field"><label>退货率 %</label><input type="number" data-p="returnRate" step="0.01" value="${p.returnRate}" class="go-input" /></div>
            <div class="go-field"><label>损耗率 %</label><input type="number" data-p="lossRate" step="0.01" value="${p.lossRate}" class="go-input" /></div>
          </div>
          <div class="go-row">
            <div class="go-field"><label>包装费 ₽</label><input type="number" data-p="packagingFee" step="0.01" value="${p.packagingFee}" class="go-input" /></div>
            <div class="go-field"><label>其他成本 ₽</label><input type="number" data-p="otherCost" step="0.01" value="${p.otherCost}" class="go-input" /></div>
            <div class="go-field"><label>目标毛利率 %</label><input type="number" data-p="targetMargin" step="0.01" value="${p.targetMargin}" class="go-input" /></div>
          </div>
          <div style="display:flex; gap:${Tokens.space.md}; margin-top:${Tokens.space.sm};">
            <button class="go-btn go-btn-secondary" id="goSaveAdvanced" style="flex:0 0 auto;">保存到后端</button>
          </div>
        </div>
      ` : '';

      // Tab 内容
      let tabContent = '';
      if (tab === 'profit') {
        tabContent = `
          <div class="go-section">
            <div class="go-section-title">售价输入</div>
            <div class="go-field"><label>售价 ₽</label><input type="number" data-p="sellPriceRub" step="0.01" value="${p.sellPriceRub}" class="go-input" /></div>
          </div>
          ${commonFields}
          <div class="go-advanced-toggle" id="goAdvancedToggle">${this.advancedOpen ? '▾ 收起高级参数' : '▸ 展开高级参数'}</div>
          ${advancedPanel}
          <div class="go-drawer-footer">
            <button class="go-btn go-btn-ghost" id="goCancel">关闭</button>
            <button class="go-btn go-btn-primary" id="goCalcProfit">计算利润</button>
          </div>
          <div class="go-section" id="goResultBox" style="display:none;"></div>
        `;
      } else {
        tabContent = `
          <div class="go-section">
            <div class="go-section-title">目标定价</div>
            <div class="go-row">
              <div class="go-field"><label>目标毛利率 %</label><input type="number" data-p="targetMargin" step="0.01" value="${p.targetMargin}" class="go-input" /></div>
              <div class="go-field"><label>店铺币种</label><input type="text" data-p="storeCurrency" value="${utils.escapeHtml(p.storeCurrency)}" class="go-input" /></div>
            </div>
          </div>
          ${commonFields}
          <div class="go-advanced-toggle" id="goAdvancedToggle">${this.advancedOpen ? '▾ 收起高级参数' : '▸ 展开高级参数'}</div>
          ${advancedPanel}
          <div class="go-drawer-footer">
            <button class="go-btn go-btn-ghost" id="goCancel">关闭</button>
            <button class="go-btn go-btn-primary" id="goCalcPrice">计算建议售价</button>
          </div>
          <div class="go-section" id="goResultBox" style="display:none;"></div>
        `;
      }

      return `
        <div class="go-overlay" id="goOverlay"></div>
        <div class="go-drawer" id="goDrawer" style="width:${this.drawerWidth}px;">
          <div class="go-resizer" id="goResizer"></div>
          <div class="go-drawer-header">
            <div class="go-drawer-title">${tab === 'profit' ? '利润计算器' : '定价工具'}</div>
            ${this.renderCloseButton('goCloseBtn')}
          </div>
          <div class="go-tabs">
            <div class="go-tab${tab === 'profit' ? ' active' : ''}" data-tab="profit">计算利润</div>
            <div class="go-tab${tab === 'pricing' ? ' active' : ''}" data-tab="pricing">定价工具</div>
          </div>
          <div class="go-drawer-body">
            ${tabContent}
          </div>
        </div>
      `;
    }

    bindEvents() {
      const self = this;

      // 关闭/取消
      this.on(this.$('#goCloseBtn'), 'click', function () { self.hide(); });
      this.on(this.$('#goCancel'), 'click', function () { self.hide(); });
      this.on(this.$('#goOverlay'), 'click', function () { self.hide(); });

      // Tab 切换
      this.$$('.go-tab').forEach(function (t) {
        t.addEventListener('click', function () {
          self.activeTab = t.getAttribute('data-tab');
          self.rerender();
        });
      });

      // 高级面板开关
      this.on(this.$('#goAdvancedToggle'), 'click', function () {
        self.advancedOpen = !self.advancedOpen;
        self.rerender();
      });

      // 输入字段同步到 params
      this.shadow.querySelectorAll('[data-p]').forEach(function (inp) {
        inp.addEventListener('change', function () {
          const key = inp.getAttribute('data-p');
          const val = inp.type === 'number' ? Number(inp.value) || 0 : inp.value;
          self.params[key] = val;
          saveParams(self.params);
        });
      });

      // 保存高级参数到后端
      this.on(this.$('#goSaveAdvanced'), 'click', async function () {
        const body = {
          targetMargin: self.params.targetMargin,
          exchangeRate: self.params.exchangeRate,
          vatRate: self.params.vatRate,
          incomeTaxRate: self.params.incomeTaxRate,
          returnRate: self.params.returnRate,
          lossRate: self.params.lossRate,
          packagingFee: self.params.packagingFee,
          otherCost: self.params.otherCost,
        };
        const resp = await ApiClient.updatePricing(body);
        self._toast(ApiClient.isOk(resp) ? '已保存到后端' : '保存失败: ' + (resp.msg || ''), ApiClient.isOk(resp) ? 'ok' : 'err');
      });

      // 计算利润
      this.on(this.$('#goCalcProfit'), 'click', async function () { await self._calcProfit(); });
      // 计算建议售价
      this.on(this.$('#goCalcPrice'), 'click', async function () { await self._calcPrice(); });

      // 抽屉宽度拖拽
      this._bindResize();
    }

    /** 抽屉宽度拖拽 */
    _bindResize() {
      const self = this;
      const resizer = this.$('#goResizer');
      const drawer = this.$('#goDrawer');
      if (!resizer || !drawer) return;
      let dragging = false;
      let startX = 0, startW = 0;

      resizer.addEventListener('mousedown', function (e) {
        dragging = true;
        startX = e.clientX;
        startW = drawer.offsetWidth;
        document.body.style.userSelect = 'none';
      });
      document.addEventListener('mousemove', function (e) {
        if (!dragging) return;
        // 向左拖 → 增加宽度
        const w = Math.min(900, Math.max(320, startW + (startX - e.clientX)));
        drawer.style.width = w + 'px';
        self.drawerWidth = w;
      });
      document.addEventListener('mouseup', function () {
        if (!dragging) return;
        dragging = false;
        document.body.style.userSelect = '';
        saveWidth(self.drawerWidth);
      });
    }

    /** 计算利润 */
    async _calcProfit() {
      const p = Object.assign({}, this.params);
      const box = this.$('#goResultBox');
      if (!box) return;
      box.style.display = 'block';
      box.innerHTML = '<div class="go-muted">计算中…</div>';

      let result = null;
      let errorMsg = '计算失败，请检查后端服务';
      try {
        const resp = await ApiClient.calculateProfit(p);
        if (ApiClient.isOk(resp) && resp.data) {
          result = resp.data;
        } else {
          errorMsg = (resp && resp.message) || (resp && resp.msg) || errorMsg;
        }
      } catch (e) {
        errorMsg = e.message || errorMsg;
      }
      if (!result) {
        box.innerHTML = '<div class="go-muted">' + G.components.Icon('warn', 13) + ' ' + utils.escapeHtml(errorMsg) + '</div>';
        return;
      }
      const profit = Number(result.profitRub || result.profit || 0);
      const margin = Number(result.margin != null ? result.margin : (result.marginPct || 0));
      box.innerHTML = `
        <div class="go-result">
          <div class="go-result-big">${utils.formatRub(profit)}</div>
          <div class="go-result-meta">毛利率 ${margin}%</div>
        </div>
      `;
    }

    /** 计算建议售价 */
    async _calcPrice() {
      const p = Object.assign({}, this.params);
      const box = this.$('#goResultBox');
      if (!box) return;
      box.style.display = 'block';
      box.innerHTML = '<div class="go-muted">计算中…</div>';

      let result = null;
      let errorMsg = '计算失败，请检查后端服务';
      try {
        const resp = await ApiClient.calculatePrice(p);
        if (ApiClient.isOk(resp) && resp.data) {
          result = resp.data;
        } else {
          errorMsg = (resp && resp.message) || (resp && resp.msg) || errorMsg;
        }
      } catch (e) {
        errorMsg = e.message || errorMsg;
      }
      if (!result) {
        box.innerHTML = '<div class="go-muted">' + G.components.Icon('warn', 13) + ' ' + utils.escapeHtml(errorMsg) + '</div>';
        return;
      }
      const sell = Number(result.sellPriceRub || result.sellPrice || 0);
      const profit = Number(result.profitRub || result.profit || 0);
      const margin = Number(result.margin != null ? result.margin : (result.marginPct || 0));
      const oldPrice = Math.round(sell * (p.oldPriceRatio || 1) * 100) / 100;
      box.innerHTML = `
        <div class="go-result">
          <div class="go-result-big">建议售价 ${utils.formatRub(sell)}</div>
          <div class="go-result-meta">划线价 ${utils.formatRub(oldPrice)} · 利润 ${utils.formatRub(profit)} · 毛利率 ${margin}%</div>
        </div>
      `;
    }

    _toast(msg, type) {
      const el = document.createElement('div');
      el.className = 'go-toast' + (type === 'ok' ? ' go-toast-ok' : type === 'err' ? ' go-toast-err' : '');
      el.textContent = msg;
      this.shadow.appendChild(el);
      setTimeout(function () { if (el.parentNode) el.parentNode.removeChild(el); }, 2000);
    }
  }

  /** 单例 */
  let _instance = null;
  function getInstance() {
    if (!_instance) _instance = new ProfitCalculator();
    return _instance;
  }

  /** 全局入口 */
  window.__geekOzonOpenProfitCalculator = function (params) {
    const inst = getInstance();
    inst.open({ tab: 'profit', params: params });
    return inst;
  };
  window.__geekOzonOpenPricingTool = function (params) {
    const inst = getInstance();
    inst.open({ tab: 'pricing', params: params });
    return inst;
  };

  // 挂到命名空间
  G.features.pricing = G.features.pricing || {};
  G.features.pricing.ProfitCalculator = ProfitCalculator;
  G.features.pricing.openProfitCalculator = window.__geekOzonOpenProfitCalculator;
  G.features.pricing.openPricingTool = window.__geekOzonOpenPricingTool;
  G.markLoaded('profit-calculator');
})();
