/**
 * 前端 Hash Router 路由管理模块
 * 基于 window.location.hash 实现 SPA 页面切换
 * 支持路由守卫、参数解析、页面过渡动画
 */
const Router = (() => {
  // 路由配置表：path → 渲染函数
  const routes = new Map();

  // 当前路由信息
  let currentRoute = null;

  // 路由变化前的钩子（用于守卫/确认离开）
  const beforeHooks = [];

  // 默认路由
  const DEFAULT_ROUTE = '/home';

  /**
   * 注册路由
   * @param {string} path - 路由路径（如 /home, /collect）
   * @param {function} renderFn - 页面渲染函数，接收 route 参数
   */
  function register(path, renderFn) {
    routes.set(path, renderFn);
  }

  /**
   * 导航到指定路径
   * @param {string} path - 目标路径
   */
  function navigate(path) {
    window.location.hash = `#${path}`;
  }

  /**
   * 解析当前 hash 为路由信息
   * @returns {{ path: string, params: object, query: object }}
   */
  function parseHash() {
    const hash = window.location.hash.slice(1) || DEFAULT_ROUTE;
    const [pathPart, ...queryParts] = hash.split('?');
    const path = pathPart || DEFAULT_ROUTE;
    const query = {};

    if (queryParts.length > 0) {
      queryParts.join('?').split('&').forEach((pair) => {
        const [key, value] = pair.split('=');
        if (key) query[decodeURIComponent(key)] = decodeURIComponent(value || '');
      });
    }

    // 提取路径参数（如 /product/:id）
    const segments = path.split('/');
    const params = {};
    // 尝试匹配带参数的路由
    for (const [routePath] of routes) {
      const routeSegments = routePath.split('/');
      if (segments.length === routeSegments.length) {
        let match = true;
        for (let i = 0; i < routeSegments.length; i++) {
          if (routeSegments[i].startsWith(':')) {
            params[routeSegments[i].slice(1)] = segments[i];
          } else if (routeSegments[i] !== segments[i]) {
            match = false;
            break;
          }
        }
        if (match) return { path: routePath, params, query };
      }
    }

    return { path, params, query };
  }

  /**
   * 执行路由跳转与页面渲染
   */
  async function resolve() {
    const routeInfo = parseHash();

    // 如果是同一路由则不重复渲染
    if (currentRoute && currentRoute.path === routeInfo.path) return;

    // 执行前置守卫
    for (const hook of beforeHooks) {
      const result = hook(routeInfo, currentRoute);
      if (result === false) return; // 阻止导航
    }

    const prevRoute = currentRoute;
    currentRoute = routeInfo;

    // 更新全局状态中的当前页
    if (typeof Store !== 'undefined') {
      Store.setState({ currentPage: routeInfo.path.replace('/', '') }, 'router');
    }

    // 更新侧栏激活状态
    Sidebar?.setActiveItem?.(currentRoute.path);

    // 查找渲染函数
    const renderFn = routes.get(routeInfo.path);

    const container = document.getElementById('pageContainer');
    if (!container) return;

    if (renderFn) {
      // 执行渲染
      container.innerHTML = '';
      const content = renderFn(routeInfo);
      if (typeof content === 'string') {
        container.innerHTML = content;
      } else if (content instanceof HTMLElement) {
        container.appendChild(content);
      }

      // 重新初始化 Lucide 图标
      if (window.lucide) lucide.createIcons();
    } else {
      // 未注册的路由显示 404
      container.innerHTML = `
        <div class="empty-state">
          <div class="empty-icon">📄</div>
          <p>页面「${routeInfo.path}」正在开发中...</p>
          <button class="btn btn-primary btn-sm" onclick="Router.navigate('/home')">
            返回首页
          </button>
        </div>`;
    }
  }

  /**
   * 添加路由前置守卫
   * @param {function} hook - 守卫函数，返回 false 可阻止导航
   */
  function beforeEach(hook) {
    beforeHooks.push(hook);
  }

  /**
   * 初始化路由监听
   */
  function init() {
    // 监听 hash 变化
    window.addEventListener('hashchange', resolve);
    // 初始加载时立即解析
    resolve();
  }

  return {
    register,
    navigate,
    parseHash,
    resolve,
    beforeEach,
    init,
    get currentRoute() { return currentRoute; },
  };
})();
