/**
 * GeekOzon 扩展 - 一键上架弹窗（完整复刻毛子 ERP 弹窗 UI/UX/功能）
 *
 * 复刻要点：
 *   - 70% 宽度居中弹窗，遮罩不可点击关闭
 *   - 顶部 Alert 提示 + 7 个控件（店铺多选/品牌/图片顺序/上架方式/水印/合并变体/浮动价格）
 *   - 12 列变体表格（序号/主图/变体/SKU/货号/原售价/我的售价/划线价/重量/尺寸/条码/操作）
 *   - 底部货源信息（货源价格/货源链接/货源备注）
 *   - 页脚：显示所有 SKU 开关 + 上架货币 + 提交/取消按钮
 *   - 10 项预填自动化（表单记忆/货号规则/默认店铺/批量价格记忆/批量售价/划线价/同首行/条码/model_id）
 *
 * 入口：window.__geekOzonOpenPublishModal(productData)
 * 防重复注入标志：window.__geekOzonPublishModalLoaded
 */
;(function () {
  'use strict';

  const G = window.GeekOzon;
  if (!G) return;
  if (window.__geekOzonPublishModalLoaded) return;
  window.__geekOzonPublishModalLoaded = true;

  const Tokens = G.components.DesignTokens;
  const BaseComponent = G.components.BaseComponent;
  const ApiClient = G.core.ApiClient;
  const EventBus = G.core.EventBus;
  const utils = G.utils;

  // ===== localStorage 键 =====
  const MEMORY_KEY          = 'geekozon-publish-form-memory';
  const OFFERID_RULE_KEY    = 'geekozon-offerid-rule';
  const OFFERID_PREFIX_KEY  = 'geekozon-offerid-prefix';
  const BATCH_PRICE_KEY     = 'geekozon-batch-price-value';
  const BATCH_OLD_PRICE_KEY = 'geekozon-batch-old-price-value';

  // ===== 选项常量（完全对齐毛子 ERP） =====
  const BRAND_OPTIONS = [
    { value: 'copy', label: '复制当前品牌' },
    { value: 'none', label: '无品牌' },
  ];
  const IMAGE_ORDER_OPTIONS = [
    { value: 'none',       label: '不处理' },
    { value: 'shuffle',    label: '随机打乱' },
    { value: 'main_fixed', label: '主图不变,其余打乱' },
  ];
  const FOLLOW_TYPE_OPTIONS = [
    { value: 'hand', label: '防侵权跟卖' },
    { value: 'api',  label: '强制跟卖' },
  ];
  /** 货币选项（对齐毛子 ERP：[符号]中文名称） */
  const CURRENCY_OPTIONS = [
    { value: 'CNY', label: '[¥]人民币',         symbol: '¥' },
    { value: 'RUB', label: '[₽]俄罗斯卢布',     symbol: '₽' },
    { value: 'USD', label: '[$]美元',           symbol: '$' },
    { value: 'EUR', label: '[€]欧元',           symbol: '€' },
    { value: 'BYN', label: '[Br]白俄罗斯卢布',   symbol: 'Br' },
    { value: 'KZT', label: '[₸]哈萨克斯坦坚戈',  symbol: '₸' },
  ];
  /** 货币符号映射（value → symbol） */
  const CURRENCY_SYMBOLS = CURRENCY_OPTIONS.reduce(function (map, o) {
    map[o.value] = o.symbol;
    return map;
  }, {});
  const OFFERID_RULES = [
    { value: 'system',        label: '系统生成（mz+时间戳+随机6位）' },
    { value: 'custom_prefix', label: '自定义前缀 + 时间戳 + 随机' },
    { value: 'source_sku',    label: '源 SKU + 随机' },
    { value: 'prefix_sku',    label: '前缀 + 源 SKU' },
  ];
  const PRICE_MODE_OPTIONS = [
    { value: 'fixed',     label: '固定金额' },
    { value: 'multiple',  label: '原售价倍数' },
  ];

  // ===== 工具函数 =====
  function lsGet(key, fallback) {
    try { const v = localStorage.getItem(key); return v ? JSON.parse(v) : fallback; }
    catch (_) { return fallback; }
  }
  function lsSet(key, val) {
    try { localStorage.setItem(key, JSON.stringify(val)); } catch (_) {}
  }
  function pad2(n) { return String(n).padStart(2, '0'); }
  function pad6(n) { return String(n).padStart(6, '0'); }
  function tsYYMMDDHHMMSS() {
    const d = new Date();
    return d.getFullYear().toString().slice(2)
      + pad2(d.getMonth() + 1) + pad2(d.getDate())
      + pad2(d.getHours()) + pad2(d.getMinutes()) + pad2(d.getSeconds());
  }
  function random6() {
    return Math.floor(Math.random() * 1e6).toString().padStart(6, '0');
  }
  function genBarcode() {
    return tsYYMMDDHHMMSS() + random6();
  }
  function genOfferId(rule, prefix, sourceSku) {
    const p = prefix || 'GO';
    const s = sourceSku || '';
    if (rule === 'system')        return 'mz-' + tsYYMMDDHHMMSS() + '-' + random6();
    if (rule === 'custom_prefix') return p + '-' + tsYYMMDDHHMMSS() + '-' + random6();
    if (rule === 'source_sku')    return (s || 'SKU') + '-' + random6();
    if (rule === 'prefix_sku')    return p + '-' + (s || 'SKU');
    return 'mz-' + tsYYMMDDHHMMSS() + '-' + random6();
  }
  function genModelId() {
    return 'mz-' + Math.random().toString(36).substring(2, 15);
  }

  /**
   * 一键上架弹窗组件（复刻毛子 ERP FollowProductModal）
   * 调用：const m = new PublishModal(); m.open(productData);
   */
  class PublishModal extends BaseComponent {
    constructor() {
      super();
      this.productData = null;
      this.rows = [];          // 表格行数据（12 列）
      this._allRows = [];      // 完整变体列表（Switch 过滤前的原始数据）
      this.shops = [];         // 后端返回店铺列表
      this.watermarks = [];    // 后端返回水印模板
      this.shopDropdownOpen = false;
      // 对齐毛子 ERP：ozonUserCurrency（页面价格货币）+ exchangeRateList（汇率表）
      // 毛子 ERP 中对应 E.value (ozonUserCurrency) 和 I.value (exchangeRateList)
      // 此处使用下划线前缀表示私有字段，避免与外部直接访问冲突
      this._ozonUserCurrency = 'CNY';  // 默认 CNY（在 _detectOzonUserCurrency 中按平台调整）
      this._exchangeRateList = {};     // 汇率表，key = fromCurrency + toCurrency
      // 预填默认汇率兜底（对齐毛子 ERP: 1 RUB ≈ 1/11 CNY）
      this._applyDefaultExchangeRates();
      this.submitting = false;
      // 表单状态（对齐毛子 c.value）
      this.form = {
        shopIds: [],
        brand: 'copy',
        imageOrder: 'none',
        followType: 'hand',
        watermarkId: 0,
        modelId: '',
        floatingPrice: null,
        sourcePrice: '',
        sourceUrl: '',
        sourceRemark: '',
        currency: 'CNY',  // 默认人民币（对齐毛子 ERP，面向中国卖家便于换算）
        showAllSku: true, // 默认显示所有 SKU（对齐毛子 ERP 详情页模式）
      };
      // 批量参数（带记忆）
      this.offerIdRule       = lsGet(OFFERID_RULE_KEY, 'system');
      this.offerIdPrefix     = lsGet(OFFERID_PREFIX_KEY, 'GO');
      this.batchPriceMode    = 'multiple';
      this.batchPriceValue   = lsGet(BATCH_PRICE_KEY, 0.95);
      this.batchOldPriceValue = lsGet(BATCH_OLD_PRICE_KEY, 2);
      this.batchOldPriceMode = 'multiple';
    }

    getHostId() { return 'geekozon-publish-modal-host'; }
    getHostPosition() { return { position: 'fixed', zIndex: Tokens.z.modal }; }

    getStyles() {
      // 对齐毛子 ERP 的 Ant Design Vue + Tailwind 色板
      const AD = {
        primary:    '#1677ff',  // Ant Design v5 主色
        primaryBg:  '#e6f4ff',
        primaryBgHover: '#bae0ff',
        danger:     '#ff4d4f',  // Ant Design 危险色（一键上架按钮）
        dangerBg:   '#fff2f0',
        dangerBorder: '#ffccc7',
        success:    '#52c41a',
        warning:    '#faad14',
        blue:       '#1890ff',  // Ant Design v4 蓝（SKU/链接色）
        textBase:   'rgba(0, 0, 0, 0.88)',
        textSec:    'rgba(0, 0, 0, 0.65)',
        textMuted:  'rgba(0, 0, 0, 0.45)',
        border:     '#d9d9d9',   // Ant Design 边框
        borderLight:'#f0f0f0',   // Ant Design 浅边框（表格分隔线）
        borderRadius:'6px',       // Ant Design 默认圆角
        bgBase:     '#ffffff',
        bgSubtle:   '#fafafa',
        bgMuted:    '#f5f5f5',
        fontSize:   '14px',
        fontSizeSm: '13px',
        fontSizeXs: '12px',
      };
      return `
        ${this.getCommonStyles()}
        /* ===== 弹窗容器 ===== */
        .pm-overlay {
          position: fixed; inset: 0;
          background: rgba(0, 0, 0, 0.45);
          display: flex; align-items: center; justify-content: center;
          z-index: ${Tokens.z.modal};
          animation: goFadeIn 0.2s ease;
        }
        .pm-modal {
          width: 70%; max-width: 1280px; min-width: 960px;
          max-height: 92vh;
          background: ${AD.bgBase};
          border-radius: ${AD.borderRadius};
          box-shadow: 0 6px 16px 0 rgba(0, 0, 0, 0.08),
                      0 3px 6px -4px rgba(0, 0, 0, 0.12),
                      0 9px 28px 8px rgba(0, 0, 0, 0.05);
          display: flex; flex-direction: column;
          position: relative;
          overflow: hidden;
          animation: goZoomIn 0.2s ease;
        }
        /* ===== 模态框头部 ===== */
        .pm-modal-header {
          padding: 16px 24px;
          display: flex; align-items: center; justify-content: space-between;
          border-bottom: 1px solid ${AD.borderLight};
          background: ${AD.bgBase};
        }
        .pm-modal-title {
          font-size: 16px;
          font-weight: 600;
          color: ${AD.textBase};
          display: flex; align-items: center; gap: 8px;
        }
        .pm-modal-title-dot { display: none; }
        /* 覆盖 BaseComponent 的 .go-close 关闭按钮样式（对齐 Ant Design） */
        .go-close {
          width: 22px !important; height: 22px !important;
          border: none !important; background: transparent !important;
          color: ${AD.textMuted} !important;
          cursor: pointer; border-radius: 4px;
          display: flex; align-items: center; justify-content: center;
          transition: all 0.15s;
          padding: 0;
        }
        .go-close:hover {
          background: ${AD.bgMuted} !important;
          color: ${AD.textSec} !important;
        }
        /* ===== 模态框主体 ===== */
        .pm-modal-body {
          padding: 16px 24px;
          overflow-y: auto; flex: 1;
        }
        /* ===== Alert 提示（Ant Design info 样式） ===== */
        .pm-alert {
          padding: 8px 12px;
          background: ${AD.primaryBg};
          border: 1px solid ${AD.primaryBgHover};
          border-radius: ${AD.borderRadius};
          margin-bottom: 12px;
          font-size: ${AD.fontSizeSm};
          color: ${AD.textSec};
          display: flex; align-items: flex-start; gap: 8px;
          line-height: 1.5715;
        }
        .pm-alert-icon { flex: 0 0 14px; color: ${AD.primary}; margin-top: 2px; }

        /* ===== 顶部表单行（inline 布局，对齐 Ant Design Form layout="inline"） ===== */
        .pm-form-row {
          display: flex; flex-wrap: wrap;
          gap: 10px;
          margin-bottom: 6px;
          align-items: center;
        }
        .pm-field {
          display: flex; flex-direction: row; align-items: center; gap: 6px;
          min-width: 0;
        }
        .pm-field-label {
          font-size: ${AD.fontSize};
          color: ${AD.textSec};
          white-space: nowrap;
          line-height: 1.5715;
        }
        .pm-input, .pm-select {
          padding: 4px 8px;
          border: 1px solid ${AD.border};
          border-radius: ${AD.borderRadius};
          font-size: ${AD.fontSize};
          background: ${AD.bgBase};
          color: ${AD.textBase};
          min-width: 120px;
          height: 28px;
          box-sizing: border-box;
          transition: all 0.15s;
          line-height: 1.5715;
        }
        .pm-input:hover, .pm-select:hover { border-color: ${AD.primary}; }
        .pm-input:focus, .pm-select:focus {
          outline: none;
          border-color: ${AD.primary};
          box-shadow: 0 0 0 2px rgba(22, 119, 255, 0.1);
        }
        .pm-input[type="number"] { min-width: 80px; }
        .pm-input-icon-group { display: flex; align-items: stretch; gap: 4px; }
        .pm-input-icon-group .pm-input { flex: 1; min-width: 120px; }
        .pm-icon-btn {
          padding: 0 8px;
          border: 1px solid ${AD.border};
          border-radius: ${AD.borderRadius};
          background: ${AD.bgBase};
          color: ${AD.textSec};
          cursor: pointer;
          display: flex; align-items: center; justify-content: center;
          height: 28px;
          transition: all 0.15s;
        }
        .pm-icon-btn:hover {
          background: ${AD.primaryBg};
          color: ${AD.primary};
          border-color: ${AD.primary};
        }
        .pm-tooltip-icon {
          width: 12px; height: 12px;
          color: ${AD.textMuted};
          cursor: help;
        }
        /* ===== 店铺多选下拉 ===== */
        .pm-shop-dropdown { position: relative; }
        .pm-shop-trigger {
          padding: 4px 24px 4px 8px;
          border: 1px solid ${AD.border};
          border-radius: ${AD.borderRadius};
          background: ${AD.bgBase};
          color: ${AD.textBase};
          font-size: ${AD.fontSize};
          min-width: 200px;
          height: 28px;
          cursor: pointer;
          position: relative;
          display: flex; align-items: center; gap: 4px;
          overflow: hidden;
          transition: all 0.15s;
        }
        .pm-shop-trigger:hover { border-color: ${AD.primary}; }
        .pm-shop-trigger.pm-shop-trigger-active {
          border-color: ${AD.primary};
          box-shadow: 0 0 0 2px rgba(22, 119, 255, 0.1);
        }
        .pm-shop-trigger::after {
          content: '';
          position: absolute; right: 8px; top: 50%;
          width: 6px; height: 6px;
          border-right: 1.5px solid ${AD.textMuted};
          border-bottom: 1.5px solid ${AD.textMuted};
          transform: translateY(-50%) rotate(45deg);
        }
        .pm-shop-trigger-text {
          flex: 1; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
        }
        .pm-shop-panel {
          position: absolute;
          top: calc(100% + 4px);
          left: 0; right: 0;
          max-height: 260px; overflow-y: auto;
          background: ${AD.bgBase};
          border: 1px solid ${AD.border};
          border-radius: ${AD.borderRadius};
          box-shadow: 0 6px 16px 0 rgba(0, 0, 0, 0.08),
                      0 3px 6px -4px rgba(0, 0, 0, 0.12);
          z-index: 10;
        }
        .pm-shop-item {
          padding: 6px 10px;
          display: flex; align-items: center; gap: 8px;
          cursor: pointer;
          font-size: ${AD.fontSizeSm};
          border-bottom: 1px solid ${AD.borderLight};
        }
        .pm-shop-item:last-child { border-bottom: none; }
        .pm-shop-item:hover { background: ${AD.primaryBg}; }
        .pm-shop-item input { margin: 0; }
        .pm-shop-item-meta { flex: 1; display: flex; flex-direction: column; gap: 1px; }
        .pm-shop-item-alias { font-weight: 500; color: ${AD.textBase}; }
        .pm-shop-item-meta-sub { font-size: ${AD.fontSizeXs}; color: ${AD.textMuted}; }
        .pm-shop-tag {
          display: inline-flex; align-items: center; gap: 4px;
          padding: 1px 6px;
          background: ${AD.primaryBg};
          color: ${AD.primary};
          border-radius: 4px;
          font-size: ${AD.fontSizeXs};
        }
        .pm-shop-tag-x { cursor: pointer; opacity: 0.6; }
        .pm-shop-tag-x:hover { opacity: 1; }
        .pm-badge {
          display: inline-block; padding: 0 4px;
          border-radius: 4px;
          font-size: 10px;
          line-height: 14px;
        }
        .pm-badge-ok   { background: rgba(82, 196, 26, 0.1); color: ${AD.success}; }
        .pm-badge-warn  { background: rgba(250, 173, 20, 0.1); color: ${AD.warning}; }

        /* ===== 变体表格（Ant Design Table 样式） ===== */
        .pm-table-wrap {
          max-height: 500px;
          overflow: auto;
          border: 1px solid ${AD.borderLight};
          border-radius: ${AD.borderRadius};
          margin: 10px 0;
        }
        .pm-table {
          width: 100%; border-collapse: collapse;
          font-size: ${AD.fontSizeSm};
          background: ${AD.bgBase};
        }
        .pm-table th, .pm-table td {
          padding: 4px 8px;
          border: 1px solid ${AD.borderLight};
          text-align: left;
          white-space: nowrap;
          line-height: 1.5715;
        }
        .pm-table thead th {
          background: ${AD.bgSubtle};
          color: ${AD.textBase};
          font-weight: 500;
          font-size: ${AD.fontSize};
          position: sticky; top: 0;
          z-index: 1;
          transition: background 0.15s;
        }
        .pm-table thead th:hover { background: ${AD.bgMuted}; }
        .pm-table th.pm-col-idx   { width: 50px; text-align: center; }
        .pm-table th.pm-col-img   { width: 80px; }
        .pm-table th.pm-col-title { min-width: 160px; max-width: 220px; }
        .pm-table th.pm-col-sku   { width: 120px; }
        .pm-table th.pm-col-offer { width: 200px; }
        .pm-table th.pm-col-sell  { width: 90px; }
        .pm-table th.pm-col-price { width: 110px; }
        .pm-table th.pm-col-old   { width: 110px; }
        .pm-table th.pm-col-w     { width: 100px; }
        .pm-table th.pm-col-dim   { width: 200px; }
        .pm-table th.pm-col-bc    { width: 160px; }
        .pm-table th.pm-col-op    { width: 60px; }
        .pm-table td input {
          width: 100%; padding: 4px 8px;
          border: 1px solid ${AD.border};
          border-radius: 4px;
          font-size: ${AD.fontSizeSm};
          background: ${AD.bgBase};
          color: ${AD.textBase};
          box-sizing: border-box;
          height: 28px;
          transition: all 0.15s;
        }
        .pm-table td input:hover { border-color: ${AD.primary}; }
        .pm-table td input:focus {
          outline: none;
          border-color: ${AD.primary};
          box-shadow: 0 0 0 2px rgba(22, 119, 255, 0.1);
        }
        .pm-table td input.pm-err { border-color: ${AD.danger}; }
        .pm-table .pm-cell-img {
          width: 58px;
          min-width: 58px;
          text-align: center;
        }
        .pm-table .pm-cell-img img {
          display: block;
          width: 48px;
          height: 64px;
          aspect-ratio: 3 / 4;
          object-fit: cover;
          object-position: center;
          border-radius: 4px;
          border: 1px solid ${AD.borderLight};
          margin: 0 auto;
        }
        .pm-table .pm-cell-title {
          width: 150px;
          min-width: 150px;
          max-width: 150px;
          line-height: 1.35;
          text-align: center;
        }
        .pm-table .pm-title-main {
          color: ${AD.textBase};
          white-space: nowrap;
          overflow: hidden;
          text-overflow: ellipsis;
        }
        .pm-table .pm-title-variant {
          margin-top: 2px;
          color: ${AD.textMuted};
          font-size: 12px;
          white-space: nowrap;
          overflow: hidden;
          text-overflow: ellipsis;
        }
        .pm-table .pm-cell-idx { color: ${AD.textMuted}; text-align: center; }
        .pm-table .pm-cell-sku { color: ${AD.blue}; font-family: monospace; cursor: pointer; }
        .pm-table .pm-cell-sku:hover { text-decoration: underline; }
        .pm-table .pm-cell-sell { color: ${AD.textBase}; }
        .pm-table .pm-cell-sell-main { font-size: ${AD.fontSizeSm}; font-weight: 500; }
        .pm-table .pm-cell-convert {
          font-size: 11px;
          color: ${AD.danger};
          margin-top: 2px;
        }
        /* 价格输入框 prefix（货币符号） */
        .pm-input-prefix {
          display: flex; align-items: center;
          border: 1px solid ${AD.border};
          border-radius: 4px;
          overflow: hidden;
          height: 28px;
        }
        .pm-input-prefix .pm-prefix-symbol {
          padding: 0 6px;
          background: ${AD.bgSubtle};
          color: ${AD.textSec};
          font-size: ${AD.fontSizeSm};
          line-height: 28px;
          flex: 0 0 auto;
          border-right: 1px solid ${AD.borderLight};
        }
        .pm-input-prefix input {
          border: none !important;
          border-radius: 0 !important;
          flex: 1;
        }
        .pm-input-prefix input:focus {
          box-shadow: none !important;
          outline: none;
        }
        .pm-input-prefix:focus-within {
          border-color: ${AD.primary};
          box-shadow: 0 0 0 2px rgba(22, 119, 255, 0.1);
        }
        .pm-table .pm-dim-group {
          display: flex; align-items: center; gap: 4px;
        }
        .pm-dim-x { color: ${AD.textMuted}; flex: 0 0 6px; }
        .pm-dim-group input { min-width: 55px; width: 55px !important; }
        .pm-row-del {
          width: 24px; height: 24px;
          border: none; background: transparent;
          color: ${AD.danger};
          cursor: pointer; border-radius: 4px;
          display: flex; align-items: center; justify-content: center;
        }
        .pm-row-del:hover { background: ${AD.dangerBg}; }
        .pm-th-actions {
          display: flex; align-items: center; gap: 4px;
        }
        .pm-th-action-btn {
          font-size: 11px;
          padding: 1px 6px;
          border: 1px solid ${AD.border};
          background: ${AD.bgBase};
          color: ${AD.primary};
          border-radius: 4px;
          cursor: pointer;
          white-space: nowrap;
          transition: all 0.15s;
        }
        .pm-th-action-btn:hover {
          background: ${AD.primaryBg};
          border-color: ${AD.primary};
        }
        /* ===== Popover（批量设置弹层） ===== */
        .pm-popover {
          position: absolute; top: calc(100% + 4px); right: 0;
          background: ${AD.bgBase};
          border: 1px solid ${AD.borderLight};
          border-radius: ${AD.borderRadius};
          box-shadow: 0 6px 16px 0 rgba(0, 0, 0, 0.08),
                      0 3px 6px -4px rgba(0, 0, 0, 0.12),
                      0 9px 28px 8px rgba(0, 0, 0, 0.05);
          padding: 12px;
          min-width: 220px;
          z-index: 5;
          font-size: ${AD.fontSizeSm};
        }
        .pm-popover-modal {
          top: auto;
          right: auto;
          bottom: auto;
          left: auto;
          z-index: 30;
        }
        .pm-popover-row { margin-bottom: 8px; }
        .pm-popover-row:last-child { margin-bottom: 0; }
        .pm-popover-row label {
          display: block; font-size: ${AD.fontSizeXs};
          color: ${AD.textMuted}; margin-bottom: 4px;
        }

        /* ===== 货源信息行（水平右对齐，对齐毛子 text-right + flex items-center gap-2.5） ===== */
        .pm-source-row {
          margin-top: 8px;
          display: flex; align-items: center; gap: 10px;
          flex-wrap: wrap;
          justify-content: flex-start;
        }
        .pm-source-row .pm-field { flex: 0 0 auto; }
        .pm-source-row .pm-source-url { flex: 1 1 280px; min-width: 200px; }
        .pm-source-row .pm-source-url .pm-input { min-width: 0; width: 100%; }
        .pm-source-row .pm-source-remark { flex: 1 1 300px; min-width: 200px; }
        .pm-source-row .pm-source-remark .pm-input { min-width: 0; width: 100%; }

        /* ===== 模态框页脚（Ant Design Modal footer 样式） ===== */
        .pm-modal-footer {
          padding: 10px 24px;
          display: flex; gap: 16px;
          justify-content: space-between; align-items: center;
          border-top: 1px solid ${AD.borderLight};
          background: ${AD.bgBase};
        }
        .pm-footer-left {
          display: flex; align-items: center; gap: 8px;
          font-size: ${AD.fontSizeSm}; color: ${AD.textSec};
        }
        .pm-footer-mid {
          display: flex; align-items: center; gap: 8px;
          flex: 1; justify-content: center;
        }
        .pm-footer-right { display: flex; gap: 8px; }
        .pm-switch {
          width: 44px; height: 22px;
          background: rgba(0, 0, 0, 0.25);
          border-radius: 11px;
          position: relative;
          cursor: pointer;
          transition: background 0.2s;
          display: flex; align-items: center; justify-content: flex-end;
          padding: 0 4px;
          font-size: 11px;
          color: white;
          box-sizing: border-box;
        }
        .pm-switch.pm-switch-on { background: ${AD.primary}; justify-content: flex-start; }
        .pm-switch .pm-switch-inner {
          font-size: 11px;
          line-height: 1;
          pointer-events: none;
          user-select: none;
        }
        .pm-switch::after {
          content: '';
          position: absolute;
          top: 2px; left: 2px;
          width: 18px; height: 18px;
          background: white; border-radius: 50%;
          transition: transform 0.2s;
          box-shadow: 0 2px 4px rgba(0,0,0,0.2);
        }
        .pm-switch.pm-switch-on::after { transform: translateX(22px); }
        /* ===== 按钮（Ant Design 样式） ===== */
        .pm-btn {
          padding: 4px 15px;
          border-radius: ${AD.borderRadius};
          font-size: ${AD.fontSize};
          height: 32px;
          cursor: pointer;
          border: 1px solid ${AD.border};
          background: ${AD.bgBase};
          color: ${AD.textSec};
          transition: all 0.15s;
          display: inline-flex; align-items: center; justify-content: center; gap: 6px;
          line-height: 1.5715;
        }
        .pm-btn:hover { color: ${AD.primary}; border-color: ${AD.primary}; }
        .pm-btn-primary {
          background: ${AD.primary};
          border-color: ${AD.primary};
          color: white;
        }
        .pm-btn-primary:hover {
          background: #4096ff;
          border-color: #4096ff;
          color: white;
        }
        /* 一键上架按钮：红色 danger 样式（对齐毛子 type="primary" danger） */
        .pm-btn-danger {
          background: ${AD.danger};
          border-color: ${AD.danger};
          color: white;
        }
        .pm-btn-danger:hover {
          background: #ff7875;
          border-color: #ff7875;
          color: white;
        }
        .pm-btn-danger:disabled {
          background: #ffccc7;
          border-color: #ffccc7;
          cursor: not-allowed;
        }
        .pm-btn:disabled { cursor: not-allowed; opacity: 0.6; }
        /* ===== Toast ===== */
        .pm-toast {
          position: fixed; top: 16px; left: 50%; transform: translateX(-50%);
          padding: 8px 16px;
          border-radius: ${AD.borderRadius};
          background: ${AD.textBase};
          color: white;
          font-size: ${AD.fontSize};
          z-index: ${Tokens.z.toast};
          box-shadow: 0 6px 16px 0 rgba(0,0,0,0.12);
        }
        .pm-toast-ok  { background: ${AD.success}; }
        .pm-toast-err { background: ${AD.danger}; }
        .pm-muted { color: ${AD.textMuted}; font-size: ${AD.fontSizeSm}; }
        .pm-loading {
          padding: 20px; text-align: center; color: ${AD.textMuted};
        }
        @keyframes goFadeIn { from { opacity: 0; } to { opacity: 1; } }
        @keyframes goZoomIn { from { opacity: 0; transform: scale(0.96); } to { opacity: 1; transform: scale(1); } }
      `;
    }

    /** 打开弹窗 */
    open(productData) {
      this.productData = productData || {};
      // 捕获编辑模式标志（对齐 maozi editFollowProductFromList）
      // list-cards.triggerEditPublish 会传入 { _editMode: true }
      this._editMode = !!(this.productData && this.productData._editMode);
      this.rows = this._extractRows(this.productData);
      // 保存完整变体列表（用于 Switch 切换时过滤）
      this._allRows = (this.rows || []).slice();
      // 从页面自动检测 Ozon 价格货币（对齐毛子 ERP ee() 函数）
      this._detectOzonUserCurrency();
      this._restoreFormMemory();
      this.mount();
      // 应用 Switch 过滤（showAllSku=false 时只显示第一行）
      this._applyShowAllSkuFilter();
      this.rerender();
      this._loadShops();
      this._loadWatermarks();
      this._loadExchangeRate();
      this._prefillOfferIds();
      // 划线价预填延迟到 _loadExchangeRate 完成后执行
      // 原因：避免用默认汇率预填后，实际汇率加载完成时因 old_price 非空而无法更新
      // 对齐毛子 ERP：毛子在 onMounted 阶段并行加载汇率，rows 构建时 F(sell_price) 已有实际汇率
      this.show();
      return this;
    }

    /**
     * 从 productData 提取表格行（兼容 ozon-scanner、alibaba-scanner、手动添加等多种格式）
     * 对齐毛子 row 结构：cover_image/title/sku/offer_id/sell_price/price/old_price/
     *                   custom_weight/custom_depth/custom_width/custom_height/custom_barcode
     */
    _extractRows(data) {
      let list = [];
      const has = function (arr) { return Array.isArray(arr) && arr.length > 0; };

      // ERP 编辑后的 skus 是发布权威数据。variants 是采集原始数据，可能在
      // 重新采集后与已保存 SKU 数量不一致，不能覆盖用户编辑结果。
      if (has(data.skus)) {
        list = data.skus.map(function (v) { return Object.assign({}, v); });
      } else if (has(data.variants)) {
        list = data.variants.map(function (v) { return Object.assign({}, v); });
      } else if (has(data.skuList)) {
        // Ozon scanner 的 skuList 是字符串数组或对象数组
        list = data.skuList.map(function (v) {
          if (typeof v === 'string') return { sku: v, title: v };
          return Object.assign({}, v);
        });
      } else {
        // 单 SKU 兜底
        list = [{
          sku: data.sku || data.id || '',
          title: data.title || data.name || '',
          sell_price: data.price || 0,
        }];
      }

      const sourceUrl = data.sourceUrl || data.originalUrl || location.href;
      // 主商品的当前售价（来自 webPrice widget）
      const mainPrice = Number(data.price) || 0;
      const mainCardPrice = Number(data.cardPrice) || 0;
      return list.map(function (v, idx) {
        const sku = v.sku || v.id || v.skuCode || v.offerId || v.offer_id || '';
        const cover = v.coverImage || v.picture || v.cover_image || v.mainImage ||
          (Array.isArray(v.images) ? v.images[0] : '') ||
          (Array.isArray(data.images) ? data.images[0] : data.mainImage || '');
        let sellPrice = Number(v.cardPrice) || 0;
        if (!sellPrice) sellPrice = Number(v.price) || 0;
        if (!sellPrice && idx === 0) sellPrice = mainCardPrice || mainPrice;
        return {
          sku: sku,
          cover_image: cover,
          images: Array.isArray(v.images) ? v.images :
            (cover ? [cover] : (Array.isArray(data.images) ? data.images : [])),
          title: v.title || v.name || Object.values(v.combo || {}).join(' / ') || '',
          offer_id: v.offer_id || v.offerId || v.article || '',
          variant_label: v.variantLabel || v.variant_label || v.searchableText || '',
          sell_price: sellPrice,
          price: 0,
          old_price: 0,
          custom_weight: Number(v.custom_weight || v.weight) || 0,
          custom_depth: Number(v.custom_depth || v.depth || v.length) || 0,
          custom_width: Number(v.custom_width || v.width) || 0,
          custom_height: Number(v.custom_height || v.height) || 0,
          custom_barcode: v.custom_barcode || v.barcode || '',
          _sourceUrl: sourceUrl,
          combo: v.attributes || v.combo || {},
        };
      });
    }

    // ===== 表单记忆持久化 =====
    _restoreFormMemory() {
      const mem = lsGet(MEMORY_KEY, null);
      if (!mem) return;
      if (mem.brand)      this.form.brand = mem.brand;
      if (mem.imageOrder) this.form.imageOrder = mem.imageOrder;
      if (mem.followType) this.form.followType = mem.followType;
      if (mem.watermarkId != null) this.form.watermarkId = mem.watermarkId;
      if (mem.currency)   this.form.currency = mem.currency;
      if (mem.showAllSku != null) this.form.showAllSku = mem.showAllSku;
      // shopIds 在店铺列表加载后再校验有效性
      if (Array.isArray(mem.shopIds)) this.form.shopIds = mem.shopIds;
    }
    _saveFormMemory() {
      lsSet(MEMORY_KEY, {
        shopIds: this.form.shopIds,
        brand: this.form.brand,
        imageOrder: this.form.imageOrder,
        followType: this.form.followType,
        watermarkId: this.form.watermarkId,
        currency: this.form.currency,
        showAllSku: this.form.showAllSku,
      });
    }

    // ===== 后端数据加载 =====

    /**
     * 应用"显示所有SKU"过滤（对齐毛子 ERP）
     * ON  → 显示所有变体（每变体一行）
     * OFF → 只显示主商品 1 行
     */
    _applyShowAllSkuFilter() {
      if (!this._allRows || !this._allRows.length) {
        this.rows = [];
        return;
      }
      if (this.form.showAllSku) {
        this.rows = this._allRows.slice();
      } else {
        this.rows = this._allRows.slice(0, 1);
      }
    }

    /** Switch 切换时调用：过滤数据 + 重新渲染表格 tbody */
    _applyShowAllSkuChange() {
      this._applyShowAllSkuFilter();
      this._renderTableBody();
    }

    /**
     * 货币切换时调用：更新价格列 prefix + 汇率换算显示
     * 对齐毛子 ERP：我的售价/划线价输入框 prefix 跟随货币变化
     */
    _applyCurrencyChange() {
      const symbol = CURRENCY_SYMBOLS[this.form.currency] || '';
      // 更新所有"我的售价"和"我的划线价"输入框的 prefix
      const priceInputs = this.shadow.querySelectorAll('input[data-field="price"]');
      const oldInputs = this.shadow.querySelectorAll('input[data-field="old_price"]');
      priceInputs.forEach(function (inp) {
        inp.setAttribute('data-currency-symbol', symbol);
      });
      oldInputs.forEach(function (inp) {
        inp.setAttribute('data-currency-symbol', symbol);
      });
      // 重新渲染表格 tbody（更新 prefix 显示和汇率换算）
      this._renderTableBody();
    }

    /** 仅重新渲染表格 tbody（不重建整个弹窗） */
    _renderTableBody() {
      const tbody = this.$('#pmTbody');
      if (!tbody) return;
      const self = this;
      const rows = this.rows || [];
      // 生成行 HTML（与 render 中一致）
      const rowsHtml = rows.map(function (r, i) {
        return self._renderRowHtml(r, i, utils);
      }).join('');
      const emptyRowHtml = rows.length === 0
        ? '<tr><td colspan="12" class="pm-muted" style="text-align:center;padding:20px;">暂无变体数据</td></tr>'
        : '';
      tbody.innerHTML = rowsHtml + emptyRowHtml;
      // 重新绑定行内事件
      this._bindRowEvents();
    }

    /** 渲染单行 HTML（抽出供 render 和 _renderTableBody 共用） */
    _renderRowHtml(r, i, utils) {
      const self = this;
      const symbol = CURRENCY_SYMBOLS[this.form.currency] || '';
      const img = r.cover_image
        ? '<img src="' + utils.escapeHtml(r.cover_image) + '" alt="" onerror="this.style.display=\'none\'" />'
        : '<span class="pm-muted">无</span>';
      // 表格显示简短标题和清洗后的变体名称；完整标题保留在悬停提示中。
      const mainTitle = String(r.title || (this.productData && (this.productData.title || this.productData.name)) || '').trim();
      const variantTitle = self._getRowVariantLabel(r);
      const fullTitleRaw = variantTitle ? (mainTitle + ' / ' + variantTitle) : mainTitle;
      const fullTitle = utils.escapeHtml(fullTitleRaw);
      const maskedMainTitle = self._maskDisplayTitle(mainTitle);
      const titleHtml = '<div class="pm-title-main">' + utils.escapeHtml(maskedMainTitle) + '</div>' +
        (variantTitle ? '<div class="pm-title-variant">' + utils.escapeHtml(variantTitle) + '</div>' : '');
      const displaySku = self._extractNumericSku(r.sku || '');
      // 原售价列渲染（完全对齐毛子 ERP FollowProductModal bodyCell）
      // 毛子渲染规则：
      //   顶部主行：ozonUserCurrencySymbol + sell_price（源货币符号 + 原值）
      //   底部红色行（≈）：currentCurrencySymbol + (sell_price × rate).toFixed(2)
      //   条件：exchangeRateList[ozonUserCurrency + selectedCurrency] 存在 且 sell_price 非空
      //   即：仅当 rate > 0 且 sellPrice > 0 时显示底部换算行
      const sellPrice = Number(r.sell_price) || 0;
      const rateInfo = this._getExchangeRateInfo();
      // 顶部：源货币符号 + 原售价（对齐毛子 Pe("div",null,ht(Q.ozonUserCurrencySymbol)+ht(ze),1)）
      const mainSellHtml = utils.escapeHtml(rateInfo.fromSymbol || '') + sellPrice;
      // 底部红色换算行（对齐毛子 Q.exchangeRateList[Q.ozonUserCurrency+d.value]&&ze）
      let convertHtml = '';
      if (sellPrice > 0 && rateInfo && rateInfo.rate > 0) {
        const converted = (sellPrice * rateInfo.rate).toFixed(2);
        // 对齐毛子 Pe("span",{class:"text-[#ff3860]"},"≈"+ht(Q.currentCurrencySymbol)+ht(converted),1)
        convertHtml = '<div class="pm-cell-convert">≈' + utils.escapeHtml(rateInfo.toSymbol || '') + converted + '</div>';
      }
      return '<tr data-idx="' + i + '">' +
        '<td class="pm-cell-idx">' + (i + 1) + '</td>' +
        '<td class="pm-cell-img">' + img + '</td>' +
        '<td class="pm-cell-title" title="' + fullTitle + '">' + titleHtml + '</td>' +
        '<td class="pm-cell-sku" title="' + utils.escapeHtml(r.sku || '') + '">' + utils.escapeHtml(displaySku) + '</td>' +
        '<td><input type="text" data-field="offer_id" value="' + utils.escapeHtml(r.offer_id || '') + '" /></td>' +
        '<td class="pm-cell-sell">' +
          '<div class="pm-cell-sell-main">' + mainSellHtml + '</div>' +
          convertHtml +
        '</td>' +
        '<td><div class="pm-input-prefix"><span class="pm-prefix-symbol">' + utils.escapeHtml(symbol) + '</span>' +
          '<input type="number" data-field="price" value="' + (Number(r.price) || 0) + '" step="0.01" /></div></td>' +
        '<td><div class="pm-input-prefix"><span class="pm-prefix-symbol">' + utils.escapeHtml(symbol) + '</span>' +
          '<input type="number" data-field="old_price" value="' + (Number(r.old_price) || 0) + '" step="0.01" /></div></td>' +
        '<td><input type="number" data-field="custom_weight" value="' + (Number(r.custom_weight) || 0) + '" step="1" /></td>' +
        '<td><div class="pm-dim-group">' +
          '<input type="number" data-field="custom_depth" value="' + (Number(r.custom_depth) || 0) + '" placeholder="深" />' +
          '<span class="pm-dim-x">×</span>' +
          '<input type="number" data-field="custom_width" value="' + (Number(r.custom_width) || 0) + '" placeholder="宽" />' +
          '<span class="pm-dim-x">×</span>' +
          '<input type="number" data-field="custom_height" value="' + (Number(r.custom_height) || 0) + '" placeholder="高" />' +
        '</div></td>' +
        '<td><input type="text" data-field="custom_barcode" value="' + utils.escapeHtml(r.custom_barcode || '') + '" placeholder="FBP" /></td>' +
        '<td><button class="pm-row-del" data-idx="' + i + '" title="删除该行">' +
          '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 6h18M19 6l-2 14a2 2 0 0 1-2 2H9a2 2 0 0 1-2-2L5 6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>' +
        '</button></td>' +
        '</tr>';
    }

    /**
     * 自动检测源商品价格货币（对齐毛子 ERP ee() 函数）
     * 平台感知策略：
     *   - 策略 0（最高优先级）：scanner 从 webPrice widget 检测到的货币（productData.currency）
     *   - 策略 1：meta[itemprop="priceCurrency"] 标签
     *   - 策略 2：页面价格文本末尾符号（对齐毛子 ee() 正则）
     *   - 策略 3：URL 域名（仅 Ozon）
     *   - 兜底：Ozon → RUB，1688/其他 → CNY
     */
    _detectOzonUserCurrency() {
      // 判断源平台：优先 productData.shopName/platform，其次 URL 域名
      const shopName = String(this.productData && (this.productData.shopName || this.productData.platform || '')).toLowerCase();
      const host = location.hostname.toLowerCase();
      const isOzon = shopName.indexOf('ozon') !== -1 ||
                     host.indexOf('ozon.ru') !== -1 ||
                     host.indexOf('ozon.kz') !== -1 ||
                     host.indexOf('ozon.by') !== -1;
      const isAlibaba = shopName.indexOf('1688') !== -1 || shopName.indexOf('alibaba') !== -1 ||
                        host.indexOf('1688.com') !== -1 || host.indexOf('alibaba') !== -1;
      // 默认货币：Ozon → RUB，1688/其他 → CNY
      const defaultCurrency = isOzon ? 'RUB' : 'CNY';

      // 策略 0（最高优先级）：使用 ozon-scanner 从 webPrice widget 检测到的货币
      // 对齐毛子 ERP ee() 函数：在 oe() 中调用 ee(Ve.price) 更新 E.value (ozonUserCurrency)
      // scanner 在 fetchProductDetail() 中调用 detectCurrencyFromPrice(priceWidget.price)
      // 将结果存入 productData.currency，此处直接使用
      const scannerCurrency = this.productData && this.productData.currency;
      if (scannerCurrency && CURRENCY_SYMBOLS[scannerCurrency]) {
        this._ozonUserCurrency = scannerCurrency;
        console.log('[GeekOzon] 货币检测(scanner/webPrice):', scannerCurrency);
        return;
      }

      // 策略 1：从 meta 标签检测（itemprop="priceCurrency"）
      try {
        const meta = document.querySelector('meta[itemprop="priceCurrency"]');
        if (meta) {
          const code = (meta.getAttribute('content') || '').toUpperCase().trim();
          if (CURRENCY_SYMBOLS[code]) {
            this._ozonUserCurrency = code;
            console.log('[GeekOzon] 货币检测(meta):', code);
            return;
          }
        }
      } catch (_) {}

      // 策略 2：从页面价格文本提取符号（对齐毛子 ee() 函数）
      try {
        const selectors = isOzon
          ? ['[data-widget="webPrice"]', '[data-widget="webSearchPrice"]', '[class*="price"]', '[class*="Price"]']
          : ['[class*="price"]', '[class*="Price"]', '.price', '.p-price', '[data-spm="price"]'];
        for (let si = 0; si < selectors.length; si++) {
          const el = document.querySelector(selectors[si]);
          if (!el) continue;
          const text = (el.innerText || el.textContent || '').trim();
          if (!text) continue;
          // 对齐毛子 ee() 正则：提取末尾非数字、非空白、非逗号句点字符
          const m = text.match(/[^\d\s,.]+$/);
          if (!m) continue;
          const sym = m[0].trim();
          if (!sym || sym.length > 4) continue;
          // 反查符号 → code
          for (let i = 0; i < CURRENCY_OPTIONS.length; i++) {
            if (CURRENCY_OPTIONS[i].symbol === sym) {
              this._ozonUserCurrency = CURRENCY_OPTIONS[i].value;
              console.log('[GeekOzon] 货币检测(价格文本):', CURRENCY_OPTIONS[i].value, '符号:', sym);
              return;
            }
          }
        }
      } catch (_) {}

      // 策略 3：从 URL 域名推断（仅 Ozon 站点）
      if (isOzon) {
        if (host.indexOf('ozon.kz') !== -1) {
          this._ozonUserCurrency = 'KZT';
          console.log('[GeekOzon] 货币检测(URL): KZT (ozon.kz)');
          return;
        }
        if (host.indexOf('ozon.by') !== -1) {
          this._ozonUserCurrency = 'BYN';
          console.log('[GeekOzon] 货币检测(URL): BYN (ozon.by)');
          return;
        }
        if (host.indexOf('ozon.ru') !== -1) {
          this._ozonUserCurrency = 'RUB';
          console.log('[GeekOzon] 货币检测(URL): RUB (ozon.ru)');
          return;
        }
      }

      // 兜底：Ozon → RUB，1688/其他 → CNY
      this._ozonUserCurrency = defaultCurrency;
      console.log('[GeekOzon] 货币检测: 使用默认', defaultCurrency, '(isOzon:', isOzon, ', isAlibaba:', isAlibaba, ')');
    }

    /**
     * 获取汇率换算信息
     * 对齐毛子 ERP：从原售价货币（ozonUserCurrency）→ 上架货币（selectedCurrency）
     * 注意：对齐毛子 ee() 行为 - 同货币时 rateKey 不存在于 exchangeRateList，故 rate=0，不显示换算行
     * @returns {{rate:number, fromSymbol:string, toSymbol:string}}
     */
    _getExchangeRateInfo() {
      // ozonUserCurrency 默认 RUB（Ozon 商品页价格大多是卢布）
      const fromCurrency = this._ozonUserCurrency || 'RUB';
      const toCurrency = this.form.currency || 'CNY';
      const fromSymbol = CURRENCY_SYMBOLS[fromCurrency] || '';
      const toSymbol = CURRENCY_SYMBOLS[toCurrency] || '';
      // 汇率 key 拼接（对齐毛子：fromCurrency + toCurrency，如 "RUBCNY"）
      const key = fromCurrency + toCurrency;
      const rateList = this._exchangeRateList || {};
      const rateEntry = rateList[key];
      let rate = 0;
      if (rateEntry) {
        rate = typeof rateEntry === 'number' ? rateEntry : (Number(rateEntry.value) || Number(rateEntry.rate) || 0);
      }
      // 对齐毛子 ERP：不设置同货币 rate=1 兜底
      // 毛子逻辑：Q.exchangeRateList[Q.ozonUserCurrency+d.value]&&ze - 同货币时 key 不存在，故不显示换算行
      return { rate: rate, fromSymbol: fromSymbol, toSymbol: toSymbol };
    }

    /**
     * 获取指定货币对的汇率（对齐毛子 ERP I.value[E.value+B.value].value）
     * @param {string} fromCurrency - 源货币（默认 ozonUserCurrency）
     * @param {string} toCurrency - 目标货币（默认当前上架货币）
     * @returns {number} 汇率值（0 表示无汇率）
     */
    _getRate(fromCurrency, toCurrency) {
      const from = fromCurrency || this._ozonUserCurrency || 'RUB';
      const to = toCurrency || (this.form && this.form.currency) || 'CNY';
      const key = from + to;
      const rateEntry = (this._exchangeRateList || {})[key];
      if (!rateEntry) return 0;
      return typeof rateEntry === 'number'
        ? rateEntry
        : (Number(rateEntry.value) || Number(rateEntry.rate) || 0);
    }

    /**
     * 计算划线价（对齐毛子 ERP F 函数）
     * 毛子公式：F(sell_price) = (sell_price × rate × 2).toFixed(2)
     * 其中 rate = exchangeRateList[ozonUserCurrency + currentCurrency].value
     * @param {number} sellPrice - 原售价（源货币）
     * @returns {number} 划线价（目标货币，已四舍五入到 2 位小数）
     */
    _calcOldPriceByF(sellPrice) {
      const sp = Number(sellPrice) || 0;
      if (sp <= 0) return 0;
      const rate = this._getRate();
      if (!rate) return 0;
      // 对齐毛子 F: Math.round(te*ve*2*100)/100
      return Math.round(sp * rate * 2 * 100) / 100;
    }

    /** 绑定表格行内事件（_renderTableBody 后调用） */
    _bindRowEvents() {
      const self = this;
      // 行内 input 变化时同步到 this.rows
      const tbody = this.$('#pmTbody');
      if (!tbody) return;
      this.on(tbody, 'input', function (e) {
        const inp = e.target;
        if (!inp.dataset || !inp.dataset.field) return;
        const tr = inp.closest('tr');
        if (!tr) return;
        const idx = Number(tr.dataset.idx);
        if (isNaN(idx) || !self.rows[idx]) return;
        const field = inp.dataset.field;
        const val = inp.type === 'number' ? (inp.value === '' ? 0 : Number(inp.value)) : inp.value;
        self.rows[idx][field] = val;
        // 同步到 _allRows
        if (self._allRows && self._allRows[idx]) {
          self._allRows[idx][field] = val;
        }
        // 对齐毛子 ERP X 函数：手动改售价时，若划线价为倍数模式则联动更新
        // X = Q => { j.value === "multiple" && W.value !== void 0 && typeof W.value == "number" &&
        //   Q.price && (Q.old_price = (Number(Q.price) * W.value).toFixed(2)); };
        if (field === 'price' &&
            self.batchOldPriceMode === 'multiple' &&
            self.batchOldPriceValue != null &&
            typeof self.batchOldPriceValue === 'number' &&
            !isNaN(self.batchOldPriceValue) &&
            val > 0) {
          const newOldPrice = Math.round(Number(val) * self.batchOldPriceValue * 100) / 100;
          self.rows[idx].old_price = newOldPrice;
          if (self._allRows && self._allRows[idx]) {
            self._allRows[idx].old_price = newOldPrice;
          }
          // 同步更新对应行的划线价输入框
          const oldPriceInp = tr.querySelector('input[data-field="old_price"]');
          if (oldPriceInp) oldPriceInp.value = newOldPrice;
        }
      });
      // 删除行按钮
      const delBtns = tbody.querySelectorAll('.pm-row-del');
      delBtns.forEach(function (btn) {
        self.on(btn, 'click', function () {
          const idx = Number(btn.dataset.idx);
          if (isNaN(idx)) return;
          self.rows.splice(idx, 1);
          if (self._allRows) self._allRows.splice(idx, 1);
          self._renderTableBody();
        });
      });
    }

    async _loadShops() {
      const resp = await ApiClient.fetchShops();
      const data = ApiClient.data(resp, null);
      this.shops = (data && data.list) || (Array.isArray(data) ? data : []);
      // 默认店铺自动选择
      if (!this.form.shopIds.length && this.shops.length) {
        const def = this.shops.find(function (s) { return s.is_default === 1 || s.isDefault === 1; });
        if (def) {
          this.form.shopIds = [String(def.store_id || def.storeId || def.id)];
        } else {
          this.form.shopIds = [String(this.shops[0].store_id || this.shops[0].storeId || this.shops[0].id)];
        }
      }
      // 校验记忆中的 shopIds 是否仍存在
      const validIds = new Set(this.shops.map(function (s) { return String(s.store_id || s.storeId || s.id); }));
      this.form.shopIds = this.form.shopIds.filter(function (id) { return validIds.has(String(id)); });
      this._renderShopTrigger();
    }

    async _loadWatermarks() {
      const self = this;
      const resp = await ApiClient.fetchWatermarkTemplates();
      const data = ApiClient.data(resp, null);
      this.watermarks = (data && data.list) || (Array.isArray(data) ? data : []);
      // 校验记忆中的 watermarkId 是否仍存在
      if (this.form.watermarkId) {
        const exists = this.watermarks.some(function (w) {
          return String(w.id) === String(self.form.watermarkId);
        });
        if (!exists) this.form.watermarkId = 0;
      }
      const sel = this.$('#pmWatermark');
      if (sel) {
        sel.innerHTML = '<option value="0">不加水印</option>' + this.watermarks.map(function (w) {
          return '<option value="' + utils.escapeHtml(String(w.id)) + '"' +
                 (String(w.id) === String(self.form.watermarkId) ? ' selected' : '') + '>' +
                 utils.escapeHtml(w.name || '') + '</option>';
        }).join('');
      }
    }

    async _loadExchangeRate() {
      const resp = await ApiClient.fetchExchangeRate();
      const data = ApiClient.data(resp, null);
      if (!data) {
        // API 失败时使用默认汇率兜底（对齐毛子 ERP: 1 RUB ≈ 1/11 CNY）
        this._applyDefaultExchangeRates();
        // 汇率加载后重新预填划线价（用实际/默认汇率，对齐毛子 F(sell_price) 公式）
        this._prefillDefaultOldPrices();
        this._renderTableBody();
        return;
      }
      // 对齐毛子 ERP：保存完整汇率表，key = fromCurrency + toCurrency（如 "RUBCNY"）
      // 兼容后端多种返回格式：
      //   1. { currencyFrom: "CNY", currencyTo: "RUB", rate: 12.5 } — 本项目后端格式
      //   2. { RUBCNY: { value: 0.087 }, RUBUSD: { value: 0.012 } } — 毛子格式
      //   3. { from: 'CNY', to: 'RUB', rate: 12.5 } — 简单单条
      //   4. { CNY_RUB: 12.5 } — 旧格式
      if (typeof data === 'object') {
        // 格式 1/3：单条 { currencyFrom/from, currencyTo/to, rate }
        const from = data.currencyFrom || data.from;
        const to = data.currencyTo || data.to;
        const rateVal = Number(data.rate);
        if (from && to && rateVal > 0) {
          const fwdKey = from + to;           // e.g. "CNYRUB"
          const revKey = to + from;            // e.g. "RUBCNY"
          const revVal = 1 / rateVal;
          this._exchangeRateList[fwdKey] = { value: rateVal };
          this._exchangeRateList[revKey] = { value: revVal };
          console.log('[GeekOzon] 汇率加载:', fwdKey, '=', rateVal, '|', revKey, '=', revVal.toFixed(4));
        }
        // 格式 2：毛子格式 { RUBCNY: { value: 0.08 } }
        Object.keys(data).forEach(function (k) {
          if (k.length === 6 && /^[A-Z]{6}$/.test(k)) {
            const v = data[k];
            const val = typeof v === 'number' ? v : (Number(v && v.value) || 0);
            if (val > 0) {
              this._exchangeRateList[k] = { value: val };
              // 自动补全反向汇率
              const rev = k.slice(3) + k.slice(0, 3);
              if (!this._exchangeRateList[rev]) {
                this._exchangeRateList[rev] = { value: 1 / val };
              }
            }
          }
        }.bind(this));
        // 格式 4：旧格式 { CNY_RUB: 12.5 }
        Object.keys(data).forEach(function (k) {
          if (k.indexOf('_') !== -1 && typeof data[k] === 'number') {
            const parts = k.split('_');
            if (parts.length === 2) {
              const newKey = parts[0] + parts[1];
              const val = data[k];
              this._exchangeRateList[newKey] = { value: val };
              const revKey = parts[1] + parts[0];
              if (!this._exchangeRateList[revKey]) {
                this._exchangeRateList[revKey] = { value: 1 / val };
              }
            }
          }
        }.bind(this));
      }
      // 补充默认汇率兜底（仅当对应 key 不存在时填充）
      this._applyDefaultExchangeRates();
      // 汇率加载后重新预填划线价（用实际汇率，对齐毛子 F(sell_price) 公式）
      // 仅对 old_price 仍为空的行预填，用户已手动输入的不覆盖
      this._prefillDefaultOldPrices();
      // 加载完成后刷新表格（更新汇率换算显示）
      this._renderTableBody();
    }

    /**
     * 补充默认汇率兜底（仅当对应 key 不存在或为 0 时填充）
     * 对齐毛子 ERP 的 fallback: 1 RUB = 1/11 CNY
     */
    _applyDefaultExchangeRates() {
      const defaults = {
        // RUB ↔ CNY（毛子 ERP 默认 1 RUB ≈ 0.0909 CNY）
        RUBCNY: 1 / 11,
        CNYRUB: 11,
        // RUB ↔ USD
        RUBUSD: 0.011,
        USDRUB: 90,
        // RUB ↔ EUR
        RUBEUR: 0.01,
        EURRUB: 100,
        // CNY ↔ USD
        CNYUSD: 0.14,
        USDCNY: 7.1,
        // KZT ↔ CNY
        KZTCNY: 0.016,
        CNYKZT: 62,
        // BYN ↔ CNY
        BYNCNY: 2.7,
        CNYBYN: 0.37,
      };
      for (const key in defaults) {
        if (!this._exchangeRateList[key] || !Number(this._exchangeRateList[key].value)) {
          this._exchangeRateList[key] = { value: defaults[key] };
        }
      }
    }

    // ===== 预填默认值 =====
    _prefillOfferIds() {
      // 新建一键上传必须生成本系统的平台 SKU，不能沿用源 Ozon 的
      // seller offer_id。编辑模式才保留已经建立的平台 SKU。
      if (!this._editMode) {
        this._batchGenerateOfferIds();
        return;
      }
      let needGen = false;
      for (const r of this.rows) {
        if (!r.offer_id || String(r.offer_id).trim() === '') { needGen = true; break; }
      }
      if (needGen) this._batchGenerateOfferIds();
    }

    _prefillDefaultOldPrices() {
      // 对齐毛子 ERP F() 函数：old_price = sell_price × rate × 2
      // 仅对 old_price 为空的行预填（用户已手动输入的不覆盖）
      for (const r of this.rows) {
        if (!r.old_price || Number(r.old_price) === 0) {
          const sp = Number(r.sell_price) || 0;
          if (sp > 0) {
            r.old_price = this._calcOldPriceByF(sp);
          }
        }
      }
    }

    // ===== 展示格式化工具 =====
    /**
     * 弹窗表格只显示简短标题，完整标题仍保留在数据和悬停提示中。
     */
    _maskDisplayTitle(title) {
      const text = String(title || '').trim().replace(/\s+/g, ' ');
      if (!text) return '';

      const words = text.split(' ');
      if (words.length > 2) return words.slice(0, 2).join(' ') + '...';

      const chars = Array.from(text);
      return chars.length > 12 ? chars.slice(0, 12).join('') + '...' : text;
    }

    /**
     * 清洗变体名称，例如将 "4 - черный" 转换为 "черный"。
     */
    _cleanVariantLabel(label) {
      let text = String(label || '').trim();
      text = text.replace(/^\s*\d+\s*(?:[\p{L}\u4e00-\u9fff]+)?\s*[-\u2013\u2014:]\s*/u, '').trim();
      text = text.replace(/\s+/g, ' ');
      return text;
    }

    _getRowVariantLabel(row) {
      const combo = row && row.combo ? row.combo : {};
      const productColorName = '商品颜色（Цвет товара）';
      const colorNameName = '颜色名称（Название цвета）';
      const candidates = [
        row && (row.variant_label || row.variantLabel || row.searchableText),
        combo && (
          combo[colorNameName] ||
          combo[productColorName] ||
          combo['Название цвета'] ||
          combo['Цвет товара'] ||
          combo.color ||
          combo.Color
        ),
      ];
      if (combo) {
        Object.keys(combo).forEach(function (key) {
          candidates.push(combo[key]);
        });
      }
      const mainTitle = String(row && row.title || '').trim().toLowerCase();
      for (let i = 0; i < candidates.length; i++) {
        const cleaned = this._cleanVariantLabel(candidates[i]);
        if (cleaned && cleaned.toLowerCase() !== mainTitle) return cleaned;
      }
      return '';
    }

    /**
     * 从 SKU 字符串中提取纯数字部分（产品编号）
     * 例："smartfony-15502-4781728105" -> "4781728105"
     *      "4781728105"               -> "4781728105"
     *      "sku-123"                  -> "123"
     * 取末尾最长的数字串（Ozon 商品 ID 通常是末尾的纯数字）
     */
    _extractNumericSku(sku) {
      const s = String(sku || '').trim();
      if (!s) return '';
      // 优先取末尾连续数字（≥4 位，避免误取 2-3 位的类目编号）
      const m = s.match(/(\d{4,})$/);
      if (m) return m[1];
      // 兜底：取最长的数字串
      const all = s.match(/\d+/g);
      if (all && all.length) {
        return all.reduce(function (a, b) { return a.length >= b.length ? a : b; }, '');
      }
      return '';
    }

    // ===== 渲染 =====
    render() {
      const self = this;
      const rows = this.rows || [];

      // 使用 _renderRowHtml 统一生成行 HTML（避免与 _renderTableBody 重复）
      const rowsHtml = rows.map(function (r, i) {
        return self._renderRowHtml(r, i, utils);
      }).join('');

      const emptyRowHtml = rows.length === 0
        ? '<tr><td colspan="12" class="pm-loading">暂无可上架的变体</td></tr>'
        : '';

      const brandOpts     = BRAND_OPTIONS.map(function (o) { return '<option value="' + o.value + '"' + (o.value === self.form.brand ? ' selected' : '') + '>' + utils.escapeHtml(o.label) + '</option>'; }).join('');
      const imageOpts     = IMAGE_ORDER_OPTIONS.map(function (o) { return '<option value="' + o.value + '"' + (o.value === self.form.imageOrder ? ' selected' : '') + '>' + utils.escapeHtml(o.label) + '</option>'; }).join('');
      const followOpts    = FOLLOW_TYPE_OPTIONS.map(function (o) { return '<option value="' + o.value + '"' + (o.value === self.form.followType ? ' selected' : '') + '>' + utils.escapeHtml(o.label) + '</option>'; }).join('');
      const currencyOpts  = CURRENCY_OPTIONS.map(function (o) { return '<option value="' + o.value + '"' + (o.value === self.form.currency ? ' selected' : '') + '>' + utils.escapeHtml(o.label) + '</option>'; }).join('');
      const watermarkOpts = '<option value="0">不加水印</option>' + (this.watermarks || []).map(function (w) {
        return '<option value="' + utils.escapeHtml(String(w.id)) + '"' + (String(w.id) === String(self.form.watermarkId) ? ' selected' : '') + '>' + utils.escapeHtml(w.name || '') + '</option>';
      }).join('');
      const priceModeOpts = PRICE_MODE_OPTIONS.map(function (o) { return '<option value="' + o.value + '"' + (o.value === self.batchPriceMode ? ' selected' : '') + '>' + utils.escapeHtml(o.label) + '</option>'; }).join('');

      return `
        <div class="pm-overlay" id="pmOverlay">
          <div class="pm-modal">
            <div class="pm-modal-header">
              <div class="pm-modal-title">
                <span class="pm-modal-title-dot"></span>
                ${this._editMode ? '编辑上架到 OZON' : '一键上架到 OZON'}
              </div>
              ${this.renderCloseButton('pmCloseBtn')}
            </div>
            <div class="pm-modal-body">
              <div class="pm-alert">
                <svg class="pm-alert-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                  <circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/>
                </svg>
                <span>提示：请先选择上架货币，再批量设置价格。划线价必须大于售价，否则 Ozon 会拒绝上架。</span>
              </div>

              <div class="pm-form-row">
                <div class="pm-field">
                  <span class="pm-field-label">
                    选择店铺：
                    <svg class="pm-tooltip-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" title="可同时上架到多个店铺">
                      <circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/>
                    </svg>
                  </span>
                  <div class="pm-shop-dropdown" id="pmShopDropdown">
                    <div class="pm-shop-trigger" id="pmShopTrigger">
                      <span class="pm-shop-trigger-text" id="pmShopTriggerText">${this._renderShopTriggerText()}</span>
                    </div>
                  </div>
                </div>

                <div class="pm-field">
                  <span class="pm-field-label">品牌：</span>
                  <select id="pmBrand" class="pm-select">${brandOpts}</select>
                </div>

                <div class="pm-field">
                  <span class="pm-field-label">图片顺序：</span>
                  <select id="pmImageOrder" class="pm-select">${imageOpts}</select>
                </div>

                <div class="pm-field">
                  <span class="pm-field-label">
                    上架方式：
                    <svg class="pm-tooltip-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"
                         title="防侵权跟卖：模拟人工上架，降低下架风险。强制跟卖：1:1复制当前商品卡片，有概率报错或被下架">
                      <circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/>
                    </svg>
                  </span>
                  <select id="pmFollowType" class="pm-select">${followOpts}</select>
                </div>

                <div class="pm-field">
                  <span class="pm-field-label">水印：</span>
                  <select id="pmWatermark" class="pm-select">${watermarkOpts}</select>
                </div>

                <div class="pm-field">
                  <span class="pm-field-label">合并变体：</span>
                  <div class="pm-input-icon-group">
                    <input type="text" id="pmModelId" class="pm-input" value="${utils.escapeHtml(this.form.modelId || '')}" placeholder="留空不合并" />
                    <button class="pm-icon-btn" id="pmModelIdRand" title="随机生成 model_id">
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                        <path d="M21 12a9 9 0 0 0-9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/><path d="M3 12a9 9 0 0 0 9 9 9.75 9.75 0 0 0 6.74-2.74L21 16"/><path d="M16 16h5v5"/>
                      </svg>
                    </button>
                  </div>
                </div>

                <div class="pm-field">
                  <span class="pm-field-label">浮动价格上限：</span>
                  <input type="number" id="pmFloatingPrice" class="pm-input" value="${this.form.floatingPrice != null ? this.form.floatingPrice : ''}" step="0.01" placeholder="留空不限" />
                </div>
              </div>

              <div class="pm-table-wrap">
                <table class="pm-table">
                  <thead>
                    <tr>
                      <th class="pm-col-idx">序号</th>
                      <th class="pm-col-img">主图</th>
                      <th class="pm-col-title">变体</th>
                      <th class="pm-col-sku">SKU</th>
                      <th class="pm-col-offer">
                        <div class="pm-th-actions">
                          <span>货号</span>
                          <button class="pm-th-action-btn" data-batch="offer_id">一键生成</button>
                          <button class="pm-th-action-btn" data-batch="offer_rule" title="设置生成规则">⚙</button>
                        </div>
                      </th>
                      <th class="pm-col-sell">原售价</th>
                      <th class="pm-col-price">
                        <div class="pm-th-actions">
                          <span>我的售价</span>
                          <button class="pm-th-action-btn" data-batch="price">批量设置</button>
                        </div>
                      </th>
                      <th class="pm-col-old">
                        <div class="pm-th-actions">
                          <span>我的划线价</span>
                          <button class="pm-th-action-btn" data-batch="old_price">批量设置</button>
                        </div>
                      </th>
                      <th class="pm-col-w">
                        <div class="pm-th-actions">
                          <span>自定义重量(g)</span>
                          <button class="pm-th-action-btn" data-batch="weight">同首行</button>
                        </div>
                      </th>
                      <th class="pm-col-dim">
                        <div class="pm-th-actions">
                          <span>包装尺寸(mm)</span>
                          <button class="pm-th-action-btn" data-batch="dim">同首行</button>
                        </div>
                      </th>
                      <th class="pm-col-bc">
                        <div class="pm-th-actions">
                          <span>条形码(FBP)</span>
                          <button class="pm-th-action-btn" data-batch="barcode">一键生成</button>
                        </div>
                      </th>
                      <th class="pm-col-op">操作</th>
                    </tr>
                  </thead>
                  <tbody id="pmTbody">${rowsHtml}${emptyRowHtml}</tbody>
                </table>
              </div>

              <div class="pm-source-row">
                <div class="pm-field">
                  <span class="pm-field-label">货源价格：</span>
                  <input type="number" id="pmSourcePrice" class="pm-input" value="${utils.escapeHtml(this.form.sourcePrice || '')}" step="0.01" placeholder="0" />
                </div>
                <div class="pm-field pm-source-url">
                  <span class="pm-field-label">货源链接：</span>
                  <input type="text" id="pmSourceUrl" class="pm-input" value="${utils.escapeHtml(this.form.sourceUrl || '')}" placeholder="https://..." />
                </div>
                <div class="pm-field pm-source-remark">
                  <span class="pm-field-label">货源备注：</span>
                  <input type="text" id="pmSourceRemark" class="pm-input" value="${utils.escapeHtml(this.form.sourceRemark || '')}" placeholder="备注信息" />
                </div>
              </div>
            </div>

            <div class="pm-modal-footer">
              <div class="pm-footer-left">
                <span>显示所有SKU：</span>
                <div class="pm-switch ${this.form.showAllSku ? 'pm-switch-on' : ''}" id="pmShowAllSku">
                  <span class="pm-switch-inner">${this.form.showAllSku ? '是' : '否'}</span>
                </div>
              </div>
              <div class="pm-footer-mid">
                <span class="pm-field-label">上架货币：</span>
                <select id="pmCurrency" class="pm-select" style="min-width: 180px;">${currencyOpts}</select>
              </div>
              <div class="pm-footer-right">
                <button class="pm-btn" id="pmCancel">取消</button>
                <button class="pm-btn pm-btn-danger" id="pmSubmit">${this.submitting ? '提交中…' : (this._editMode ? '保存编辑并上架' : '一键上架至 OZON')}</button>
              </div>
            </div>
          </div>
        </div>
      `;
    }

    /** 渲染店铺选择器触发文本 */
    _renderShopTriggerText() {
      if (!this.form.shopIds.length) return '<span class="pm-muted">请选择店铺</span>';
      const self = this;
      const selected = this.shops.filter(function (s) {
        return self.form.shopIds.indexOf(String(s.store_id || s.storeId || s.id)) !== -1;
      });
      if (!selected.length) return '<span class="pm-muted">请选择店铺</span>';
      if (selected.length === 1) {
        return '<span class="pm-shop-tag">' + utils.escapeHtml(selected[0].alias || String(selected[0].store_id || '')) + '</span>';
      }
      return '<span class="pm-shop-tag">' + selected.length + ' 个店铺</span>';
    }

    /** 重新渲染店铺触发器文本 + 下拉面板 */
    _renderShopTrigger() {
      const txt = this.$('#pmShopTriggerText');
      if (txt) txt.innerHTML = this._renderShopTriggerText();
      const panel = this.$('#pmShopPanel');
      if (panel) panel.innerHTML = this._renderShopPanel();
    }

    /** 渲染店铺下拉面板 */
    _renderShopPanel() {
      if (!this.shops.length) return '<div class="pm-loading">暂无可用店铺</div>';
      const self = this;
      return this.shops.map(function (s) {
        const sid = String(s.store_id || s.storeId || s.id);
        const checked = self.form.shopIds.indexOf(sid) !== -1 ? 'checked' : '';
        const auth = s.auth_status || s.authStatus || 'unknown';
        const authBadge = (auth === 'ok' || auth === 'active')
          ? '<span class="pm-badge pm-badge-ok">已授权</span>'
          : '<span class="pm-badge pm-badge-warn">' + utils.escapeHtml(auth) + '</span>';
        return '<div class="pm-shop-item" data-store="' + utils.escapeHtml(sid) + '">' +
          '<input type="checkbox" ' + checked + ' />' +
          '<div class="pm-shop-item-meta">' +
            '<div class="pm-shop-item-alias">' + utils.escapeHtml(s.alias || sid) + ' ' + authBadge + '</div>' +
            '<div class="pm-shop-item-meta-sub">' + utils.escapeHtml(s.store_group || s.storeGroup || '') + ' · ' + utils.escapeHtml(s.currency || 'RUB') + '</div>' +
          '</div>' +
        '</div>';
      }).join('');
    }

    bindEvents() {
      const self = this;

      // 关闭/取消/遮罩外点击（遮罩不可关闭，对齐毛子 maskClosable:false）
      this.on(this.$('#pmCloseBtn'), 'click', function () { self.hide(); });
      this.on(this.$('#pmCancel'), 'click', function () { self.hide(); });

      // 顶部控件
      this.on(this.$('#pmBrand'), 'change', function (e) { self.form.brand = e.target.value; });
      this.on(this.$('#pmImageOrder'), 'change', function (e) { self.form.imageOrder = e.target.value; });
      this.on(this.$('#pmFollowType'), 'change', function (e) { self.form.followType = e.target.value; });
      this.on(this.$('#pmWatermark'), 'change', function (e) { self.form.watermarkId = Number(e.target.value) || 0; });
      this.on(this.$('#pmModelId'), 'input', function (e) { self.form.modelId = e.target.value; });
      this.on(this.$('#pmModelIdRand'), 'click', function () {
        self.form.modelId = genModelId();
        const inp = self.$('#pmModelId');
        if (inp) inp.value = self.form.modelId;
        self._toast('已生成合并变体 ID', 'ok');
      });
      this.on(this.$('#pmFloatingPrice'), 'input', function (e) {
        const v = e.target.value;
        self.form.floatingPrice = v === '' ? null : Number(v);
      });
      this.on(this.$('#pmCurrency'), 'change', function (e) {
        self.form.currency = e.target.value;
        self._applyCurrencyChange();
      });
      this.on(this.$('#pmShowAllSku'), 'click', function () {
        self.form.showAllSku = !self.form.showAllSku;
        const sw = self.$('#pmShowAllSku');
        if (sw) {
          sw.classList.toggle('pm-switch-on', self.form.showAllSku);
          const inner = sw.querySelector('.pm-switch-inner');
          if (inner) inner.textContent = self.form.showAllSku ? '是' : '否';
        }
        // 重新渲染表格（对齐毛子 ERP：ON 显示所有变体，OFF 只显示主商品 1 行）
        self._applyShowAllSkuChange();
      });
      this.on(this.$('#pmSourcePrice'), 'input', function (e) { self.form.sourcePrice = e.target.value; });
      this.on(this.$('#pmSourceUrl'), 'input', function (e) { self.form.sourceUrl = e.target.value; });
      this.on(this.$('#pmSourceRemark'), 'input', function (e) { self.form.sourceRemark = e.target.value; });

      // 绑定表格行内事件（input 变化同步 + 删除行按钮）
      this._bindRowEvents();

      // 店铺下拉
      this.on(this.$('#pmShopTrigger'), 'click', function (e) {
        e.stopPropagation();
        self.shopDropdownOpen = !self.shopDropdownOpen;
        const trigger = self.$('#pmShopTrigger');
        if (trigger) trigger.classList.toggle('pm-shop-trigger-active', self.shopDropdownOpen);
        self._toggleShopPanel();
      });
      this.on(document, 'click', function (e) {
        if (!self.shopDropdownOpen) return;
        const dd = self.$('#pmShopDropdown');
        if (dd && !dd.contains(e.target)) {
          self.shopDropdownOpen = false;
          const trigger = self.$('#pmShopTrigger');
          if (trigger) trigger.classList.remove('pm-shop-trigger-active');
          self._toggleShopPanel();
        }
      });

      // 表格行编辑
      this._bindTableEvents();

      // 表头批量按钮
      this.on(this.$('#pmTbody'), 'click', function (e) {
        // 删除行
        const delBtn = e.target.closest('[data-act="del"]');
        if (delBtn) {
          const tr = delBtn.closest('tr');
          const idx = parseInt(tr.getAttribute('data-idx'), 10);
          if (!isNaN(idx) && self.rows[idx]) {
            self.rows.splice(idx, 1);
            self.rerender();
          }
        }
      });

      // 批量操作按钮（事件委托）
      this.$$('.pm-th-action-btn').forEach(function (btn) {
        btn.addEventListener('click', function (e) {
          e.stopPropagation();
          const act = btn.getAttribute('data-batch');
          if (act === 'offer_id') self._batchGenerateOfferIds();
          else if (act === 'offer_rule') self._showOfferRulePopover(btn);
          else if (act === 'price') self._showPricePopover(btn, 'price');
          else if (act === 'old_price') self._showPricePopover(btn, 'old_price');
          else if (act === 'weight') self._applyFirstRowWeight();
          else if (act === 'dim') self._applyFirstRowDimensions();
          else if (act === 'barcode') self._batchGenerateBarcodes();
        });
      });

      // 提交
      this.on(this.$('#pmSubmit'), 'click', function () { self._submit(); });
    }

    _bindTableEvents() {
      const self = this;
      this.$$('#pmTbody tr').forEach(function (tr) {
        const idx = parseInt(tr.getAttribute('data-idx'), 10);
        if (isNaN(idx)) return;
        tr.querySelectorAll('input').forEach(function (inp) {
          inp.addEventListener('change', function () {
            const field = inp.getAttribute('data-field');
            const val = inp.type === 'number' ? (Number(inp.value) || 0) : inp.value;
            if (self.rows[idx]) {
              self.rows[idx][field] = val;
              // 实时校验划线价 > 售价
              if (field === 'old_price' || field === 'price') {
                const r = self.rows[idx];
                const oldInp = tr.querySelector('[data-field="old_price"]');
                if (oldInp) {
                  const isErr = Number(r.old_price) > 0 && Number(r.old_price) <= Number(r.price);
                  oldInp.classList.toggle('pm-err', isErr);
                }
              }
            }
          });
        });
      });
    }

    /** 切换店铺下拉面板显示 */
    _toggleShopPanel() {
      let panel = this.$('#pmShopPanel');
      if (this.shopDropdownOpen) {
        if (!panel) {
          panel = document.createElement('div');
          panel.id = 'pmShopPanel';
          panel.className = 'pm-shop-panel';
          panel.innerHTML = this._renderShopPanel();
          this.$('#pmShopDropdown').appendChild(panel);
          this._bindShopPanelEvents();
        } else {
          panel.innerHTML = this._renderShopPanel();
          this._bindShopPanelEvents();
        }
      } else {
        if (panel) panel.remove();
      }
    }

    _bindShopPanelEvents() {
      const self = this;
      const panel = this.$('#pmShopPanel');
      if (!panel) return;
      panel.querySelectorAll('.pm-shop-item').forEach(function (item) {
        item.addEventListener('click', function (e) {
          if (e.target.tagName === 'INPUT') return; // 让 checkbox 自己处理
          const sid = item.getAttribute('data-store');
          const cb = item.querySelector('input[type="checkbox"]');
          if (cb) {
            cb.checked = !cb.checked;
            if (cb.checked) {
              if (self.form.shopIds.indexOf(sid) === -1) self.form.shopIds.push(sid);
            } else {
              self.form.shopIds = self.form.shopIds.filter(function (id) { return id !== sid; });
            }
            self._renderShopTriggerText();
            const txt = self.$('#pmShopTriggerText');
            if (txt) txt.innerHTML = self._renderShopTriggerText();
          }
        });
        const cb = item.querySelector('input[type="checkbox"]');
        if (cb) {
          cb.addEventListener('change', function () {
            const sid = item.getAttribute('data-store');
            if (cb.checked) {
              if (self.form.shopIds.indexOf(sid) === -1) self.form.shopIds.push(sid);
            } else {
              self.form.shopIds = self.form.shopIds.filter(function (id) { return id !== sid; });
            }
            const txt = self.$('#pmShopTriggerText');
            if (txt) txt.innerHTML = self._renderShopTriggerText();
          });
        }
      });
    }

    // ===== 批量操作 =====
    _batchGenerateOfferIds() {
      const self = this;
      this.rows.forEach(function (r) {
        r.offer_id = genOfferId(self.offerIdRule, self.offerIdPrefix, r.sku);
      });
      this.rerender();
      this._toast('已生成货号', 'ok');
    }

    _batchGenerateBarcodes() {
      this.rows.forEach(function (r) {
        r.custom_barcode = genBarcode();
      });
      this.rerender();
      this._toast('已生成条形码', 'ok');
    }

    _applyFirstRowWeight() {
      if (!this.rows.length) return;
      const w = this.rows[0].custom_weight;
      for (let i = 1; i < this.rows.length; i++) {
        this.rows[i].custom_weight = w;
      }
      this.rerender();
      this._toast('已应用首行重量', 'ok');
    }

    _applyFirstRowDimensions() {
      if (!this.rows.length) return;
      const first = this.rows[0];
      for (let i = 1; i < this.rows.length; i++) {
        this.rows[i].custom_depth = first.custom_depth;
        this.rows[i].custom_width = first.custom_width;
        this.rows[i].custom_height = first.custom_height;
      }
      this.rerender();
      this._toast('已应用首行尺寸', 'ok');
    }

    /** 显示货号规则 Popover */
    _mountPopoverInModal(anchor, pop) {
      const modal = this.$('.pm-modal');
      if (!anchor || !pop || !modal) return false;
      modal.appendChild(pop);

      const gap = 8;
      const margin = 12;
      const anchorRect = anchor.getBoundingClientRect();
      const modalRect = modal.getBoundingClientRect();
      const width = pop.offsetWidth || 220;
      const height = pop.offsetHeight || 130;

      let left = anchorRect.right - modalRect.left - width;
      if (left < margin) left = margin;
      if (left + width > modal.clientWidth - margin) left = modal.clientWidth - margin - width;

      const downTop = anchorRect.bottom - modalRect.top + gap;
      const upTop = anchorRect.top - modalRect.top - height - gap;
      let top = downTop + height <= modal.clientHeight - margin ? downTop : upTop;
      if (top < margin) top = margin;

      pop.style.left = Math.round(left) + 'px';
      pop.style.top = Math.round(top) + 'px';
      return true;
    }

    _eventInPopover(e, anchor, pop) {
      const path = typeof e.composedPath === 'function' ? e.composedPath() : [];
      return pop.contains(e.target) || e.target === anchor ||
        path.indexOf(pop) !== -1 || path.indexOf(anchor) !== -1;
    }

    _showOfferRulePopover(anchor) {
      const self = this;
      // 移除已存在的 popover
      const old = this.$('#pmOfferRulePopover');
      if (old) { old.remove(); return; }

      const opts = OFFERID_RULES.map(function (r) {
        return '<option value="' + r.value + '"' + (r.value === self.offerIdRule ? ' selected' : '') + '>' + utils.escapeHtml(r.label) + '</option>';
      }).join('');

      const pop = document.createElement('div');
      pop.id = 'pmOfferRulePopover';
      pop.className = 'pm-popover';
      pop.innerHTML =
        '<div class="pm-popover-row"><label>生成规则</label><select id="pmOfferRuleSel" class="pm-select" style="width:100%;">' + opts + '</select></div>' +
        '<div class="pm-popover-row"><label>自定义前缀</label><input type="text" id="pmOfferPrefixInp" class="pm-input" value="' + utils.escapeHtml(self.offerIdPrefix) + '" style="width:100%;" /></div>' +
        '<div class="pm-popover-row"><button class="pm-btn pm-btn-primary" id="pmOfferRuleApply" style="width:100%;">应用并生成</button></div>';
      anchor.parentElement.style.position = 'relative';
      anchor.parentElement.appendChild(pop);

      this.on(this.$('#pmOfferRuleApply'), 'click', function () {
        self.offerIdRule = self.$('#pmOfferRuleSel').value;
        self.offerIdPrefix = self.$('#pmOfferPrefixInp').value || 'GO';
        lsSet(OFFERID_RULE_KEY, self.offerIdRule);
        lsSet(OFFERID_PREFIX_KEY, self.offerIdPrefix);
        self._batchGenerateOfferIds();
        pop.remove();
      });
      // 点击外部关闭
      setTimeout(function () {
        self.on(document, 'click', function closeOnOut(e) {
          if (!pop.contains(e.target) && e.target !== anchor) {
            pop.remove();
            document.removeEventListener('click', closeOnOut);
          }
        });
      }, 0);
    }

    /** 显示批量价格 Popover */
    _showPricePopover(anchor, type) {
      const self = this;
      const oldId = type === 'price' ? '#pmPricePopover' : '#pmOldPricePopover';
      const old = this.$(oldId);
      if (old) { old.remove(); return; }

      const mode = type === 'price' ? self.batchPriceMode : self.batchOldPriceMode;
      const val = type === 'price' ? self.batchPriceValue : self.batchOldPriceValue;
      const modeOpts = PRICE_MODE_OPTIONS.map(function (o) {
        return '<option value="' + o.value + '"' + (o.value === mode ? ' selected' : '') + '>' + utils.escapeHtml(o.label) + '</option>';
      }).join('');

      const pop = document.createElement('div');
      pop.id = type === 'price' ? 'pmPricePopover' : 'pmOldPricePopover';
      pop.className = 'pm-popover pm-popover-modal';
      pop.innerHTML =
        '<div class="pm-popover-row"><label>设置方式</label><select class="pm-select pm-pop-mode" style="width:100%;">' + modeOpts + '</select></div>' +
        '<div class="pm-popover-row"><label>' + (type === 'price' ? '金额 / 倍数' : '金额 / 倍数（相对售价）') + '</label><input type="number" class="pm-input pm-pop-val" value="' + val + '" step="0.01" style="width:100%;" /></div>' +
        '<div class="pm-popover-row"><button class="pm-btn pm-btn-primary pm-pop-apply" style="width:100%;">应用</button></div>';
      if (!this._mountPopoverInModal(anchor, pop)) {
        anchor.parentElement.style.position = 'relative';
        anchor.parentElement.appendChild(pop);
      }

      this.on(pop.querySelector('.pm-pop-apply'), 'click', function () {
        const m = pop.querySelector('.pm-pop-mode').value;
        const v = Number(pop.querySelector('.pm-pop-val').value) || 0;
        if (type === 'price') {
          self.batchPriceMode = m;
          self.batchPriceValue = v;
          lsSet(BATCH_PRICE_KEY, v);
          self._batchSetPrice(m, v);
        } else {
          self.batchOldPriceMode = m;
          self.batchOldPriceValue = v;
          lsSet(BATCH_OLD_PRICE_KEY, v);
          self._batchSetOldPrice(m, v);
        }
        pop.remove();
      });
      setTimeout(function () {
        self.on(document, 'click', function closeOnOut(e) {
          if (!self._eventInPopover(e, anchor, pop)) {
            pop.remove();
            document.removeEventListener('click', closeOnOut);
          }
        });
      }, 0);
    }

    _batchSetPrice(mode, val) {
      const self = this;
      // 对齐毛子 ERP F 函数
      if (mode === 'fixed') {
        // 固定金额：直接赋值（毛子：Q.price = k.value）
        this.rows.forEach(function (r) {
          r.price = Math.round(val * 100) / 100;
        });
      } else if (mode === 'multiple') {
        // 倍数模式：需校验 val 有效（毛子：typeof k.value == "number" 否则 he.warning）
        if (typeof val !== 'number' || isNaN(val) || val <= 0) {
          self._toast('请输入有效倍数', 'err');
          return;
        }
        let rate = self._getRate() || 0;
        // 对齐毛子 ERP：let Q = 1; 若汇率表无对应 key 则 Q 保持 1（同货币直接用 sell_price × 倍数）
        if (rate <= 0 && (self._ozonUserCurrency || 'RUB') === ((self.form && self.form.currency) || 'CNY')) {
          rate = 1;
        }
        if (rate <= 0) {
          self._toast('汇率未加载，无法按倍数设置售价', 'err');
          return;
        }
        // 毛子公式：U.price = (U.sell_price * Q * k.value).toFixed(2)
        this.rows.forEach(function (r) {
          const sp = Number(r.sell_price) || 0;
          if (sp > 0) {
            r.price = Math.round(sp * rate * val * 100) / 100;
          }
        });
      }
      // 联动划线价（对齐毛子 F 函数末尾）：
      // j.value === "multiple" && W.value !== void 0 && typeof W.value == "number" &&
      //   n.tableData.forEach(Q => { Q.price && (Q.old_price = (Number(Q.price) * W.value).toFixed(2)); });
      // 注意：基于已设的 price（不是 sell_price），用划线价倍数计算
      if (self.batchOldPriceMode === 'multiple' &&
          self.batchOldPriceValue != null &&
          typeof self.batchOldPriceValue === 'number' &&
          !isNaN(self.batchOldPriceValue)) {
        this.rows.forEach(function (r) {
          if (r.price) {
            r.old_price = Math.round(Number(r.price) * self.batchOldPriceValue * 100) / 100;
          }
        });
      }
      this.rerender();
      this._toast('已批量设置售价', 'ok');
    }

    _batchSetOldPrice(mode, val) {
      const self = this;
      // 对齐毛子 ERP ie 函数
      if (mode === 'fixed') {
        // 固定金额：直接赋值（毛子：Q.old_price = W.value）
        this.rows.forEach(function (r) {
          r.old_price = Math.round(val * 100) / 100;
        });
      } else if (mode === 'multiple') {
        // 倍数模式：需校验 val 有效（毛子：typeof W.value == "number" 否则 he.warning）
        if (typeof val !== 'number' || isNaN(val) || val <= 0) {
          self._toast('请输入有效倍数', 'err');
          return;
        }
        let rate = self._getRate() || 0;
        // 对齐毛子 ERP：let Q = 1; 若汇率表无对应 key 则 Q 保持 1（同货币直接用 sell_price × 倍数）
        if (rate <= 0 && (self._ozonUserCurrency || 'RUB') === ((self.form && self.form.currency) || 'CNY')) {
          rate = 1;
        }
        if (rate <= 0) {
          self._toast('汇率未加载，无法按倍数设置划线价', 'err');
          return;
        }
        // 毛子公式：U.old_price = (U.sell_price * Q * W.value).toFixed(2)
        this.rows.forEach(function (r) {
          const sp = Number(r.sell_price) || 0;
          if (sp > 0) {
            r.old_price = Math.round(sp * rate * val * 100) / 100;
          }
        });
      }
      this.rerender();
      this._toast('已批量设置划线价', 'ok');
    }

    // ===== 提交 =====
    async _submit() {
      const self = this;
      if (this.submitting) return;
      if (!this.rows.length) { this._toast('没有可上架的变体', 'err'); return; }
      if (!this.form.shopIds.length) { this._toast('请选择店铺', 'err'); return; }

      // 校验：每行必须有 offer_id 和 price
      for (let i = 0; i < this.rows.length; i++) {
        const r = this.rows[i];
        if (!r.offer_id || String(r.offer_id).trim() === '') {
          this._toast('第 ' + (i + 1) + ' 行货号不能为空', 'err');
          return;
        }
        if (!Number(r.price) || Number(r.price) <= 0) {
          this._toast('第 ' + (i + 1) + ' 行售价必须大于 0', 'err');
          return;
        }
        // 划线价校验：必须 > 售价（如果填写了）
        if (Number(r.old_price) > 0 && Number(r.old_price) <= Number(r.price)) {
          this._toast('第 ' + (i + 1) + ' 行划线价必须大于售价', 'err');
          return;
        }
      }

      this.submitting = true;
      const btn = this.$('#pmSubmit');
      if (btn) { btn.textContent = '提交中…'; btn.disabled = true; }

      try {
        // 持久化表单记忆
        this._saveFormMemory();

        // 取第一行作为产品级默认值（对齐后端 build_ozon_product_item 期望的字段名）
        const firstRow = (this.rows[0] || {});

        // 扫描器常用 combo.color，ERP/Ozon 则要求明确的 10096/10097。
        // 在生成 skuAttrs 前统一键名，并在没有独立颜色名称时保留原始颜色文本。
        const PRODUCT_COLOR_NAME = '商品颜色（Цвет товара）';
        const COLOR_NAME_NAME = '颜色名称（Название цвета）';
        const savedColorNameAttr = (this.productData.attributes || []).find(function (attr) {
          return String(attr && (attr.id || attr.attrId || attr.attribute_id) || '') === '10097';
        });
        this.rows.forEach(function (row, rowIndex) {
          const combo = Object.assign({}, row.combo || {});
          let productColor = combo[PRODUCT_COLOR_NAME] || '';
          let colorName = combo[COLOR_NAME_NAME] || '';
          Object.keys(combo).forEach(function (key) {
            const normalized = String(key).toLowerCase();
            const isColorName = /название цвета|color name|颜色名称/.test(normalized);
            const isProductColor = !isColorName && /(^color$|^colour$|^цвет$|商品颜色|颜色$)/.test(normalized);
            if (isColorName && !colorName) colorName = combo[key];
            if (isProductColor && !productColor) productColor = combo[key];
            if ((isColorName || isProductColor) && key !== PRODUCT_COLOR_NAME && key !== COLOR_NAME_NAME) {
              delete combo[key];
            }
          });
          if (!colorName && savedColorNameAttr) {
            const values = Array.isArray(savedColorNameAttr.values) ? savedColorNameAttr.values : [];
            colorName = savedColorNameAttr.value || (values[rowIndex] && values[rowIndex].value) || '';
          }
          if (!colorName) colorName = productColor;
          if (productColor) combo[PRODUCT_COLOR_NAME] = productColor;
          if (colorName) combo[COLOR_NAME_NAME] = colorName;
          row.combo = combo;
        });

        // 从 rows 的 combo 字段聚合生成 skuAttrs（销售属性定义）
        // 若 productData 已有 skuAttrs（如 1688 采集数据），则优先使用原有定义。
        const hasExistSkuAttrs = Array.isArray(this.productData.skuAttrs)
          && this.productData.skuAttrs.length > 0;
        let generatedSkuAttrs = [];
        if (!hasExistSkuAttrs) {
          const skuAttrsMap = {};
          (this.rows || []).forEach(function (r) {
            const combo = r.combo || {};
            Object.keys(combo).forEach(function (key) {
              const val = combo[key];
              if (val === undefined || val === null || String(val).trim() === '') return;
              if (!skuAttrsMap[key]) skuAttrsMap[key] = [];
              if (skuAttrsMap[key].indexOf(val) === -1) skuAttrsMap[key].push(val);
            });
          });
          generatedSkuAttrs = Object.keys(skuAttrsMap).map(function (name) {
            const nameLower = name.toLowerCase();
            let skuType = 'text';
            let attrCategory = 'sales';
            let attrId = null;
            let dictionaryId = null;
            if (name === PRODUCT_COLOR_NAME) {
              skuType = 'color';
              attrId = 10096;
              dictionaryId = 1494;
            } else if (name === COLOR_NAME_NAME) {
              skuType = 'text';
              attrCategory = 'info';
            }
            return {
              name: name,
              values: skuAttrsMap[name],
              attrCategory: attrCategory,
              skuType: skuType,
              attrId: attrId || (name === COLOR_NAME_NAME ? 10097 : null),
              dictionaryId: dictionaryId,
              required: false,
              description: '',
            };
          });

          // 多行且无可解析规格时，保留每个变体的唯一标识。
          if (generatedSkuAttrs.length === 0 && this.rows.length > 1) {
            const variantValues = this.rows.map(function (r, idx) {
              return r.offer_id || r.title || ('SKU-' + (idx + 1));
            });
            generatedSkuAttrs = [{
              name: '变体',
              values: variantValues,
              attrCategory: 'sales',
              skuType: 'text',
              attrId: null,
              required: false,
              description: '',
            }];
            this.rows.forEach(function (r, idx) {
              if (!r.combo || Object.keys(r.combo).length === 0) {
                r.combo = { '变体': variantValues[idx] };
              }
            });
          }
        }

        // 构造提交数据
        const preparedSkus = this.rows.map(function (r) {
          const platformSku = r.offer_id || r.offerId || r.skuCode || '';
          const sourceSku = r.sku || r.sourceSku || '';
          return {
            offerId: platformSku,
            skuCode: platformSku,
            sku: platformSku,
            sourceSku: sourceSku,
            price: r.price,
            oldPrice: r.old_price,
            weight: r.custom_weight,
            length: r.custom_depth,
            width: r.custom_width,
            height: r.custom_height,
            barcode: r.custom_barcode,
            title: r.title,
            variantLabel: r.variant_label || r.variantLabel || '',
            stock: r.stock || 0,
            combo: r.combo || {},
            attributes: r.combo || {},
            images: r.images || [],
            coverImage: r.cover_image || (Array.isArray(r.images) ? r.images[0] : ''),
          };
        });
        const preparedRows = this.rows.map(function (r) {
          return {
            cover_image: r.cover_image,
            images: r.images || [],
            title: r.title,
            variant_label: r.variant_label || r.variantLabel || '',
            sku: r.sku,
            offer_id: r.offer_id,
            sell_price: r.sell_price,
            price: r.price,
            old_price: r.old_price,
            custom_weight: r.custom_weight,
            custom_depth: r.custom_depth,
            custom_width: r.custom_width,
            custom_height: r.custom_height,
            custom_barcode: r.custom_barcode,
            combo: r.combo || {},
            attributes: r.combo || {},
          };
        });
        const preparedSkuAttrs = hasExistSkuAttrs
          ? this.productData.skuAttrs.map(function (attr) { return Object.assign({}, attr); })
          : generatedSkuAttrs;
        // 历史 skuAttrs 可能存在但缺少颜色定义；按 attrId 合并本次规范化结果。
        generatedSkuAttrs.forEach(function (generated) {
          const exists = preparedSkuAttrs.some(function (attr) {
            return (generated.attrId && String(attr.attrId || attr.id || '') === String(generated.attrId)) ||
              attr.name === generated.name;
          });
          if (!exists) preparedSkuAttrs.push(generated);
        });
        [
          { name: PRODUCT_COLOR_NAME, attrId: 10096, dictionaryId: 1494, skuType: 'color', attrCategory: 'sales' },
          { name: COLOR_NAME_NAME, attrId: 10097, skuType: 'text', attrCategory: 'info' },
        ].forEach(function (definition) {
          const values = self.rows.map(function (row) { return row.combo && row.combo[definition.name]; })
            .filter(function (value, index, all) { return value && all.indexOf(value) === index; });
          if (!values.length) return;
          const existing = preparedSkuAttrs.find(function (attr) {
            return String(attr.attrId || attr.id || '') === String(definition.attrId);
          });
          if (existing) {
            existing.name = definition.name;
            existing.attrId = definition.attrId;
            existing.skuType = definition.skuType;
            existing.attrCategory = definition.attrCategory;
            existing.values = values;
            if (definition.dictionaryId) existing.dictionaryId = definition.dictionaryId;
          } else {
            preparedSkuAttrs.push(Object.assign({ values: values, required: false, description: '' }, definition));
          }
        });
        const sourceUrl = this.productData.sourceUrl || this.productData.originalUrl || location.href;
        const publishBrand = this.form.brand === 'copy'
          ? (this.productData.brand || '')
          : 'Нет бренда';

        const payload = Object.assign({}, this.productData, {
          // 表单设置（对齐毛子 c.value）
          scene: 'plugin',
          shop_ids: this.form.shopIds,
          brand: publishBrand,
          brandMode: this.form.brand,
          image_order: this.form.imageOrder,
          follow_type: this.form.followType,
          watermark_id: this.form.watermarkId,
          model_id: this.form.modelId,
          publishMode: this.form.modelId ? 'merge' : 'split',
          floating_price: this.form.floatingPrice,
          source_price: this.form.sourcePrice,
          source_url: this.form.sourceUrl,
          source_remark: this.form.sourceRemark,
          sourceUrl: sourceUrl,
          originalUrl: this.productData.originalUrl || sourceUrl,
          currency: this.form.currency,
          currencyCode: this.form.currency,
          show_all_sku: this.form.showAllSku,
          // 编辑模式标志（对齐 maozi editFollowProductFromList）
          // true 时后端可走更新逻辑而非新建（如存在已有商品则更新而非重复创建）
          edit_mode: this._editMode,

          // 产品级字段（取第一行作为默认值）
          // 后端 build_ozon_product_item 从 product 顶层读取这些字段：
          //   mergeCode → offer_id, price → price, oldPrice → old_price,
          //   weight → weight, length → depth, width → width, height → height,
          //   barcode → barcode
          mergeCode: firstRow.offer_id || '',
          price: firstRow.price || 0,
          oldPrice: firstRow.old_price || '',
          weight: firstRow.custom_weight || 0,
          length: firstRow.custom_depth || 0,
          width: firstRow.custom_width || 0,
          height: firstRow.custom_height || 0,
          barcode: firstRow.custom_barcode || '',

          // SKU 多规格数据（对齐后端 build_ozon_skus 期望的 skus 字段）
          // 后端 build_ozon_skus 读取的字段：offerId/skuCode/offer_id, price, oldPrice,
          //   stock, weight, length, width, height, barcode, combo, images
          skus: preparedSkus,

          // 保留 rows 用于前端展示和后端兼容
          // 对齐毛子 ERP rows 结构：每行含 cover_image（主图）+ images（图片数组）
          rows: preparedRows,

          // SKU 销售属性定义（供 ERP 后台 generateSkuTable 生成多规格行）
          // 优先使用 productData 已有的 skuAttrs（1688 采集数据），
          // 否则用从 combo 聚合生成的 skuAttrs（Ozon 采集数据）
          skuAttrs: preparedSkuAttrs,
          // 四套兼容字段必须来自同一批弹窗行，避免后端再次命中过期 variants。
          variants: preparedSkus,
          skuList: preparedSkus,

          source: 'extension-publish-modal',
        });

        // 1) 采集商品到 ERP（含完整变体数据）
        // 后端 collect_product 透传所有字段到 Product 表
        const collectResp = await ApiClient.collectProduct(payload);
        if (!ApiClient.isOk(collectResp)) {
          throw new Error(collectResp.msg || '采集失败');
        }
        // 注意：必须使用 collectResp.data.id（后端主键，形如 "id_xxxxxxxxxx"），
        // 不能用 collectResp.data.productId（那是源平台 Ozon 的商品 ID，如 "15502"），
        // 否则后端 Product.find_by_id() 找不到商品，导致 "未找到有效的商品" 错误。
        const productId = collectResp.data && collectResp.data.id;
        if (!productId) throw new Error('未拿到 productId');

        // 2) 对每个选中的店铺创建发布任务
        // 后端 PublishService.create_task 异步执行：
        //   图片预处理 → build_ozon_product_item → 调用 Ozon /v3/product/import API
        // 浮动价格（对齐 maozi）：每个店铺在 [0, floatingPrice] 区间随机加价
        //   避免多店铺同款完全同价被 Ozon 判定重复铺货
        const floatMax = Number(this.form.floatingPrice) || 0;
        const results = [];
        for (const sid of this.form.shopIds) {
          // 每个店铺生成独立的随机浮动额（保留两位小数）
          const priceOffset = floatMax > 0
            ? Math.round(Math.random() * floatMax * 100) / 100
            : 0;
          const pubResp = await ApiClient.publishProducts({
            storeId: sid,
            productIds: [productId],
            platform: 'ozon',
            publishMode: this.form.modelId ? 'merge' : 'split',
            // 透传浮动额给后端，build_ozon_product_item 在 price 基础上 +price_offset
            price_offset: priceOffset,
            edit_mode: this._editMode,
          });
          let finalResult = null;
          const publishData = ApiClient.data(pubResp, null) || {};
          const taskId = publishData.taskIds && publishData.taskIds[0];
          if (ApiClient.isOk(pubResp) && taskId) {
            finalResult = await this._waitForPublishTask(taskId, 15000);
          }
          results.push({
            storeId: sid,
            ok: ApiClient.isOk(pubResp) && (!finalResult || finalResult.ok),
            pending: !!(finalResult && finalResult.pending),
            msg: finalResult && !finalResult.ok
              ? ((finalResult.data && (finalResult.data.error || finalResult.data.message)) || 'Ozon publish failed')
              : pubResp.msg,
            data: finalResult ? finalResult.data : pubResp.data,
          });
        }

        const okCount = results.filter(function (r) { return r.ok; }).length;
        const failCount = results.length - okCount;

        const pendingCount = results.filter(function (r) { return r.pending; }).length;
        if (okCount > 0 && failCount === 0 && pendingCount > 0) {
          this._toast('任务已提交，Ozon 仍在处理', 'ok');
        } else if (okCount > 0 && failCount === 0) {
          this._toast((this._editMode ? '已编辑并上架到 ' : '已上架到 ') + okCount + ' 个店铺', 'ok');
          EventBus.emit(EventBus.EVENTS.PUBLISH_DONE, { storeIds: this.form.shopIds, productId: productId, editMode: this._editMode });
          setTimeout(function () { self.hide(); }, 1000);
        } else if (okCount > 0 && failCount > 0) {
          this._toast('部分成功：' + okCount + ' 成功，' + failCount + ' 失败', 'err');
        } else {
          const firstErr = (results[0] && results[0].msg) || '发布失败';
          this._toast('上架失败：' + firstErr, 'err');
        }
      } catch (err) {
        console.error('[GeekOzon] publish submit error:', err);
        this._toast('上架失败: ' + err.message, 'err');
      } finally {
        this.submitting = false;
        const btn = this.$('#pmSubmit');
        if (btn) { btn.textContent = this._editMode ? '保存编辑并上架' : '一键上架至 OZON'; btn.disabled = false; }
      }
    }

    /** 简易 toast */
    async _waitForPublishTask(taskId, timeoutMs) {
      const deadline = Date.now() + (timeoutMs || 90000);
      let last = null;
      while (Date.now() < deadline) {
        const response = await ApiClient.fetchPublishStatus(taskId);
        if (ApiClient.isOk(response)) {
          last = ApiClient.data(response, null) || {};
          const status = String(last.status || last.publishStatus || '').toLowerCase();
          if (['success', 'published', 'published_with_errors', 'failed', 'error', 'skipped'].indexOf(status) >= 0) {
            return {
              done: true,
              ok: ['success', 'published', 'published_with_errors'].indexOf(status) >= 0,
              data: last,
            };
          }
        }
        await new Promise(function (resolve) { setTimeout(resolve, 2000); });
      }
      return { done: false, ok: true, pending: true, data: last };
    }

    _toast(msg, type) {
      const self = this;
      const el = document.createElement('div');
      el.className = 'pm-toast' + (type === 'ok' ? ' pm-toast-ok' : type === 'err' ? ' pm-toast-err' : '');
      el.textContent = msg;
      this.shadow.appendChild(el);
      setTimeout(function () { if (el.parentNode) el.parentNode.removeChild(el); }, 2400);
    }
  }

  /** 单例 */
  let _instance = null;
  function getInstance() {
    if (!_instance) _instance = new PublishModal();
    return _instance;
  }

  /** 全局入口 */
  window.__geekOzonOpenPublishModal = function (productData) {
    const inst = getInstance();
    inst.open(productData);
    return inst;
  };

  // 挂到命名空间
  G.features.publish = G.features.publish || {};
  G.features.publish.PublishModal = PublishModal;
  G.features.publish.open = window.__geekOzonOpenPublishModal;
  G.markLoaded('publish-modal');
  console.log('[GeekOzon] publish-modal 已加载（v2 复刻版）');
})();
