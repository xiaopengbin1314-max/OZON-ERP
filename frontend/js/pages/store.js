/**
 * 店铺绑定管理页 - Store Management Page
 * 支持店铺授权、币种管理、分组管理、批量操作等功能
 * 数据来源：后端 SQLite 数据库 API
 */
function renderStorePage(route) {
  return `
    <div style="animation: pageEnter 0.35s ease;">
      <!-- 页面标题 -->
      <div class="store-page-header">
        <div>
          <h2 class="store-page-title">店铺管理</h2>
          <p class="store-page-desc">管理所有已绑定的店铺账号，支持授权、分组、币种配置</p>
        </div>
        <div class="store-header-actions">
          <button class="btn btn-sm btn-ghost" onclick="showAddGroupDialog()">
            <i data-lucide="folder-plus" style="width:14px;height:14px;"></i> 新建分组
          </button>
          <button class="btn btn-primary btn-sm" onclick="showAddStoreDialog()">
            <i data-lucide="plus" style="width:14px;height:14px;"></i> 添加店铺
          </button>
        </div>
      </div>

      <!-- 筛选工具栏 -->
      <div class="store-toolbar">
        <div class="store-toolbar-left">
          <!-- 分组筛选 -->
          <select class="form-select filter-select" id="filterGroup" onchange="filterStores()">
            <option value="">全部分组</option>
          </select>
          <!-- 授权状态 -->
          <select class="form-select filter-select" id="filterAuthStatus" onchange="filterStores()">
            <option value="">全部状态</option>
            <option value="active">已授权</option>
            <option value="expired">已过期</option>
            <option value="pending">待授权</option>
            <option value="disabled">已禁用</option>
          </select>
          <!-- 通知推送 -->
          <select class="form-select filter-select" id="filterNotifyStatus" onchange="filterStores()">
            <option value="">全部通知</option>
            <option value="on">已开启</option>
            <option value="off">未开启</option>
          </select>
          <!-- 关键词搜索 -->
          <div class="search-input-group">
            <input type="text" class="form-input search-input" placeholder="搜索店铺ID/别名/关键词..." id="storeSearchInput" onkeydown="if(event.key==='Enter')filterStores()">
          </div>
        </div>
        <div class="store-toolbar-right">
          <button class="btn btn-sm btn-primary" onclick="filterStores()">
            <i data-lucide="search" style="width:14px;height:14px;"></i> 搜索
          </button>
          <button class="btn btn-sm btn-ghost" onclick="resetStoreFilters()">
            <i data-lucide="rotate-ccw" style="width:14px;height:14px;"></i> 重置
          </button>
        </div>
      </div>

      <!-- 表格区域 -->
      <div class="store-table-wrap">
        <table class="collect-table" id="storeTable">
          <thead>
            <tr>
              <th><input type="checkbox" class="table-check-all" onclick="toggleSelectAllStores(this)"></th>
              <th>序号</th>
              <th>店铺ID</th>
              <th>今日可刊登数</th>
              <th>币种</th>
              <th>分组</th>
              <th>店铺别名</th>
              <th>通知推送</th>
              <th>授权类型</th>
              <th>授权时间</th>
              <th>授权状态</th>
              <th>操作</th>
            </tr>
          </thead>
          <tbody id="storeTableBody"></tbody>
        </table>

        <!-- 空状态 -->
        <div class="empty-state" id="storeEmptyState" style="display:none;">
          <div class="empty-icon">&#128203;</div>
          <p>暂无店铺数据</p>
          <p style="font-size:12px;margin-top:4px;">点击「添加店铺」开始绑定您的第一个店铺</p>
        </div>
      </div>

      <!-- 底部操作栏 -->
      <div class="store-footer-bar" id="storeFooterBar">
        <div class="store-footer-left">
          <span class="select-info">已选 <strong id="storeSelectedCount">0</strong> 条</span>
          <button class="btn btn-sm btn-ghost" onclick="batchSetGroup()">批量设分组</button>
          <button class="btn btn-sm btn-ghost" onclick="batchSetCurrency()">批量设币种</button>
          <button class="btn btn-sm btn-ghost danger" onclick="batchDeleteStores()">批量删除</button>
        </div>
        <div class="store-footer-right">
          <span class="total-info">共 <strong id="storeTotalCount">0</strong> 个店铺</span>
        </div>
      </div>
    </div>
  `;
}

