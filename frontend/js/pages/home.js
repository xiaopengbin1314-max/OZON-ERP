/**
 * 首页仪表盘 - Home Page
 * 完全对齐 TailAdmin 真实模板结构，使用真实 Tailwind 工具类
 * 统计卡（metric-group 真实结构）/ 主区域左7右5 / 生态插件
 * 数据来源：后端 /api/dashboard/stats 聚合接口（真实数据，非假数据）
 */

function renderHomePage(route) {
  // 生态插件配置数据（保留业务功能）
  const featureCards = [
    {
      id: 'premium',
      badgeColor: 'blue',
      badgeIcon: '💎',
      badgeText: 'Premium 会员插件',
      title: '高级 Premium 会员插件',
      subtitle: '解锁全部高级功能，享受无限制的商品采集、AI 撰写次数、优先客服支持等专属权益。',
      features: [
        '无限次商品采集与批量操作',
        'AI 撰写每日500次额度',
        '专属客户经理1对1服务',
        '数据导出与API接口权限',
        '多店铺统一管理',
        '优先体验新功能',
      ],
      primaryAction: { text: '开通会员', onClick: "Toast.show('会员功能开发中...', 'info')" },
      secondaryAction: { text: '查看权益', class: 'btn-ghost', icon: '', onClick: "Toast.show('权益详情页开发中...', 'info')" },
    },
    {
      id: 'collect',
      badgeColor: 'red',
      badgeIcon: '🛒',
      badgeText: '商品采集插件',
      title: '商品采集插件',
      subtitle: '一键采集 Ozon 全站商品，支持批量导入、智能去重、自动提取图片与属性信息。',
      features: [
        '支持 Ozon/Wildberries/1688 多平台',
        '批量 URL 导入快速采集',
        '自动识别商品SKU/价格/库存',
        '图片批量下载与管理',
        '多语言标题翻译',
        '实时监控价格变动',
      ],
      primaryAction: { text: '开始使用', onClick: "Router.navigate('/collect')" },
      secondaryAction: { text: '安装扩展', class: 'btn-success-outline', icon: '', onClick: "Toast.show('浏览器扩展已就绪，请在 Chrome 中加载', 'success')" },
    },
    {
      id: 'ai-write',
      badgeColor: 'purple',
      badgeIcon: '✨',
      badgeText: 'AI 撰写插件',
      title: 'AI 撰写插件',
      subtitle: '基于大语言模型的智能内容生成引擎，自动优化商品标题、描述、关键词，提升曝光率。',
      features: [
        'AI 标题生成与SEO优化',
        '多语言描述自动撰写',
        '关键词推荐与热度分析',
        'A/B 测试文案对比',
        '品牌语调定制',
        '一键批量处理',
      ],
      primaryAction: { text: '立即体验', onClick: "Router.navigate('/ai-write')" },
      secondaryAction: { text: '了解详情', class: 'btn-ghost', icon: '', onClick: "Modal.show({title:'AI撰写引擎',body:'<p>基于 GPT-4o 的电商文案生成引擎，专为跨境卖家优化。</p><ul style=\"list-style:disc;padding-left:20px;color:#6B7280;\"><li>支持俄语/英语/中文等12种语言</li><li>针对Ozon搜索算法深度优化</li><li>平均提升30%点击转化率</li></ul>'})" },
    },
  ];

  // 统计卡骨架（初始加载态，数据异步填充）
  const metrics = [
    { key: 'todayCollected', label: '今日采集', icon: 'package' },
    { key: 'pendingPublish', label: '待上架', icon: 'clock' },
    { key: 'published', label: '已上架', icon: 'check-circle' },
    { key: 'aiStatus', label: 'AI 引擎', icon: 'sparkles' },
  ];

  const html = `
    <!-- ===== 页面标题区 ===== -->
    <div class="mb-6 flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
      <div>
        <h1 class="text-[26px] font-bold leading-tight tracking-tight text-gray-800">工作台</h1>
        <p class="mt-1.5 text-sm text-gray-500">欢迎使用 GeekOzon ERP，一站式跨境电商运营平台</p>
      </div>
      <div class="flex items-center gap-2.5">
        <button onclick="Router.navigate('/collect')" class="inline-flex items-center gap-2 rounded-lg border border-gray-200 bg-white px-4 py-2 text-sm font-medium text-gray-700 transition hover:bg-gray-50">
          <i data-lucide="package" style="width:16px;height:16px;"></i>
          <span>新建采集</span>
        </button>
        <button onclick="Router.navigate('/publish')" class="inline-flex items-center gap-2 rounded-lg bg-brand-500 px-4 py-2 text-sm font-medium text-white shadow-theme-xs transition hover:bg-brand-600">
          <i data-lucide="upload-cloud" style="width:16px;height:16px;"></i>
          <span>批量上架</span>
        </button>
      </div>
    </div>

    <!-- ===== 统计卡组（TailAdmin metric-group 真实结构） ===== -->
    <div class="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4 md:gap-6 mb-6">
      ${metrics.map(m => `
        <div class="rounded-2xl border border-gray-200 bg-white p-5 transition hover:border-gray-300 hover:shadow-theme-md md:p-6">
          <div class="flex h-12 w-12 items-center justify-center rounded-xl bg-gray-100 text-gray-700">
            <i data-lucide="${m.icon}" style="width:24px;height:24px;"></i>
          </div>
          <div class="mt-5 flex items-end justify-between">
            <div>
              <span class="text-sm text-gray-500">${m.label}</span>
              <h4 class="mt-2 text-[26px] font-bold leading-tight tracking-tight text-gray-800" data-metric-value="${m.key}">
                <span class="text-gray-300">—</span>
              </h4>
            </div>
            <span data-metric-trend="${m.key}"></span>
          </div>
        </div>
      `).join('')}
    </div>

    <!-- ===== 主区域：左7 + 右5 ===== -->
    <div class="grid grid-cols-1 gap-5 xl:grid-cols-12 mb-8">
      <!-- 左侧 7 列：最近采集活动 -->
      <div class="xl:col-span-7 rounded-2xl border border-gray-200 bg-white shadow-theme-xs overflow-hidden">
        <div class="flex items-center justify-between px-5 py-4 border-b border-gray-100">
          <h3 class="text-base font-bold text-gray-800">最近采集活动</h3>
          <a href="#/collect" class="inline-flex items-center gap-1 text-sm font-medium text-brand-500 transition hover:opacity-75">
            查看全部
            <i data-lucide="arrow-right" style="width:14px;height:14px;"></i>
          </a>
        </div>
        <div id="activityList" class="flex flex-col">
          <div class="px-5 py-10 text-center text-sm text-gray-400">加载中...</div>
        </div>
      </div>

      <!-- 右侧 5 列：系统状态 + 公告 -->
      <div class="xl:col-span-5 flex flex-col gap-5">
        <!-- 系统状态卡 -->
        <div class="rounded-2xl border border-gray-200 bg-white shadow-theme-xs overflow-hidden">
          <div class="flex items-center justify-between px-5 py-4 border-b border-gray-100">
            <h3 class="text-base font-bold text-gray-800">系统状态</h3>
            <span id="systemStatusBadge" class="inline-flex items-center gap-1.5 rounded-full bg-gray-100 px-2.5 py-1 text-xs font-medium text-gray-500">
              <span class="h-1.5 w-1.5 rounded-full bg-gray-400"></span>
              检测中
            </span>
          </div>
          <div id="systemStatusList" class="flex flex-col">
            <div class="px-5 py-3.5 text-sm text-gray-400">加载中...</div>
          </div>
        </div>

        <!-- 公告面板（保留业务组件） -->
        <section id="noticeSection" class="rounded-2xl border border-gray-200 bg-white shadow-theme-xs overflow-hidden">
          ${NoticeList.render()}
        </section>
      </div>
    </div>

    <!-- ===== 生态插件区（保留业务组件） ===== -->
    <div>
      <div class="mb-5">
        <h2 class="text-xl font-bold text-gray-800">生态插件</h2>
        <p class="mt-1 text-sm text-gray-500">扩展 GeekOzon 能力，解锁更多高级功能</p>
      </div>
      <div class="cards-grid">
        ${featureCards.map(card => Card.createFeatureCard(card)).join('')}
        ${Card.createPlaceholderCard()}
      </div>
    </div>
  `;

  // 渲染后初始化图标
  setTimeout(() => { if (window.lucide) lucide.createIcons(); }, 50);

  // 异步加载工作台真实数据
  setTimeout(() => _loadDashboardData(), 200);

  // 异步加载公告数据
  setTimeout(async () => {
    try {
      const res = await Api.getNotices();
      if (res.code === 200 && res.data?.list) {
        const noticeSection = document.getElementById('noticeSection');
        if (noticeSection) {
          noticeSection.innerHTML = NoticeList.render(res.data.list);
          NoticeList.bindEvents(noticeSection);
          if (window.lucide) lucide.createIcons();
        }
      }
    } catch (e) {
      console.warn('[首页] 公告加载失败:', e);
    }
  }, 300);

  return html;
}

