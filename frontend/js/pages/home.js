/**
 * 运营工作台
 * 数据来源：/api/dashboard/stats
 */

const WORKBENCH_METRICS = [
  { key: 'todayCollected', label: '今日采集', hint: '新进入采集箱', icon: 'package-plus', tone: 'blue', href: '/collect' },
  { key: 'pendingPublish', label: '待上架', hint: '等待完善与发布', icon: 'clock-3', tone: 'amber', href: '/collect' },
  { key: 'published', label: '在线商品', hint: 'Ozon 店铺在售', icon: 'badge-check', tone: 'green', href: '/online-products' },
  { key: 'failedPublish', label: '发布异常', hint: '需要立即处理', icon: 'circle-alert', tone: 'red', href: '/publish' },
];

function renderHomePage() {
  const html = `
    <div class="workbench-shell">
      <header class="workbench-heading">
        <div>
          <div class="workbench-eyebrow">
            <span class="workbench-live-dot"></span>
            Ozon 运营中心
          </div>
          <h1>工作台</h1>
          <p>集中查看采集、刊登和店铺运行情况</p>
        </div>
        <div class="workbench-heading-actions">
          <button class="workbench-btn workbench-btn-secondary" onclick="Router.navigate('/calculator')">
            <i data-lucide="calculator"></i><span>定价计算</span>
          </button>
          <button class="workbench-btn workbench-btn-primary" onclick="Router.navigate('/collect')">
            <i data-lucide="plus"></i><span>采集商品</span>
          </button>
        </div>
      </header>

      <section class="workbench-metrics" aria-label="运营指标">
        ${WORKBENCH_METRICS.map(metric => `
          <button class="workbench-metric workbench-metric-${metric.tone}" onclick="Router.navigate('${metric.href}')">
            <span class="workbench-metric-icon"><i data-lucide="${metric.icon}"></i></span>
            <span class="workbench-metric-copy">
              <span class="workbench-metric-label">${metric.label}</span>
              <strong data-metric-value="${metric.key}"><span class="workbench-skeleton">--</span></strong>
              <small>${metric.hint}</small>
            </span>
            <i class="workbench-metric-arrow" data-lucide="arrow-up-right"></i>
          </button>
        `).join('')}
      </section>

      <div class="workbench-grid">
        <div class="workbench-main-column">
          <section class="workbench-panel workbench-flow-panel">
            <div class="workbench-panel-header">
              <div>
                <h2>刊登流程</h2>
                <p>从采集到 Ozon 在线商品的完整路径</p>
              </div>
              <button class="workbench-text-btn" onclick="Router.navigate('/publish')">查看记录 <i data-lucide="arrow-right"></i></button>
            </div>
            <div class="workbench-flow">
              <button onclick="Router.navigate('/collect')" class="workbench-flow-step">
                <span class="workbench-flow-index">01</span>
                <span class="workbench-flow-icon flow-blue"><i data-lucide="scan-line"></i></span>
                <span><strong>商品采集</strong><small>扩展插件与手动录入</small></span>
              </button>
              <span class="workbench-flow-connector"><i data-lucide="chevron-right"></i></span>
              <button onclick="Router.navigate('/collect')" class="workbench-flow-step">
                <span class="workbench-flow-index">02</span>
                <span class="workbench-flow-icon flow-amber"><i data-lucide="list-checks"></i></span>
                <span><strong>信息校验</strong><small>类目、属性、SKU 与定价</small></span>
              </button>
              <span class="workbench-flow-connector"><i data-lucide="chevron-right"></i></span>
              <button onclick="Router.navigate('/publish')" class="workbench-flow-step">
                <span class="workbench-flow-index">03</span>
                <span class="workbench-flow-icon flow-violet"><i data-lucide="send"></i></span>
                <span><strong>提交 Ozon</strong><small>追踪 API 任务与异常</small></span>
              </button>
              <span class="workbench-flow-connector"><i data-lucide="chevron-right"></i></span>
              <button onclick="Router.navigate('/online-products')" class="workbench-flow-step">
                <span class="workbench-flow-index">04</span>
                <span class="workbench-flow-icon flow-green"><i data-lucide="store"></i></span>
                <span><strong>在线商品</strong><small>价格、库存与状态同步</small></span>
              </button>
            </div>
          </section>

          <section class="workbench-panel">
            <div class="workbench-panel-header">
              <div>
                <h2>最近任务</h2>
                <p>最新采集与上架状态</p>
              </div>
              <button class="workbench-text-btn" onclick="Router.navigate('/collect')">全部商品 <i data-lucide="arrow-right"></i></button>
            </div>
            <div id="activityList" class="workbench-activity-list">
              <div class="workbench-loading"><span></span><span></span><span></span></div>
            </div>
          </section>
        </div>

        <aside class="workbench-side-column">
          <section class="workbench-panel">
            <div class="workbench-panel-header workbench-panel-header-compact">
              <div><h2>系统状态</h2><p>服务连接健康度</p></div>
              <span id="systemStatusBadge" class="workbench-health is-loading"><span></span>检测中</span>
            </div>
            <div id="systemStatusList" class="workbench-status-list">
              <div class="workbench-loading"><span></span><span></span></div>
            </div>
          </section>

          <section class="workbench-panel">
            <div class="workbench-panel-header workbench-panel-header-compact">
              <div><h2>快捷操作</h2><p>常用运营入口</p></div>
            </div>
            <div class="workbench-quick-grid">
              <button onclick="Router.navigate('/collect')"><i data-lucide="inbox"></i><span>采集箱</span></button>
              <button onclick="Router.navigate('/publish')"><i data-lucide="upload"></i><span>上架记录</span></button>
              <button onclick="Router.navigate('/online-products')"><i data-lucide="boxes"></i><span>在线商品</span></button>
              <button onclick="Router.navigate('/store-manage')"><i data-lucide="store"></i><span>店铺管理</span></button>
            </div>
          </section>

          <section id="noticeSection" class="workbench-panel workbench-notice-panel">
            ${NoticeList.render()}
          </section>
        </aside>
      </div>
    </div>
  `;

  setTimeout(() => {
    if (window.lucide) lucide.createIcons();
    _loadDashboardData();
    _loadWorkbenchNotices();
  }, 50);
  return html;
}