// ===== 数据层 =====

let allStores = [];
let filteredStores = [];
let storeGroups = [];

/** 从后端 API 加载店铺数据 */
async function loadStoresFromAPI() {
  const res = await Api.getStores();
  if (res.code === 200 && res.data) {
    allStores = res.data.list || [];
    filteredStores = [...allStores];
  } else {
    allStores = [];
    filteredStores = [];
  }
  return allStores;
}

/** 从后端 API 加载分组列表 */
async function loadGroupsFromAPI() {
  const res = await Api.getStoreGroups();
  if (res.code === 200 && res.data) {
    storeGroups = res.data;
    // 更新分组筛选下拉框
    const select = document.getElementById('filterGroup');
    if (select) {
      const current = select.value;
      select.innerHTML = '<option value="">全部分组</option>' +
        storeGroups.map(g => `<option value="${g}">${g}</option>`).join('');
      select.value = current;
    }
  }
}

// ===== 渲染层 =====

/** 渲染表格 */
function renderStoreTable() {
  const tbody = document.getElementById('storeTableBody');
  const emptyEl = document.getElementById('storeEmptyState');
  if (!tbody) return;

  if (filteredStores.length === 0) {
    tbody.innerHTML = '';
    emptyEl.style.display = '';
    document.getElementById('storeFooterBar').style.display = 'none';
    return;
  }

  emptyEl.style.display = 'none';
  document.getElementById('storeFooterBar').style.display = 'flex';

  tbody.innerHTML = filteredStores.map((s, i) => `
    <tr data-id="${s.id}" data-pk="${s.id}">
      <td><input type="checkbox" class="table-check-item store-check" value="${s.id}"></td>
      <td class="seq-cell">${i + 1}</td>
      <td><span class="store-id-text">${s.store_id || s.storeId || s.id}</span></td>
      <td class="limit-cell">${s.todayLimit > 0 ? s.todayLimit.toLocaleString() : '-'}</td>
      <td><span class="currency-badge">${s.currency}</span></td>
      <td><span class="group-badge">${s.storeGroup || s.group || ''}</span></td>
      <td><span class="alias-text">${s.alias}</span></td>
      <td>${s.notifyOn ? '<span class="notify-badge on"><i data-lucide="bell-ring" style="width:12px;height:12px;"></i> 已开启</span>' : '<span class="notify-badge off">未开启</span>'}</td>
      <td><span class="auth-type-tag ${s.authType === 'API授权' ? 'api' : 'cookie'}">${s.authType}</span></td>
      <td class="time-cell">${s.authTime || ''}</td>
      <td>${getStoreStatusBadge(s.authStatus)}</td>
      <td>
        <div class="action-btns">
          <button class="action-link" onclick="showEditStoreDialog(${s.id})">编辑</button>
          <button class="action-link" onclick="refreshAuth(${s.id})">更新授权</button>
          <button class="action-link danger" onclick="deleteStore(${s.id})">删除</button>
        </div>
      </td>
    </tr>
  `).join('');

  // 更新计数
  document.getElementById('storeTotalCount').textContent = filteredStores.length;
  updateStoreSelection();

  if (window.lucide) lucide.createIcons();
}

/** 店铺状态徽章 */
function getStoreStatusBadge(status) {
  const map = {
    active: { text: '已授权', cls: 'status-active' },
    expired: { text: '已过期', cls: 'status-expired' },
    pending: { text: '待授权', cls: 'status-pending' },
    disabled: { text: '已禁用', cls: 'status-disabled' },
  };
  const item = map[status] || { text: status, cls: '' };
  return `<span class="store-status-badge ${item.cls}">${item.text}</span>`;
}

// ===== 筛选 & 搜索 =====

