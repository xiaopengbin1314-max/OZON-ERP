/**
 * GeekOzon 扩展 - 字段显示设置弹窗（21 字段，5 分组）
 * 复选框分组、持久化、保存后派发 FIELD_SETTINGS_CHANGED 事件
 *
 * 入口：
 *   - window.__geekOzonOpenFieldSettings()        打开弹窗
 *   - window.__geekOzonGetFieldSettings()          同步返回当前设置（{fieldName: true/false}）
 * 防重复注入标志：window.__geekOzonFieldSettingsLoaded
 */
;(function () {
  'use strict';

  const G = window.GeekOzon;
  if (!G) return;
  if (window.__geekOzonFieldSettingsLoaded) return;
  window.__geekOzonFieldSettingsLoaded = true;

  const Tokens = G.components.DesignTokens;
  const BaseComponent = G.components.BaseComponent;
  const Storage = G.core.Storage;
  const EventBus = G.core.EventBus;
  const Config = G.core.Config;

  /** chrome.storage.local 键名 */
  const STORAGE_KEY = Config.STORAGE_KEYS.FIELD_SETTINGS;  // 'geekOzonFieldSettings'

  /** 5 分组 21 字段定义 */
  const GROUPS = [
    {
      name: '基础信息', fields: [
        { value: 'sku',       label: 'SKU' },
        { value: 'title',     label: '商品标题' },
        { value: 'brand',     label: '品牌' },
        { value: 'category',  label: '类目' },
        { value: 'image',     label: '主图' },
        { value: 'url',       label: '商品链接' },
      ],
    },
    {
      name: '销量数据', fields: [
        { value: 'soldSum',         label: '销量总额' },
        { value: 'soldCount',       label: '销量数' },
        { value: 'clickRate',      label: '点击率' },
        { value: 'convRate',       label: '转化率' },
        { value: 'createDays',     label: '上架天数' },
        { value: 'redemptionRate', label: '退货率' },
        { value: 'cancelRate',     label: '取消率' },
        { value: 'rating',         label: '评分' },
      ],
    },
    {
      name: '跟卖数据', fields: [
        { value: 'competitorMinPrice', label: '跟卖最低价' },
        { value: 'competitorMaxPrice', label: '跟卖最高价' },
        { value: 'competitorCount',    label: '跟卖数' },
      ],
    },
    {
      name: '价格分析', fields: [
        { value: 'price',        label: '当前价格' },
        { value: 'blackPrice',   label: '黑标价' },
        { value: 'profitMargin', label: '利润率' },
      ],
    },
    {
      name: '状态', fields: [
        { value: 'isActive', label: '是否在售' },
      ],
    },
  ];

  /** 全部字段名扁平数组 */
  const ALL_FIELDS = (function () {
    const arr = [];
    GROUPS.forEach(function (g) { g.fields.forEach(function (f) { arr.push(f.value); }); });
    return arr;
  })();

  /** 生成默认设置（全选） */
  function defaultSettings() {
    const o = {};
    ALL_FIELDS.forEach(function (k) { o[k] = true; });
    return o;
  }

  /** 内存缓存（用于同步返回） */
  let _cache = defaultSettings();
  let _loaded = false;

  /** 加载存储 → 缓存 */
  async function loadFromStorage() {
    const obj = await Storage.getOne(STORAGE_KEY, null);
    if (obj && typeof obj === 'object') {
      _cache = Object.assign(defaultSettings(), obj);
    } else {
      _cache = defaultSettings();
    }
    _loaded = true;
    return _cache;
  }

  /** 写入存储 + 更新缓存 */
  async function saveToStorage(settings) {
    _cache = Object.assign(defaultSettings(), settings);
    _loaded = true;
    await Storage.setOne(STORAGE_KEY, _cache);
    return _cache;
  }

  // 启动时异步加载一次，避免首次 get 同步返回默认值时与存储不一致
  loadFromStorage();

  /**
   * 字段显示设置弹窗
   */
  class FieldSettingsModal extends BaseComponent {
    constructor() {
      super();
      this.draft = Object.assign({}, _cache);
    }

    getHostId() { return 'geekozon-field-settings-host'; }
    getHostPosition() { return { position: 'fixed', zIndex: Tokens.z.modal }; }

    getStyles() {
      return `
        ${this.getCommonStyles()}
        .go-overlay {
          position: fixed; inset: 0; background: ${Tokens.color.bgOverlay};
          display: flex; align-items: center; justify-content: center;
          z-index: ${Tokens.z.modal};
          animation: goFadeIn ${Tokens.animation.duration} ${Tokens.animation.easing};
        }
        .go-modal {
          width: 560px; max-width: 96vw; max-height: 92vh;
          background: ${Tokens.color.bgBase};
          border-radius: ${Tokens.radius.lg};
          box-shadow: ${Tokens.shadow.modal};
          display: flex; flex-direction: column; overflow: hidden;
          animation: goZoomIn ${Tokens.animation.duration} ${Tokens.animation.easing};
        }
        .go-modal-header {
          padding: ${Tokens.space.lg} ${Tokens.space.xl};
          display: flex; align-items: center; justify-content: space-between;
          background: ${Tokens.color.gradientYellowTop};
          border-bottom: 1px solid ${Tokens.color.border};
        }
        .go-modal-title { font-size: ${Tokens.font.sizeTitle}; font-weight: ${Tokens.font.weightBold}; color: ${Tokens.color.textPrimary}; }
        .go-modal-body { padding: ${Tokens.space.lg} ${Tokens.space.xl}; overflow-y: auto; flex: 1; }
        .go-group { margin-bottom: ${Tokens.space.lg}; }
        .go-group-head {
          display: flex; align-items: center; justify-content: space-between;
          padding: ${Tokens.space.sm} ${Tokens.space.base};
          background: ${Tokens.color.bgMuted};
          border-radius: ${Tokens.radius.base};
          font-weight: ${Tokens.font.weightSemi}; color: ${Tokens.color.textPrimary};
          margin-bottom: ${Tokens.space.sm};
        }
        .go-group-head a { color: ${Tokens.color.info}; cursor: pointer; font-size: ${Tokens.font.sizeSm}; font-weight: ${Tokens.font.weightNormal}; }
        .go-fields { display: grid; grid-template-columns: repeat(2, 1fr); gap: ${Tokens.space.sm} ${Tokens.space.md}; }
        .go-field-item {
          display: flex; align-items: center; gap: ${Tokens.space.sm};
          padding: ${Tokens.space.xs} ${Tokens.space.sm};
          border-radius: ${Tokens.radius.base}; cursor: pointer;
          transition: background ${Tokens.animation.durationFast} ${Tokens.animation.easing};
        }
        .go-field-item:hover { background: ${Tokens.color.bgSubtle}; }
        .go-checkbox {
          width: 16px; height: 16px; border: 1.5px solid ${Tokens.color.borderStrong};
          border-radius: 3px; display: inline-flex; align-items: center; justify-content: center;
          background: ${Tokens.color.bgBase}; transition: all ${Tokens.animation.durationFast} ${Tokens.animation.easing};
        }
        .go-checkbox.on { background: ${Tokens.color.primary}; border-color: ${Tokens.color.primary}; }
        .go-checkbox.on::after {
          content: ''; width: 8px; height: 4px;
          border-left: 2px solid ${Tokens.color.textInverse};
          border-bottom: 2px solid ${Tokens.color.textInverse};
          transform: rotate(-45deg) translate(1px, -1px);
        }
        .go-field-label { font-size: ${Tokens.font.sizeBase}; color: ${Tokens.color.textPrimary}; }

        .go-modal-footer {
          padding: ${Tokens.space.md} ${Tokens.space.xl};
          display: flex; gap: ${Tokens.space.md}; justify-content: flex-end;
          border-top: 1px solid ${Tokens.color.border}; background: ${Tokens.color.bgSubtle};
        }
        .go-toast {
          position: fixed; top: 16px; left: 50%; transform: translateX(-50%);
          padding: ${Tokens.space.sm} ${Tokens.space.base}; border-radius: ${Tokens.radius.base};
          color: ${Tokens.color.textInverse}; font-size: ${Tokens.font.sizeBase}; z-index: ${Tokens.z.toast};
          background: ${Tokens.color.success};
        }
      `;
    }

    async open() {
      // 弹窗打开前同步最新存储到 draft
      await loadFromStorage();
      this.draft = Object.assign({}, _cache);
      this.mount();
      this.rerender();
      this.show();
      return this;
    }

    render() {
      const self = this;
      const draft = this.draft;
      const groupHtml = GROUPS.map(function (g) {
        const allOn = g.fields.every(function (f) { return draft[f.value]; });
        const items = g.fields.map(function (f) {
          const on = !!draft[f.value];
          return `<div class="go-field-item" data-toggle="${f.value}">
            <span class="go-checkbox${on ? ' on' : ''}"></span>
            <span class="go-field-label">${f.label}</span>
          </div>`;
        }).join('');
        return `<div class="go-group">
          <div class="go-group-head">
            <span>${g.name}（${g.fields.length}）</span>
            <a data-group-toggle="${allOn ? 'off' : 'on'}">${allOn ? '取消全选' : '全选'}</a>
          </div>
          <div class="go-fields">${items}</div>
        </div>`;
      }).join('');

      const totalOn = ALL_FIELDS.filter(function (k) { return draft[k]; }).length;

      return `
        <div class="go-overlay" id="goOverlay">
          <div class="go-modal">
            <div class="go-modal-header">
              <div class="go-modal-title">字段显示设置（${totalOn}/${ALL_FIELDS.length}）</div>
              ${this.renderCloseButton('goCloseBtn')}
            </div>
            <div class="go-modal-body">${groupHtml}</div>
            <div class="go-modal-footer">
              <button class="go-btn go-btn-ghost" id="goReset">恢复默认</button>
              <button class="go-btn go-btn-secondary" id="goCancel">取消</button>
              <button class="go-btn go-btn-primary" id="goSave">保存</button>
            </div>
          </div>
        </div>
      `;
    }

    bindEvents() {
      const self = this;

      this.on(this.$('#goCloseBtn'), 'click', function () { self.hide(); });
      this.on(this.$('#goCancel'), 'click', function () { self.hide(); });
      this.on(this.$('#goOverlay'), 'click', function (e) {
        if (e.target === self.$('#goOverlay')) self.hide();
      });

      // 单字段切换
      this.$$('.go-field-item').forEach(function (el) {
        el.addEventListener('click', function () {
          const key = el.getAttribute('data-toggle');
          self.draft[key] = !self.draft[key];
          self.rerender();
        });
      });

      // 分组全选/取消
      this.$$('.go-group-head a[data-group-toggle]').forEach(function (a) {
        a.addEventListener('click', function () {
          const group = GROUPS.find(function (g) { return g.fields.some(function (f) { return f.label === a.parentNode.querySelector('span').textContent; }); });
          // 简化：找与当前点击最近的 group 元素
          const groupEl = a.closest('.go-group');
          if (!groupEl) return;
          const fields = groupEl.querySelectorAll('[data-toggle]');
          const action = a.getAttribute('data-group-toggle');
          const target = action === 'on';
          fields.forEach(function (el) {
            const k = el.getAttribute('data-toggle');
            self.draft[k] = target;
          });
          self.rerender();
        });
      });

      // 恢复默认（全选）
      this.on(this.$('#goReset'), 'click', function () {
        self.draft = defaultSettings();
        self.rerender();
      });

      // 保存
      this.on(this.$('#goSave'), 'click', async function () {
        await saveToStorage(self.draft);
        EventBus.emit(EventBus.EVENTS.FIELD_SETTINGS_CHANGED, Object.assign({}, _cache));
        self._toast('已保存');
        setTimeout(function () { self.hide(); }, 500);
      });
    }

    _toast(msg) {
      const el = document.createElement('div');
      el.className = 'go-toast';
      el.textContent = msg;
      this.shadow.appendChild(el);
      setTimeout(function () { if (el.parentNode) el.parentNode.removeChild(el); }, 1800);
    }
  }

  /** 单例 */
  let _instance = null;
  function getInstance() {
    if (!_instance) _instance = new FieldSettingsModal();
    return _instance;
  }

  /** 全局入口 */
  window.__geekOzonOpenFieldSettings = function () {
    const inst = getInstance();
    inst.open();
    return inst;
  };
  /** 同步返回当前设置（首次未加载完时返回默认全选） */
  window.__geekOzonGetFieldSettings = function () {
    return Object.assign({}, _cache);
  };

  // 挂到命名空间
  G.features.fieldSettings = G.features.fieldSettings || {};
  G.features.fieldSettings.FieldSettingsModal = FieldSettingsModal;
  G.features.fieldSettings.open = window.__geekOzonOpenFieldSettings;
  G.features.fieldSettings.get = window.__geekOzonGetFieldSettings;
  G.features.fieldSettings.GROUPS = GROUPS;
  G.features.fieldSettings.ALL_FIELDS = ALL_FIELDS;
  G.markLoaded('field-settings-modal');

  // 监听跨 tab storage 变化，同步本地缓存
  Storage.onChanged(STORAGE_KEY, function (newVal) {
    if (newVal && typeof newVal === 'object') {
      _cache = Object.assign(defaultSettings(), newVal);
      EventBus.emit(EventBus.EVENTS.FIELD_SETTINGS_CHANGED, Object.assign({}, _cache));
    }
  });
})();
