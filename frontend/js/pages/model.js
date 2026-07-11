/**
 * 模型管理页 - AI Model Management Page
 * 统一管理所有 AI 提供商（DeepSeek/通义千问/OpenAI/自定义）的 API 配置
 * 一经设置，整个系统所有 AI 相关功能（类目匹配、内容生成等）共用此配置
 */

// ===== 数据层 =====
let aiModelsConfig = null;
let testingProvider = null;  // 当前正在测试连接的提供商 key

// 提供商图标映射
const PROVIDER_ICONS = {
  deepseek: '🔍',
  qwen: '🧠',
  openai: '⚡',
  custom: '⚙️',
};

/** 渲染页面主体 */
function renderModelPage(route) {
  return `
    <div style="animation: pageEnter 0.35s ease;">
      <!-- 页面标题 -->
      <div class="model-page-header">
        <div>
          <h2 class="model-page-title">模型管理</h2>
          <p class="model-page-desc">配置 AI 提供商，整个系统所有 AI 功能共用此配置（类目匹配、内容生成等）</p>
        </div>
        <div class="model-header-actions">
          <button class="btn btn-primary btn-sm" onclick="showEditProviderDialog()">
            <i data-lucide="plus" style="width:14px;height:14px;"></i> 添加自定义模型
          </button>
          <button class="btn btn-sm btn-ghost" onclick="loadModelConfig(true)">
            <i data-lucide="refresh-cw" style="width:14px;height:14px;"></i> 刷新
          </button>
        </div>
      </div>

      <!-- 当前激活状态 -->
      <div class="model-active-banner" id="modelActiveBanner">
        <div class="model-active-loading">
          <i data-lucide="loader-2" style="width:18px;height:18px;animation: spin 1s linear infinite;"></i>
          <span>加载配置中...</span>
        </div>
      </div>

      <!-- 提供商卡片网格 -->
      <div class="model-cards-grid" id="modelCardsGrid">
        <div class="model-loading-placeholder">
          <i data-lucide="loader-2" style="width:24px;height:24px;animation: spin 1s linear infinite;"></i>
          <p>正在加载...</p>
        </div>
      </div>

      <!-- 使用说明 -->
      <div class="model-help-section">
        <h3 class="model-help-title"><i data-lucide="help-circle" style="width:18px;height:18px;"></i> 使用说明</h3>
        <ul class="model-help-list">
          <li><strong>当前激活</strong>：系统所有 AI 功能调用时使用的默认模型，只能激活一个</li>
          <li><strong>DeepSeek</strong>：推荐，性价比高，中文理解强。申请：<a href="https://platform.deepseek.com" target="_blank">platform.deepseek.com</a></li>
          <li><strong>通义千问</strong>：阿里云大模型，国内访问稳定。申请：<a href="https://dashscope.console.aliyun.com" target="_blank">dashscope.console.aliyun.com</a></li>
          <li><strong>自定义</strong>：支持任何 OpenAI 兼容接口（如 Moonshot/智谱/火山引擎等）</li>
          <li><strong>安全提示</strong>：API Key 加密存储在服务器本地，前端展示为脱敏形式</li>
        </ul>
      </div>

      <!-- Ozon 类目映射库状态 -->
      <div class="model-help-section" style="margin-top: 20px;">
        <h3 class="model-help-title" style="display:flex;align-items:center;justify-content:space-between;">
          <span><i data-lucide="database" style="width:18px;height:18px;"></i> Ozon 类目映射库</span>
          <button class="btn btn-sm btn-ghost" onclick="loadCategorySyncStatus(true)" style="font-size:12px;font-weight:400;">
            <i data-lucide="refresh-cw" style="width:13px;height:13px;"></i> 刷新
          </button>
        </h3>
        <div id="categorySyncStatusBox" style="padding: 12px 0;">
          <div style="display:flex;align-items:center;gap:8px;color:var(--text-tertiary);">
            <i data-lucide="loader-2" style="width:16px;height:16px;animation: spin 1s linear infinite;"></i>
            <span style="font-size:13px;">加载同步状态...</span>
          </div>
        </div>
      </div>

      <!-- Ozon 类目属性库状态 -->
      <div class="model-help-section" style="margin-top: 20px;">
        <h3 class="model-help-title" style="display:flex;align-items:center;justify-content:space-between;">
          <span><i data-lucide="list-tree" style="width:18px;height:18px;"></i> Ozon 类目属性库</span>
          <button class="btn btn-sm btn-ghost" onclick="loadAttrSyncStatus(true)" style="font-size:12px;font-weight:400;">
            <i data-lucide="refresh-cw" style="width:13px;height:13px;"></i> 刷新
          </button>
        </h3>
        <div id="attrSyncStatusBox" style="padding: 12px 0;">
          <div style="display:flex;align-items:center;gap:8px;color:var(--text-tertiary);">
            <i data-lucide="loader-2" style="width:16px;height:16px;animation: spin 1s linear infinite;"></i>
            <span style="font-size:13px;">加载属性同步状态...</span>
          </div>
        </div>
      </div>
    </div>
  `;
}

