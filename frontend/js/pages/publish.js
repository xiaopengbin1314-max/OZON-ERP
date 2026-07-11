/**
 * 上架记录页 - Publish Records Page
 * 上架记录管理、状态追踪、批量操作
 */

let currentPublishFilter = '';
let publishSelectedIds = new Set();
let publishCurrentPage = 1;
let publishPageSize = 20;
let publishTotal = 0;

function renderPublishPage(route) {
  return `
    <div style="animation:pageEnter 0.35s ease;">
      <!-- 页面标题 -->
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:24px;">
        <div>
          <h2 style="font-family:var(--font-display);font-size:var(--text-2xl);font-weight:700;">上架记录</h2>
          <p style="color:var(--text-secondary);margin-top:4px;font-size:13px;">管理上架队列、追踪发布状态</p>
        </div>
        <div style="display:flex;gap:8px;">
          <button class="btn btn-ghost btn-sm" onclick="refreshAllPublishStatus()">
            <i data-lucide="refresh-cw" style="width:14px;height:14px;"></i> 刷新状态
          </button>
          <button class="btn btn-primary btn-sm" onclick="batchSubmitPublishRecords()">
            <i data-lucide="upload-cloud" style="width:14px;height:14px;"></i> 批量发布
          </button>
        </div>
      </div>

      <!-- 统计卡片 -->
      <div class="publish-stats">
        <div class="stat-card">
          <div class="stat-icon green"><i data-lucide="check-circle" style="width:20px;height:20px;"></i></div>
          <div>
            <div class="stat-value" id="statSuccess">0</div>
            <div class="stat-label">发布成功</div>
          </div>
        </div>
        <div class="stat-card">
          <div class="stat-icon red"><i data-lucide="x-circle" style="width:20px;height:20px;"></i></div>
          <div>
            <div class="stat-value" id="statFailed">0</div>
            <div class="stat-label">发布失败</div>
          </div>
        </div>
        <div class="stat-card">
          <div class="stat-icon blue"><i data-lucide="loader-2" style="width:20px;height:20px;"></i></div>
          <div>
            <div class="stat-value" id="statProcessing">0</div>
            <div class="stat-label">发布中</div>
          </div>
        </div>
        <div class="stat-card">
          <div class="stat-icon orange"><i data-lucide="clock" style="width:20px;height:20px;"></i></div>
          <div>
            <div class="stat-value" id="statPending">0</div>
            <div class="stat-label">待发布</div>
          </div>
        </div>
      </div>

      <!-- 搜索与筛选 -->
      <div class="publish-toolbar">
        <div class="publish-toolbar-left">
          <div class="publish-filters" id="publishFilters">
            <button class="filter-chip active" data-status="" onclick="setPublishFilter(this)">全部</button>
            <button class="filter-chip" data-status="pending" onclick="setPublishFilter(this)">待发布</button>
            <button class="filter-chip" data-status="processing" onclick="setPublishFilter(this)">发布中</button>
            <button class="filter-chip" data-status="published" onclick="setPublishFilter(this)">已成功</button>
            <button class="filter-chip" data-status="failed" onclick="setPublishFilter(this)">已失败</button>
            <button class="filter-chip" data-status="cancelled" onclick="setPublishFilter(this)">已取消</button>
          </div>
        </div>
        <div class="publish-toolbar-right">
          <div class="search-box" style="max-width:240px;">
            <i data-lucide="search" class="search-icon"></i>
            <input type="text" placeholder="搜索商品、货源..." id="publishSearchInput" onkeydown="if(event.key==='Enter')loadPublishData()">
          </div>
        </div>
      </div>

      <!-- 发布记录表格 -->
      <div class="publish-table-wrap">
        <table class="data-table publish-table" id="publishTable">
          <thead>
            <tr>
              <th><input type="checkbox" class="table-check-all" onclick="togglePublishSelectAll(this)"></th>
              <th>产品信息</th>
              <th>关联货源</th>
              <th>发布状态</th>
              <th>发布人员/发布时间</th>
              <th>店铺名称</th>
              <th>操作</th>
            </tr>
          </thead>
          <tbody id="publishTableBody">
            <!-- 动态渲染 -->
          </tbody>
        </table>
      </div>

      <!-- 空状态 -->
      <div class="empty-state" id="publishEmpty" style="display:none;">
        <div class="empty-icon">📋</div>
        <p>暂无上架记录</p>
        <p style="font-size:12px;margin-top:4px;">从「采集箱」中选择商品进行上架</p>
      </div>

      <!-- 底部操作栏 -->
      <div class="collect-footer-bar" id="publishFooterBar" style="display:none;">
        <div class="collect-footer-left">
          <span class="select-info">已选 <strong id="publishSelectedCount">0</strong> 条</span>
          <button class="btn btn-sm btn-ghost" onclick="batchSubmitPublishRecords()">批量发布</button>
          <button class="btn btn-sm btn-ghost" onclick="batchRefreshPublishStatus()">刷新状态</button>
          <button class="btn btn-sm btn-ghost danger" onclick="batchDeletePublishRecords()">批量删除</button>
        </div>
        <div class="collect-footer-right">
          <span class="total-info">共 <strong id="publishTotalCount">0</strong> 条记录</span>
          <button class="btn btn-xs btn-ghost" onclick="publishPrevPage()" id="publishPrevBtn">上一页</button>
          <span style="font-size:12px;color:var(--text-secondary);" id="publishPageInfo">1/1</span>
          <button class="btn btn-xs btn-ghost" onclick="publishNextPage()" id="publishNextBtn">下一页</button>
        </div>
      </div>
    </div>
  `;
}

