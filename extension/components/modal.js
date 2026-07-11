/**
 * GeekOzon 扩展 - 模态框组件 Modal
 * 居中遮罩 + 圆角 20px 弹窗 + 深蓝阴影
 * 支持 title、自定义内容、底部按钮区
 * ESC 关闭、点击遮罩关闭（可配置）
 *
 * 用法：
 *   const modal = new GeekOzon.components.Modal({
 *     title: '提示',
 *     content: '<p>确认删除？</p>',
 *     closable: true,
 *     onClose: () => {},
 *   });
 *   modal.show();
 *   modal.setContent('<p>新内容</p>');
 *   modal.setTitle('新标题');
 */
;(function () {
  'use strict';

  const G = window.GeekOzon;
  if (!G || G.isLoaded('modal')) return;

  const Tokens = G.components.DesignTokens;
  const BaseComponent = G.components.BaseComponent;

  class Modal extends BaseComponent {
    constructor(opts) {
      opts = opts || {};
      super(opts);
      this.title = opts.title || '';
      this.content = opts.content || '';
      this.closable = opts.closable !== false; // 默认可关闭
      this.onClose = opts.onClose || null;
    }

    getHostId() { return 'geekozon-modal-host'; }

    getHostPosition() {
      return { position: 'fixed', zIndex: Tokens.z.modal };
    }

    getStyles() {
      return `
        :host { display: block; }
        .go-modal-overlay {
          position: fixed; inset: 0;
          background: ${Tokens.color.bgOverlay};
          display: flex; align-items: center; justify-content: center;
          animation: goFadeIn ${Tokens.animation.duration} ${Tokens.animation.easing};
        }
        .go-modal {
          min-width: 360px; max-width: 90vw; max-height: 85vh;
          background: ${Tokens.color.bgBase};
          border-radius: ${Tokens.radius.lg};
          box-shadow: ${Tokens.shadow.modal};
          display: flex; flex-direction: column;
          overflow: hidden;
          animation: goZoomIn ${Tokens.animation.duration} ${Tokens.animation.easing};
        }
        .go-modal-header {
          display: flex; align-items: center; justify-content: space-between;
          padding: ${Tokens.space.lg} ${Tokens.space.xl};
          border-bottom: 1px solid ${Tokens.color.border};
        }
        .go-modal-title {
          font-size: ${Tokens.font.sizeTitle};
          font-weight: ${Tokens.font.weightSemi};
          color: ${Tokens.color.textPrimary};
        }
        .go-modal-body {
          padding: ${Tokens.space.xl};
          font-size: ${Tokens.font.sizeLg};
          color: ${Tokens.color.textPrimary};
          overflow: auto;
          flex: 1;
        }
        .go-modal-footer {
          padding: ${Tokens.space.md} ${Tokens.space.xl} ${Tokens.space.xl};
          display: flex; gap: ${Tokens.space.sm}; justify-content: flex-end;
        }
        .go-modal-footer:empty { display: none; }
        ${this.getCommonStyles()}
        .go-modal-header .go-close { flex-shrink: 0; }
      `;
    }

    render() {
      const closeBtn = this.closable
        ? `<div class="go-modal-header-right">${this.renderCloseButton('goModalClose')}</div>`
        : '';
      const footer = this.opts.footer
        ? `<div class="go-modal-footer" id="goModalFooter">${this.opts.footer}</div>`
        : '';
      return `
        <div class="go-modal-overlay" id="goModalOverlay">
          <div class="go-modal" id="goModalBox">
            <div class="go-modal-header">
              <div class="go-modal-title" id="goModalTitle">${G.utils.escapeHtml(this.title)}</div>
              ${closeBtn}
            </div>
            <div class="go-modal-body" id="goModalBody">${this.content}</div>
            ${footer}
          </div>
        </div>
      `;
    }

    bindEvents() {
      // ESC 关闭
      this.on(document, 'keydown', function (e) {
        if (!this.visible || !this.closable) return;
        if (e.key === 'Escape') { e.preventDefault(); this.hide(); }
      });
      // 点击遮罩关闭
      const overlay = this.$('#goModalOverlay');
      if (overlay) {
        this.on(overlay, 'click', function (e) {
          if (e.target === overlay && this.closable) this.hide();
        });
      }
      // 关闭按钮
      const closeBtn = this.$('#goModalClose');
      if (closeBtn) {
        this.on(closeBtn, 'click', function () { this.hide(); });
      }
    }

    /** 触发 onClose 回调 */
    _fireClose() {
      if (typeof this.onClose === 'function') {
        try { this.onClose.call(null, this); } catch (e) { console.error('[GeekOzon Modal] onClose 异常:', e); }
      }
    }

    /** 设置内容（重新渲染 body） */
    setContent(html) {
      this.content = html == null ? '' : String(html);
      const body = this.$('#goModalBody');
      if (body) body.innerHTML = this.content;
      return this;
    }

    /** 设置标题 */
    setTitle(text) {
      this.title = text == null ? '' : String(text);
      const titleEl = this.$('#goModalTitle');
      if (titleEl) titleEl.textContent = this.title;
      return this;
    }

    /** 覆盖 hide：关闭时触发 onClose（仅在此处统一触发，避免重复） */
    hide() {
      const wasVisible = this.visible;
      super.hide();
      if (wasVisible) this._fireClose();
      return this;
    }
  }

  G.components.Modal = Modal;
  G.markLoaded('modal');
})();
