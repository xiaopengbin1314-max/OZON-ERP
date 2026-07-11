/**
 * GeekOzon 扩展 - UI 组件基类
 * 封装 Shadow DOM 创建、生命周期、事件管理、样式注入
 * 所有 UI 组件继承 BaseComponent
 *
 * 用法：
 *   class MyModal extends GeekOzon.components.BaseComponent {
 *     getHostId() { return 'my-modal-host'; }
 *     getStyles() { return '.my-modal { ... }'; }
 *     render() { return '<div class="my-modal">...</div>'; }
 *     bindEvents() { this.shadow.querySelector('#btn').onclick = ...; }
 *   }
 *   const inst = new MyModal();
 *   inst.mount();  // 挂载到 DOM
 *   inst.show();   // 显示
 */
;(function () {
  'use strict';

  const G = window.GeekOzon;
  if (!G || G.isLoaded('base-component')) return;

  const Tokens = G.components.DesignTokens;
  const DomUtils = G.core.DomUtils;

  class BaseComponent {
    constructor(opts) {
      this.opts = opts || {};
      this.host = null;
      this.shadow = null;
      this.mounted = false;
      this.visible = false;
      this._listeners = [];  // 记录事件，便于统一解绑
    }

    /** 子类重写：宿主元素 ID */
    getHostId() { return 'geekozon-component-' + Date.now(); }

    /** 子类重写：CSS 样式文本 */
    getStyles() { return ''; }

    /** 子类重写：HTML 模板字符串 */
    render() { return ''; }

    /** 子类重写：绑定事件 */
    bindEvents() {}

    /** 子类重写：组件销毁前的清理 */
    beforeDestroy() {}

    /** 宿主定位选项（{position, top, right, left, bottom, zIndex}） */
    getHostPosition() {
      return { position: 'fixed' };
    }

    /** 挂载到 DOM（创建 Shadow DOM） */
    mount() {
      if (this.mounted) return this;
      const id = this.getHostId();
      const pos = this.getHostPosition();
      const result = DomUtils.createShadowHost(id, '', pos);
      this.host = result.host;
      this.shadow = result.shadow;

      // 注入基础样式 + 组件样式
      const styleEl = document.createElement('style');
      styleEl.textContent = Tokens.baseStyles + '\n' + this.getStyles();
      this.shadow.appendChild(styleEl);

      // 注入内容
      const container = document.createElement('div');
      container.innerHTML = this.render();
      this.shadow.appendChild(container);
      this.container = container;

      this.bindEvents();
      this.mounted = true;
      return this;
    }

    /** 显示 */
    show() {
      if (!this.mounted) this.mount();
      this.host.style.display = '';
      this.visible = true;
      this.onShow && this.onShow();
      return this;
    }

    /** 隐藏 */
    hide() {
      if (this.host) this.host.style.display = 'none';
      this.visible = false;
      this.onHide && this.onHide();
      return this;
    }

    /** 切换显隐 */
    toggle() {
      return this.visible ? this.hide() : this.show();
    }

    /** 重新渲染（保留显隐状态） */
    rerender() {
      if (!this.mounted) return this;
      const wasVisible = this.visible;
      this.unbindAll();
      this.container.innerHTML = this.render();
      this.bindEvents();
      if (wasVisible) this.show();
      return this;
    }

    /** 销毁组件（移除 DOM） */
    destroy() {
      this.beforeDestroy && this.beforeDestroy();
      this.unbindAll();
      if (this.host && this.host.parentNode) {
        this.host.parentNode.removeChild(this.host);
      }
      this.host = null;
      this.shadow = null;
      this.container = null;
      this.mounted = false;
      this.visible = false;
    }

    /**
     * 在 shadow 内查询元素
     * @param {string} selector
     */
    $(selector) {
      return this.shadow ? this.shadow.querySelector(selector) : null;
    }

    /** 查询全部 */
    $$(selector) {
      return this.shadow ? Array.prototype.slice.call(this.shadow.querySelectorAll(selector)) : [];
    }

    /**
     * 绑定事件（自动记录，便于销毁时解绑）
     * @param {EventTarget} target - 目标元素
     * @param {string} event - 事件名
     * @param {function} handler - 处理函数
     * @param {object} opts - addEventListener 选项
     */
    on(target, event, handler, opts) {
      if (!target) return;
      const wrapper = handler.bind(this);
      target.addEventListener(event, wrapper, opts);
      this._listeners.push({ target: target, event: event, handler: wrapper });
      return wrapper;
    }

    /** 解绑全部事件 */
    unbindAll() {
      this._listeners.forEach(function (item) {
        try { item.target.removeEventListener(item.event, item.handler); }
        catch (_) {}
      });
      this._listeners = [];
    }

    /** 派发组件事件（通过 EventBus） */
    emit(event) {
      const args = Array.prototype.slice.call(arguments, 1);
      G.core.EventBus.emit.apply(G.core.EventBus, [event].concat(args));
    }

    /** 关闭按钮（现代 SVG X 图标） */
    renderCloseButton(id) {
      return `<button class="go-close" id="${id || 'goClose'}" aria-label="关闭"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 6 6 18M6 6l12 12"/></svg></button>`;
    }

    /** 通用样式：关闭按钮 + 按钮组 */
    getCommonStyles() {
      return `
        .go-close {
          width: 28px; height: 28px; border-radius: ${Tokens.radius.base};
          background: transparent; border: none; color: ${Tokens.color.textMuted};
          cursor: pointer; padding: 0;
          display: inline-flex; align-items: center; justify-content: center;
          transition: background ${Tokens.animation.durationFast} ${Tokens.animation.easing}, color ${Tokens.animation.durationFast} ${Tokens.animation.easing};
        }
        .go-close:hover { background: ${Tokens.color.bgMuted}; color: ${Tokens.color.textPrimary}; }
        .go-close:active { background: ${Tokens.color.border}; }
        ${Tokens.buttonStyles}
      `;
    }
  }

  G.components.BaseComponent = BaseComponent;
  G.markLoaded('base-component');
})();