/**
 * 加载工作台真实数据并填充到 DOM
 */
async function _loadDashboardData() {
  try {
    const res = await Api.getDashboardStats();
    if (res.code !== 200 || !res.data) {
      _renderDashboardError();
      return;
    }
    _renderMetrics(res.data.metrics || []);
    _renderActivities(res.data.activities || []);
    _renderSystemStatus(res.data.systemStatus || []);
  } catch (e) {
    _renderDashboardError();
  }
}

/**
 * 渲染统计卡
 */
function _renderMetrics(metrics) {
  for (const m of metrics) {
    const valueEl = document.querySelector(`[data-metric-value="${m.key}"]`);
    const trendEl = document.querySelector(`[data-metric-trend="${m.key}"]`);
    if (!valueEl) continue;

    // AI 引擎卡片展示文本而非数字
    let displayValue;
    if (m.key === 'aiStatus') {
      displayValue = m.value ? (m.trendValue || '已配置') : '未配置';
    } else {
      const num = Number(m.value) || 0;
      displayValue = num.toLocaleString('zh-CN');
    }
    valueEl.innerHTML = `<span>${displayValue}</span>`;

    // 趋势胶囊（仅 AI 卡片展示提供商名称，其余展示 —）
    if (trendEl) {
      const trend = m.trend || 'flat';
      let trendValue = m.trendValue || '—';
      if (m.key === 'aiStatus') {
        trendValue = m.value ? '已就绪' : '未配置';
      }
      trendEl.innerHTML = _buildTrendHtml(trend, trendValue, m.key === 'aiStatus' && m.value);
    }
  }
  if (window.lucide) lucide.createIcons();
}

