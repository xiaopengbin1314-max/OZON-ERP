/**
 * GeekOzon 扩展 - 基础 UI 元素 + SVG 图标系统（v2 现代 SaaS）
 * 提供：Button / Tag / Icon / Divider / Empty / Loading / Input / Select / Checkbox
 * 图标系统：内联 SVG（Lucide 风格，stroke 1.75，currentColor），替代 v1 的 emoji
 *
 * 用法：
 *   const B = GeekOzon.components;
 *   shadow.innerHTML = B.PrimitiveStyles + B.Button('保存', {type:'primary', icon:B.Icon('check',14)}) + B.Tag('热销');
 *   B.Toast.success('ok');
 */
;(function () {
  'use strict';

  const G = window.GeekOzon;
  if (!G || G.isLoaded('ui-primitives')) return;

  const Tokens = G.components.DesignTokens;
  const esc = G.utils.escapeHtml;

  // ===== SVG 图标 path 数据（Lucide 风格，24x24 viewBox，stroke-based） =====
  // 来源：Lucide Icons (MIT) https://lucide.dev
  const ICON_PATHS = {
    check: 'M20 6 9 17l-5-5',
    close: 'M18 6 6 18M6 6l12 12',
    edit: 'M12 20h9M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4Z',
    trash: 'M3 6h18M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2M10 11v6M14 11v6',
    search: 'm21 21-4.3-4.3M19 11a8 8 0 1 1-16 0 8 8 0 0 1 16 0Z',
    star: 'M12 2 15.09 8.26 22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14l-5-4.87 6.91-1.01L12 2Z',
    warn: 'M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0ZM12 9v4M12 17h.01',
    info: 'M12 22a10 10 0 1 1 0-20 10 10 0 0 1 0 20ZM12 16v-4M12 8h.01',
    plus: 'M12 5v14M5 12h14',
    minus: 'M5 12h14',
    arrowRight: 'M5 12h14M12 5l7 7-7 7',
    arrowLeft: 'M19 12H5M12 19l-7-7 7-7',
    arrowUp: 'M12 19V5M5 12l7-7 7 7',
    arrowDown: 'M12 5v14M19 12l-7 7-7-7',
    chevronRight: 'm9 18 6-6-6-6',
    chevronLeft: 'm15 18-6-6 6-6',
    chevronDown: 'm6 9 6 6 6-6',
    chevronUp: 'm18 15-6-6-6 6',
    eye: 'M2 12s3-7 10-7 10 7 10 7-3 7-10 7-10-7-10-7ZM12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6Z',
    copy: 'M8 8H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h8a2 2 0 0 0 2-2v-2M9 8a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2h-2',
    chart: 'M3 3v18h18M18 17V9M13 17V5M8 17v-3',
    box: 'M21 8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16ZM3.27 6.96 12 12.01l8.73-5.05M12 22.08V12',
    fire: 'M12 22c4.97 0 7-3.58 7-7 0-2.5-1.5-4.5-3-6-2-2-2-4-2-4s-2 1-2 4c0 2 0 3-1 3s-1-1-1-2c-1 1-2 3-2 5 0 3.42 2.03 7 7 7Z',
    clock: 'M12 22a10 10 0 1 1 0-20 10 10 0 0 1 0 20ZM12 6v6l4 2',
    tag: 'M12.586 2.586A2 2 0 0 0 11.172 2H4a2 2 0 0 0-2 2v7.172a2 2 0 0 0 .586 1.414l8.704 8.704a2.426 2.426 0 0 0 3.42 0l6.58-6.58a2.426 2.426 0 0 0 0-3.42zM7 7.01a.01.01 0 1 1-.02 0 .01.01 0 0 1 .02 0',
    gear: 'M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2zM12 8a4 4 0 1 1 0 8 4 4 0 0 1 0-8',
    user: 'M19 21v-2a4 4 0 0 0-4-4H9a4 4 0 0 0-4 4v2M12 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8',
    shop: 'M2 7 3 3h18l1 4M4 7v13a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1V7M4 7h16M9 11v3M15 11v3',
    cart: 'M2 3h2l2.4 12.4a2 2 0 0 0 2 1.6h7.7a2 2 0 0 0 2-1.6L21 7H5M9 21a1 1 0 1 0 0-2 1 1 0 0 0 0 2M17 21a1 1 0 1 0 0-2 1 1 0 0 0 0 2',
    link: 'M9 17H7A5 5 0 0 1 7 7h2M15 7h2a5 5 0 0 1 0 10h-2M8 12h8',
    lock: 'M5 11h14a2 2 0 0 1 2 2v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-7a2 2 0 0 1 2-2zM7 11V7a5 5 0 0 1 10 0v4',
    loader: 'M12 2v4M12 18v4M4.93 4.93l2.83 2.83M16.24 16.24l2.83 2.83M2 12h4M18 12h4M4.93 19.07l2.83-2.83M16.24 7.76l2.83-2.83',
    refresh: 'M3 12a9 9 0 0 1 15-6.7L21 8M21 3v5h-5M21 12a9 9 0 0 1-15 6.7L3 16M3 21v-5h5',
    send: 'm22 2-7 20-4-9-9-4ZM22 2 11 13',
    download: 'M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M7 10l5 5 5-5M12 15V3',
    upload: 'M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M17 8l-5-5-5 5M12 3v12',
    external: 'M15 3h6v6M10 14 21 3M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6',
    menu: 'M4 6h16M4 12h16M4 18h16',
    filter: 'M22 3H2l8 9.46V19l4 2v-8.54L22 3Z',
    settings: 'M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2zM12 8a4 4 0 1 1 0 8 4 4 0 0 1 0-8',
    rub: 'M9 4v16M9 4h4a4 4 0 0 1 0 8H9M9 12h5l4 8',
    heart: 'M19 14c1.49-1.46 3-3.21 3-5.5A5.5 5.5 0 0 0 16.5 3c-1.76 0-3 .5-4.5 2-1.5-1.5-2.74-2-4.5-2A5.5 5.5 0 0 0 2 8.5c0 2.3 1.5 4.05 3 5.5l7 7Z',
    package: 'm7.5 4.27 9 5.15M21 8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16Zm-9 4L3 8m9 4 9-4M12 22V12',
    sparkle: 'M12 3v3M12 18v3M5.6 5.6l2.1 2.1M16.3 16.3l2.1 2.1M3 12h3M18 12h3M5.6 18.4l2.1-2.1M16.3 7.7l2.1-2.1M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8',
    calculator: 'M4 2a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V4a2 2 0 0 0-2-2H4ZM8 6h8M8 10h.01M12 10h.01M16 10h.01M8 14h.01M12 14h.01M16 14h.01M8 18h.01M12 18h4',
    list: 'M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01',
    grid: 'M3 3h7v7H3zM14 3h7v7h-7zM14 14h7v7h-7zM3 14h7v7H3z',
    bell: 'M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9M10.3 21a1.94 1.94 0 0 0 3.4 0',
    save: 'M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2zM17 21v-8H7v8M7 3v5h8',
    globe: 'M12 22a10 10 0 1 1 0-20 10 10 0 0 1 0 20ZM2 12h20M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10',
  };

  /** 拼接属性字符串 */
  function attrs(obj) {
    if (!obj) return '';
    let s = '';
    for (const k in obj) {
      if (obj[k] == null || obj[k] === false) continue;
      if (obj[k] === true) { s += ' ' + k; continue; }
      s += ' ' + k + '="' + esc(obj[k]) + '"';
    }
    return s;
  }

  /**
   * SVG 线性图标（Lucide 风格）
   * @param {string} name - 图标名（见 ICON_PATHS），未匹配返回空字符串
   * @param {number|string} [size=16] - 图标尺寸 px
   * @param {string} [className] - 额外类名
   * @returns {string} SVG HTML 字符串
   */
  function Icon(name, size, className) {
    const path = ICON_PATHS[name];
    if (!path) return '';
    const s = size || 16;
    const cls = 'go-icon' + (className ? ' ' + className : '');
    return '<svg class="' + cls + '" width="' + s + '" height="' + s + '" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + path + '</svg>';
  }

  /** 拼接图标 + 文本（图标在前，自动间距） */
  function withIcon(iconName, text, size) {
    const svg = Icon(iconName, size);
    if (!svg) return esc(text);
    return '<span class="go-icon-text">' + svg + '<span class="go-icon-text-label">' + esc(text) + '</span></span>';
  }

  /**
   * 按钮
   * @param {string} text - 按钮文字
   * @param {object} [opts] - { type:'primary'|'secondary'|'danger'|'ghost', id, className, size:'sm'|'md', disabled, icon, iconRight, onClick, attrs }
   */
  function Button(text, opts) {
    opts = opts || {};
    const type = opts.type || 'primary';
    const typeClass = ({ primary: 'go-btn-primary', secondary: 'go-btn-secondary', danger: 'go-btn-danger', ghost: 'go-btn-ghost' })[type] || 'go-btn-primary';
    const sizeClass = opts.size === 'sm' ? ' go-btn-sm' : '';
    const cls = 'go-btn ' + typeClass + sizeClass + (opts.className ? ' ' + opts.className : '');
    const extra = {};
    if (opts.id) extra.id = opts.id;
    if (opts.disabled) extra.disabled = 'disabled';
    if (opts.attrs) Object.assign(extra, opts.attrs);
    if (opts.onClick) extra['data-action'] = opts.onClick;
    const iconSvg = opts.icon ? Icon(opts.icon, opts.size === 'sm' ? 13 : 14, 'go-btn-icon') : '';
    const textHtml = text != null ? '<span class="go-btn-text">' + esc(text) + '</span>' : '';
    return '<button class="' + cls + '"' + attrs(extra) + '>' + iconSvg + textHtml + '</button>';
  }

  /**
   * 标签（胶囊式，浅底 + 同色文字）
   * @param {string} text - 标签文字
   * @param {string} [color] - 自定义颜色（hex/rgba），不传用主色
   * @param {object} [opts] - { icon }
   */
  function Tag(text, color, opts) {
    opts = opts || {};
    const c = color || Tokens.color.primary;
    const iconHtml = opts.icon ? Icon(opts.icon, 11) : '';
    return '<span class="go-tag" style="background:' + c + '1a;color:' + c + ';border-color:' + c + '33;">' + iconHtml + esc(text) + '</span>';
  }

  /** 分隔线 */
  function Divider() {
    return '<div class="go-divider"></div>';
  }

  /** 空状态（SVG 图标，可选自定义） */
  function Empty(text, opts) {
    opts = opts || {};
    const icon = opts.icon ? Icon(opts.icon, 28, 'go-empty-icon') : Icon('package', 28, 'go-empty-icon');
    return '<div class="go-empty">' + icon + '<span class="go-empty-text">' + esc(text || '暂无数据') + '</span></div>';
  }

  /** 加载状态（旋转 SVG） */
  function Loading(text) {
    const spinner = '<svg class="go-loading-spinner" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M12 2v4" opacity="1"/><path d="M12 18v4" opacity="0.4"/><path d="M4.93 4.93l2.83 2.83" opacity="0.7"/><path d="M16.24 16.24l2.83 2.83" opacity="0.3"/><path d="M2 12h4" opacity="0.85"/><path d="M18 12h4" opacity="0.25"/><path d="M4.93 19.07l2.83-2.83" opacity="0.55"/><path d="M16.24 7.76l2.83-2.83" opacity="0.15"/></svg>';
    return '<div class="go-loading">' + spinner + '<span class="go-loading-text">' + esc(text || '加载中...') + '</span></div>';
  }

  /**
   * 输入框
   * @param {object} [opts] - { type, placeholder, value, id, className, disabled, readonly, icon, attrs }
   */
  function Input(opts) {
    opts = opts || {};
    const type = opts.type || 'text';
    const extra = { type: type };
    if (opts.id) extra.id = opts.id;
    if (opts.placeholder) extra.placeholder = opts.placeholder;
    if (opts.value != null) extra.value = opts.value;
    if (opts.disabled) extra.disabled = 'disabled';
    if (opts.readonly) extra.readonly = 'readonly';
    if (opts.attrs) Object.assign(extra, opts.attrs);
    const cls = 'go-input' + (opts.icon ? ' go-input-with-icon' : '') + (opts.className ? ' ' + opts.className : '');
    const iconHtml = opts.icon ? '<span class="go-input-icon">' + Icon(opts.icon, 15) + '</span>' : '';
    if (opts.icon) {
      return '<div class="go-input-wrap">' + iconHtml + '<input class="' + cls + '"' + attrs(extra) + ' /></div>';
    }
    return '<input class="' + cls + '"' + attrs(extra) + ' />';
  }

  /**
   * 下拉框
   * @param {object} [opts] - { id, className, value, disabled, attrs }
   * @param {Array} [options] - 选项数组：['a','b'] 或 [{value,text,selected}]
   */
  function Select(opts, options) {
    opts = opts || {};
    options = options || [];
    const extra = {};
    if (opts.id) extra.id = opts.id;
    if (opts.disabled) extra.disabled = 'disabled';
    if (opts.attrs) Object.assign(extra, opts.attrs);
    const cls = 'go-select' + (opts.className ? ' ' + opts.className : '');
    let html = '<select class="' + cls + '"' + attrs(extra) + '>';
    for (let i = 0; i < options.length; i++) {
      const o = options[i];
      if (typeof o === 'string') {
        const sel = (opts.value != null && String(opts.value) === o) ? ' selected' : '';
        html += '<option value="' + esc(o) + '"' + sel + '>' + esc(o) + '</option>';
      } else {
        const v = o.value != null ? o.value : o.text;
        const sel = (o.selected || (opts.value != null && String(opts.value) === String(v))) ? ' selected' : '';
        html += '<option value="' + esc(v) + '"' + sel + '>' + esc(o.text != null ? o.text : v) + '</option>';
      }
    }
    html += '</select>';
    return html;
  }

  /** 复选框 */
  function Checkbox(label, checked) {
    const c = checked ? ' checked' : '';
    return '<label class="go-checkbox"><input type="checkbox"' + c + ' /><span class="go-checkbox-box">' + Icon('check', 11) + '</span><span class="go-checkbox-label">' + esc(label || '') + '</span></label>';
  }

  /**
   * 基础元素样式表（含 buttonStyles + 各 primitive 样式）
   * 使用方需在 Shadow DOM 内注入一次
   */
  const PrimitiveStyles = `
    ${Tokens.buttonStyles}
    .go-btn-sm { padding: 4px 10px; font-size: ${Tokens.font.sizeSm}; }
    .go-btn-sm .go-btn-icon { width: 13px; height: 13px; }
    .go-btn:disabled .go-btn-icon { opacity: 0.5; }

    .go-icon { display: inline-flex; vertical-align: middle; flex-shrink: 0; }
    .go-icon-text { display: inline-flex; align-items: center; gap: ${Tokens.space.sm}; }
    .go-icon-text-label { line-height: 1; }

    .go-tag {
      display: inline-flex; align-items: center; gap: 4px;
      padding: 2px 8px; border-radius: ${Tokens.radius.pill};
      font-size: ${Tokens.font.sizeXs}; font-weight: ${Tokens.font.weightSemi};
      border: 1px solid transparent; line-height: 1.4;
    }
    .go-tag .go-icon { width: 11px; height: 11px; }

    .go-divider { width: 100%; height: 1px; background: ${Tokens.color.border}; margin: ${Tokens.space.md} 0; }

    .go-empty {
      display: flex; flex-direction: column; align-items: center; justify-content: center;
      gap: ${Tokens.space.sm}; padding: ${Tokens.space.xxl} ${Tokens.space.base};
      color: ${Tokens.color.textMuted}; font-size: ${Tokens.font.sizeLg};
    }
    .go-empty .go-icon { color: ${Tokens.color.textMuted}; opacity: 0.55; }

    .go-loading {
      display: flex; align-items: center; justify-content: center; gap: ${Tokens.space.sm};
      padding: ${Tokens.space.lg}; color: ${Tokens.color.textSecondary}; font-size: ${Tokens.font.sizeLg};
    }
    .go-loading-spinner { color: ${Tokens.color.primary}; animation: goSpin 0.8s linear infinite; }

    .go-input, .go-select {
      padding: 7px 11px; border: 1px solid ${Tokens.color.borderStrong};
      border-radius: ${Tokens.radius.base};
      font-size: ${Tokens.font.sizeLg}; color: ${Tokens.color.textPrimary};
      background: ${Tokens.color.bgBase};
      transition: border-color ${Tokens.animation.durationFast} ${Tokens.animation.easing}, box-shadow ${Tokens.animation.durationFast} ${Tokens.animation.easing};
      width: 100%;
    }
    .go-input:hover, .go-select:hover { border-color: ${Tokens.color.textMuted}; }
    .go-input:focus, .go-select:focus { border-color: ${Tokens.color.primary}; box-shadow: ${Tokens.shadow.focus}; }
    .go-input:disabled, .go-select:disabled { background: ${Tokens.color.bgMuted}; cursor: not-allowed; color: ${Tokens.color.textMuted}; }
    .go-input-wrap { position: relative; display: block; }
    .go-input-with-icon { padding-left: 32px; }
    .go-input-icon { position: absolute; left: 9px; top: 50%; transform: translateY(-50%); color: ${Tokens.color.textMuted}; pointer-events: none; display: inline-flex; }

    .go-checkbox {
      display: inline-flex; align-items: center; gap: ${Tokens.space.sm};
      cursor: pointer; user-select: none;
      font-size: ${Tokens.font.sizeLg}; color: ${Tokens.color.textPrimary};
    }
    .go-checkbox input { display: none; }
    .go-checkbox-box {
      width: 16px; height: 16px; border: 1.5px solid ${Tokens.color.borderStrong};
      border-radius: ${Tokens.radius.sm}; background: ${Tokens.color.bgBase};
      position: relative; flex-shrink: 0;
      display: flex; align-items: center; justify-content: center;
      transition: all ${Tokens.animation.durationFast} ${Tokens.animation.easing};
    }
    .go-checkbox-box .go-icon { color: transparent; width: 11px; height: 11px; transition: color ${Tokens.animation.durationFast} ${Tokens.animation.easing}; }
    .go-checkbox input:checked + .go-checkbox-box {
      background: ${Tokens.color.primary}; border-color: ${Tokens.color.primary};
    }
    .go-checkbox input:checked + .go-checkbox-box .go-icon { color: ${Tokens.color.textInverse}; }
    .go-checkbox-label { line-height: 1.4; }
  `;

  // 暴露到 components 命名空间
  G.components.Button = Button;
  G.components.Tag = Tag;
  G.components.Icon = Icon;
  G.components.withIcon = withIcon;
  G.components.Divider = Divider;
  G.components.Empty = Empty;
  G.components.Loading = Loading;
  G.components.Input = Input;
  G.components.Select = Select;
  G.components.Checkbox = Checkbox;
  G.components.PrimitiveStyles = PrimitiveStyles;
  // 暴露图标 path 表，供业务方直接用 Icon() 生成自定义 SVG
  G.components.Icons = ICON_PATHS;

  G.markLoaded('ui-primitives');
})();