// ===== 数据加载 =====

/** 从后端加载 AI 模型配置 */
async function loadModelConfig(forceRefresh = false) {
  try {
    const res = await Api.getAIModels();
    if (res.code === 200 && res.data) {
      aiModelsConfig = res.data;
      renderActiveBanner();
      renderProviderCards();
    } else {
      Toast.show(res.msg || '加载配置失败', 'error');
      renderProviderCardsError(res.msg || '加载失败');
    }
  } catch (e) {
    console.error('[模型管理] 加载失败:', e);
    Toast.show('加载配置失败，请检查后端服务', 'error');
    renderProviderCardsError('后端服务未响应');
  }
  // 同时加载类目映射库同步状态
  loadCategorySyncStatus();
  // 同时加载属性库同步状态
  loadAttrSyncStatus();
  if (window.lucide) lucide.createIcons();
}

// ===== Ozon 类目映射库同步状态 =====

/** 加载类目映射库同步状态 */
async function loadCategorySyncStatus(showToast = false) {
  const box = document.getElementById('categorySyncStatusBox');
  if (!box) return;
  try {
    const res = await Api.getCategorySyncStatus();
    if (res.code === 200 && res.data) {
      renderCategorySyncStatus(res.data);
      if (showToast) Toast.show('同步状态已刷新', 'success');
    } else {
      box.innerHTML = `<div style="color:var(--text-tertiary);font-size:13px;">${res.msg || '获取状态失败'}</div>`;
    }
  } catch (e) {
    console.error('[类目映射库] 加载状态失败:', e);
    box.innerHTML = `<div style="color:var(--color-accent-red);font-size:13px;">加载失败：${e.message}</div>`;
  }
  if (window.lucide) lucide.createIcons();
}

/** 渲染类目映射库同步状态 */
function renderCategorySyncStatus(status) {
  const box = document.getElementById('categorySyncStatusBox');
  if (!box) return;

  const total = status.category_count || 0;
  const l1 = status.l1_count || 0;
  const l2 = status.l2_count || 0;
  const l3 = status.l3_count || 0;
  const isSyncing = status.is_syncing;
  const needsSync = status.needs_sync;
  const lastSuccess = status.last_success;
  const intervalDays = status.sync_interval_days || 30;

  // 状态指示
  let statusBadge = '';
  if (isSyncing) {
    statusBadge = `<span style="display:inline-flex;align-items:center;gap:4px;padding:3px 10px;border-radius:12px;background:rgba(59,130,246,0.1);color:#3b82f6;font-size:12px;">
      <i data-lucide="loader-2" style="width:13px;height:13px;animation: spin 1s linear infinite;"></i> 同步中
    </span>`;
  } else if (needsSync) {
    statusBadge = `<span style="display:inline-flex;align-items:center;gap:4px;padding:3px 10px;border-radius:12px;background:rgba(234,179,8,0.1);color:#ca8a04;font-size:12px;">
      <i data-lucide="alert-circle" style="width:13px;height:13px;"></i> 需要更新
    </span>`;
  } else {
    statusBadge = `<span style="display:inline-flex;align-items:center;gap:4px;padding:3px 10px;border-radius:12px;background:rgba(34,197,94,0.1);color:#16a34a;font-size:12px;">
      <i data-lucide="check-circle" style="width:13px;height:13px;"></i> 已是最新
    </span>`;
  }

  // 上次同步时间
  let lastSyncHtml = '<span style="color:var(--text-tertiary);">从未同步</span>';
  if (lastSuccess) {
    lastSyncHtml = `<span style="color:var(--text-secondary);">${lastSuccess.created_at}</span>
      <span style="color:var(--text-tertiary);font-size:11px;margin-left:6px;">
        (耗时 ${lastSuccess.duration_seconds}s，共 ${lastSuccess.total_count} 个)
      </span>`;
  }

  box.innerHTML = `
    <div style="display:grid;grid-template-columns:repeat(4,1fr);gap:12px;margin-bottom:14px;">
      <div style="background:var(--bg-input);border-radius:8px;padding:10px 12px;">
        <div style="font-size:11px;color:var(--text-tertiary);margin-bottom:4px;">类目总数</div>
        <div style="font-size:18px;font-weight:700;color:var(--text-primary);">${total.toLocaleString()}</div>
      </div>
      <div style="background:var(--bg-input);border-radius:8px;padding:10px 12px;">
        <div style="font-size:11px;color:var(--text-tertiary);margin-bottom:4px;">一级类目</div>
        <div style="font-size:18px;font-weight:700;color:var(--text-primary);">${l1.toLocaleString()}</div>
      </div>
      <div style="background:var(--bg-input);border-radius:8px;padding:10px 12px;">
        <div style="font-size:11px;color:var(--text-tertiary);margin-bottom:4px;">二级类目</div>
        <div style="font-size:18px;font-weight:700;color:var(--text-primary);">${l2.toLocaleString()}</div>
      </div>
      <div style="background:var(--bg-input);border-radius:8px;padding:10px 12px;">
        <div style="font-size:11px;color:var(--text-tertiary);margin-bottom:4px;">三级类目</div>
        <div style="font-size:18px;font-weight:700;color:var(--text-primary);">${l3.toLocaleString()}</div>
      </div>
    </div>

    <div style="display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:10px;padding-top:10px;border-top:1px solid var(--border-color-lighter);">
      <div style="display:flex;align-items:center;gap:12px;flex-wrap:wrap;">
        ${statusBadge}
        <span style="font-size:12px;color:var(--text-tertiary);">更新周期：每 ${intervalDays} 天</span>
        <span style="font-size:12px;color:var(--text-tertiary);">|</span>
        <span style="font-size:12px;color:var(--text-tertiary);">上次同步：${lastSyncHtml}</span>
      </div>
      <div style="display:flex;gap:8px;">
        <button class="btn btn-sm btn-primary" onclick="triggerManualCategorySync(false)" ${isSyncing ? 'disabled' : ''} style="font-size:12px;">
          <i data-lucide="refresh-cw" style="width:13px;height:13px;"></i> ${isSyncing ? '同步中...' : '检查更新'}
        </button>
        <button class="btn btn-sm btn-ghost" onclick="triggerManualCategorySync(true)" ${isSyncing ? 'disabled' : ''} style="font-size:12px;">
          <i data-lucide="download-cloud" style="width:13px;height:13px;"></i> 强制全量同步
        </button>
      </div>
    </div>

    ${status.reason ? `<div style="margin-top:8px;font-size:11px;color:var(--text-tertiary);">${status.reason}</div>` : ''}
  `;

  if (window.lucide) lucide.createIcons();
}