/**
 * 构建趋势胶囊 HTML
 */
function _buildTrendHtml(trend, trendValue, aiReady) {
  if (trend === 'up') {
    return `<span class="flex items-center gap-1 rounded-full bg-success-50 py-0.5 pl-2 pr-2.5 text-sm font-medium text-success-600">
      <i data-lucide="trending-up" style="width:12px;height:12px;"></i>${trendValue}
    </span>`;
  }
  if (trend === 'down') {
    return `<span class="flex items-center gap-1 rounded-full bg-error-50 py-0.5 pl-2 pr-2.5 text-sm font-medium text-error-600">
      <i data-lucide="trending-down" style="width:12px;height:12px;"></i>${trendValue}
    </span>`;
  }
  const cls = aiReady
    ? 'bg-success-50 text-success-600'
    : 'bg-gray-100 text-gray-500';
  return `<span class="flex items-center gap-1 rounded-full ${cls} py-0.5 pl-2 pr-2.5 text-sm font-medium">
    <i data-lucide="minus" style="width:12px;height:12px;"></i>${trendValue}
  </span>`;
}

/**
 * 渲染最近活动列表
 */
function _renderActivities(activities) {
  const list = document.getElementById('activityList');
  if (!list) return;

  if (!activities || activities.length === 0) {
    list.innerHTML = `<div class="px-5 py-10 text-center text-sm text-gray-400">暂无活动记录</div>`;
    return;
  }

  list.innerHTML = activities.map(a => {
    const iconCls = a.status === 'success'
      ? 'bg-success-50 text-success-600'
      : a.status === 'pending'
        ? 'bg-warning-50 text-warning-600'
        : 'bg-error-50 text-error-600';
    const statusCls = a.status === 'success'
      ? 'text-success-600'
      : a.status === 'pending'
        ? 'text-warning-600'
        : 'text-error-600';
    return `
    <div class="flex items-center gap-3.5 px-5 py-3.5 border-b border-gray-100 last:border-b-0 transition hover:bg-gray-50">
      <div class="flex h-9 w-9 items-center justify-center rounded-lg flex-shrink-0 ${iconCls}">
        <i data-lucide="${a.icon}" style="width:18px;height:18px;"></i>
      </div>
      <div class="flex-1 min-w-0">
        <div class="text-sm font-semibold text-gray-800 truncate">${a.name}</div>
        <div class="flex items-center gap-2 mt-1 text-xs text-gray-500">
          <span class="${statusCls} font-medium">${a.statusText}</span>
          <span>·</span>
          <span>${_formatRelativeTime(a.time)}</span>
        </div>
      </div>
    </div>`;
  }).join('');

  if (window.lucide) lucide.createIcons();
}

