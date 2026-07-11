/**
 * GeekOzon 扩展 - Service Worker（消息中枢）
 * 职责：
 *  1. 跨 tab 借权：把 CROSS_TAB_OZON_REQUEST 转发给 seller.ozon.ru 标签页
 *  2. Cookie 查询：GET_COOKIES
 *  3. 标签页管理：CHECK_SELLER_TAB / REFRESH_SELLER_TAB
 *  4. 采集任务分发：COLLECT_PRODUCT（转发给当前 active tab）
 *  5. 命令快捷键：collect-product / quick-publish
 *
 * 不依赖任何毛子云端，直连本地 GeekOzon 后端
 */
;(function () {
  'use strict';

  // ===== 常量 =====
  const SELLER_OZON_URL = 'https://seller.ozon.ru/';
  const MSG = {
    CROSS_TAB_OZON_REQUEST: 'CROSS_TAB_OZON_REQUEST',
    CHECK_SELLER_TAB: 'CHECK_SELLER_TAB',
    TEST_SELLER_TAB_COMMUNICATION: 'TEST_SELLER_TAB_COMMUNICATION',
    REFRESH_SELLER_TAB: 'REFRESH_SELLER_TAB',
    GET_COOKIES: 'GET_COOKIES',
    OZON_SKU_API_REQUEST: 'OZON_SKU_API_REQUEST',
    COLLECT_PRODUCT: 'COLLECT_PRODUCT',
    PING_TEST: 'PING_TEST',
  };

  // ===== Tab 查询 =====

  /** 查找 seller.ozon.ru 标签页 */
  async function findSellerTab() {
    try {
      const tabs = await chrome.tabs.query({ url: 'https://seller.ozon.ru/*' });
      return tabs && tabs.length > 0 ? tabs[0] : null;
    } catch (e) {
      return null;
    }
  }

  /** 检查 seller.ozon.ru 是否打开 */
  async function checkSellerTab() {
    const tab = await findSellerTab();
    return { hasSellerTab: !!tab, tabId: tab ? tab.id : null };
  }

  // ===== Cookie =====

  /** 获取指定 URL 的 cookie */
  async function getCookiesForUrl(url, name) {
    try {
      const details = { url: url };
      if (name) details.name = name;
      return await chrome.cookies.getAll(details);
    } catch (e) {
      return [];
    }
  }

  // ===== 跨 tab 借权 =====

  /**
   * 向 seller.ozon.ru 标签页转发请求
   * seller-bridge.js 在 seller.ozon.ru 页面监听 SELLER_BRIDGE_REQUEST 消息
   */
  async function crossTabOzonRequest(message, sender) {
    const tab = await findSellerTab();
    if (!tab) {
      return {
        success: false,
        error: 'NO_SELLER_TAB',
        message: '未打开 seller.ozon.ru，请先打开并登录',
      };
    }
    try {
      const resp = await chrome.tabs.sendMessage(tab.id, {
        type: 'SELLER_BRIDGE_REQUEST',
        sku: message.sku,
        apiType: message.apiType,
        requestId: message.requestId,
      });
      return resp || { success: false, error: 'NO_RESPONSE' };
    } catch (e) {
      return { success: false, error: 'BRIDGE_INJECT_FAILED', message: e.message };
    }
  }

  // ===== 消息路由 =====

  chrome.runtime.onMessage.addListener(function (message, sender, sendResponse) {
    if (!message || !message.type) {
      sendResponse({ success: false, error: 'INVALID_MESSAGE' });
      return false;
    }

    const type = message.type;

    if (type === MSG.CHECK_SELLER_TAB) {
      checkSellerTab().then(sendResponse);
      return true;
    }

    if (type === MSG.TEST_SELLER_TAB_COMMUNICATION) {
      findSellerTab().then(function (tab) {
        if (!tab) {
          sendResponse({ success: false, error: 'NO_SELLER_TAB' });
          return;
        }
        chrome.tabs.sendMessage(tab.id, { type: 'PING' }).then(function (resp) {
          sendResponse({ success: true, tabId: tab.id, pong: resp });
        }).catch(function (e) {
          sendResponse({ success: false, error: e.message });
        });
      });
      return true;
    }

    if (type === MSG.REFRESH_SELLER_TAB) {
      findSellerTab().then(function (tab) {
        if (tab) chrome.tabs.reload(tab.id);
        sendResponse({ success: !!tab });
      });
      return true;
    }

    if (type === MSG.CROSS_TAB_OZON_REQUEST) {
      crossTabOzonRequest(message, sender).then(sendResponse);
      return true;
    }

    if (type === MSG.GET_COOKIES) {
      getCookiesForUrl(message.url, message.name).then(sendResponse);
      return true;
    }

    if (type === MSG.OZON_SKU_API_REQUEST) {
      // 直接调用 seller.ozon.ru API（不需要跨 tab，但需要 cookie）
      // 当前未使用，保留通道
      sendResponse({ success: false, error: 'NOT_IMPLEMENTED' });
      return false;
    }

    if (type === MSG.COLLECT_PRODUCT) {
      // 转发给当前 active tab 的 scanner
      chrome.tabs.query({ active: true, currentWindow: true }, function (tabs) {
        if (tabs && tabs[0]) {
          chrome.tabs.sendMessage(tabs[0].id, {
            type: 'TRIGGER_COLLECT',
            payload: message.payload || {},
          }).then(function (resp) {
            sendResponse(resp || { success: false });
          }).catch(function (e) {
            sendResponse({ success: false, error: e.message });
          });
        } else {
          sendResponse({ success: false, error: 'NO_ACTIVE_TAB' });
        }
      });
      return true;
    }

    if (type === MSG.PING_TEST) {
      sendResponse({ success: true, pong: Date.now() });
      return false;
    }

    // 未知消息
    sendResponse({ success: false, error: 'UNKNOWN_TYPE', type: type });
    return false;
  });

  // ===== 快捷命令 =====

  chrome.commands.onCommand.addListener(function (command) {
    if (command === 'collect-product') {
      chrome.tabs.query({ active: true, currentWindow: true }, function (tabs) {
        if (tabs && tabs[0]) {
          chrome.tabs.sendMessage(tabs[0].id, { type: 'TRIGGER_COLLECT' });
        }
      });
    } else if (command === 'quick-publish') {
      chrome.tabs.query({ active: true, currentWindow: true }, function (tabs) {
        if (tabs && tabs[0]) {
          chrome.tabs.sendMessage(tabs[0].id, { type: 'TRIGGER_PUBLISH' });
        }
      });
    }
  });

  // ===== 安装/更新事件 =====

  chrome.runtime.onInstalled.addListener(function (details) {
    if (details.reason === 'install') {
      console.log('[GeekOzon] 扩展已安装 v3.0.0');
    } else if (details.reason === 'update') {
      console.log('[GeekOzon] 扩展已更新到 v3.0.0');
    }
  });

  console.log('[GeekOzon] Service Worker 已启动');
})();
