/**
 * GeekOzon 扩展 - 抽屉组件 Drawer
 * 从右侧滑出，宽度 500px 可配置，可拖拽调整宽度
 * 顶部标题 + 关闭按钮，底部可选按钮区
 * 拖拽手柄在左侧，宽度持久化到 localStorage 'geekOzon-drawer-width'
 *
 * 用法：
 *   const drawer = new GeekOzon.components.Drawer({
 *     title: '商品详情',
 *     width: 500,
 *     onClose: () => {},
 *     onResize: (newWidth) => {},
 *   });
 *   drawer.show();
 *   drawer.setContent('<p>...</p>');
 */
;(function () {
  'use strict';

  const G = window.GeekOzon;
  if (!G || G.isLoaded('drawer')) return;

  const Tokens = G.components.DesignTokens;
  const BaseComponent = G.components.BaseComponent;

  const STORAGE_KEY = 'geekOzon-drawer-width';
  const MIN_WIDTH = 320;
  const MAX_WIDTH = 960;

  /** 读取持久化宽度 */
  function readStoredWidth() {
    try {
      const v = localStorage.getItem(STORAGE_KEY);
      const n = parseInt(v, 10);
      if (!isNaN(n) && n >= MIN_WIDTH && n <= MAX_WIDTH) return n;
    } catch (_) {}
    return null;
  }

  /** 写入持久化宽度 */
  function writeStoredWidth(w) {
    try { localStorage.setItem(STORAGE_KEY, String(w)); } catch (_) {}
  }

  class Drawer extends BaseComponent {
    constructor(opts) {
      opts = opts || {};
      super(opts);
      this.title = opts.title || '';
      this.onClose = opts.onClose || null;
      this.onResize = opts.onResize || null;
      // 宽度优先级：构造参数 > 持久化 > 默认 500
      this.width = opts.width || readStoredWidth() || 500;
      this._dragging = false;
      this._dragMove = null;
      this._dragUp = null;
    }

    getHostId() { return 'geekozon-drawer-host'; }

    getHostPosition() {
      return { position: 'fixed', zIndex: Tokens.z.drawer };
    }

    getStyles() {
      return `
        :host { display: block; }
        .go-drawer-overlay {
          position: fixed; inset: 0;
          background: ${Tokens.color.bgOverlayLight};
          animation: goFadeIn ${Tokens.animation.duration} ${Tokens.animation.easing};
        }
        .go-drawer {
          position: fixed; top: 0; right: 0; bottom: 0;
          width: ${this.width}px;
          background: ${Tokens.color.bgBase};
          box-shadow: ${Tokens.shadow.drawer};
          display: flex; flex-direction: column;
          animation: goSlideIn ${Tokens.animation.duration} ${Tokens.animation.easing};
        }
        .go-drawer-handle {
          position: absolute; top: 0; left: -3px; bottom: 0;
          width: 6px; cursor: col-resize;
          background: ${Tokens.color.border};
          transition: background ${Tokens.animation.durationFast} ease;
          z-index: 2;
        }
        .go-drawer-handle:hover,
        .go-drawer-handle.dragging {
          background: ${Tokens.color.primary};
        }
        .go-drawer-header {
          display: flex; align-items: center; justify-content: space-between;
          padding: ${Tokens.space.lg} ${Tokens.space.xl};
          border-bottom: 1px solid ${Tokens.color.border};
          flex-shrink: 0;
        }
        .go-drawer-title {
          font-size: ${Tokens.font.sizeTitle};
          font-weight: ${Tokens.font.weightSemi};
          color: ${Tokens.color.textPrimary};
          flex: 1;
          overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
        }
        .go-drawer-body {
          flex: 1; overflow: auto;
          padding: ${Tokens.space.xl};
          font-size: ${Tokens.font.sizeLg};
          color: ${Tokens.color.textPrimary};
        }
        .go-drawer-footer {
          padding: ${Tokens.space.md} ${Tokens.space.xl} ${Tokens.space.xl};
          display: flex; gap: ${Tokens.space.sm}; justify-content: flex-end;
          border-top: 1px solid ${Tokens.color.border};
          flex-shrink: 0;
        }
        .go-drawer-footer:empty { display: none; }
        ${this.getCommonStyles()}
      `;
    }

    render() {
      const footer = this.opts.footer
        ? `<div class="go-drawer-footer" id="goDrawerFooter">${this.opts.footer}</div>`
        : '';
      return `
        <div class="go-drawer-overlay" id="goDrawerOverlay"></div>
        <div class="go-drawer" id="goDrawerPanel">
          <div class="go-drawer-handle" id="goDrawerHandle" title="拖拽调整宽度"></div>
          <div class="go-drawer-header">
            <div class="go-drawer-title" id="goDrawerTitle">${G.utils.escapeHtml(this.title)}</div>
            ${this.renderCloseButton('goDrawerClose')}
          </div>
          <div class="go-drawer-body" id="goDrawerBody">${this.opts.content || ''}</div>
          ${footer}
        </div>
      `;
    }

    bindEvents() {
      // 点击遮罩关闭
      const overlay = this.$('#goDrawerOverlay');
      if (overlay) {
        this.on(overlay, 'click', function () { this.hide(); });
      }
      // 关闭按钮
      const closeBtn = this.$('#goDrawerClose');
      if (closeBtn) {
        this.on(closeBtn, 'click', function () { this.hide(); });
      }
      // ESC 关闭
      this.on(document, 'keydown', function (e) {
        if (!this.visible) return;
        if (e.key === 'Escape') { e.preventDefault(); this.hide(); }
      });
      // 拖拽手柄
      const handle = this.$('#goDrawerHandle');
      const panel = this.$('#goDrawerPanel');
      if (handle && panel) {
        this.on(handle, 'mousedown', function (e) {
          if (e.button !== 0) return;
          e.preventDefault();
          this._dragging = true;
          handle.classList.add('dragging');
          document.body.style.userSelect = 'none';
          const startX = e.clientX;
          const startWidth = panel.offsetWidth;

          // 在 document 上监听移动/松开（绑一次，松开时解绑）
          this._dragMove = function (ev) {
            if (!this._dragging) return;
            // 向左拖 → 宽度变宽（clientX 减小 → 宽度增加）
            const delta = startX - ev.clientX;
            let w = startWidth + delta;
            if (w < MIN_WIDTH) w = MIN_WIDTH;
            if (w > MAX_WIDTH) w = MAX_WIDTH;
            panel.style.width = w + 'px';
          }.bind(this);

          this._dragUp = function () {
            if (!this._dragging) return;
            this._dragging = false;
            handle.classList.remove('dragging');
            document.body.style.userSelect = '';
            const finalWidth = panel.offsetWidth;
            this.width = finalWidth;
            writeStoredWidth(finalWidth);
            if (typeof this.onResize === 'function') {
              try { this.onResize.call(null, finalWidth, this); }
              catch (err) { console.error('[GeekOzon Drawer] onResize 异常:', err); }
            }
            document.removeEventListener('mousemove', this._dragMove);
            document.removeEventListener('mouseup', this._dragUp);
            this._dragMove = null;
            this._dragUp = null;
          }.bind(this);

          document.addEventListener('mousemove', this._dragMove);
          document.addEventListener('mouseup', this._dragUp);
        });
      }
    }

    /** 设置内容 */
    setContent(html) {
      const body = this.$('#goDrawerBody');
      if (body) body.innerHTML = html == null ? '' : String(html);
      return this;
    }

    /** 设置标题 */
    setTitle(text) {
      this.title = text == null ? '' : String(text);
      const el = this.$('#goDrawerTitle');
      if (el) el.textContent = this.title;
      return this;
    }

    /** 主动设置宽度（不会触发 onResize） */
    setWidth(w) {
      w = parseInt(w, 10);
      if (isNaN(w)) return this;
      if (w < MIN_WIDTH) w = MIN_WIDTH;
      if (w > MAX_WIDTH) w = MAX_WIDTH;
      this.width = w;
      const panel = this.$('#goDrawerPanel');
      if (panel) panel.style.width = w + 'px';
      writeStoredWidth(w);
      return this;
    }

    /** 销毁前清理拖拽残留监听 */
    beforeDestroy() {
      if (this._dragMove) { document.removeEventListener('mousemove', this._dragMove); this._dragMove = null; }
      if (this._dragUp) { document.removeEventListener('mouseup', this._dragUp); this._dragUp = null; }
      document.body.style.userSelect = '';
    }

    /** 覆盖 hide：触发 onClose */
    hide() {
      const wasVisible = this.visible;
      super.hide();
      if (wasVisible && typeof this.onClose === 'function') {
        try { this.onClose.call(null, this); }
        catch (e) { console.error('[GeekOzon Drawer] onClose 异常:', e); }
      }
      return this;
    }
  }

  G.components.Drawer = Drawer;
  G.markLoaded('drawer');
})();
