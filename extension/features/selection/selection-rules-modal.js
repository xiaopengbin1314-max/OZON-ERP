/**
 * GeekOzon 扩展 - 选品规则管理弹窗（24 维度条件 CRUD）
 * 左侧规则列表 + 右侧规则编辑器
 *
 * 入口：window.__geekOzonOpenSelectionRules()
 * 防重复注入标志：window.__geekOzonSelectionRulesLoaded
 */
;(function () {
  'use strict';

  const G = window.GeekOzon;
  if (!G) return;
  if (window.__geekOzonSelectionRulesLoaded) return;
  window.__geekOzonSelectionRulesLoaded = true;

  const Tokens = G.components.DesignTokens;
  const BaseComponent = G.components.BaseComponent;
  const ApiClient = G.core.ApiClient;
  const EventBus = G.core.EventBus;
  const utils = G.utils;

  /**
   * 24 维度字段定义
   * type: number | string | date
   */
  const FIELDS = [
    // 销量类 5
    { value: 'soldSum',          label: '销量总额',     type: 'number' },
    { value: 'soldCount',        label: '销量数',       type: 'number' },
    { value: 'clickRate',       label: '点击率 %',     type: 'number' },
    { value: 'convRate',        label: '转化率 %',     type: 'number' },
    { value: 'createDays',      label: '上架天数',     type: 'number' },
    // 价格类 5
    { value: 'price',           label: '价格',         type: 'number' },
    { value: 'competitorMinPrice', label: '跟卖最低价', type: 'number' },
    { value: 'competitorMaxPrice', label: '跟卖最高价', type: 'number' },
    { value: 'competitorCount', label: '跟卖数',       type: 'number' },
    { value: 'blackPrice',      label: '黑价',         type: 'number' },
    // 商品类 6
    { value: 'brand',           label: '品牌',         type: 'string' },
    { value: 'category',        label: '类目名称',     type: 'string' },
    { value: 'weight',          label: '重量',         type: 'number' },
    { value: 'dimensions',      label: '尺寸',         type: 'string' },
    { value: 'imageCount',      label: '图片数',       type: 'number' },
    { value: 'skuCount',        label: 'SKU 数',       type: 'number' },
    // 退货类 2
    { value: 'redemptionRate',  label: '退货率 %',     type: 'number' },
    { value: 'cancelRate',      label: '取消率 %',     type: 'number' },
    // 利润类 2
    { value: 'profitMargin',    label: '利润率 %',     type: 'number' },
    { value: 'profitAmount',     label: '利润额',       type: 'number' },
    // 状态类 4
    { value: 'isActive',        label: '是否在售',     type: 'number' },
    { value: 'hasCompetitor',   label: '是否有跟卖',   type: 'number' },
    { value: 'createDate',      label: '创建日期',     type: 'date' },
    { value: 'categoryId',      label: '类目 ID',      type: 'number' },
  ];

  /** 操作符定义（按字段类型） */
  const OPERATORS = {
    number: [
      { value: 'gt',       label: '>' },
      { value: 'gte',      label: '>=' },
      { value: 'lt',       label: '<' },
      { value: 'lte',      label: '<=' },
      { value: 'eq',       label: '=' },
      { value: 'between',  label: '区间 [a,b]' },
    ],
    string: [
      { value: 'eq',       label: '等于' },
      { value: 'ne',       label: '不等于' },
      { value: 'contains', label: '包含' },
      { value: 'starts',   label: '以…开头' },
    ],
    date: [
      { value: 'before',   label: '早于' },
      { value: 'after',    label: '晚于' },
      { value: 'between',  label: '区间' },
    ],
  };

  /** 根据 field 取 type */
  function getFieldType(field) {
    for (let i = 0; i < FIELDS.length; i++) {
      if (FIELDS[i].value === field) return FIELDS[i].type;
    }
    return 'number';
  }

  /** 新建空规则 */
  function newEmptyRule() {
    return {
      name: '新规则',
      enabled: true,
      priority: 0,
      logic: 'AND',  // AND | OR
      conditions: [
        { field: 'soldCount', op: 'gt', value: '' },
      ],
    };
  }

  /**
   * 选品规则弹窗
   */
  class SelectionRulesModal extends BaseComponent {
    constructor() {
      super();
      this.rules = [];
      this.selectedId = null;
      this.editing = null;       // 当前编辑的规则对象
      this.dirty = false;
    }

    getHostId() { return 'geekozon-selection-rules-host'; }
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
          width: 1080px; max-width: 96vw; height: 720px; max-height: 92vh;
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
        .go-modal-body { display: flex; flex: 1; min-height: 0; }
        .go-side {
          width: 280px; border-right: 1px solid ${Tokens.color.border};
          display: flex; flex-direction: column;
        }
        .go-side-head {
          padding: ${Tokens.space.md} ${Tokens.space.base};
          display: flex; justify-content: space-between; align-items: center;
          background: ${Tokens.color.bgSubtle};
          border-bottom: 1px solid ${Tokens.color.border};
        }
        .go-side-list { flex: 1; overflow-y: auto; }
        .go-rule-item {
          padding: ${Tokens.space.md} ${Tokens.space.base};
          border-bottom: 1px solid ${Tokens.color.border};
          cursor: pointer; transition: background ${Tokens.animation.durationFast} ${Tokens.animation.easing};
        }
        .go-rule-item:hover { background: ${Tokens.color.bgSubtle}; }
        .go-rule-item.active { background: rgba(234,179,8,0.08); border-left: 3px solid ${Tokens.color.primary}; padding-left: calc(${Tokens.space.base} - 3px); }
        .go-rule-name { font-weight: ${Tokens.font.weightMedium}; color: ${Tokens.color.textPrimary}; }
        .go-rule-meta { font-size: ${Tokens.font.sizeSm}; color: ${Tokens.color.textSecondary}; margin-top: 2px; }
        .go-toggle {
          width: 30px; height: 16px; border-radius: ${Tokens.radius.pill};
          background: ${Tokens.color.borderStrong};
          position: relative; cursor: pointer; transition: background ${Tokens.animation.durationFast} ${Tokens.animation.easing};
        }
        .go-toggle::after {
          content: ''; position: absolute; top: 1px; left: 1px;
          width: 14px; height: 14px; border-radius: 50%;
          background: ${Tokens.color.bgBase}; transition: left ${Tokens.animation.durationFast} ${Tokens.animation.easing};
        }
        .go-toggle.on { background: ${Tokens.color.success}; box-shadow: ${Tokens.shadow.toggle}; }
        .go-toggle.on::after { left: 15px; }

        .go-main { flex: 1; display: flex; flex-direction: column; min-width: 0; }
        .go-main-head {
          padding: ${Tokens.space.md} ${Tokens.space.lg};
          background: ${Tokens.color.bgSubtle};
          border-bottom: 1px solid ${Tokens.color.border};
          display: flex; gap: ${Tokens.space.md}; align-items: center;
        }
        .go-main-body { flex: 1; overflow-y: auto; padding: ${Tokens.space.lg}; }

        .go-field { display: flex; flex-direction: column; gap: 4px; }
        .go-field label { font-size: ${Tokens.font.sizeSm}; color: ${Tokens.color.textSecondary}; }
        .go-input, .go-select {
          padding: 6px 8px; border: 1px solid ${Tokens.color.borderStrong};
          border-radius: ${Tokens.radius.base}; font-size: ${Tokens.font.sizeBase};
          background: ${Tokens.color.bgBase}; color: ${Tokens.color.textPrimary};
        }
        .go-input:focus, .go-select:focus { border-color: ${Tokens.color.borderFocus}; }

        .go-cond-row {
          display: grid; grid-template-columns: 1.5fr 1fr 1.5fr auto;
          gap: ${Tokens.space.sm}; align-items: end; margin-bottom: ${Tokens.space.sm};
        }
        .go-cond-row .go-btn { padding: 6px 10px; }

        .go-modal-footer {
          padding: ${Tokens.space.md} ${Tokens.space.xl};
          display: flex; gap: ${Tokens.space.md}; justify-content: flex-end;
          border-top: 1px solid ${Tokens.color.border};
          background: ${Tokens.color.bgSubtle};
        }
        .go-muted { color: ${Tokens.color.textMuted}; font-size: ${Tokens.font.sizeSm}; }
        .go-toast {
          position: fixed; top: 16px; left: 50%; transform: translateX(-50%);
          padding: ${Tokens.space.sm} ${Tokens.space.base}; border-radius: ${Tokens.radius.base};
          color: ${Tokens.color.textInverse}; font-size: ${Tokens.font.sizeBase}; z-index: ${Tokens.z.toast};
        }
        .go-toast-ok { background: ${Tokens.color.success}; }
        .go-toast-err { background: ${Tokens.color.danger}; }
      `;
    }

    /** 打开弹窗 */
    open() {
      this.mount();
      this.rerender();
      this._loadRules();
      this.show();
      return this;
    }

    /** 拉取规则列表 */
    async _loadRules() {
      const resp = await ApiClient.fetchSelectionRules();
      const data = ApiClient.data(resp, null);
      this.rules = (data && data.list) || (Array.isArray(data) ? data : []);
      if (this.rules.length) {
        const first = this.rules[0];
        this.selectedId = first.id != null ? first.id : (first._id || null);
        this.editing = Object.assign({}, first);
      } else {
        this.selectedId = null;
        this.editing = newEmptyRule();
      }
      this.rerender();
    }

    render() {
      const self = this;
      const rules = this.rules || [];
      const editing = this.editing || newEmptyRule();

      const ruleItems = rules.length === 0
        ? '<div class="go-muted" style="padding:' + Tokens.space.base + ';">暂无规则，点右上角「新建」</div>'
        : rules.map(function (r) {
          const id = r.id != null ? r.id : (r._id || '');
          const active = String(id) === String(self.selectedId) ? ' active' : '';
          return `<div class="go-rule-item${active}" data-id="${utils.escapeHtml(String(id))}">
            <div style="display:flex; justify-content:space-between; align-items:center;">
              <div class="go-rule-name">${utils.escapeHtml(r.name || '未命名')}</div>
              <div class="go-toggle${r.enabled ? ' on' : ''}" data-toggle="${utils.escapeHtml(String(id))}"></div>
            </div>
            <div class="go-rule-meta">优先级 ${r.priority != null ? r.priority : 0} · ${r.logic || 'AND'} · ${(r.conditions || []).length} 条</div>
          </div>`;
        }).join('');

      const fieldsOpts = FIELDS.map(function (f) {
        return `<option value="${f.value}">${utils.escapeHtml(f.label)}</option>`;
      }).join('');

      const condRows = (editing.conditions || []).map(function (c, idx) {
        const ft = getFieldType(c.field);
        const ops = OPERATORS[ft] || OPERATORS.number;
        const opsOpts = ops.map(function (op) {
          return `<option value="${op.value}"${c.op === op.value ? ' selected' : ''}>${utils.escapeHtml(op.label)}</option>`;
        }).join('');
        const valInput = ft === 'date'
          ? `<input type="date" class="go-input" data-cv="${idx}" value="${utils.escapeHtml(c.value)}" />`
          : `<input type="text" class="go-input" data-cv="${idx}" value="${utils.escapeHtml(c.value)}" placeholder="值（between 用逗号分隔）" />`;
        return `<div class="go-cond-row">
          <select class="go-select" data-cf="${idx}">${fieldsOpts.replace('value="' + c.field + '"', 'value="' + c.field + '" selected')}</select>
          <select class="go-select" data-co="${idx}">${opsOpts}</select>
          ${valInput}
          <button class="go-btn go-btn-danger" data-cd="${idx}">删</button>
        </div>`;
      }).join('');

      return `
        <div class="go-overlay" id="goOverlay">
          <div class="go-modal">
            <div class="go-modal-header">
              <div class="go-modal-title">选品规则管理</div>
              ${this.renderCloseButton('goCloseBtn')}
            </div>
            <div class="go-modal-body">
              <div class="go-side">
                <div class="go-side-head">
                  <span style="font-weight:${Tokens.font.weightSemi};">规则列表 (${rules.length})</span>
                  <button class="go-btn go-btn-secondary" id="goNew" style="flex:0 0 auto; padding:4px 10px;">+ 新建</button>
                </div>
                <div class="go-side-list" id="goRuleList">${ruleItems}</div>
              </div>
              <div class="go-main">
                <div class="go-main-head">
                  <div class="go-field" style="flex:1;">
                    <label>规则名称</label>
                    <input type="text" id="goRuleName" class="go-input" value="${utils.escapeHtml(editing.name || '')}" />
                  </div>
                  <div class="go-field">
                    <label>优先级</label>
                    <input type="number" id="goRulePriority" class="go-input" value="${editing.priority != null ? editing.priority : 0}" style="width:80px;" />
                  </div>
                  <div class="go-field">
                    <label>逻辑</label>
                    <select id="goRuleLogic" class="go-select">
                      <option value="AND"${editing.logic === 'AND' ? ' selected' : ''}>AND（且）</option>
                      <option value="OR"${editing.logic === 'OR' ? ' selected' : ''}>OR（或）</option>
                    </select>
                  </div>
                </div>
                <div class="go-main-body">
                  <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:${Tokens.space.md};">
                    <div style="font-weight:${Tokens.font.weightSemi}; color:${Tokens.color.textPrimary};">条件列表（${(editing.conditions || []).length}）</div>
                    <button class="go-btn go-btn-secondary" id="goAddCond" style="flex:0 0 auto; padding:4px 10px;">+ 添加条件</button>
                  </div>
                  <div id="goCondList">${condRows}</div>
                </div>
              </div>
            </div>
            <div class="go-modal-footer">
              <button class="go-btn go-btn-danger" id="goDelete">删除当前</button>
              <button class="go-btn go-btn-ghost" id="goCancel">取消</button>
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

      // 新建
      this.on(this.$('#goNew'), 'click', function () {
        self.editing = newEmptyRule();
        self.selectedId = null;
        self.rerender();
      });

      // 切换规则项
      this.$$('#goRuleList .go-rule-item').forEach(function (el) {
        el.addEventListener('click', function (e) {
          if (e.target.classList.contains('go-toggle')) return;
          const id = el.getAttribute('data-id');
          const found = self.rules.find(function (r) {
            const rid = r.id != null ? r.id : r._id;
            return String(rid) === String(id);
          });
          if (found) {
            self.selectedId = id;
            self.editing = Object.assign({}, found, {
              conditions: (found.conditions || []).map(function (c) { return Object.assign({}, c); }),
            });
            self.rerender();
          }
        });
      });

      // 启停切换
      this.$$('.go-toggle').forEach(function (el) {
        el.addEventListener('click', async function (e) {
          e.stopPropagation();
          const id = el.getAttribute('data-toggle');
          const resp = await ApiClient.post('/api/selection/rules/' + encodeURIComponent(id) + '/toggle');
          if (ApiClient.isOk(resp)) {
            self._toast('已切换', 'ok');
            await self._loadRules();
            EventBus.emit(EventBus.EVENTS.SELECTION_RULES_CHANGED, { id: id });
          } else {
            self._toast('切换失败: ' + (resp.msg || ''), 'err');
          }
        });
      });

      // 名称/优先级/逻辑同步
      this.on(this.$('#goRuleName'), 'input', function (e) {
        if (self.editing) { self.editing.name = e.target.value; }
      });
      this.on(this.$('#goRulePriority'), 'input', function (e) {
        if (self.editing) { self.editing.priority = Number(e.target.value) || 0; }
      });
      this.on(this.$('#goRuleLogic'), 'change', function (e) {
        if (self.editing) { self.editing.logic = e.target.value; }
      });

      // 添加条件
      this.on(this.$('#goAddCond'), 'click', function () {
        if (!self.editing) self.editing = newEmptyRule();
        self.editing.conditions = self.editing.conditions || [];
        self.editing.conditions.push({ field: 'soldCount', op: 'gt', value: '' });
        self.rerender();
      });

      // 条件行编辑（字段/操作符/值/删除）
      this.$$('#goCondList .go-cond-row').forEach(function (row) {
        const fSel = row.querySelector('[data-cf]');
        const oSel = row.querySelector('[data-co]');
        const vInp = row.querySelector('[data-cv]');
        const dBtn = row.querySelector('[data-cd]');
        if (fSel) fSel.addEventListener('change', function () {
          const i = parseInt(fSel.getAttribute('data-cf'), 10);
          if (self.editing && self.editing.conditions[i]) {
            self.editing.conditions[i].field = fSel.value;
            // 字段类型变化时，操作符可能不兼容，重置为第一个
            const ft = getFieldType(fSel.value);
            const ops = OPERATORS[ft] || OPERATORS.number;
            self.editing.conditions[i].op = ops[0].value;
            self.rerender();
          }
        });
        if (oSel) oSel.addEventListener('change', function () {
          const i = parseInt(oSel.getAttribute('data-co'), 10);
          if (self.editing && self.editing.conditions[i]) self.editing.conditions[i].op = oSel.value;
        });
        if (vInp) vInp.addEventListener('input', function () {
          const i = parseInt(vInp.getAttribute('data-cv'), 10);
          if (self.editing && self.editing.conditions[i]) self.editing.conditions[i].value = vInp.value;
        });
        if (dBtn) dBtn.addEventListener('click', function () {
          const i = parseInt(dBtn.getAttribute('data-cd'), 10);
          if (self.editing && self.editing.conditions[i]) {
            self.editing.conditions.splice(i, 1);
            self.rerender();
          }
        });
      });

      // 保存
      this.on(this.$('#goSave'), 'click', async function () { await self._save(); });
      // 删除
      this.on(this.$('#goDelete'), 'click', async function () { await self._delete(); });
    }

    async _save() {
      const self = this;
      if (!this.editing) return;
      if (!this.editing.name) { this._toast('请填写规则名称', 'err'); return; }
      const body = {
        name: this.editing.name,
        enabled: this.editing.enabled !== false,
        priority: this.editing.priority || 0,
        logic: this.editing.logic || 'AND',
        conditions: this.editing.conditions || [],
      };
      let resp;
      if (this.selectedId != null) {
        // 更新
        resp = await ApiClient.put('/api/selection/rules/' + encodeURIComponent(this.selectedId), body);
      } else {
        // 新建
        resp = await ApiClient.post('/api/selection/rules', body);
      }
      if (ApiClient.isOk(resp)) {
        self._toast('保存成功', 'ok');
        if (resp.data && resp.data.id != null) self.selectedId = resp.data.id;
        await self._loadRules();
        EventBus.emit(EventBus.EVENTS.SELECTION_RULES_CHANGED, { id: self.selectedId });
      } else {
        self._toast('保存失败: ' + (resp.msg || ''), 'err');
      }
    }

    async _delete() {
      const self = this;
      if (this.selectedId == null) { this._toast('未选中规则', 'err'); return; }
      const resp = await ApiClient.del('/api/selection/rules/' + encodeURIComponent(this.selectedId));
      if (ApiClient.isOk(resp)) {
        self._toast('已删除', 'ok');
        self.selectedId = null;
        self.editing = newEmptyRule();
        await self._loadRules();
        EventBus.emit(EventBus.EVENTS.SELECTION_RULES_CHANGED, {});
      } else {
        self._toast('删除失败: ' + (resp.msg || ''), 'err');
      }
    }

    _toast(msg, type) {
      const el = document.createElement('div');
      el.className = 'go-toast' + (type === 'ok' ? ' go-toast-ok' : type === 'err' ? ' go-toast-err' : '');
      el.textContent = msg;
      this.shadow.appendChild(el);
      setTimeout(function () { if (el.parentNode) el.parentNode.removeChild(el); }, 2000);
    }
  }

  /** 单例 */
  let _instance = null;
  function getInstance() {
    if (!_instance) _instance = new SelectionRulesModal();
    return _instance;
  }

  /** 全局入口 */
  window.__geekOzonOpenSelectionRules = function () {
    const inst = getInstance();
    inst.open();
    return inst;
  };

  // 挂到命名空间
  G.features.selection = G.features.selection || {};
  G.features.selection.SelectionRulesModal = SelectionRulesModal;
  G.features.selection.open = window.__geekOzonOpenSelectionRules;
  G.markLoaded('selection-rules-modal');
})();