/** 手动触发类目同步 */
async function triggerManualCategorySync(force = false) {
  if (typeof Toast === 'undefined') return;
  Toast.show(force ? '开始强制全量同步...' : '开始检查更新...', 'info');

  // 先更新按钮状态为同步中
  const box = document.getElementById('categorySyncStatusBox');
  if (box) {
    const buttons = box.querySelectorAll('button');
    buttons.forEach(b => { b.disabled = true; });
  }

  try {
    // 用异步触发接口（不阻塞）
    const res = await Api.triggerCategorySync(force);
    if (res.code === 200) {
      Toast.show(res.msg || '同步任务已启动', 'success');
      // 轮询状态
      _pollCategorySyncStatus();
    } else {
      Toast.show(res.msg || '触发同步失败', 'error');
      loadCategorySyncStatus();
    }
  } catch (e) {
    console.error('[类目映射库] 触发同步失败:', e);
    Toast.show('触发同步失败: ' + e.message, 'error');
    loadCategorySyncStatus();
  }
}

/** 轮询同步状态（每 3 秒查一次，直到完成） */
let _syncPollTimer = null;
function _pollCategorySyncStatus() {
  if (_syncPollTimer) clearInterval(_syncPollTimer);
  _syncPollTimer = setInterval(async () => {
    try {
      const res = await Api.getCategorySyncStatus();
      if (res.code === 200 && res.data) {
        renderCategorySyncStatus(res.data);
        if (!res.data.is_syncing) {
          clearInterval(_syncPollTimer);
          _syncPollTimer = null;
          Toast.show(res.data.needs_sync ? '同步未完成，请重试' : '同步完成', res.data.needs_sync ? 'warning' : 'success');
        }
      }
    } catch (e) {
      console.error('[类目映射库] 轮询状态失败:', e);
    }
  }, 3000);

  // 30 秒后停止轮询（防止无限轮询）
  setTimeout(() => {
    if (_syncPollTimer) {
      clearInterval(_syncPollTimer);
      _syncPollTimer = null;
    }
  }, 30000);
}

// ===== Ozon 类目属性库同步状态 =====

/** 加载属性库同步状态 */
async function loadAttrSyncStatus(showToast = false) {
  const box = document.getElementById('attrSyncStatusBox');
  if (!box) return;
  try {
    const res = await Api.getAttrSyncStatus();
    if (res.code === 200 && res.data) {
      renderAttrSyncStatus(res.data);
      if (showToast) Toast.show('属性同步状态已刷新', 'success');
    } else {
      box.innerHTML = `<div style="color:var(--text-tertiary);font-size:13px;">${res.msg || '获取状态失败'}</div>`;
    }
  } catch (e) {
    console.error('[属性库] 加载状态失败:', e);
    box.innerHTML = `<div style="color:var(--color-accent-red);font-size:13px;">加载失败：${e.message}</div>`;
  }
  if (window.lucide) lucide.createIcons();
}

