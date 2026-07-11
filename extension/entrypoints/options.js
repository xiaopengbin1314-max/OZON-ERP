/**
 * GeekOzon 扩展 - options 设置页逻辑
 */
;(function () {
  'use strict';

  const G = window.GeekOzon;
  const Config = G.core.Config;
  const ApiClient = G.core.ApiClient;

  const DEFAULTS = {
    apiBaseUrl: 'http://localhost:5000',
    blackPriceRatio: 0.95,
    exchangeRate: 12.5,
    profitMargin: 1.3,
    oldPriceRatio: 1.2,
    defaultCurrency: 'CNY',
    shippingRate: 80,
    volumetricDivisor: 5000,
    returnRate: 0,
    lossRate: 0,
    packagingFee: 0,
  };

  const FIELDS = ['apiBaseUrl', 'blackPriceRatio', 'exchangeRate', 'profitMargin',
    'oldPriceRatio', 'defaultCurrency', 'shippingRate', 'volumetricDivisor',
    'returnRate', 'lossRate', 'packagingFee'];

  /** 加载设置 */
  async function loadSettings() {
    const settings = await Config.getSettings();
    FIELDS.forEach(function (key) {
      const el = document.getElementById(key);
      if (el) {
        const val = settings[key] !== undefined ? settings[key] : DEFAULTS[key];
        el.value = val;
      }
    });
  }

  /** 保存设置 */
  async function saveSettings() {
    const patch = {};
    FIELDS.forEach(function (key) {
      const el = document.getElementById(key);
      if (el) {
        let val = el.value;
        if (el.type === 'number') {
          val = parseFloat(val) || 0;
        }
        patch[key] = val;
      }
    });
    await Config.setSettings(patch);
    Config.invalidateCache();
    showToast('设置已保存', 'success');
  }

  /** 测试连接 */
  async function testConnection() {
    const base = document.getElementById('apiBaseUrl').value.replace(/\/+$/, '');
    try {
      const resp = await fetch(base + '/api/config/pricing', { method: 'GET' });
      if (resp.ok) {
        const json = await resp.json();
        showToast('连接成功', 'success');
        // 同步后端定价配置到表单
        if (json && json.data) {
          const d = json.data;
          if (d.exchangeRateCnyToRub != null) document.getElementById('exchangeRate').value = d.exchangeRateCnyToRub;
          if (d.profitMargin != null) document.getElementById('profitMargin').value = d.profitMargin;
          if (d.oldPriceRatio != null) document.getElementById('oldPriceRatio').value = d.oldPriceRatio;
          if (d.defaultCurrency) document.getElementById('defaultCurrency').value = d.defaultCurrency;
          if (d.shipping_rate_per_kg != null) document.getElementById('shippingRate').value = d.shipping_rate_per_kg;
          if (d.volumetric_divisor != null) document.getElementById('volumetricDivisor').value = d.volumetric_divisor;
          if (d.return_rate != null) document.getElementById('returnRate').value = d.return_rate;
          if (d.loss_rate != null) document.getElementById('lossRate').value = d.loss_rate;
          if (d.packaging_fee != null) document.getElementById('packagingFee').value = d.packaging_fee;
        }
      } else {
        showToast('连接失败：HTTP ' + resp.status, 'error');
      }
    } catch (e) {
      showToast('连接失败：' + e.message, 'error');
    }
  }

  /** 重置默认 */
  function resetDefaults() {
    if (!confirm('确定重置为默认设置？')) return;
    FIELDS.forEach(function (key) {
      const el = document.getElementById(key);
      if (el) el.value = DEFAULTS[key];
    });
    showToast('已重置为默认（需点保存生效）', 'success');
  }

  function showToast(msg, type) {
    const el = document.getElementById('toast');
    el.textContent = msg;
    el.className = 'toast show ' + (type || 'success');
    setTimeout(function () { el.className = 'toast'; }, 2500);
  }

  // 初始化
  loadSettings();
  document.getElementById('btnSave').addEventListener('click', saveSettings);
  document.getElementById('btnTest').addEventListener('click', testConnection);
  document.getElementById('btnReset').addEventListener('click', resetDefaults);
})();
