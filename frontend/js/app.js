/**
 * 应用入口文件 App.js
 * 负责初始化所有组件、注册路由、启动应用
 */

(function () {
  'use strict';

  /**
   * Toast 轻提示工具
   * 提供 success/error/info/warning 四种类型的临时提示
   */
  window.Toast = (() => {
    const container = document.getElementById('toastContainer');
    const DURATION = 3000;

    /**
     * 显示提示消息
     * @param {string} message - 提示文本
     * @param {string} [type='info'] - 提示类型：success/error/info/warning
     */
    function show(message, type = 'info') {
      const toast = document.createElement('div');
      toast.className = `toast ${type}`;

      const icons = {
        success: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#22C55E" stroke-width="2.5"><path d="M20 6L9 17l-5-5"/></svg>',
        error: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#EF4444" stroke-width="2.5"><path d="M18 6L6 18M6 6l12 12"/></svg>',
        info: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#4A90D9" stroke-width="2.5"><circle cx="12" cy="12" r="10"/><path d="M12 16v-4m0-4h.01"/></svg>',
        warning: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#F59E0B" stroke-width="2.5"><path d="M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0zM12 9v4m0 4h.01"/></svg>',
      };

      toast.innerHTML = `${icons[type] || icons.info}<span>${message}</span>`;
      container.appendChild(toast);

      // 自动移除
      setTimeout(() => {
        toast.classList.add('removing');
        setTimeout(() => toast.remove(), 250);
      }, DURATION);
    }

    return { show };
  })();

  /**
   * 应用启动入口
   */
  function bootstrap() {
    console.log('[GeekOzon] 系统正在初始化...');

    // 1. 初始化 Lucide 图标库
    if (typeof lucide !== 'undefined') {
      lucide.createIcons();
    }

    // 2. 初始化各组件
    Header.init();
    Sidebar.init();

    // 3. 启动路由系统
    Router.init();

    // 4. 绑定全局键盘快捷键
    bindGlobalShortcuts();

    // 5. 加载价格换算配置（供采集时计算建议售价使用）
    loadPricingConfig();

    // 6. 显示欢迎提示
    setTimeout(() => {
      console.log('[GeekOzon] 系统初始化完成 ✓');
    }, 100);
  }

  /** 加载价格换算配置到全局变量，供 product-mapping.js 使用 */
  async function loadPricingConfig() {
    try {
      const res = await fetch('/api/config/pricing');
      const data = await res.json();
      if (data.code === 200 && data.data) {
        window._pricingConfig = data.data;
        console.log('[GeekOzon] 价格配置已加载:', data.data);
      }
    } catch (e) {
      console.warn('[GeekOzon] 加载价格配置失败，使用默认值:', e);
    }
  }

  /** 绑定全局快捷键 */
  function bindGlobalShortcuts() {
    document.addEventListener('keydown', (e) => {
      // Ctrl+K 聚焦搜索框
      if ((e.ctrlKey || e.metaKey) && e.key === 'k') {
        e.preventDefault();
        const searchInput = document.getElementById('globalSearch');
        if (searchInput) searchInput.focus();
      }

      // Ctrl+B 切换侧栏
      if ((e.ctrlKey || e.metaKey) && e.key === 'b') {
        e.preventDefault();
        Sidebar.toggle();
      }

      // Escape 关闭弹窗
      if (e.key === 'Escape') {
        Modal.close();
      }
    });

    // 移动端/桌面端切换由 Sidebar.toggle 内部判断，无需在此覆盖 onclick
  }

  // DOM 就绪后启动
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', bootstrap);
  } else {
    bootstrap();
  }
})();