/** 渲染属性库同步状态 */
function renderAttrSyncStatus(status) {
  const box = document.getElementById('attrSyncStatusBox');
  if (!box) return;

  const attrCount = status.attr_count || 0;
  const syncedTypes = status.synced_type_count || 0;
  const dictValues = status.dict_value_count || 0;
  const isSyncing = status.is_syncing;
  const progress = status.progress;
  const lastSync = status.last_sync;

  // 状态指示
  let statusBadge = '';
  if (isSyncing) {
    statusBadge = `<span style="display:inline-flex;align-items:center;gap:4px;padding:3px 10px;border-radius:12px;background:rgba(59,130,246,0.1);color:#3b82f6;font-size:12px;">
      <i data-lucide="loader-2" style="width:13px;height:13px;animation: spin 1s linear infinite;"></i> 同步中
    </span>`;
  } else if (syncedTypes === 0) {
    statusBadge = `<span style="display:inline-flex;align-items:center;gap:4px;padding:3px 10px;border-radius:12px;background:rgba(234,179,8,0.1);color:#ca8a04;font-size:12px;">
      <i data-lucide="alert-circle" style="width:13px;height:13px;"></i> 未同步
    </span>`;
  } else {
    statusBadge = `<span style="display:inline-flex;align-items:center;gap:4px;padding:3px 10px;border-radius:12px;background:rgba(34,197,94,0.1);color:#16a34a;font-size:12px;">
      <i data-lucide="check-circle" style="width:13px;height:13px;"></i> 已同步 ${syncedTypes} 个类目
    </span>`;
  }

  // 上次同步时间
  let lastSyncHtml = '<span style="color:var(--text-tertiary);">从未同步</span>';
  if (lastSync) {
    lastSyncHtml = `<span style="color:var(--text-secondary);">${lastSync.created_at}</span>
      <span style="color:var(--text-tertiary);font-size:11px;margin-left:6px;">
        (耗时 ${lastSync.duration_seconds}s，共 ${lastSync.total_count} 个类目)
      </span>`;
  }

  // 同步进度条
  let progressHtml = '';
  if (isSyncing && progress) {
    const percent = progress.total_type_ids > 0
      ? Math.round(((progress.synced_count + progress.failed_count) / progress.total_type_ids) * 100)
      : 0;
    progressHtml = `
      <div style="margin-top:10px;">
        <div style="display:flex;justify-content:space-between;font-size:11px;color:var(--text-tertiary);margin-bottom:4px;">
          <span>进度: ${progress.synced_count + progress.failed_count} / ${progress.total_type_ids}</span>
          <span>${percent}% (失败 ${progress.failed_count})</span>
        </div>
        <div style="height:6px;background:var(--bg-input);border-radius:3px;overflow:hidden;">
          <div style="height:100%;width:${percent}%;background:var(--color-primary);transition:width 0.3s;"></div>
        </div>
      </div>`;
  }

  box.innerHTML = `
    <div style="display:grid;grid-template-columns:repeat(3,1fr);gap:12px;margin-bottom:14px;">
      <div style="background:var(--bg-input);border-radius:8px;padding:10px 12px;">
        <div style="font-size:11px;color:var(--text-tertiary);margin-bottom:4px;">属性总数</div>
        <div style="font-size:18px;font-weight:700;color:var(--text-primary);">${attrCount.toLocaleString()}</div>
      </div>
      <div style="background:var(--bg-input);border-radius:8px;padding:10px 12px;">
        <div style="font-size:11px;color:var(--text-tertiary);margin-bottom:4px;">已同步类目</div>
        <div style="font-size:18px;font-weight:700;color:var(--text-primary);">${syncedTypes.toLocaleString()}</div>
      </div>
      <div style="background:var(--bg-input);border-radius:8px;padding:10px 12px;">
        <div style="font-size:11px;color:var(--text-tertiary);margin-bottom:4px;">字典值总数</div>
        <div style="font-size:18px;font-weight:700;color:var(--text-primary);">${dictValues.toLocaleString()}</div>
      </div>
    </div>

    <div style="display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:10px;padding-top:10px;border-top:1px solid var(--border-color-lighter);">
      <div style="display:flex;align-items:center;gap:12px;flex-wrap:wrap;">
        ${statusBadge}
        <span style="font-size:12px;color:var(--text-tertiary);">上次全量同步：${lastSyncHtml}</span>
      </div>
      <div style="display:flex;gap:8px;">
        <button class="btn btn-sm btn-primary" onclick="triggerAttrSyncManual()" ${isSyncing ? 'disabled' : ''} style="font-size:12px;">
          <i data-lucide="download-cloud" style="width:13px;height:13px;"></i> ${isSyncing ? '同步中...' : '全量同步属性'}
        </button>
      </div>
    </div>

    <div style="margin-top:8px;font-size:11px;color:var(--text-tertiary);">
      按需同步：编辑商品时自动拉取该类目属性并缓存。全量同步：后台拉取全部 7422 个类目属性（预计 1-2 小时）。
    </div>

    ${progressHtml}
  `;

  if (window.lucide) lucide.createIcons();
}

