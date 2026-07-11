/**
 * GeekOzon 扩展 - 悬浮折叠工具栏（v3）
 * 左侧悬浮 FAB 按钮，点击展开操作面板
 * 收起态：44px 圆形 FAB（package 图标）
 * 展开态：FAB（chevron-left 图标）+ 胶囊面板 [采集 / ERP / 设置]
 * 状态持久化到 localStorage
 */
;(function () {
  'use strict';

  const G = window.GeekOzon;
  if (!G || G.isLoaded('floating-bar')) return;

  const DomUtils = G.core.DomUtils;
  const Tokens = G.components && G.components.DesignTokens;
  const ApiClient = G.core && G.core.ApiClient;

  /** ERP 后端地址 */
  const ERP_URL = 'http://localhost:5000/';

  /** 宿主元素 ID */
  const HOST_ID = 'geekozon-floating-bar-host';

  /** 折叠状态持久化键 */
  const LS_COLLAPSED_KEY = 'geekOzon-fb-collapsed';

  /** 位置持久化键 */
  const LS_POSITION_KEY = 'geekOzon-fb-position';

  /** 拖动阈值（移动超过此距离才视为拖动，避免误触发点击） */
  const DRAG_THRESHOLD = 5;

  /** FAB 尺寸（用于边界保护） */
  const FAB_SIZE = 44;

  /** 浮动栏实例（单例） */
  let instance = null;

  /**
   * 悬浮折叠工具栏
   */
  class FloatingBar {
    constructor() {
      this.host = null;
      this.shadow = null;
      this.container = null;
      this.collapsed = this._loadState();
      this.collecting = false;
      this._unsubRouter = null;
      this._outsideClickHandler = null;
      // 拖动相关状态
      this._dragging = false;
      this._dragStartX = 0;
      this._dragStartY = 0;
      this._hostStartX = 0;
      this._hostStartY = 0;
      this._suppressClick = false;
      this._dragMoveHandler = null;
      this._dragEndHandler = null;
    }

    /** 读取持久化折叠状态 */
    _loadState() {
      try {
        return localStorage.getItem(LS_COLLAPSED_KEY) !== 'expanded';
      } catch (_) {
        return true;
      }
    }

    /** 保存折叠状态 */
    _saveState() {
      try {
        localStorage.setItem(LS_COLLAPSED_KEY, this.collapsed ? 'collapsed' : 'expanded');
      } catch (_) {}
    }

    /** 读取持久化位置 */
    _loadPosition() {
      try {
        const raw = localStorage.getItem(LS_POSITION_KEY);
        if (!raw) return null;
        const p = JSON.parse(raw);
        if (p && typeof p.x === 'number' && typeof p.y === 'number') return p;
      } catch (_) {}
      return null;
    }

    /** 保存位置到 localStorage */
    _savePosition(x, y) {
      try {
        localStorage.setItem(LS_POSITION_KEY, JSON.stringify({ x: x, y: y }));
      } catch (_) {}
    }

    /** 应用初始位置（持久化优先，否则左侧垂直居中） */
    _applyInitialPosition() {
      const saved = this._loadPosition();
      if (saved) {
        this._setHostPosition(saved.x, saved.y);
      } else {
        const vh = window.innerHeight || document.documentElement.clientHeight;
        const top = Math.max(8, Math.round(vh / 2 - FAB_SIZE / 2));
        this._setHostPosition(8, top);
      }
    }

    /** 设置 host 位置（带边界保护） */
    _setHostPosition(x, y) {
      if (!this.host) return;
      const vw = window.innerWidth || document.documentElement.clientWidth;
      const vh = window.innerHeight || document.documentElement.clientHeight;
      const maxX = Math.max(0, vw - FAB_SIZE - 4);
      const maxY = Math.max(0, vh - FAB_SIZE - 4);
      x = Math.max(4, Math.min(x, maxX));
      y = Math.max(4, Math.min(y, maxY));
      this.host.style.left = x + 'px';
      this.host.style.top = y + 'px';
    }

    /** 获取 host 当前位置（像素） */
    _getHostPosition() {
      if (!this.host) return { x: 0, y: 0 };
      return {
        x: this.host.offsetLeft || 0,
        y: this.host.offsetTop || 0,
      };
    }

    /** 设置 FAB 拖动监听 */
    _setupDrag() {
      const fab = this.shadow.getElementById('goFbToggle');
      if (!fab) return;
      const self = this;
      fab.addEventListener('mousedown', function (e) {
        if (e.button !== 0) return; // 仅左键
        self._dragging = true;
        self._suppressClick = false;
        const pos = self._getHostPosition();
        self._dragStartX = e.clientX;
        self._dragStartY = e.clientY;
        self._hostStartX = pos.x;
        self._hostStartY = pos.y;
        if (self.container) {
          self.container.setAttribute('data-dragging', 'true');
        }
        e.preventDefault();

        function onMove(ev) {
          if (!self._dragging) return;
          const dx = ev.clientX - self._dragStartX;
          const dy = ev.clientY - self._dragStartY;
          if (!self._suppressClick && Math.abs(dx) + Math.abs(dy) > DRAG_THRESHOLD) {
            self._suppressClick = true;
          }
          self._setHostPosition(self._hostStartX + dx, self._hostStartY + dy);
        }
        function onUp() {
          self._dragging = false;
          if (self.container) {
            self.container.removeAttribute('data-dragging');
          }
          document.removeEventListener('mousemove', onMove);
          document.removeEventListener('mouseup', onUp);
          self._dragMoveHandler = null;
          self._dragEndHandler = null;
          if (self._suppressClick) {
            const finalPos = self._getHostPosition();
            self._savePosition(finalPos.x, finalPos.y);
          }
        }
        self._dragMoveHandler = onMove;
        self._dragEndHandler = onUp;
        document.addEventListener('mousemove', onMove);
        document.addEventListener('mouseup', onUp);
      });
    }

    /** 展开/收起 */
    toggle() {
      this.collapsed = !this.collapsed;
      if (this.container) {
        this.container.setAttribute('data-state', this.collapsed ? 'collapsed' : 'expanded');
      }
      this._saveState();
      // 展开时注册外部点击监听（点击面板外自动收起）
      if (!this.collapsed) {
        this._registerOutsideClick();
      } else {
        this._unregisterOutsideClick();
      }
    }

    /** 注册外部点击监听 */
    _registerOutsideClick() {
      this._unregisterOutsideClick();
      const self = this;
      this._outsideClickHandler = function (e) {
        if (self.host && !self.host.contains(e.target)) {
          self.collapsed = true;
          if (self.container) {
            self.container.setAttribute('data-state', 'collapsed');
          }
          self._saveState();
          self._unregisterOutsideClick();
        }
      };
      setTimeout(function () {
        document.addEventListener('click', self._outsideClickHandler, true);
      }, 100);
    }

    /** 移除外部点击监听 */
    _unregisterOutsideClick() {
      if (this._outsideClickHandler) {
        document.removeEventListener('click', this._outsideClickHandler, true);
        this._outsideClickHandler = null;
      }
    }

    /** 挂载到 DOM */
    mount() {
      if (this.host) return this;

      const result = DomUtils.createShadowHost(HOST_ID, '', {
        position: 'fixed',
        left: 0,
        top: 0,
        zIndex: Tokens ? Tokens.z.base : 2147483600,
      });
      this.host = result.host;
      this.shadow = result.shadow;
      // 应用初始位置（持久化优先，否则左侧垂直居中）
      this._applyInitialPosition();

      const styleEl = document.createElement('style');
      styleEl.textContent = this.getStyles();
      this.shadow.appendChild(styleEl);

      const container = document.createElement('div');
      container.className = 'go-fb';
      container.setAttribute('data-state', this.collapsed ? 'collapsed' : 'expanded');
      container.innerHTML = this.render();
      this.shadow.appendChild(container);
      this.container = container;

      this.bindEvents();

      if (!this.collapsed) {
        this._registerOutsideClick();
      }
      return this;
    }

    /** CSS 样式 */
    getStyles() {
      const base = Tokens ? Tokens.baseStyles : '';
      const T = Tokens || {};
      const C = T.color || {};
      const R = T.radius || {};
      const S = T.space || {};
      const SH = T.shadow || {};
      const A = T.animation || {};
      const primary = C.primary || '#6366f1';
      const primaryHover = C.primaryHover || '#4f46e5';
      const textPrimary = C.textPrimary || '#0f172a';
      const textSecondary = C.textSecondary || '#475569';
      const textInverse = C.textInverse || '#ffffff';
      const bgBase = C.bgBase || '#ffffff';
      const bgMuted = C.bgMuted || '#f1f5f9';
      const border = C.border || '#e2e8f0';
      const radiusMd = R.md || '10px';
      const radiusLg = R.lg || '14px';
      const spaceXs = S.xs || '4px';
      const spaceSm = S.sm || '8px';
      const easing = A.easing || 'cubic-bezier(0.4, 0, 0.2, 1)';
      const easingOut = A.easingOut || 'cubic-bezier(0.16, 1, 0.3, 1)';
      const dur = A.duration || '0.2s';
      const durFast = A.durationFast || '0.15s';

      return base + `
        .go-fb {
          display: inline-flex;
          align-items: center;
          font-family: inherit;
        }

        /* ===== FAB 圆形按钮 ===== */
        .go-fb-fab {
          width: 44px; height: 44px;
          border: none;
          border-radius: 50%;
          background: ${primary};
          color: ${textInverse};
          cursor: grab;
          display: flex; align-items: center; justify-content: center;
          flex-shrink: 0;
          position: relative;
          z-index: 2;
          box-shadow: ${SH.md || '0 4px 6px -1px rgba(99,102,241,0.3)'};
          transition: background ${durFast} ${easing}, box-shadow ${dur} ${easing};
          user-select: none;
          -webkit-user-select: none;
          will-change: background;
        }
        .go-fb-fab:hover {
          background: ${primaryHover};
          box-shadow: ${SH.lg || '0 10px 15px -3px rgba(99,102,241,0.4)'};
        }
        .go-fb-fab svg { transition: none; }

        /* 拖动态：禁用所有过渡，改 grabbing 光标 */
        .go-fb[data-dragging="true"] .go-fb-fab,
        .go-fb[data-dragging="true"] .go-fb-fab:hover,
        .go-fb[data-dragging="true"] .go-fb-panel,
        .go-fb[data-dragging="true"] .go-fb-fab svg {
          transition: none !important;
        }
        .go-fb[data-dragging="true"] .go-fb-fab {
          cursor: grabbing;
          box-shadow: ${SH.lg || '0 10px 15px -3px rgba(99,102,241,0.4)'} !important;
        }

        /* FAB 内双图标：收起态显示 package，展开态显示 chevron-left */
        .go-fb-fab-icon { display: none; align-items: center; justify-content: center; }
        .go-fb[data-state="collapsed"] .go-fb-fab-icon--collapsed { display: flex; }
        .go-fb[data-state="expanded"] .go-fb-fab-icon--expanded { display: flex; }

        /* ===== 展开面板（纯色背景，禁用 backdrop-filter 提升性能） ===== */
        .go-fb-panel {
          display: flex;
          align-items: center;
          gap: ${spaceXs};
          padding: ${spaceSm};
          margin-left: -6px;
          padding-left: 12px;
          background: ${bgBase};
          border: 1px solid ${border};
          border-left: none;
          border-radius: 0 ${radiusLg} ${radiusLg} 0;
          box-shadow: ${SH.lg || '0 10px 15px -3px rgba(15,23,42,0.08)'};
          overflow: hidden;
          max-width: 0;
          opacity: 0;
          pointer-events: none;
          transition: max-width ${dur} ${easingOut}, opacity ${durFast} ${easing};
        }
        .go-fb[data-state="expanded"] .go-fb-panel {
          max-width: 320px;
          opacity: 1;
          pointer-events: auto;
        }

        /* ===== 操作按钮 ===== */
        .go-fb-btn {
          width: 36px; height: 36px;
          border: 1px solid transparent;
          border-radius: ${radiusMd};
          background: transparent;
          color: ${textSecondary};
          cursor: pointer;
          display: inline-flex;
          align-items: center;
          justify-content: center;
          position: relative;
          flex-shrink: 0;
          transition: background ${durFast} ${easing}, color ${durFast} ${easing}, border-color ${durFast} ${easing}, transform ${durFast} ${easing};
        }
        .go-fb-btn:hover {
          background: ${bgMuted};
          color: ${textPrimary};
        }
        .go-fb-btn .go-fb-icon {
          display: inline-flex;
          pointer-events: none;
        }

        /* 采集按钮：主色强调 */
        .go-fb-btn--primary {
          background: ${primary};
          color: ${textInverse};
          box-shadow: ${SH.xs || '0 1px 2px 0 rgba(15,23,42,0.05)'};
        }
        .go-fb-btn--primary:hover {
          background: ${primaryHover};
          color: ${textInverse};
          box-shadow: ${SH.md || '0 4px 6px -1px rgba(99,102,241,0.28)'};
        }

        /* loading 状态 */
        .go-fb-btn.is-loading {
          pointer-events: none;
          cursor: wait;
        }
        .go-fb-btn.is-loading .go-fb-icon { display: none; }
        .go-fb-btn.is-loading::after {
          content: '';
          position: absolute;
          width: 16px; height: 16px;
          border: 2px solid currentColor;
          border-top-color: transparent;
          border-radius: 50%;
          opacity: 0.7;
          animation: goFbSpin 0.7s linear infinite;
        }
        .go-fb-btn.is-loading.go-fb-btn--primary::after {
          border-color: rgba(255,255,255,0.4);
          border-top-color: transparent;
          opacity: 1;
        }

        /* ===== Tooltip ===== */
        .go-fb-tip {
          position: absolute;
          left: calc(100% + 10px);
          top: 50%;
          transform: translateY(-50%) translateX(-4px);
          background: ${textPrimary};
          color: ${textInverse};
          font-size: 12px;
          font-weight: 500;
          padding: 5px 10px;
          border-radius: ${R.base || '8px'};
          white-space: nowrap;
          opacity: 0;
          pointer-events: none;
          transition: opacity ${durFast} ${easing}, transform ${durFast} ${easingOut};
          z-index: 10;
          box-shadow: ${SH.md || '0 4px 6px -1px rgba(15,23,42,0.1)'};
          font-family: inherit;
        }
        .go-fb-tip::before {
          content: '';
          position: absolute;
          left: -4px;
          top: 50%;
          transform: translateY(-50%) rotate(45deg);
          width: 8px; height: 8px;
          background: ${textPrimary};
        }
        .go-fb-btn:hover .go-fb-tip {
          opacity: 1;
          transform: translateY(-50%) translateX(0);
        }
        .go-fb-tip-kbd {
          display: inline-block;
          margin-left: 6px;
          padding: 1px 5px;
          background: rgba(255,255,255,0.18);
          border-radius: 4px;
          font-size: 10px;
          font-family: inherit;
        }

        @keyframes goFbSpin { to { transform: rotate(360deg); } }
      `;
    }

    /** SVG 图标字符串（Lucide 风格） */
    iconSvg(name) {
      const paths = {
        collect: '<path d="M21 8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16Z"/><path d="m3.3 7 8.7 5 8.7-5"/><path d="M12 22V12"/>',
        copy: '<rect width="14" height="14" x="8" y="8" rx="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/>',
        erp: '<rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/>',
        settings: '<path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z"/><circle cx="12" cy="12" r="3"/>',
        publish: '<path d="m22 2-7 20-4-9-9-4Z"/><path d="M22 2 11 13"/>',
        profit: '<rect x="4" y="2" width="16" height="20" rx="2"/><line x1="8" x2="16" y1="6" y2="6"/><line x1="8" x2="8" y1="14" y2="18"/><line x1="12" x2="12" y1="14" y2="18"/><line x1="16" x2="16" y1="14" y2="18"/>',
        pricing: '<path d="M12.586 2.586A2 2 0 0 0 11.172 2H4a2 2 0 0 0-2 2v7.172a2 2 0 0 0 .586 1.414l8.704 8.704a2.426 2.426 0 0 0 3.42 0l6.58-6.58a2.426 2.426 0 0 0 0-3.42z"/><circle cx="7.5" cy="7.5" r=".5" fill="currentColor"/>',
        cookie: '<path d="M12 2a10 10 0 1 0 10 10 4 4 0 0 1-4-4 4 4 0 0 1-4-4 4 4 0 0 1 0-2Z"/><circle cx="9" cy="9" r="1"/><circle cx="15" cy="12" r="1"/><circle cx="9" cy="15" r="1"/>',
        shield: '<path d="M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1Z"/><path d="m9 12 2 2 4-4"/>',
      };
      const p = paths[name] || '';
      return '<span class="go-fb-icon"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + p + '</svg></span>';
    }

    /** 是否在 seller.ozon.ru 页面（对齐 maozi seller tab 注入） */
    isSellerPage() {
      try {
        return location.hostname === 'seller.ozon.ru';
      } catch (_) {
        return false;
      }
    }

    /** HTML 模板 */
    render() {
      // seller.ozon.ru 上下文：渲染卖家中心专用按钮（对齐 maozi seller tab 注入）
      // maozi 在 seller.ozon.ru 显示：绑定Cookie / 计算利润 / 定价工具 / 进入ERP
      // GeekOzon 额外增加：检查桥接（验证 seller-bridge 是否就绪）
      if (this.isSellerPage()) {
        return this._renderSellerPanel();
      }
      return this._renderNormalPanel();
    }

    /** 商品页/列表页标准按钮组 */
    _renderNormalPanel() {
      return `
        <button class="go-fb-fab" id="goFbToggle" aria-label="展开/收起工具栏">
          <span class="go-fb-fab-icon go-fb-fab-icon--collapsed">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
              <path d="M21 8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16Z"/>
              <path d="m3.3 7 8.7 5 8.7-5"/>
              <path d="M12 22V12"/>
            </svg>
          </span>
          <span class="go-fb-fab-icon go-fb-fab-icon--expanded">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
              <path d="m15 18-6-6 6-6"/>
            </svg>
          </span>
        </button>
        <div class="go-fb-panel">
          <button class="go-fb-btn go-fb-btn--primary" id="goFbCollect" aria-label="采集商品">
            ${this.iconSvg('collect')}
            <span class="go-fb-tip">采集商品<span class="go-fb-tip-kbd">Ctrl+Shift+C</span></span>
          </button>
          ${location.hostname.indexOf('ozon.') === -1 ? `
          <button class="go-fb-btn" id="goFbCopyImages" aria-label="复制图片">
            ${this.iconSvg('copy')}
            <span class="go-fb-tip">复制图片</span>
          </button>` : ''}
          <button class="go-fb-btn" id="goFbPublish" aria-label="一键上架">
            ${this.iconSvg('publish')}
            <span class="go-fb-tip">一键上架</span>
          </button>
          <button class="go-fb-btn" id="goFbProfit" aria-label="计算利润">
            ${this.iconSvg('profit')}
            <span class="go-fb-tip">计算利润</span>
          </button>
          <button class="go-fb-btn" id="goFbPricing" aria-label="定价工具">
            ${this.iconSvg('pricing')}
            <span class="go-fb-tip">定价工具</span>
          </button>
          <button class="go-fb-btn" id="goFbErp" aria-label="打开 ERP">
            ${this.iconSvg('erp')}
            <span class="go-fb-tip">打开 ERP 后台</span>
          </button>
          <button class="go-fb-btn" id="goFbSettings" aria-label="设置">
            ${this.iconSvg('settings')}
            <span class="go-fb-tip">扩展设置</span>
          </button>
        </div>
      `;
    }

    /**
     * seller.ozon.ru 卖家中心专用按钮组（对齐 maozi）
     * 按钮：绑定Cookie / 检查桥接 / 计算利润 / 定价工具 / 进入ERP
     */
    _renderSellerPanel() {
      return `
        <button class="go-fb-fab" id="goFbToggle" aria-label="展开/收起工具栏">
          <span class="go-fb-fab-icon go-fb-fab-icon--collapsed">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
              <path d="M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1Z"/>
              <path d="m9 12 2 2 4-4"/>
            </svg>
          </span>
          <span class="go-fb-fab-icon go-fb-fab-icon--expanded">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
              <path d="m15 18-6-6 6-6"/>
            </svg>
          </span>
        </button>
        <div class="go-fb-panel">
          <button class="go-fb-btn go-fb-btn--primary" id="goFbBindCookie" aria-label="绑定Cookie">
            ${this.iconSvg('cookie')}
            <span class="go-fb-tip">绑定 Cookie</span>
          </button>
          <button class="go-fb-btn" id="goFbCheckBridge" aria-label="检查桥接">
            ${this.iconSvg('shield')}
            <span class="go-fb-tip">检查桥接状态</span>
          </button>
          <button class="go-fb-btn" id="goFbProfit" aria-label="计算利润">
            ${this.iconSvg('profit')}
            <span class="go-fb-tip">计算利润</span>
          </button>
          <button class="go-fb-btn" id="goFbPricing" aria-label="定价工具">
            ${this.iconSvg('pricing')}
            <span class="go-fb-tip">定价工具</span>
          </button>
          <button class="go-fb-btn" id="goFbErp" aria-label="进入ERP">
            ${this.iconSvg('erp')}
            <span class="go-fb-tip">进入 ERP 后台</span>
          </button>
        </div>
      `;
    }

    /** 绑定事件 */
    bindEvents() {
      const toggleBtn = this.shadow.getElementById('goFbToggle');
      const collectBtn = this.shadow.getElementById('goFbCollect');
      const copyImagesBtn = this.shadow.getElementById('goFbCopyImages');
      const publishBtn = this.shadow.getElementById('goFbPublish');
      const profitBtn = this.shadow.getElementById('goFbProfit');
      const pricingBtn = this.shadow.getElementById('goFbPricing');
      const erpBtn = this.shadow.getElementById('goFbErp');
      const settingsBtn = this.shadow.getElementById('goFbSettings');
      // seller.ozon.ru 专用按钮
      const bindCookieBtn = this.shadow.getElementById('goFbBindCookie');
      const checkBridgeBtn = this.shadow.getElementById('goFbCheckBridge');

      if (toggleBtn) {
        toggleBtn.addEventListener('click', this.onToggleClick.bind(this));
      }
      if (collectBtn) {
        collectBtn.addEventListener('click', this.onCollectClick.bind(this));
      }
      if (copyImagesBtn) {
        copyImagesBtn.addEventListener('click', this.onCopyImagesClick.bind(this));
      }
      if (publishBtn) {
        publishBtn.addEventListener('click', this.onPublishClick.bind(this));
      }
      if (profitBtn) {
        profitBtn.addEventListener('click', this.onProfitClick.bind(this));
      }
      if (pricingBtn) {
        pricingBtn.addEventListener('click', this.onPricingClick.bind(this));
      }
      if (erpBtn) {
        erpBtn.addEventListener('click', this.onErpClick.bind(this));
      }
      if (settingsBtn) {
        settingsBtn.addEventListener('click', this.onSettingsClick.bind(this));
      }
      if (bindCookieBtn) {
        bindCookieBtn.addEventListener('click', this.onBindCookieClick.bind(this));
      }
      if (checkBridgeBtn) {
        checkBridgeBtn.addEventListener('click', this.onCheckBridgeClick.bind(this));
      }

      // 启用 FAB 拖动
      this._setupDrag();
    }

    /** FAB 点击：展开/收起（拖动后抑制一次点击） */
    onToggleClick() {
      if (this._suppressClick) {
        this._suppressClick = false;
        return;
      }
      this.toggle();
    }

    /** 采集按钮点击 */
    async onCollectClick() {
      if (this.collecting) return;
      this.collecting = true;
      const btn = this.shadow.getElementById('goFbCollect');
      if (btn) btn.classList.add('is-loading');

      try {
        const result = await this.doCollect();
        const msg = (result && result.msg) ? result.msg : '';
        if (result && result.code === 200) {
          this.toast('采集成功' + (msg ? '：' + msg : ''), 'success');
        } else {
          // 显示具体错误码和消息，便于诊断
          const errCode = (result && result.code) ? result.code : '无响应';
          const errMsg = msg || '未检测到商品或后端未响应';
          console.error('[GeekOzon] 采集失败详情:', result);
          this.toast('采集失败（' + errCode + '）：' + errMsg, 'error');
        }
      } catch (e) {
        this.toast('采集异常：' + e.message, 'error');
      } finally {
        this.collecting = false;
        if (btn) btn.classList.remove('is-loading');
      }
    }

    async onCopyImagesClick() {
      const productData = await this._getCurrentProductData();
      const images = Array.from(new Set([].concat(
        productData.images || [], productData.detailImages || []
      ).filter(Boolean)));
      if (!images.length) {
        this.toast('未采集到可复制的图片', 'error');
        return;
      }
      try {
        await navigator.clipboard.writeText(images.join('\n'));
        this.toast('已复制 ' + images.length + ' 张图片链接', 'success');
      } catch (error) {
        this.toast('复制图片失败: ' + error.message, 'error');
      }
    }

    /**
     * 执行采集：优先用页面注入的 scanner
     * 1. window.__geekOzonCollect（完整采集，含后端提交）
     * 2. window.__geekOzonScanAsync / __geekOzonScan（仅提取）+ 手动提交
     * 3. 发 TRIGGER_COLLECT 消息（无 scanner 时）
     * @returns {Promise<object>}
     */
    async doCollect() {
      // 优先：完整采集入口
      if (typeof window.__geekOzonCollect === 'function') {
        return await window.__geekOzonCollect();
      }

      // 次选：异步提取 + 手动提交
      let productData = null;
      if (typeof window.__geekOzonScanAsync === 'function') {
        try { productData = await window.__geekOzonScanAsync(); }
        catch (_) { productData = null; }
      }
      if (!productData && typeof window.__geekOzonScan === 'function') {
        try { productData = window.__geekOzonScan(); }
        catch (_) { productData = null; }
      }

      if (productData && ApiClient) {
        // 补全通用字段
        productData.sourceUrl = location.href;
        productData.collectedAt = new Date().toISOString();
        return await ApiClient.collectProduct(productData);
      }

      // 兜底：发消息触发
      if (chrome && chrome.runtime && chrome.runtime.sendMessage) {
        return await new Promise(function (resolve) {
          chrome.runtime.sendMessage(
            { type: 'COLLECT_PRODUCT', payload: {} },
            function (resp) { resolve(resp || { code: -1, msg: '无 scanner 可用' }); }
          );
        });
      }

      return { code: -1, msg: '当前页面未注入采集器' };
    }

    /**
     * 获取当前页面商品数据
     * 优先使用同步扫描结果，次选异步扫描，兜底空对象
     */
    async _getCurrentProductData() {
      // 1) 同步扫描结果（ozon-scanner / alibaba-scanner 等已注入 lastProduct）
      if (typeof window.__geekOzonGetLastProduct === 'function') {
        const last = window.__geekOzonGetLastProduct();
        if (last && (last.sku || last.id || last.title)) return last;
      }
      // 2) 异步扫描当前页
      if (typeof window.__geekOzonScanAsync === 'function') {
        try {
          const data = await window.__geekOzonScanAsync();
          if (data && (data.sku || data.id || data.title)) return data;
        } catch (_) {}
      }
      // 3) 同步扫描兜底
      if (typeof window.__geekOzonScan === 'function') {
        try {
          const data = window.__geekOzonScan();
          if (data && (data.sku || data.id || data.title)) return data;
        } catch (_) {}
      }
      return {};
    }

    /** 一键上架按钮 */
    async onPublishClick() {
      if (typeof window.__geekOzonOpenPublishModal !== 'function') {
        this.toast('上架模块未加载', 'error');
        return;
      }
      this.toast('正在获取商品数据…', 'info');
      const productData = await this._getCurrentProductData();
      if (!productData || (!productData.sku && !productData.id && !productData.title)) {
        this.toast('请在商品详情页使用上架功能', 'error');
        return;
      }
      try {
        window.__geekOzonOpenPublishModal(productData);
      } catch (e) {
        this.toast('打开上架弹窗失败：' + e.message, 'error');
      }
    }

    /** 计算利润按钮 */
    async onProfitClick() {
      if (typeof window.__geekOzonOpenProfitCalculator !== 'function') {
        this.toast('利润计算器未加载', 'error');
        return;
      }
      const productData = await this._getCurrentProductData();
      const params = productData && (productData.sku || productData.price)
        ? {
            costCny: Number(productData.costCny) || 0,
            weightG: Number(productData.weightG || productData.weight) || 0,
            lengthMm: Number(productData.length) || 0,
            widthMm: Number(productData.width) || 0,
            heightMm: Number(productData.height) || 0,
            sellPriceRub: Number(productData.price) || 0,
          }
        : null;
      try {
        window.__geekOzonOpenProfitCalculator(params ? { params: params } : undefined);
      } catch (e) {
        this.toast('打开利润计算器失败：' + e.message, 'error');
      }
    }

    /** 定价工具按钮 */
    async onPricingClick() {
      if (typeof window.__geekOzonOpenPricingTool !== 'function') {
        this.toast('定价工具未加载', 'error');
        return;
      }
      const productData = await this._getCurrentProductData();
      const params = productData && (productData.sku || productData.costCny)
        ? {
            costCny: Number(productData.costCny) || 0,
            weightG: Number(productData.weightG || productData.weight) || 0,
            lengthMm: Number(productData.length) || 0,
            widthMm: Number(productData.width) || 0,
            heightMm: Number(productData.height) || 0,
            descriptionCategoryId: Number(productData.descriptionCategoryId) || 0,
          }
        : null;
      try {
        window.__geekOzonOpenPricingTool(params ? { params: params } : undefined);
      } catch (e) {
        this.toast('打开定价工具失败：' + e.message, 'error');
      }
    }

    /** 打开 ERP 按钮 */
    onErpClick() {
      try {
        window.open(ERP_URL, '_blank');
      } catch (e) {
        this.toast('打开 ERP 失败：' + e.message, 'error');
      }
    }

    /** 设置按钮 */
    onSettingsClick() {
      try {
        if (chrome && chrome.runtime && chrome.runtime.sendMessage) {
          chrome.runtime.sendMessage({ type: 'OPEN_OPTIONS' }, function () {
            if (chrome.runtime.lastError) { /* noop */ }
          });
          this.toast('已请求打开扩展设置页', 'info');
        } else {
          this.toast('请在扩展管理页配置', 'info');
        }
      } catch (e) {
        this.toast('打开设置失败：' + e.message, 'error');
      }
    }

    /**
     * 绑定 Cookie（对齐 maozi "绑定Cookie" 按钮）
     * 收集 seller.ozon.ru 的全部 cookie，POST 到本地后端 /api/shop/set_cookies
     * 后端可保存以便后续 Ozon API 调用或 cookie 刷新
     */
    async onBindCookieClick() {
      const btn = this.shadow.getElementById('goFbBindCookie');
      if (btn) btn.classList.add('is-loading');
      this.toast('正在上传 Cookie...', 'info');
      try {
        // 通过 chrome.runtime.sendMessage 获取 seller.ozon.ru 的所有 cookie（含 httpOnly）
        const cookies = await this._getAllSellerCookies();
        if (!cookies || cookies.length === 0) {
          this.toast('未获取到 Cookie，请确认已登录 seller.ozon.ru', 'error');
          return;
        }
        // 提取 company_id 用于显示
        const cidCookie = cookies.find(function (c) { return c.name === 'sc_company_id'; });
        const companyId = cidCookie ? cidCookie.value : '';

        // POST 到本地后端（对齐 maozi /api.shop/set_cookies）
        const resp = await this._postCookiesToBackend(cookies);
        if (resp && resp.ok) {
          const msg = companyId
            ? 'Cookie 上传成功（公司ID: ' + companyId.slice(0, 4) + '****，共 ' + cookies.length + ' 条）'
            : 'Cookie 上传成功（共 ' + cookies.length + ' 条）';
          this.toast(msg, 'success');
        } else {
          const errMsg = (resp && resp.msg) || '后端响应异常';
          this.toast('Cookie 上传失败：' + errMsg, 'error');
        }
      } catch (e) {
        this.toast('绑定 Cookie 异常：' + e.message, 'error');
      } finally {
        if (btn) btn.classList.remove('is-loading');
      }
    }

    /**
     * 获取 seller.ozon.ru 的所有 cookie
     * 通过 chrome.runtime.sendMessage GET_COOKIES 获取（含 httpOnly）
     * @returns {Promise<Array>}
     */
    _getAllSellerCookies() {
      return new Promise(function (resolve) {
        try {
          const Config = G.core && G.core.Config;
          const MSG = Config ? Config.MSG : null;
          const msgType = MSG ? MSG.GET_COOKIES : 'GET_COOKIES';
          chrome.runtime.sendMessage({
            type: msgType,
            url: 'https://seller.ozon.ru/',
          }, function (resp) {
            resolve(Array.isArray(resp) ? resp : (resp && resp.cookies) || []);
          });
        } catch (e) {
          resolve([]);
        }
      });
    }

    /**
     * POST cookie 到本地后端
     * @param {Array} cookies
     * @returns {Promise<{ok:boolean, msg?:string}>}
     */
    async _postCookiesToBackend(cookies) {
      try {
        const Config = G.core && G.core.Config;
        const baseUrl = Config ? await Config.getApiBaseUrl() : 'http://localhost:5000';
        const resp = await fetch(baseUrl + '/api/stores/set_cookies', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            platform: 'ozon',
            cookies: JSON.stringify(cookies),
            source: 'extension-seller-floating-bar',
          }),
        });
        if (!resp.ok) {
          return { ok: false, msg: 'HTTP_' + resp.status };
        }
        const json = await resp.json();
        return { ok: true, data: json };
      } catch (e) {
        return { ok: false, msg: e.message };
      }
    }

    /**
     * 检查桥接状态（对齐 maozi PING_TEST）
     * 向 seller-bridge.js 发送 PING，验证跨 tab 借权是否就绪
     */
    async onCheckBridgeClick() {
      const btn = this.shadow.getElementById('goFbCheckBridge');
      if (btn) btn.classList.add('is-loading');
      this.toast('正在检查桥接状态...', 'info');
      try {
        const result = await this._pingSellerBridge();
        if (result && result.success && result.pong) {
          const cidStatus = result.hasCompanyId
            ? '已获取（' + result.companyId + '****）'
            : '未获取（请先登录卖家中心）';
          this.toast('桥接就绪 ✓ | 公司ID: ' + cidStatus, 'success');
        } else {
          const err = (result && result.error) || '未知错误';
          this.toast('桥接异常：' + err, 'error');
        }
      } catch (e) {
        this.toast('检查桥接异常：' + e.message, 'error');
      } finally {
        if (btn) btn.classList.remove('is-loading');
      }
    }

    /**
     * PING seller-bridge.js（同 tab 内直接调 chrome.runtime.sendMessage）
     * seller-bridge.js 已监听 PING 消息并返回 {pong, hasCompanyId, companyId}
     * @returns {Promise<object>}
     */
    _pingSellerBridge() {
      return new Promise(function (resolve) {
        try {
          const timer = setTimeout(function () {
            resolve({ success: false, error: 'TIMEOUT' });
          }, 5000);
          chrome.runtime.sendMessage({ type: 'PING' }, function (resp) {
            clearTimeout(timer);
            if (chrome.runtime.lastError) {
              resolve({ success: false, error: chrome.runtime.lastError.message });
              return;
            }
            resolve(resp || { success: false, error: 'NO_RESPONSE' });
          });
        } catch (e) {
          resolve({ success: false, error: e.message });
        }
      });
    }

    /**
     * 轻量 Toast 提示（自包含，不依赖 Toast 组件）
     * @param {string} text
     * @param {string} type - success / error / info
     */
    toast(text, type) {
      if (G.components && G.components.Toast && typeof G.components.Toast.show === 'function') {
        try {
          G.components.Toast.show(text, type);
          return;
        } catch (_) { /* 降级 */ }
      }

      try {
        const t = document.createElement('div');
        t.textContent = text;
        const bg = type === 'success' ? '#10b981' : (type === 'error' ? '#ef4444' : '#0f172a');
        t.style.cssText =
          'position:fixed;top:20px;left:50%;transform:translateX(-50%);' +
          'background:' + bg + ';color:#fff;padding:8px 16px;border-radius:8px;' +
          'font-size:13px;font-family:system-ui,sans-serif;z-index:2147483647;' +
          'box-shadow:0 4px 12px rgba(0,0,0,0.2);opacity:0;transition:opacity 0.2s;';
        (document.body || document.documentElement).appendChild(t);
        requestAnimationFrame(function () { t.style.opacity = '1'; });
        setTimeout(function () {
          t.style.opacity = '0';
          setTimeout(function () { if (t.parentNode) t.parentNode.removeChild(t); }, 250);
        }, 2400);
      } catch (_) { /* 静默 */ }
    }

    /** 销毁 */
    destroy() {
      this._unregisterOutsideClick();
      // 清理拖动监听
      if (this._dragMoveHandler) {
        document.removeEventListener('mousemove', this._dragMoveHandler);
        this._dragMoveHandler = null;
      }
      if (this._dragEndHandler) {
        document.removeEventListener('mouseup', this._dragEndHandler);
        this._dragEndHandler = null;
      }
      if (this._unsubRouter) {
        try { this._unsubRouter(); } catch (_) {}
        this._unsubRouter = null;
      }
      if (this.host && this.host.parentNode) {
        this.host.parentNode.removeChild(this.host);
      }
      this.host = null;
      this.shadow = null;
      this.container = null;
    }
  }

  /** 监听 chrome.runtime.onMessage 的 TRIGGER_COLLECT，触发采集 */
  function setupMessageListener() {
    if (!chrome || !chrome.runtime || !chrome.runtime.onMessage) return;
    chrome.runtime.onMessage.addListener(function (message, sender, sendResponse) {
      if (!message || (message.type !== 'TRIGGER_COLLECT' && message.type !== 'TRIGGER_PUBLISH')) return false;
      if (instance) {
        const action = message.type === 'TRIGGER_PUBLISH'
          ? instance.onPublishClick.bind(instance)
          : instance.onCollectClick.bind(instance);
        action().then(function () {
          sendResponse({ success: true });
        }).catch(function (e) {
          sendResponse({ success: false, error: e.message });
        });
        return true;
      }
      sendResponse({ success: false, error: 'FLOATING_BAR_NOT_READY' });
      return false;
    });
  }

  /**
   * 初始化浮动栏
   * - body 就绪后立即挂载，使用 requestIdleCallback 不阻塞首屏
   * - 所有错误被 safeRun 捕获，防止单点故障扩散
   */
  function init() {
    if (window.__geekOzonFloatingBarLoaded) return;
    window.__geekOzonFloatingBarLoaded = true;

    if (instance) return;

    instance = new FloatingBar();

    const start = function () {
      if (!document.body) {
        // body 尚未就绪：等 DOMContentLoaded，否则轮询
        if (document.readyState === 'loading') {
          document.addEventListener('DOMContentLoaded', start, { once: true });
        } else {
          setTimeout(start, 50);
        }
        return;
      }
      // body 就绪，在空闲时挂载（避免抢占首屏渲染资源）
      G.utils.idleRun(function () {
        G.utils.safeRun(function () { instance.mount(); }, null, 'floating-bar.mount');
        G.utils.safeRun(function () { setupMessageListener(); }, null, 'floating-bar.message');
      }, 800);
    };
    start();
  }

  /**
   * 刷新浮动栏（销毁后重建）
   */
  window.__geekOzonRefreshFloatingBar = function () {
    if (instance) {
      instance.destroy();
      instance = null;
    }
    window.__geekOzonFloatingBarLoaded = false;
    init();
  };

  G.features = G.features || {};
  G.features.FloatingBar = FloatingBar;

  // 启动
  init();

  G.markLoaded('floating-bar');
  console.log('[GeekOzon] 悬浮折叠工具栏已加载');
})();