// ===== 数据加载 =====

async function loadPublishData() {
  const tbody = document.getElementById('publishTableBody');
  const emptyEl = document.getElementById('publishEmpty');
  const footerEl = document.getElementById('publishFooterBar');

  try {
    const keyword = document.getElementById('publishSearchInput')?.value?.trim() || '';
    const res = await Api.getPublishRecords({
      page: publishCurrentPage,
      pageSize: publishPageSize,
      status: currentPublishFilter,
      keyword: keyword,
    });

    let records = [];
    if (res.code === 200 && res.data?.list) {
      records = res.data.list;
      publishTotal = res.data.total;
    } else {
      records = [];
      publishTotal = 0;
    }

    // 更新统计
    loadPublishStats();

    if (records.length === 0) {
      tbody.innerHTML = '';
      if (emptyEl) emptyEl.style.display = 'flex';
      if (footerEl) footerEl.style.display = 'none';
      return;
    }

    if (emptyEl) emptyEl.style.display = 'none';
    if (footerEl) footerEl.style.display = 'flex';

    document.getElementById('publishTotalCount').textContent = publishTotal;
    const totalPages = Math.ceil(publishTotal / publishPageSize) || 1;
    document.getElementById('publishPageInfo').textContent = `${publishCurrentPage}/${totalPages}`;

    tbody.innerHTML = records.map(record => `
      <tr data-id="${record.id}">
        <td><input type="checkbox" class="table-check-item publish-check" value="${record.id}" onclick="togglePublishSelect('${record.id}', this.checked)"></td>
        <td>
          <div class="publish-product-cell">
            <div style="font-weight:600;font-size:13px;color:var(--text-primary);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:260px;">${record.title || '-'}</div>
            <div style="font-size:11px;color:var(--text-tertiary);margin-top:2px;">₽${(record.price||0).toLocaleString()}</div>
          </div>
        </td>
        <td>
          <div class="publish-source-cell">
            ${record.sourceUrl
              ? `<a class="source-link" href="${record.sourceUrl}" target="_blank" title="${record.sourceUrl}">${record.sourceName || '1688货源'}</a>`
              : `<span class="unassigned">未关联</span>`}
            ${record.sourceId ? `<div class="source-id">${record.sourceId}</div>` : ''}
          </div>
        </td>
        <td><span class="status-badge status-${record.status}">${getPublishStatusText(record.status)}</span></td>
        <td>
          <div class="publish-meta-cell">
            <div style="font-size:13px;color:var(--text-primary);">${record.publisher || '-'}</div>
            <div style="font-size:11px;color:var(--text-tertiary);margin-top:1px;">${formatPubTime(record.createdAt)}</div>
          </div>
        </td>
        <td><span class="store-badge">${record.storeName || '-'}</span></td>
        <td>
          <div class="action-btns">
            ${record.status === 'pending' || record.status === 'failed'
              ? `<button class="action-link" onclick="submitSinglePublishRecord('${record.id}')">发布</button>`
              : ''}
            ${record.status === 'processing'
              ? `<button class="action-link" onclick="refreshSinglePublishRecord('${record.id}')">刷新</button>`
              : ''}
            <button class="action-link" onclick="editPublishRecord('${record.id}')">编辑</button>
            <button class="action-link danger" onclick="deleteSinglePublishRecord('${record.id}')">删除</button>
          </div>
        </td>
      </tr>
    `).join('');

    updatePublishSelection();
    if (window.lucide) lucide.createIcons();

  } catch (e) {
    console.error('[PublishRecords] 加载失败:', e);
  }
}