async function _loadDashboardData() {
  try {
    const res = await Api.getDashboardStats();
    if (res.code !== 200 || !res.data) throw new Error('工作台数据不可用');
    _renderMetrics(res.data.metrics || []);
    _renderActivities(res.data.activities || []);
    _renderSystemStatus(res.data.systemStatus || []);
  } catch (error) {
    _renderDashboardError();
  }
}

async function _loadWorkbenchNotices() {
  try {
    const res = await Api.getNotices();
    if (res.code !== 200 || !res.data?.list) return;
    const section = document.getElementById('noticeSection');
    if (!section) return;
    section.innerHTML = NoticeList.render(res.data.list);
    NoticeList.bindEvents(section);
  } catch (error) {
    console.warn('[工作台] 公告加载失败:', error);
  }
}

function _renderMetrics(metrics) {
  const metricMap = Object.fromEntries(metrics.map(item => [item.key, item]));
  WORKBENCH_METRICS.forEach(definition => {
    const element = document.querySelector(`[data-metric-value="${definition.key}"]`);
    if (!element) return;
    const metric = metricMap[definition.key];
    const value = metric ? Number(metric.value) || 0 : 0;
    element.textContent = value.toLocaleString('zh-CN');
  });
}

function _renderActivities(activities) {
  const list = document.getElementById('activityList');
  if (!list) return;
  if (!activities.length) {
    list.innerHTML = '<div class="workbench-empty"><i data-lucide="inbox"></i><strong>暂无任务</strong><span>新采集或发布的商品会出现在这里</span></div>';
    if (window.lucide) lucide.createIcons();
    return;
  }

  list.innerHTML = activities.map(activity => {
    const status = activity.status === 'success' ? 'success' : activity.status === 'pending' ? 'pending' : 'failed';
    return `<button class="workbench-activity" onclick="Router.navigate('${activity.type === 'publish' ? '/publish' : '/collect'}')">
      <span class="workbench-activity-icon is-${status}"><i data-lucide="${activity.icon || 'package'}"></i></span>
      <span class="workbench-activity-main"><strong title="${_escapeWorkbenchHtml(activity.name)}">${_escapeWorkbenchHtml(activity.name)}</strong><small>${activity.type === 'publish' ? '刊登任务' : '商品采集'} · ${_formatRelativeTime(activity.time)}</small></span>
      <span class="workbench-activity-status is-${status}">${_escapeWorkbenchHtml(activity.statusText)}</span>
      <i class="workbench-row-arrow" data-lucide="chevron-right"></i>
    </button>`;
  }).join('');
  if (window.lucide) lucide.createIcons();
}

function _renderSystemStatus(statuses) {
  const list = document.getElementById('systemStatusList');
  const badge = document.getElementById('systemStatusBadge');
  if (!list || !badge) return;
  list.innerHTML = statuses.map(status => `<div class="workbench-status-row">
    <span><i data-lucide="${_statusIcon(status.key)}"></i>${_escapeWorkbenchHtml(status.label)}</span>
    <strong class="is-${status.status}"><span></span>${_escapeWorkbenchHtml(status.text)}</strong>
  </div>`).join('');

  const hasError = statuses.some(status => status.status === 'error');
  const hasWarning = statuses.some(status => status.status === 'warn');
  const state = hasError ? 'error' : hasWarning ? 'warning' : 'ok';
  badge.className = `workbench-health is-${state}`;
  badge.innerHTML = `<span></span>${hasError ? '存在异常' : hasWarning ? '部分受限' : '运行正常'}`;
  if (window.lucide) lucide.createIcons();
}

function _statusIcon(key) {
  return { backend: 'server', ai: 'sparkles', database: 'database', collector: 'scan-line' }[key] || 'circle';
}

function _renderDashboardError() {
  document.querySelectorAll('[data-metric-value]').forEach(element => { element.textContent = '--'; });
  const activity = document.getElementById('activityList');
  if (activity) activity.innerHTML = '<div class="workbench-empty"><i data-lucide="wifi-off"></i><strong>数据加载失败</strong><span>请检查 ERP 后端服务</span></div>';
  const status = document.getElementById('systemStatusList');
  if (status) status.innerHTML = '<div class="workbench-status-error">无法获取服务状态</div>';
  if (window.lucide) lucide.createIcons();
}

function _formatRelativeTime(isoString) {
  if (!isoString) return '未知时间';
  const timestamp = new Date(isoString).getTime();
  if (!Number.isFinite(timestamp)) return '未知时间';
  const seconds = Math.max(0, Math.floor((Date.now() - timestamp) / 1000));
  if (seconds < 60) return '刚刚';
  if (seconds < 3600) return `${Math.floor(seconds / 60)} 分钟前`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)} 小时前`;
  if (seconds < 2592000) return `${Math.floor(seconds / 86400)} 天前`;
  return new Date(timestamp).toLocaleDateString('zh-CN');
}

function _escapeWorkbenchHtml(value) {
  return String(value || '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
}

Router.register('/home', renderHomePage);