/** 手动触发属性全量同步 */
async function triggerAttrSyncManual() {
  if (typeof Toast === 'undefined') return;
  Toast.show('开始全量同步属性库...', 'info');

  try {
    const res = await Api.triggerAttrSync();
    if (res.code === 200) {
      Toast.show(res.msg || '同步任务已启动', 'success');
      // 轮询状态
      _pollAttrSyncStatus();
    } else {
      Toast.show(res.msg || '触发同步失败', 'error');
      loadAttrSyncStatus();
    }
  } catch (e) {
    console.error('[属性库] 触发同步失败:', e);
    Toast.show('触发同步失败: ' + e.message, 'error');
    loadAttrSyncStatus();
  }
}

/** 轮询属性同步状态 */
let _attrSyncPollTimer = null;
function _pollAttrSyncStatus() {
  if (_attrSyncPollTimer) clearInterval(_attrSyncPollTimer);
  _attrSyncPollTimer = setInterval(async () => {
    try {
      const res = await Api.getAttrSyncStatus();
      if (res.code === 200 && res.data) {
        renderAttrSyncStatus(res.data);
        if (!res.data.is_syncing) {
          clearInterval(_attrSyncPollTimer);
          _attrSyncPollTimer = null;
          Toast.show('属性库全量同步完成', 'success');
        }
      }
    } catch (e) {
      console.error('[属性库] 轮询状态失败:', e);
    }
  }, 5000); // 5 秒轮询一次

  // 2 小时后停止轮询
  setTimeout(() => {
    if (_attrSyncPollTimer) {
      clearInterval(_attrSyncPollTimer);
      _attrSyncPollTimer = null;
    }
  }, 7200000);
}

/** 渲染当前激活状态横幅 */
function renderActiveBanner() {
  const banner = document.getElementById('modelActiveBanner');
  if (!banner) return;
  if (!aiModelsConfig) {
    banner.innerHTML = '<div class="model-active-loading">无配置</div>';
    return;
  }
  const activeKey = aiModelsConfig.active_provider || '';
  const providers = aiModelsConfig.providers || {};
  const active = providers[activeKey] || {};
  const hasKey = !!active.has_key;
  const statusColor = hasKey ? '#16a34a' : '#dc2626';
  const statusText = hasKey ? '运行中' : '未配置 API Key';
  const statusIcon = hasKey ? 'check-circle' : 'alert-circle';
  const icon = PROVIDER_ICONS[activeKey] || '🤖';

  banner.innerHTML = `
    <div class="model-active-info">
      <div class="model-active-icon">${icon}</div>
      <div class="model-active-text">
        <div class="model-active-label">当前激活模型</div>
        <div class="model-active-name">${active.name || activeKey} <span class="model-active-model">· ${active.model || '-'}</span></div>
      </div>
    </div>
    <div class="model-active-status" style="color: ${statusColor};">
      <i data-lucide="${statusIcon}" style="width:18px;height:18px;"></i>
      <span>${statusText}</span>
      ${aiModelsConfig.updated_at ? `<span class="model-active-time">最后更新: ${formatTime(aiModelsConfig.updated_at)}</span>` : ''}
    </div>
  `;
  if (window.lucide) lucide.createIcons();
}

/** 渲染所有提供商卡片 */
function renderProviderCards() {
  const grid = document.getElementById('modelCardsGrid');
  if (!grid) return;
  if (!aiModelsConfig) {
    grid.innerHTML = '<div class="model-empty">暂无配置</div>';
    return;
  }

  const providers = aiModelsConfig.providers || {};
  const activeKey = aiModelsConfig.active_provider || '';
  const cards = Object.entries(providers).map(([key, p]) => {
    const isActive = key === activeKey;
    const hasKey = !!p.has_key;
    const isBuiltin = ['deepseek', 'qwen', 'openai', 'custom'].includes(key);
    const icon = PROVIDER_ICONS[key] || '🤖';

    return `
      <div class="model-card ${isActive ? 'model-card-active' : ''} ${!p.enabled ? 'model-card-disabled' : ''}" data-key="${key}">
        <!-- 卡片头部 -->
        <div class="model-card-header">
          <div class="model-card-icon">${icon}</div>
          <div class="model-card-title-wrap">
            <div class="model-card-title">${p.name || key}</div>
            <div class="model-card-subtitle">${p.description || ''}</div>
          </div>
          ${isActive ? '<span class="model-active-badge">当前激活</span>' : ''}
        </div>

        <!-- 卡片信息 -->
        <div class="model-card-body">
          <div class="model-card-row">
            <span class="model-row-label">API Key</span>
            <span class="model-row-value ${hasKey ? 'model-key-set' : 'model-key-unset'}">
              ${hasKey ? (p.api_key || '****') : '未配置'}
            </span>
          </div>
          <div class="model-card-row">
            <span class="model-row-label">Base URL</span>
            <span class="model-row-value model-row-url" title="${p.base_url || ''}">${p.base_url || '-'}</span>
          </div>
          <div class="model-card-row">
            <span class="model-row-label">模型名称</span>
            <span class="model-row-value">${p.model || '-'}</span>
          </div>
          <div class="model-card-row">
            <span class="model-row-label">启用状态</span>
            <span class="model-row-value">
              <span class="model-status-pill ${p.enabled ? 'model-status-on' : 'model-status-off'}">
                ${p.enabled ? '已启用' : '已禁用'}
              </span>
            </span>
          </div>
        </div>

        <!-- 卡片操作 -->
        <div class="model-card-footer">
          <button class="btn btn-sm btn-ghost" onclick="testConnection('${key}')">
            <i data-lucide="zap" style="width:13px;height:13px;"></i> 测试连接
          </button>
          <button class="btn btn-sm btn-ghost" onclick="showEditProviderDialog('${key}')">
            <i data-lucide="edit-2" style="width:13px;height:13px;"></i> 编辑
          </button>
          ${isActive
            ? ''
            : `<button class="btn btn-sm btn-primary" onclick="activateProvider('${key}')" ${!hasKey ? 'disabled title="请先配置 API Key"' : ''}>
                 <i data-lucide="check" style="width:13px;height:13px;"></i> 设为默认
               </button>`
          }
          ${!isBuiltin ? `<button class="btn btn-sm btn-ghost model-btn-danger" onclick="deleteProvider('${key}')">
            <i data-lucide="trash-2" style="width:13px;height:13px;"></i>
          </button>` : ''}
        </div>
      </div>
    `;
  }).join('');

  grid.innerHTML = `<div class="model-cards-inner">${cards}</div>`;
  if (window.lucide) lucide.createIcons();
}