async function loadPublishStats() {
  try {
    const res = await Api.getPublishRecordStats();
    if (res.code === 200 && res.data?.stats) {
      const stats = res.data.stats;
      const setEl = (id, val) => { const el = document.getElementById(id); if (el) el.textContent = val; };
      setEl('statSuccess', (stats.published || 0) + (stats.published_with_errors || 0));
      setEl('statFailed', stats.failed || 0);
      setEl('statProcessing', stats.processing || 0);
      setEl('statPending', stats.pending || 0);
    }
  } catch (e) {
    console.error('[PublishRecords] 统计加载失败:', e);
  }
}

// ===== 筛选与搜索 =====

function setPublishFilter(btn) {
  document.querySelectorAll('.publish-filters .filter-chip').forEach(c => c.classList.remove('active'));
  btn.classList.add('active');
  currentPublishFilter = btn.dataset.status;
  publishCurrentPage = 1;
  publishSelectedIds.clear();
  loadPublishData();
}

// ===== 选择与批量操作 =====

function togglePublishSelect(id, checked) {
  if (checked) publishSelectedIds.add(id); else publishSelectedIds.delete(id);
  updatePublishSelection();
}

function togglePublishSelectAll(cb) {
  document.querySelectorAll('.publish-check').forEach(i => {
    i.checked = cb.checked;
    togglePublishSelect(i.value, cb.checked);
  });
}

function updatePublishSelection() {
  const checked = document.querySelectorAll('.publish-check:checked');
  const el = document.getElementById('publishSelectedCount');
  if (el) el.textContent = checked.length;
  const allCb = document.querySelector('#publishTable .table-check-all');
  const total = document.querySelectorAll('.publish-check');
  if (allCb) allCb.checked = total.length > 0 && checked.length === total.length;
}

// ===== 分页 =====

function publishPrevPage() {
  if (publishCurrentPage > 1) { publishCurrentPage--; loadPublishData(); }
}

function publishNextPage() {
  const totalPages = Math.ceil(publishTotal / publishPageSize) || 1;
  if (publishCurrentPage < totalPages) { publishCurrentPage++; loadPublishData(); }
}

// ===== 单项操作 =====

async function submitSinglePublishRecord(id) {
  Toast.show('正在提交发布...', 'info');
  const res = await Api.submitPublishRecord(id);
  if (res.code === 200) {
    Toast.show('发布任务已提交', 'success');
  } else {
    Toast.show(res.msg || '发布失败', 'error');
  }
  loadPublishData();
}

async function refreshSinglePublishRecord(id) {
  Toast.show('正在刷新状态...', 'info');
  const res = await Api.refreshPublishRecord(id);
  if (res.code === 200) {
    Toast.show('状态已更新', 'success');
  } else {
    Toast.show(res.msg || '刷新失败', 'error');
  }
  loadPublishData();
}

async function editPublishRecord(id) {
  const res = await Api.getPublishRecord(id);
  if (res.code !== 200 || !res.data) {
    Toast.show('获取记录详情失败', 'error');
    return;
  }
  const record = res.data;

  Modal.show({
    title: '编辑上架记录',
    size: 'lg',
    body: `
      <div class="edit-main"><div class="edit-content scroll-tabs-mode">
        <div class="edit-panel active" data-panel="basic">
          <div class="edit-panel-box">
            <div class="form-group"><label class="form-label">产品标题</label>
              <input type="text" class="form-input" id="epRecTitle" value="${record.title || ''}"></div>
            <div class="form-row-2">
              <div class="form-group"><label class="form-label">售价 (₽)</label>
                <input type="number" class="form-input" id="epRecPrice" value="${record.price || 0}"></div>
              <div class="form-group"><label class="form-label">状态</label>
                <select class="form-select" id="epRecStatus">
                  <option value="pending" ${record.status==='pending'?'selected':''}>待发布</option>
                  <option value="processing" ${record.status==='processing'?'selected':''}>发布中</option>
                  <option value="published" ${record.status==='published'?'selected':''}>已成功</option>
                  <option value="failed" ${record.status==='failed'?'selected':''}>已失败</option>
                  <option value="cancelled" ${record.status==='cancelled'?'selected':''}>已取消</option>
                </select></div>
            </div>
            <div class="form-row-2">
              <div class="form-group"><label class="form-label">店铺名称</label>
                <input type="text" class="form-input" id="epRecStore" value="${record.storeName || ''}"></div>
              <div class="form-group"><label class="form-label">发布人员</label>
                <input type="text" class="form-input" id="epRecPublisher" value="${record.publisher || ''}"></div>
            </div>
            <div class="form-group"><label class="form-label">关联货源</label>
              <div class="form-row-2">
                <input type="text" class="form-input" id="epRecSourceName" value="${record.sourceName || ''}" placeholder="货源名称">
                <input type="text" class="form-input" id="epRecSourceUrl" value="${record.sourceUrl || ''}" placeholder="货源链接">
              </div></div>
            <div class="form-group"><label class="form-label">备注</label>
              <textarea class="form-textarea" id="epRecNote" rows="2">${record.note || ''}</textarea></div>
          </div>
        </div>
      </div></div>
    `,
    footer: [
      { text: '取消', class: 'btn-ghost' },
      { text: '保存修改', class: 'btn-primary', onClick: async () => {
        const updateData = {
          title: document.getElementById('epRecTitle').value,
          price: parseFloat(document.getElementById('epRecPrice').value) || 0,
          status: document.getElementById('epRecStatus').value,
          storeName: document.getElementById('epRecStore').value,
          publisher: document.getElementById('epRecPublisher').value,
          sourceName: document.getElementById('epRecSourceName').value,
          sourceUrl: document.getElementById('epRecSourceUrl').value,
          note: document.getElementById('epRecNote').value,
        };
        const res = await Api.updatePublishRecord(id, updateData);
        if (res.code === 200) {
          Modal.close();
          Toast.show('记录已更新', 'success');
          loadPublishData();
        } else {
          Toast.show(res.msg || '更新失败', 'error');
        }
      }},
    ],
  });
}

