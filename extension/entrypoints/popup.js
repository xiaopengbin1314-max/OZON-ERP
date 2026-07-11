/**
 * GeekOzon 扩展 - popup 页面逻辑
 */
;(function () {
  'use strict';

  const G = window.GeekOzon;
  const ApiClient = G.core.ApiClient;
  const Config = G.core.Config;
  const CrossTab = G.core.CrossTab;

  let toastTimer = null;
  function showToast(message, type) {
    const el = document.getElementById('popupToast');
    if (!el) return;
    clearTimeout(toastTimer);
    el.textContent = message;
    el.className = 'toast show' + (type === 'error' ? ' error' : '');
    toastTimer = setTimeout(function () { el.className = 'toast'; }, 2600);
  }

  function statusHtml(text, kind) {
    return '<span class="badge badge-' + kind + '">' + escapeHtml(text) + '</span>';
  }

  /** 检测后端连通性 */
  async function checkBackend() {
    const el = document.getElementById('backendStatus');
    try {
      const base = await Config.getApiBaseUrl();
      document.getElementById('apiBaseUrl').textContent = base;
      const resp = await fetch(base + '/api/config/pricing', { method: 'GET' });
      if (resp.ok) {
        el.innerHTML = statusHtml('运行正常', 'ok');
      } else {
        el.innerHTML = statusHtml('响应异常 ' + resp.status, 'warn');
      }
    } catch (e) {
      el.innerHTML = statusHtml('无法连接', 'err');
    }
  }

  /** 检测 seller.ozon.ru 标签页 */
  async function checkSellerTab() {
    const el = document.getElementById('sellerTabStatus');
    try {
      const r = await CrossTab.checkSellerTab();
      if (r.hasSellerTab) {
        el.innerHTML = statusHtml('桥接可用', 'ok');
      } else {
        el.innerHTML = statusHtml('未打开', 'warn');
      }
    } catch (e) {
      el.innerHTML = statusHtml('检测失败', 'err');
    }
  }

  /** 加载店铺列表 */
  async function loadShops() {
    const el = document.getElementById('shopList');
    try {
      const resp = await ApiClient.fetchShops();
      if (ApiClient.isOk(resp)) {
        const list = (resp.data && resp.data.list) || [];
        document.getElementById('shopCount').textContent = list.length + ' 个店铺';
        if (list.length === 0) {
          el.innerHTML = '<div class="loading">暂无店铺</div>';
          return;
        }
        el.innerHTML = list.map(function (s) {
          const authStatus = s.authStatus || s.auth_status || '';
          const todayLimit = s.todayLimit != null ? s.todayLimit : s.today_limit;
          const name = s.alias || s.storeId || s.store_id || '未命名';
          const authClass = authStatus === 'active' ? 'badge-ok' :
            (authStatus === 'pending' ? 'badge-warn' : 'badge-err');
          const authText = authStatus === 'active' ? '正常' :
            (authStatus === 'pending' ? '待授权' : '失效');
          const today = todayLimit != null ? '可刊 ' + todayLimit : '';
          return '<div class="shop-item">' +
            '<span class="shop-name">' + escapeHtml(name) + '</span>' +
            '<span class="shop-meta"><span class="badge ' + authClass + '">' + authText + '</span><span>' + today + '</span></span>' +
            '</div>';
        }).join('');
      } else {
        document.getElementById('shopCount').textContent = '同步失败';
        el.innerHTML = '<div class="loading">加载失败</div>';
      }
    } catch (e) {
      document.getElementById('shopCount').textContent = '同步失败';
      el.innerHTML = '<div class="loading">暂时无法读取店铺</div>';
    }
  }

  function detectCurrentPage() {
    chrome.tabs.query({ active: true, currentWindow: true }, function (tabs) {
      const tab = tabs && tabs[0];
      const title = document.getElementById('currentPageTitle');
      const host = document.getElementById('currentPageHost');
      const tag = document.getElementById('pageStatus');
      const collect = document.getElementById('btnCollect');
      if (!tab) return;
      let hostname = '';
      try { hostname = new URL(tab.url || '').hostname; } catch (_) {}
      const supported = /(^|\.)(ozon\.|1688\.com|taobao\.com|tmall\.com|jd\.com|pinduoduo\.com|yangkeduo\.com|aliexpress\.|amazon\.|wildberries\.ru)/i.test(hostname);
      title.textContent = tab.title || '当前页面';
      host.textContent = hostname || '浏览器内部页面';
      tag.textContent = supported ? '可采集' : '不支持';
      tag.className = 'page-tag' + (supported ? ' supported' : '');
      collect.disabled = !supported;
      collect.querySelector('span').textContent = supported ? '采集当前商品' : '当前页面不可采集';
    });
  }

  function escapeHtml(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  /** 采集当前页 */
  function collectCurrentTab() {
    const button = document.getElementById('btnCollect');
    const label = button.querySelector('span');
    button.disabled = true;
    label.textContent = '正在采集...';
    chrome.tabs.query({ active: true, currentWindow: true }, function (tabs) {
      if (tabs && tabs[0]) {
        chrome.tabs.sendMessage(tabs[0].id, { type: 'TRIGGER_COLLECT' }, function (resp) {
          if (chrome.runtime.lastError || !resp || !resp.success) {
            showToast('采集失败，请刷新商品页后重试', 'error');
          } else {
            showToast('商品已采集到 ERP');
          }
          button.disabled = false;
          label.textContent = '采集当前商品';
        });
      } else {
        button.disabled = false;
        label.textContent = '采集当前商品';
        showToast('没有找到当前标签页', 'error');
      }
    });
  }

  function refreshAll() {
    const button = document.getElementById('btnRefresh');
    button.disabled = true;
    Promise.all([checkBackend(), checkSellerTab(), loadShops()]).finally(function () {
      detectCurrentPage();
      button.disabled = false;
      showToast('状态已刷新');
    });
  }

  /** 绑定按钮 */
  function bindButtons() {
    document.getElementById('btnCollect').addEventListener('click', collectCurrentTab);
    document.getElementById('btnErp').addEventListener('click', function () {
      Config.getApiBaseUrl().then(function (base) {
        window.open(base + '/', '_blank');
      });
    });
    document.getElementById('btnSeller').addEventListener('click', function () {
      window.open('https://seller.ozon.ru/', '_blank');
    });
    document.getElementById('btnRefresh').addEventListener('click', refreshAll);
    document.getElementById('btnOptions').addEventListener('click', function () {
      chrome.runtime.openOptionsPage();
    });
  }

  // 初始化
  checkBackend();
  checkSellerTab();
  loadShops();
  detectCurrentPage();
  bindButtons();
})();