/** 渲染加载错误占位 */
function renderProviderCardsError(msg) {
  const grid = document.getElementById('modelCardsGrid');
  if (!grid) return;
  grid.innerHTML = `
    <div class="model-loading-placeholder">
      <i data-lucide="cloud-off" style="width:32px;height:32px;color:#dc2626;"></i>
      <p style="color:#dc2626;">${msg}</p>
      <button class="btn btn-sm btn-ghost" onclick="loadModelConfig(true)">重试</button>
    </div>
  `;
  if (window.lucide) lucide.createIcons();
}

// ===== 操作函数 =====

/** 激活某个提供商 */
async function activateProvider(key) {
  try {
    const res = await Api.setActiveAIModel(key);
    if (res.code === 200) {
      Toast.show(`已切换至「${aiModelsConfig.providers[key]?.name || key}」`, 'success');
      await loadModelConfig();
    } else {
      Toast.show(res.msg || '切换失败', 'error');
    }
  } catch (e) {
    Toast.show('切换失败', 'error');
  }
}

/** 测试连接 */
async function testConnection(key) {
  const provider = aiModelsConfig?.providers?.[key];
  if (!provider) return;

  // 如果未配置 API Key，提示并引导编辑
  if (!provider.has_key) {
    Toast.show('请先配置 API Key', 'warning');
    showEditProviderDialog(key, true);
    return;
  }

  testingProvider = key;
  // 显示测试中状态
  const card = document.querySelector(`.model-card[data-key="${key}"]`);
  if (card) {
    const btn = card.querySelector('button.btn-ghost');
    if (btn) {
      btn.disabled = true;
      btn.innerHTML = '<i data-lucide="loader-2" style="width:13px;height:13px;animation: spin 1s linear infinite;"></i> 测试中...';
      if (window.lucide) lucide.createIcons();
    }
  }

  try {
    const res = await Api.testAIModelConnection({ provider: key });
    const result = res.data || {};
    const latency = result.latency_ms ? ` (${result.latency_ms}ms)` : '';
    if (res.code === 200 && result.success) {
      Toast.show(`✅ 连接成功${latency}：${result.message || 'OK'}`, 'success', 5000);
    } else {
      Toast.show(`❌ 连接失败${latency}：${result.message || res.msg}`, 'error', 6000);
    }
  } catch (e) {
    Toast.show('测试请求失败', 'error');
  } finally {
    testingProvider = null;
    // 恢复按钮状态
    if (card) {
      const btn = card.querySelector('button.btn-ghost');
      if (btn) {
        btn.disabled = false;
        btn.innerHTML = '<i data-lucide="zap" style="width:13px;height:13px;"></i> 测试连接';
        if (window.lucide) lucide.createIcons();
      }
    }
  }
}

/** 删除自定义提供商 */
async function deleteProvider(key) {
  const confirmed = await Modal.confirm(`确定要删除自定义模型「${key}」吗？此操作不可恢复。`);
  if (!confirmed) return;
  try {
    const res = await Api.deleteAIModel(key);
    if (res.code === 200) {
      Toast.show('删除成功', 'success');
      await loadModelConfig();
    } else {
      Toast.show(res.msg || '删除失败', 'error');
    }
  } catch (e) {
    Toast.show('删除失败', 'error');
  }
}

