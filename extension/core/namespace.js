/**
 * GeekOzon 扩展 - 全局命名空间初始化
 * 所有模块通过 window.GeekOzon 挂载，避免全局污染
 * 加载顺序：本文件必须最先加载
 */
;(function () {
  'use strict';

  if (window.GeekOzon && window.GeekOzon.__initialized) return;

  /** 顶层命名空间 */
  const GeekOzon = {
    __initialized: true,
    __version: '3.0.0',
    __buildTime: '2026-06-29',

    /** 核心框架（API/存储/跨 tab/DOM/事件/采集基类） */
    core: {},

    /** 自研轻量 UI 组件库（毛子设计系统） */
    components: {},

    /** 业务功能模块（按平台/场景分组） */
    features: {},

    /** 工具函数 */
    utils: {},

    /** 运行时缓存（页面级，非持久化） */
    runtime: {
      settings: null,        // chrome.storage.local 缓存
      settingsLoadedAt: 0,    // 缓存时间戳
    },
  };

  /** 防重复加载标志（每个 content script 独立） */
  GeekOzon.loadedModules = new Set();

  /** 标记模块已加载 */
  GeekOzon.markLoaded = function (name) {
    this.loadedModules.add(name);
  };

  /** 判断模块是否已加载 */
  GeekOzon.isLoaded = function (name) {
    return this.loadedModules.has(name);
  };

  /** 安全取值：从嵌套对象按路径取值 */
  GeekOzon.utils.getPath = function (obj, path, fallback) {
    if (!obj || !path) return fallback;
    const keys = String(path).split('.');
    let cur = obj;
    for (const k of keys) {
      if (cur == null) return fallback;
      cur = cur[k];
    }
    return cur === undefined ? fallback : cur;
  };

  /** HTML 转义（防 XSS） */
  GeekOzon.utils.escapeHtml = function (str) {
    if (str == null) return '';
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  };

  /** 复制文本到剪贴板（带 execCommand 降级） */
  GeekOzon.utils.copyToClipboard = function (text) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      return navigator.clipboard.writeText(text);
    }
    return new Promise(function (resolve) {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      try { document.execCommand('copy'); } catch (_) {}
      document.body.removeChild(ta);
      resolve();
    });
  };

  /** 格式化卢布金额 */
  GeekOzon.utils.formatRub = function (num) {
    const n = Number(num) || 0;
    return '₽' + n.toLocaleString('ru-RU');
  };

  /** 防抖 */
  GeekOzon.utils.debounce = function (fn, wait) {
    let timer = null;
    return function () {
      const ctx = this, args = arguments;
      clearTimeout(timer);
      timer = setTimeout(function () { fn.apply(ctx, args); }, wait);
    };
  };

  /** 节流 */
  GeekOzon.utils.throttle = function (fn, wait) {
    let last = 0, timer = null;
    return function () {
      const ctx = this, args = arguments, now = Date.now();
      const remain = wait - (now - last);
      if (remain <= 0) {
        clearTimeout(timer);
        timer = null;
        last = now;
        fn.apply(ctx, args);
      } else if (!timer) {
        timer = setTimeout(function () {
          last = Date.now();
          timer = null;
          fn.apply(ctx, args);
        }, remain);
      }
    };
  };

  /** 空闲执行（无 requestIdleCallback 时降级 setTimeout） */
  GeekOzon.utils.idleRun = function (fn, timeout) {
    if (window.requestIdleCallback) {
      return window.requestIdleCallback(fn, { timeout: timeout || 500 });
    }
    return setTimeout(fn, 1);
  };

  /**
   * 安全执行：捕获同步异常 + 异步 Promise 异常
   * 防止单个组件故障导致整个扩展崩溃
   * @param {function} fn - 同步函数
   * @param {*} fallback - 失败时返回值
   * @param {string} [label] - 错误标签（便于定位）
   */
  GeekOzon.utils.safeRun = function (fn, fallback, label) {
    try {
      const ret = fn();
      // 若返回 Promise，自动 catch
      if (ret && typeof ret.then === 'function') {
        return ret.catch(function (err) {
          console.error('[GeekOzon]' + (label ? ' ' + label : '') + ' async error:', err);
          return fallback;
        });
      }
      return ret;
    } catch (err) {
      console.error('[GeekOzon]' + (label ? ' ' + label : '') + ' error:', err);
      return fallback;
    }
  };

  /**
   * 安全执行异步函数（async function 包装）
   */
  GeekOzon.utils.safeAsync = function (fn, label) {
    return function () {
      try {
        const ret = fn.apply(this, arguments);
        if (ret && typeof ret.then === 'function') {
          return ret.catch(function (err) {
            console.error('[GeekOzon]' + (label ? ' ' + label : '') + ' async error:', err);
          });
        }
        return ret;
      } catch (err) {
        console.error('[GeekOzon]' + (label ? ' ' + label : '') + ' error:', err);
      }
    };
  };

  /** 错误日志收集器（限制最多 50 条，避免内存泄漏） */
  GeekOzon.__errors = [];
  GeekOzon.logError = function (label, err) {
    const entry = {
      t: Date.now(),
      label: String(label || ''),
      msg: err && err.message ? err.message : String(err),
      stack: err && err.stack ? String(err.stack).slice(0, 500) : '',
    };
    GeekOzon.__errors.push(entry);
    if (GeekOzon.__errors.length > 50) GeekOzon.__errors.shift();
    // 同时输出到 console，便于调试
    console.error('[GeekOzon] ' + entry.label + ':', err);
    return entry;
  };

  /**
   * 安装全局错误捕获（仅安装一次）
   * 捕获：1) 同步运行时错误 2) Promise 未处理 rejection
   */
  GeekOzon.installGlobalErrorHandler = function () {
    if (GeekOzon.__errorHandlerInstalled) return;
    GeekOzon.__errorHandlerInstalled = true;

    // 1) 同步运行时错误（script error、undefined is not a function 等）
    window.addEventListener('error', function (e) {
      // 避免捕获跨域脚本错误（无错误信息可读）
      if (!e.error && !e.message) return;
      GeekOzon.logError('window.error', e.error || e.message);
      // 不阻止默认行为，让浏览器也记录
    }, true);

    // 2) Promise 未处理 rejection
    window.addEventListener('unhandledrejection', function (e) {
      const reason = e && e.reason;
      GeekOzon.logError('unhandledrejection', reason instanceof Error ? reason : { message: String(reason) });
    });

    // 3) Chrome 扩展 runtime 错误（lastError）
    if (typeof chrome !== 'undefined' && chrome.runtime) {
      const origGetLastError = Object.getOwnPropertyDescriptor(chrome.runtime, 'lastError');
      // 不直接拦截 lastError，仅在 API 调用时检查（各模块自行处理）
    }
  };

  // 立即安装全局错误捕获
  GeekOzon.installGlobalErrorHandler();

  window.GeekOzon = GeekOzon;
  GeekOzon.markLoaded('namespace');
})();
