/**
 * GeekOzon 扩展 - popup 页面逻辑
 */
;(function () {
  'use strict';

  const G = window.GeekOzon;
  const ApiClient = G.core.ApiClient;
  const Config = G.core.Config;
  const CrossTab = G.core.CrossTab;

  /** 检测后端连通性 */
  async function checkBackend() {
    const el = document.getElementById('backendStatus');
    try {
      const base = await Config.getApiBaseUrl();
      document.getElementById('apiBaseUrl').textContent = base;
      const resp = await fetch(base + '/api/config/pricing', { method: 'GET' });
      if (resp.ok) {
        el.innerHTML = '<span class="badge badge-ok">已连接</span>';
      } else {
        el.innerHTML = '<span class="badge badge-warn">异常 ' + resp.status + '</span>';
      }
    } catch (e) {
      el.innerHTML = '<span class="badge badge-err">未连接</span>';
    }
  }

  /** 检测 seller.ozon.ru 标签页 */
  async function checkSellerTab() {
    const el = document.getElementById('sellerTabStatus');
    try {
      const r = await CrossTab.checkSellerTab();
      if (r.hasSellerTab) {
        el.innerHTML = '<span class="badge badge-ok">已打开</span>';
      } else {
        el.innerHTML = '<span class="badge badge-warn">未打开</span>';
      }
    } catch (e) {
      el.innerHTML = '<span class="badge badge-err">检测失败</span>';
    }
  }

  /** 加载店铺列表 */
  async function loadShops() {
    const el = document.getElementById('shopList');
    try {
      const resp = await ApiClient.fetchShops();
      if (ApiClient.isOk(resp)) {
        const list = (resp.data && resp.data.list) || [];
        if (list.length === 0) {
          el.innerHTML = '<div class="loading">暂无店铺</div>';
          return;
        }
        el.innerHTML = list.map(function (s) {
          const name = s.alias || s.store_id || '未命名';
          const authClass = s.auth_status === 'active' ? 'badge-ok' :
            (s.auth_status === 'pending' ? 'badge-warn' : 'badge-err');
          const authText = s.auth_status === 'active' ? '正常' :
            (s.auth_status === 'pending' ? '待授权' : '失效');
          const today = s.today_limit != null ? ' 今日可刊 ' + s.today_limit : '';
          return '<div class="shop-item">' +
            '<span class="shop-name">' + escapeHtml(name) + '</span>' +
            '<span><span class="badge ' + authClass + '">' + authText + '</span>' + today + '</span>' +
            '</div>';
        }).join('');
      } else {
        el.innerHTML = '<div class="loading">加载失败</div>';
      }
    } catch (e) {
      el.innerHTML = '<div class="loading">加载失败: ' + escapeHtml(e.message) + '</div>';
    }
  }

  function escapeHtml(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  /** 采集当前页 */
  function collectCurrentTab() {
    chrome.tabs.query({ active: true, currentWindow: true }, function (tabs) {
      if (tabs && tabs[0]) {
        chrome.tabs.sendMessage(tabs[0].id, { type: 'TRIGGER_COLLECT' }, function (resp) {
          if (chrome.runtime.lastError || !resp || !resp.success) {
            alert('采集失败：当前页面可能不支持采集或脚本未加载');
          } else {
            alert('采集成功！');
          }
        });
      }
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
    document.getElementById('btnOptions').addEventListener('click', function () {
      chrome.runtime.openOptionsPage();
    });
  }

  // 初始化
  checkBackend();
  checkSellerTab();
  loadShops();
  bindButtons();
})();
