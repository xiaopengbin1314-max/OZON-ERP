/**
 * GeekOzon 扩展 - 主世界注入脚本
 * 突破 content script 隔离世界限制，访问页面主世界的变量/函数
 *
 * 用法（content script 侧）：
 *   const script = document.createElement('script');
 *   script.src = chrome.runtime.getURL('entrypoints/inject.js');
 *   (document.head || document.documentElement).appendChild(script);
 *
 * 通信通道：
 *   - geekozon-inject-request：content script → 主世界（请求数据）
 *   - geekozon-inject-response：主世界 → content script（返回数据）
 *
 * 支持的 action：
 *   - 'eval'：执行表达式（受信任场景，谨慎使用）
 *   - 'getVar'：读取全局变量
 *   - 'pdd_rawData'：读取拼多多页面 rawData（用于 pdd-scanner）
 */
;(function () {
  'use strict';

  // 防重复注入
  if (window.__geekOzonInjectLoaded) return;
  window.__geekOzonInjectLoaded = true;

  /**
   * 监听 geekozon-inject-request 自定义事件
   * event.detail = { id, action, args }
   */
  window.addEventListener('geekozon-inject-request', function (e) {
    const detail = e.detail || {};
    const id = detail.id;
    const action = detail.action;
    const args = detail.args || {};
    let result = null;
    let error = null;

    try {
      switch (action) {
        case 'getVar':
          // 读取全局变量（支持点号路径：'window.xxx.yyy'）
          result = readPath(window, args.path);
          break;

        case 'pdd_rawData':
          // 拼多多页面 rawData（适配 pdd-scanner）
          result = readPddRawData();
          break;

        case 'eval':
          // 执行表达式（仅受信任场景）
          // eslint-disable-next-line no-eval
          result = eval(args.code);
          break;

        default:
          error = '未知 action: ' + action;
      }
    } catch (e) {
      error = e.message;
    }

    // 返回结果
    const respEvent = new CustomEvent('geekozon-inject-response', {
      detail: { id: id, result: result, error: error },
    });
    window.dispatchEvent(respEvent);
  });

  /** 按路径读取对象属性 */
  function readPath(obj, path) {
    if (!path) return undefined;
    const keys = String(path).split('.');
    let cur = obj;
    for (let i = 0; i < keys.length; i++) {
      if (cur == null) return undefined;
      cur = cur[keys[i]];
    }
    return cur;
  }

  /** 读取拼多多页面 rawData */
  function readPddRawData() {
    // 拼多多的商品数据通常挂在 window.rawData 或 window.__INITIAL_STATE__
    if (typeof window.rawData !== 'undefined') {
      return safeClone(window.rawData);
    }
    if (window.__INITIAL_STATE__ && window.__INITIAL_STATE__.store) {
      return safeClone(window.__INITIAL_STATE__.store);
    }
    return null;
  }

  /** 安全克隆（避免循环引用 + 函数） */
  function safeClone(obj, depth) {
    depth = depth || 0;
    if (depth > 5) return '[DEPTH_LIMIT]';
    if (obj == null || typeof obj !== 'object') return obj;
    if (typeof obj === 'function') return '[FUNCTION]';
    try {
      const str = JSON.stringify(obj, function (key, val) {
        if (typeof val === 'function') return '[FUNCTION]';
        return val;
      });
      return JSON.parse(str);
    } catch (e) {
      return '[CLONE_ERROR: ' + e.message + ']';
    }
  }

  console.log('[GeekOzon] inject.js 已注入主世界');
})();