/** 筛选（从后端重新查询） */
async function filterStores() {
  const groupVal = document.getElementById('filterGroup')?.value || '';
  const statusVal = document.getElementById('filterAuthStatus')?.value || '';
  const notifyVal = document.getElementById('filterNotifyStatus')?.value || '';
  const keyword = (document.getElementById('storeSearchInput')?.value || '').trim();

  const res = await Api.getStores({
    group: groupVal,
    authStatus: statusVal,
    notify: notifyVal,
    keyword: keyword,
  });

  if (res.code === 200 && res.data) {
    filteredStores = res.data.list || [];
  } else {
    filteredStores = [];
  }

  renderStoreTable();
}

/** 重置筛选 */
async function resetStoreFilters() {
  const el = (id) => document.getElementById(id);
  if (el('filterGroup')) el('filterGroup').value = '';
  if (el('filterAuthStatus')) el('filterAuthStatus').value = '';
  if (el('filterNotifyStatus')) el('filterNotifyStatus').value = '';
  if (el('storeSearchInput')) el('storeSearchInput').value = '';
  await loadStoresFromAPI();
  renderStoreTable();
}

// ===== 选择 & 批量操作 =====

/** 全选/取消全选 */
function toggleSelectAllStores(checkbox) {
  const items = document.querySelectorAll('.store-check');
  items.forEach(item => item.checked = checkbox.checked);
  updateStoreSelection();
}

/** 更新选择计数 */
function updateStoreSelection() {
  const checked = document.querySelectorAll('.store-check:checked');
  document.getElementById('storeSelectedCount').textContent = checked.length;
  const allCheck = document.querySelector('.table-check-all');
  const totalItems = document.querySelectorAll('.store-check');
  if (allCheck) allCheck.checked = totalItems.length > 0 && checked.length === totalItems.length;
}

/** 批量设置分组 */
function batchSetGroup() {
  const ids = getSelectedStoreIds();
  if (ids.length === 0) { Toast.show('请先选择店铺', 'warning'); return; }
  Modal.show({
    title: '批量设置分组',
    body: `
      <p style="font-size:13px;color:#6B7280;margin-bottom:12px;">已选择 <b>${ids.length}</b> 个店铺</p>
      <div class="form-group">
        <label class="form-label">目标分组</label>
        <select class="form-select" id="batchGroupSelect">
          ${storeGroups.map(g => `<option value="${g}">${g}</option>`).join('')}
        </select>
      </div>
    `,
    footer: [
      { text: '取消', class: 'btn-ghost' },
      { text: '确认', class: 'btn-primary', onClick: async () => {
        const group = document.getElementById('batchGroupSelect').value;
        const res = await Api.batchSetGroup(ids, group);
        if (res.code === 200) {
          Modal.close();
          await loadStoresFromAPI();
          await loadGroupsFromAPI();
          renderStoreTable();
          Toast.show(res.msg || `已将 ${ids.length} 个店铺移至「${group}」`, 'success');
        } else {
          Toast.show(res.msg || '操作失败', 'error');
        }
      }},
    ],
  });
}

/** 批量设置币种 */
function batchSetCurrency() {
  const ids = getSelectedStoreIds();
  if (ids.length === 0) { Toast.show('请先选择店铺', 'warning'); return; }
  Modal.show({
    title: '批量设置币种',
    body: `
      <p style="font-size:13px;color:#6B7280;margin-bottom:12px;">已选择 <b>${ids.length}</b> 个店铺</p>
      <div class="form-group">
        <label class="form-label">币种</label>
        <select class="form-select" id="batchCurrencySelect">
          <option value="RUB">RUB - 俄罗斯卢布</option>
          <option value="USD">USD - 美元</option>
          <option value="EUR">EUR - 欧元</option>
          <option value="CNY">CNY - 人民币</option>
        </select>
      </div>
    `,
    footer: [
      { text: '取消', class: 'btn-ghost' },
      { text: '确认', class: 'btn-primary', onClick: async () => {
        const cur = document.getElementById('batchCurrencySelect').value;
        const res = await Api.batchSetCurrency(ids, cur);
        if (res.code === 200) {
          Modal.close();
          await loadStoresFromAPI();
          renderStoreTable();
          Toast.show(res.msg || `已将 ${ids.length} 个店铺币种设置为「${cur}」`, 'success');
        } else {
          Toast.show(res.msg || '操作失败', 'error');
        }
      }},
    ],
  });
}

