/**
 * GeekOzon 扩展 - 设计系统 Token（v2 现代 SaaS）
 * 主色：清晰蓝 #2563eb，搭配翠绿状态色与中性灰阶
 * 视觉语言：克制配色、细腻灰阶、多层阴影、SVG 线性图标
 * 兼容性：保留 v1 全部属性名，业务弹窗无需改动即可继承新配色
 */
;(function () {
  'use strict';

  const G = window.GeekOzon;
  if (!G || G.isLoaded('design-tokens')) return;

  /** slate 中性灰阶（Tailwind slate 体系，细腻现代） */
  const SLATE = {
    50: '#f8fafc', 100: '#f1f5f9', 200: '#e2e8f0', 300: '#cbd5e1',
    400: '#94a3b8', 500: '#64748b', 600: '#475569', 700: '#334155',
    800: '#1e293b', 900: '#0f172a',
  };

  const Tokens = {
    // ===== 颜色 =====
    color: {
      // 主色（blue-600）
      primary: '#2563eb',
      primaryHover: '#1d4ed8',
      primaryActive: '#1e40af',
      primarySubtle: '#eff6ff',
      primaryBorder: '#bfdbfe',

      // 强调红（保留属性名以兼容业务；语义已收敛为"黑标价红/危险"）
      accentRed: 'rgba(37,99,235,0.16)',
      accentRedStrong: 'rgba(238,19,27,0.28)',    // 黑标价/危险光晕，更克制
      accentRedSolid: '#ee131b',                   // Ozon 黑标价红（业务语义色，保留）

      // 文字
      textPrimary: SLATE[900],
      textSecondary: SLATE[600],
      textMuted: SLATE[400],
      textInverse: '#ffffff',

      // 背景
      bgBase: '#ffffff',
      bgSubtle: SLATE[50],
      bgMuted: SLATE[100],
      bgOverlay: 'rgba(15,23,42,0.55)',          // slate-900/55 沉浸遮罩
      bgOverlayLight: 'rgba(15,23,42,0.35)',

      // 边框
      border: SLATE[200],
      borderStrong: SLATE[300],
      borderFocus: '#2563eb',

      // 语义色（现代 SaaS 色板，含浅底背景）
      success: '#10b981',        successBg: '#ecfdf5',   // emerald
      info: '#3b82f6',           infoBg: '#eff6ff',      // blue
      warning: '#f59e0b',        warningBg: '#fffbeb',   // amber
      danger: '#ef4444',         dangerBg: '#fef2f2',    // red
      dangerStrong: '#dc2626',

      // 渐变（保留属性名兼容业务；色调由黄/绿改为靛蓝/翠）
      gradientYellowTop: 'linear-gradient(to bottom, rgba(37,99,235,0.04) 0%, #ffffff 70%)',
      gradientGreenTop: 'linear-gradient(to bottom, rgba(16,185,129,0.06) 0%, #ffffff 70%)',
      gradientStoreBar: 'linear-gradient(to right, rgba(37,99,235,0.04), #ffffff)',
    },

    // ===== 间距（4 倍数体系） =====
    space: {
      xs: '4px',
      sm: '8px',
      md: '12px',
      base: '16px',
      lg: '20px',
      xl: '24px',
      xxl: '32px',
    },

    // ===== 圆角（克制现代，比 v1 的 20px 更收敛） =====
    radius: {
      sm: '6px',
      base: '8px',
      md: '10px',
      lg: '14px',
      pill: '9999px',
    },

    // ===== 阴影（细腻多层，去掉红色光晕） =====
    shadow: {
      xs: '0 1px 2px 0 rgba(15,23,42,0.05)',
      sm: '0 1px 3px 0 rgba(15,23,42,0.08), 0 1px 2px -1px rgba(15,23,42,0.08)',
      md: '0 4px 6px -1px rgba(15,23,42,0.08), 0 2px 4px -2px rgba(15,23,42,0.06)',
      lg: '0 10px 15px -3px rgba(15,23,42,0.08), 0 4px 6px -4px rgba(15,23,42,0.08)',
      xl: '0 20px 25px -5px rgba(15,23,42,0.1), 0 8px 10px -6px rgba(15,23,42,0.08)',
      card: '0 1px 3px 0 rgba(15,23,42,0.06), 0 1px 2px -1px rgba(15,23,42,0.05)',
      modal: '0 20px 25px -5px rgba(15,23,42,0.12), 0 8px 10px -6px rgba(15,23,42,0.08)',
      drawer: '-12px 0 28px 0 rgba(15,23,42,0.12)',
      // 按钮阴影：去掉红色光晕，改为主色 focus ring（业务弹窗引用同名属性自动获得新视觉）
      buttonPrimary: '0 1px 2px 0 rgba(15,23,42,0.06), 0 0 0 1px rgba(37,99,235,0.18)',
      buttonPrimaryHover: '0 4px 8px -2px rgba(37,99,235,0.24), 0 0 0 1px rgba(37,99,235,0.2)',
      toggle: '0 0 0 3px rgba(37,99,235,0.32)',
      toggleHover: '0 0 0 4px rgba(37,99,235,0.38)',
      focus: '0 0 0 3px rgba(37,99,235,0.28)',
    },

    // ===== 字体 =====
    font: {
      family: 'Inter, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif',
      sizeXs: '10px',
      sizeSm: '11px',
      sizeBase: '12px',
      sizeMd: '13px',
      sizeLg: '14px',
      sizeXl: '15px',
      sizeTitle: '16px',
      sizeH2: '18px',
      sizeH1: '20px',
      weightNormal: '400',
      weightMedium: '500',
      weightSemi: '600',
      weightBold: '700',
      lineHeight: '1.5',
    },

    // ===== 动画 =====
    animation: {
      duration: '0.2s',
      durationFast: '0.15s',
      durationSlow: '0.3s',
      easing: 'cubic-bezier(0.4, 0, 0.2, 1)',
      easingOut: 'cubic-bezier(0.16, 1, 0.3, 1)',  // 现代出场曲线
      keyframes: {
        slideInRight: '@keyframes goSlideIn { from { transform: translateX(24px); opacity: 0; } to { transform: translateX(0); opacity: 1; } }',
        slideUp: '@keyframes goSlideUp { from { transform: translateY(8px); opacity: 0; } to { transform: translateY(0); opacity: 1; } }',
        fadeIn: '@keyframes goFadeIn { from { opacity: 0; } to { opacity: 1; } }',
        zoomIn: '@keyframes goZoomIn { from { transform: scale(0.96); opacity: 0; } to { transform: scale(1); opacity: 1; } }',
        shine: '@keyframes goShine { 0% { left: -80%; } 100% { left: 130%; } }',
        spin: '@keyframes goSpin { to { transform: rotate(360deg); } }',
      },
    },

    // ===== z-index 层级 =====
    z: {
      base: 100,
      card: 2147483646,        // 数据卡片
      toggle: 2147483646,      // 折叠按钮
      toast: 2147483647,       // Toast（最高）
      modal: 2147483647,       // 模态框
      drawer: 2147483647,      // 抽屉
      popover: 2147483645,     // 弹出层
    },
  };

  /**
   * 基础样式（Shadow DOM 内 :host 重置 + 全局 keyframes）
   */
  Tokens.baseStyles = `
    :host {
      all: initial;
      font-family: ${Tokens.font.family};
      line-height: ${Tokens.font.lineHeight};
      -webkit-font-smoothing: antialiased;
      -moz-osx-font-smoothing: grayscale;
      text-rendering: optimizeLegibility;
    }
    * { margin: 0; padding: 0; box-sizing: border-box; }
    button { font-family: inherit; cursor: pointer; }
    button:focus-visible { outline: none; box-shadow: ${Tokens.shadow.focus}; }
    input, select, textarea { font-family: inherit; outline: none; }
    input:focus, select:focus, textarea:focus { box-shadow: ${Tokens.shadow.focus}; }
    ${Tokens.animation.keyframes.slideInRight}
    ${Tokens.animation.keyframes.slideUp}
    ${Tokens.animation.keyframes.fadeIn}
    ${Tokens.animation.keyframes.zoomIn}
    ${Tokens.animation.keyframes.shine}
    ${Tokens.animation.keyframes.spin}
  `;

  /**
   * 按钮样式（靛蓝主色，无红色光晕，hover 上移 + subtle 阴影）
   * 保留 v1 的类名（go-btn / go-btn-primary 等）以兼容业务弹窗
   */
  Tokens.buttonStyles = `
    .go-btn {
      flex: 1;
      display: inline-flex; align-items: center; justify-content: center; gap: ${Tokens.space.sm};
      padding: 7px 14px;
      border: 1px solid transparent;
      border-radius: ${Tokens.radius.base};
      font-size: ${Tokens.font.sizeMd};
      font-weight: ${Tokens.font.weightMedium};
      line-height: 1.4;
      cursor: pointer;
      transition: background ${Tokens.animation.durationFast} ${Tokens.animation.easing},
                  border-color ${Tokens.animation.durationFast} ${Tokens.animation.easing},
                  color ${Tokens.animation.durationFast} ${Tokens.animation.easing},
                  box-shadow ${Tokens.animation.durationFast} ${Tokens.animation.easing},
                  transform ${Tokens.animation.durationFast} ${Tokens.animation.easing};
      font-family: inherit;
      white-space: nowrap;
      user-select: none;
    }
    .go-btn:active { transform: translateY(0); }
    .go-btn-primary {
      background: ${Tokens.color.primary};
      color: ${Tokens.color.textInverse};
      box-shadow: ${Tokens.shadow.xs};
    }
    .go-btn-primary:hover {
      background: ${Tokens.color.primaryHover};
      box-shadow: ${Tokens.shadow.md};
      transform: translateY(-1px);
    }
    .go-btn-primary:active {
      background: ${Tokens.color.primaryActive};
      transform: translateY(0);
    }
    .go-btn-secondary {
      background: ${Tokens.color.bgBase};
      color: ${Tokens.color.textPrimary};
      border: 1px solid ${Tokens.color.borderStrong};
    }
    .go-btn-secondary:hover { background: ${Tokens.color.bgSubtle}; border-color: ${Tokens.color.textMuted}; }
    .go-btn-danger {
      background: ${Tokens.color.danger};
      color: ${Tokens.color.textInverse};
      box-shadow: ${Tokens.shadow.xs};
    }
    .go-btn-danger:hover { background: ${Tokens.color.dangerStrong}; box-shadow: ${Tokens.shadow.md}; transform: translateY(-1px); }
    .go-btn-ghost {
      background: transparent;
      color: ${Tokens.color.textSecondary};
      border: 1px solid transparent;
    }
    .go-btn-ghost:hover { background: ${Tokens.color.bgMuted}; color: ${Tokens.color.textPrimary}; }
    .go-btn:disabled { opacity: 0.5; cursor: not-allowed; transform: none !important; box-shadow: ${Tokens.shadow.xs} !important; }
  `;

  G.components.DesignTokens = Tokens;
  G.markLoaded('design-tokens');
})();
