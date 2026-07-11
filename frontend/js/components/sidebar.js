/**
 * 左侧折叠菜单组件
 * 管理侧栏展开/折叠、子菜单、移动端适配
 */
const Sidebar = (() => {
  let isCollapsed = false;
  let elements = {};

  function init() {
    elements.sidebar = document.getElementById('sidebar');
    elements.toggleBtn = document.getElementById('sidebarToggle');
    elements.collapseBtn = document.getElementById('collapseSidebarBtn');
    elements.mobileOverlay = document.getElementById('mobileOverlay');
    elements.mainContent = document.getElementById('mainContent');
    elements.navParents = document.querySelectorAll('.nav-parent[data-expandable]');

    // 折叠按钮（Header 中）
    if (elements.toggleBtn) {
      elements.toggleBtn.addEventListener('click', toggle);
    }

    // 底部收起按钮
    if (elements.collapseBtn) {
      elements.collapseBtn.addEventListener('click', toggle);
    }

    // 移动端遮罩点击关闭
    if (elements.mobileOverlay) {
      elements.mobileOverlay.addEventListener('click', closeMobile);
    }

    // 可展开父级菜单
    console.log('[Sidebar] navParents count:', elements.navParents.length);
    elements.navParents.forEach((parent) => {
      const btn = parent.querySelector(':scope > .nav-item');
      console.log('[Sidebar] binding:', parent.querySelector('.menu-text')?.textContent, 'btn:', btn);
      if (!btn) {
        console.warn('[Sidebar] 未找到 button:', parent);
        return;
      }
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        parent.classList.toggle('expanded');
        console.log('[Sidebar] expanded:', parent.classList.contains('expanded'));
      });
    });

    // 导航项点击后关闭移动端菜单
    elements.sidebar.querySelectorAll('.nav-item[href]').forEach((item) => {
      item.addEventListener('click', () => closeMobile());
    });

    // 恢复持久化的折叠状态
    const savedCollapsed = localStorage.getItem('geekozon_sidebarCollapsed');
    if (savedCollapsed === 'true') {
      isCollapsed = false; // 先设为 false，让 toggle 变为 true
      toggle(true); // 静默切换，不触发动画
    }
  }

  /**
   * 切换侧栏展开/折叠
   * @param {boolean} silent - 是否静默切换（不触发状态更新）
   */
  function toggle(silent = false) {
    // 移动端：切换 mobile-open 状态
    if (window.matchMedia('(max-width: 1023px)').matches) {
      if (elements.sidebar.classList.contains('mobile-open')) {
        closeMobile();
      } else {
        openMobile();
      }
      return;
    }

    isCollapsed = !isCollapsed;

    elements.sidebar.classList.toggle('collapsed', isCollapsed);
    elements.mainContent.classList.toggle('collapsed-layout', isCollapsed);

    // 更新图标方向
    const icon = elements.toggleBtn?.querySelector('i, [data-lucide]');
    if (icon) {
      icon.setAttribute('data-lucide', isCollapsed ? 'panel-left-open' : 'panel-left-close');
      if (window.lucide) lucide.createIcons();
    }

    if (!silent && typeof Store !== 'undefined') {
      Store.setState({ sidebarCollapsed: isCollapsed }, 'sidebar-toggle');
    }
  }

  /** 打开移动端侧栏 */
  function openMobile() {
    elements.sidebar.classList.add('mobile-open');
    if (elements.mobileOverlay) {
      elements.mobileOverlay.style.display = 'block';
    }
  }

  /** 关闭移动端侧栏 */
  function closeMobile() {
    elements.sidebar.classList.remove('mobile-open');
    if (elements.mobileOverlay) {
      elements.mobileOverlay.style.display = 'none';
    }
  }

  /** 设置当前激活的导航项 */
  function setActiveItem(path) {
    // 移除所有 active 类
    elements.sidebar.querySelectorAll('.nav-item.active').forEach((el) => {
      el.classList.remove('active');
    });

    // 查找并设置匹配项
    const targetSelector = `.nav-item[data-page="${path.replace('/', '')}"]`;
    const targetEl = elements.sidebar.querySelector(targetSelector);
    if (targetEl) {
      targetEl.classList.add('active');

      // 展开父级菜单
      const parentMenu = targetEl.closest('.nav-parent');
      if (parentMenu) parentMenu.classList.add('expanded');
    } else {
      // 默认高亮首页
      const homeItem = elements.sidebar.querySelector('.nav-item[data-page="home"]');
      if (homeItem) homeItem.classList.add('active');
    }
  }

  return { init, toggle, openMobile, closeMobile, setActiveItem };
})();