/** 批量删除 */
function batchDeleteStores() {
  const ids = getSelectedStoreIds();
  if (ids.length === 0) { Toast.show('请先选择店铺', 'warning'); return; }
  Modal.confirm(`确定要删除选中的 ${ids.length} 个店铺吗？此操作不可恢复。`).then(async (ok) => {
    if (ok) {
      const res = await Api.batchDeleteStores(ids);
      if (res.code === 200) {
        await loadStoresFromAPI();
        await loadGroupsFromAPI();
        renderStoreTable();
        Toast.show(res.msg || `已删除 ${ids.length} 个店铺`, 'success');
      } else {
        Toast.show(res.msg || '删除失败', 'error');
      }
    }
  });
}

/** 获取选中的店铺ID列表 */
function getSelectedStoreIds() {
  return [...document.querySelectorAll('.store-check:checked')].map(el => parseInt(el.value));
}

// ===== 单项操作 =====

/** 删除店铺 */
function deleteStore(pk) {
  const store = filteredStores.find(s => s.id === pk);
  if (!store) return;
  Modal.confirm(`确定要删除店铺「${store.alias}」吗？此操作不可恢复。`).then(async (ok) => {
    if (ok) {
      const res = await Api.deleteStore(pk);
      if (res.code === 200) {
        await loadStoresFromAPI();
        await loadGroupsFromAPI();
        renderStoreTable();
        Toast.show(`店铺「${store.alias}」已删除`, 'success');
      } else {
        Toast.show(res.msg || '删除失败', 'error');
      }
    }
  });
}

/** 更新授权 */
async function refreshAuth(pk) {
  const store = filteredStores.find(s => s.id === pk);
  if (!store) return;
  Toast.show(`正在更新「${store.alias}」的授权信息...`, 'info');
  const res = await Api.refreshStoreAuth(pk);
  if (res.code === 200) {
    await loadStoresFromAPI();
    renderStoreTable();
    Toast.show('授权更新成功', 'success');
  } else {
    Toast.show(res.msg || '授权更新失败', 'error');
  }
}

/** 显示编辑店铺弹窗 */
function showEditStoreDialog(pk) {
  const store = filteredStores.find(s => s.id === pk);
  if (!store) return;

  Modal.show({
    title: `编辑店铺 - ${store.alias}`,
    size: 'md',
    body: `
      <div class="add-auth-form">
        <div class="form-group auth-form-group">
          <label class="form-label auth-label">店铺别名</label>
          <input type="text" class="form-input auth-input" id="editAlias"
                 value="${store.alias || ''}" maxlength="50">
        </div>

        <div class="form-group auth-form-group">
          <label class="form-label auth-label">Client-Id</label>
          <input type="text" class="form-input auth-input" id="editClientId"
                 value="${store.clientId || ''}" maxlength="64">
        </div>

        <div class="form-group auth-form-group">
          <label class="form-label auth-label">Api-Key</label>
          <input type="password" class="form-input auth-input" id="editApiKey"
                 placeholder="输入新的 Api-Key 以更新" maxlength="128">
          <button type="button" class="toggle-pwd-btn" onclick="togglePwdVisibility('editApiKey',this)" title="显示/隐藏密码">
            <i data-lucide="eye" style="width:14px;height:14px;"></i>
          </button>
          <div class="field-notice">
            <span class="notice-text" style="color:#6B7280;font-size:12px;">
              留空表示不修改；从 Ozon 卖家后台获取：设置 → API Keys
            </span>
          </div>
        </div>

        <div class="form-group auth-form-group">
          <label class="form-label auth-label">店铺币种</label>
          <select class="form-select auth-input" id="editCurrency">
            <option value="RUB" ${store.currency === 'RUB' ? 'selected' : ''}>RUB - 俄罗斯卢布</option>
            <option value="USD" ${store.currency === 'USD' ? 'selected' : ''}>USD - 美元</option>
            <option value="EUR" ${store.currency === 'EUR' ? 'selected' : ''}>EUR - 欧元</option>
            <option value="CNY" ${store.currency === 'CNY' ? 'selected' : ''}>CNY - 人民币</option>
            <option value="KZT" ${store.currency === 'KZT' ? 'selected' : ''}>KZT - 哈萨克斯坦坚戈</option>
            <option value="BYN" ${store.currency === 'BYN' ? 'selected' : ''}>BYN - 白俄罗斯卢布</option>
          </select>
        </div>

        <div class="form-group auth-form-group">
          <label class="form-label auth-label">授权状态</label>
          <select class="form-select auth-input" id="editAuthStatus">
            <option value="active" ${store.authStatus === 'active' ? 'selected' : ''}>已授权</option>
            <option value="pending" ${store.authStatus === 'pending' ? 'selected' : ''}>待授权</option>
            <option value="expired" ${store.authStatus === 'expired' ? 'selected' : ''}>已过期</option>
            <option value="disabled" ${store.authStatus === 'disabled' ? 'selected' : ''}>已禁用</option>
          </select>
        </div>
      </div>
    `,
    footer: [
      { text: '取消', class: 'btn-ghost', onClick: () => Modal.close() },
      { text: '保存', class: 'btn-primary', id: 'btnEditStoreConfirm', onClick: () => submitEditStoreForm(pk) },
    ],
    onOpen: () => {
      if (window.lucide) lucide.createIcons();
    },
  });
}