/** 显示编辑/添加提供商弹窗 */
function showEditProviderDialog(key = null, focusApiKey = false) {
  const isEdit = !!key;
  const provider = isEdit ? (aiModelsConfig?.providers?.[key] || {}) : {
    name: '', api_key: '', base_url: '', model: '', enabled: true, description: '',
  };

  Modal.show({
    title: isEdit ? `编辑「${provider.name || key}」` : '添加自定义 AI 模型',
    size: 'md',
    body: `
      <div class="model-edit-form">
        ${!isEdit ? `
        <div class="form-group">
          <label class="form-label">提供商标识 <span class="required">*</span></label>
          <input type="text" class="form-input" id="editProviderKey"
                 placeholder="如：moonshot / zhipu / volcengine（小写英文）" maxlength="32"
                 value="">
          <div class="field-hint">用于内部标识，唯一不可重复</div>
        </div>
        ` : ''}

        <div class="form-group">
          <label class="form-label">显示名称 <span class="required">*</span></label>
          <input type="text" class="form-input" id="editProviderName"
                 placeholder="如：月之暗面 / 智谱清言" maxlength="50"
                 value="${escapeHtmlAttr(provider.name || '')}">
        </div>

        <div class="form-group">
          <label class="form-label">API Key ${isEdit ? '<span class="field-hint-inline">（留空表示不修改）</span>' : '<span class="required">*</span>'}</label>
          <div class="input-pwd-wrap">
            <input type="password" class="form-input" id="editApiKey"
                   placeholder="${isEdit && provider.has_key ? `已配置 ${provider.api_key || '****'}，留空不改` : 'sk-xxxxxxxxxxxxxxxx'}"
                   maxlength="200" autocomplete="new-password">
            <button type="button" class="toggle-pwd-btn" onclick="togglePwdVisibility('editApiKey',this)" title="显示/隐藏">
              <i data-lucide="eye" style="width:14px;height:14px;"></i>
            </button>
          </div>
        </div>

        <div class="form-group">
          <label class="form-label">Base URL <span class="required">*</span></label>
          <input type="text" class="form-input" id="editBaseUrl"
                 placeholder="https://api.example.com/v1" maxlength="200"
                 value="${escapeHtmlAttr(provider.base_url || '')}">
          <div class="field-hint">OpenAI 兼容接口的基础地址，通常以 /v1 结尾</div>
        </div>

        <div class="form-group">
          <label class="form-label">模型名称 <span class="required">*</span></label>
          <input type="text" class="form-input" id="editModel"
                 placeholder="如：gpt-4o-mini / qwen-plus / deepseek-chat" maxlength="100"
                 value="${escapeHtmlAttr(provider.model || '')}">
          <div class="field-hint">由提供商指定的模型 ID</div>
        </div>

        <div class="form-group">
          <label class="form-label">描述</label>
          <input type="text" class="form-input" id="editDescription"
                 placeholder="可选，简要描述该模型特点" maxlength="200"
                 value="${escapeHtmlAttr(provider.description || '')}">
        </div>

        <div class="form-group form-group-checkbox">
          <label class="checkbox-wrap">
            <input type="checkbox" id="editEnabled" ${provider.enabled !== false ? 'checked' : ''}>
            <span>启用此模型（禁用后系统不会调用）</span>
          </label>
        </div>

        <!-- 即时测试连接 -->
        <div class="form-group form-test-section">
          <button type="button" class="btn btn-sm btn-ghost" id="editTestBtn" onclick="testConnectionFromDialog(${isEdit ? `'${key}'` : 'null'})">
            <i data-lucide="zap" style="width:13px;height:13px;"></i> 保存并测试连接
          </button>
          <div class="test-result" id="editTestResult"></div>
        </div>
      </div>
    `,
    footer: [
      { text: '取消', class: 'btn-ghost', onClick: () => Modal.close() },
      { text: isEdit ? '保存' : '添加', class: 'btn-primary', onClick: () => saveProviderFromDialog(isEdit ? key : null) },
    ],
    onOpen: () => {
      if (window.lucide) lucide.createIcons();
      if (focusApiKey) {
        setTimeout(() => document.getElementById('editApiKey')?.focus(), 100);
      }
    },
  });
}

