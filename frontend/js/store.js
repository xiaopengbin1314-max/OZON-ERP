/**
 * 简易状态管理模块
 * 基于 Observer 模式实现跨组件状态共享与响应式更新
 * 支持持久化到 localStorage
 */
const Store = (() => {
  // 状态容器
  let state = {
    // 用户信息
    user: null,
    token: localStorage.getItem('geekozon_token') || null,

    // UI 状态
    sidebarCollapsed: false,
    currentPage: 'home',

    // 商品数据缓存
    products: [],
    productsTotal: 0,

    // 公告数据
    notices: [],

    // 发布任务
    publishTasks: [],
  };

  // 订阅者回调列表
  const listeners = new Map();

  // 需要持久化的字段
  const PERSIST_KEYS = ['token', 'sidebarCollapsed'];

  /**
   * 获取状态快照
   * @param {string} [key] - 可选，获取单个字段
   * @returns {*}
   */
  function getState(key) {
    return key ? state[key] : { ...state };
  }

  /**
   * 更新状态并通知订阅者
   * @param {object} partial - 要更新的字段对象
   * @param {string} [source] - 变更来源标识（用于调试）
   */
  function setState(partial, source) {
    const prevState = { ...state };
    state = { ...state, ...partial };

    // 持久化指定字段
    PERSIST_KEYS.forEach((key) => {
      if (key in partial && partial[key] !== undefined) {
        try {
          localStorage.setItem(`geekozon_${key}`, JSON.stringify(partial[key]));
        } catch (e) {
          // localStorage 可能不可用，静默忽略
        }
      }
    });

    // 通知所有订阅者
    notifyListeners(prevState, state, source);
  }

  /**
   * 订阅状态变化
   * @param {function} callback - 回调函数 (newState, prevState)
   * @returns {function} 取消订阅的函数
   */
  function subscribe(callback) {
    const id = Symbol('listener');
    listeners.set(id, callback);
    return () => listeners.delete(id);
  }

  /**
   * 通知所有订阅者
   */
  function notifyListeners(prevState, newState, source) {
    listeners.forEach((callback) => {
      try {
        callback(newState, prevState, source);
      } catch (e) {
        console.error('[Store] 订阅者回调异常:', e);
      }
    });
  }

  /**
   * 重置为初始状态
   */
  function reset() {
    state = {
      user: null,
      token: null,
      sidebarCollapsed: false,
      currentPage: 'home',
      products: [],
      productsTotal: 0,
      notices: [],
      publishTasks: [],
    };
    PERSIST_KEYS.forEach((key) => {
      localStorage.removeItem(`geekozon_${key}`);
    });
    notifyListeners({}, state, 'reset');
  }

  /* ===== 快捷访问器 ===== */
  function getToken() { return state.token; }
  function getUser() { return state.user; }
  function isSidebarCollapsed() { return state.sidebarCollapsed; }
  function getCurrentPage() { return state.currentPage; }

  return {
    getState,
    setState,
    subscribe,
    reset,
    getToken,
    getUser,
    isSidebarCollapsed,
    getCurrentPage,
  };
})();