/** 提交编辑店铺表单 */
async function submitEditStoreForm(pk) {
  const apiKey = document.getElementById('editApiKey').value.trim();
  const updateData = {
    alias: document.getElementById('editAlias').value.trim(),
    clientId: document.getElementById('editClientId').value.trim(),
    currency: document.getElementById('editCurrency').value,
    authStatus: document.getElementById('editAuthStatus').value,
  };

  // Api-Key 留空表示不修改
  if (apiKey) {
    updateData.apiKey = apiKey;
  }

  const confirmBtn = document.getElementById('btnEditStoreConfirm');
  if (confirmBtn) {
    confirmBtn.disabled = true;
    confirmBtn.innerHTML = '<span class="loading-spinner-sm"></span> 保存中...';
  }

  const res = await Api.updateStore(pk, updateData);

  if (confirmBtn) {
    confirmBtn.disabled = false;
    confirmBtn.innerHTML = '保存';
  }

  if (res.code === 200) {
    Modal.close();
    await loadStoresFromAPI();
    renderStoreTable();
    Toast.show('店铺信息已更新', 'success');
  } else {
    Toast.show(res.msg || '保存失败', 'error');
  }
}

// ===== 弹窗操作 =====

/** 显示添加授权弹窗 */
function showAddStoreDialog() {
  Modal.show({
    title: '添加授权',
    size: 'md',
    body: `
      <!-- 顶部提示横幅 -->
      <div class="auth-tip-banner">
        <span class="auth-tip-text">提示：OZON除授权店铺外，还需要开启通知推送，可避免"订单自动同步延迟、打印面单慢、漏单"等问题。</span>
        <a class="auth-tip-link" href="#" onclick="Toast.show('打开帮助中心','info');return false;">帮助中心</a>
      </div>

      <!-- 表单区域 -->
      <div class="add-auth-form">
        <!-- 店铺ID -->
        <div class="form-group auth-form-group">
          <label class="form-label auth-label">店铺ID <span class="required">*</span></label>
          <input type="text" class="form-input auth-input" id="addStoreId"
                 placeholder="Ozon 平台店铺 ID" maxlength="20"
                 oninput="validateAuthField('storeId',this.value)">
          <div class="field-error" id="error_storeId"></div>
        </div>

        <!-- 店铺别名 -->
        <div class="form-group auth-form-group">
          <label class="form-label auth-label">店铺别名 <span class="required">*</span></label>
          <input type="text" class="form-input auth-input" id="addAlias"
                 placeholder="" maxlength="50"
                 oninput="validateAuthField('alias',this.value)">
          <div class="field-notice" id="notice_alias">
            <span class="notice-icon">&#9888;</span>
            <span class="notice-text">注意：生成API密钥时请选择"管理员"权限</span>
            <a class="notice-detail-link" href="#" onclick="Toast.show('查看权限详情','info');return false;">详情</a>
          </div>
          <div class="field-error" id="error_alias"></div>
        </div>

        <!-- 店铺币种 -->
        <div class="form-group auth-form-group">
          <label class="form-label auth-label">店铺币种 <span class="required">*</span></label>
          <select class="form-select auth-input" id="addCurrency" onchange="validateAuthField('currency',this.value)">
            <option value="">请选择店铺后台币种</option>
            <option value="RUB">RUB - 俄罗斯卢布</option>
            <option value="USD">USD - 美元</option>
            <option value="EUR">EUR - 欧元</option>
            <option value="CNY">CNY - 人民币</option>
            <option value="KZT">KZT - 哈萨克斯坦坚戈</option>
            <option value="BYN">BYN - 白俄罗斯卢布</option>
          </select>
          <div class="field-notice" id="notice_currency">
            <span class="notice-icon">&#9888;</span>
            <span class="notice-text">注意：请选择与店铺后台相同的币种，否则会影响发布</span>
            <a class="notice-detail-link" href="#" onclick="Toast.show('查看币种影响说明','info');return false;">详情</a>
          </div>
          <div class="field-error" id="error_currency"></div>
        </div>

        <!-- Client-Id -->
        <div class="form-group auth-form-group">
          <label class="form-label auth-label">Client-Id <span class="required">*</span></label>
          <input type="text" class="form-input auth-input" id="addClientId"
                 placeholder="" maxlength="64"
                 oninput="validateAuthField('clientId',this.value)">
          <div class="field-error" id="error_clientId"></div>
        </div>

        <!-- Api-Key -->
        <div class="form-group auth-form-group">
          <label class="form-label auth-label">Api-Key <span class="required">*</span></label>
          <input type="password" class="form-input auth-input" id="addApiKey"
                 placeholder="" maxlength="128"
                 oninput="validateAuthField('apiKey',this.value)">
          <button type="button" class="toggle-pwd-btn" onclick="togglePwdVisibility('addApiKey',this)" title="显示/隐藏密码">
            <i data-lucide="eye" style="width:14px;height:14px;"></i>
          </button>
          <div class="field-error" id="error_apiKey"></div>
        </div>
      </div>
    `,
    footer: [
      { text: '查看授权帮助', class: 'btn-link', onClick: () => Toast.show('正在打开授权帮助文档...', 'info') },
      { text: '取消', class: 'btn-ghost', onClick: () => Modal.close() },
      { text: '确定', class: 'btn-primary', id: 'btnAddStoreConfirm', onClick: () => submitAddStoreForm() },
    ],
    onOpen: () => {
      if (window.lucide) lucide.createIcons();
      clearAllAuthErrors();
    },
  });
}