/**
 * 渲染系统状态列表
 */
function _renderSystemStatus(statuses) {
  const list = document.getElementById('systemStatusList');
  const badge = document.getElementById('systemStatusBadge');
  if (!list) return;

  list.innerHTML = statuses.map(s => {
    const dotCls = s.status === 'ok'
      ? 'bg-success-500'
      : s.status === 'warn'
        ? 'bg-warning-500'
        : 'bg-error-500';
    return `
    <div class="flex items-center justify-between px-5 py-3.5 border-b border-gray-100 last:border-b-0">
      <span class="text-sm font-medium text-gray-700">${s.label}</span>
      <span class="inline-flex items-center gap-1.5 text-sm text-gray-600">
        <span class="h-2 w-2 rounded-full ${dotCls}"></span>
        ${s.text}
      </span>
    </div>`;
  }).join('');

  // 更新顶部徽章
  if (badge) {
    const hasError = statuses.some(s => s.status === 'error');
    const hasWarn = statuses.some(s => s.status === 'warn');
    if (hasError) {
      badge.className = 'inline-flex items-center gap-1.5 rounded-full bg-error-50 px-2.5 py-1 text-xs font-medium text-error-700';
      badge.innerHTML = `<span class="h-1.5 w-1.5 rounded-full bg-error-500"></span>存在异常`;
    } else if (hasWarn) {
      badge.className = 'inline-flex items-center gap-1.5 rounded-full bg-warning-50 px-2.5 py-1 text-xs font-medium text-warning-700';
      badge.innerHTML = `<span class="h-1.5 w-1.5 rounded-full bg-warning-500"></span>部分受限`;
    } else {
      badge.className = 'inline-flex items-center gap-1.5 rounded-full bg-success-50 px-2.5 py-1 text-xs font-medium text-success-700';
      badge.innerHTML = `<span class="h-1.5 w-1.5 rounded-full bg-success-500"></span>全部正常`;
    }
  }
}

/**
 * 数据加载失败时的降级展示
 */
function _renderDashboardError() {
  const list = document.getElementById('activityList');
  if (list) list.innerHTML = `<div class="px-5 py-10 text-center text-sm text-gray-400">数据加载失败，请检查后端服务</div>`;
  const valueEls = document.querySelectorAll('[data-metric-value]');
  valueEls.forEach(el => { el.innerHTML = `<span class="text-gray-300">—</span>`; });
  const statusList = document.getElementById('systemStatusList');
  if (statusList) statusList.innerHTML = `<div class="px-5 py-3.5 text-sm text-gray-400">状态获取失败</div>`;
}

/**
 * 将 ISO 时间字符串格式化为相对时间（如 "2 分钟前"）
 */
function _formatRelativeTime(isoString) {
  if (!isoString) return '';
  try {
    const date = new Date(isoString);
    const now = new Date();
    const diff = Math.floor((now - date) / 1000);
    if (diff < 60) return '刚刚';
    if (diff < 3600) return `${Math.floor(diff / 60)} 分钟前`;
    if (diff < 86400) return `${Math.floor(diff / 3600)} 小时前`;
    if (diff < 2592000) return `${Math.floor(diff / 86400)} 天前`;
    return date.toLocaleDateString('zh-CN');
  } catch (e) {
    return '';
  }
}

// 注册路由
Router.register('/home', renderHomePage);
