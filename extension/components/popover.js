/**
 * GeekOzon 扩展 - 弹出层组件 Popover
 * 相对目标元素定位（上下左右），半透明遮罩 + ESC 关闭，内容可自定义
 *
 * 用法：
 *   const pop = new GeekOzon.components.Popover({
 *     target: btnEl,
 *     content: '<p>弹出内容</p>',
 *     placement: 'top',  // top/bottom/left/right，默认 bottom
 *     onClose: () => {},
 *   });
 *   pop.show();
 *   pop.setContent('<p>新内容</p>');
 */
;(function () {
  'use strict';

  const G = window.GeekOzon;
  if (!G || G.isLoaded('popover')) return;

  const Tokens = G.components.DesignTokens;
  const BaseComponent = G.components.BaseComponent;

  // 合法方位
  const PLACEMENTS = { top: 1, bottom: 1, left: 1, right: 1 };
  // 视口边距
  const VIEWPORT_GAP = 8;

  class Popover extends BaseComponent {
    constructor(opts) {
      opts = opts || {};
      super(opts);
      this.target = opts.target || null;
      this.content = opts.content || '';
      this.placement = PLACEMENTS[opts.placement] ? opts.placement : 'bottom';
      this.onClose = opts.onClose || null;
      // 滚动/resize 时需要重新定位
      this._onScrollResize = null;
    }

    getHostId() { return 'geekozon-popover-host'; }

    getHostPosition() {
      return { position: 'fixed', zIndex: Tokens.z.popover };
    }

    getStyles() {
      return `
        :host { display: block; }
        .go-popover-overlay {
          position: fixed; inset: 0;
          background: rgba(0,0,0,0.12);
          animation: goFadeIn ${Tokens.animation.durationFast} ${Tokens.animation.easing};
        }
        .go-popover {
          position: fixed;
          max-width: 320px;
          background: ${Tokens.color.bgBase};
          border-radius: ${Tokens.radius.lg};
          box-shadow: ${Tokens.shadow.card};
          padding: ${Tokens.space.base};
          font-size: ${Tokens.font.sizeLg};
          color: ${Tokens.color.textPrimary};
          animation: goZoomIn ${Tokens.animation.durationFast} ${Tokens.animation.easing};
        }
        .go-popover-arrow {
          position: fixed;
          width: 10px; height: 10px;
          background: ${Tokens.color.bgBase};
          transform: rotate(45deg);
          box-shadow: ${Tokens.shadow.card};
          z-index: -1;
        }
        ${this.getCommonStyles()}
      `;
    }

    render() {
      return `
        <div class="go-popover-overlay" id="goPopoverOverlay"></div>
        <div class="go-popover" id="goPopoverBox" style="visibility:hidden;">
          <div class="go-popover-content" id="goPopoverContent">${this.content}</div>
        </div>
      `;
    }

    bindEvents() {
      // 点击遮罩关闭
      const overlay = this.$('#goPopoverOverlay');
      if (overlay) {
        this.on(overlay, 'click', function () { this.hide(); });
      }
      // ESC 关闭
      this.on(document, 'keydown', function (e) {
        if (!this.visible) return;
        if (e.key === 'Escape') { e.preventDefault(); this.hide(); }
      });
      // 滚动/resize 重新定位（用 rAF 节流，passive 不阻塞滚动）
      this._rafPending = false;
      this._onScrollResize = function () {
        if (!this.visible || this._rafPending) return;
        this._rafPending = true;
        requestAnimationFrame(function () {
          this._rafPending = false;
          if (this.visible) {
            try { this._position(); } catch (e) { console.error('[GeekOzon] popover._position:', e); }
          }
        }.bind(this));
      }.bind(this);
      // passive: true 让滚动不阻塞（capture phase 仍捕获嵌套滚动）
      window.addEventListener('scroll', this._onScrollResize, { capture: true, passive: true });
      window.addEventListener('resize', this._onScrollResize, { passive: true });
    }

    /** 计算并设置弹出层位置（相对 target，按 placement 方位） */
    _position() {
      const box = this.$('#goPopoverBox');
      if (!box) return;
      // 先显示以便测量尺寸
      box.style.visibility = 'hidden';
      box.style.left = '0px';
      box.style.top = '0px';

      const target = this.target;
      if (!target) { box.style.visibility = ''; return; }
      const tr = target.getBoundingClientRect();
      const bw = box.offsetWidth;
      const bh = box.offsetHeight;
      const vw = window.innerWidth;
      const vh = window.innerHeight;

      let left = 0, top = 0;
      const place = this.placement;

      if (place === 'top') {
        left = tr.left + tr.width / 2 - bw / 2;
        top = tr.top - bh - 8;
      } else if (place === 'bottom') {
        left = tr.left + tr.width / 2 - bw / 2;
        top = tr.bottom + 8;
      } else if (place === 'left') {
        left = tr.left - bw - 8;
        top = tr.top + tr.height / 2 - bh / 2;
      } else if (place === 'right') {
        left = tr.right + 8;
        top = tr.top + tr.height / 2 - bh / 2;
      }

      // 视口边界钳制
      if (left < VIEWPORT_GAP) left = VIEWPORT_GAP;
      if (left + bw > vw - VIEWPORT_GAP) left = vw - VIEWPORT_GAP - bw;
      if (top < VIEWPORT_GAP) top = VIEWPORT_GAP;
      if (top + bh > vh - VIEWPORT_GAP) top = vh - VIEWPORT_GAP - bh;

      box.style.left = left + 'px';
      box.style.top = top + 'px';
      box.style.visibility = '';
    }

    /** 覆盖 show：显示后定位 */
    show() {
      super.show();
      // 等下一帧测量（确保已渲染）
      const self = this;
      requestAnimationFrame(function () { self._position(); });
      return this;
    }

    /** 设置内容并重新定位 */
    setContent(html) {
      this.content = html == null ? '' : String(html);
      const el = this.$('#goPopoverContent');
      if (el) el.innerHTML = this.content;
      if (this.visible) {
        const self = this;
        requestAnimationFrame(function () { self._position(); });
      }
      return this;
    }

    /** 销毁前移除全局监听 */
    beforeDestroy() {
      if (this._onScrollResize) {
        window.removeEventListener('scroll', this._onScrollResize, true);
        window.removeEventListener('resize', this._onScrollResize);
        this._onScrollResize = null;
      }
    }

    /** 覆盖 hide：触发 onClose */
    hide() {
      const wasVisible = this.visible;
      super.hide();
      if (wasVisible && typeof this.onClose === 'function') {
        try { this.onClose.call(null, this); }
        catch (e) { console.error('[GeekOzon Popover] onClose 异常:', e); }
      }
      return this;
    }
  }

  G.components.Popover = Popover;
  G.markLoaded('popover');
})();