/** 验证单个字段 */
function validateAuthField(field, value) {
  const errorEl = document.getElementById(`error_${field}`);
  if (!errorEl) return true;
  errorEl.textContent = '';
  errorEl.classList.remove('show');

  const v = (value || '').trim();

  switch (field) {
    case 'storeId':
      if (!v) { showFieldError(field, '店铺ID不能为空'); return false; }
      break;
    case 'alias':
      if (!v) { showFieldError(field, '店铺别名不能为空'); return false; }
      if (v.length < 2) { showFieldError(field, '店铺别名至少需要2个字符'); return false; }
      break;
    case 'currency':
      if (!v) { showFieldError(field, '请选择店铺币种'); return false; }
      break;
    case 'clientId':
      if (!v) { showFieldError(field, 'Client-Id不能为空'); return false; }
      break;
    case 'apiKey':
      if (!v) { showFieldError(field, 'Api-Key不能为空'); return false; }
      break;
  }
  return true;
}

/** 显示字段错误 */
function showFieldError(field, msg) {
  const el = document.getElementById(`error_${field}`);
  if (el) { el.textContent = msg; el.classList.add('show'); }
}

/** 清除所有错误 */
function clearAllAuthErrors() {
  ['storeId','alias','currency','clientId','apiKey'].forEach(f => {
    const el = document.getElementById(`error_${f}`);
    if (el) { el.textContent = ''; el.classList.remove('show'); }
  });
}

