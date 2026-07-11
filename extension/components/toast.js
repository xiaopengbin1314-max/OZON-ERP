/**
 * GeekOzon 扩展 - 通知组件 Toast（v2 现代 SaaS，单例）
 * 顶部居中滑入，3 秒自动消失（可配置）
 * 4 种类型：success(绿)/error(红)/warn(橙)/info(蓝)
 * 图标使用内联 SVG（Lucide 风格），替代 v1 的 emoji
 * 支持手动关闭
 *
 * 用法：
 *   GeekOzon.components.Toast.show('保存成功', 'success', 3000);
 *   GeekOzon.components.Toast.success('保存成功');
 *   GeekOzon.components.Toast.error('网络错误');
 *
 * 设计说明：
 *   Toast 为单例（整个页面共享一个 Shadow DOM 容器），
 *   不继承 BaseComponent（生命周期与通用组件不同：常驻、多条堆叠）。
 */
;(function () {
  'use strict';

  const G = window.GeekOzon;
  if (!G || G.isLoaded('toast')) return;

  const Tokens = G.components.DesignTokens;
  const DomUtils = G.core.DomUtils;

  const HOST_ID = 'geekozon-toast-host';
  const DEFAULT_DURATION = 3000;

  // 类型 → 主题色映射
  const TYPE_THEME = {
    success: Tokens.color.success,
    error: Tokens.color.danger,
    warn: Tokens.color.warning,
    info: Tokens.color.info,
  };

  // 类型 → SVG path（Lucide 风格，24x24 viewBox）
  const TYPE_ICON_PATH = {
    success: 'M20 6 9 17l-5-5',
    error: 'M18 6 6 18M6 6l12 12',
    warn: 'M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0ZM12 9v4M12 17h.01',
    info: 'M12 22a10 10 0 1 1 0-20 10 10 0 0 1 0 20ZM12 16v-4M12 8h.01',
  };

  /** 生成类型对应的 SVG 图标 HTML */
  function typeIcon(type) {
    const path = TYPE_ICON_PATH[type] || TYPE_ICON_PATH.info;
    return '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + path + '</svg>';
  }

  const Toast = {
    host: null,
    shadow: null,
    container: null,
    _inited: false,

    /** 初始化 Shadow DOM 容器（懒加载，首次 show 时调用） */
    _init() {
      if (this._inited) return;
      const result = DomUtils.createShadowHost(HOST_ID, '', {
        position: 'fixed',
        top: 0,
        left: 0,
        right: 0,
        zIndex: Tokens.z.toast,
      });
      this.host = result.host;
      this.shadow = result.shadow;

      const styleEl = document.createElement('style');
      styleEl.textContent = Tokens.baseStyles + '\n' + this._getStyles();
      this.shadow.appendChild(styleEl);

      const container = document.createElement('div');
      container.className = 'go-toast-stack';
      this.shadow.appendChild(container);
      this.container = container;

      this._inited = true;
    },

    _getStyles() {
      return `
        .go-toast-stack {
          display: flex; flex-direction: column; align-items: center;
          gap: ${Tokens.space.sm};
          padding: ${Tokens.space.lg} ${Tokens.space.base} 0;
          pointer-events: none;
        }
        .go-toast {
          pointer-events: auto;
          display: flex; align-items: center; gap: ${Tokens.space.sm};
          min-width: 240px; max-width: 440px;
          padding: ${Tokens.space.sm} ${Tokens.space.base} ${Tokens.space.sm} ${Tokens.space.sm};
          background: ${Tokens.color.bgBase};
          border: 1px solid ${Tokens.color.border};
          border-radius: ${Tokens.radius.md};
          box-shadow: ${Tokens.shadow.lg};
          font-size: ${Tokens.font.sizeLg};
          color: ${Tokens.color.textPrimary};
          animation: goToastIn ${Tokens.animation.duration} ${Tokens.animation.easingOut};
          overflow: hidden;
        }
        .go-toast-icon {
          flex-shrink: 0;
          width: 26px; height: 26px;
          border-radius: ${Tokens.radius.base};
          display: inline-flex; align-items: center; justify-content: center;
          color: ${Tokens.color.textInverse};
        }
        .go-toast-msg {
          flex: 1;
          line-height: ${Tokens.font.lineHeight};
          word-break: break-word;
        }
        .go-toast-close {
          flex-shrink: 0;
          width: 22px; height: 22px;
          border: none; background: transparent;
          color: ${Tokens.color.textMuted};
          cursor: pointer; padding: 0;
          display: inline-flex; align-items: center; justify-content: center;
          border-radius: ${Tokens.radius.sm};
          transition: background ${Tokens.animation.durationFast} ${Tokens.animation.easing}, color ${Tokens.animation.durationFast} ${Tokens.animation.easing};
        }
        .go-toast-close:hover {
          color: ${Tokens.color.textPrimary};
          background: ${Tokens.color.bgMuted};
        }
        @keyframes goToastIn {
          from { transform: translateY(-12px); opacity: 0; }
          to { transform: translateY(0); opacity: 1; }
        }
        @keyframes goToastOut {
          from { transform: translateY(0); opacity: 1; }
          to { transform: translateY(-12px); opacity: 0; }
        }
        .go-toast.leaving {
          animation: goToastOut 0.2s ${Tokens.animation.easing} forwards;
        }
      `;
    },

    /**
     * 显示一条通知
     * @param {string} msg - 消息文本
     * @param {string} [type=info] - success/error/warn/info
     * @param {number} [duration=3000] - 自动关闭毫秒数，0 表示不自动关闭
     */
    show(msg, type, duration) {
      this._init();
      type = TYPE_THEME[type] ? type : 'info';
      duration = duration == null ? DEFAULT_DURATION : duration;

      const color = TYPE_THEME[type];
      const toast = document.createElement('div');
      toast.className = 'go-toast';
      toast.innerHTML =
        '<div class="go-toast-icon" style="background:' + color + '">' +
          typeIcon(type) +
        '</div>' +
        '<div class="go-toast-msg">' + G.utils.escapeHtml(msg) + '</div>' +
        '<button class="go-toast-close" title="关闭" aria-label="关闭"><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 6 6 18M6 6l12 12"/></svg></button>';
      this.container.appendChild(toast);

      // 手动关闭
      const closeBtn = toast.querySelector('.go-toast-close');
      let timer = null;
      const dismiss = function () {
        if (toast._dismissed) return;
        toast._dismissed = true;
        if (timer) { clearTimeout(timer); timer = null; }
        toast.classList.add('leaving');
        setTimeout(function () {
          if (toast.parentNode) toast.parentNode.removeChild(toast);
        }, 220);
      };
      closeBtn.addEventListener('click', dismiss);

      // 自动关闭
      if (duration > 0) {
        timer = setTimeout(dismiss, duration);
      }
      return { el: toast, dismiss: dismiss };
    },

    /** 成功通知 */
    success(msg, duration) { return this.show(msg, 'success', duration); },
    /** 错误通知 */
    error(msg, duration) { return this.show(msg, 'error', duration); },
    /** 警告通知 */
    warn(msg, duration) { return this.show(msg, 'warn', duration); },
    /** 信息通知 */
    info(msg, duration) { return this.show(msg, 'info', duration); },
  };

  G.components.Toast = Toast;
  G.markLoaded('toast');
})();