async function deleteSinglePublishRecord(id) {
  const confirmed = await Modal.confirm('确定删除该上架记录？删除后不可恢复。');
  if (!confirmed) return;

  const res = await Api.deletePublishRecord(id);
  if (res.code === 200) {
    Toast.show('记录已删除', 'success');
    publishSelectedIds.delete(id);
    loadPublishData();
  } else {
    Toast.show(res.msg || '删除失败', 'error');
  }
}

// ===== 批量操作 =====

async function batchSubmitPublishRecords() {
  if (publishSelectedIds.size === 0) {
    Toast.show('请先选择要发布的记录', 'warning');
    return;
  }
  const confirmed = await Modal.confirm(`确定将选中的 ${publishSelectedIds.size} 条记录提交发布？`);
  if (!confirmed) return;

  Toast.show(`正在提交 ${publishSelectedIds.size} 条发布任务...`, 'info');
  const res = await Api.batchSubmitPublishRecords([...publishSelectedIds]);
  if (res.code === 200) {
    Toast.show(`已提交 ${res.data?.count || publishSelectedIds.size} 条发布任务`, 'success');
    publishSelectedIds.clear();
    loadPublishData();
  } else {
    Toast.show(res.msg || '批量发布失败', 'error');
  }
}

async function batchRefreshPublishStatus() {
  if (publishSelectedIds.size === 0) {
    Toast.show('请先选择要刷新的记录', 'warning');
    return;
  }
  Toast.show(`正在刷新 ${publishSelectedIds.size} 条记录状态...`, 'info');
  let refreshed = 0;
  for (const id of publishSelectedIds) {
    const res = await Api.refreshPublishRecord(id);
    if (res.code === 200) refreshed++;
  }
  Toast.show(`已刷新 ${refreshed} 条记录`, 'success');
  loadPublishData();
}

async function batchDeletePublishRecords() {
  if (publishSelectedIds.size === 0) {
    Toast.show('请先选择要删除的记录', 'warning');
    return;
  }
  const confirmed = await Modal.confirm(`确定删除选中的 ${publishSelectedIds.size} 条记录？不可恢复。`);
  if (!confirmed) return;

  const res = await Api.batchDeletePublishRecords([...publishSelectedIds]);
  if (res.code === 200) {
    Toast.show(`已删除 ${res.data?.deleted || 0} 条记录`, 'success');
    publishSelectedIds.clear();
    loadPublishData();
  } else {
    Toast.show(res.msg || '批量删除失败', 'error');
  }
}

async function refreshAllPublishStatus() {
  Toast.show('正在刷新所有记录状态...', 'info');
  loadPublishData();
  setTimeout(() => Toast.show('状态已更新', 'success'), 600);
}

// ===== 工具函数 =====

function getPublishStatusText(status) {
  const map = {
    pending: '待发布',
    processing: '发布中',
    published: '已成功',
    published_with_errors: '有警告',
    failed: '已失败',
    cancelled: '已取消',
    skipped: '已跳过',
  };
  return map[status] || '未知';
}

function formatPubTime(isoStr) {
  if (!isoStr) return '--';
  const d = new Date(isoStr);
  return `${d.getMonth()+1}/${d.getDate()} ${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}`;
}

// ===== 注册路由与初始化 =====

Router.register('/publish', renderPublishPage);

Store.subscribe((state) => {
  if (state.currentPage === 'publish') {
    setTimeout(loadPublishData, 80);
  }
});