/** 保存（添加/编辑）提供商 */
async function saveProviderFromDialog(key) {
  const isEdit = !!key;
  const providerKey = isEdit ? key : document.getElementById('editProviderKey')?.value.trim();
  const name = document.getElementById('editProviderName')?.value.trim();
  const apiKey = document.getElementById('editApiKey')?.value;
  const baseUrl = document.getElementById('editBaseUrl')?.value.trim();
  const model = document.getElementById('editModel')?.value.trim();
  const description = document.getElementById('editDescription')?.value.trim();
  const enabled = document.getElementById('editEnabled')?.checked;

  // 校验
  if (!isEdit && !providerKey) {
    Toast.show('请填写提供商标识', 'warning');
    return;
  }
  if (!name) {
    Toast.show('请填写显示名称', 'warning');
    return;
  }
  if (!baseUrl) {
    Toast.show('请填写 Base URL', 'warning');
    return;
  }
  if (!model) {
    Toast.show('请填写模型名称', 'warning');
    return;
  }
  if (!isEdit && !apiKey) {
    Toast.show('请填写 API Key', 'warning');
    return;
  }
  if (!isEdit && !/^[a-z0-9_-]+$/.test(providerKey)) {
    Toast.show('提供商标识只能包含小写字母、数字、下划线和短横线', 'warning');
    return;
  }

  const data = {
    name,
    base_url: baseUrl,
    model,
    description,
    enabled,
  };
  // API Key：编辑时留空不修改，添加时必须传
  if (apiKey) {
    data.api_key = apiKey;
  }

  try {
    const res = await Api.updateAIModel(providerKey, data);
    if (res.code === 200) {
      Toast.show(isEdit ? '配置已保存' : '模型已添加', 'success');
      Modal.close();
      await loadModelConfig();
    } else {
      Toast.show(res.msg || '保存失败', 'error');
    }
  } catch (e) {
    Toast.show('保存请求失败', 'error');
  }
}

/** 从编辑弹窗测试连接（保存临时配置后测试） */
async function testConnectionFromDialog(key) {
  const isEdit = !!key;
  const providerKey = isEdit ? key : document.getElementById('editProviderKey')?.value.trim();
  const apiKey = document.getElementById('editApiKey')?.value;
  const baseUrl = document.getElementById('editBaseUrl')?.value.trim();
  const model = document.getElementById('editModel')?.value.trim();
  const resultEl = document.getElementById('editTestResult');
  const testBtn = document.getElementById('editTestBtn');

  if (!baseUrl || !model) {
    Toast.show('请先填写 Base URL 和 模型名称', 'warning');
    return;
  }
  // 编辑时若没填新 API Key，使用已保存的配置测试
  if (!isEdit && !apiKey) {
    Toast.show('请先填写 API Key', 'warning');
    return;
  }

  testBtn.disabled = true;
  testBtn.innerHTML = '<i data-lucide="loader-2" style="width:13px;height:13px;animation: spin 1s linear infinite;"></i> 测试中...';
  if (window.lucide) lucide.createIcons();
  resultEl.innerHTML = '';
  resultEl.className = 'test-result';

  try {
    // 先保存配置（如果有 key 或编辑模式）
    if (apiKey || isEdit) {
      const saveData = {
        name: document.getElementById('editProviderName')?.value.trim() || providerKey,
        base_url: baseUrl,
        model,
        description: document.getElementById('editDescription')?.value.trim(),
        enabled: document.getElementById('editEnabled')?.checked,
      };
      if (apiKey) saveData.api_key = apiKey;
      const saveRes = await Api.updateAIModel(providerKey, saveData);
      if (saveRes.code !== 200) {
        resultEl.innerHTML = `<span class="test-error">保存失败：${saveRes.msg}</span>`;
        return;
      }
    }
    // 然后测试连接
    const params = { provider: providerKey };
    if (apiKey) params.api_key = apiKey;
    if (baseUrl) params.base_url = baseUrl;
    if (model) params.model = model;
    const res = await Api.testAIModelConnection(params);
    const result = res.data || {};
    const latency = result.latency_ms ? ` · ${result.latency_ms}ms` : '';
    if (res.code === 200 && result.success) {
      resultEl.innerHTML = `<span class="test-success"><i data-lucide="check-circle" style="width:14px;height:14px;"></i> ${result.message || '连接成功'}${latency}</span>`;
    } else {
      resultEl.innerHTML = `<span class="test-error"><i data-lucide="x-circle" style="width:14px;height:14px;"></i> ${result.message || res.msg}${latency}</span>`;
    }
    if (window.lucide) lucide.createIcons();
    // 刷新列表
    await loadModelConfig();
  } catch (e) {
    resultEl.innerHTML = `<span class="test-error">请求失败：${e.message}</span>`;
  } finally {
    testBtn.disabled = false;
    testBtn.innerHTML = '<i data-lucide="zap" style="width:13px;height:13px;"></i> 保存并测试连接';
    if (window.lucide) lucide.createIcons();
  }
}

// ===== 工具函数 =====

function escapeHtmlAttr(s) {
  if (s === null || s === undefined) return '';
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function formatTime(iso) {
  if (!iso) return '';
  try {
    const d = new Date(iso);
    if (isNaN(d.getTime())) return iso;
    return d.toLocaleString('zh-CN', {
      month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit',
    });
  } catch (e) {
    return iso;
  }
}

function togglePwdVisibility(inputId, btn) {
  const input = document.getElementById(inputId);
  if (!input) return;
  input.type = input.type === 'password' ? 'text' : 'password';
  if (window.lucide) lucide.createIcons();
}

// ===== 页面初始化 =====

function initModelPage() {
  loadModelConfig();
}

// 注册路由
Router.register('/model-manage', (route) => {
  const html = renderModelPage(route);
  requestAnimationFrame(() => initModelPage());
  return html;
});
