/**
 * GeekOzon 扩展 - 事件总线
 * 组件间解耦通信（同页面内，不跨 tab）
 * 支持命名空间事件：'card:refresh' / 'favorite:toggled' / 'settings:changed'
 */
;(function () {
  'use strict';

  const G = window.GeekOzon;
  if (!G || G.isLoaded('event-bus')) return;

  const _listeners = {};

  const EventBus = {
    /**
     * 订阅事件
     * @param {string} event - 事件名
     * @param {function} cb - 回调
     * @returns {function} 取消订阅函数
     */
    on: function (event, cb) {
      if (!_listeners[event]) _listeners[event] = [];
      _listeners[event].push(cb);
      const self = this;
      return function () { self.off(event, cb); };
    },

    /** 订阅一次 */
    once: function (event, cb) {
      const self = this;
      const wrapper = function () {
        cb.apply(null, arguments);
        self.off(event, wrapper);
      };
      return this.on(event, wrapper);
    },

    /** 取消订阅 */
    off: function (event, cb) {
      if (!_listeners[event]) return;
      if (!cb) { _listeners[event] = []; return; }
      const idx = _listeners[event].indexOf(cb);
      if (idx >= 0) _listeners[event].splice(idx, 1);
    },

    /**
     * 触发事件
     * @param {string} event - 事件名
     * @param {...any} args - 参数
     */
    emit: function (event) {
      const args = Array.prototype.slice.call(arguments, 1);
      const list = _listeners[event];
      if (!list) return;
      // 复制一份，防止回调中 off 导致索引错乱
      list.slice().forEach(function (cb) {
        try { cb.apply(null, args); }
        catch (e) { console.error('[GeekOzon] EventBus 回调异常:', event, e); }
      });
    },

    /** 标准事件名常量（防拼写错误） */
    EVENTS: {
      CARD_REFRESH: 'card:refresh',
      CARD_DATA_UPDATED: 'card:data-updated',
      FAVORITE_TOGGLED: 'favorite:toggled',
      FIELD_SETTINGS_CHANGED: 'settings:field-changed',
      BLACK_TAG_REFRESH: 'blacktag:refresh',
      LIST_CARDS_REFRESH: 'listcards:refresh',
      PUBLISH_DONE: 'publish:done',
      PRICING_DONE: 'pricing:done',
      SELECTION_RULES_CHANGED: 'selection:rules-changed',
      TAB_PRODUCT_DETECTED: 'tab:product-detected',
    },
  };

  G.core.EventBus = EventBus;
  G.markLoaded('event-bus');
})();