/** 切换密码可见性 */
function togglePwdVisibility(inputId, btn) {
  const input = document.getElementById(inputId);
  if (!input) return;
  const isPassword = input.type === 'password';
  input.type = isPassword ? 'text' : 'password';
  const icon = btn.querySelector('i');
  if (icon && window.lucide) {
    icon.setAttribute('data-lucide', isPassword ? 'eye-off' : 'eye');
    lucide.createIcons();
  }
}

/** 提交添加店铺表单 */
async function submitAddStoreForm() {
  clearAllAuthErrors();

  let allValid = true;
  allValid &= validateAuthField('storeId', document.getElementById('addStoreId')?.value);
  allValid &= validateAuthField('alias', document.getElementById('addAlias')?.value);
  allValid &= validateAuthField('currency', document.getElementById('addCurrency')?.value);
  allValid &= validateAuthField('clientId', document.getElementById('addClientId')?.value);
  allValid &= validateAuthField('apiKey', document.getElementById('addApiKey')?.value);

  if (!allValid) {
    Toast.show('请检查表单中的错误项', 'warning');
    return;
  }

  const confirmBtn = document.getElementById('btnAddStoreConfirm');
  if (confirmBtn) {
    confirmBtn.disabled = true;
    confirmBtn.innerHTML = '<span class="loading-spinner-sm"></span> 提交中...';
  }

  const storeData = {
    storeId: document.getElementById('addStoreId').value.trim(),
    alias: document.getElementById('addAlias').value.trim(),
    currency: document.getElementById('addCurrency').value,
    group: '新店',
    notifyOn: true,
    authType: 'api',
    clientId: document.getElementById('addClientId').value.trim(),
    apiKey: document.getElementById('addApiKey').value.trim(),
    authStatus: 'active',
  };

  const res = await Api.createStore(storeData);

  if (confirmBtn) {
    confirmBtn.disabled = false;
    confirmBtn.innerHTML = '确定';
  }

  if (res.code === 200) {
    Modal.close();
    await loadStoresFromAPI();
    await loadGroupsFromAPI();
    renderStoreTable();
    Toast.show(`店铺「${storeData.alias}」添加并授权成功！`, 'success');
  } else {
    Toast.show(res.msg || '添加失败', 'error');
  }
}

/** 显示新建分组弹窗 */
function showAddGroupDialog() {
  Modal.show({
    title: '新建分组',
    body: `
      <div class="form-group">
        <label class="form-label">分组名称 <span class="required">*</span></label>
        <input type="text" class="form-input" id="newGroupName" placeholder="输入分组名称...">
      </div>
      <div class="existing-groups" id="existingGroups">
        <p style="font-size:12px;color:#9CA3AF;margin-bottom:8px;">已有分组：</p>
        <div class="group-tags" id="existingGroupTags">
          ${storeGroups.map(g => `<span class="group-tag">${g}</span>`).join('')}
        </div>
      </div>
    `,
    footer: [
      { text: '取消', class: 'btn-ghost' },
      { text: '创建', class: 'btn-primary', onClick: () => {
        const name = document.getElementById('newGroupName')?.value?.trim();
        if (!name) { Toast.show('请输入分组名称', 'warning'); return; }
        Modal.close();
        Toast.show(`分组「${name}」创建成功`, 'success');
        // 刷新分组列表
        loadGroupsFromAPI();
      }},
    ],
  });
}

// ===== 初始化 =====

async function initStorePage() {
  await loadStoresFromAPI();
  await loadGroupsFromAPI();
  renderStoreTable();
}

// 注册路由
Router.register('/store-manage', (route) => {
  const html = renderStorePage(route);
  requestAnimationFrame(() => initStorePage());
  return html;
});

// 页面加载后初始化（首次直接访问时）
document.addEventListener('DOMContentLoaded', () => {
  setTimeout(() => {
    if (window.location.hash === '#/store-manage' || Router.currentRoute?.path === '/store-manage') {
      initStorePage();
    }
  }, 150);
});
