/**
 * 商品采集页 - Collect Page（表格布局版）
 * 支持手动输入URL采集、表格化查看已采集商品列表
 */

/** HTML属性转义（用于 src="..." 等属性值） */
function escapeAttr(str) {
  if (!str) return '';
  return String(str).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** HTML文本转义（用于标签内容） */
function escapeHtml(str) {
  if (!str) return '';
  return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/**
 * 将外部图片URL转换为后端代理URL，解决1688/淘宝等防盗链问题
 * data: 开头的 base64 图片不转换
 */
function proxyImage(url) {
  if (!url) return '';
  if (url.startsWith('data:') || url.startsWith('/api/')) return url;
  // 已经是代理URL则不重复转换
  if (url.includes('/api/image_proxy?')) return url;
  return '/api/image_proxy?url=' + encodeURIComponent(url);
}

function renderCollectPage(route) {
  return `
    <div style="animation: pageEnter 0.35s ease;">
      <!-- 页面标题 -->
      <div class="collect-page-header">
        <div>
          <h2 class="collect-page-title">商品采集</h2>
          <p class="collect-page-desc">从 Ozon 等平台快速采集商品数据</p>
        </div>
        <button class="btn btn-primary btn-sm" onclick="showAddProductDialog()">
          <i data-lucide="plus" style="width:14px;height:14px;"></i> 手动添加
        </button>
      </div>

      <!-- Tab 筛选栏 -->
      <div class="collect-tabs" id="collectTabs">
        <button class="collect-tab active" data-status="" onclick="switchCollectTab(this)">全部<span class="tab-count" id="tabCountAll"></span></button>
        <button class="collect-tab" data-status="unpublished" onclick="switchCollectTab(this)">未发布<span class="tab-count" id="tabCountUnpublished"></span></button>
        <button class="collect-tab" data-status="scheduled" onclick="switchCollectTab(this)">定时发布<span class="tab-count" id="tabCountScheduled"></span></button>
        <button class="collect-tab" data-status="published" onclick="switchCollectTab(this)">已发布<span class="tab-count" id="tabCountPublished"></span></button>
      </div>


      <!-- 表格区域 -->
      <div class="collect-table-wrap">
        <table class="collect-table" id="collectTable">
          <thead>
            <tr>
              <th><input type="checkbox" class="table-check-all" onclick="toggleSelectAll(this)"></th>
              <th>产品信息</th>
              <th>分组</th>
              <th>类目</th>
              <th>售价</th>
              <th>发布店铺</th>
              <th>货源价格</th>
              <th>所属人员</th>
              <th>认领时间</th>
              <th>备注</th>
              <th>操作</th>
            </tr>
          </thead>
          <tbody id="collectTableBody">
            <!-- 动态渲染 -->
          </tbody>
        </table>

        <!-- 空状态 -->
        <div class="empty-state" id="emptyState" style="display:none;">
          <div class="empty-icon">&#128230;</div>
          <p>暂无采集的商品</p>
          <p style="font-size:12px;margin-top:4px;">通过上方输入框添加链接或使用浏览器扩展采集</p>
        </div>
      </div>

      <!-- 底部分页/批量操作栏 -->
      <div class="collect-footer-bar" id="collectFooterBar" style="display:none;">
        <div class="collect-footer-left">
          <span class="select-info">已选 <strong id="selectedCount">0</strong> 条</span>
          <button class="btn btn-sm btn-ghost" onclick="batchPublish()">批量发布</button>
          <button class="btn btn-sm btn-ghost" onclick="batchDelete()">批量删除</button>
        </div>
        <div class="collect-footer-right">
          <span class="total-info">共 <strong id="totalCount">0</strong> 条数据</span>
        </div>
      </div>
    </div>
  `;
}

/** 当前筛选状态 */
let currentStatusFilter = '';
let allProducts = [];

/** 已同步商品ID集合：保存后标记，再次编辑时跳过后端拉取；loadProducts 刷新时清空 */
const _syncedProductIds = new Set();

/** 类目属性结构缓存：按 typeId 缓存，避免每次打开编辑都重新拉取；切换新类目时才拉取 */
const _categoryAttrCache = new Map();

/** 切换Tab */
function switchCollectTab(el) {
  document.querySelectorAll('.collect-tab').forEach(t => t.classList.remove('active'));
  el.classList.add('active');
  currentStatusFilter = el.dataset.status;
  loadProducts();
}

/** 更新 Tab 数量统计 */
function updateTabCounts() {
  // 先用本地数据快速更新，再异步获取准确统计
  const total = allProducts.length;
  const unpublished = allProducts.filter(p => p.status === 'unpublished').length;
  const scheduled = allProducts.filter(p => p.status === 'scheduled').length;
  const published = allProducts.filter(p => p.status === 'published').length;

  const setCount = (id, count) => {
    const el = document.getElementById(id);
    if (el) el.textContent = `(${count})`;
  };
  setCount('tabCountAll', total);
  setCount('tabCountUnpublished', unpublished);
  setCount('tabCountScheduled', scheduled);
  setCount('tabCountPublished', published);

  // 异步从后端获取准确统计
  Api.getProductStats().then(res => {
    if (res.code === 200 && res.data?.stats) {
      const stats = res.data.stats;
      setCount('tabCountAll', res.data.total || 0);
      setCount('tabCountUnpublished', stats.unpublished || 0);
      setCount('tabCountScheduled', stats.scheduled || 0);
      setCount('tabCountPublished', stats.published || 0);
    }
  }).catch(() => {});
}

/** 渲染表格 */
function loadProducts() {
  const tbody = document.getElementById('collectTableBody');
  const emptyEl = document.getElementById('emptyState');
  const footerBar = document.getElementById('collectFooterBar');

  // 从后端 API 加载数据
  Api.getProducts({ status: currentStatusFilter, pageSize: 200 }).then(res => {
    let products;
    if (res.code === 200 && res.data?.list) {
      products = res.data.list;
    } else if (res.code === -2) {
      // 后端未启动
      products = [];
    } else {
      products = [];
    }

    allProducts = products;
    // 列表刷新后数据来源已是最新的，清空已同步标记，确保下次编辑时重新拉取
    _syncedProductIds.clear();

    if (products.length === 0) {
      tbody.innerHTML = '';
      if (emptyEl) emptyEl.style.display = 'flex';
      if (footerBar) footerBar.style.display = 'none';
      updateTabCounts();
      return;
    }

    if (emptyEl) emptyEl.style.display = 'none';
    if (footerBar) footerBar.style.display = 'flex';

    renderTable();
    updateTabCounts();

    if (window.lucide) lucide.createIcons();
  }).catch(err => {
    console.error('[Collect] 加载商品失败:', err);
    allProducts = [];
    renderTable();
    updateTabCounts();
  });
}

function renderTable() {
  const tbody = document.getElementById('collectTableBody');
  const totalEl = document.getElementById('totalCount');

  let filtered = allProducts;
  if (currentStatusFilter) {
    filtered = allProducts.filter(p => p.status === currentStatusFilter);
  }

  if (totalEl) totalEl.textContent = filtered.length;

  if (filtered.length === 0) {
    tbody.innerHTML = `<tr><td colspan="11" class="table-empty-row">暂无符合条件的数据</td></tr>`;
    return;
  }

  tbody.innerHTML = filtered.map(p => `
    <tr data-id="${p.id}">
      <td><input type="checkbox" class="table-check-item" value="${p.id}"></td>
      <td>
        <div class="product-info-cell">
          <img class="product-thumb" src="${escapeAttr(proxyImage(p.images?.[0] || ''))}" alt="" loading="lazy" referrerpolicy="no-referrer"
               onerror="this.onerror=null;this.src='data:image/svg+xml,%3Csvg xmlns=%22http://www.w3.org/2000/svg%22 width=%2260%22 height=%2260%22%3E%3Crect width=%22100%25%22 height=%22100%25%22 fill=%22%23f5f5f5%22/%3E%3Ctext x=%2250%25%22 y=%2255%25%22 text-anchor=%22middle%22 fill=%22%23ccc%22 font-size=%2211%22%3E无图%3C/text%3E%3C/svg%3E'">
          <div class="product-text">
            <div class="product-name">${escapeHtml(p.title || '')}</div>
            <div class="product-source-row">
              <button class="source-search-btn" onclick="search1688('${p.id}')">搜1688同款</button>
              <span class="source-link-text">
                货源：<span class="source-id">${escapeHtml(p.sourceId ? (p.sourceId.startsWith('(') ? p.sourceId : '(' + p.sourceId + ')') : '-')}</span>
                ${p.sourceLink && p.sourceLink !== '#' ? '<span class="source-link-wrap" style="position:relative;display:inline-block;">' +
                  '<a class="source-link" href="' + escapeAttr(p.sourceLink) + '" target="_blank">' + escapeHtml(p.sourceName || '1688分销') + ' +</a>' +
                  '<div class="source-popover">' +
                    '<span class="source-popover-label">' + escapeHtml(p.sourceName || '1688分销') + '</span>' +
                    '<a class="source-popover-url" href="' + escapeAttr(p.sourceLink) + '" target="_blank">' + escapeHtml(p.sourceLink) + '</a>' +
                  '</div>' +
                '</span>' : ''}
              </span>
            </div>
          </div>
        </div>
      </td>
      <td><span class="group-badge">${escapeHtml(p.group || '未分组')}</span></td>
      <td>${renderCategoryCell(p)}</td>
      <td class="price-cell">${getCurrencySymbol(p.currency || 'RUB')}${(p.price || 0).toLocaleString()}</td>
      <td><span class="store-badge">${escapeHtml(p.store || 'Ozon')}</span></td>
      <td class="source-price-cell">${p.sourcePrice ? getSourcePriceSymbol(p.platform) + p.sourcePrice.toLocaleString() : '-'}</td>
      <td>${p.assignee ? escapeHtml(p.assignee) : '<span class="unassigned">未认领</span>'}</td>
      <td class="time-cell">${formatTime(p.claimedAt || p.createdAt)}</td>
      <td class="note-cell"><span class="note-text" title="${escapeAttr(p.note || '')}">${escapeHtml(p.note || '-')}</span></td>
      <td>
        <div class="action-btns">
          ${renderPublishStatusBadge(p)}
          <button class="action-link" onclick="aiOptimize('${p.id}')" title="AI优化">AI优化</button>
          <button class="action-link" onclick="editProduct('${p.id}')" title="编辑">编辑</button>
          <button class="action-link" onclick="publishProduct('${p.id}')" title="发布">发布</button>
          <button class="action-link danger" onclick="deleteProduct('${p.id}')" title="删除">删除</button>
          <button class="action-link note-action" onclick="addNote('${p.id}')" title="备注">备注</button>
        </div>
      </td>
    </tr>
  `).join('');

  // 更新全选框状态
  updateSelectState();

  // 绑定 1688分销+ 悬浮弹窗事件
  bindSourcePopoverEvents();
}

/** 渲染发布状态小徽章（在操作列中显示，点击跳转到上架记录页） */
function renderPublishStatusBadge(p) {
  const s = p.publishStatus;
  if (!s || s === 'pending') return '';
  const map = {
    processing: { text: '发布中', cls: 'pub-badge-processing' },
    published: { text: '已发布', cls: 'pub-badge-published' },
    published_with_errors: { text: '有警告', cls: 'pub-badge-warning' },
    failed: { text: '失败', cls: 'pub-badge-failed' },
    skipped: { text: '已跳过', cls: 'pub-badge-skipped' },
  };
  const info = map[s];
  if (!info) return '';
  return `<a href="#/publish" class="pub-badge ${info.cls}" style="display:inline-block;padding:1px 6px;border-radius:8px;font-size:11px;margin-right:4px;cursor:pointer;text-decoration:none;" onclick="event.stopPropagation()">${info.text}</a>`;
}

/** 渲染类目列（含匹配状态标识） */
function renderCategoryCell(p) {
  const cm = p.categoryMatch;
  const sourceCat = p.category || '';

  // 有匹配结果
  if (cm && cm.matched) {
    const confidenceClass = cm.confidence === 'high' ? 'cat-match-high' : 'cat-match-medium';
    const confidenceText = cm.confidence === 'high' ? '高' : '中';
    return `<div class="category-cell">
      <div class="category-matched ${confidenceClass}" title="匹配置信度: ${confidenceText}&#10;原始分类: ${sourceCat}&#10;Ozon类目: ${cm.label}">
        <span class="cat-match-icon"></span>
        <span class="cat-ozon-name">${cm.label}</span>
      </div>
      ${sourceCat && sourceCat !== cm.label ? `<div class="cat-source-name" title="原始分类">${sourceCat}</div>` : ''}
    </div>`;
  }

  // 有匹配结果但未匹配成功（有候选）
  if (cm && !cm.matched && cm.candidates && cm.candidates.length > 0) {
    return `<div class="category-cell">
      <div class="category-unmatched" title="未自动匹配&#10;原始分类: ${sourceCat}&#10;点击编辑手动选择类目">
        <span class="cat-unmatch-icon"></span>
        <span class="cat-source-text">${sourceCat || '未分类'}</span>
      </div>
    </div>`;
  }

  // 无匹配结果
  if (sourceCat) {
    return `<div class="category-cell">
      <div class="category-pending" title="尚未匹配Ozon类目&#10;原始分类: ${sourceCat}">
        <span class="cat-pending-icon"></span>
        <span class="cat-source-text">${sourceCat}</span>
      </div>
    </div>`;
  }

  return `<span class="category-text">-</span>`;
}

/** 全选/取消全选 */
function toggleSelectAll(el) {
  const items = document.querySelectorAll('.table-check-item');
  items.forEach(item => item.checked = el.checked);
  updateSelectState();
}

/** 更新选中状态 */
function updateSelectState() {
  const items = document.querySelectorAll('.table-check-item:checked');
  const countEl = document.getElementById('selectedCount');
  if (countEl) countEl.textContent = items.length;
}

/** 绑定 1688分销+ 悬浮弹窗事件 */
let _activeSourcePopover = null;
let _sourcePopoverTimer = null;

function bindSourcePopoverEvents() {
  var wraps = document.querySelectorAll('.source-link-wrap');
  wraps.forEach(function (wrap) {
    var popover = wrap.querySelector('.source-popover');
    if (!popover) return;

    wrap.addEventListener('mouseenter', function () {
      clearTimeout(_sourcePopoverTimer);
      // 关闭其他已打开的弹窗
      if (_activeSourcePopover && _activeSourcePopover !== popover) {
        _activeSourcePopover.style.display = 'none';
      }
      // 计算位置（fixed 定位，不受 overflow 裁剪）
      var rect = wrap.getBoundingClientRect();
      popover.style.display = 'block';
      popover.style.top = (rect.bottom + 6) + 'px';
      // 居中对齐：弹窗中心 = 触发元素中心
      var popWidth = popover.offsetWidth;
      var centerLeft = rect.left + rect.width / 2 - popWidth / 2;
      // 确保不超出左右边界
      if (centerLeft < 10) centerLeft = 10;
      if (centerLeft + popWidth > window.innerWidth - 10) {
        centerLeft = window.innerWidth - popWidth - 10;
      }
      popover.style.left = centerLeft + 'px';
      // 更新箭头位置：指向触发元素中心
      var arrowLeft = rect.left + rect.width / 2 - centerLeft - 5;
      popover.style.setProperty('--arrow-left', arrowLeft + 'px');
      _activeSourcePopover = popover;
    });

    wrap.addEventListener('mouseleave', function () {
      _sourcePopoverTimer = setTimeout(function () {
        popover.style.display = 'none';
        if (_activeSourcePopover === popover) _activeSourcePopover = null;
      }, 200);
    });

    // 鼠标移入弹窗本身时不关闭
    popover.addEventListener('mouseenter', function () {
      clearTimeout(_sourcePopoverTimer);
    });
    popover.addEventListener('mouseleave', function () {
      _sourcePopoverTimer = setTimeout(function () {
        popover.style.display = 'none';
        if (_activeSourcePopover === popover) _activeSourcePopover = null;
      }, 200);
    });
  });
}

/** 处理采集操作 */
async function handleCollect() {
  const input = document.getElementById('urlInput');
  const urls = input.value.trim().split('\n').filter(u => u.trim());

  if (urls.length === 0) {
    Toast.show('请输入至少一个商品链接', 'warning');
    return;
  }

  Toast.show(`正在采集 ${urls.length} 个商品...`, 'info');

  for (const url of urls) {
    await Api.collectProduct({
      url: url,
      platform: 'ozon',
      title: `Ozon 商品 #${Math.random().toString(36).slice(2, 8).toUpperCase()}`,
      price: Math.floor(Math.random() * 10000) + 100,
      images: [],
    });
  }

  Toast.show(`成功采集 ${urls.length} 个商品`, 'success');
  input.value = '';
  loadProducts();
}

/** 手动添加 - 直接创建占位商品并进入编辑界面 */
async function showAddProductDialog() {
  Toast.show('正在创建新商品…', 'info');

  // platform=manual 后端会跳过类目自动匹配，立即返回，避免 90s 等待
  const resp = await Api.collectProduct({ title: '新建商品', platform: 'manual' });
  if (resp.code !== 200 || !resp.data?.id) {
    Toast.show('创建失败：' + (resp.msg || '未知错误'), 'error');
    return;
  }

  const newId = resp.data.id;

  // 将新商品并入 allProducts（若已存在则替换，保证 editProduct 能找到）
  const idx = allProducts.findIndex(p => p.id === newId);
  if (idx >= 0) {
    allProducts[idx] = resp.data;
  } else {
    allProducts.unshift(resp.data);
  }

  // 立即刷新表格显示新商品，避免用户关闭弹窗后表格未更新
  renderTable();
  updateTabCounts();

  // 直接打开编辑界面（已确认是最新数据，跳过 Api.getProduct 拉取）
  editProduct(newId, { skipFetch: true });

  // 延迟聚焦标题输入框并全选，方便用户直接覆盖"新建商品"默认值
  setTimeout(() => {
    const titleInput = document.getElementById('editTitle');
    if (titleInput) {
      titleInput.focus();
      titleInput.select();
    }
  }, 300);
}

/** 编辑商品 - 全屏Tab编辑弹窗
 * 进入前先从后端拉取最新数据，避免内存快照过期被覆盖
 * @param {string} id - 商品ID
 * @param {object} [opts] - { skipFetch?: boolean } 跳过后端拉取（已确认是最新数据时使用）
 */
async function editProduct(id, opts = {}) {
  let product = allProducts.find(p => p.id === id);
  if (!product) {
    Toast.show('未找到商品', 'error');
    return;
  }

  // 仅在首次编辑（未在 _syncedProductIds 中）时从后端拉取最新数据
  // 保存成功后 ID 会被加入 _syncedProductIds，再次编辑时跳过拉取，避免覆盖用户已保存的修改
  // loadProducts 刷新列表时会清空 _syncedProductIds，确保数据不会无限期过期
  if (!opts.skipFetch && !_syncedProductIds.has(id)) {
    console.log('[编辑商品] 首次编辑，从后端拉取最新数据:', { id, syncedCount: _syncedProductIds.size });
    try {
      const resp = await Api.getProduct(id);
      if (resp.code === 200 && resp.data) {
        // 以后端返回的最新数据为准（包括 _cleaned 标记）
        // 注意：不能保留内存中旧的 _cleaned，否则1688重新采集后端重置为 false 时
        // 前端仍会用旧值 true，导致清洗逻辑被跳过
        product = Object.assign({}, resp.data);
        // 标记为已同步，再次编辑时无需重复拉取
        _syncedProductIds.add(id);
        // 同步回 allProducts
        const idx = allProducts.findIndex(p => p.id === id);
        if (idx >= 0) allProducts[idx] = product;
      }
    } catch (e) {
      console.warn('[editProduct] 拉取后端最新数据失败，使用内存快照:', e);
    }
  } else {
    console.log('[编辑商品] 跳过后端拉取（已同步或skipFetch）:', { id, skipFetch: opts.skipFetch, alreadySynced: _syncedProductIds.has(id) });
  }

  // === 标准化 attributes 字段格式 ===
  // 采集侧的 attributes 可能是：对象 {color:'черный'} / Ozon 原生 [{key:'4497', value:'200'}] / 已标准 [{id, value}]
  // 统一转成 [{id|name, value, dictionary_value_id?}] 数组，否则 fillAttributeValues 的 forEach 会失败
  product.attributes = normalizeCollectedAttributes(product.attributes);

  // Ozon may return product color (10096) as one collection value with nested
  // dictionary IDs. The SKU editor expects one scalar color per SKU; keeping
  // the nested shape causes an empty color control and broken combinations.
  normalizeCollectedOzonColorData(product);

  // === 数据清洗：1688采集数据自动清洗并填充缺失字段 ===
  if (product.platform === '1688' && !product._cleaned) {
    try {
      const cleaned = ProductMapping.cleanProductData(product);
      // 标题清洗：去除公司名后缀（仅当原标题未手动编辑过时）
      if (product.title && cleaned.title && product.title !== cleaned.title) {
        product.title = cleaned.title;
      }
      // 描述清洗：去HTML标签
      if (!product.description && cleaned.description) {
        product.description = cleaned.description;
      }
      // 图片清洗：去重、URL标准化
      if (cleaned.images && cleaned.images.length > 0) {
        product.images = cleaned.images;
      }
      if (cleaned.detailImages && cleaned.detailImages.length > 0 && (!product.detailImages || product.detailImages.length === 0)) {
        product.detailImages = cleaned.detailImages;
      }
      // 重量尺寸：仅填充缺失字段
      if (!product.weight && cleaned.weight) product.weight = cleaned.weight;
      if (!product.length && cleaned.length) product.length = cleaned.length;
      if (!product.width && cleaned.width) product.width = cleaned.width;
      if (!product.height && cleaned.height) product.height = cleaned.height;
      // 合并编号
      if (!product.mergeCode && cleaned.mergeCode) product.mergeCode = cleaned.mergeCode;
      // 品牌
      if (!product.brand && cleaned.brand) product.brand = cleaned.brand;
      // 价格：仅当计算出有效建议售价时填充
      if (!product.sourcePrice && cleaned.sourcePrice) product.sourcePrice = cleaned.sourcePrice;
      // 1688商品的price字段原始值是货源价（成本），不是售价。
      // 当price为空或等于货源价时，用建议售价覆盖，避免货源价被当作售价发布到Ozon。
      if (cleaned.price && (!product.price || parseFloat(product.price) === parseFloat(cleaned.sourcePrice))) {
        product.price = cleaned.price;
      }
      if (!product.oldPrice && cleaned.oldPrice) product.oldPrice = cleaned.oldPrice;
      // 货源链接初始化
      if ((!product.sourceLinks || product.sourceLinks.length === 0) && cleaned.sourceLinks.length > 0) {
        product.sourceLinks = cleaned.sourceLinks;
      }
      // SKU属性初始化（仅当没有已保存的skuAttrs时）
      if ((!product.skuAttrs || product.skuAttrs.length === 0) && cleaned.skuAttrs.length > 0) {
        product.skuAttrs = cleaned.skuAttrs;
      }
      // SKU行数据初始化（仅当没有已保存的skus时）
      if ((!product.skus || product.skus.length === 0) && cleaned.skus && cleaned.skus.length > 0) {
        product.skus = cleaned.skus;
      }
      // 类目属性：保留已存在的Ozon属性
      if ((!product.attributes || product.attributes.length === 0) && cleaned.attributes && cleaned.attributes.length > 0) {
        product.attributes = cleaned.attributes;
      }
      // 标记已清洗，避免重复处理
      product._cleaned = true;
      console.log('[数据清洗] 1688数据清洗完成:', {
        title: !!product.title,
        description: !!product.description,
        detailImages: product.detailImages?.length || 0,
        images: product.images?.length || 0,
        weight: product.weight,
        dimensions: `${product.length}x${product.width}x${product.height}`,
        mergeCode: product.mergeCode,
        brand: product.brand,
        price: product.price,
        sourcePrice: product.sourcePrice,
        skuAttrs: product.skuAttrs?.length || 0,
        skus: product.skus?.length || 0,
        attributes: product.attributes?.length || 0,
      });
    } catch (e) {
      console.warn('数据清洗失败:', e);
    }
  }

  // 保存当前编辑的商品引用，供SKU表格获取店铺币种等使用
  window._editingProduct = product;
  // 恢复已保存的销售属性
  window._skuAttrs = product.skuAttrs && Array.isArray(product.skuAttrs) ? JSON.parse(JSON.stringify(product.skuAttrs)) : [];
  // 重置SKU图片数据（generateSkuTable 会从 product.skus 回填）
  window._skuImages = {};
  // 编辑会话 ID，用于异步回调判断是否仍是当前会话（防止旧会话污染新会话）
  const editSessionId = `${id}_${Date.now()}`;
  window._editSessionId = editSessionId;
  console.log('[editProduct] SKU数据加载:', {
    'product.skuAttrs': product.skuAttrs?.length || 0,
    'product.skus': product.skus?.length || 0,
    'window._skuAttrs': window._skuAttrs.length,
    'window._editingProduct.skus': window._editingProduct.skus?.length || 0,
    skuAttrsDetail: window._skuAttrs.map(a => ({ name: a.name, attrId: a.attrId, valuesCount: a.values?.length || 0, skuType: a.skuType })),
  });
  // 初始化货源链接列表：若 sourceLinks 为空但 sourceLink/originalUrl 存在，则从其初始化
  if ((!product.sourceLinks || product.sourceLinks.length === 0) && (product.sourceLink || product.originalUrl)) {
    product.sourceLinks = [{
      remark: product.sourceName || '1688分销',
      url: product.sourceLink || product.originalUrl || '',
    }];
  }
  // 恢复已保存的类目ID（优先使用手动指定的，其次使用自动匹配的）
  if (product.descriptionCategoryId && product.typeId) {
    window._selectedCategory = {
      description_category_id: product.descriptionCategoryId,
      type_id: product.typeId,
      label: product.categoryMatch?.label || product.category || '',
    };
  } else if (product.categoryMatch && product.categoryMatch.matched) {
    // 自动匹配成功但尚未保存到 descriptionCategoryId
    window._selectedCategory = {
      description_category_id: product.categoryMatch.description_category_id,
      type_id: product.categoryMatch.type_id,
      label: product.categoryMatch.label || '',
    };
  } else {
    window._selectedCategory = null;
  }
  // 异步加载店铺列表以获取币种配置
  loadStoresForCurrency();

  // 记录打开时的快照，用于 dirty 检测
  window._editFormInitialSnapshot = _captureEditFormSnapshot(product);

  Modal.show({
    title: '编辑商品',
    size: 'xl',
    beforeClose: _confirmDiscardIfDirty,
    body: `
      <div class="edit-product-layout${!window._selectedCategory ? ' cat-step-pending' : ''}">
        <!-- 左侧：产品列表 -->
        <div class="edit-sidebar" id="editSidebar">
          <div class="edit-sidebar-header">产品列表 (${allProducts.length})</div>
          <div class="edit-sidebar-list" id="editSidebarList">
            ${allProducts.map((p, i) => `
              <div class="edit-sidebar-item${p.id === id ? ' active' : ''}" data-id="${p.id}" onclick="switchEditProduct('${p.id}')">
                <img class="edit-sidebar-thumb" src="${escapeAttr(proxyImage(p.images?.[0] || ''))}" alt="" loading="lazy" referrerpolicy="no-referrer"
                     onerror="this.onerror=null;this.src='data:image/svg+xml,%3Csvg xmlns=%22http://www.w3.org/2000/svg%22 width=%2260%22 height=%2260%22%3E%3Crect width=%22100%25%22 height=%22100%25%22 fill=%22%23f5f5f5%22/%3E%3Ctext x=%2250%25%22 y=%2255%25%22 text-anchor=%22middle%22 fill=%22%23ccc%22 font-size=%2211%22%3E无图%3C/text%3E%3C/svg%3E'">
                <div class="edit-sidebar-text">
                  <div class="edit-sidebar-title">${escapeHtml((p.title || '').slice(0, 40))}${(p.title || '').length > 40 ? '...' : ''}</div>
                  <div class="edit-sidebar-source" title="${escapeAttr(p.sourceLink || p.sourceName || p.sourceId || '')}">
                    <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="#6366F1" stroke="none"><path d="M6 2L3 6v14a2 2 0 002 2h14a2 2 0 002-2V6l-3-4H6zm3 19a1.5 1.5 0 110-3 1.5 1.5 0 010 3zm8 0a1.5 1.5 0 110-3 1.5 1.5 0 010 3zM9 2h6v4H9V2z"/></svg>
                    ${p.sourceLink && p.sourceLink !== '#' ? '<span class="source-link-wrap" style="position:relative;display:inline-block;vertical-align:middle;">' +
                      '<a class="source-link" href="' + escapeAttr(p.sourceLink) + '" target="_blank" style="color:inherit;">' + escapeHtml(p.sourceId ? (p.sourceId.startsWith('(') ? p.sourceId : '(' + p.sourceId + ')') : (p.sourceName || '-')) + '</a>' +
                      '<div class="source-popover">' +
                        '<span class="source-popover-label">' + escapeHtml(p.sourceName || '1688分销') + '</span>' +
                        '<a class="source-popover-url" href="' + escapeAttr(p.sourceLink) + '" target="_blank">' + escapeHtml(p.sourceLink) + '</a>' +
                      '</div>' +
                    '</span>' : escapeHtml(p.sourceId ? (p.sourceId.startsWith('(') ? p.sourceId : '(' + p.sourceId + ')') : (p.sourceName || '-'))}
                  </div>
                </div>
              </div>
            `).join('')}
          </div>
        </div>

        <!-- 右侧：锚点菜单 + 滚动编辑区 -->
        <div class="edit-main">
          <ul class="scroll-menu-nav" id="editAnchorMenu">
            <li class="scroll-menu-nav__item is-active" data-section="basic" onclick="scrollToSection('basic')"><div>基本信息</div></li>
            <li class="scroll-menu-nav__item" data-section="category" onclick="scrollToSection('category')"><div>类目&属性</div></li>
            <li class="scroll-menu-nav__item" data-section="images" onclick="scrollToSection('images')"><div>产品图片</div></li>
            <li class="scroll-menu-nav__item" data-section="video" onclick="scrollToSection('video')"><div>产品视频</div></li>
            <li class="scroll-menu-nav__item" data-section="other" onclick="scrollToSection('other')"><div>其他信息</div></li>
            <li class="scroll-menu-nav__item" data-section="source" onclick="scrollToSection('source')"><div>货源链接</div></li>
          </ul>

          <div class="edit-content" id="editContent">

            <!-- 基本信息 -->
            <div class="edit-panel" data-panel="basic" id="section-basic">
              <div class="edit-panel-box">

              <!-- 产品标题 -->
              <div class="jx-form-item asterisk-left jx-form-item--label-top">
                <label class="jx-form-item__label">
                  <span>产品标题</span>
                  <button type="button" class="pro-button-ai label-operator" onclick="aiGenerateField('title')">
                    <i data-lucide="sparkles" style="width:14px;height:14px;"></i>AI生成
                  </button>
                  <button type="button" class="pro-button-plain" onclick="document.getElementById('editTitle').value='';updateTitleCount()">重置标题</button>
                </label>
                <div class="jx-form-item__content">
                  <div class="chat-gpt-panel is-title">
                    <div class="jx-input jx-input--small jx-input--suffix pro-input">
                      <div class="jx-input__wrapper">
                        <input class="jx-input__inner" type="text" maxlength="200" id="editTitle" oninput="updateTitleCount()" value="${escapeAttr(product.title || '')}" placeholder="">
                        <span class="jx-input__suffix">
                          <span class="jx-input__suffix-inner">
                            <a href="javascript:;" class="jx-link upper-first-tag" onclick="toUpperCaseFirst()" title="首字母大写">Abc</a>
                            <div class="jx-divider jx-divider--vertical word-limit-divider"></div>
                            <span class="jx-input__count"><span class="jx-input__count-inner" id="titleCount">${(product.title || '').length} / 200</span></span>
                          </span>
                        </span>
                      </div>
                    </div>
                    <div>
                      <div class="tips-box">1、每个SKU优先使用SKU标题(可在SKU列表模块进行维护)，当无SKU标题时，则使用SPU标题</div>
                      <div class="tips-box">2、若不设置标题，Ozon官方会根据产品信息自动生成标题</div>
                    </div>
                  </div>
                </div>
              </div>

              <!-- 简介（Аннотация）：作为通用属性，由类目属性加载时自动适配 -->
              <div id="annotationAttr"></div>

              <!-- JSON富内容（Rich-контент JSON）：作为通用属性，由类目属性加载时自动适配 -->
              <div id="richContentAttr"></div>

              <!-- 型号名称类目属性：作为通用属性，由类目属性加载时自动适配 -->
              <div id="modelAttr"></div>

              <!-- VAT增值税 -->
              <div class="jx-form-item asterisk-left jx-form-item--label-top is-required">
                <label class="jx-form-item__label"><span>VAT增值税</span></label>
                <div class="jx-form-item__content">
                  <div class="pro-radio-group is-horizontal">
                    <div class="jx-radio-group" id="vatRadioGroup">
                      <label class="jx-radio jx-radio--small${!product.vatRate || product.vatRate === '' ? ' is-checked' : ''}">
                        <span class="jx-radio__input${!product.vatRate || product.vatRate === '' ? ' is-checked' : ''}">
                          <input class="jx-radio__original" name="vatRate" type="radio" value="" ${!product.vatRate || product.vatRate === '' ? 'checked' : ''} onchange="updateVatRadio(this)">
                          <span class="jx-radio__inner"></span>
                        </span>
                        <span class="jx-radio__label">豁免</span>
                      </label>
                      <label class="jx-radio jx-radio--small${product.vatRate === '10' ? ' is-checked' : ''}">
                        <span class="jx-radio__input${product.vatRate === '10' ? ' is-checked' : ''}">
                          <input class="jx-radio__original" name="vatRate" type="radio" value="10" ${product.vatRate === '10' ? 'checked' : ''} onchange="updateVatRadio(this)">
                          <span class="jx-radio__inner"></span>
                        </span>
                        <span class="jx-radio__label">10%</span>
                      </label>
                      <label class="jx-radio jx-radio--small${product.vatRate === '20' ? ' is-checked' : ''}">
                        <span class="jx-radio__input${product.vatRate === '20' ? ' is-checked' : ''}">
                          <input class="jx-radio__original" name="vatRate" type="radio" value="20" ${product.vatRate === '20' ? 'checked' : ''} onchange="updateVatRadio(this)">
                          <span class="jx-radio__inner"></span>
                        </span>
                        <span class="jx-radio__label">20%</span>
                      </label>
                    </div>
                  </div>
                </div>
              </div>

              <!-- 包裹重量尺寸 -->
              <div class="jx-form-item asterisk-left jx-form-item--label-top is-required package-info-form-item">
                <label class="jx-form-item__label"><span>包裹重量尺寸</span></label>
                <div class="jx-form-item__content">
                  <div class="pro-radio-group is-horizontal">
                    <div class="jx-radio-group package-info-box">
                      <label class="jx-radio jx-radio--small${product.packageMode === 'spu' ? ' is-checked' : ''}">
                        <span class="jx-radio__input${product.packageMode === 'spu' ? ' is-checked' : ''}">
                          <input class="jx-radio__original" name="packageMode" type="radio" value="spu" ${product.packageMode === 'spu' ? 'checked' : ''} onchange="updatePackageMode(this)">
                          <span class="jx-radio__inner"></span>
                        </span>
                        <span class="jx-radio__label">按SPU设置 <i class="pro-icon-question" title="所有SKU共享同一组重量尺寸">?</i></span>
                      </label>
                      <label class="jx-radio jx-radio--small${(!product.packageMode || product.packageMode === 'sku') ? ' is-checked' : ''}">
                        <span class="jx-radio__input${(!product.packageMode || product.packageMode === 'sku') ? ' is-checked' : ''}">
                          <input class="jx-radio__original" name="packageMode" type="radio" value="sku" ${(!product.packageMode || product.packageMode === 'sku') ? 'checked' : ''} onchange="updatePackageMode(this)">
                          <span class="jx-radio__inner"></span>
                        </span>
                        <span class="jx-radio__label">按SKU设置 <i class="pro-icon-question" title="每个SKU有独立的重量尺寸，在SKU表格中填写">?</i></span>
                      </label>
                    </div>
                  </div>
                  <div class="dims-grid" id="spuDimsGrid" style="${(!product.packageMode || product.packageMode === 'sku') ? 'display:none;' : ''}">
                    <div class="dim-item">
                      <span class="dim-label">重量(g)</span>
                      <input type="number" class="form-input dim-input" id="editWeight" placeholder="-" value="${escapeAttr(product.weight ?? '')}">
                    </div>
                    <div class="dim-item">
                      <span class="dim-label">长(mm)</span>
                      <input type="number" class="form-input dim-input" id="editLength" placeholder="-" value="${escapeAttr(product.length ?? '')}">
                    </div>
                    <div class="dim-item">
                      <span class="dim-label">宽(mm)</span>
                      <input type="number" class="form-input dim-input" id="editWidth" placeholder="-" value="${escapeAttr(product.width ?? '')}">
                    </div>
                    <div class="dim-item">
                      <span class="dim-label">高(mm)</span>
                      <input type="number" class="form-input dim-input" id="editHeight" placeholder="-" value="${escapeAttr(product.height ?? '')}">
                    </div>
                  </div>
                  <div id="skuDimsHint" style="display:${(!product.packageMode || product.packageMode === 'sku') ? 'block' : 'none'};color:var(--text-tertiary);font-size:12px;margin-top:6px;">按SKU设置模式下，请在下方"类目&属性"区块的SKU表格中填写每个SKU的重量和尺寸</div>
                  <div class="volume-calc" id="volumeCalc"></div>
                </div>
              </div>

              </div>
            </div>

            <!-- 类目&属性 -->
            <div class="edit-panel" data-panel="category" id="section-category">
              <div class="edit-panel-box">


              <div class="form-group">
                <label class="form-label">商品类目 <span class="required">*</span></label>
                <div class="category-path">
                  <span class="category-breadcrumb" id="editCategoryBreadcrumb">${escapeHtml((product.categoryMatch && product.categoryMatch.matched) ? (product.categoryMatch.label || '') : (product.category || '-'))}</span>
                  ${(product.categoryMatch && product.categoryMatch.matched) ? `<span class="cat-match-badge cat-match-badge-${product.categoryMatch.confidence}" title="匹配置信度: ${product.categoryMatch.confidence === 'high' ? '高' : '中'}">自动匹配</span>` : ''}
                  ${(product.categoryMatch && !product.categoryMatch.matched && product.category) ? `<span class="cat-match-badge cat-match-badge-low" title="未自动匹配到Ozon类目">待匹配</span>` : ''}
                  <button class="action-link" onclick="openCategorySelector()">修改类目</button>
                </div>
                ${(product.categoryMatch && product.categoryMatch.matched && product.category && product.category !== product.categoryMatch.label) ? `<div class="cat-source-hint">原始分类: ${escapeHtml(product.category)}</div>` : ''}
                <input type="hidden" id="editCategoryValue" value="${escapeAttr((product.categoryMatch && product.categoryMatch.matched) ? (product.categoryMatch.label || '') : (product.category || ''))}">
              </div>

              <!-- 公共属性 -->
              <div class="form-group">
                <label class="form-label">公共属性</label>
                <div id="attrList">
                  <div style="text-align:center;color:var(--text-tertiary);padding:16px 0;font-size:13px;">请先选择商品类目</div>
                </div>
              </div>

              <!-- 销售属性/SKU信息 -->
              <div class="form-group">
                <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:8px;">
                  <label class="form-label" style="margin:0;">销售属性/SKU信息</label>
                  <select id="skuTemplateSelect" style="font-size:12px;padding:4px 24px 4px 8px;border-radius:6px;border:1px solid var(--border-color);background:var(--bg-primary);color:var(--text-primary);cursor:pointer;appearance:none;background-image:url('data:image/svg+xml;utf8,<svg xmlns=%22http://www.w3.org/2000/svg%22 width=%2212%22 height=%2212%22 viewBox=%220 0 24 24%22 fill=%22none%22 stroke=%22%23999%22 stroke-width=%222%22><path d=%22M6 9l6 6 6-6%22/></svg>');background-repeat:no-repeat;background-position:right 6px center;" onchange="onSkuTemplateChange(this.value)">
                    <option value="">已用SKU模板</option>
                  </select>
                </div>
                <div id="skuAttrList"></div>

              </div>

              <!-- SKU列表 -->
              <div class="form-group">
                <label class="form-label">SKU列表</label>
                <div id="skuTableWrap">
                  <div style="text-align:center;color:var(--text-tertiary);padding:16px 0;font-size:13px;">添加销售属性后自动生成SKU组合</div>
                </div>
              </div>

              </div>
            </div>

            <!-- 产品图片 -->
            <div class="edit-panel" data-panel="images" id="section-images">
              <div class="edit-panel-box">

                <!-- 产品图片标题 -->
                <div class="sku-image-title">产品图片<span class="required-mark">*</span></div>

                <!-- SKU图片标题栏 -->
                <div class="sku-image-header">
                  <div>
                    SKU图片
                    <span class="sku-image-count">（已选 <span id="skuImageCount">0</span> 张）</span>
                  </div>
                  <div class="sku-image-controls">
                    <label class="control-checkbox"><input type="checkbox" id="selectTop30" onchange="onSelectTop30Change()"> 选中前30张</label>
                    <label class="control-checkbox"><input type="checkbox" id="showLargePreview" checked onchange="refreshAllSkuImageCells()"> 显示大图预览</label>
                    <label class="control-checkbox"><input type="checkbox" id="showImageSize" checked onchange="refreshAllSkuImageCells()"> 显示图片尺寸</label>
                  </div>
                </div>

                <!-- 规则提示 -->
                <div class="sku-image-rules">
                  每个SKU图片 <span class="rule-highlight">最少1张，最多30张</span>，其中<span class="rule-highlight">第一张为主图</span>。格式：jpeg、jpg、png。图片比例建议为3:4，尺寸需从 200px*200px到4320px*7680px。大小不超过10MB。背景：白色或浅色。
                  <a href="#" class="rule-link" onclick="return false;">了解更多规则</a>
                </div>

                <!-- SKU图片表格 -->
                <div class="sku-image-table-wrap">
                  <table class="sku-image-table" id="skuImageTable">
                    <thead>
                      <tr>
                        <th class="col-sku">SKU选项</th>
                        <th class="col-img">图片</th>
                      </tr>
                    </thead>
                    <tbody id="skuImageTableBody">
                      <tr>
                        <td colspan="2" class="table-empty">添加销售属性后在此处管理各SKU图片</td>
                      </tr>
                    </tbody>
                  </table>
                </div>

                <!-- 颜色样本 -->
                <div class="color-sample-section">
                  <div class="color-sample-header">
                    <div class="color-sample-title">颜色样本</div>
                    <div class="color-sample-actions">
                      <button class="cs-btn cs-btn-translate" type="button">
                        <i data-lucide="languages" style="width:14px;height:14px;"></i>
                        图片翻译
                      </button>
                      <button class="cs-btn cs-btn-edit" type="button">
                        <i data-lucide="image-plus" style="width:14px;height:14px;"></i>
                        图片编辑
                      </button>
                      <button class="cs-btn cs-btn-batch" type="button">
                        <i data-lucide="upload-cloud" style="width:14px;height:14px;"></i>
                        批量传图
                      </button>
                      <button class="cs-btn cs-btn-auto" type="button">
                        一键自动填充
                      </button>
                      <button class="cs-btn cs-btn-apply" type="button">
                        应用至SKU主图
                      </button>
                      <button class="cs-btn cs-btn-batch-del" type="button">
                        批量删除
                      </button>
                      <button class="cs-btn cs-btn-export" type="button">
                        <i data-lucide="download" style="width:14px;height:14px;"></i>
                        导出图片
                      </button>
                    </div>
                  </div>

                  <div class="color-sample-controls">
                    <label class="control-checkbox">
                      <input type="checkbox"> 全选
                    </label>
                    <label class="control-checkbox">
                      <input type="checkbox" checked> 显示大图预览
                    </label>
                  </div>

                  <div class="color-sample-warnings">
                    <p><span class="warning-num">1.</span>若产品类目支持上传颜色样本，上传后会自动发布到Ozon后台，若不支持，颜色样本不会发布至Ozon后台</p>
                    <p><span class="warning-num">2.</span>可使用商品图片展示商品颜色 —————— 例如：衣服上的图案、油漆或口红的样子等。这样，买家将在切换器中看见的不显示标准圆形按钮，而是商品小图片。</p>
                    <p class="warning-format">图片大小不超过10MB，支持JPG、JPEG、PNG格式，大小200*200 - 4320*7680</p>
                  </div>

                  <div class="color-sample-grid" id="colorSampleGrid">
                    <!-- 动态生成：由 renderColorSamples() 根据 SKU 颜色属性渲染 -->
                  </div>
                </div>

              </div>
            </div>

            <!-- 产品视频 -->
            <div class="edit-panel" data-panel="video" id="section-video">
              <div class="edit-panel-box">
                <div class="product-video-info-box">

                  <!-- 视频规则说明 -->
                  <div class="video-tips">
                    <li class="video-tips-item">因视频文件会占用大量服务器资源，<span class="color-light-red">请视频上传7天内完成产品发布，过期将会被清除；</span></li>
                    <li class="video-tips-item">格式格式:MP4，MOV；视频封面最多可上传1条；视频大小不能超过20MB。视频封面建议无边框与页边，且视频时长小于30秒</li>
                    <li class="video-tips-item">产品描述视频最多可上传5条，大小不能超过200MB；</li>
                  </div>

                  <div class="vide-box">
                    <!-- 封面视频 -->
                    <div class="cover-video-box">
                      <div class="upload-video-box">
                        <div class="upload-video-box__header">
                          <div class="cover-label">封面视频 <span class="info-icon" title="视频封面建议无边框与页边，时长小于30秒">&#9432;</span>：</div>
                          <div class="generate-video-box">
                            <button class="video-action-btn" title="视频翻译" onclick="videoTranslate()">
                              <i data-lucide="languages" style="width:14px;height:14px;"></i>视频翻译
                            </button>
                            <button class="video-action-btn btn-new" title="AI图生视频" onclick="aiGenerateVideo()">
                              <i data-lucide="sparkles" style="width:14px;height:14px;"></i>AI图生视频<span class="new-badge">NEW</span>
                            </button>
                            <button class="video-action-btn" title="剪辑视频" onclick="editVideo()" disabled>
                              <i data-lucide="scissors" style="width:14px;height:14px;"></i>剪辑视频
                            </button>
                            <button class="video-action-btn" title="一键生成" onclick="oneClickGenerateVideo()">
                              <i data-lucide="wand-2" style="width:14px;height:14px;"></i>一键生成
                            </button>
                            <button class="video-action-btn" title="制作视频" onclick="makeVideo()">
                              <i data-lucide="clapperboard" style="width:14px;height:14px;"></i>制作视频
                            </button>
                          </div>
                        </div>
                        <div class="upload-video-container">
                          <div class="upload-video-left">
                            <input type="hidden" id="editCoverVideoUrl" value="${escapeAttr((product.videos && product.videos[0]) || '')}">
                            <div class="video-wrap add-video-box ${product.videos && product.videos[0] ? 'has-video' : ''}" id="coverVideoWrap" onclick="document.getElementById('coverVideoFile').click()">
                              ${product.videos && product.videos[0]
                                ? `<video src="${escapeAttr(product.videos[0])}" muted></video><button class="video-delete-btn" onclick="event.stopPropagation();clearCoverVideo(event)">&times;</button>`
                                : `<i data-lucide="plus" style="width:24px;height:24px;color:#bbb;"></i>`}
                            </div>
                          </div>
                          <div class="upload-video-right"></div>
                        </div>
                        <div class="upload-video-container-footer"></div>
                      </div>
                      <div class="hidden-video-upload">
                        <input class="jx-upload__input" id="coverVideoFile" name="video" accept=".mp4,.mov" type="file" style="display:none;" onchange="handleCoverVideoUpload(this)">
                      </div>
                    </div>

                    <!-- 分隔线 -->
                    <div class="video-divider"></div>

                    <!-- 产品描述视频 -->
                    <div class="desc-video-box">
                      <div class="desc-video-label">产品描述视频 <span class="info-icon" title="最多5条">&#9432;</span>：</div>
                      <div class="video-list" id="descVideoList">
                        <div class="upload-video-box">
                          <div class="upload-video-container">
                            <div class="upload-video-left">
                              <div class="video-wrap add-video-box" onclick="document.getElementById('descVideoFile').click()">
                                <i data-lucide="plus" style="width:24px;height:24px;color:#bbb;"></i>
                              </div>
                            </div>
                            <div class="upload-video-right" id="descVideoPreview">
                              ${(product.videos || []).slice(1).map((url, i) => `
                              <div class="desc-video-item" data-url="${url}">
                                <video src="${url}" muted></video>
                                <button class="video-delete-btn" onclick="removeDescVideo(this)">&times;</button>
                              </div>`).join('')}
                            </div>
                          </div>
                          <div class="upload-video-container-footer"></div>
                        </div>
                      </div>
                      <div class="hidden-video-upload">
                        <input class="jx-upload__input" id="descVideoFile" name="video" accept=".mp4,.mov" type="file" style="display:none;" onchange="handleDescVideoUpload(this)">
                      </div>
                    </div>
                  </div>

                </div>
                <div class="video-list" id="videoList"></div>
              </div>
            </div>

            <!-- 其他信息 -->
            <div class="edit-panel" data-panel="other" id="section-other">
              <div class="edit-panel-box">

              <!-- 付费推广 -->
              <div class="jx-form-item asterisk-left jx-form-item--label-top">
                <div class="jx-form-item__label"><span>付费推广</span></div>
                <div class="jx-form-item__content">
                  <div>
                    <label class="jx-checkbox jx-checkbox--small reviews-promo-operation pro-checkbox">
                      <span class="jx-checkbox__input">
                        <input class="jx-checkbox__original" type="checkbox" id="editPointsForReviews" ${product.pointsForReviews === 'enable' ? 'checked' : ''} true-value="enable" false-value="disable" onchange="this.value=this.checked?'enable':'disable'">
                        <span class="jx-checkbox__inner"></span>
                      </span>
                      <span class="jx-checkbox__label">积分评价</span>
                    </label>
                    <div class="promo-operation-tips">
                      <div class="promo-operation-tips-item">勾选后，商家可在 "Ozon 商家后台 — 商品 — 积分评价" 页面设置 "留评获分" 活动。买家提交此产品的评价后能获得积分，这一方式有助于提升店铺购买转化率，</div>
                      <div class="promo-operation-tips-item"><span class="color-warning">积分产生的费用需要卖家承担。</span><a class="jx-link jx-link--primary" href="https://docs.ozon.ru/global/zh-hans/promotion/feedback/customer-reviews/points-for-reviews/start-reviews-for-points/?country=CN" target="_blank">查看官方说明</a></div>
                      <div class="promo-operation-tips-item">提示：由于Ozon接口限制，若产品发布到Ozon商家后台时审核失败，积分评价会默认关闭。若要开启请前往Ozon商家后台编辑。</div>
                    </div>
                  </div>
                </div>
              </div>
              </div>
            </div>

            <!-- 货源链接 -->
            <div class="edit-panel" data-panel="source" id="section-source">
              <div class="edit-panel-box">
              <!-- 货源链接（多条动态表单） -->
              <form class="source-form" onsubmit="return false">
              <div class="jx-form-item asterisk-left jx-form-item--label-top">
                <div class="jx-form-item__label"><span>货源链接</span></div>
                <div class="jx-form-item__content">
                  <div class="source-link-info-box" id="sourceLinksList">
                    ${(product.sourceLinks || [{ remark: '', url: '' }]).map((sl, idx) => `
                    <div class="jx-form-item asterisk-left jx-form-item--label-top pro-form-item source-link-row" sourceindex="${idx}" data-idx="${idx}">
                      <div class="jx-form-item__content">
                        <div class="pro-input-group source-input-group">
                          <div class="jx-input jx-input--small pro-input source-remark-input">
                            <div class="jx-input__wrapper">
                              <input class="jx-input__inner" type="text" placeholder="备注" maxlength="30" value="${escapeAttr(sl.remark || '')}" data-idx="${idx}">
                            </div>
                          </div>
                          <div class="jx-input jx-input--small pro-input source-url-input">
                            <div class="jx-input__wrapper">
                              <input class="jx-input__inner" type="text" placeholder="记录供货商链接，便于采购" value="${escapeAttr(sl.url || '')}" data-idx="${idx}">
                            </div>
                          </div>
                        </div>
                        <div class="jx-button-group pro-button-group source-link-actions">
                          ${sl.url ? `<button type="button" class="jx-button jx-button--primary jx-button--small is-text pro-button" onclick="window.open('${sl.url}','_blank')">跳转</button>` : ''}
                          ${sl.url ? `<button type="button" class="jx-button jx-button--primary jx-button--small is-text pro-button" onclick="navigator.clipboard.writeText('${sl.url}');Toast.show('已复制','success')">复制</button>` : ''}
                          <button type="button" class="jx-button jx-button--primary jx-button--small is-text pro-button" onclick="addSourceLinkRow()">添加</button>
                        </div>
                        <button type="button" class="jx-button jx-button--primary jx-button--small is-text pro-button source-remove-btn" onclick="removeSourceLinkRow(${idx})" ${idx === 0 ? 'disabled' : ''}>删除</button>
                      </div>
                    </div>
                    `).join('')}
                  </div>
                </div>
              </div>
              </form>
              </div>
            </div>

          </div>
        </div>
      </div>
    `,
    footer: [
      { text: '取消', class: 'btn-ghost' },
      { text: '一键翻译', class: 'btn-secondary', onClick: () => oneClickTranslate(product) },
      { text: '保存并发布', class: 'btn-primary', onClick: () => saveAndPublish(product, id) },
      { text: '保存修改', class: 'btn-ghost', onClick: () => saveProductData(product) },
    ],
    onOpen: () => {
      if (window.lucide) lucide.createIcons();
      initScrollTabs();
      console.log('[onOpen] 渲染前SKU数据:', {
        'window._skuAttrs.length': window._skuAttrs?.length || 0,
        'window._editingProduct.skus.length': window._editingProduct?.skus?.length || 0,
      });
      // 调用自动填充：将清洗后的product数据同步到表单字段（覆盖模板默认值）
      if (window.ProductMapping && typeof ProductMapping.autoFillEditForm === 'function') {
        try {
          ProductMapping.autoFillEditForm(product);
        } catch (e) {
          console.warn('自动填充表单失败:', e);
        }
      }
      // 立即渲染三个固定字段（简介/JSON富内容/型号名称），不等待类目属性加载
      // 传入 null 使用默认元数据，确保字段始终可见；类目加载后会用真实数据覆盖
      try {
        renderAnnotationAttr(null);
        renderRichContentAttr(null);
        renderModelAttr(null);
      } catch (e) {
        console.warn('固定字段渲染失败:', e);
      }
      // 捕获表单初始值，作为 dirty 检测的基线
      window._editFormInitialSnapshot = _captureEditFormSnapshot(product);

      // 如果类目已匹配，渲染SKU和属性；否则自动触发AI匹配
      if (window._selectedCategory) {
        renderSkuAttrs();
        generateSkuTable();
        renderColorSamples();
        // 异步竞态保护：仅当仍是当前会话时才执行后续回填
        const sessionId = editSessionId;
        loadCategoryAttributes(
          window._selectedCategory.description_category_id,
          window._selectedCategory.type_id,
          { preserveSkuAttrs: true }
        ).then(() => {
          if (window._editSessionId !== sessionId) {
            console.log('[onOpen] 会话已切换，丢弃属性回填');
            return;
          }
          // renderCategoryAttributes 内部已调用 renderSkuAttrs + generateSkuTable + renderColorSamples
          // 此处只需填充采集属性值，避免重复渲染导致表格闪烁/重复
          fillAttributeValues(product.attributes);
        }).catch(e => console.warn('拉取类目属性失败:', e));
      } else {
        // 无类目时也渲染单SKU表格（通用字段：价格/库存/货号等不依赖类目）
        generateSkuTable();
        // 同时自动触发AI智能匹配
        const breadcrumb = document.getElementById('editCategoryBreadcrumb');
        if (breadcrumb) breadcrumb.textContent = 'AI匹配中...';
        aiMatchCategoryForProduct();
      }
      // 绑定侧边栏 1688分销+ 弹窗
      bindSourcePopoverEvents();
    }
  });
}

/**
 * 捕获当前编辑表单的快照，用于 dirty 检测
 * 在 Modal.show 之前调用一次（初始值），在 beforeClose 时再调用一次进行对比
 */
function _captureEditFormSnapshot(product) {
  const get = (id) => {
    const el = document.getElementById(id);
    return el ? (el.type === 'checkbox' ? el.checked : el.value) : null;
  };
  const getRadio = (name) => {
    const el = document.querySelector(`input[name="${name}"]:checked`);
    return el ? el.value : null;
  };
  const getList = (selector, fn) => {
    const items = [];
    document.querySelectorAll(selector).forEach(row => items.push(fn(row)));
    return JSON.stringify(items);
  };
  return JSON.stringify({
    title: get('editTitle'),
    desc: document.querySelector('#annotationAttr .attr-field')?.value || '',
    mergeCode: document.querySelector('#modelAttr .attr-field')?.value || '',
    vat: getVatValue ? getVatValue() : null,
    weight: get('editWeight'),
    length: get('editLength'),
    width: get('editWidth'),
    height: get('editHeight'),
    packageMode: getRadio('packageMode'),
    pointsForReviews: get('editPointsForReviews'),
    coverVideoUrl: get('editCoverVideoUrl'),
    descVideos: Array.from(document.querySelectorAll('.desc-video-item')).map(i => i.getAttribute('data-url') || ''),
    sourceLinks: getList('#sourceLinksList .source-link-row', row => ({
      remark: row.querySelector('.source-remark-input input')?.value || '',
      url: row.querySelector('.source-url-input input')?.value || '',
    })),
    skuAttrs: JSON.stringify(window._skuAttrs || []),
    selectedCategory: JSON.stringify(window._selectedCategory || null),
    // 类目属性区
    attrs: collectCategoryAttributes ? collectCategoryAttributes() : [],
    // SKU 表格数据
    skus: collectSkuTableData ? collectSkuTableData() : [],
  });
}

/** 检测表单是否有未保存修改 */
function _isEditFormDirty(product) {
  try {
    const current = _captureEditFormSnapshot(product);
    return current !== window._editFormInitialSnapshot;
  } catch (e) {
    console.warn('[dirty] 检测失败:', e);
    return false;
  }
}

/** beforeClose 守卫：若有未保存修改，弹确认对话框 */
async function _confirmDiscardIfDirty() {
  const product = window._editingProduct;
  if (!product) return true;
  if (!_isEditFormDirty(product)) return true;
  // 有未保存修改，弹确认
  const confirmed = await Modal.confirm('当前修改尚未保存，确定要离开吗？');
  return confirmed;
}

/** 切换编辑产品（左侧列表点击）
 * 若当前有未保存修改，先弹确认
 */
async function switchEditProduct(id) {
  // 检查 dirty
  const product = window._editingProduct;
  if (product && _isEditFormDirty(product)) {
    const confirmed = await Modal.confirm('当前修改尚未保存，确定切换商品吗？');
    if (!confirmed) return;
  }
  // 更新侧栏高亮
  document.querySelectorAll('.edit-sidebar-item').forEach(item => {
    item.classList.toggle('active', item.dataset.id === id);
  });
  // 强制关闭（已确认）后重新打开以加载新产品的数据
  await Modal.forceClose();
  // 重置会话，避免新会话被旧的异步回调污染
  window._editSessionId = null;
  window._editFormInitialSnapshot = null;
  setTimeout(() => editProduct(id), 250);
}

/** 切换编辑Tab */
/** 标题字数统计 */
function updateTitleCount() {
  const el = document.getElementById('editTitle');
  const count = document.getElementById('titleCount');
  if (el && count) count.textContent = `${el.value.length} / 200`;
}

/** 首字母大写 */
function toUpperCaseFirst() {
  const el = document.getElementById('editTitle');
  if (!el) return;
  el.value = el.value.replace(/\b\w/g, c => c.toUpperCase());
  updateTitleCount();
}

/** 包裹模式切换：按SPU/按SKU */
function updatePackageMode(el) {
  const mode = el.value;
  const dimsGrid = document.getElementById('spuDimsGrid');
  const skuHint = document.getElementById('skuDimsHint');
  // 更新radio样式
  const group = el.closest('.jx-radio-group');
  if (group) {
    group.querySelectorAll('.jx-radio').forEach(r => {
      r.classList.remove('is-checked');
      r.querySelector('.jx-radio__input')?.classList.remove('is-checked');
    });
    const checkedLabel = el.closest('.jx-radio');
    if (checkedLabel) {
      checkedLabel.classList.add('is-checked');
      checkedLabel.querySelector('.jx-radio__input')?.classList.add('is-checked');
    }
  }
  if (dimsGrid) dimsGrid.style.display = mode === 'sku' ? 'none' : '';
  if (skuHint) skuHint.style.display = mode === 'sku' ? 'block' : 'none';
}

/** AI生成字段内容 */
async function aiGenerateField(field) {
  const title = document.getElementById('editTitle')?.value || '';
  const desc = document.querySelector('#annotationAttr .attr-field')?.value || '';
  const prompt = field === 'title'
    ? `根据以下商品描述，生成一个适合Ozon平台的俄语商品标题（不超过200字符）：\n${desc || title}`
    : `根据以下商品标题，生成一段适合Ozon平台的俄语商品描述：\n${title}`;

  Toast.show('AI生成中...', 'info');
  try {
    const res = await Api.aiGenerate({ prompt });
    if (res?.data?.text) {
      const target = field === 'title'
        ? document.getElementById('editTitle')
        : document.querySelector('#annotationAttr .attr-field');
      if (target) {
        target.value = res.data.text;
        if (field === 'title') updateTitleCount();
      }
      Toast.show('AI生成完成', 'success');
    } else {
      Toast.show('AI生成失败', 'error');
    }
  } catch (e) {
    Toast.show('AI生成失败: ' + (e.message || ''), 'error');
  }
}

/** 添加货源链接行 */
function addSourceLinkRow(remark = '', url = '') {
  const list = document.getElementById('sourceLinksList');
  if (!list) return;
  const idx = list.querySelectorAll('.source-link-row').length;
  const row = document.createElement('div');
  row.className = 'jx-form-item asterisk-left jx-form-item--label-top pro-form-item source-link-row';
  row.setAttribute('sourceindex', idx);
  row.dataset.idx = idx;
  row.innerHTML = `
    <div class="jx-form-item__content">
      <div class="pro-input-group source-input-group">
        <div class="jx-input jx-input--small pro-input source-remark-input">
          <div class="jx-input__wrapper">
            <input class="jx-input__inner" type="text" placeholder="备注" maxlength="30" data-idx="${idx}" value="${escapeAttr(remark)}">
          </div>
        </div>
        <div class="jx-input jx-input--small pro-input source-url-input">
          <div class="jx-input__wrapper">
            <input class="jx-input__inner" type="text" placeholder="记录供货商链接，便于采购" data-idx="${idx}" value="${escapeAttr(url)}">
          </div>
        </div>
      </div>
      <div class="jx-button-group pro-button-group source-link-actions">
        ${url ? `<button type="button" class="jx-button jx-button--primary jx-button--small is-text pro-button" onclick="window.open('${escapeAttr(url)}','_blank')">跳转</button>` : ''}
        ${url ? `<button type="button" class="jx-button jx-button--primary jx-button--small is-text pro-button" onclick="navigator.clipboard.writeText('${escapeAttr(url)}');Toast.show('已复制','success')">复制</button>` : ''}
        <button type="button" class="jx-button jx-button--primary jx-button--small is-text pro-button" onclick="addSourceLinkRow()">添加</button>
      </div>
      <button type="button" class="jx-button jx-button--primary jx-button--small is-text pro-button source-remove-btn" onclick="removeSourceLinkRow(${idx})">删除</button>
    </div>
  `;
  list.appendChild(row);
}

/** 删除货源链接行 */
function removeSourceLinkRow(idx) {
  const list = document.getElementById('sourceLinksList');
  if (!list) return;
  const rows = list.querySelectorAll('.source-link-row');
  if (rows.length <= 1) return;
  rows[idx]?.remove();
  // 重新编号
  list.querySelectorAll('.source-link-row').forEach((row, i) => {
    row.dataset.idx = i;
    row.querySelectorAll('input').forEach(inp => inp.dataset.idx = i);
  });
}

/** 滚动到指定区块 */
function scrollToSection(section) {
  const el = document.getElementById('section-' + section);
  const content = document.getElementById('editContent');
  if (el && content) {
    content.scrollTo({ top: el.offsetTop - 8, behavior: 'smooth' });
  }
}

/** 更新锚点菜单高亮 */
function updateActiveAnchor() {
  const content = document.getElementById('editContent');
  const anchors = document.querySelectorAll('.scroll-menu-nav__item');
  if (!content) return;

  const scrollTop = content.scrollTop;
  let activeSection = 'basic';

  document.querySelectorAll('.edit-panel[data-panel]').forEach(panel => {
    if (panel.offsetTop - 20 <= scrollTop) {
      activeSection = panel.dataset.panel;
    }
  });

  anchors.forEach(a => {
    a.classList.toggle('is-active', a.dataset.section === activeSection);
  });
}

/** 初始化锚点滚动菜单 */
function initScrollTabs() {
  const content = document.getElementById('editContent');
  if (!content) return;

  // 所有面板改为纵向堆叠可见
  content.classList.add('scroll-tabs-mode');

  // 滚动时更新锚点高亮
  let ticking = false;
  content.addEventListener('scroll', () => {
    if (!ticking) {
      requestAnimationFrame(() => {
        updateActiveAnchor();
        ticking = false;
      });
      ticking = true;
    }
  });

  // 初始定位
  setTimeout(() => updateActiveAnchor(), 100);
}


/** 一键翻译 - 翻译标题和描述 */
function oneClickTranslate(product) {
  Toast.show('翻译功能未接入真实 AI 接口，已停止模拟生成', 'warning');
}

/** VAT单选切换 */
function updateVatRadio(radio) {
  const group = radio.closest('.jx-radio-group');
  if (!group) return;
  group.querySelectorAll('.jx-radio').forEach(label => {
    const input = label.querySelector('input');
    const isChecked = input && input.checked;
    label.classList.toggle('is-checked', isChecked);
    label.querySelector('.jx-radio__input')?.classList.toggle('is-checked', isChecked);
  });
}

/** 获取VAT值 */
function getVatValue() {
  const checked = document.querySelector('input[name="vatRate"]:checked');
  return checked ? checked.value : '';
}

/** 根据滚动位置更新当前激活的Tab */
// updateActiveTabByScroll 已被 updateActiveAnchor 替代

/** 更新SKU图片计数 */
function updateSkuImageCount() {
  updateTotalSkuImageCount();
}

/** 添加属性行 */
function addAttrRow() {
  const list = document.getElementById('attrList');
  const row = document.createElement('div');
  row.className = 'attr-item';
  row.innerHTML = `
    <input type="text" class="form-input attr-key" placeholder="属性名">
    <input type="text" class="form-input attr-val" placeholder="属性值">
    <button class="btn-icon-sm danger" onclick="this.parentElement.remove()">×</button>
  `;
  list.appendChild(row);
}

/* ========== 销售属性 / SKU 管理 ========== */

// 全局销售属性数据
window._skuAttrs = [];
// 全局SKU图片数据，按SKU索引存储 { 0: [url1, url2, ...], 1: [...] }
window._skuImages = {};

/** SKU模板切换 */
function onSkuTemplateChange(value) {
  // TODO: 实现SKU模板加载逻辑
  if (!value) return;
}

/** 添加销售属性 */
function addSkuAttr(defaultName) {
  window._skuAttrs.push({ name: defaultName || '', values: [] });
  renderSkuAttrs();
}

/** 删除销售属性 */
function removeSkuAttr(idx) {
  window._skuAttrs.splice(idx, 1);
  renderSkuAttrs();
  generateSkuTable();
}

/** 更新销售属性名 */
function updateSkuAttrName(idx, name) {
  window._skuAttrs[idx].name = name;
  renderSkuAttrs();
  generateSkuTable();
}

/** 添加单个属性值 */
function addSkuAttrValue(idx) {
  const input = document.getElementById(`skuValueInput_${idx}`);
  if (!input) return;
  const val = input.value.trim();
  if (!val) return;
  if (!window._skuAttrs[idx].values.includes(val)) {
    window._skuAttrs[idx].values.push(val);
    generateSkuTable();
  }
  input.value = '';
  renderSkuAttrs();
  // 聚焦回输入框
  const newInput = document.getElementById(`skuValueInput_${idx}`);
  if (newInput) newInput.focus();
}

/** 添加属性值（点击+添加选项按钮，自动生成名称） */
function addBlankSkuAttrValue(idx) {
  const existing = window._skuAttrs[idx].values;
  let num = existing.filter(v => v && v.startsWith('选项')).length + 1;
  let newName = `选项${num}`;
  // 确保名称不重复，如果重复则递增编号
  while (existing.includes(newName)) {
    num++;
    newName = `选项${num}`;
  }
  window._skuAttrs[idx].values.push(newName);
  renderSkuAttrs();
  generateSkuTable();
}

/** 添加SKU属性值（根据skuType区分输入方式） */
function addSkuAttrValueForType(idx) {
  const input = document.getElementById(`skuValueInput_${idx}`);
  if (!input) return;
  const val = input.value.trim();
  if (!val) return;
  if (window._skuAttrs[idx].values.includes(val)) return;
  window._skuAttrs[idx].values.push(val);
  input.value = '';
  renderSkuAttrs();
  generateSkuTable();
  // 重新聚焦输入框
  const newInput = document.getElementById(`skuValueInput_${idx}`);
  if (newInput) newInput.focus();
}

/** 添加数字类型属性值（新增一个输入框） */
function addNumberSkuValue(idx) {
  window._skuAttrs[idx].values.push('');
  renderSkuAttrs();
  // 聚焦新添加的输入框
  setTimeout(() => {
    const area = document.querySelector('.sku-attr-values-area');
    if (area) {
      const inputs = area.querySelectorAll('input[type="number"]');
      if (inputs.length > 0) inputs[inputs.length - 1].focus();
    }
  }, 0);
}

/** 更新数字类型属性值（实时更新，不允许为0） */
function updateNumberSkuValue(attrIdx, valIdx, val) {
  const num = parseInt(val);
  if (val && num === 0) {
    Toast.show('数字不能为0', 'warning');
    return;
  }
  window._skuAttrs[attrIdx].values[valIdx] = val;
  generateSkuTable();
}

/** 更新单个属性值文本 */
function updateSkuAttrValueText(attrIdx, valIdx, text) {
  window._skuAttrs[attrIdx].values[valIdx] = text.trim();
  generateSkuTable();
}

/** 删除单个属性值 */
function removeSkuAttrValue(attrIdx, valIdx) {
  window._skuAttrs[attrIdx].values.splice(valIdx, 1);
  renderSkuAttrs();
  generateSkuTable();
}

/** 清除指定属性的所有值 */
function clearSkuAttrValues(attrIdx) {
  if (attrIdx < 0 || attrIdx >= window._skuAttrs.length) return;
  window._skuAttrs[attrIdx].values = [];
  // 同时清空输入框
  const inputEl = document.getElementById(`skuValueInput_${attrIdx}`);
  if (inputEl) inputEl.value = '';
  const textEl = document.getElementById(`skuTextInput_${attrIdx}`);
  if (textEl) textEl.value = '';
  renderSkuAttrs();
  generateSkuTable();
}

/** 回车添加属性值 */
function onSkuValueKeydown(e, idx) {
  if (e.key === 'Enter') {
    e.preventDefault();
    addSkuAttrValue(idx);
  }
}

// Ozon 标准颜色选项（中文 + 俄语）
const OZON_COLORS = [
  { zh: '白色', ru: 'белый' },
  { zh: '透明', ru: 'прозрачный' },
  { zh: '米色', ru: 'бежевый' },
  { zh: '黑色', ru: 'черный' },
  { zh: '棕色', ru: 'коричневый' },
  { zh: '灰色', ru: 'серый' },
  { zh: '金属灰色', ru: 'серый металлик' },
  { zh: '黄色', ru: 'желтый' },
  { zh: '红色', ru: 'красный' },
  { zh: '粉红色', ru: 'розовый' },
  { zh: '蓝色', ru: 'синий' },
  { zh: '金色', ru: 'золотой' },
  { zh: '绿色', ru: 'зеленый' },
  { zh: '天蓝色', ru: 'голубой' },
  { zh: '橙色', ru: 'оранжевый' },
  { zh: '紫色', ru: 'фиолетовый' },
  { zh: '青铜色', ru: 'бронза' },
  { zh: '淡紫色', ru: 'сиреневый' },
  { zh: '浅绿色', ru: 'светло-зеленый' },
  { zh: '酒红色', ru: 'бордовый' },
  { zh: '浅棕色', ru: 'светло-коричневый' },
  { zh: '深蓝色', ru: 'темно-синий' },
  { zh: '浅米色', ru: 'светло-бежевый' },
  { zh: '浅灰色', ru: 'светло-серый' },
  { zh: '青色', ru: 'бирюзовый' },
  { zh: '浅粉色', ru: 'светло-розовый' },
  { zh: '象牙白', ru: 'слоновая кость' },
  { zh: '深棕色', ru: 'темно-коричневый' },
  { zh: '紫红色', ru: 'фиксия' },
  { zh: '深灰色', ru: 'темно-серый' },
  { zh: '珊瑚色', ru: 'коралловый' },
  { zh: '深绿色', ru: 'темно-зеленый' },
  { zh: '棕红色', ru: 'коричнево-красный' },
  { zh: '深米色', ru: 'темно-бежевый' },
  { zh: '橄榄色', ru: 'оливковый' },
  { zh: '巧克力色', ru: 'шоколадный' },
  { zh: '黑灰色', ru: 'черно-серый' },
  { zh: '铜色', ru: 'медь' },
  { zh: '银色', ru: 'серебристый' },
  { zh: '深粉红色', ru: 'темно-розовый' },
  { zh: '蔚蓝色', ru: 'лазурный' },
  { zh: '奶油色', ru: 'кремовый' },
  { zh: '卡其色', ru: 'хаки' },
  { zh: '浅绿色', ru: 'салатовый' },
  { zh: '芥末黄', ru: 'горчичный' },
  { zh: '多色', ru: 'разноцветный' },
  { zh: '红紫色', ru: 'пурпурный' },
  { zh: '亚光黑色', ru: 'черный матовый' },
  { zh: '红莓色', ru: 'малиновый' },
  { zh: '浅黄色', ru: 'светло-желтый' },
  { zh: '镜面色', ru: 'зеркальный' },
  { zh: '铬色', ru: 'хром' },
  { zh: '深酒红色', ru: 'темно-бордовый' },
  { zh: '浅蓝色', ru: 'светло-синий' },
  { zh: '珠光色', ru: 'перламутровый' },
  { zh: '浅紫色', ru: 'лиловый' },
];

/** 格式化颜色标签：中文(俄语) */
function formatColorLabel(zhName) {
  const found = OZON_COLORS.find(c => c.zh === zhName);
  return found ? `${found.zh}(${found.ru})` : zhName;
}

// ===== 颜色字典值缓存（从 Ozon API 加载，含 value_id）=====
// 结构: { [dictionaryId]: [{ id, value_zh, value_ru, value_id }] }
window._colorDictCache = window._colorDictCache || {};

/**
 * 加载颜色字典值（从 Ozon API，含 dictionary_value_id）
 * @param {number} attributeId - Ozon 属性 ID（用于 API 查询）
 * @param {number} dictionaryId - Ozon 字典 ID（用于缓存 key）
 * @param {number} descCatId - description_category_id
 * @param {number} typeId - type_id
 * @returns {Promise<Array>} 字典值数组 [{ id, value_zh, value_ru, value_id }]
 */
async function loadColorDictionary(attributeId, dictionaryId, descCatId, typeId) {
  if (!attributeId || !dictionaryId) return [];
  const cacheKey = `${dictionaryId}`;
  if (window._colorDictCache[cacheKey]) {
    return window._colorDictCache[cacheKey];
  }
  try {
    const res = await Api.getAttributeValues(descCatId, typeId, attributeId);
    const values = (res.data || []).map(v => ({
      id: v.value_id,           // Ozon 字典值 ID
      value_id: v.value_id,     // Ozon 字典值 ID
      value_zh: v.value_zh || (v.value || '').split(/[（(]/)[0].trim(),
      value_ru: v.value_ru || '',
      value: v.value || '',
    }));
    window._colorDictCache[cacheKey] = values;
    return values;
  } catch (e) {
    console.warn('[loadColorDictionary] 加载失败:', e);
    return [];
  }
}

/**
 * 1688 颜色名 → Ozon 颜色字典值 自动匹配
 * 匹配策略：精确匹配 → 包含匹配 → 关键词匹配 → 回退到 OZON_COLORS
 * @param {string} sourceColor - 1688 源颜色名（如 "蓝色史迪仔"）
 * @param {Array} dictValues - Ozon 颜色字典值（loadColorDictionary 返回值）
 * @returns {{ text: string, value_id: number|null }} 匹配结果
 */
function autoMatchColor(sourceColor, dictValues) {
  if (!sourceColor) return { text: '', value_id: null };
  const src = sourceColor.trim();
  const srcLower = src.toLowerCase();

  // 1. 精确匹配（中文或俄语）
  let match = dictValues.find(v => v.value_zh === src || v.value_ru.toLowerCase() === srcLower);
  if (match) return { text: match.value, value_id: match.value_id };

  // 2. 包含匹配：源颜色包含字典值的中文名
  match = dictValues.find(v => v.value_zh && src.includes(v.value_zh));
  if (match) return { text: match.value, value_id: match.value_id };

  // 3. 包含匹配：字典值中文名包含源颜色
  match = dictValues.find(v => v.value_zh && v.value_zh.includes(src));
  if (match) return { text: match.value, value_id: match.value_id };

  // 4. 关键词匹配：提取颜色关键词进行匹配
  //    颜色关键词表（从短到长，优先匹配更具体的关键词）
  const COLOR_KEYWORDS = [
    ['浅紫色', 'лиловый'], ['浅粉色', 'светло-розовый'], ['浅蓝色', 'светло-синий'],
    ['浅绿色', 'светло-зеленый'], ['浅灰色', 'светло-серый'], ['浅黄色', 'светло-желтый'],
    ['深蓝色', 'темно-синий'], ['深灰色', 'темно-серый'], ['深绿色', 'темно-зеленый'],
    ['深棕色', 'темно-коричневый'], ['深粉色', 'темно-розовый'], ['深酒红', 'темно-бордовый'],
    ['酒红色', 'бордовый'], ['巧克力', 'шоколадный'], ['橄榄色', 'оливковый'],
    ['珊瑚色', 'коралловый'], ['天蓝色', 'голубой'], ['紫红色', 'фиксия'],
    ['红紫色', 'пурпурный'], ['红莓色', 'малиновый'], ['蔚蓝色', 'лазурный'],
    ['青铜色', 'бронза'], ['奶油色', 'кремовый'], ['卡其色', 'хаки'],
    ['芥末黄', 'горчичный'], ['珠光色', 'перламутровый'], ['镜面色', 'зеркальный'],
    ['金属灰', 'серый металлик'], ['亚光黑', 'черный матовый'],
    ['黑灰色', 'черно-серый'], ['棕红色', 'коричнево-красный'],
    ['白色', 'белый'], ['黑色', 'черный'], ['红色', 'красный'],
    ['蓝色', 'синий'], ['绿色', 'зеленый'], ['黄色', 'желтый'],
    ['紫色', 'фиолетовый'], ['橙色', 'оранжевый'], ['粉色', 'розовый'],
    ['灰色', 'серый'], ['棕色', 'коричневый'], ['米色', 'бежевый'],
    ['金色', 'золотой'], ['银色', 'серебристый'], ['青色', 'бирюзовый'],
    ['铜色', 'медь'], ['铬色', 'хром'], ['透明', 'прозрачный'],
    ['多色', 'разноцветный'],
  ];
  // 单字颜色关键词（最低优先级）
  const SINGLE_CHAR_COLORS = ['白', '黑', '红', '蓝', '绿', '黄', '紫', '橙', '粉', '灰', '棕', '金', '银', '青'];

  for (const [kwZh, kwRu] of COLOR_KEYWORDS) {
    if (src.includes(kwZh)) {
      match = dictValues.find(v => v.value_zh === kwZh || v.value_ru === kwRu);
      if (match) return { text: match.value, value_id: match.value_id };
    }
  }
  // 单字匹配（如 "蓝" → "蓝色"）
  for (const ch of SINGLE_CHAR_COLORS) {
    if (src.includes(ch)) {
      match = dictValues.find(v => v.value_zh && v.value_zh.startsWith(ch));
      if (match) return { text: match.value, value_id: match.value_id };
    }
  }

  // 5. 回退：用 OZON_COLORS 匹配（无 value_id）
  for (const c of OZON_COLORS) {
    if (src.includes(c.zh) || c.zh.includes(src)) {
      return { text: `${c.zh}（${c.ru}）`, value_id: null };
    }
  }

  // 6. 无法匹配：保留原值，无 value_id
  return { text: src, value_id: null };
}

/** 打开颜色选择弹窗（异步加载 API 字典值） */
async function openColorPickerModal(attrIdx, valIdx) {
  const isEdit = valIdx >= 0;
  const currentVal = isEdit ? (window._skuAttrs[attrIdx]?.values[valIdx] || '') : '';

  // 先展示加载中
  Modal.show({
    title: '请选择',
    size: 'xs',
    body: `<div style="text-align:center;padding:40px 0;color:var(--text-tertiary);font-size:13px;">加载中...</div>`,
    footer: [{ text: '取消', class: 'btn-ghost', onClick: () => Modal.close() }],
  });

  // 加载颜色字典值（优先 API，回退 OZON_COLORS）
  const attr = window._skuAttrs[attrIdx];
  let colorOptions = [];
  if (attr?.dictionaryId) {
    const descCatId = window._selectedCategory?.description_category_id;
    const typeId = window._selectedCategory?.type_id;
    if (descCatId && typeId) {
      colorOptions = await loadColorDictionary(attr.attrId, attr.dictionaryId, descCatId, typeId);
    }
  }
  // 回退到 OZON_COLORS
  if (colorOptions.length === 0) {
    colorOptions = OZON_COLORS.map(c => ({ value_id: null, value_zh: c.zh, value_ru: c.ru, value: `${c.zh}（${c.ru}）` }));
  }

  Modal.close(); // 关闭加载中弹窗

  Modal.show({
    title: '请选择',
    size: 'xs',
    body: `
      <div style="margin-bottom:12px;">
        <div style="position:relative;">
          <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#9ca3af" stroke-width="1.5"
            style="position:absolute;left:10px;top:50%;transform:translateY(-50%);pointer-events:none;">
            <circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/>
          </svg>
          <input type="text" id="colorSearchInput" class="form-input" placeholder="搜索" value=""
            oninput="filterColorList(this.value)" style="padding-left:32px;">
        </div>
      </div>
      <div id="colorSelectList" style="max-height:360px;overflow-y:auto;padding-right:4px;"
        class="color-select-list">
        ${renderColorCheckboxes(currentVal, colorOptions)}
      </div>
    `,
    footer: [
      { text: '取消', class: 'btn-ghost', onClick: () => Modal.close() },
      { text: '确定', class: 'btn-primary', onClick: () => confirmColorSelection(attrIdx, valIdx, colorOptions) },
    ],
    onOpen: () => {
      const input = document.getElementById('colorSearchInput');
      if (input) {
        setTimeout(() => input.focus(), 100);
        input.addEventListener('keydown', (e) => {
          if (e.key === 'Enter') e.preventDefault();
        });
      }
    }
  });
}

/** 渲染颜色复选框列表（支持 API 字典值和 OZON_COLORS） */
function renderColorCheckboxes(currentVal, colorOptions) {
  const options = colorOptions || OZON_COLORS.map(c => ({ value_id: null, value_zh: c.zh, value_ru: c.ru, value: `${c.zh}（${c.ru}）` }));
  const items = options.map((c, idx) => {
    const zh = c.value_zh || c.zh || '';
    const ru = c.value_ru || c.ru || '';
    const vid = c.value_id || '';
    const label = `${zh}（${ru}）`;
    const isChecked = currentVal === zh || currentVal === label;
    return `
      <label class="color-check-item" data-index="${idx}" data-zh="${zh}" data-ru="${ru}" data-vid="${vid}"
        style="display:flex;align-items:center;gap:6px;padding:5px 4px;font-size:13px;color:#333;cursor:pointer;border-radius:3px;width:100%;box-sizing:border-box;"
        onmouseenter="this.style.background='#f5f5f5'" onmouseleave="this.style.background=''">
        <input type="checkbox" class="color-check-box" data-zh="${zh}" data-vid="${vid}" ${isChecked ? 'checked' : ''}
          style="accent-color:#0891b2;width:15px;height:15px;margin:0;flex-shrink:0;"
          onchange="handleColorCheckChange(this)">
        <span style="white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${label}</span>
      </label>
    `;
  }).join('');

  return `
    <label style="display:flex;align-items:center;gap:6px;padding:8px 0;font-size:13px;color:#333;cursor:pointer;border-bottom:1px solid #eee;margin-bottom:4px;"
      onmouseenter="this.querySelector('span').style.color='#0891b2'" onmouseleave="this.querySelector('span').style.color='#333'">
      <input type="checkbox" id="colorSelectAll" style="accent-color:#0891b2;width:15px;height:15px;margin:0;" onchange="toggleColorSelectAll(this.checked)">
      <span>全选</span>
    </label>
    <div style="display:grid;grid-template-columns:repeat(2,1fr);gap:0;">${items}</div>
  `;
}

/** 全选/取消全选 */
function toggleColorSelectAll(checked) {
  document.querySelectorAll('.color-check-box').forEach(cb => {
    // 只显示的项才操作
    const item = cb.closest('.color-check-item');
    if (item && item.style.display !== 'none') {
      cb.checked = checked;
    }
  });
}

/** 过滤颜色列表 */
function filterColorList(keyword) {
  const kw = (keyword || '').toLowerCase().trim();
  const items = document.querySelectorAll('.color-check-item');
  items.forEach(item => {
    const zh = item.dataset.zh?.toLowerCase() || '';
    const ru = item.dataset.ru?.toLowerCase() || '';
    item.style.display = (!kw || zh.includes(kw) || ru.includes(kw)) ? '' : 'none';
  });
}

/** 处理单个 checkbox 变化 */
function handleColorCheckChange(checkbox) {
  // 多选模式，不做自动取消
}

/** 确认颜色选择（多选时全部更新到当前输入框，存储 value_id） */
function confirmColorSelection(attrIdx, valIdx, colorOptions) {
  const checked = document.querySelectorAll('.color-check-box:checked');
  if (checked.length === 0) {
    Toast.show('请选择至少一个颜色', 'warning');
    return;
  }

  const options = colorOptions || OZON_COLORS.map(c => ({ value_id: null, value_zh: c.zh, value_ru: c.ru, value: `${c.zh}（${c.ru}）` }));

  // 收集选中的颜色文本和 value_id
  const selectedNames = Array.from(checked).map(cb => cb.dataset.zh);
  const selectedColorStr = selectedNames.map(name => {
    const found = options.find(c => (c.value_zh || c.zh) === name);
    return found ? (found.value || `${name}（${found.value_ru || found.ru || ''}）`) : name;
  }).join(', ');

  // 存储颜色文本和 value_id
  window._skuAttrs[attrIdx].values[valIdx] = selectedColorStr;
  if (!window._skuAttrs[attrIdx].valueIds) window._skuAttrs[attrIdx].valueIds = [];
  // 多选时收集所有选中的 value_id
  const selectedVids = Array.from(checked).map(cb => cb.dataset.vid ? parseInt(cb.dataset.vid) : null).filter(v => v);
  window._skuAttrs[attrIdx].valueIds[valIdx] = selectedVids.length === 1 ? selectedVids[0] : selectedVids;

  Modal.close();
  generateSkuTable();
  renderSkuAttrs();
}

/** 渲染颜色样本（根据 SKU 颜色属性动态生成） */
function renderColorSamples() {
  const grid = document.getElementById('colorSampleGrid');
  if (!grid) return;

  // 从销售属性中查找颜色类型属性
  const colorAttr = (Array.isArray(window._skuAttrs) ? window._skuAttrs : [])
    .find(a => a && a.skuType === 'color');
  const colorValues = colorAttr ? (colorAttr.values || []).filter(v => v) : [];

  if (colorValues.length === 0) {
    grid.innerHTML = '<div style="grid-column:1/-1;text-align:center;color:var(--text-tertiary);padding:24px 0;font-size:13px;">请先在"类目&属性"中添加商品颜色，颜色样本将自动生成</div>';
    return;
  }

  // SVG 图标复用
  const iconView = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="9" cy="9" r="2"/><path d="m21 15-3.086-3.086a2 2 0 0 0-2.828 0L6 21"/></svg>';
  const iconAi = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11.017 2.814a1 1 0 0 1 1.966 0l1.051 5.558a2 2 0 0 0 1.594 1.594l5.558 1.051a1 1 0 0 1 0 1.966l-5.558 1.051a2 2 0 0 0-1.594 1.594l-1.051 5.558a1 1 0 0 1-1.966 0l-1.051-5.558a2 2 0 0 0-1.594-1.594l-5.558-1.051a1 1 0 0 1 0-1.966l5.558-1.051a2 2 0 0 0 1.594-1.594z"/><path d="M20 2v4M22 4h-4"/><circle cx="4" cy="20" r="2"/></svg>';
  const iconEdit = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21.174 6.812a1 1 0 0 0-3.986-3.987L3.842 16.174a2 2 0 0 0-.5.83l-1.321 4.352a.5.5 0 0 0 .623.622l4.353-1.32a2 2 0 0 0 .83-.497z"/><path d="m15 5 4 4"/></svg>';
  const iconDel = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10 11v6M14 11v6M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6M3 6h18M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>';
  const iconMain = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg>';

  // 从采集数据中按颜色提取图片（每个颜色仅取一张代表图）
  const colorImageMap = {};
  const product = window._editingProduct || {};
  // 优先从 skuList 中按颜色提取图片
  if (Array.isArray(product.skuList)) {
    product.skuList.forEach(sku => {
      if (sku.color && sku.image && !colorImageMap[sku.color]) {
        colorImageMap[sku.color] = sku.image;
      }
    });
  }
  // 从用户上传的 SKU 图片中按颜色提取（用户上传优先级最高，覆盖采集图）
  if (colorAttr && Array.isArray(window._lastCombos)) {
    window._lastCombos.forEach((combo, idx) => {
      const colorVal = combo[colorAttr.name];
      if (colorVal && window._skuImages[idx] && window._skuImages[idx].length > 0) {
        colorImageMap[colorVal] = window._skuImages[idx][0];
      }
    });
  }
  // 产品主图来源
  const productImages = Array.isArray(product.images) ? product.images : [];

  // 用于追踪已使用的 fallback 图片索引，避免多个颜色复用同一张
  const usedFallbackIdx = new Set();

  // 颜色名匹配辅助：处理"中文（俄语）"格式与原始颜色名的匹配
  const matchColorImage = (colorName) => {
    // 1. 精确匹配
    if (colorImageMap[colorName]) return colorImageMap[colorName];
    // 2. 提取括号前的中文名再匹配（处理"中文（俄语）"格式）
    const zhName = colorName.split(/[（(]/)[0].trim();
    if (zhName && zhName !== colorName && colorImageMap[zhName]) return colorImageMap[zhName];
    // 3. 模糊匹配：skuList 中的 color 包含 colorName 或反向
    for (const key of Object.keys(colorImageMap)) {
      if (key && colorName && (key.includes(colorName) || colorName.includes(key))) {
        return colorImageMap[key];
      }
      if (zhName && key && (key.includes(zhName) || zhName.includes(key))) {
        return colorImageMap[key];
      }
    }
    return '';
  };

  const cards = colorValues.map((colorName, i) => {
    const isFirst = i === 0;
    // 1. 优先从颜色匹配 SKU 颜色图
    let imgUrl = matchColorImage(colorName);
    // 2. 回退：从产品主图中按序选用（避免重复使用同一张）
    if (!imgUrl) {
      for (let pi = 0; pi < productImages.length; pi++) {
        if (!usedFallbackIdx.has(pi)) {
          usedFallbackIdx.add(pi);
          imgUrl = productImages[pi];
          break;
        }
      }
    }
    const imgHtml = imgUrl
      ? `<img src="${escapeAttr(proxyImage(imgUrl))}" alt="${escapeAttr(colorName)}" class="color-sample-img" loading="lazy" referrerpolicy="no-referrer" onerror="this.style.display='none';this.nextElementSibling.style.display='flex';">
         <div class="color-sample-placeholder" style="width:100%;height:100%;display:none;align-items:center;justify-content:center;background:var(--bg-input);color:var(--text-tertiary);font-size:12px;">${escapeHtml(colorName)}</div>`
      : `<div class="color-sample-placeholder" style="width:100%;height:100%;display:flex;align-items:center;justify-content:center;background:var(--bg-input);color:var(--text-tertiary);font-size:12px;">${escapeHtml(colorName)}</div>`;
    return `
    <div class="color-sample-card${isFirst ? ' cs-selected' : ''}">
      <label class="cs-card-check"><input type="checkbox" ${isFirst ? 'checked' : ''} class="cs-check-input"></label>
      ${isFirst ? '<span class="cs-badge-main">主图</span>' : ''}
      <div class="color-sample-img-wrap">
        ${imgHtml}
      </div>
      <div class="color-sample-label">${escapeHtml(colorName)}</div>
      <div class="cs-action-bar">
        <button class="cs-action-btn" title="查看大图">${iconView}</button>
        <button class="cs-action-btn" title="AI优化">${iconAi}</button>
        <button class="cs-action-btn" title="编辑">${iconEdit}</button>
        <button class="cs-action-btn cs-action-del" title="删除">${iconDel}</button>
        <button class="cs-action-btn" title="设为主图">${iconMain}</button>
      </div>
    </div>`;
  }).join('');

  // 添加新图片卡片
  const addCard = `
    <div class="color-sample-card cs-add-card">
      <div class="cs-add-wrap">
        <div class="cs-add-icon">
          <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12h14"></path><path d="M12 5v14"></path></svg>
        </div>
        <span class="cs-add-text">添加新图片</span>
        <span class="cs-add-hint">支持 JPG/PNG，最大10MB</span>
      </div>
    </div>`;

  grid.innerHTML = cards + addCard;
}

/** 渲染销售属性列表 */
function renderSkuAttrs() {
  const container = document.getElementById('skuAttrList');
  if (!container) return;
  if (!Array.isArray(window._skuAttrs)) window._skuAttrs = [];

  // 同步更新颜色样本
  renderColorSamples();

  if (window._skuAttrs.length === 0) {
    container.innerHTML = '<div style="text-align:center;color:var(--text-tertiary);padding:12px 0;font-size:13px;">暂无销售属性，点击下方按钮添加</div>';
    return;
  }

  // 找到相邻的Ozon类目属性对（商品颜色 + 颜色名称），合并为一张卡片
  const colorAttrIdx = window._skuAttrs.findIndex(a => a.skuType === 'color');
  const textAttrIdx = window._skuAttrs.findIndex((a, i) => i !== colorAttrIdx && a.skuType === 'text');

  container.innerHTML = window._skuAttrs.map((attr, i) => {
    const skuType = attr.skuType || 'default';

    // ===== 跳过颜色名称，它合并在商品颜色卡片中渲染 =====
    if (i === textAttrIdx && colorAttrIdx >= 0) return '';

    // ===== SKU信息属性（无字典，按SKU填写）：不渲染卡片，作为表格列处理 =====
    // 仅适用于自动识别的 is_aspect=1 + dictionary_id=0 属性（如长度、重量等）
    // 件数/颜色名称虽有 attrCategory='info'，但保留原有 skuType（number/text）继续渲染卡片
    if (skuType === 'info') return '';

    // ===== 件数类型：多个数字输入框 + 添加选项 =====
    if (skuType === 'number') {
      const descTip = attr.description ? `<span class="label-tooltip" title="${attr.description.replace(/"/g, '&quot;')}">?</span>` : '';
      const requiredMark = attr.required ? '<span class="required">*</span>' : '';
      const numValues = attr.values.length > 0 ? attr.values : [''];
      return `
      <div style="border:1px solid #d4e8f0;border-radius:8px;margin-bottom:12px;background:#fff;overflow:hidden;">
        <!-- 标题栏 -->
        <div style="display:flex;align-items:center;justify-content:space-between;padding:10px 14px;background:#f0f9ff;">
          <span style="font-size:13px;font-weight:500;color:#333;">规格${i + 1}：<span style="color:#0891b2;">${attr.name || '未命名'}</span> ${requiredMark} ${descTip}</span>
          <button onclick="removeSkuAttr(${i})" style="background:none;border:none;color:#0891b2;cursor:pointer;font-size:12px;padding:2px 6px;white-space:nowrap;" title="操作">
            -- 操作
          </button>
        </div>
        <!-- 内容区 -->
        <div style="padding:16px 20px;" class="sku-attr-values-area">
          <!-- 输入区：每个值一个输入框 -->
          <div>
            <div style="font-size:12px;color:#666;margin-bottom:4px;">${attr.name || '未命名'} ${requiredMark} ${descTip}</div>
            ${numValues.map((v, vi) => `
            <div style="display:flex;align-items:center;gap:6px;margin-bottom:6px;">
              <input type="number" min="1" class="form-input" placeholder="${attr.ozonType || 'Integer'}" value="${v}" style="flex:1;padding:8px 12px;font-size:13px;border-radius:6px;border:1px solid var(--border-color);" oninput="updateNumberSkuValue(${i}, ${vi}, this.value)" onkeydown="if(event.key==='Enter'){event.preventDefault();addNumberSkuValue(${i})}">
              <button onclick="removeSkuAttrValue(${i}, ${vi})" style="background:none;border:none;cursor:pointer;color:#94a3b8;padding:4px;flex-shrink:0;display:inline-flex;align-items:center;" title="删除">
                <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18"/><path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6"/><path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2"/></svg>
              </button>
            </div>
            `).join('')}
          </div>
        </div>
        <!-- 底部添加选项 -->
        <div style="text-align:center;padding:10px 0;border-top:1px solid #f5f5f5;">
          <button onclick="addNumberSkuValue(${i})" style="background:none;border:none;color:#06b6d4;cursor:pointer;font-size:13px;white-space:nowrap;padding:2px 10px;">+ 添加选项</button>
        </div>
      </div>`;
    }

    // ===== 颜色类型 + 颜色名称 合并卡片（多输入框模式）=====
    if (skuType === 'color') {
      const descTipC = attr.description ? `<span class="label-tooltip" title="${attr.description.replace(/"/g, '&quot;')}">?</span>` : '';
      const collectionMark = attr.isCollection ? ' <span style="font-size:11px;color:#999;">（可多选）</span>' : '';
      const textPartner = textAttrIdx >= 0 ? window._skuAttrs[textAttrIdx] : null;
      const descTipT = textPartner?.description ? `<span class="label-tooltip" title="${textPartner.description.replace(/"/g, '&quot;')}">?</span>` : '';
      const partnerLabel = textPartner?.name || '颜色名称';
      const mergedTitle = `${attr.name}${textPartner ? ' / ' + partnerLabel : ''}`;

      const colorValues = attr.values.length > 0 ? attr.values : [''];
      const textValues = textPartner ? (textPartner.values.length > 0 ? textPartner.values : ['']) : [''];

      return `
      <div style="border:1px solid #d4e8f0;border-radius:8px;margin-bottom:12px;background:#fff;overflow:hidden;">
        <!-- 标题栏 -->
        <div style="display:flex;align-items:center;justify-content:space-between;padding:10px 14px;background:#f0f9ff;">
          <span style="font-size:13px;font-weight:500;color:#333;">规格${i + 1}：<span style="color:#0891b2;">${mergedTitle}</span></span>
          <button onclick="removeSkuAttr(${i});${textAttrIdx >= 0 ? `removeSkuAttr(${textAttrIdx})` : ''}" style="background:none;border:none;color:#06b6d4;cursor:pointer;font-size:12px;padding:2px 6px;white-space:nowrap;" title="移除">
            -- 移除
          </button>
        </div>
        <!-- 内容区 -->
        <div style="padding:16px 20px;" class="sku-attr-values-area">
          <!-- 列标题 -->
          <div style="display:flex;gap:20px;margin-bottom:6px;">
            <div style="flex:1;min-width:0;font-size:12px;color:#666;">${attr.name}${collectionMark} ${descTipC}</div>
            <div style="flex:1;min-width:0;font-size:12px;color:#666;">${partnerLabel} ${descTipT}</div>
          </div>
          <!-- 每组值一个输入框行 -->
          ${colorValues.map((v, vi) => `
          <div style="display:flex;gap:20px;align-items:center;margin-bottom:6px;">
            <!-- 左列：商品颜色输入框 + 选择按钮 -->
            <div style="flex:1;min-width:0;display:flex;align-items:center;gap:6px;">
              <input type="text" class="form-input" placeholder="请选择" value="${v}" style="flex:1;padding:7px 10px;font-size:13px;border-radius:6px;border:1px solid var(--border-color);" oninput="updateColorSkuValue(${i}, ${vi}, this.value)">
              <button onclick="openColorPickerModal(${i}, ${vi})" title="选择颜色" style="padding:7px 10px;border-radius:6px;border:1px solid var(--border-color);background:var(--bg-primary);cursor:pointer;display:inline-flex;align-items:center;justify-content:center;color:#0891b2;flex-shrink:0;">
                <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#0891b2" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z"/><path d="m15 5 4 4"/></svg>
              </button>
            </div>
            <!-- 右列：颜色名称输入框 + 删除按钮 -->
            <div style="flex:1;min-width:0;display:flex;align-items:center;gap:6px;">
              <input type="text" class="form-input" placeholder="${textPartner?.ozonType || 'String'}" value="${textValues[vi] || ''}" style="flex:1;padding:7px 10px;font-size:13px;border-radius:6px;border:1px solid var(--border-color);" oninput="updateTextSkuValue(${textAttrIdx}, ${vi}, this.value)">
              <button onclick="removeCombinedSkuValue(${i}, ${textAttrIdx}, ${vi})" style="background:none;border:none;cursor:pointer;color:#94a3b8;padding:4px;flex-shrink:0;display:inline-flex;align-items:center;" title="删除">
                <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18"/><path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6"/><path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2"/></svg>
              </button>
            </div>
          </div>
          `).join('')}
        </div>
        <!-- 底部添加选项 -->
        <div style="text-align:center;padding:10px 0;border-top:1px solid #f5f5f5;">
          <button onclick="addCombinedSkuValue(${i},${textAttrIdx})" style="background:none;border:none;color:#06b6d4;cursor:pointer;font-size:13px;white-space:nowrap;padding:2px 10px;">+ 添加选项</button>
        </div>
      </div>`;
    }

    // ===== 文本类型（独立渲染，未被颜色卡片合并时）=====
    if (skuType === 'text') {
      // 如果已被颜色卡片合并则跳过
      if (colorAttrIdx >= 0 && i === textAttrIdx) return '';
      const descTip = attr.description ? `<span class="label-tooltip" title="${attr.description.replace(/"/g, '&quot;')}">?</span>` : '';
      const requiredMark = attr.required ? '<span class="required">*</span>' : '';
      return `
      <div style="border:1px solid #d4e8f0;border-radius:8px;margin-bottom:12px;background:#fff;overflow:hidden;">
        <div style="display:flex;align-items:center;justify-content:space-between;padding:10px 14px;background:#f0f9ff;">
          <span style="font-size:13px;font-weight:500;color:#333;">规格${i + 1}：<span style="color:#0891b2;">${attr.name || '未命名'}</span> ${requiredMark} ${descTip}</span>
          <button onclick="removeSkuAttr(${i})" style="background:none;border:none;color:#0891b2;cursor:pointer;font-size:12px;padding:2px 6px;" title="移除">移除</button>
        </div>
        <div style="padding:16px 20px;" class="sku-attr-values-area">
          ${attr.values.length > 0 ? `
          <div style="display:flex;flex-wrap:wrap;gap:6px;margin-bottom:10px;">
            ${attr.values.map((v, vi) => `
            <span style="display:inline-flex;align-items:center;gap:4px;padding:3px 8px;border-radius:4px;background:#eff6ff;border:1px solid #bfdbfe;font-size:12px;color:#1d4ed8;">
              ${v}
              <button onclick="removeSkuAttrValue(${i}, ${vi})" style="background:none;border:none;cursor:pointer;color:#94a3b8;padding:0;line-height:1;display:inline-flex;" title="删除">×</button>
            </span>
            `).join('')}
          </div>` : ''}
          <input type="text" id="skuValueInput_${i}" class="form-input" placeholder="${attr.ozonType || '请输入'}" style="width:100%;padding:8px 12px;font-size:13px;border-radius:6px;border:1px solid var(--border-color);" onkeydown="if(event.key==='Enter'){event.preventDefault();addSkuAttrValueForType(${i})}">
        </div>
        <div style="text-align:center;padding:10px 0;border-top:1px solid #f5f5f5;">
          <button onclick="addSkuAttrValueForType(${i})" style="background:none;border:none;color:#06b6d4;cursor:pointer;font-size:13px;white-space:nowrap;padding:2px 10px;">+ 添加选项</button>
        </div>
      </div>`;
    }

    // ===== 默认类型 =====
    return `
    <div style="border:1px solid #d4e8f0;border-radius:8px;margin-bottom:12px;background:#fff;overflow:hidden;">
      <div style="display:flex;align-items:center;justify-content:space-between;padding:10px 14px;background:#f0f9ff;">
        <span style="font-size:13px;font-weight:500;color:#333;">规格${i + 1}：<span style="color:#0891b2;">${attr.name || '未命名'}</span></span>
        <button onclick="document.getElementById('skuNameEditWrap_${i}').style.display='block';setTimeout(()=>{const el=document.getElementById('skuNameEdit_${i}');el.focus();el.select();},0)" style="background:none;border:none;color:#0891b2;cursor:pointer;font-size:13px;padding:2px 8px;">修改</button>
      </div>
      <div style="padding:16px 20px;" class="sku-attr-values-area">
        ${attr.values.map((v, vi) => `
        <div style="display:flex;align-items:center;justify-content:space-between;padding:6px 10px;margin-bottom:6px;border-radius:4px;border:1px solid #e5e7eb;background:#fafafa;">
          <span style="font-size:13px;color:#333;">${formatColorLabel(v)}</span>
          <button onclick="removeSkuAttrValue(${i}, ${vi})" style="background:none;border:none;cursor:pointer;color:#94a3b8;padding:2px 6px;" title="删除">
            <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#94a3b8" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18"/><path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6"/><path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2"/></svg>
          </button>
        </div>
        `).join('')}
        <div style="margin-top:8px;text-align:center;">
          <button onclick="addBlankSkuAttrValue(${i})" style="background:none;border:none;color:#06b6d4;cursor:pointer;font-size:13px;white-space:nowrap;padding:2px 10px;">+ 添加选项</button>
        </div>
      </div>
    </div>`;
  }).filter(h => h).join('');
}

/** 颜色选择器确认后，同步填充颜色名称 */
function onSkuColorSelected(colorIdx, colorName) {
  const textInput = document.getElementById(`skuTextInput_${colorIdx}`);
  if (!textInput || !colorName) return;
  // 自动填充俄语名称作为默认颜色名（仅当输入框为空时）
  if (!textInput.value.trim()) {
    const found = OZON_COLORS.find(c => c.zh === colorName);
    textInput.value = found ? found.ru : colorName;
  }
}

/** 组合添加：新增一组空的商品颜色和颜色名称输入框 */
function addCombinedSkuValue(colorIdx, textIdx) {
  const colorAttr = window._skuAttrs[colorIdx];
  if (!colorAttr) return;

  colorAttr.values.push('');
  if (!colorAttr.valueIds) colorAttr.valueIds = [];
  colorAttr.valueIds.push(null);
  if (textIdx >= 0 && window._skuAttrs[textIdx]) {
    window._skuAttrs[textIdx].values.push('');
  }

  renderSkuAttrs();
  // 聚焦新添加的商品颜色输入框
  setTimeout(() => {
    const area = document.querySelector('.sku-attr-values-area');
    if (area) {
      const inputs = area.querySelectorAll('input[placeholder="请选择"]');
      if (inputs.length > 0) inputs[inputs.length - 1].focus();
    }
  }, 0);
}

/** 更新商品颜色输入框值（手动输入时清除 value_id，因为不再匹配字典值） */
function updateColorSkuValue(attrIdx, valIdx, val) {
  if (window._skuAttrs[attrIdx]) {
    window._skuAttrs[attrIdx].values[valIdx] = val;
    // 手动输入时清除 value_id
    if (!window._skuAttrs[attrIdx].valueIds) window._skuAttrs[attrIdx].valueIds = [];
    window._skuAttrs[attrIdx].valueIds[valIdx] = null;
    generateSkuTable();
  }
}

/** 更新颜色名称输入框值 */
function updateTextSkuValue(attrIdx, valIdx, val) {
  if (attrIdx >= 0 && window._skuAttrs[attrIdx]) {
    window._skuAttrs[attrIdx].values[valIdx] = val;
    generateSkuTable();
  }
}

/** 删除一组商品颜色和颜色名称 */
function removeCombinedSkuValue(colorIdx, textIdx, valIdx) {
  if (window._skuAttrs[colorIdx]) {
    window._skuAttrs[colorIdx].values.splice(valIdx, 1);
    if (window._skuAttrs[colorIdx].valueIds) {
      window._skuAttrs[colorIdx].valueIds.splice(valIdx, 1);
    }
  }
  if (textIdx >= 0 && window._skuAttrs[textIdx]) {
    window._skuAttrs[textIdx].values.splice(valIdx, 1);
  }
  renderSkuAttrs();
  generateSkuTable();
}

/** 生成 SKU 笛卡尔组合表 */
function generateSkuTable() {
  const wrap = document.getElementById('skuTableWrap');
  if (!wrap) return;

  // 属性分类：
  // - salesAttrs（销售属性，有字典，参与笛卡尔积）：商品颜色、尺码等
  // - infoAttrs（SKU信息，无字典，按SKU填写）：长度、重量、件数、颜色名称等
  // - legacyAttrs（兼容旧数据，无 attrCategory 但有值）：按销售属性处理参与笛卡尔积
  // 笛卡尔积仅使用 salesAttrs + legacyAttrs；infoAttrs 作为表格输入列
  const allSkuAttrs = (Array.isArray(window._skuAttrs) ? window._skuAttrs : [])
    .map(a => ({ ...a, values: (a.values || []).filter(v => v !== '') }));

  const salesAttrs = allSkuAttrs.filter(a =>
    a.name && a.attrCategory === 'sales' && a.values.length > 0
  );
  const legacyAttrs = allSkuAttrs.filter(a =>
    a.name && !a.attrCategory && a.values.length > 0
  );
  // SKU信息属性：跳过 件数/颜色名称（它们由卡片UI管理，不在表格中显示）
  const INFO_ATTR_SKIP_KEYWORDS = ['一个商品中的件数', '颜色名称', 'название цвета', 'color name'];
  const infoAttrs = allSkuAttrs.filter(a =>
    a.name && a.attrCategory === 'info' &&
    !INFO_ATTR_SKIP_KEYWORDS.some(kw => a.name.toLowerCase().includes(kw.toLowerCase()))
  );

  // 笛卡尔积属性 = 销售属性 + 兼容旧数据
  const cartesianAttrs = [...salesAttrs, ...legacyAttrs];
  // 表格列属性 = 笛卡尔积属性（display）+ SKU信息属性（input）
  const tableAttrs = [...cartesianAttrs, ...infoAttrs];

  // 兼容旧变量名（后续代码引用 attrs）
  const attrs = cartesianAttrs;

  // 无销售属性时，渲染单 SKU 表格（仅通用列：价格/库存/货号等，不依赖类目）
  // combos 保持为 [{}]，后续逻辑会渲染单行表格

  // 笛卡尔积
  let combos = [{}];
  attrs.forEach(attr => {
    const next = [];
    combos.forEach(combo => {
      attr.values.forEach(v => {
        next.push({ ...combo, [attr.name]: v });
      });
    });
    combos = next;
  });

  // Ozon collection already provides authoritative SKU combinations. Rebuilding
  // those rows as a Cartesian product creates variants that never existed.
  const savedOzonSkus = window._editingProduct?.platform === 'ozon' && Array.isArray(window._editingProduct?.skus)
    ? window._editingProduct.skus : [];
  const savedOzonCombos = savedOzonSkus
    .map(sku => sku?.combo && typeof sku.combo === 'object' ? { ...sku.combo } : null)
    .filter(combo => combo && Object.keys(combo).length > 0);
  if (savedOzonCombos.length === savedOzonSkus.length && savedOzonCombos.length > 0) {
    const seenSavedCombos = new Set();
    combos = savedOzonCombos.filter(combo => {
      const signature = Object.keys(combo).sort().map(key => `${key}:${combo[key]}`).join('||');
      if (seenSavedCombos.has(signature)) return false;
      seenSavedCombos.add(signature);
      return true;
    });
  }

  // 限制最多 50 个 SKU
  if (combos.length > 50) {
    combos = combos.slice(0, 50);
  }

  // 缓存 combos 供 renderColorSamples 建立"颜色值 → SKU图片"映射
  window._lastCombos = combos;

  // 获取当前编辑商品的标题（用于SKU标题列）
  const productTitle = (document.getElementById('editTitle')?.value || '').trim();
  // 获取当前店铺币种
  const currency = getCurrentStoreCurrency();
  const currencySymbol = getCurrencySymbol(currency);

  // 已保存的 SKU 数据（用于回填）
  const savedSkus = (window._editingProduct?.skus && Array.isArray(window._editingProduct.skus))
    ? window._editingProduct.skus
    : [];
  // 构建已保存 SKU 的查找映射：
  // 指纹 = "属性名1:值1||属性名2:值2"（含属性名，避免不同属性但相同值集合时冲突）
  // 同时建立"仅值集合"作为回退 key，类目切换后属性名变化时使用
  // 注意：只保留笛卡尔积属性名（cartesianAttrs），过滤掉颜色名称等 SKU 信息属性。
  // 因为新生成的 combos 不包含颜色名称（由 INFO_ATTR_SKIP_KEYWORDS 跳过），
  // 若不过滤会导致 savedSkuMap 的 key 包含颜色名称，与新 combos 的 key 不匹配，回填失败。
  const cartesianAttrNames = new Set(cartesianAttrs.map(a => a.name));
  const savedSkuMap = {};
  const savedSkuFallbackMap = {};
  savedSkus.forEach(sku => {
    const combo = sku.combo || {};
    const pairs = Object.keys(combo)
      .filter(k => combo[k] !== '' && combo[k] !== null && combo[k] !== undefined)
      .filter(k => cartesianAttrNames.size === 0 || cartesianAttrNames.has(k))
      .map(k => `${k}:${combo[k]}`)
      .sort();
    const namedKey = pairs.join('||');
    const valuesOnlyKey = pairs.map(p => p.split(':')[1]).join('||');
    // 空 combo（单 SKU 场景）也允许作为独立 key，但用 __single__ 标记避免被覆盖
    const finalKey = namedKey || '__single__';
    savedSkuMap[finalKey] = sku;
    // 仅在非空 combo 时建立回退映射
    if (valuesOnlyKey) {
      savedSkuFallbackMap[valuesOnlyKey] = savedSkuFallbackMap[valuesOnlyKey] || sku;
    }
  });

  // 从已保存的SKU数据回填图片到 window._skuImages
  // 同时也从采集的 skuList 中按颜色回填图片
  const skuList = (window._editingProduct?.skuList && Array.isArray(window._editingProduct.skuList))
    ? window._editingProduct.skuList
    : [];
  // 构建 skuList 颜色 → 图片映射
  const skuListColorImageMap = {};
  skuList.forEach(s => {
    if (s.color && s.image && !skuListColorImageMap[s.color]) {
      skuListColorImageMap[s.color] = s.image;
    }
  });
  // 构建属性名到颜色属性的映射
  const colorAttrName = attrs.find(a => a.skuType === 'color')?.name || '';

  // 产品主图来源（直接使用 product.images）
  const productImagesSource = Array.isArray(window._editingProduct?.images)
    ? window._editingProduct.images
    : [];

  // 颜色名匹配辅助：处理"中文（俄语）"格式与原始颜色名的匹配
  const matchColorImageForSku = (colorName) => {
    if (!colorName) return '';
    // 1. 精确匹配
    if (skuListColorImageMap[colorName]) return skuListColorImageMap[colorName];
    // 2. 提取括号前的中文名再匹配
    const zhName = colorName.split(/[（(]/)[0].trim();
    if (zhName && zhName !== colorName && skuListColorImageMap[zhName]) return skuListColorImageMap[zhName];
    // 3. 模糊匹配
    for (const key of Object.keys(skuListColorImageMap)) {
      if (key && colorName && (key.includes(colorName) || colorName.includes(key))) {
        return skuListColorImageMap[key];
      }
      if (zhName && key && (key.includes(zhName) || zhName.includes(key))) {
        return skuListColorImageMap[key];
      }
    }
    return '';
  };

  combos.forEach((combo, i) => {
    // 如果已经有图片（之前会话添加的），不覆盖
    if (window._skuImages[i] && window._skuImages[i].length > 0) return;

    // 与构建 savedSkuMap 时一致的指纹算法
    const pairs = Object.keys(combo)
      .filter(k => combo[k] !== '' && combo[k] !== null && combo[k] !== undefined)
      .map(k => `${k}:${combo[k]}`)
      .sort();
    const comboKey = pairs.join('||') || '__single__';
    const comboFallbackKey = pairs.map(p => p.split(':')[1]).join('||');
    const savedSku = savedSkuMap[comboKey] || (comboFallbackKey ? savedSkuFallbackMap[comboFallbackKey] : undefined);

    // 优先从已保存的SKU数据回填
    // 注意：已保存的 SKU 图片可能不完整（旧数据/单张颜色图），需补齐产品主图，
    // 否则编辑时只能看到 1 张图，无法管理其余产品图片。
    if (savedSku && Array.isArray(savedSku.images) && savedSku.images.length > 0) {
      const merged = [...savedSku.images];
      productImagesSource.forEach(url => {
        if (url && !merged.includes(url)) merged.push(url);
      });
      window._skuImages[i] = merged.slice(0, 30);
      return;
    }

    // 回退：组装图片 = 颜色匹配图（如有，作为主图） + 全部产品主图（去重）
    const colorVal = colorAttrName ? combo[colorAttrName] : '';
    const colorImg = matchColorImageForSku(colorVal);
    const result = [];
    if (colorImg) result.push(colorImg);
    // 追加所有产品主图（去重），确保采集的图片完全显示
    productImagesSource.forEach(url => {
      if (url && !result.includes(url)) result.push(url);
    });
    if (result.length > 0) {
      // SKU图片最多30张
      window._skuImages[i] = result.slice(0, 30);
    }
  });

  console.log('[generateSkuTable] SKU匹配调试:', {
    'attrs数量': attrs.length,
    'attrs名称': attrs.map(a => a.name),
    'combos数量': combos.length,
    'savedSkus数量': savedSkus.length,
    'savedSkuMap键(名值指纹)': Object.keys(savedSkuMap),
    'combos键(名值指纹)': combos.map(combo => {
      const pairs = Object.keys(combo).filter(k => combo[k]).map(k => `${k}:${combo[k]}`).sort();
      return pairs.join('||') || '__single__';
    }),
    '匹配结果': combos.map(combo => {
      const pairs = Object.keys(combo).filter(k => combo[k]).map(k => `${k}:${combo[k]}`).sort();
      const key = pairs.join('||') || '__single__';
      return { key, matched: !!savedSkuMap[key] };
    }),
  });

  // 表头定义：动态生成SKU属性列 + 固定列
  // tableAttrs 包含 salesAttrs（display）+ infoAttrs（input）
  const skuAttrHeaders = tableAttrs.map(attr => ({
    name: attr.name + (attr.attrCategory === 'info' ? ' *' : ''),
    batch: false,
  }));
  const headerDefs = [
    { name: 'SKU标题', batch: false },
    ...skuAttrHeaders,
    { name: '货源价格', batch: true, field: 'source-price', unit: '¥' },
    { name: '售价', batch: true, field: 'price', unit: currencySymbol },
    { name: '划线价', batch: true, field: 'old-price', unit: currencySymbol },
    { name: '库存', batch: true, field: 'stock', unit: '' },
    { name: '包裹重量', batch: true, field: 'weight', unit: 'g' },
    { name: '包裹尺寸', batch: true, field: 'dims', unit: 'cm' },
    { name: '平台SKU', batch: false, auto: true },
    { name: '操作', batch: false },
  ];

  let html = `<div style="overflow-x:auto;border:1px solid var(--border-color);border-radius:8px;">
    <table class="sku-table" style="width:100%;font-size:13px;min-width:1100px;">
      <thead>
        <tr style="background:#f8f9fb;">
          ${headerDefs.map((h, hi) => {
            let cls = '';
            let stickyInline = '';
            if (hi === 0) {
              cls = ' sku-table__sticky-left';
              stickyInline = 'position:sticky;left:0;';
            } else if (hi === headerDefs.length - 1) {
              cls = ' sku-table__sticky-right';
              stickyInline = 'position:sticky;right:0;';
            }
            return `<th class="sku-table__sticky-col${cls}" style="${stickyInline}padding:8px 10px;text-align:left;border-bottom:1px solid var(--border-color);white-space:nowrap;font-weight:600;color:var(--text-secondary);background:#f8f9fb;">${h.name}${h.batch ? ` <a href="javascript:;" onclick="showBatchCard('${h.field}','${h.name}','${h.unit}')" style="font-size:11px;font-weight:400;color:var(--primary-color,#2563EB);margin-left:4px;">批量</a>` : ''}${h.auto ? ` <a href="javascript:;" onclick="autoGenerateSkuCodes()" style="font-size:11px;font-weight:400;color:var(--primary-color,#2563EB);margin-left:4px;">自动</a>` : ''}</th>`;
          }).join('')}
        </tr>
      </thead>
      <tbody>
        ${combos.map((combo, i) => {
          // 查找已保存的 SKU 数据（用"属性名:值"指纹匹配；回退到值指纹，避免类目切换后属性名变化导致匹配失败）
          const pairs = Object.keys(combo)
            .filter(k => combo[k] !== '' && combo[k] !== null && combo[k] !== undefined)
            .map(k => `${k}:${combo[k]}`)
            .sort();
          const comboKey = pairs.join('||') || '__single__';
          const comboFallbackKey = pairs.map(p => p.split(':')[1]).join('||');
          const savedSku = savedSkuMap[comboKey] || (comboFallbackKey ? savedSkuFallbackMap[comboFallbackKey] : {}) || {};

          // Keep the full product title in persisted SKU rows. The previous
          // UI truncation leaked into saved data and produced malformed Ozon
          // titles such as "..." instead of the real product name.
          const skuTitle = productTitle || savedSku.title || ('SKU ' + (i + 1));
          // 货源价 = 1688 采集价格（CNY），优先使用SKU自身货源价，回退到商品级货源价
          const sourcePrice = savedSku.sourcePrice || window._editingProduct?.sourcePrice || '';
          // 售价/划线价：优先使用已保存的值，否则从货源价自动计算（Ozon 售价 = 货源价 × 汇率 × 利润系数）
          const autoCalc = sourcePrice ? calcPriceFromSource(parseFloat(sourcePrice)) : { price: 0, oldPrice: 0 };
          const skuPrice = savedSku.price || autoCalc.price || '';
          const skuOldPrice = savedSku.oldPrice || autoCalc.oldPrice || '';
          const skuStock = savedSku.stock || '';
          const weight = savedSku.weight || window._editingProduct?.weight || '';
          const length = savedSku.length || window._editingProduct?.length || '';
          const width = savedSku.width || window._editingProduct?.width || '';
          const height = savedSku.height || window._editingProduct?.height || '';
          const skuCode = savedSku.skuCode || '';
          // 动态生成SKU属性列：销售属性=显示单元格，SKU信息属性=输入框
          const skuAttrCells = tableAttrs.map(attr => {
            if (attr.attrCategory === 'info') {
              // SKU信息属性：每行独立输入框（不参与笛卡尔积）
              const savedInfoVal = savedSku?.combo?.[attr.name] || '';
              const isNumeric = ['Integer', 'Float', 'Decimal', 'Double'].includes(attr.ozonType);
              const inputType = isNumeric ? 'number' : 'text';
              const placeholder = attr.ozonType || '请输入';
              return `<td style="padding:6px 10px;border-bottom:1px solid var(--border-color);white-space:nowrap;">
                <input type="${inputType}" class="form-input sku-info-input" data-sku-info-row="${i}" data-sku-info-attr="${attr.attrId}" data-sku-info-name="${attr.name.replace(/"/g, '&quot;')}" value="${(savedInfoVal || '').toString().replace(/"/g, '&quot;')}" placeholder="${placeholder}" style="width:100px;padding:4px 8px;font-size:12px;">
              </td>`;
            }
            // 销售属性：显示单元格（来自combo，只读）
            const val = combo[attr.name] || '-';
            const displayVal = (attr.skuType === 'color') ? formatColorLabel(val) : val;
            return `<td data-original="${val}" style="padding:6px 10px;border-bottom:1px solid var(--border-color);white-space:nowrap;">${displayVal}</td>`;
          }).join('');
          return `
          <tr data-sku-index="${i}">
            <td class="sku-table__sticky-col sku-table__sticky-left" style="position:sticky;left:0;padding:6px 10px;border-bottom:1px solid var(--border-color);min-width:260px;background:#fff;">
              <div class="sku-title-input-wrap" data-sku-idx="${i}">
                <input type="text" class="sku-title-input" data-sku-title="${i}" value="${(skuTitle || '').replace(/"/g, '&quot;')}" placeholder="输入SKU标题" maxlength="200">
                <div class="sku-title-input__actions">
                  <button type="button" class="sku-title-ai-btn" title="AI生成标题" onclick="event.stopPropagation();">AI</button>
                  <span class="sku-title-abc-hint">Abc</span>
                  <span class="sku-title-counter"><em>${(skuTitle || '').length}</em> / 200</span>
                </div>
              </div>
            </td>
            ${skuAttrCells}
            <td style="padding:6px 10px;border-bottom:1px solid var(--border-color);white-space:nowrap;">
              <div style="display:flex;align-items:center;gap:2px;">
                <span style="color:var(--text-tertiary);font-size:12px;">¥</span>
                <input type="number" class="form-input" data-sku-source-price="${i}" value="${sourcePrice}" placeholder="0.00" style="width:80px;padding:4px 8px;font-size:12px;">
              </div>
            </td>
            <td style="padding:6px 10px;border-bottom:1px solid var(--border-color);white-space:nowrap;">
              <div style="display:flex;align-items:center;gap:2px;">
                <span style="color:var(--text-tertiary);font-size:12px;">${currencySymbol}</span>
                <input type="number" class="form-input" data-sku-price="${i}" value="${skuPrice}" placeholder="0.00" style="width:80px;padding:4px 8px;font-size:12px;">
              </div>
            </td>
            <td style="padding:6px 10px;border-bottom:1px solid var(--border-color);white-space:nowrap;">
              <div style="display:flex;align-items:center;gap:2px;">
                <span style="color:var(--text-tertiary);font-size:12px;">${currencySymbol}</span>
                <input type="number" class="form-input" data-sku-old-price="${i}" value="${skuOldPrice}" placeholder="划线价" style="width:80px;padding:4px 8px;font-size:12px;">
              </div>
            </td>
            <td style="padding:6px 10px;border-bottom:1px solid var(--border-color);white-space:nowrap;">
              <input type="number" class="form-input" data-sku-stock="${i}" value="${skuStock}" placeholder="0" style="width:70px;padding:4px 8px;font-size:12px;">
            </td>
            <td style="padding:6px 10px;border-bottom:1px solid var(--border-color);white-space:nowrap;">
              <div style="display:flex;align-items:center;gap:2px;">
                <input type="number" class="form-input" data-sku-weight="${i}" value="${weight}" placeholder="0" style="width:70px;padding:4px 8px;font-size:12px;">
                <span style="color:var(--text-tertiary);font-size:11px;">g</span>
              </div>
            </td>
            <td style="padding:6px 10px;border-bottom:1px solid var(--border-color);white-space:nowrap;">
              <div style="display:flex;align-items:center;gap:2px;">
                <input type="number" class="form-input" data-sku-length="${i}" value="${length}" placeholder="L" style="width:50px;padding:4px 6px;font-size:12px;">
                <span style="color:var(--text-tertiary);">×</span>
                <input type="number" class="form-input" data-sku-width="${i}" value="${width}" placeholder="W" style="width:50px;padding:4px 6px;font-size:12px;">
                <span style="color:var(--text-tertiary);">×</span>
                <input type="number" class="form-input" data-sku-height="${i}" value="${height}" placeholder="H" style="width:50px;padding:4px 6px;font-size:12px;">
                <span style="color:var(--text-tertiary);font-size:11px;">mm</span>
              </div>
            </td>
            <td style="padding:6px 10px;border-bottom:1px solid var(--border-color);white-space:nowrap;">
              <input type="text" class="form-input" data-sku-code="${i}" value="${skuCode}" placeholder="自动生成" style="width:110px;padding:4px 8px;font-size:12px;">
            </td>
            <td class="sku-table__sticky-col sku-table__sticky-right" style="position:sticky;right:0;padding:6px 10px;border-bottom:1px solid var(--border-color);white-space:nowrap;background:#fff;">
              <div style="display:flex;gap:4px;align-items:center;">
                <button onclick="copySkuRow(${i})" title="复制" style="background:none;border:none;cursor:pointer;color:var(--text-tertiary);padding:2px 4px;display:flex;align-items:center;">
                  <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>
                </button>
                <button onclick="deleteSkuRow(${i})" title="删除" style="background:none;border:none;cursor:pointer;color:#ef4444;padding:2px 4px;display:flex;align-items:center;">
                  <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18"/><path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6"/><path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2"/></svg>
                </button>
              </div>
            </td>
          </tr>`;
        }).join('')}
      </tbody>
    </table>
  </div>
  <div style="margin-top:6px;font-size:12px;color:var(--text-tertiary);display:flex;align-items:center;justify-content:space-between;">
    <span>共 ${combos.length} 个SKU组合 · 售价币种：${currency}</span>
  </div>`;

  wrap.innerHTML = html;

  // 初始化SKU标题字数统计 & 绑定input事件
  initSkuTitleCounters(wrap);

  // 初始化价格联动监听（货源价→售价/划线价，事件委托，只绑定一次）
  initSkuPriceListeners(wrap);

  // 同步渲染SKU图片表格
  renderSkuImageTable(combos);
}

/** 初始化SKU标题输入框字数统计 */
function initSkuTitleCounters(container) {
  const inputs = container.querySelectorAll('.sku-title-input');
  inputs.forEach(input => {
    const wrap = input.closest('.sku-title-input-wrap');
    if (!wrap) return;
    const counterEm = wrap.querySelector('.sku-title-counter em');
    if (!counterEm) return;
    // 初始字数
    counterEm.textContent = input.value.length;
    // 实时更新
    input.addEventListener('input', () => {
      counterEm.textContent = input.value.length;
    });
  });
}

/**
 * 初始化SKU表格价格联动监听（事件委托，只需绑定一次）
 *
 * 三种价格联动规则：
 *   货源价 (sourcePrice) = 1688 采集价（CNY），是价格链的源头
 *   售价   (price)       = Ozon 售价，由货源价 × 汇率 × 利润系数 计算
 *   划线价 (oldPrice)     = Ozon 划线价，由售价 × 划线价系数 计算
 *
 *   - 编辑货源价 → 自动重算售价/划线价（仅当对应输入未被手动覆盖时）
 *   - 手动编辑售价/划线价 → 标记 data-manual="true"，后续货源价变化不再自动覆盖
 *   - 清空售价/划线价 → 取消手动标记，恢复与货源价联动
 *
 * 通过事件委托绑定到 #skuTableWrap，自动覆盖后续手动添加/复制的行。
 */
function initSkuPriceListeners(wrap) {
  if (!wrap || wrap.dataset.priceListenersBound === 'true') return;
  wrap.dataset.priceListenersBound = 'true';

  wrap.addEventListener('input', (e) => {
    const input = e.target;
    if (!input || input.tagName !== 'INPUT') return;

    // 1. 货源价变化 → 自动重算售价/划线价（仅当未被手动覆盖时）
    if (input.dataset.skuSourcePrice !== undefined) {
      const row = input.closest('tr[data-sku-index]');
      if (!row) return;
      const sourcePrice = parseFloat(input.value) || 0;
      if (sourcePrice <= 0) return;
      const { price, oldPrice } = calcPriceFromSource(sourcePrice);
      const priceInput = row.querySelector('input[data-sku-price]');
      const oldPriceInput = row.querySelector('input[data-sku-old-price]');
      if (priceInput && priceInput.dataset.manual !== 'true') {
        priceInput.value = price || '';
      }
      if (oldPriceInput && oldPriceInput.dataset.manual !== 'true') {
        oldPriceInput.value = oldPrice || '';
      }
      return;
    }

    // 2. 手动编辑售价/划线价 → 标记手动覆盖；清空时取消标记恢复联动
    if (input.dataset.skuPrice !== undefined || input.dataset.skuOldPrice !== undefined) {
      if (input.value !== '') {
        input.dataset.manual = 'true';
      } else {
        delete input.dataset.manual;
      }
    }
  });
}

/** 渲染SKU图片表格 */
function renderSkuImageTable(combos) {
  const tbody = document.getElementById('skuImageTableBody');
  if (!tbody) return;

  if (!combos || combos.length === 0) {
    tbody.innerHTML = `<tr><td colspan="2" class="table-empty">添加销售属性后在此处管理各SKU图片</td></tr>`;
    updateTotalSkuImageCount();
    return;
  }

  tbody.innerHTML = combos.map((combo, i) => {
    const skuLabel = Object.values(combo).map(v => formatColorLabel(v)).join(' / ') || `SKU ${i + 1}`;
    const images = window._skuImages[i] || [];
    return `
      <tr data-sku-image-index="${i}">
        <td class="col-sku">
          <div class="sku-image-label">${skuLabel}</div>
          <div class="sku-image-count-small">${images.length}/30 张</div>
        </td>
        <td class="col-img">
          <div class="sku-image-cell" id="skuImageCell-${i}">
            ${renderSkuImageList(i, images)}
          </div>
        </td>
      </tr>`;
  }).join('');

  updateTotalSkuImageCount();

  // 重新初始化图标
  if (window.lucide) window.lucide.createIcons();
}

/** 渲染单个SKU的图片列表HTML */
function renderSkuImageList(skuIndex, images) {
  const showLarge = document.getElementById('showLargePreview')?.checked !== false;
  const showSize = document.getElementById('showImageSize')?.checked !== false;
  const thumbSize = showLarge ? 'large' : 'small';

  let html = '<div class="sku-image-gallery">';

  images.forEach((url, imgIndex) => {
    const isMain = imgIndex === 0;
    html += `
      <div class="sku-image-card" data-img-index="${imgIndex}">
        <div class="card-preview">
          <img src="${escapeAttr(proxyImage(url))}" alt="SKU图片${imgIndex + 1}" loading="lazy" referrerpolicy="no-referrer" onerror="this.onerror=null;this.src='data:image/svg+xml,%3Csvg xmlns=%22http://www.w3.org/2000/svg%22 width=%22100%22 height=%22100%22%3E%3Crect width=%22100%25%22 height=%22100%25%22 fill=%22%23f5f5f5%22/%3E%3Ctext x=%2250%25%22 y=%2255%25%22 text-anchor=%22middle%22 fill=%22%23ccc%22 font-size=%2212%22%3E加载失败%3C/text%3E%3C/svg%3E'">
          ${isMain ? '<span class="main-badge">主图</span>' : ''}
        </div>
        <div class="card-dimensions">1200 x 1600</div>
        <div class="card-actions">
          <button class="card-action-btn" title="AI优化" onclick="event.stopPropagation();"><i data-lucide="sparkles" style="width:13px;height:13px;"></i> AI</button>
          <button class="card-action-btn" title="编辑" onclick="event.stopPropagation();"><i data-lucide="pencil" style="width:13px;height:13px;"></i></button>
          <button class="card-action-btn btn-danger" title="删除" onclick="event.stopPropagation();removeSkuImage(${skuIndex}, ${imgIndex})"><i data-lucide="trash-2" style="width:13px;height:13px;"></i></button>
          <button class="card-action-btn" title="信息" onclick="event.stopPropagation();"><i data-lucide="info" style="width:13px;height:13px;"></i></button>
        </div>
      </div>`;
  });

  if (images.length < 30) {
    html += `
      <div class="sku-image-card sku-add-card" onclick="addSkuImage(${skuIndex}, event)">
        <div class="card-preview">
          <div class="add-plus-icon">
            <i data-lucide="plus" style="width:32px;height:32px;color:#bbb;"></i>
          </div>
        </div>
        <div class="card-dimensions"></div>
        <div class="card-actions">
          <span class="add-label">添加新图片</span>
        </div>
      </div>`;
  }

  html += '</div>';

  if (images.length === 0) {
    html = `<div class="sku-image-gallery">
      <div class="sku-image-card sku-add-card" onclick="addSkuImage(${skuIndex}, event)">
        <div class="card-preview">
          <div class="add-plus-icon">
            <i data-lucide="plus" style="width:32px;height:32px;color:#bbb;"></i>
          </div>
        </div>
        <div class="card-dimensions"></div>
        <div class="card-actions">
          <span class="add-label">添加新图片</span>
        </div>
      </div>
    </div>`;
  }

  return html;
}

/** 添加SKU图片 - 弹出上传方式选择菜单 */
function addSkuImage(skuIndex, event) {
  // 关闭已存在的菜单
  closeUploadMenu();

  const menu = document.createElement('div');
  menu.className = 'upload-method-menu';
  menu.id = 'uploadMethodMenu';
  menu.innerHTML = `
    <div class="upload-menu-item" data-method="local">
      <i data-lucide="upload" style="width:16px;height:16px;"></i>
      <span>本地上传</span>
    </div>
    <div class="upload-menu-item" data-method="space">
      <i data-lucide="folder" style="width:16px;height:16px;"></i>
      <span>选择空间图片</span>
    </div>
    <div class="upload-menu-item" data-method="network">
      <i data-lucide="link" style="width:16px;height:16px;"></i>
      <span>使用网络图片</span>
    </div>
    <div class="upload-menu-item" data-method="product">
      <i data-lucide="image" style="width:16px;height:16px;"></i>
      <span>使用产品图片</span>
    </div>
    <div class="upload-menu-item" data-method="source">
      <i data-lucide="external-link" style="width:16px;height:16px;"></i>
      <span>使用来源图片</span>
    </div>
  `;

  // 定位菜单：在触发元素附近弹出
  let targetEl;
  if (event && event.currentTarget) {
    targetEl = event.currentTarget;
  } else {
    targetEl = document.querySelector('.sku-add-card');
  }
  if (!targetEl) {
    targetEl = document.body;
  }

  const rect = targetEl.getBoundingClientRect();
  menu.style.position = 'fixed';
  menu.style.left = rect.left + rect.width / 2 - 80 + 'px';
  menu.style.top = rect.bottom + 6 + 'px';
  menu.style.zIndex = '9999';

  document.body.appendChild(menu);

  // 初始化图标
  if (window.lucide) window.lucide.createIcons();

  // 绑定事件
  menu.querySelectorAll('.upload-menu-item').forEach(item => {
    item.addEventListener('click', () => {
      const method = item.dataset.method;
      closeUploadMenu();
      handleUploadMethod(method, skuIndex);
    });
  });

  // 点击外部关闭
  setTimeout(() => {
    document.addEventListener('click', closeUploadMenu, { once: true });
  }, 0);
}

/** 关闭上传方式菜单 */
function closeUploadMenu() {
  const existing = document.getElementById('uploadMethodMenu');
  if (existing) existing.remove();
}

/** 根据选择的上传方式执行对应操作 */
function handleUploadMethod(method, skuIndex) {
  switch (method) {
    case 'local':
      uploadLocalFile(skuIndex);
      break;
    case 'space':
      selectSpaceImage(skuIndex);
      break;
    case 'network':
      showNetworkImageModal(skuIndex);
      break;
    case 'product':
      showProductImagePicker(skuIndex);
      break;
    case 'source':
      showSourceImagePicker(skuIndex);
      break;
  }
}

/** 本地上传：先上传到后端获取公网URL，再添加到SKU图片列表 */
function uploadLocalFile(skuIndex) {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = 'image/*';
  input.multiple = true;
  input.onchange = async (e) => {
    const files = Array.from(e.target.files);
    for (const file of files) {
      if (!window._skuImages[skuIndex]) window._skuImages[skuIndex] = [];
      if (window._skuImages[skuIndex].length >= 30) {
        Toast.show('每个SKU最多30张图片', 'warning');
        return;
      }

      // 先用 base64 预览（即时显示）
      const reader = new FileReader();
      const previewUrl = await new Promise(resolve => {
        reader.onload = (ev) => resolve(ev.target.result);
        reader.readAsDataURL(file);
      });

      // 添加预览图（先显示，后台异步上传）
      addSkuImageUrl(skuIndex, previewUrl);
      Toast.show('图片上传中...', 'info', 2000);

      // 上传到后端获取公网URL
      try {
        const res = await Api.uploadImage(file);
        if (res.code === 200 && res.data?.url) {
          // 替换 base64 预览为后端URL
          const imgs = window._skuImages[skuIndex];
          const idx = imgs.indexOf(previewUrl);
          if (idx >= 0) {
            imgs[idx] = res.data.url;
            refreshSkuImageCell(skuIndex);
          }
          Toast.show('图片上传成功', 'success', 1500);
        } else {
          // 上传失败，移除预览图
          const imgs = window._skuImages[skuIndex];
          const idx = imgs.indexOf(previewUrl);
          if (idx >= 0) {
            imgs.splice(idx, 1);
            refreshSkuImageCell(skuIndex);
          }
          Toast.show('图片上传失败: ' + (res.msg || '未知错误'), 'error');
        }
      } catch (err) {
        // 上传异常，移除预览图
        const imgs = window._skuImages[skuIndex];
        const idx = imgs.indexOf(previewUrl);
        if (idx >= 0) {
          imgs.splice(idx, 1);
          refreshSkuImageCell(skuIndex);
        }
        Toast.show('图片上传失败: ' + (err.message || '网络错误'), 'error');
      }
    }
  };
  input.click();
}

/** 选择空间图片（占位，可对接图床） */
function selectSpaceImage(skuIndex) {
  Modal.show({
    title: '选择空间图片',
    body: `
      <div class="form-group">
        <p style="color:var(--text-secondary);font-size:13px;line-height:1.6;">
          此功能将对接图床/云存储空间，可在此浏览和管理已上传的图片资源。
        </p>
      </div>
      <div class="form-group">
        <label class="form-label">或输入空间图片URL</label>
        <input type="text" class="form-input" id="spaceImageUrlInput" placeholder="粘贴空间图片地址" autocomplete="off">
      </div>
    `,
    footer: [
      { text: '取消', class: 'btn-ghost' },
      { text: '确认添加', class: 'btn-primary', onClick: () => {
        const url = document.getElementById('spaceImageUrlInput')?.value?.trim();
        if (url) addSkuImageUrl(skuIndex, url);
      }},
    ],
  });
}

/** 使用网络图片（URL输入弹窗） */
function showNetworkImageModal(skuIndex) {
  Modal.show({
    title: '添加网络图片',
    body: `
      <div class="form-group">
        <label class="form-label">图片URL</label>
        <input type="text" class="form-input" id="skuImageUrlInput" placeholder="粘贴图片地址，多个用换行分隔" autocomplete="off">
      </div>
    `,
    footer: [
      { text: '取消', class: 'btn-ghost' },
      { text: '确认添加', class: 'btn-primary', onClick: () => confirmAddSkuImage(skuIndex) },
    ],
  });
}

/** 使用产品图片（从商品主图选择） */
function showProductImagePicker(skuIndex) {
  const product = window._editingProduct;
  const productImages = product?.images || [];
  if (productImages.length === 0) {
    Toast.show('该商品暂无产品图片', 'warning');
    return;
  }
  Modal.show({
    title: '选择产品图片',
    body: `
      <div class="sku-image-picker" id="skuImagePicker">
        ${renderProductImagePicker(skuIndex)}
      </div>
    `,
  });
}

/** 使用来源图片（1688货源图） */
function showSourceImagePicker(skuIndex) {
  const product = window._editingProduct;
  const sourceImages = product?.sourceImages || [];
  if (sourceImages.length === 0 && !product?.sourceLink) {
    Toast.show('该商品暂无来源图片，请先设置货源链接', 'info');
    return;
  }
  let pickerHtml = '';
  if (sourceImages.length > 0) {
    pickerHtml = `<div class="sku-image-picker">${sourceImages.map((url, i) => `
      <div class="picker-thumb" onclick="pickSourceImage(${skuIndex}, '${url.replace(/'/g, "\\'")}')">
        <img src="${escapeAttr(proxyImage(url))}" alt="货源图${i + 1}" loading="lazy" referrerpolicy="no-referrer" onerror="this.style.opacity=0.3">
      </div>
    `).join('')}</div>`;
  } else {
    pickerHtml = `<p style="color:var(--text-secondary);font-size:13px;">暂无缓存货源图片，可通过下方URL添加：</p>
      <div class="form-group" style="margin-top:10px;">
        <input type="text" class="form-input" id="sourceImageUrlInput" placeholder="粘贴货源图片URL" autocomplete="off">
      </div>`;
  }
  Modal.show({
    title: '选择来源图片',
    body: pickerHtml,
    footer: sourceImages.length === 0 ? [
      { text: '取消', class: 'btn-ghost' },
      { text: '添加', class: 'btn-primary', onClick: () => {
        const url = document.getElementById('sourceImageUrlInput')?.value?.trim();
        if (url) addSkuImageUrl(skuIndex, url);
      }},
    ] : undefined,
  });
}

/** 从来源图片选择一张添加到SKU */
function pickSourceImage(skuIndex, url) {
  addSkuImageUrl(skuIndex, url);
}

/** 添加单张图片URL到SKU（通用辅助函数） */
function addSkuImageUrl(skuIndex, url) {
  if (!url || !url.trim()) return;
  url = url.trim();
  if (!window._skuImages[skuIndex]) window._skuImages[skuIndex] = [];
  if (window._skuImages[skuIndex].length >= 30) {
    Toast.show('每个SKU最多30张图片', 'warning');
    return;
  }
  if (window._skuImages[skuIndex].includes(url)) {
    Toast.show('该图片已添加', 'info');
    return;
  }
  window._skuImages[skuIndex].push(url);
  refreshSkuImageCell(skuIndex);
  Modal.close();
  Toast.show('图片已添加', 'success');
}

/** 渲染产品图片选择器 */
function renderProductImagePicker(skuIndex) {
  const product = window._editingProduct;
  const productImages = product?.images || [];
  if (productImages.length === 0) {
    return '<div style="color:var(--text-tertiary);font-size:13px;padding:8px 0;">该商品暂无产品图片</div>';
  }
  return productImages.map((url, i) => {
    return `<div class="picker-thumb" onclick="pickProductImage(${skuIndex}, '${url.replace(/'/g, "\\'")}')">
      <img src="${escapeAttr(proxyImage(url))}" alt="产品图${i + 1}" loading="lazy" referrerpolicy="no-referrer" onerror="this.style.opacity=0.3">
    </div>`;
  }).join('');
}

/** 从产品图片选择一张添加到SKU */
function pickProductImage(skuIndex, url) {
  addSkuImageUrl(skuIndex, url);
}

/** 确认添加SKU图片（从URL输入） */
function confirmAddSkuImage(skuIndex) {
  const input = document.getElementById('skuImageUrlInput');
  if (!input) return;
  const urls = input.value.trim().split('\n').map(u => u.trim()).filter(Boolean);

  if (urls.length === 0) {
    Toast.show('请输入至少一个图片URL', 'warning');
    return;
  }

  if (!window._skuImages[skuIndex]) window._skuImages[skuIndex] = [];

  let added = 0;
  urls.forEach(url => {
    if (window._skuImages[skuIndex].length >= 30) return;
    if (!window._skuImages[skuIndex].includes(url)) {
      window._skuImages[skuIndex].push(url);
      added++;
    }
  });

  refreshSkuImageCell(skuIndex);
  Modal.close();

  if (added > 0) {
    Toast.show(`成功添加 ${added} 张图片`, 'success');
  } else {
    Toast.show('图片已存在或已达上限', 'info');
  }
}

/** 删除SKU图片 */
function removeSkuImage(skuIndex, imgIndex) {
  if (!window._skuImages[skuIndex]) return;
  window._skuImages[skuIndex].splice(imgIndex, 1);
  if (window._skuImages[skuIndex].length === 0) {
    delete window._skuImages[skuIndex];
  }
  refreshSkuImageCell(skuIndex);
  Toast.show('图片已删除', 'info');
}

/** 设为主图（移到第一位） */
function setSkuMainImage(skuIndex, imgIndex) {
  if (!window._skuImages[skuIndex] || imgIndex === 0) return;
  const imgs = window._skuImages[skuIndex];
  const [img] = imgs.splice(imgIndex, 1);
  imgs.unshift(img);
  refreshSkuImageCell(skuIndex);
  Toast.show('已设为主图', 'success');
}

/** 刷新单个SKU图片单元格 */
function refreshSkuImageCell(skuIndex) {
  const cell = document.getElementById(`skuImageCell-${skuIndex}`);
  if (!cell) return;
  const images = window._skuImages[skuIndex] || [];
  cell.innerHTML = renderSkuImageList(skuIndex, images);

  // 更新该行SKU图片计数
  const row = document.querySelector(`tr[data-sku-image-index="${skuIndex}"]`);
  if (row) {
    const countEl = row.querySelector('.sku-image-count-small');
    if (countEl) countEl.textContent = `${images.length}/30 张`;
  }

  updateTotalSkuImageCount();

  // 重新初始化图标
  if (window.lucide) window.lucide.createIcons();

  // SKU图片变化后联动刷新颜色样本，确保样本与SKU颜色属性准确对应
  renderColorSamples();
}

/** 更新SKU图片总数 */
function updateTotalSkuImageCount() {
  const countEl = document.getElementById('skuImageCount');
  if (!countEl) return;
  let total = 0;
  Object.values(window._skuImages).forEach(imgs => {
    total += imgs.length;
  });
  countEl.textContent = total;
}

/** 刷新所有SKU图片单元格（预览设置变化时调用） */
function refreshAllSkuImageCells() {
  document.querySelectorAll('[data-sku-image-index]').forEach(row => {
    const skuIndex = parseInt(row.dataset.skuImageIndex, 10);
    if (!isNaN(skuIndex)) refreshSkuImageCell(skuIndex);
  });
}

/** 选中前30张复选框变化 */
function onSelectTop30Change() {
  const checked = document.getElementById('selectTop30')?.checked;
  if (!checked) return;
  // 为每个SKU从产品图片中选取前30张
  const product = window._editingProduct;
  const productImages = product?.images || [];
  if (productImages.length === 0) {
    Toast.show('该商品暂无产品图片可选', 'info');
    document.getElementById('selectTop30').checked = false;
    return;
  }
  const top30 = productImages.slice(0, 30);
  Object.keys(window._skuImages).forEach(key => {
    const idx = parseInt(key, 10);
    if (!isNaN(idx)) {
      window._skuImages[idx] = [...top30];
      refreshSkuImageCell(idx);
    }
  });
  Toast.show('已为所有SKU选中前30张产品图片', 'success');
  document.getElementById('selectTop30').checked = false;
}

/** 获取当前编辑商品绑定店铺的币种 */
function getCurrentStoreCurrency() {
  const product = window._editingProduct;
  if (!product || !product.store) return 'CNY';
  // 从已加载的店铺列表中查找匹配币种
  const stores = window._cachedStores || [];
  const matched = stores.find(s => s.alias === product.store || s.store_id === product.store);
  if (matched && matched.currency) {
    return matched.currency;
  }
  // 默认返回 CNY
  return 'CNY';
}

/** 异步加载店铺列表以获取币种配置 */
async function loadStoresForCurrency() {
  if (window._cachedStores && window._cachedStores.length > 0) return;
  try {
    const res = await Api.getStores();
    if (res.code === 200 && res.data) {
      window._cachedStores = res.data.list || [];
    }
  } catch (e) {
    // 静默失败，使用默认币种
  }
}

/** 获取币种符号 */
function getCurrencySymbol(currency) {
  const symbols = {
    CNY: '¥',
    USD: '$',
    RUB: '₽',
    EUR: '€',
    KZT: '₸',
    BYN: 'Br',
  };
  return symbols[currency] || '¥';
}

/** 根据采集平台获取货源价币种符号（1688/淘宝=CNY，Ozon=RUB）*/
function getSourcePriceSymbol(platform) {
  if (platform === 'ozon') return '₽';
  return '¥'; // 1688/淘宝/手工等默认人民币
}

/** 颜色中英文 → 俄语翻译映射 */
const COLOR_RU_MAP = {
  '红': 'Красный', '红色': 'Красный', 'red': 'Красный',
  '蓝': 'Синий', '蓝色': 'Синий', 'blue': 'Синий',
  '黑': 'Чёрный', '黑色': 'Чёрный', 'black': 'Чёрный',
  '白': 'Белый', '白色': 'Белый', 'white': 'Белый',
  '绿': 'Зелёный', '绿色': 'Зелёный', 'green': 'Зелёный',
  '黄': 'Жёлтый', '黄色': 'Жёлтый', 'yellow': 'Жёлтый',
  '紫': 'Фиолетовый', '紫色': 'Фиолетовый', 'purple': 'Фиолетовый',
  '粉': 'Розовый', '粉色': 'Розовый', 'pink': 'Розовый',
  '灰': 'Серый', '灰色': 'Серый', 'gray': 'Серый', 'grey': 'Серый',
  '橙': 'Оранжевый', '橙色': 'Оранжевый', 'orange': 'Оранжевый',
  '棕': 'Коричневый', '棕色': 'Коричневый', 'brown': 'Коричневый',
  '金': 'Золотой', '金色': 'Золотой', 'gold': 'Золотой',
  '银': 'Серебряный', '银色': 'Серебряный', 'silver': 'Серебряный',
  '青': 'Бирюзовый', '青色': 'Бирюзовый', 'cyan': 'Бирюзовый',
  '藏青': 'Тёмно-синий', 'navy': 'Тёмно-синий',
  '酒红': 'Бордовый', '酒红色': 'Бордовый', 'burgundy': 'Бордовый',
  '卡其': 'Хаки', '卡其色': 'Хаки', 'khaki': 'Хаки',
  '米白': 'Бежевый', '米色': 'Бежевый', 'beige': 'Бежевый',
};

/** 从SKU组合中提取颜色并显示为中文(俄语)双语格式 */
function extractColorRu(combo) {
  for (const [key, val] of Object.entries(combo)) {
    const lowerKey = key.toLowerCase();
    if (lowerKey.includes('颜色') || lowerKey.includes('color') || lowerKey.includes('цвет')) {
      return formatColorLabel(val);
    }
  }
  // 如果没有明确的颜色属性，尝试匹配所有值
  for (const val of Object.values(combo)) {
    const found = OZON_COLORS.find(c => c.zh === val);
    if (found) return formatColorLabel(val);
  }
  return '-';
}

/** 编辑SKU行 */
function editSkuRow(index) {
  const row = document.querySelector(`tr[data-sku-index="${index}"]`);
  if (!row) return;
  const inputs = row.querySelectorAll('input');
  const firstInput = inputs[0];
  if (firstInput) firstInput.focus();
  Toast.show(`正在编辑第 ${index + 1} 行SKU`, 'info');
}

/** 复制SKU行 */
function copySkuRow(index) {
  const row = document.querySelector(`tr[data-sku-index="${index}"]`);
  if (!row) return;
  const data = {};
  row.querySelectorAll('input').forEach(input => {
    if (input.dataset.skuPrice !== undefined) data.price = input.value;
    if (input.dataset.skuStock !== undefined) data.stock = input.value;
    if (input.dataset.skuCode !== undefined) data.skuCode = input.value;
    if (input.dataset.skuSourcePrice !== undefined) data.sourcePrice = input.value;
    if (input.dataset.skuWeight !== undefined) data.weight = input.value;
    if (input.dataset.skuLength !== undefined) data.length = input.value;
    if (input.dataset.skuWidth !== undefined) data.width = input.value;
    if (input.dataset.skuHeight !== undefined) data.height = input.value;
  });
  try {
    navigator.clipboard.writeText(JSON.stringify(data, null, 2));
    Toast.show('SKU数据已复制到剪贴板', 'success');
  } catch (e) {
    Toast.show('复制失败，请手动复制', 'warning');
  }
}

/** 删除SKU行 */
async function deleteSkuRow(index) {
  const confirmed = await Modal.confirm(`确定要删除第 ${index + 1} 行SKU吗？`);
  if (!confirmed) return;

  const row = document.querySelector(`tr[data-sku-index="${index}"]`);
  if (row) {
    row.style.transition = 'opacity 0.2s';
    row.style.opacity = '0';
    setTimeout(() => {
      row.remove();
      // 更新SKU计数
      const remaining = document.querySelectorAll('#skuTableWrap tr[data-sku-index]').length;
      const countSpan = document.querySelector('#skuTableWrap > div:last-child > span');
      if (countSpan) {
        const currency = getCurrentStoreCurrency();
        countSpan.textContent = `共 ${remaining} 个SKU组合 · 售价币种：${currency}`;
      }
      Toast.show('SKU已删除', 'success');
    }, 200);
  }
}

/**
 * 自动生成平台SKU（来源平台-时间-商品颜色 格式）
 * 拼接来源平台、时间戳和颜色属性值。
 * 示例：1688-08081230-红色、1688-08081230-蓝色；无颜色属性时格式：1688-08081230
 */
function autoGenerateSkuCodes() {
  console.log('[autoGenerateSkuCodes] 开始执行');
  const rows = document.querySelectorAll('#skuTableWrap tr[data-sku-index]');
  console.log('[autoGenerateSkuCodes] 找到SKU行:', rows.length);
  if (!rows.length) {
    Toast.show('无SKU行可生成', 'warning');
    return;
  }

  // 查找颜色属性在 cartesianAttrs 中的索引（与 generateSkuTable 的表格列顺序一致）
  // 仅销售属性（attrCategory='sales'）和兼容旧数据（无 attrCategory）参与笛卡尔积并在表格中显示为列
  const attrs = (Array.isArray(window._skuAttrs) ? window._skuAttrs : [])
    .map(a => ({ ...a, values: (a.values || []).filter(v => v !== '') }))
    .filter(a => a.name && a.values.length > 0 &&
      (a.attrCategory === 'sales' || !a.attrCategory));
  console.log('[autoGenerateSkuCodes] 过滤后的attrs:', attrs.length, attrs.map(a => ({ name: a.name, skuType: a.skuType })));
  const colorAttrIdx = attrs.findIndex(a => a.skuType === 'color');
  console.log('[autoGenerateSkuCodes] 颜色属性索引:', colorAttrIdx);

  // 生成时间戳 MMDDHHMM（月日时分）
  const now = new Date();
  const timestamp = `${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}${String(now.getHours()).padStart(2, '0')}${String(now.getMinutes()).padStart(2, '0')}`;

  // 获取来源平台名称（从商品数据中提取）
  const sourceName = window._editingProduct?.sourceName || '';
  // 提取平台名（去掉"分销"等后缀）
  const platform = sourceName.replace(/分销|代理|直供|批发/g, '').trim() || '';

  let generated = 0;
  rows.forEach((row, i) => {
    let colorName = '';
    if (colorAttrIdx >= 0) {
      // SKU 属性列从第 2 个 td 开始（第 1 个是 SKU 标题）
      const cells = row.querySelectorAll('td');
      const colorCell = cells[colorAttrIdx + 1];
      if (colorCell) {
        colorName = colorCell.getAttribute('data-original') || '';
        if (colorName === '-' || colorName === '') colorName = '';
      }
    }

    // 格式：平台-时间-商品颜色（平台名可能为空）
    const code = platform
      ? (colorName ? `${platform}-${timestamp}-${colorName}` : `${platform}-${timestamp}`)
      : (colorName ? `${timestamp}-${colorName}` : timestamp);

    // 用 data-sku-index 属性定位 input（删除行后 forEach 序号可能与 data-sku-code 不一致）
    const skuIdx = row.getAttribute('data-sku-index');
    const input = row.querySelector(`input[data-sku-code="${skuIdx}"]`);
    console.log('[autoGenerateSkuCodes] 行', i, 'skuIdx:', skuIdx, '找到input:', !!input, 'code:', code);
    if (input) {
      input.value = code;
      generated++;
    }
  });

  Toast.show(`已生成 ${generated} 条平台SKU`, 'success');
  console.log('[autoGenerateSkuCodes] 完成，生成:', generated);
}

/** 手动添加SKU行 */
function addManualSkuRow() {
  const tbody = document.querySelector('#skuTableWrap tbody');
  if (!tbody) return;

  const existingRows = document.querySelectorAll('#skuTableWrap tr[data-sku-index]');
  const newIndex = existingRows.length;
  const productTitle = (document.getElementById('editTitle')?.value || '').trim();
  const skuTitle = productTitle ? (productTitle.length > 30 ? productTitle.slice(0, 30) + '...' : productTitle) : ('SKU ' + (newIndex + 1));
  const currency = getCurrentStoreCurrency();
  const currencySymbol = getCurrencySymbol(currency);

  // 动态生成SKU属性列（与 generateSkuTable 的 tableAttrs 逻辑一致）
  // 销售属性=显示单元格（手动添加时为空），SKU信息属性=输入框
  const allSkuAttrs = (Array.isArray(window._skuAttrs) ? window._skuAttrs : []).filter(a => a && a.name);
  const INFO_ATTR_SKIP_KEYWORDS_ROW = ['一个商品中的件数', '颜色名称', 'название цвета', 'color name'];
  const tableAttrsForRow = allSkuAttrs.filter(a => {
    if (a.attrCategory === 'sales' || !a.attrCategory) {
      return Array.isArray(a.values) && a.values.filter(v => v !== '').length > 0;
    }
    if (a.attrCategory === 'info') {
      return !INFO_ATTR_SKIP_KEYWORDS_ROW.some(kw => a.name.toLowerCase().includes(kw.toLowerCase()));
    }
    return false;
  });
  const skuAttrCells = tableAttrsForRow.map(attr => {
    if (attr.attrCategory === 'info') {
      // SKU信息属性：输入框
      const isNumeric = ['Integer', 'Float', 'Decimal', 'Double'].includes(attr.ozonType);
      const inputType = isNumeric ? 'number' : 'text';
      const placeholder = attr.ozonType || '请输入';
      return `<td style="padding:6px 10px;border-bottom:1px solid var(--border-color);white-space:nowrap;">
        <input type="${inputType}" class="form-input sku-info-input" data-sku-info-row="${newIndex}" data-sku-info-attr="${attr.attrId}" data-sku-info-name="${attr.name.replace(/"/g, '&quot;')}" value="" placeholder="${placeholder}" style="width:100px;padding:4px 8px;font-size:12px;">
      </td>`;
    }
    // 销售属性：显示单元格（手动添加时为空值）
    return `<td data-original="-" style="padding:6px 10px;border-bottom:1px solid var(--border-color);white-space:nowrap;color:var(--text-tertiary);">-</td>`;
  }).join('');

  const row = document.createElement('tr');
  row.setAttribute('data-sku-index', newIndex);
  row.innerHTML = `
    <td class="sku-table__sticky-col sku-table__sticky-left" style="position:sticky;left:0;padding:6px 10px;border-bottom:1px solid var(--border-color);min-width:260px;background:#fff;">
      <div class="sku-title-input-wrap" data-sku-idx="${newIndex}">
        <input type="text" class="sku-title-input" data-sku-title="${newIndex}" value="${productTitle || ''}" placeholder="输入SKU标题" maxlength="200">
        <div class="sku-title-input__actions">
          <button type="button" class="sku-title-ai-btn" title="AI生成标题" onclick="event.stopPropagation();">AI</button>
          <span class="sku-title-abc-hint">Abc</span>
          <span class="sku-title-counter"><em>0</em> / 200</span>
        </div>
      </div>
    </td>
    ${skuAttrCells}
    <td style="padding:6px 10px;border-bottom:1px solid var(--border-color);white-space:nowrap;">
      <div style="display:flex;align-items:center;gap:2px;">
        <span style="color:var(--text-tertiary);font-size:12px;">¥</span>
        <input type="number" class="form-input" data-sku-source-price="${newIndex}" placeholder="0.00" style="width:80px;padding:4px 8px;font-size:12px;">
      </div>
    </td>
    <td style="padding:6px 10px;border-bottom:1px solid var(--border-color);white-space:nowrap;">
      <div style="display:flex;align-items:center;gap:2px;">
        <span style="color:var(--text-tertiary);font-size:12px;">${currencySymbol}</span>
        <input type="number" class="form-input" data-sku-price="${newIndex}" placeholder="0.00" style="width:80px;padding:4px 8px;font-size:12px;">
      </div>
    </td>
    <td style="padding:6px 10px;border-bottom:1px solid var(--border-color);white-space:nowrap;">
      <div style="display:flex;align-items:center;gap:2px;">
        <span style="color:var(--text-tertiary);font-size:12px;">${currencySymbol}</span>
        <input type="number" class="form-input" data-sku-old-price="${newIndex}" placeholder="划线价" style="width:80px;padding:4px 8px;font-size:12px;">
      </div>
    </td>
    <td style="padding:6px 10px;border-bottom:1px solid var(--border-color);white-space:nowrap;">
      <input type="number" class="form-input" data-sku-stock="${newIndex}" placeholder="0" style="width:70px;padding:4px 8px;font-size:12px;">
    </td>
    <td style="padding:6px 10px;border-bottom:1px solid var(--border-color);white-space:nowrap;">
      <div style="display:flex;align-items:center;gap:2px;">
        <input type="number" class="form-input" data-sku-weight="${newIndex}" placeholder="0" style="width:70px;padding:4px 8px;font-size:12px;">
        <span style="color:var(--text-tertiary);font-size:11px;">g</span>
      </div>
    </td>
    <td style="padding:6px 10px;border-bottom:1px solid var(--border-color);white-space:nowrap;">
      <div style="display:flex;align-items:center;gap:2px;">
        <input type="number" class="form-input" data-sku-length="${newIndex}" placeholder="L" style="width:50px;padding:4px 6px;font-size:12px;">
        <span style="color:var(--text-tertiary);">×</span>
        <input type="number" class="form-input" data-sku-width="${newIndex}" placeholder="W" style="width:50px;padding:4px 6px;font-size:12px;">
        <span style="color:var(--text-tertiary);">×</span>
        <input type="number" class="form-input" data-sku-height="${newIndex}" placeholder="H" style="width:50px;padding:4px 6px;font-size:12px;">
        <span style="color:var(--text-tertiary);font-size:11px;">mm</span>
      </div>
    </td>
    <td style="padding:6px 10px;border-bottom:1px solid var(--border-color);white-space:nowrap;">
      <input type="text" class="form-input" data-sku-code="${newIndex}" placeholder="自动生成" style="width:110px;padding:4px 8px;font-size:12px;">
    </td>
    <td style="padding:6px 10px;border-bottom:1px solid var(--border-color);white-space:nowrap;">
      <div style="display:flex;gap:4px;align-items:center;">
        <button onclick="copySkuRow(${newIndex})" title="复制" style="background:none;border:none;cursor:pointer;color:var(--text-tertiary);padding:2px 4px;display:flex;align-items:center;">
          <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>
        </button>
        <button onclick="deleteSkuRow(${newIndex})" title="删除" style="background:none;border:none;cursor:pointer;color:#ef4444;padding:2px 4px;display:flex;align-items:center;">
          <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18"/><path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6"/><path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2"/></svg>
        </button>
      </div>
    </td>`;

  tbody.appendChild(row);

  // 初始化新行的SKU标题字数统计
  initSkuTitleCounters(row);

  // 更新计数
  const countSpan = document.querySelector('#skuTableWrap > div:last-child > span');
  if (countSpan) {
    const total = document.querySelectorAll('#skuTableWrap tr[data-sku-index]').length;
    countSpan.textContent = `共 ${total} 个SKU组合 · 售价币种：${currency}`;
  }

  Toast.show('已添加手动SKU行', 'success');
}

/** 显示批量设置卡片弹窗 */
function showBatchCard(field, label, unit) {
  document.getElementById('skuBatchCard')?.remove();

  const isDims = field === 'dims';
  const isPriceField = field === 'price' || field === 'source-price';
  const rowCount = document.querySelectorAll('#skuTableWrap tr[data-sku-index]').length;
  const currency = getCurrentStoreCurrency();
  const currencySymbol = getCurrencySymbol(currency);

  // 构建输入区域
  let inputHtml;
  if (isDims) {
    inputHtml = `
      <div style="display:flex;align-items:center;gap:8px;margin-bottom:12px;">
        <div style="display:flex;align-items:center;gap:2px;">
          <input type="number" id="batchInputL" placeholder="长" style="width:80px;padding:6px 10px;font-size:13px;border:1px solid var(--border-color);border-radius:6px;">
          <span style="color:var(--text-tertiary);font-size:12px;">cm</span>
        </div>
        <span style="color:var(--text-tertiary);">×</span>
        <div style="display:flex;align-items:center;gap:2px;">
          <input type="number" id="batchInputW" placeholder="宽" style="width:80px;padding:6px 10px;font-size:13px;border:1px solid var(--border-color);border-radius:6px;">
          <span style="color:var(--text-tertiary);font-size:12px;">cm</span>
        </div>
        <span style="color:var(--text-tertiary);">×</span>
        <div style="display:flex;align-items:center;gap:2px;">
          <input type="number" id="batchInputH" placeholder="高" style="width:80px;padding:6px 10px;font-size:13px;border:1px solid var(--border-color);border-radius:6px;">
          <span style="color:var(--text-tertiary);font-size:12px;">cm</span>
        </div>
      </div>
      <p style="font-size:12px;color:var(--text-tertiary);margin:0 0 12px;">留空的尺寸不会被修改，仅更新已填写的值</p>
    `;
  } else if (isPriceField) {
    const srcCurText = field === 'source-price' ? 'CNY' : currency;
    const curSym = getCurrencySymbol(field === 'source-price' ? 'CNY' : currency);
    inputHtml = `
      <!-- 修改方式 -->
      <div class="bf-item">
        <div class="bf-label">修改方式</div>
        <div class="bf-content">
          <label class="bf-radio active" onclick="switchBatchMode(this,'unified')"><span class="bf-radio-dot"></span><span class="bf-radio-txt">使用统一价：</span>
            <span id="batchUnifiedArea" class="bf-inline">
              <div class="bf-input-wrap bf-has-prefix">
                <span class="bf-prefix">${curSym}</span>
                <input type="number" id="batchUnifiedVal" placeholder="输入要设置的价格" class="bf-in" autofocus>
              </div>
            </span>
          </label>
          <label class="bf-radio" onclick="switchBatchMode(this,'formula')"><span class="bf-radio-dot"></span><span class="bf-radio-txt">使用公式：</span>
            <div id="batchFormulaArea">
              <div class="bf-inline">
                <div class="bf-source-sel">来源原价(${srcCurText})<i class="bf-arrow"></i></div><span class="bf-op">×</span>
                <div class="bf-input-wrap"><input type="number" id="batchFactor" placeholder="倍数" step="any" class="bf-in bf-in-sm"></div>
                <span class="bf-op">+</span>
                <div class="bf-input-wrap bf-has-prefix">
                  <span class="bf-prefix">${curSym}</span>
                  <input type="number" id="batchAdd" placeholder="加数" step="any" class="bf-in bf-in-sm">
                </div>
                <span class="bf-op">-</span>
                <div class="bf-input-wrap bf-has-prefix">
                  <span class="bf-prefix">${curSym}</span>
                  <input type="number" id="batchSub" placeholder="减数" step="any" class="bf-in bf-in-sm">
                </div>
              </div>
              <!-- 取整 / 尾数 / 小数 -->
              <div class="bf-sub-rows">
                <div class="bf-sub-row">
                  <span class="bf-sub-lbl">取整方式：</span>
                  <label class="bf-radio active" onclick="event.stopPropagation();switchRoundMode(this,'round')"><span class="bf-radio-dot"></span>四舍五入</label>
                  <label class="bf-radio" onclick="event.stopPropagation();switchRoundMode(this,'ceil')"><span class="bf-radio-dot"></span>向上取整</label>
                  <label class="bf-radio" onclick="event.stopPropagation();switchRoundMode(this,'floor')"><span class="bf-radio-dot"></span>向下取整</label>
                </div>
                <div class="bf-sub-row">
                  <span class="bf-sub-lbl">尾数值：</span>
                  <div class="bf-input-wrap"><input type="number" id="batchTail" placeholder="" step="any" class="bf-in bf-in-full"></div>
                </div>
                <div class="bf-sub-row">
                  <span class="bf-sub-lbl">保留小数：</span>
                  <label class="bf-radio active" onclick="event.stopPropagation();switchDecimalMode(this,1)"><span class="bf-radio-dot"></span>保留1位小数</label>
                  <label class="bf-radio" onclick="event.stopPropagation();switchDecimalMode(this,2)"><span class="bf-radio-dot"></span>保留2位小数</label>
                </div>
              </div>
            </div>
          </label>
        </div>
      </div>

      <!-- 修改范围 -->
      <div class="bf-item">
        <div class="bf-label">修改范围：</div>
        <div class="bf-content" style="flex-direction:row;align-items:center;gap:20px;">
          <label class="bf-radio active" onclick="switchScopeMode(this,'all')"><span class="bf-radio-dot"></span>此产品全部SKU</label>
          <label class="bf-radio" onclick="switchScopeMode(this,'spec')"><span class="bf-radio-dot"></span>指定规格的SKU</label>
        </div>
      </div>
    `;
  } else {
    inputHtml = `
      <div style="display:flex;align-items:center;gap:6px;margin-bottom:12px;">
        ${unit ? `<span style="font-size:14px;color:var(--text-secondary);font-weight:500;">${unit}</span>` : ''}
        <input type="number" id="batchInputVal" placeholder="输入批量值" style="flex:1;padding:8px 12px;font-size:14px;border:1px solid var(--border-color);border-radius:6px;" autofocus>
      </div>
      <p style="font-size:12px;color:var(--text-tertiary);margin:0 0 14px;">将应用到全部 <strong style="color:var(--text-primary);">${rowCount}</strong> 行SKU</p>
    `;
  }

  const cardWidth = isPriceField ? '700px' : (isDims ? '420px' : '380px');
  const card = document.createElement('div');
  card.id = 'skuBatchCard';
  card.innerHTML = `
    <div style="position:fixed;inset:0;background:rgba(0,0,0,0.3);z-index:9999;display:flex;align-items:center;justify-content:center;padding:24px;box-sizing:border-box;" onclick="if(event.target===this)closeBatchCard()">
      <div style="background:var(--bg-card,#fff);border-radius:12px;box-shadow:0 8px 40px rgba(0,0,0,0.25);width:${cardWidth};max-width:calc(100vw - 48px);max-height:calc(100vh - 48px);overflow-y:auto;overflow-x:auto;animation:batchCardIn 0.2s ease;">
        <div style="padding:14px 20px;border-bottom:1px solid var(--border-color);display:flex;align-items:center;justify-content:space-between;position:sticky;top:0;background:var(--bg-card,#fff);z-index:1;border-radius:12px 12px 0 0;">
          <div style="font-size:15px;font-weight:600;color:var(--text-primary);">批量设置${label}</div>
          <button onclick="closeBatchCard()" style="background:none;border:none;font-size:18px;cursor:pointer;color:var(--text-tertiary);padding:0 4px;line-height:1;">&times;</button>
        </div>
        <div style="padding:18px 20px;" data-batch-field="${field}">
          ${inputHtml}
          <div style="display:flex;gap:8px;justify-content:flex-end;margin-top:16px;padding-top:14px;border-top:1px solid var(--border-color);position:sticky;bottom:0;background:var(--bg-card,#fff);z-index:1;margin-bottom:-2px;">
            <button class="btn btn-sm btn-ghost" onclick="closeBatchCard()" style="padding:7px 20px;font-size:13px;">取消</button>
            <button class="btn btn-sm btn-primary" onclick="confirmBatchApply('${field}')" style="padding:7px 24px;font-size:13px;">确定</button>
          </div>
        </div>
      </div>
    </div>
  `;
  document.body.appendChild(card);

  if (!document.getElementById('batchCardStyle')) {
    const style = document.createElement('style');
    style.id = 'batchCardStyle';
    style.textContent = `
      @keyframes batchCardIn{from{opacity:0;transform:translateY(-12px) scale(0.96)}to{opacity:1;transform:translateY(0) scale(1)}}

      /* 表单行：label左对齐 + content右填充 */
      .bf-item{display:flex;align-items:flex-start;margin-bottom:18px;}
      .bf-item:last-child{margin-bottom:2px;}
      .bf-label{width:100px;flex-shrink:0;font-size:13px;color:#333;line-height:32px;padding-top:0;}
      .bf-content{flex:1;display:flex;flex-direction:column;gap:10px;}

      /* 单选按钮 - 圆点样式 */
      .bf-radio{display:inline-flex;align-items:center;gap:6px;font-size:13px;color:#333;cursor:pointer;user-select:none;line-height:1.6;}
      /* radio文字固定宽度，保证输入框左对齐 */
      .bf-radio-txt{min-width:88px;display:inline-block;white-space:nowrap;}
      .bf-radio-dot{display:inline-block;width:14px;height:14px;border-radius:50%;border:1.5px solid #c0c4cc;flex-shrink:0;position:relative;background:#fff;transition:border-color .15s,background .15s,box-shadow .15s;box-sizing:border-box;}
      .bf-radio.active .bf-radio-dot{border-color:#00BFA5;background:#00BFA5;box-shadow:inset 0 0 0 2px #fff;}
      .bf-radio:hover:not(.active) .bf-radio-dot{border-color:#999;}

      /* 统一价/公式内联区域 */
      .bf-inline{display:inline-flex;align-items:center;gap:4px;vertical-align:middle;margin-left:2px;}

      /* 输入框容器（支持前缀） */
      .bf-input-wrap{display:inline-flex;align-items:center;border:1px solid #dcdee2;border-radius:4px;background:#fff;overflow:hidden;transition:border-color .15s,box-shadow .15s;height:32px;box-sizing:border-box;vertical-align:middle;}
      .bf-input-wrap:focus-within{border-color:#00BFA5;box-shadow:0 0 0 2px rgba(0,191,165,.12);}
      .bf-has-prefix{padding-left:0;}

      /* 前缀币种符号 */
      .bf-prefix{display:inline-flex;align-items:center;padding:0 8px;font-size:13px;color:#666;background:#f7f8fa;border-right:1px solid #dcdee2;height:100%;line-height:30px;white-space:nowrap;flex-shrink:0;}

      /* 输入框本体 */
      .bf-in{border:none;outline:none;background:transparent;font-size:13px;color:#333;width:140px;height:30px;padding:0 8px;box-sizing:border-box;min-width:0;}
      .bf-in::placeholder{color:#c0c4cc;}
      .bf-in-sm{width:64px;}
      .bf-in-full{width:100%;}

      /* 来源原价选择器样式 */
      .bf-source-sel{display:inline-flex;align-items:center;gap:4px;padding:0 10px;border:1px solid #dcdee2;border-radius:4px;background:#fafafa;font-size:12px;color:#666;height:30px;cursor:default;white-space:nowrap;user-select:none;line-height:1;}
      .bf-arrow{display:inline-block;width:0;height:0;border-left:4px solid transparent;border-right:4px solid transparent;border-top:5px solid #999;margin-left:2px;vertical-align:middle;}

      /* 运算符 */
      .bf-op{color:#999;font-size:14px;margin:0 1px;font-weight:300;}

      /* 公式区域（含子项） */
      #batchFormulaArea{margin-top:6px;transition:opacity .2s;}
      #batchFormulaArea.bf-disabled{opacity:.4;pointer-events:none;}
      .bf-sub-rows{margin-top:10px;padding-left:0;}
      .bf-sub-row{display:flex;align-items:center;margin-bottom:10px;gap:16px;}
      .bf-sub-lbl{width:auto;flex-shrink:0;font-size:13px;color:#555;line-height:30px;}

    `;
    document.head.appendChild(style);
  }

  setTimeout(() => {
    const firstInput = card.querySelector('input[autofocus],#batchUnifiedVal,#batchInputVal');
    if (firstInput) firstInput.focus();
    // 默认统一价模式，公式区域置灰禁用
    if (isPriceField) {
      const formula = document.getElementById('batchFormulaArea');
      if (formula) formula.classList.add('bf-disabled');
      // 重置取整方式：默认四舍五入
      card.querySelectorAll('.bf-sub-row:nth-child(1) .bf-radio').forEach((r, i) => {
        r.classList.toggle('active', i === 0);
      });
      // 重置保留小数：默认1位
      card.querySelectorAll('.bf-sub-row:nth-child(3) .bf-radio').forEach((r, i) => {
        r.classList.toggle('active', i === 0);
      });
      // 重置全局状态
      window._batchState.round = 'round';
      window._batchState.decimal = 1;
    }
  }, 50);
}

// ========== 批量卡片交互状态 ==========
window._batchState = { mode: 'unified', round: 'round', decimal: 1, scope: 'all' };

/** 切换统一价/公式模式 */
function switchBatchMode(el, mode) {
  window._batchState.mode = mode;
  el.closest('.bf-content').querySelectorAll(':scope > .bf-radio').forEach(r => r.classList.remove('active'));
  el.classList.add('active');
  const formula = document.getElementById('batchFormulaArea');
  if (formula) formula.classList.toggle('bf-disabled', mode === 'unified');
  // 切换到公式模式时，重置子选项为默认值
  if (mode === 'formula' && formula) {
    // 取整方式：默认四舍五入
    formula.querySelectorAll('.bf-sub-row:nth-child(1) .bf-radio').forEach((r, i) => {
      r.classList.toggle('active', i === 0);
    });
    // 保留小数：默认1位
    formula.querySelectorAll('.bf-sub-row:nth-child(3) .bf-radio').forEach((r, i) => {
      r.classList.toggle('active', i === 0);
    });
    window._batchState.round = 'round';
    window._batchState.decimal = 1;
  }
}

/** 切换取整方式 */
function switchRoundMode(el, mode) {
  window._batchState.round = mode;
  el.closest('.bf-sub-row').querySelectorAll('.bf-radio').forEach(r => r.classList.remove('active'));
  el.classList.add('active');
}

/** 切换保留小数位数 */
function switchDecimalMode(el, digits) {
  window._batchState.decimal = digits;
  el.closest('.bf-sub-row').querySelectorAll('.bf-radio').forEach(r => r.classList.remove('active'));
  el.classList.add('active');
}

/** 切换修改范围 */
function switchScopeMode(el, scope) {
  window._batchState.scope = scope;
  el.closest('.bf-item').querySelectorAll('.bf-radio').forEach(r => r.classList.remove('active'));
  el.classList.add('active');
}

/** 关闭批量卡片 */
function closeBatchCard() {
  document.getElementById('skuBatchCard')?.remove();
}

/** 确认批量应用 */
function confirmBatchApply(field) {
  const rows = document.querySelectorAll('#skuTableWrap tr[data-sku-index]');
  if (rows.length === 0) { Toast.show('没有可应用的SKU行', 'warning'); closeBatchCard(); return; }
  const isDims = field === 'dims';

  if (isDims) {
    const l = document.getElementById('batchInputL')?.value;
    const w = document.getElementById('batchInputW')?.value;
    const h = document.getElementById('batchInputH')?.value;
    if (!l && !w && !h) { Toast.show('请至少填写一个尺寸值', 'warning'); return; }
    rows.forEach(row => {
      if (l) { const el = row.querySelector('input[data-sku-length]'); if (el) el.value = l; }
      if (w) { const el = row.querySelector('input[data-sku-width]'); if (el) el.value = w; }
      if (h) { const el = row.querySelector('input[data-sku-height]'); if (el) el.value = h; }
    });
    Toast.show(`已批量设置 ${rows.length} 行尺寸`, 'success');
  } else if (field === 'price' || field === 'source-price') {
    applyBatchPrice(field, rows);
  } else {
    const val = document.getElementById('batchInputVal')?.value;
    if (val === '' || val === null) { Toast.show('请输入批量值', 'warning'); return; }
    const targets = document.querySelectorAll(`#skuTableWrap input[data-sku-${field}]`);
    // 售价/划线价批量设置视为手动覆盖，标记后不再被货源价联动自动重算
    const markManual = (field === 'price' || field === 'old-price');
    targets.forEach(input => {
      input.value = val;
      if (markManual) input.dataset.manual = 'true';
    });
    Toast.show(`已批量设置 ${targets.length} 行`, 'success');
  }
  closeBatchCard();
}

/** 批量价格计算与应用 */
function applyBatchPrice(field, rows) {
  const state = window._batchState;
  // 批量设置的售价/划线价视为手动覆盖，标记后不再被货源价联动自动重算
  const isManualField = (field === 'price' || field === 'old-price');
  // 货源价批量修改后需触发联动重算售价/划线价（程序式赋值不触发input事件）
  const isSourceField = field === 'source-price';

  if (state.mode === 'unified') {
    const val = parseFloat(document.getElementById('batchUnifiedVal')?.value);
    if (isNaN(val)) { Toast.show('请输入统一价格值', 'warning'); return; }
    rows.forEach(row => {
      const target = row.querySelector(`input[data-sku-${field}]`);
      if (target) {
        target.value = val.toFixed(state.decimal);
        if (isManualField) target.dataset.manual = 'true';
        if (isSourceField) target.dispatchEvent(new Event('input', { bubbles: true }));
      }
    });
    Toast.show(`已将全部 ${rows.length} 行售价设为 ${val}`, 'success');
  } else {
    // 公式模式：来源原价 × 倍数 + 加数 - 减数
    const factor = parseFloat(document.getElementById('batchFactor')?.value) || 1;
    const add = parseFloat(document.getElementById('batchAdd')?.value) || 0;
    const sub = parseFloat(document.getElementById('batchSub')?.value) || 0;
    let applied = 0;
    rows.forEach(row => {
      const sourceEl = row.querySelector('input[data-sku-source-price]');
      const sourcePrice = sourceEl ? (parseFloat(sourceEl.value) || 0) : 0;
      let result = sourcePrice * factor + add - sub;
      const tailVal = parseFloat(document.getElementById('batchTail')?.value) || 0;
      result = roundByMode(result, state.round, tailVal);
      result = parseFloat(result.toFixed(state.decimal));
      const target = row.querySelector(`input[data-sku-${field}]`);
      if (target) {
        target.value = result;
        if (isManualField) target.dataset.manual = 'true';
        if (isSourceField) target.dispatchEvent(new Event('input', { bubbles: true }));
        applied++;
      }
    });
    Toast.show(`公式计算完成，已更新 ${applied} 行`, 'success');
  }
}

/** 按指定取整方式处理数值 */
function roundByMode(val, mode, tail) {
  if (mode === 'ceil') return Math.ceil(val);
  if (mode === 'floor') return Math.floor(val);
  // 四舍五入 + 尾数处理
  const rounded = Math.round(val);
  if (tail && tail > 0) {
    const lastDigit = rounded % 10;
    if (lastDigit !== tail) return rounded + (tail - lastDigit);
  }
  return rounded;
}

/** 收集类目属性表单中的值 */
function collectCategoryAttributes() {
  const attrs = [];

  // 1. 收集动态属性（从 attrList 表单中读取，含基本信息区的 JSON富内容）
  document.querySelectorAll('#attrList .attr-item, #richContentAttr .attr-item, #modelAttr .attr-item, #annotationAttr .attr-item').forEach(el => {
    const attrEl = el.querySelector('[data-attr-id]');
    if (!attrEl) return;
    const attrId = parseInt(attrEl.dataset.attrId);
    if (!attrId) return;

    // 多选字典属性：从显示区 data-value-ids 读取
    const multiDisplayEl = el.querySelector('.multi-select-display[data-attr-id]');
    if (multiDisplayEl) {
      const idsStr = multiDisplayEl.dataset.valueIds || '';
      const selectedIds = idsStr.split(',').filter(v => v).map(Number).filter(v => v > 0);
      if (selectedIds.length > 0) {
        attrs.push({ id: attrId, dictionary_value_ids: selectedIds });
      }
      return;
    }

    // select 类型（字典值 或 Boolean）
    const selectEl = el.querySelector('select[data-attr-id]');
    if (selectEl) {
      if (selectEl.dataset.attrType === 'boolean') {
        // Boolean 类型：值为 "true" / "false"
        if (selectEl.value === 'true' || selectEl.value === 'false') {
          attrs.push({ id: attrId, value: selectEl.value });
        }
      } else {
        // 单选字典值：优先用 select.value；若空则兜底用 savedValueId（选项未加载或字典值已下架）
        let dictValueId = parseInt(selectEl.value) || null;
        if (!dictValueId && selectEl.dataset.savedValueId) {
          dictValueId = parseInt(selectEl.dataset.savedValueId) || null;
        }
        if (dictValueId) {
          attrs.push({ id: attrId, dictionary_value_id: dictValueId });
        }
      }
      return;
    }

    // 品牌搜索输入框：优先使用 data-value-id（字典值ID），否则用文本值
    const searchEl = el.querySelector('input.attr-search-field[data-attr-id]');
    if (searchEl) {
      const dictValueId = parseInt(searchEl.dataset.valueId) || null;
      // submitValue 优先（无品牌选项显示双语但提交俄语），否则用输入框文本
      const textValue = searchEl.dataset.submitValue || searchEl.value.trim();
      if (dictValueId) {
        attrs.push({ id: attrId, dictionary_value_id: dictValueId, value: textValue });
      } else if (textValue) {
        attrs.push({ id: attrId, value: textValue });
      }
      return;
    }

    // input/textarea 类型（自由文本）
    const inputEl = el.querySelector('input[data-attr-id], textarea[data-attr-id]');
    if (inputEl && inputEl.value.trim()) {
      attrs.push({ id: attrId, value: inputEl.value.trim() });
    }
  });

  // 2. 从 _skuAttrs 收集Ozon类目SKU属性值
  (Array.isArray(window._skuAttrs) ? window._skuAttrs : []).forEach(attr => {
    if (!attr || !attr.attrId) return;
    if (!Array.isArray(attr.values) || attr.values.length === 0) return;

    // SKU信息属性（attrCategory='info'，含 skuType='info'/'text' 等）按SKU独立填写，
    // 不作为 item 级属性提交。其值由 collectSkuTableData 收集到 SKU combo 中，
    // 由 buildOzonSkus 提交到 sources[].attributes。
    // 注意：颜色名称 skuType='text' 但 attrCategory='info'，必须在此跳过，
    // 否则会被当作 SPU 级 text 属性只取 values[0] 提交，导致数据丢失。
    if (attr.skuType === 'info' || attr.attrCategory === 'info') return;

    if (attr.skuType === 'color' && attr.dictionaryId) {
      // 颜色类型：优先使用 valueIds（自动匹配/手动选择时存储的 dictionary_value_id）
      const valueIds = attr.valueIds || [];
      attr.values.forEach((v, i) => {
        const vid = valueIds[i];
        if (Array.isArray(vid) && vid.length > 0) {
          // 多选颜色：使用 dictionary_value_ids 数组
          attrs.push({ id: attr.attrId, dictionary_value_ids: vid });
        } else if (vid) {
          attrs.push({ id: attr.attrId, dictionary_value_id: vid });
        } else {
          // 回退：从颜色字典缓存中查找匹配的 value_id
          const dictValues = window._colorDictCache?.[`${attr.dictionaryId}`] || [];
          const match = autoMatchColor(v, dictValues);
          if (match.value_id) {
            attrs.push({ id: attr.attrId, dictionary_value_id: match.value_id });
          }
        }
      });
    } else if (attr.skuType === 'select' && attr.dictionaryId) {
      // 销售属性（有字典）：优先使用 valueIds，回退到提交纯值
      // 注意：当前卡片UI未提供字典选择器，valueIds 可能为空。
      //       若 API 要求 dictionary_value_id，需后续增强字典选择器UI。
      const valueIds = attr.valueIds || [];
      attr.values.forEach((v, i) => {
        const vid = valueIds[i];
        if (Array.isArray(vid) && vid.length > 0) {
          attrs.push({ id: attr.attrId, dictionary_value_ids: vid });
        } else if (vid) {
          attrs.push({ id: attr.attrId, dictionary_value_id: vid });
        } else {
          // 回退：提交纯值（部分字典属性接受纯值，具体视 Ozon API 规范而定）
          attrs.push({ id: attr.attrId, value: v });
        }
      });
    } else if (attr.skuType === 'number') {
      // 件数类型：取第一个值
      attrs.push({ id: attr.attrId, value: attr.values[0] });
    } else if (attr.skuType === 'text') {
      // 文本类型：取第一个值
      attrs.push({ id: attr.attrId, value: attr.values[0] });
    }
  });

  return attrs;
}

/** 保存商品数据 */
/** 添加描述视频（通过上传框自动调用） */
function addDescVideoUrl() {
  // 兼容旧调用，实际添加由 handleDescVideoUpload 处理
}

/** 处理封面视频文件上传 */
function handleCoverVideoUpload(input) {
  const file = input.files[0];
  if (!file) return;
  // 校验格式
  const ext = file.name.split('.').pop().toLowerCase();
  if (!['mp4', 'mov'].includes(ext)) {
    Toast.show('仅支持 MP4、MOV 格式', 'error');
    input.value = '';
    return;
  }
  // 校验大小（20MB）
  if (file.size > 20 * 1024 * 1024) {
    Toast.show('视频大小不能超过20MB', 'error');
    input.value = '';
    return;
  }
  // 生成本地预览URL
  const url = URL.createObjectURL(file);
  const urlInput = document.getElementById('editCoverVideoUrl');
  if (urlInput) urlInput.value = url;
  // 更新上传框显示视频预览
  const wrap = document.getElementById('coverVideoWrap');
  if (wrap) {
    wrap.classList.add('has-video');
    wrap.innerHTML = `<video src="${url}" muted></video>` +
      `<button class="video-delete-btn" onclick="event.stopPropagation();clearCoverVideo(event)">&times;</button>`;
  }
  Toast.show('封面视频已添加，请发布前确认', 'success');
}

/** 清除封面视频 */
function clearCoverVideo(e) {
  e.preventDefault();
  e.stopPropagation();
  const urlInput = document.getElementById('editCoverVideoUrl');
  if (urlInput) urlInput.value = '';
  const fileInput = document.getElementById('coverVideoFile');
  if (fileInput) fileInput.value = '';
  const wrap = document.getElementById('coverVideoWrap');
  if (wrap) {
    wrap.classList.remove('has-video');
    wrap.innerHTML = `<i data-lucide="plus" style="width:24px;height:24px;color:#bbb;"></i>`;
    if (window.lucide) lucide.createIcons();
  }
}

/** 处理描述视频文件上传 */
function handleDescVideoUpload(input) {
  const file = input.files[0];
  if (!file) return;
  const ext = file.name.split('.').pop().toLowerCase();
  if (!['mp4', 'mov'].includes(ext)) {
    Toast.show('仅支持 MP4、MOV 格式', 'error');
    input.value = '';
    return;
  }
  if (file.size > 200 * 1024 * 1024) {
    Toast.show('视频大小不能超过200MB', 'error');
    input.value = '';
    return;
  }
  // 检查数量限制
  const existing = document.querySelectorAll('.desc-video-item');
  if (existing.length >= 5) {
    Toast.show('最多添加5条描述视频', 'warning');
    input.value = '';
    return;
  }
  const url = URL.createObjectURL(file);
  const list = document.getElementById('descVideoList');
  if (list) {
    const item = document.createElement('div');
    item.className = 'desc-video-item';
    item.setAttribute('data-url', url);
    item.innerHTML = `<video src="${url}" muted></video>` +
      `<button class="video-delete-btn" onclick="removeDescVideo(this)">&times;</button>`;
    list.appendChild(item);
  }
  input.value = '';
  Toast.show('描述视频已添加', 'success');
}

/** 删除描述视频 */
function removeDescVideo(btn) {
  const item = btn.parentElement;
  if (item) item.remove();
}

/** 视频操作按钮功能 */
function videoTranslate() {
  const url = document.getElementById('editCoverVideoUrl')?.value?.trim();
  if (!url) { Toast.show('请先添加封面视频', 'info'); return; }
  Toast.show('视频翻译功能开发中', 'info');
}
function aiGenerateVideo() {
  Toast.show('AI生视频功能开发中', 'info');
}
function editVideo() {
  Toast.show('剪辑视频功能开发中', 'info');
}
function oneClickGenerateVideo() {
  const product = window._editingProduct;
  if (!product) return;
  Toast.show('一键生成视频功能开发中', 'info');
}
function makeVideo() {
  Toast.show('制作视频功能开发中', 'info');
}

/**
 * 从编辑表单 DOM 收集数据并写入 product 对象（公共逻辑）
 * saveProductData 与 saveProductDataOnly 共享，避免重复代码
 * @param {object} product - 待写入的目标商品对象
 * @param {object} [opts] - { skipValidation?: boolean } 跳过必填校验（保存草稿时使用）
 * @throws {Error} 校验失败时抛出，含 .code='VALIDATION_FAILED' 与 .errors
 */
function collectEditFormToProduct(product, opts = {}) {
  product.title = document.getElementById('editTitle')?.value || product.title;
  // 描述和合并编号字段已移除，值从"简介"和"型号名称"类目属性字段获取
  product.description = document.querySelector('#annotationAttr .attr-field')?.value || '';
  product.mergeCode = document.querySelector('#modelAttr .attr-field')?.value || '';
  product.vatRate = getVatValue();
  // 重量尺寸：用 null 区分"未填写"与"0"，便于发布时校验
  const parseDim = (id) => {
    const v = document.getElementById(id)?.value;
    if (v === '' || v === undefined || v === null) return null;
    const n = parseFloat(v);
    return isNaN(n) ? null : n;
  };
  product.weight = parseDim('editWeight');
  product.length = parseDim('editLength');
  product.width = parseDim('editWidth');
  product.height = parseDim('editHeight');

  // 包裹模式
  const packageModeRadio = document.querySelector('input[name="packageMode"]:checked');
  product.packageMode = packageModeRadio?.value || 'sku';

  // 积分评价
  const pointsCheckbox = document.getElementById('editPointsForReviews');
  product.pointsForReviews = pointsCheckbox?.checked ? 'enable' : 'disable';

  // 视频URL列表（封面视频 + 描述视频）
  const videos = [];
  const coverVideoUrl = document.getElementById('editCoverVideoUrl')?.value?.trim() || '';
  if (coverVideoUrl) {
    videos.push(coverVideoUrl);
    // 同时保留 coverVideoUrl 字段，便于编辑时区分封面视频
    product.coverVideoUrl = coverVideoUrl;
  } else {
    product.coverVideoUrl = '';
  }
  document.querySelectorAll('.desc-video-item').forEach(item => {
    const url = item.getAttribute('data-url') || '';
    if (url) videos.push(url);
  });
  product.videos = videos;

  // 多条货源链接
  const sourceLinks = [];
  document.querySelectorAll('#sourceLinksList .source-link-row').forEach(row => {
    const remark = row.querySelector('.source-remark-input input')?.value || '';
    const url = row.querySelector('.source-url-input input')?.value || '';
    if (remark || url) sourceLinks.push({ remark, url });
  });
  product.sourceLinks = sourceLinks;
  // 同步 sourceLink/sourceName 为第一条货源链接（保持向后兼容）
  if (sourceLinks.length > 0) {
    product.sourceLink = sourceLinks[0].url || '';
    if (sourceLinks[0].remark) product.sourceName = sourceLinks[0].remark;
  }

  // 保存类目ID（Ozon发布必需）
  if (window._selectedCategory) {
    product.descriptionCategoryId = window._selectedCategory.description_category_id;
    product.typeId = window._selectedCategory.type_id;
    product.category = window._selectedCategory.label || product.category;
  }

  // 收集类目属性
  product.attributes = collectCategoryAttributes();
  console.log('[collectEditFormToProduct] 收集到类目属性:', product.attributes.length, '条',
    product.attributes.map(a => ({ id: a.id, name: a.name, value: a.value, dictId: a.dictionary_value_id, dictIds: a.dictionary_value_ids })));

  // 11254 is the publish source of truth; mirror it to richContent so a later
  // category re-render or edit-page reopen cannot fall back to stale data.
  const collectedRichAttr = product.attributes.find(a => String(a.id || '') === '11254');
  const renderedRichField = document.querySelector('#richContentAttr [data-attr-id="11254"]');
  if (renderedRichField) product.richContent = collectedRichAttr?.value || '';

  // richContent 保留：若类目无 11254 属性（#richContentAttr 未渲染），
  // 但 product.richContent 有值，则手动追加到 attributes 防止丢失
  const hasRichContentAttr = document.querySelector('#richContentAttr [data-attr-id="11254"]');
  if (!hasRichContentAttr && product.richContent) {
    let richJson = '';
    try { richJson = typeof product.richContent === 'string' ? product.richContent : JSON.stringify(product.richContent); } catch (_) {}
    if (richJson) {
      // 去重：移除已存在的 11254 条目
      product.attributes = product.attributes.filter(a => a.id !== 11254);
      product.attributes.push({ id: 11254, name: 'JSON富内容（Rich-контент JSON）', value: richJson });
    }
  }

  // 保存销售属性
  product.skuAttrs = JSON.parse(JSON.stringify(window._skuAttrs || []));

  // 收集SKU表格数据
  product.skus = collectSkuTableData();

  // 同步商品级价格：从 SKU 表格取价格同步到 product.price/oldPrice/sourcePrice
  // 避免 buildOzonPayload 提交过期价格（单 SKU 商品尤其需要）
  if (Array.isArray(product.skus) && product.skus.length > 0) {
    const firstSku = product.skus[0];
    if (firstSku.price) product.price = firstSku.price;
    if (firstSku.oldPrice) product.oldPrice = firstSku.oldPrice;
    if (firstSku.sourcePrice) product.sourcePrice = firstSku.sourcePrice;
  }

  // 同步 skuList/variants 与 skus 保持一致（避免三字段不一致导致 find_by_sku 等逻辑命中过期数据）
  // skuList: 从 skus 推导出兼容格式
  if (Array.isArray(product.skus)) {
    product.skuList = product.skus.map(function (s) {
      return {
        name: s.combo ? Object.values(s.combo).filter(Boolean).join(' / ') : '',
        sku: s.skuCode || '',
        skuId: s.skuCode || '',
        price: s.sourcePrice || s.price || 0,
        stock: s.stock || 0,
      };
    });
    product.variants = JSON.parse(JSON.stringify(product.skus));
  }

  // 校验必填属性（类目属性 + 重量）
  if (!opts.skipValidation) {
    const errors = [];
    // 类目必填属性校验
    if (typeof validateAllRequiredAttrs === 'function') {
      if (!validateAllRequiredAttrs()) {
        errors.push('请填写所有必填的类目属性（红色边框标记）');
      }
    }
    // 重量校验：Ozon 要求 weight > 0，发布前必填，但保存草稿时允许空
    // 此处不强制，由 publishProduct 单独校验
    if (errors.length > 0) {
      const err = new Error(errors.join('\n'));
      err.code = 'VALIDATION_FAILED';
      err.errors = errors;
      throw err;
    }
  }
}

/**
 * 保存商品数据：从表单收集 → 校验 → 同步后端 → 关闭弹窗
 * 后端失败时不会关闭弹窗，提示用户后保留修改
 */
async function saveProductData(product) {
  try {
    // 1. 收集并校验（保存时只校验类目必填属性，发布校验由 publishProduct 单独负责）
    collectEditFormToProduct(product);

    // 2. 同步到后端
    let updateOk = false;
    let errMsg = '';
    try {
      const resp = await Api.updateProduct(product.id, product);
      // 业务层错误（非 200 code）也视为失败
      if (resp && resp.code === 200) {
        updateOk = true;
        // 后端返回的最新数据同步回内存
        if (resp.data) {
          Object.assign(product, resp.data);
        }
      } else {
        errMsg = (resp && resp.msg) || '更新失败';
      }
    } catch (e) {
      errMsg = e.message || '网络异常';
    }

    if (!updateOk) {
      Toast.show('保存失败：' + errMsg, 'error', 5000);
      return false;
    }

    // 3. 同步 allProducts 中的引用，并标记为已同步（再次编辑时无需重复拉取后端）
    _syncedProductIds.add(product.id);
    const idx = allProducts.findIndex(p => p.id === product.id);
    if (idx >= 0) allProducts[idx] = product;

    // 4. 关闭弹窗（保存成功，直接 forceClose 跳过 dirty 守卫）
    await Modal.forceClose();
    // 清理会话状态
    window._editFormInitialSnapshot = null;
    window._editSessionId = null;
    renderTable();
    Toast.show('保存成功', 'success');
    return true;
  } catch (err) {
    if (err.code === 'VALIDATION_FAILED') {
      Toast.show(err.message, 'error', 5000);
    } else {
      console.error('保存失败:', err);
      Toast.show('保存失败: ' + (err.message || '未知错误'), 'error');
    }
    return false;
  }
}

/** 收集SKU表格中的数据 */
function collectSkuTableData() {
  const rows = document.querySelectorAll('#skuTableWrap tr[data-sku-index]');
  const skuList = [];
  // 构建表格列属性（与 generateSkuTable 一致）：
  // - salesAttrs（销售属性，有值）+ legacyAttrs（兼容旧数据，有值）：显示单元格，从 data-original 读取
  // - infoAttrs（SKU信息属性，排除 件数/颜色名称）：输入框，从 input.value 读取
  const allSkuAttrs = (Array.isArray(window._skuAttrs) ? window._skuAttrs : [])
    .filter(a => a && a.name);
  const INFO_ATTR_SKIP_KEYWORDS = ['一个商品中的件数', '颜色名称', 'название цвета', 'color name'];
  const tableAttrs = allSkuAttrs.filter(a => {
    if (a.attrCategory === 'sales' || !a.attrCategory) {
      // 销售属性 / 兼容旧数据：必须有值才在表格中
      return Array.isArray(a.values) && a.values.filter(v => v !== '').length > 0;
    }
    if (a.attrCategory === 'info') {
      // SKU信息属性：跳过 件数/颜色名称（由卡片UI管理），其余均在表格中
      return !INFO_ATTR_SKIP_KEYWORDS.some(kw => a.name.toLowerCase().includes(kw.toLowerCase()));
    }
    return false;
  });

  // 颜色名称与商品颜色在合并卡片中共享值索引（values[vi] 一一对应）。
  // 颜色名称不在表格列中显示，但需要按 SKU 独立提交到 sources[].attributes。
  // 这里建立 "商品颜色值 → 颜色名称" 映射，在收集每个 SKU 的 combo 时同步补充。
  const colorAttrForMapping = allSkuAttrs.find(a => a.skuType === 'color');
  // 使用更宽泛的关键词匹配颜色名称属性（兼容中/俄/英文名称）
  const COLOR_NAME_KEYWORDS_MAP = ['颜色名称', 'название цвета', 'color name'];
  let colorNameAttrForMapping = allSkuAttrs.find(a =>
    a.skuType === 'text' && a.name &&
    COLOR_NAME_KEYWORDS_MAP.some(kw => a.name.toLowerCase().includes(kw.toLowerCase()))
  );
  // 回退：如果按关键词未找到，取第一个 text 类型属性（与渲染逻辑 renderSkuAttrCards 一致）
  if (!colorNameAttrForMapping && colorAttrForMapping) {
    const colorIdx = allSkuAttrs.indexOf(colorAttrForMapping);
    colorNameAttrForMapping = allSkuAttrs.find((a, i) => i !== colorIdx && a.skuType === 'text');
  }
  console.log('[collectSkuTableData] 颜色名称映射检查:', {
    colorAttrForMapping: colorAttrForMapping ? { name: colorAttrForMapping.name, values: colorAttrForMapping.values } : null,
    colorNameAttrForMapping: colorNameAttrForMapping ? { name: colorNameAttrForMapping.name, attrId: colorNameAttrForMapping.attrId, attrCategory: colorNameAttrForMapping.attrCategory, skuType: colorNameAttrForMapping.skuType, values: colorNameAttrForMapping.values } : null,
    allSkuAttrs: allSkuAttrs.map(a => ({ name: a.name, skuType: a.skuType, attrCategory: a.attrCategory, attrId: a.attrId }))
  });
  const colorToNameMap = {};
  if (colorAttrForMapping && colorNameAttrForMapping &&
      Array.isArray(colorAttrForMapping.values) && Array.isArray(colorNameAttrForMapping.values)) {
    colorAttrForMapping.values.forEach((v, i) => {
      if (v && colorNameAttrForMapping.values[i] !== undefined && colorNameAttrForMapping.values[i] !== '') {
        colorToNameMap[v] = colorNameAttrForMapping.values[i];
      }
    });
  }
  console.log('[collectSkuTableData] colorToNameMap:', colorToNameMap);

  rows.forEach(row => {
    const skuIndex = parseInt(row.getAttribute('data-sku-index')) || 0;
    const getPrice = (attr) => parseFloat(row.querySelector(`input[data-sku-${attr}]`)?.value) || 0;
    const getText = (attr) => row.querySelector(`input[data-sku-${attr}]`)?.value || '';
    // 动态收集SKU属性列文本（销售属性从单元格读取，SKU信息属性从输入框读取）
    const skuAttrValues = {};
    tableAttrs.forEach((attr, idx) => {
      if (attr.attrCategory === 'info') {
        // SKU信息属性：从输入框读取（按 attrId 定位）
        const input = row.querySelector(`input[data-sku-info-attr="${attr.attrId}"]`);
        skuAttrValues[attr.name] = input?.value || '';
      } else {
        // 销售属性：从单元格的 data-original 属性读取
        const cellIdx = idx + 1; // SKU标题后的第 idx+1 个 td
        const cell = row.cells[cellIdx];
        if (cell) {
          skuAttrValues[attr.name] = cell.getAttribute('data-original') || cell.textContent?.trim() || '';
        }
      }
    });
    // 颜色名称同步补充：根据当前 SKU 的商品颜色值，从映射中取对应颜色名称
    // 这样每个 SKU 的 combo 都包含独立的颜色名称，由 buildOzonSkus 提交到 sources[].attributes
    if (colorAttrForMapping && colorNameAttrForMapping && colorAttrForMapping.name) {
      const colorVal = skuAttrValues[colorAttrForMapping.name];
      if (colorVal && colorToNameMap[colorVal] !== undefined) {
        skuAttrValues[colorNameAttrForMapping.name] = colorToNameMap[colorVal];
      }
    }
    console.log('[collectSkuTableData] SKU行', skuIndex, 'combo:', JSON.stringify(skuAttrValues));
    skuList.push({
      title: getText('title'),
      combo: skuAttrValues,
      sourcePrice: getPrice('source-price'),
      price: getPrice('price'),
      oldPrice: getPrice('old-price'),
      stock: getPrice('stock'),
      weight: getPrice('weight'),
      length: getPrice('length'),
      width: getPrice('width'),
      height: getPrice('height'),
      skuCode: getText('code'),
      images: window._skuImages[skuIndex] || [],
    });
  });
  return skuList;
}

/** 获取状态中文 */
function getStatusLabel(status) {
  return { unpublished: '未发布', scheduled: '定时发布', published: '已发布' }[status] || '未知';
}

/** AI优化商品 */
function aiOptimize(id) {
  const product = allProducts.find(p => p.id === id);
  if (!product) return;
  Toast.show(`正在AI优化「${product.title.slice(0,15)}...」`, 'info');
  setTimeout(() => {
    Toast.show('AI优化完成，标题和描述已优化', 'success');
    renderTable();
  }, 1500);
}

/** 添加/编辑备注 */
function addNote(id) {
  const product = allProducts.find(p => p.id === id);
  if (!product) return;
  Modal.show({
    title: '编辑备注',
    body: `
      <div class="form-group">
        <label class="form-label">备注内容</label>
        <textarea class="form-textarea" id="noteInput" rows="3" placeholder="输入备注信息...">${product.note || ''}</textarea>
      </div>
    `,
    footer: [
      { text: '取消', class: 'btn-ghost' },
      { text: '保存', class: 'btn-primary', onClick: async () => {
        const noteVal = document.getElementById('noteInput').value;
        product.note = noteVal;
        // 同步到后端
        try {
          await Api.updateProduct(id, { note: noteVal });
        } catch (e) {
          console.warn('备注同步后端失败:', e);
        }
        Modal.close();
        renderTable();
        Toast.show('备注已保存', 'success');
      }},
    ],
  });
}

/** 显示店铺选择弹窗，返回选中的 storeId（取消时返回 null） */
function showStoreSelectModal() {
  return new Promise(async (resolve) => {
    // 加载店铺列表（优先使用缓存）
    let stores = window._cachedStores || [];
    if (stores.length === 0) {
      try {
        const res = await Api.getStores();
        if (res.code === 200 && res.data) {
          stores = res.data.list || [];
          window._cachedStores = stores;
        }
      } catch (e) {
        Toast.show('获取店铺列表失败：' + (e.message || '未知错误'), 'error');
        resolve(null);
        return;
      }
    }

    // 仅展示已授权（active）的店铺
    const activeStores = stores.filter(s => s.authStatus === 'active');

    if (activeStores.length === 0) {
      Toast.show('没有已授权的店铺，请先在店铺管理中添加并授权店铺', 'error', 4000);
      resolve(null);
      return;
    }

    // 默认选中第一个
    const defaultStoreId = activeStores[0].store_id || activeStores[0].storeId || activeStores[0].id;

    const storeListHtml = activeStores.map((s, i) => {
      const sid = s.store_id || s.storeId || s.id;
      const checked = i === 0 ? 'checked' : '';
      return `
        <label class="store-publish-option" data-store-id="${escapeAttr(sid)}" style="display:flex;align-items:center;gap:10px;padding:12px 14px;border:1px solid var(--border-color);border-radius:8px;cursor:pointer;transition:all .15s;">
          <input type="radio" name="publishStoreTarget" value="${escapeAttr(sid)}" ${checked} style="width:16px;height:16px;accent-color:#2563eb;cursor:pointer;flex-shrink:0;">
          <div style="flex:1;min-width:0;">
            <div style="font-weight:500;color:var(--text-primary);font-size:14px;">${escapeHtml(s.alias || sid)}</div>
            <div style="display:flex;gap:8px;align-items:center;margin-top:4px;font-size:12px;color:var(--text-tertiary);flex-wrap:wrap;">
              <span>${escapeHtml(sid)}</span>
              ${s.currency ? `<span class="currency-badge">${escapeHtml(s.currency)}</span>` : ''}
              ${s.storeGroup || s.group ? `<span>${escapeHtml(s.storeGroup || s.group)}</span>` : ''}
            </div>
          </div>
          <span class="store-status-badge status-active" style="flex-shrink:0;">已授权</span>
        </label>`;
    }).join('');

    Modal.show({
      title: '选择发布店铺',
      size: 'sm',
      body: `
        <p style="font-size:13px;color:var(--text-secondary);margin-bottom:14px;">请选择要发布到的 Ozon 店铺：</p>
        <div style="display:flex;flex-direction:column;gap:8px;">${storeListHtml}</div>
      `,
      footer: [
        { text: '取消', class: 'btn-ghost', onClick: () => { Modal.close(); resolve(null); } },
        { text: '确定发布', class: 'btn-primary', onClick: () => {
          const selected = document.querySelector('input[name="publishStoreTarget"]:checked');
          Modal.close();
          resolve(selected ? selected.value : defaultStoreId);
        } },
      ],
      onOpen: () => {
        // 获取顶层弹窗（刚创建的店铺选择弹窗）
        const overlays = document.querySelectorAll('.modal-overlay');
        const topOverlay = overlays[overlays.length - 1];
        if (!topOverlay) return;

        // 选中项高亮
        const updateHighlight = () => {
          topOverlay.querySelectorAll('.store-publish-option').forEach(label => {
            const radio = label.querySelector('input[type="radio"]');
            if (radio.checked) {
              label.style.borderColor = '#2563eb';
              label.style.background = '#eff6ff';
            } else {
              label.style.borderColor = 'var(--border-color)';
              label.style.background = '';
            }
          });
        };
        topOverlay.querySelectorAll('input[name="publishStoreTarget"]').forEach(radio => {
          radio.addEventListener('change', updateHighlight);
        });
        updateHighlight();
      },
    });
  });
}

/** 保存并发布（先保存，再发布，带状态轮询） */
async function saveAndPublish(product, id) {
  // 0. 先选择目标店铺
  const storeId = await showStoreSelectModal();
  if (!storeId) return; // 用户取消

  // 禁用按钮防止重复点击
  const btns = document.querySelectorAll('.modal-footer .btn');
  btns.forEach(b => { b.disabled = true; b.style.opacity = '0.6'; });

  try {
    // 1. 保存数据（不关闭弹窗）
    await saveProductDataOnly(product);

    // 2. 发布前校验（使用映射系统的校验）
    const validation = ProductMapping.validateForPublish(product);
    if (!validation.valid) {
      Toast.show('发布校验失败：\n' + validation.errors.join('\n'), 'error', 5000);
      return;
    }

    // 3. 发布。返回 true 表示已提交（含异步处理中），false 表示立即失败
    // 图片转存和 Ozon 载荷构建由后端 PublishService.create_task 统一处理，避免重复工作
    const publishOk = await publishProduct(id, true, storeId, {
      publishMode: resolvePublishMode(product),
    });

    // 4. 仅在提交成功时关闭弹窗；立即失败时保留弹窗以便用户查看错误并修正
    if (publishOk) {
      // 保存成功并发布已提交，直接 forceClose 跳过 dirty 守卫
      await Modal.forceClose();
      window._editFormInitialSnapshot = null;
      window._editSessionId = null;
    }
  } catch (e) {
    if (e.code === 'BACKEND_FAILED' || e.code === 'VALIDATION_FAILED') {
      Toast.show(e.message, 'error', 5000);
    } else {
      Toast.show('保存并发布失败: ' + (e.message || '未知错误'), 'error');
    }
  } finally {
    btns.forEach(b => { b.disabled = false; b.style.opacity = ''; });
  }
}

/** 收集商品中所有图片 URL（主图 + SKU图 + 详情图） */
function collectAllImages(product) {
  const images = new Set();
  // 主图
  (product.images || []).forEach(url => { if (url) images.add(url); });
  // SKU 图片
  (product.skus || []).forEach(sku => {
    if (sku.image) images.add(sku.image);
    if (sku.combo) {
      Object.values(sku.combo).forEach(val => {
        if (typeof val === 'string' && (val.startsWith('http') || val.startsWith('data:') || val.startsWith('/'))) {
          images.add(val);
        }
      });
    }
  });
  // 详情图
  (product.detailImages || []).forEach(url => { if (url) images.add(url); });
  return Array.from(images);
}

/** 根据 urlMap 替换 product 中的图片 URL */
function replaceImageUrls(product, urlMap) {
  if (Object.keys(urlMap).length === 0) return;

  const replace = (url) => urlMap[url] || url;

  // 主图
  if (product.images) {
    product.images = product.images.map(replace);
  }
  // SKU 图片
  if (product.skus) {
    product.skus.forEach(sku => {
      if (sku.image) sku.image = replace(sku.image);
      if (sku.combo) {
        Object.keys(sku.combo).forEach(key => {
          const val = sku.combo[key];
          if (typeof val === 'string' && urlMap[val]) {
            sku.combo[key] = urlMap[val];
          }
        });
      }
    });
  }
  // 详情图
  if (product.detailImages) {
    product.detailImages = product.detailImages.map(replace);
  }
}

/** 仅保存商品数据（不关闭弹窗、不显示Toast） */
async function saveProductDataOnly(product) {
  try {
    // 复用公共收集逻辑（保存并发布场景跳过必填校验，由 publishProduct 单独校验）
    collectEditFormToProduct(product, { skipValidation: true });

    // 同步到后端：失败时抛出，阻止后续发布流程
    const resp = await Api.updateProduct(product.id, product);
    if (!resp || resp.code !== 200) {
      const err = new Error((resp && resp.msg) || '后端更新失败');
      err.code = 'BACKEND_FAILED';
      throw err;
    }
    // 后端返回的最新数据同步回内存
    if (resp.data) {
      Object.assign(product, resp.data);
    }
    // 标记为已同步，再次编辑时无需重复拉取后端
    _syncedProductIds.add(product.id);
    // 同步 allProducts 引用
    const idx = allProducts.findIndex(p => p.id === product.id);
    if (idx >= 0) allProducts[idx] = product;
    // 保存成功后重置 dirty 基线
    window._editFormInitialSnapshot = _captureEditFormSnapshot(product);
  } catch (err) {
    console.error('保存失败(saveProductDataOnly):', err);
    throw err;
  }
}

function getPublishSkuCount(product) {
  const skus = Array.isArray(product?.skus)
    ? product.skus
    : (Array.isArray(product?.skuList) ? product.skuList : (Array.isArray(product?.variants) ? product.variants : []));
  return skus.filter(s => s && (s.skuCode || s.offerId || s.offer_id || s.sku || s.skuId || s.price)).length;
}

function resolvePublishMode(product, options = {}) {
  const skuCount = getPublishSkuCount(product);
  if (skuCount > 1 && options.preferSplitForMultiSku !== false) return 'split';
  const mode = String(product?.publishMode || product?.publish_mode || '').trim().toLowerCase();
  if (['split', 'separate', 'single', 'sku', 'sku_items', 'separate_skus'].includes(mode)) return 'split';
  if (['merge', 'variant', 'variants', 'group', 'grouped'].includes(mode)) return 'merge';
  return '';
}

/** 发布商品。返回 true 表示提交成功（含异步处理中），false 表示提交失败 */
async function publishProduct(id, fromSaveAndPublish = false, storeId = null, options = {}) {
  const product = allProducts.find(p => p.id === id);
  if (!product) return false;

  // 发布前校验必填字段
  const missing = [];
  if (!product.title) missing.push('产品标题');
  if (!product.descriptionCategoryId) missing.push('商品类目');
  if (!product.typeId) missing.push('商品类型');
  if (!product.mergeCode) missing.push('合并编号/SKU编码');
  if (!product.weight) missing.push('包裹重量');
  if (!product.images || product.images.length === 0) missing.push('产品图片');
  if (!product.price) missing.push('售价');

  if (missing.length > 0) {
    Toast.show(`缺少必填项：${missing.join('、')}`, 'error');
    return false;
  }

  // 校验类目必填属性（非保存并发布场景，因为弹窗已关闭）
  if (!fromSaveAndPublish && typeof validateAllRequiredAttrs === 'function') {
    if (!validateAllRequiredAttrs()) {
      Toast.show('请填写所有必填的类目属性（红色边框标记）', 'error');
      return false;
    }
  }

  Toast.show('正在提交发布到 Ozon...', 'info');
  try {
    if (!storeId) {
      storeId = await showStoreSelectModal();
      if (!storeId) return false;
    }
    const payload = { productIds: [id], platform: 'ozon' };
    payload.storeId = storeId;
    const publishMode = options.publishMode || resolvePublishMode(product);
    if (publishMode) payload.publishMode = publishMode;
    const res = await Api.submitPublish(payload);

    // 后端在所有任务立即失败时返回非 200 code（含 data.tasks 详情）
    if (res.code !== 200) {
      product.publishStatus = 'failed';
      // 优先使用后端返回的具体错误信息
      const errMsg = res.msg || '发布失败';
      // 尝试从 data.tasks 中取更详细的错误
      const failedTask = res.data?.tasks?.find(t => t.status === 'failed');
      const detailError = failedTask?.error || errMsg;
      product.publishError = detailError;
      renderTable();
      Toast.show(detailError, 'error', 6000);
      return false;
    }

    const taskIds = res.data?.taskIds || [];
    const tasks = res.data?.tasks || [];
    // 检查是否有立即失败的任务
    const failedTask = tasks.find(t => t.productId === id && t.status === 'failed');
    if (failedTask) {
      // 当前商品的任务立即失败（如图片预处理失败）
      product.publishStatus = 'failed';
      product.publishError = failedTask.error || '发布失败';
      renderTable();
      Toast.show(failedTask.error || '发布失败', 'error', 6000);
      return false;
    }

    // 提交成功，进入异步处理状态
    product.status = 'published';
    product.publishStatus = 'processing';
    delete product.publishError;
    renderTable();
    Toast.show('已提交发布，正在查询 Ozon 审核状态...', 'success');

    // 轮询发布状态
    if (taskIds.length > 0) {
      pollPublishStatus(id, taskIds[0]);
    }
    return true;
  } catch (e) {
    product.publishStatus = 'failed';
    renderTable();
    Toast.show('发布失败: ' + (e.message || '未知错误'), 'error');
    return false;
  }
}

/** 轮询发布状态。首次立即检查，之后按 interval 间隔轮询 */
async function pollPublishStatus(productId, taskId, maxRetries = 12, interval = 10000) {
  for (let i = 0; i < maxRetries; i++) {
    // 首次立即检查（i===0 不等待），后续按 interval 间隔轮询
    if (i > 0) {
      await new Promise(r => setTimeout(r, interval));
    }

    try {
      const res = await Api.getPublishStatus(taskId);
      if (res.code !== 200) {
        // 首次查询失败时，稍作等待后继续
        if (i === 0) await new Promise(r => setTimeout(r, 2000));
        continue;
      }

      const statusInfo = res.data || {};
      const status = statusInfo.status;
      const product = allProducts.find(p => p.id === productId);
      if (!product) break;

      if (status === 'published') {
        product.publishStatus = 'published';
        if (statusInfo.message) {
          const match = statusInfo.message.match(/Ozon ID:\s*(\d+)/);
          if (match) product.ozonProductId = match[1];
        }
        renderTable();
        Toast.show('发布成功！商品已通过 Ozon 审核', 'success');
        return;
      }

      if (status === 'published_with_errors') {
        product.publishStatus = 'published_with_errors';
        if (statusInfo.message) {
          const match = statusInfo.message.match(/Ozon ID:\s*(\d+)/);
          if (match) product.ozonProductId = match[1];
        }
        renderTable();
        const errMsg = (statusInfo.errors || []).join('\n');
        Modal.alert(
          '商品已创建但需修正',
          `商品已在 Ozon 创建，但存在以下问题需要修正：\n\n${errMsg || statusInfo.message}`,
          'warning'
        );
        return;
      }

      if (status === 'failed') {
        product.publishStatus = 'failed';
        product.publishError = statusInfo.message || 'Ozon 审核未通过';
        renderTable();
        Toast.show('发布失败: ' + (statusInfo.message || 'Ozon 审核未通过'), 'error', 6000);
        return;
      }

      if (status === 'skipped') {
        product.publishStatus = 'skipped';
        renderTable();
        Toast.show('商品被 Ozon 跳过: ' + (statusInfo.message || ''), 'warning');
        return;
      }

      // 仍在处理中
      product.publishStatus = 'processing';
      renderTable();

    } catch (e) {
      // 查询失败不中断轮询
      console.warn('发布状态查询失败:', e);
    }
  }

  // 超时
  const product = allProducts.find(p => p.id === productId);
  if (product) {
    product.publishStatus = 'processing';
    renderTable();
  }
  Toast.show('发布状态查询超时，请稍后在列表中刷新查看', 'warning');
}

/** 删除商品 */
async function deleteProduct(id) {
  const confirmed = await Modal.confirm('确定要删除该商品吗？');
  if (!confirmed) return;

  const res = await Api.deleteProduct(id);
  if (res.code === 200 || res.code === -2) {
    allProducts = allProducts.filter(p => p.id !== id);
    renderTable();
    Toast.show('已删除', 'success');
  } else {
    Toast.show(res.msg || '删除失败', 'error');
  }
}

/** 批量发布 */
async function batchPublish() {
  const checked = [...document.querySelectorAll('.table-check-item:checked')].map(el => el.value);
  if (checked.length === 0) { Toast.show('请先选择商品', 'warning'); return; }

  // 校验选中商品是否满足发布条件
  const invalidProducts = [];
  for (const pid of checked) {
    const product = allProducts.find(p => p.id === pid);
    if (!product) { invalidProducts.push({ id: pid, reason: '商品不存在' }); continue; }
    const missing = [];
    if (!product.title) missing.push('标题');
    if (!product.descriptionCategoryId) missing.push('类目');
    if (!product.typeId) missing.push('类型');
    if (!product.mergeCode) missing.push('合并编号');
    if (!product.weight) missing.push('重量');
    if (!product.images || product.images.length === 0) missing.push('图片');
    if (!product.price) missing.push('售价');
    if (missing.length > 0) {
      invalidProducts.push({ id: pid, title: product.title, reason: missing.join('、') });
    }
  }

  if (invalidProducts.length > 0) {
    const msg = invalidProducts.slice(0, 3).map(p => `「${(p.title || p.id).slice(0, 20)}」缺: ${p.reason}`).join('\n');
    Toast.show(`${invalidProducts.length} 个商品缺少必填项，无法发布\n${msg}${invalidProducts.length > 3 ? '\n...' : ''}`, 'error', 5000);
    return;
  }

  // 确认发布
  const confirmed = await Modal.confirm(`确定要发布选中的 ${checked.length} 个商品到 Ozon 吗？`);
  if (!confirmed) return;
  const storeId = await showStoreSelectModal();
  if (!storeId) return;

  Toast.show(`正在提交 ${checked.length} 个商品的发布任务...`, 'info');

  // 调用发布接口（后端会异步处理）
  try {
    const payload = { productIds: checked, platform: 'ozon' };
    payload.storeId = storeId;
    if (checked.some(pid => resolvePublishMode(allProducts.find(p => p.id === pid)) === 'split')) {
      payload.publishMode = 'split';
    }
    const res = await Api.submitPublish(payload);

    // 后端返回非 200 表示所有任务都立即失败
    if (res.code !== 200) {
      const errMsg = res.msg || '批量发布失败';
      const failedTasks = res.data?.tasks || [];
      // 标记所有商品为 failed
      for (const pid of checked) {
        const product = allProducts.find(p => p.id === pid);
        if (product) {
          product.publishStatus = 'failed';
          const t = failedTasks.find(ft => ft.productId === pid);
          product.publishError = t?.error || errMsg;
        }
      }
      renderTable();
      Toast.show(errMsg, 'error', 6000);
      return;
    }

    const taskCount = res.data?.count || checked.length;
    const tasks = res.data?.tasks || [];
    const failedCount = res.data?.failedCount || 0;
    const taskIds = res.data?.taskIds || [];

    // 按任务实际状态更新商品
    let processingCount = 0;
    for (let i = 0; i < checked.length; i++) {
      const pid = checked[i];
      const product = allProducts.find(p => p.id === pid);
      if (!product) continue;
      const t = tasks.find(ft => ft.productId === pid);
      if (t && t.status === 'failed') {
        // 立即失败的任务
        product.publishStatus = 'failed';
        product.publishError = t.error || '发布失败';
      } else {
        // 已提交，进入异步处理
        product.status = 'published';
        product.publishStatus = 'processing';
        delete product.publishError;
        processingCount++;
      }
    }
    renderTable();

    if (failedCount > 0 && processingCount > 0) {
      Toast.show(`已提交 ${processingCount} 个任务，${failedCount} 个立即失败`, 'warning', 6000);
    } else if (failedCount > 0) {
      Toast.show(`${failedCount} 个商品发布失败`, 'error', 6000);
    } else {
      Toast.show(`已提交 ${taskCount} 个发布任务，后台正在处理`, 'success');
    }

    // 仅对未失败的任务轮询发布状态，并显示批量进度弹窗
    const processingTasks = [];
    for (let i = 0; i < checked.length && i < taskIds.length; i++) {
      const pid = checked[i];
      const t = tasks.find(ft => ft.productId === pid);
      if (t && t.status !== 'failed') {
        processingTasks.push({ productId: pid, taskId: taskIds[i] });
      }
    }

    if (processingTasks.length > 0) {
      showBatchProgressModal(processingTasks);
    }

    // 延迟刷新列表
    setTimeout(() => loadProducts(), 3000);
  } catch (e) {
    Toast.show('批量发布失败: ' + (e.message || '未知错误'), 'error');
  }
}

/** 显示批量发布进度弹窗，实时更新每个商品的发布状态 */
function showBatchProgressModal(tasks) {
  const total = tasks.length;
  let completed = 0;
  let failed = 0;
  // 记录失败任务，便于"重试失败项"功能使用
  const failedTasks = [];

  // 创建进度弹窗
  const modal = document.createElement('div');
  modal.id = 'batchProgressModal';
  modal.style.cssText = 'position:fixed;top:0;left:0;right:0;bottom:0;background:rgba(0,0,0,0.5);z-index:9999;display:flex;align-items:center;justify-content:center;';

  const content = document.createElement('div');
  content.style.cssText = 'background:white;border-radius:8px;padding:24px;min-width:450px;max-width:600px;max-height:80vh;overflow:auto;';
  content.innerHTML = `
    <h3 style="margin:0 0 16px 0;">批量发布进度</h3>
    <div style="margin-bottom:16px;">
      <div style="display:flex;justify-content:space-between;margin-bottom:8px;font-size:14px;">
        <span id="batchProgressText">已完成 0 / ${total}</span>
        <span id="batchProgressStats">成功 0 | 失败 0</span>
      </div>
      <div style="background:#e5e7eb;border-radius:4px;height:8px;overflow:hidden;">
        <div id="batchProgressBar" style="background:#3b82f6;height:100%;width:0%;transition:width 0.3s;"></div>
      </div>
    </div>
    <div id="batchProgressList" style="font-size:13px;line-height:1.8;"></div>
    <div style="margin-top:16px;text-align:right;">
      <button id="batchProgressRetry" class="btn btn-secondary" style="display:none;margin-right:8px;">重试失败项</button>
      <button id="batchProgressClose" class="btn btn-ghost" style="display:none;">关闭</button>
    </div>
  `;
  modal.appendChild(content);
  document.body.appendChild(modal);

  const progressText = content.querySelector('#batchProgressText');
  const progressStats = content.querySelector('#batchProgressStats');
  const progressBar = content.querySelector('#batchProgressBar');
  const progressList = content.querySelector('#batchProgressList');
  const closeBtn = content.querySelector('#batchProgressClose');
  const retryBtn = content.querySelector('#batchProgressRetry');

  // 为每个任务创建状态行
  const taskRows = {};
  tasks.forEach(t => {
    const product = allProducts.find(p => p.id === t.productId);
    const row = document.createElement('div');
    row.innerHTML = `<span style="color:#6b7280;">⏳</span> ${(product?.title || t.productId).slice(0, 30)}... <span style="color:#6b7280;">处理中</span>`;
    progressList.appendChild(row);
    taskRows[t.productId] = row;
  });

  closeBtn.onclick = () => modal.remove();

  // 重试失败项：对每个失败任务调用 retryPublishTask，重置状态后重新轮询
  retryBtn.onclick = async () => {
    if (failedTasks.length === 0) return;
    retryBtn.disabled = true;
    retryBtn.textContent = '重试中...';

    // 重置计数器和进度条
    completed = 0;
    failed = 0;
    const retryList = [...failedTasks];
    failedTasks.length = 0;
    progressBar.style.width = '0%';
    progressBar.style.background = '#3b82f6';
    closeBtn.style.display = 'none';
    retryBtn.style.display = 'none';
    progressText.textContent = `已完成 0 / ${retryList.length}`;
    progressStats.textContent = `成功 0 | 失败 0`;

    // 逐个重试（断点续传在后端自动处理）
    for (const t of retryList) {
      try {
        const res = await Api.retryPublishTask(t.taskId);
        if (res.code !== 200) {
          // 重试提交失败，直接标记失败
          const row = taskRows[t.productId];
          const product = allProducts.find(p => p.id === t.productId);
          completed++;
          failed++;
          if (row) row.innerHTML = `<span style="color:#dc2626;">✗</span> ${(product?.title || t.productId).slice(0, 30)}... <span style="color:#dc2626;">重试失败: ${(res.message || '').slice(0, 50)}</span>`;
          failedTasks.push(t);
          continue;
        }

        // 重置该任务的状态行
        const row = taskRows[t.productId];
        const product = allProducts.find(p => p.id === t.productId);
        if (row) row.innerHTML = `<span style="color:#6b7280;">⏳</span> ${(product?.title || t.productId).slice(0, 30)}... <span style="color:#6b7280;">重试中</span>`;

        // 重新轮询
        pollBatchTaskStatus(t.productId, t.taskId, (status, error) => {
          completed++;
          const r = taskRows[t.productId];
          const p = allProducts.find(p => p.id === t.productId);
          if (p) p.publishStatus = status;

          if (status === 'failed') {
            failed++;
            failedTasks.push(t);
            if (r) r.innerHTML = `<span style="color:#dc2626;">✗</span> ${(p?.title || t.productId).slice(0, 30)}... <span style="color:#dc2626;">失败: ${(error || '').slice(0, 50)}</span>`;
          } else if (status === 'published_with_errors') {
            if (r) r.innerHTML = `<span style="color:#f59e0b;">⚠</span> ${(p?.title || t.productId).slice(0, 30)}... <span style="color:#f59e0b;">已发布（有警告）</span>`;
          } else if (status === 'published') {
            if (r) r.innerHTML = `<span style="color:#16a34a;">✓</span> ${(p?.title || t.productId).slice(0, 30)}... <span style="color:#16a34a;">成功</span>`;
          } else {
            if (r) r.innerHTML = `<span style="color:#6b7280;">•</span> ${(p?.title || t.productId).slice(0, 30)}... <span style="color:#6b7280;">${status}</span>`;
          }

          const pct = (completed / retryList.length) * 100;
          progressBar.style.width = pct + '%';
          progressText.textContent = `已完成 ${completed} / ${retryList.length}`;
          progressStats.textContent = `成功 ${completed - failed} | 失败 ${failed}`;

          if (completed >= retryList.length) {
            progressBar.style.background = failed > 0 ? '#f59e0b' : '#16a34a';
            closeBtn.style.display = 'inline-block';
            if (failed > 0) retryBtn.style.display = 'inline-block';
            retryBtn.disabled = false;
            retryBtn.textContent = '重试失败项';
            renderTable();
          }
        });
      } catch (e) {
        // 网络异常，跳过此任务
        completed++;
        failed++;
        failedTasks.push(t);
      }
    }
  };

  // 轮询每个任务
  tasks.forEach(t => {
    pollBatchTaskStatus(t.productId, t.taskId, (status, error) => {
      completed++;
      const row = taskRows[t.productId];
      const product = allProducts.find(p => p.id === t.productId);
      if (product) product.publishStatus = status;

      if (status === 'failed') {
        failed++;
        failedTasks.push(t);
        if (row) row.innerHTML = `<span style="color:#dc2626;">✗</span> ${(product?.title || t.productId).slice(0, 30)}... <span style="color:#dc2626;">失败: ${(error || '').slice(0, 50)}</span>`;
      } else if (status === 'published_with_errors') {
        if (row) row.innerHTML = `<span style="color:#f59e0b;">⚠</span> ${(product?.title || t.productId).slice(0, 30)}... <span style="color:#f59e0b;">已发布（有警告）</span>`;
      } else if (status === 'published') {
        if (row) row.innerHTML = `<span style="color:#16a34a;">✓</span> ${(product?.title || t.productId).slice(0, 30)}... <span style="color:#16a34a;">成功</span>`;
      } else {
        if (row) row.innerHTML = `<span style="color:#6b7280;">•</span> ${(product?.title || t.productId).slice(0, 30)}... <span style="color:#6b7280;">${status}</span>`;
      }

      // 更新进度条
      const pct = (completed / total) * 100;
      progressBar.style.width = pct + '%';
      progressText.textContent = `已完成 ${completed} / ${total}`;
      progressStats.textContent = `成功 ${completed - failed} | 失败 ${failed}`;

      if (completed >= total) {
        progressBar.style.background = failed > 0 ? '#f59e0b' : '#16a34a';
        closeBtn.style.display = 'inline-block';
        if (failed > 0) retryBtn.style.display = 'inline-block';
        renderTable();
      }
    });
  });
}

/** 轮询单个批量任务状态，通过回调返回结果 */
async function pollBatchTaskStatus(productId, taskId, callback, maxRetries = 12, interval = 10000) {
  for (let i = 0; i < maxRetries; i++) {
    try {
      const res = await Api.getPublishStatus(taskId);
      if (res.code === 200 && res.data) {
        const status = res.data.status;
        if (status && status !== 'processing' && status !== 'pending') {
          callback(status, res.data.error || res.data.message);
          return;
        }
      }
    } catch (e) {
      // 查询失败，继续重试
    }
    if (i < maxRetries - 1) {
      await new Promise(r => setTimeout(r, interval));
    }
  }
  // 超时
  callback('processing', '查询超时，请稍后刷新查看');
}

/** 批量删除 */
async function batchDelete() {
  const checked = [...document.querySelectorAll('.table-check-item:checked')].map(el => el.value);
  if (checked.length === 0) { Toast.show('请先选择商品', 'warning'); return; }
  const confirmed = await Modal.confirm(`确定要删除选中的 ${checked.length} 个商品吗？`);
  if (!confirmed) return;

  const res = await Api.batchDeleteProducts(checked);
  if (res.code === 200 || res.code === -2) {
    allProducts = allProducts.filter(p => !checked.includes(p.id));
    renderTable();
    Toast.show(`已删除 ${res.data?.deleted || checked.length} 个商品`, 'success');
  } else {
    Toast.show(res.msg || '批量删除失败', 'error');
  }
}

/** 格式化时间 */
function formatTime(isoStr) {
  if (!isoStr) return '--';
  const d = new Date(isoStr);
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')} ${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}:${String(d.getSeconds()).padStart(2,'0')}`;
}

/** 搜1688同款 */
function search1688(productId) {
  const product = allProducts.find(p => p.id === productId);
  if (product) {
    Toast.show(`正在搜索「${product.title.slice(0,20)}...」的1688同款`, 'info');
  }
}

// 注册路由
Router.register('/collect', renderCollectPage);

/** 打开类目选择弹窗（三级级联 + 中文-俄语双语） */
async function openCategorySelector() {
  document.getElementById('categorySelectorModal')?.remove();

  // 显示加载中弹窗
  const modal = document.createElement('div');
  modal.id = 'categorySelectorModal';
  modal.innerHTML = `
    <div class="modal-overlay" onclick="closeCategorySelector()" style="position:fixed;inset:0;background:rgba(0,0,0,0.4);z-index:9998;display:flex;align-items:center;justify-content:center;">
      <div class="category-selector-modal" onclick="event.stopPropagation()" style="background:var(--bg-card);border-radius:12px;width:700px;max-height:80vh;display:flex;flex-direction:column;box-shadow:0 20px 60px rgba(0,0,0,0.3);">
        <div style="padding:16px 20px;border-bottom:1px solid var(--border-color-light);display:flex;align-items:center;justify-content:space-between;">
          <h3 style="margin:0;font-size:16px;">选择商品类目</h3>
          <div style="display:flex;align-items:center;gap:8px;">
            <button class="btn btn-xs btn-ghost" onclick="refreshCategoryTree()" title="刷新类目数据">刷新</button>
            <button onclick="closeCategorySelector()" style="background:none;border:none;font-size:20px;cursor:pointer;color:var(--text-secondary);padding:0 4px;">&times;</button>
          </div>
        </div>
        <div style="padding:16px 20px;display:flex;gap:10px;flex-wrap:wrap;">
          <div style="flex:1;min-width:180px;">
            <label style="font-size:12px;color:var(--text-secondary);margin-bottom:4px;display:block;">一级类目</label>
            <select id="catL1" class="form-input" onchange="onCatL1Change()" style="width:100%;">
              <option value="">加载中...</option>
            </select>
          </div>
          <div style="flex:1;min-width:180px;">
            <label style="font-size:12px;color:var(--text-secondary);margin-bottom:4px;display:block;">二级类目</label>
            <select id="catL2" class="form-input" onchange="onCatL2Change()" style="width:100%;" disabled>
              <option value="">请先选择一级类目</option>
            </select>
          </div>
          <div style="flex:1;min-width:180px;">
            <label style="font-size:12px;color:var(--text-secondary);margin-bottom:4px;display:block;">三级类目（类型）</label>
            <select id="catL3" class="form-input" style="width:100%;" disabled>
              <option value="">请先选择二级类目</option>
            </select>
          </div>
        </div>
        <div style="padding:0 20px 12px;">
          <input type="text" id="categorySearchInput" class="form-input" placeholder="搜索类目名称" oninput="filterCategoryList(this.value)" style="width:100%;">
        </div>
        <div id="categoryListContainer" style="flex:1;overflow-y:auto;padding:0 20px 20px;">
          <div style="text-align:center;color:var(--text-tertiary);padding:24px 0;font-size:13px;">请通过上方级联选择或搜索类目</div>
        </div>
        <div style="padding:12px 20px;border-top:1px solid var(--border-color-light);display:flex;justify-content:flex-end;gap:8px;">
          <button class="btn btn-sm btn-ghost" onclick="closeCategorySelector()">取消</button>
          <button class="btn btn-sm btn-primary" onclick="confirmCategorySelection()">确认选择</button>
        </div>
      </div>
    </div>
  `;
  document.body.appendChild(modal);

  // 拉取 Ozon 真实类目树
  try {
    const res = await Api.getCategories();
    const tree = res?.data || [];
    window._categoryTree = tree;

    // 构建一级选项
    const l1Select = document.getElementById('catL1');
    l1Select.innerHTML = '<option value="">请选择</option>' + tree.map(l1 =>
      `<option value="${l1.description_category_id}">${l1.category_name}</option>`
    ).join('');

    // 构建扁平列表供搜索
    buildFlatList(tree);
  } catch (e) {
    console.error('拉取类目树失败:', e);
    document.getElementById('catL1').innerHTML = '<option value="">加载失败</option>';
    Toast.show('拉取类目树失败: ' + (e.message || '未知错误'), 'error');
  }
}

/** 刷新类目树（清除缓存） */
async function refreshCategoryTree() {
  try {
    Toast.show('正在刷新类目数据...', 'info');
    const res = await Api.getCategories(true);
    const tree = res?.data || [];
    window._categoryTree = tree;

    const l1Select = document.getElementById('catL1');
    l1Select.innerHTML = '<option value="">请选择</option>' + tree.map(l1 =>
      `<option value="${l1.description_category_id}">${l1.category_name}</option>`
    ).join('');

    document.getElementById('catL2').innerHTML = '<option value="">请先选择一级类目</option>';
    document.getElementById('catL2').disabled = true;
    document.getElementById('catL3').innerHTML = '<option value="">请先选择二级类目</option>';
    document.getElementById('catL3').disabled = true;

    buildFlatList(tree);
    Toast.show('类目数据已刷新', 'success');
  } catch (e) {
    Toast.show('刷新失败: ' + (e.message || ''), 'error');
  }
}

/** 构建扁平列表供搜索 */
function buildFlatList(tree) {
  const flat = [];
  for (const l1 of tree) {
    for (const l2 of (l1.children || [])) {
      for (const l3 of (l2.children || [])) {
        if (l3.type_id) {
          flat.push({
            description_category_id: l2.description_category_id,
            type_id: l3.type_id,
            label: `${l1.category_name} / ${l2.category_name} / ${l3.type_name}`,
            l1_name: l1.category_name,
            l2_name: l2.category_name,
            l3_name: l3.type_name,
            search_text: [l1.category_name_zh, l1.category_name_ru, l2.category_name_zh, l2.category_name_ru, l3.type_name_zh, l3.type_name_ru].filter(Boolean).join(' ').toLowerCase(),
          });
        }
      }
    }
  }
  window._categoryFlat = flat;
}

/** 一级类目变更 */
function onCatL1Change() {
  const l1Id = parseInt(document.getElementById('catL1').value);
  const l2Select = document.getElementById('catL2');
  const l3Select = document.getElementById('catL3');

  l3Select.innerHTML = '<option value="">请先选择二级类目</option>';
  l3Select.disabled = true;

  if (!l1Id) {
    l2Select.innerHTML = '<option value="">请先选择一级类目</option>';
    l2Select.disabled = true;
    return;
  }

  const l1 = window._categoryTree.find(c => c.description_category_id === l1Id);
  if (!l1 || !l1.children || l1.children.length === 0) {
    l2Select.innerHTML = '<option value="">无子类目</option>';
    l2Select.disabled = true;
    return;
  }

  l2Select.disabled = false;
  l2Select.innerHTML = '<option value="">请选择</option>' + l1.children.map(l2 =>
    `<option value="${l2.description_category_id}">${l2.category_name}</option>`
  ).join('');
}

/** 二级类目变更 */
function onCatL2Change() {
  const l1Id = parseInt(document.getElementById('catL1').value);
  const l2Id = parseInt(document.getElementById('catL2').value);
  const l3Select = document.getElementById('catL3');

  if (!l2Id) {
    l3Select.innerHTML = '<option value="">请先选择二级类目</option>';
    l3Select.disabled = true;
    return;
  }

  const l1 = window._categoryTree.find(c => c.description_category_id === l1Id);
  const l2 = l1?.children?.find(c => c.description_category_id === l2Id);
  if (!l2 || !l2.children || l2.children.length === 0) {
    l3Select.innerHTML = '<option value="">无子类目</option>';
    l3Select.disabled = true;
    return;
  }

  // L3 是 type 节点（有 type_id 和 type_name）
  l3Select.disabled = false;
  l3Select.innerHTML = '<option value="">请选择</option>' + l2.children.map(l3 =>
    `<option value="${l3.type_id}" data-desc-cat-id="${l2.description_category_id}">${l3.type_name}</option>`
  ).join('');
}

/** 确认选择 */
function confirmCategorySelection() {
  const l3Select = document.getElementById('catL3');
  const typeId = parseInt(l3Select.value);
  const selectedOption = l3Select.options[l3Select.selectedIndex];
  const descCatId = parseInt(selectedOption?.dataset?.descCatId);

  if (!typeId) {
    Toast.show('请选择三级类目（类型）', 'warning');
    return;
  }

  // 构建面包屑路径
  const l1Select = document.getElementById('catL1');
  const l2Select = document.getElementById('catL2');
  const l1Name = l1Select.options[l1Select.selectedIndex]?.text || '';
  const l2Name = l2Select.options[l2Select.selectedIndex]?.text || '';
  const l3Name = selectedOption?.text || '';
  const breadcrumbText = `${l1Name} / ${l2Name} / ${l3Name}`;

  const breadcrumb = document.getElementById('editCategoryBreadcrumb');
  const hiddenInput = document.getElementById('editCategoryValue');
  if (breadcrumb) breadcrumb.textContent = breadcrumbText;
  if (hiddenInput) hiddenInput.value = breadcrumbText;

  // 保存选中的 Ozon ID 供后续拉取特征使用
  window._selectedCategory = {
    description_category_id: descCatId,
    type_id: typeId,
    label: breadcrumbText,
  };

  closeCategorySelector();

  // 类目匹配成功，显示所有编辑面板
  revealAllEditPanels();

  // 先收集当前SKU表格数据，避免类目切换时丢失已编辑的通用字段
  const currentSkus = collectSkuTableData();
  if (currentSkus.length > 0 && window._editingProduct) {
    window._editingProduct.skus = currentSkus;
  }

  // 自动拉取该类目下的特征（保留已有SKU属性，避免清空）
  // forceRefresh=true 强制刷新缓存，确保切换到新类目时拉取最新的属性结构
  loadCategoryAttributes(descCatId, typeId, { preserveSkuAttrs: true, forceRefresh: true });
}

/** 类目匹配成功后，显示所有编辑面板 */
function revealAllEditPanels() {
  const layout = document.querySelector('.edit-product-layout');
  if (layout) layout.classList.remove('cat-step-pending');
  const guide = document.getElementById('categoryStepGuide');
  if (guide) guide.remove();
}

/**
 * 通用 SKU 属性迁移：将无 attrId 的 1688 采集属性迁移到同类型的 Ozon 属性（有 attrId）
 * 按 skuType 匹配（color→color, number→number, text→text），迁移 values 和 combo key
 * 避免类目切换后属性名变化导致 SKU 数据无法回填
 */
function migrateAliSkuAttrsToOzon() {
  if (!Array.isArray(window._skuAttrs)) return;

  // Ozon 属性（有 attrId）按 skuType 分组
  const ozonAttrsByType = {};
  window._skuAttrs.filter(a => a.attrId).forEach(a => {
    const type = a.skuType || 'default';
    if (!ozonAttrsByType[type]) ozonAttrsByType[type] = [];
    ozonAttrsByType[type].push(a);
  });

  // 1688 属性（无 attrId）逐个迁移
  const aliAttrs = window._skuAttrs.filter(a => !a.attrId);
  const toRemove = [];

  // 名称匹配函数（参考 fillAttributeValues 的同义词匹配）
  const SKU_NAME_SYNONYMS = {
    '颜色': ['цвет', 'color', '商品颜色', '颜色名称'],
    '尺寸': ['размер', 'size', '尺码'],
    '版本': ['версия', 'version', 'модификация'],
    '套装': ['комплект', 'set', 'набор'],
    '款式': ['стиль', 'style', 'модель'],
  };
  const normalize = s => String(s || '').toLowerCase().trim();
  const skuNameMatch = (aliName, ozonName) => {
    if (!aliName || !ozonName) return false;
    if (ozonName.includes(aliName) || aliName.includes(ozonName)) return true;
    const syns = SKU_NAME_SYNONYMS[aliName] || [];
    return syns.some(s => ozonName.includes(s));
  };

  aliAttrs.forEach(aliAttr => {
    const type = aliAttr.skuType || 'default';
    // 主匹配类型 + 回退类型（兼容新的 select/info skuType）
    // 1688 属性通常是 'default' 类型，需回退匹配 Ozon 的 'select'(销售) 或 'info'(信息) 属性
    const TYPE_FALLBACKS = {
      'default': ['default', 'select', 'info'],
      'color':   ['color'],
      'number':  ['number', 'info'],
      'text':    ['text', 'info'],
      'select':  ['select', 'default'],
      'info':    ['info', 'default'],
    };
    const typesToTry = TYPE_FALLBACKS[type] || [type, 'default'];

    // 按类型优先级查找：先名称匹配，回退到第一个未迁移的
    let ozonAttr = null;
    for (const t of typesToTry) {
      const candidates = ozonAttrsByType[t] || [];
      ozonAttr = candidates.find(o => !o._migrated && skuNameMatch(aliAttr.name, normalize(o.name)));
      if (!ozonAttr) {
        ozonAttr = candidates.find(o => !o._migrated);
      }
      if (ozonAttr) break;
    }
    if (!ozonAttr || ozonAttr.name === aliAttr.name) return;

    // 迁移 values（仅当 Ozon 属性 values 为空或少于 1688 时）
    const aliValues = (aliAttr.values || []).filter(v => v !== '');
    const ozonValues = (ozonAttr.values || []).filter(v => v !== '');
    if (aliValues.length > 0 && ozonValues.length === 0) {
      ozonAttr.values = [...aliValues];
    }

    // 迁移 SKU combo key（旧名 → Ozon 属性名）
    if (window._editingProduct?.skus && Array.isArray(window._editingProduct.skus)) {
      window._editingProduct.skus.forEach(sku => {
        if (sku.combo && sku.combo[aliAttr.name] !== undefined && sku.combo[ozonAttr.name] === undefined) {
          sku.combo[ozonAttr.name] = sku.combo[aliAttr.name];
          delete sku.combo[aliAttr.name];
        }
      });
    }

    ozonAttr._migrated = true;
    toRemove.push(aliAttr);
    console.log('[migrateAliSkuAttrsToOzon] 迁移:', aliAttr.name, '→', ozonAttr.name, `(skuType: ${type})`);
  });

  // 从 _skuAttrs 中移除已迁移的 1688 属性
  toRemove.forEach(a => {
    const idx = window._skuAttrs.indexOf(a);
    if (idx >= 0) window._skuAttrs.splice(idx, 1);
  });
}

/** AI智能匹配类目 */
async function aiMatchCategoryForProduct() {
  const product = window._editingProduct;
  if (!product) return;

  // 竞态保护：记录当前会话 ID，异步操作完成后校验是否仍是同一会话
  const sessionId = window._editSessionId;

  const resultDiv = document.getElementById('aiMatchResult');
  if (resultDiv) {
    resultDiv.style.display = 'block';
    resultDiv.innerHTML = '<div style="padding:12px;color:var(--text-secondary);font-size:13px;">AI 正在分析商品信息并匹配类目...</div>';
  }

  try {
    const res = await Api.aiMatchCategory(
      product.category || '',
      product.title || '',
      product.description || '',
    );

    // 竞态保护：异步操作完成前用户可能已切换商品
    if (window._editSessionId !== sessionId) {
      console.log('[aiMatchCategoryForProduct] 会话已切换，丢弃匹配结果');
      return;
    }

    if (res.code === 200 && res.data) {
      const data = res.data;
      if (data.matched) {
        // AI 匹配成功
        window._selectedCategory = {
          description_category_id: data.description_category_id,
          type_id: data.type_id,
          label: data.label,
        };

        // 更新面包屑
        const breadcrumb = document.getElementById('editCategoryBreadcrumb');
        const hiddenInput = document.getElementById('editCategoryValue');
        if (breadcrumb) breadcrumb.textContent = data.label;
        if (hiddenInput) hiddenInput.value = data.label;

        if (resultDiv) {
          resultDiv.innerHTML = `<div style="padding:12px;background:#f0fdf4;border:1px solid #bbf7d0;border-radius:8px;font-size:13px;color:#15803d;">
            <strong>AI匹配成功</strong> (${data.confidence === 'high' ? '高置信度' : '中置信度'})<br>
            <span style="color:#4b5563;">${escapeHtml(data.label)}</span><br>
            ${data.reason ? `<span style="color:#6b7280;font-size:12px;">理由: ${escapeHtml(data.reason)}</span>` : ''}
          </div>`;
        }

        // 先收集当前SKU表格数据，避免重新渲染时丢失用户已编辑的通用字段（价格/库存/货号等）
        const currentSkus = collectSkuTableData();
        if (currentSkus.length > 0 && window._editingProduct) {
          window._editingProduct.skus = currentSkus;
        }
        // 显示所有面板并加载属性
        revealAllEditPanels();
        renderSkuAttrs();
        generateSkuTable();
        renderColorSamples();
        loadCategoryAttributes(
          data.description_category_id,
          data.type_id,
          { preserveSkuAttrs: true }
        ).then(() => {
          // renderCategoryAttributes 内部已调用 renderSkuAttrs + generateSkuTable + renderColorSamples
          fillAttributeValues(product.attributes);
        });

        Toast.show('AI匹配成功: ' + data.label, 'success');
      } else {
        // AI 未匹配成功
        if (resultDiv) {
          resultDiv.innerHTML = `<div style="padding:12px;background:#fef2f2;border:1px solid #fecaca;border-radius:8px;font-size:13px;color:#dc2626;">
            <strong>AI未能匹配</strong><br>
            ${data.reason ? `<span style="color:#6b7280;font-size:12px;">${escapeHtml(data.reason)}</span>` : ''}
            ${data.candidates && data.candidates.length > 0 ? '<br><span style="color:#6b7280;font-size:12px;">候选类目:</span>' : ''}
            ${(data.candidates || []).map((c, i) => `<div style="margin-top:4px;"><a href="javascript:void(0)" onclick="selectAICandidate(${i})" style="color:#2563eb;font-size:12px;">${escapeHtml(c.label)}</a></div>`).join('')}
          </div>`;
          // 保存候选到全局变量
          window._aiCandidates = data.candidates || [];
        }
        Toast.show('AI未能确定匹配，请手动选择', 'info');
      }
    } else {
      throw new Error(res.msg || 'API请求失败');
    }
  } catch (e) {
    if (resultDiv) {
      resultDiv.innerHTML = `<div style="padding:12px;background:#fef2f2;border:1px solid #fecaca;border-radius:8px;font-size:13px;color:#dc2626;">
        <strong>匹配失败</strong><br>
        <span style="color:#6b7280;font-size:12px;">${escapeHtml(e.message || String(e))}</span><br>
        <span style="color:#6b7280;font-size:12px;">请检查 AI API Key 是否已配置，或使用手动选择类目</span>
      </div>`;
    }
    Toast.show('AI匹配失败: ' + e.message, 'error');
  }
}

/** 选择AI候选类目 */
function selectAICandidate(index) {
  const candidates = window._aiCandidates || [];
  const candidate = candidates[index];
  if (!candidate) return;

  // === 切换类目前，先收集当前已填的动态属性，避免切换后丢失 ===
  if (window._editingProduct) {
    try {
      const currentAttrs = collectCategoryAttributes();
      if (currentAttrs && currentAttrs.length > 0) {
        const existing = Array.isArray(window._editingProduct.attributes)
          ? window._editingProduct.attributes : [];
        const byId = new Map();
        existing.forEach(a => {
          const key = a.id || `name:${a.name || ''}`;
          if (key) byId.set(key, a);
        });
        currentAttrs.forEach(a => {
          const key = a.id || `name:${a.name || ''}`;
          if (key) byId.set(key, a);
        });
        window._editingProduct.attributes = Array.from(byId.values());
        console.log('[selectAICandidate] 切换类目前已保存当前动态属性:', currentAttrs.length, '项');
      }
    } catch (e) {
      console.warn('[selectAICandidate] 收集当前属性失败:', e);
    }
  }

  window._selectedCategory = {
    description_category_id: candidate.description_category_id,
    type_id: candidate.type_id,
    label: candidate.label,
  };

  const breadcrumb = document.getElementById('editCategoryBreadcrumb');
  const hiddenInput = document.getElementById('editCategoryValue');
  if (breadcrumb) breadcrumb.textContent = candidate.label;
  if (hiddenInput) hiddenInput.value = candidate.label;

  revealAllEditPanels();
  renderSkuAttrs();
  generateSkuTable();
  renderColorSamples();
  loadCategoryAttributes(
    candidate.description_category_id,
    candidate.type_id,
    { preserveSkuAttrs: true }
  ).then(() => {
    // renderCategoryAttributes 内部已调用 renderSkuAttrs + generateSkuTable + renderColorSamples
    // 延迟 100ms 确保 batchPreloadAttrOptions 完成，再回填之前保存的属性
    setTimeout(() => {
      try {
        if (window._editingProduct && Array.isArray(window._editingProduct.attributes)) {
          fillAttributeValues(window._editingProduct.attributes);
          console.log('[selectAICandidate] 已尝试回填旧属性到新类目');
        }
      } catch (e) {
        console.warn('[selectAICandidate] 回填旧属性失败:', e);
      }
    }, 100);
  });

  Toast.show('已选择: ' + candidate.label, 'success');
}

/** 关闭类目选择弹窗 */
function closeCategorySelector() {
  document.getElementById('categorySelectorModal')?.remove();
}

/** 搜索过滤类目 */
function filterCategoryList(keyword) {
  const container = document.getElementById('categoryListContainer');
  const kw = keyword.toLowerCase().trim();

  if (!kw) {
    container.innerHTML = '<div style="text-align:center;color:var(--text-tertiary);padding:24px 0;font-size:13px;">请通过上方级联选择或搜索类目</div>';
    return;
  }

  const flat = window._categoryFlat || [];
  const matched = flat.filter(c => c.label.toLowerCase().includes(kw) || (c.search_text && c.search_text.includes(kw)));

  if (matched.length === 0) {
    container.innerHTML = '<div style="text-align:center;color:var(--text-tertiary);padding:24px 0;font-size:13px;">未找到匹配的类目</div>';
    return;
  }

  // 最多显示 50 条
  const shown = matched.slice(0, 50);
  container.innerHTML = shown.map(c => `
    <div class="category-select-item" data-desc-cat-id="${c.description_category_id}" data-type-id="${c.type_id}" data-label="${c.label}" onclick="selectCategory(this)" style="padding:10px 12px;border-radius:8px;cursor:pointer;display:flex;justify-content:space-between;align-items:center;transition:background 0.15s;" onmouseover="this.style.background='var(--bg-hover)'" onmouseout="this.style.background='transparent'">
      <span style="font-size:13px;color:var(--text-primary);">${c.label}</span>
    </div>
  `).join('') + (matched.length > 50 ? `<div style="text-align:center;color:var(--text-tertiary);padding:8px;font-size:12px;">还有 ${matched.length - 50} 条结果...</div>` : '');
}

/** 搜索结果中选择类目 */
function selectCategory(el) {
  const descCatId = parseInt(el.dataset.descCatId);
  const typeId = parseInt(el.dataset.typeId);
  const label = el.dataset.label;

  // === 切换类目前，先收集当前已填的动态属性，避免切换后丢失 ===
  // 收集到的属性会按 id/name 在新类目下重新匹配回填
  if (window._editingProduct) {
    try {
      const currentAttrs = collectCategoryAttributes();
      if (currentAttrs && currentAttrs.length > 0) {
        // 合并到 product.attributes：相同 id 替换，新 id 追加
        // 这样即使新类目下没有该属性 id，数据也不会丢失，仍保留在 product.attributes 中
        const existing = Array.isArray(window._editingProduct.attributes)
          ? window._editingProduct.attributes : [];
        const byId = new Map();
        // 先放已有属性
        existing.forEach(a => {
          const key = a.id || `name:${a.name || ''}`;
          if (key) byId.set(key, a);
        });
        // 再用新收集的覆盖（同 id/name 替换）
        currentAttrs.forEach(a => {
          const key = a.id || `name:${a.name || ''}`;
          if (key) byId.set(key, a);
        });
        window._editingProduct.attributes = Array.from(byId.values());
        console.log('[selectCategory] 切换类目前已保存当前动态属性:', currentAttrs.length, '项, 累计:', window._editingProduct.attributes.length, '项');
      }
    } catch (e) {
      console.warn('[selectCategory] 收集当前属性失败:', e);
    }
  }

  const breadcrumb = document.getElementById('editCategoryBreadcrumb');
  const hiddenInput = document.getElementById('editCategoryValue');
  if (breadcrumb) breadcrumb.textContent = label;
  if (hiddenInput) hiddenInput.value = label;

  window._selectedCategory = {
    description_category_id: descCatId,
    type_id: typeId,
    label: label,
  };

  closeCategorySelector();

  // 类目匹配成功，显示所有编辑面板
  revealAllEditPanels();

  // 先收集当前SKU表格数据，避免类目切换时丢失已编辑的通用字段
  const currentSkus = collectSkuTableData();
  if (currentSkus.length > 0 && window._editingProduct) {
    window._editingProduct.skus = currentSkus;
  }

  // 自动拉取该类目下的特征（保留已有SKU属性，避免清空）
  // 拉取完成后，用 fillAttributeValues 把之前保存的属性按 id/name 重新匹配回填到新类目
  // forceRefresh=true 强制刷新缓存，确保切换到新类目时拉取最新的属性结构
  loadCategoryAttributes(descCatId, typeId, { preserveSkuAttrs: true, forceRefresh: true }).then(() => {
    if (window._editingProduct && Array.isArray(window._editingProduct.attributes)
        && window._editingProduct.attributes.length > 0) {
      // 延迟 100ms，确保 batchPreloadAttrOptions 已完成
      setTimeout(() => {
        try {
          fillAttributeValues(window._editingProduct.attributes);
          console.log('[selectCategory] 已尝试回填旧属性到新类目:', window._editingProduct.attributes.length, '项');
        } catch (e) {
          console.warn('[selectCategory] 回填旧属性失败:', e);
        }
      }, 100);
    }
  }).catch(e => {
    console.warn('[selectCategory] 拉取新类目属性失败:', e);
  });
}

/** 拉取类目特征并渲染到表单 */
async function loadCategoryAttributes(descCatId, typeId, options = {}) {
  const { preserveSkuAttrs = false, forceRefresh = false } = options;

  // 保留已保存的 SKU 属性数据（重新打开编辑弹窗时）
  const savedSkuAttrs = preserveSkuAttrs && Array.isArray(window._skuAttrs)
    ? JSON.parse(JSON.stringify(window._skuAttrs))
    : null;

  // 类目切换时重置SKU属性；重新打开弹窗时保留
  if (!preserveSkuAttrs) {
    window._skuAttrs = [];
  }
  window._colorNameAttrMeta = null;

  const attrList = document.getElementById('attrList');

  // 缓存命中检查：同一 typeId 的类目属性结构已拉取过时，直接用缓存渲染，不重新请求
  // forceRefresh=true 时跳过缓存（用于用户手动切换类目时强制刷新）
  const cacheKey = String(typeId);
  if (!forceRefresh && _categoryAttrCache.has(cacheKey)) {
    const cachedAttrs = _categoryAttrCache.get(cacheKey);
    console.log('[类目属性缓存] 命中缓存，跳过API请求:', { typeId, cacheKey, attrCount: cachedAttrs?.length || 0 });
    await renderCategoryAttributes(cachedAttrs, { preserveSkuAttrs, savedSkuAttrs });
    return;
  }

  console.log('[类目属性缓存] 未命中，发起API请求:', { typeId, cacheKey, forceRefresh, cacheSize: _categoryAttrCache.size });
  if (attrList) attrList.innerHTML = '<div style="text-align:center;color:var(--text-tertiary);padding:16px 0;font-size:13px;">正在拉取特征...</div>';

  try {
    const res = await Api.getCategoryAttributes(descCatId, typeId);
    if (res.code === 200 && res.data) {
      // 存入缓存，下次打开同类目商品时直接复用
      _categoryAttrCache.set(cacheKey, res.data);
      console.log('[类目属性缓存] 已缓存:', { typeId, cacheKey, attrCount: res.data?.length || 0, cacheSize: _categoryAttrCache.size });
      await renderCategoryAttributes(res.data, { preserveSkuAttrs, savedSkuAttrs });
      Toast.show(res.msg || '特征加载成功', 'success');
    } else {
      if (attrList) attrList.innerHTML = `<div style="text-align:center;color:var(--text-tertiary);padding:16px 0;font-size:13px;">${res.msg || '加载失败'}</div>`;
    }
  } catch (e) {
    console.error('拉取类目特征失败:', e);
    if (attrList) attrList.innerHTML = '<div style="text-align:center;color:var(--text-tertiary);padding:16px 0;font-size:13px;">拉取失败，请重试</div>';
  }
}

/** 渲染类目特征表单（返回 Promise，等待字典值预加载完成） */
async function renderCategoryAttributes(attributes, options = {}) {
  const { preserveSkuAttrs = false, savedSkuAttrs = null } = options;
  const attrList = document.getElementById('attrList');
  if (!attrList) return;

  // 类目未匹配时不渲染 Ozon 类目属性，防止创建不存在的属性导致 SKU 表格异常
  if (!window._selectedCategory) {
    attrList.innerHTML = '<div style="text-align:center;color:var(--text-tertiary);padding:16px 0;font-size:13px;">请先选择商品类目，类目属性将自动加载</div>';
    console.warn('[renderCategoryAttributes] 类目未匹配，跳过属性渲染');
    return;
  }

  if (!attributes || attributes.length === 0) {
    attrList.innerHTML = '<div style="text-align:center;color:var(--text-tertiary);padding:16px 0;font-size:13px;">该类目暂无特征</div>';
    return;
  }

  // 保存属性元数据供校验和映射使用
  window._currentAttributes = attributes;

  // SKU属性识别：优先使用 Ozon Seller API 的 is_aspect 字段，回退到关键词匹配（兼容旧数据）
  // is_aspect=1 表示 SKU 级属性（每个 SKU 独立），is_aspect=0 表示 SPU 级属性（所有 SKU 共享）
  const SKU_KEYWORDS_FALLBACK = ['商品颜色', '颜色名称', '一个商品中的件数', '尺码', '尺寸', '俄罗斯尺码', '由制造商规定尺码'];
  const isSkuAttr = attr => {
    if (attr.is_aspect !== undefined && attr.is_aspect !== null) {
      return attr.is_aspect === true || attr.is_aspect === 1;
    }
    return SKU_KEYWORDS_FALLBACK.some(kw => attr.name && attr.name.includes(kw));
  };
  // 二级分类：销售属性（有字典，参与笛卡尔积）vs SKU信息（无字典，按SKU填写）
  const isSalesAttr = attr => isSkuAttr(attr) && (Number(attr.dictionary_id) > 0 || Number(attr.dictionaryId) > 0);
  const isSkuInfoAttr = attr => isSkuAttr(attr) && !isSalesAttr(attr);
  // 获取属性分类：'sales' / 'info' / null（非SKU属性）
  const getAttrCategory = attr => {
    if (!isSkuAttr(attr)) return null;
    return isSalesAttr(attr) ? 'sales' : 'info';
  };

  // 通用属性关键词（名称/描述/重量/长宽高/合并编号/增值税）
  // 这些属性已作为 item 顶层字段（name/description/weight/width/height/depth/offer_id/vat）提交
  // 类目拉取时直接过滤掉，不拉取、不绑定、不作为 attributes 提交，避免重复
  const COMMON_ATTR_EXACT_NAMES = new Set([
    '名称', 'название', 'название товара', '标题', 'name', 'title',
    '描述', 'описание', 'description',
    '合并编号', '增值税', 'ндс', 'vat',
  ]);
  // 型号名称排除：'Название' 会误匹配 'Название модели'（型号名称），
  // 但型号名称是独立类目属性（对应 mergeCode），不能被过滤掉。
  // 匹配到以下关键词的属性，跳过通用过滤。
  const isModelNameAttr = attr => {
    if (!attr.name) return false;
    if (String(attr.id) === '9048') return true;
    const nameLower = attr.name.toLowerCase().trim();
    return nameLower === 'название модели (для объединения в одну карточку)' ||
      nameLower === '型号名称（针对合并为一张商品卡片）' ||
      nameLower === 'model name (for merging into one card)';
  };
  // 颜色名称排除：'名称' 会误匹配 '颜色名称'，但颜色名称是 SKU 信息属性，
  // 需要作为颜色卡片的配套输入框渲染，不能被过滤掉。
  const COLOR_NAME_KEYWORDS = ['颜色名称', 'название цвета', 'color name'];
  const isColorNameAttr = attr => {
    if (!attr.name) return false;
    const nameLower = attr.name.toLowerCase();
    return COLOR_NAME_KEYWORDS.some(kw => nameLower.includes(kw.toLowerCase()));
  };
  const isCommonAttr = attr => {
    if (!attr.name) return false;
    // 型号名称属性不被过滤（即使包含 'Название'）
    if (isModelNameAttr(attr)) return false;
    // 颜色名称属性不被过滤（即使包含 '名称'）
    if (isColorNameAttr(attr)) return false;
    const nameLower = attr.name.toLowerCase().trim();
    return COMMON_ATTR_EXACT_NAMES.has(nameLower);
  };

  // JSON富内容（Rich-контент JSON）：作为通用属性放到基本信息区描述下方，
  // 不在类目属性列表中渲染。按 attrId=11254 或名称匹配（兼容不同类目）
  const RICH_CONTENT_ATTR_ID = 11254;
  const RICH_CONTENT_KEYWORDS = ['JSON富内容', 'Rich-контент', 'Rich content', 'Rich-content'];
  const isRichContentAttr = attr =>
    attr.id === RICH_CONTENT_ATTR_ID ||
    RICH_CONTENT_KEYWORDS.some(kw => attr.name && attr.name.toLowerCase().includes(kw.toLowerCase()));

  // 简介（Аннотация）：作为通用属性放到基本信息区JSON富内容下方，
  // 不在类目属性列表中渲染。按名称匹配（兼容不同类目）
  const ANNOTATION_KEYWORDS = ['简介', 'Аннотация', 'Annotation'];
  const isAnnotationAttr = attr =>
    attr.name && ANNOTATION_KEYWORDS.some(kw => attr.name.toLowerCase().includes(kw.toLowerCase()));

  // 分离：SKU属性 vs 动态属性（需拉取显示）
  // 通用属性直接过滤掉，不渲染、不绑定
  const skuAttrs = attributes.filter(isSkuAttr);
  const dynamicAttrs = attributes.filter(attr => !isSkuAttr(attr) && !isCommonAttr(attr) && !isRichContentAttr(attr) && !isModelNameAttr(attr) && !isAnnotationAttr(attr));
  // JSON富内容单独渲染到基本信息区
  const richContentAttr = attributes.find(isRichContentAttr);
  // 型号名称单独渲染到基本信息区（合并编号下方）
  const modelNameAttr = attributes.find(isModelNameAttr);
  // 简介单独渲染到基本信息区（JSON富内容下方）
  const annotationAttr = attributes.find(isAnnotationAttr);

  // 将Ozon类目SKU属性注入到 window._skuAttrs（保留已保存的值）
  const findSaved = (attr, namePattern) => savedSkuAttrs
    ? savedSkuAttrs.find(a =>
        (a.attrId && attr?.id && String(a.attrId) === String(attr.id)) ||
        (a.name && namePattern && namePattern.test(a.name)))
    : null;

  // 安全更新已存在的SKU属性值：仅当saved有非空值时才更新，避免清空已有数据
  const safeUpdateValues = (existing, saved) => {
    if (preserveSkuAttrs && saved && Array.isArray(saved.values) && saved.values.filter(v => v !== '').length > 0) {
      existing.values = saved.values;
      return true;
    }
    return false;
  };

  const unitAttr = skuAttrs.find(a => a.name && /一个商品中的件数|количество.*товар|items?.*product/i.test(a.name));
  const colorAttr = skuAttrs.find(a => String(a.id) === '10096' ||
    (a.name && /商品颜色|цвет товара|product color/i.test(a.name)));
  const colorNameAttr = skuAttrs.find(a => String(a.id) === '10097' ||
    (a.name && COLOR_NAME_KEYWORDS.some(kw => a.name.toLowerCase().includes(kw.toLowerCase()))));

  // 1688 原始颜色名（迁移前保存），供"颜色名称"自动填充使用
  // 注意：必须在外层作用域声明，因为"商品颜色"自动匹配会替换 colorSkuAttr.values
  let originalColorValues = [];

  console.log('[renderCategoryAttributes] SKU属性处理:', {
    'API返回SKU属性': skuAttrs.map(a => a.name),
    '已存在skuAttrs': window._skuAttrs.map(a => ({ name: a.name, valuesCount: a.values?.length || 0 })),
    'savedSkuAttrs': savedSkuAttrs?.map(a => ({ name: a.name, valuesCount: a.values?.length || 0 })) || null,
    'unitAttr存在': !!unitAttr,
    'colorAttr存在': !!colorAttr,
    'colorNameAttr存在': !!colorNameAttr,
  });

  if (unitAttr) {
    const existing = window._skuAttrs.find(a => String(a.attrId) === String(unitAttr.id) ||
      (a.name && /一个商品中的件数|количество.*товар|items?.*product/i.test(a.name)));
    const saved = findSaved(unitAttr, /一个商品中的件数|количество.*товар|items?.*product/i);
    if (!existing) {
      window._skuAttrs.push({
        name: unitAttr.name,
        values: (preserveSkuAttrs && saved?.values) ? saved.values : [],
        skuType: 'number',
        attrId: unitAttr.id,
        required: !!unitAttr.required,
        description: unitAttr.description || '',
        ozonType: unitAttr.ozon_type || '',
        attrCategory: 'info'
      });
    } else {
      // 补全缺失的元数据字段（attrId等）
      if (!existing.attrId) existing.attrId = unitAttr.id;
      if (!existing.description) existing.description = unitAttr.description || '';
      if (!existing.ozonType) existing.ozonType = unitAttr.ozon_type || '';
      if (existing.required === undefined) existing.required = !!unitAttr.required;
      if (!existing.attrCategory) existing.attrCategory = 'info';
      // 安全更新值：仅当saved有非空值时才更新
      safeUpdateValues(existing, saved);
    }
  }
  if (colorAttr) {
    const existing = window._skuAttrs.find(a => String(a.attrId) === String(colorAttr.id) ||
      (a.name && /商品颜色|цвет товара|product color/i.test(a.name)));
    const saved = findSaved(colorAttr, /商品颜色|цвет товара|product color/i);
    if (!existing) {
      // 智能匹配 1688 采集的颜色属性（无 attrId，名称为"颜色"/"color"/"цвет"等同义词）
      const aliColorAttr = window._skuAttrs.find(a =>
        a.skuType === 'color' && !a.attrId && a.name &&
        (a.name === '颜色' || a.name.includes('颜色') ||
         a.name.toLowerCase().includes('color') || a.name.toLowerCase().includes('цвет'))
      );

      let migratedValues = [];
      let migratedFromName = null;
      if (aliColorAttr && Array.isArray(aliColorAttr.values)) {
        migratedValues = aliColorAttr.values.filter(v => v !== '');
        migratedFromName = aliColorAttr.name;
        originalColorValues = [...migratedValues]; // 保存原始值
      }

      window._skuAttrs.push({
        name: colorAttr.name,
        values: migratedValues.length > 0 ? migratedValues : ((preserveSkuAttrs && saved?.values) ? saved.values : []),
        valueIds: [], // parallel array for dictionary_value_id
        skuType: 'color',
        attrId: colorAttr.id,
        dictionaryId: colorAttr.dictionary_id,
        required: !!colorAttr.required,
        description: colorAttr.description || '',
        isCollection: !!colorAttr.is_collection,
        attrCategory: 'sales'
      });

      // 迁移成功：移除 1688 旧颜色属性 + 同步更新 SKU combo 的 key（旧名称 → Ozon 属性名）
      if (migratedFromName && aliColorAttr) {
        const idx = window._skuAttrs.indexOf(aliColorAttr);
        if (idx >= 0) window._skuAttrs.splice(idx, 1);

        if (window._editingProduct?.skus && Array.isArray(window._editingProduct.skus)) {
          window._editingProduct.skus.forEach(sku => {
            if (sku.combo && sku.combo[migratedFromName] !== undefined) {
              sku.combo[colorAttr.name] = sku.combo[migratedFromName];
              delete sku.combo[migratedFromName];
            }
          });
        }

        console.log('[renderCategoryAttributes] 1688颜色属性已迁移到Ozon:', {
          旧属性名: migratedFromName,
          新属性名: colorAttr.name,
          迁移值数: migratedValues.length,
        });
      }
    } else {
      // 补全缺失的元数据字段
      if (!existing.attrId) existing.attrId = colorAttr.id;
      if (!existing.dictionaryId) existing.dictionaryId = colorAttr.dictionary_id;
      if (!existing.description) existing.description = colorAttr.description || '';
      if (existing.isCollection === undefined) existing.isCollection = !!colorAttr.is_collection;
      if (existing.required === undefined) existing.required = !!colorAttr.required;
      if (!existing.valueIds) existing.valueIds = [];
      if (!existing.attrCategory) existing.attrCategory = 'sales';
      safeUpdateValues(existing, saved);
      // 保存已有值中未经匹配的原始 1688 颜色名（不含"（"的值），
      // 已匹配的字典文本（如"蓝色（синий）"）不算原始名，避免污染"颜色名称"
      originalColorValues = (existing.values || [])
        .filter(v => v && !v.includes('（') && !v.includes('('));
    }

    // 异步：加载 Ozon 颜色字典值并自动匹配 1688 颜色名
    if (colorAttr.dictionary_id && originalColorValues.length > 0) {
      const colorSkuAttr = window._skuAttrs.find(a => String(a.attrId) === String(colorAttr.id) ||
        (a.name && /商品颜色|цвет товара|product color/i.test(a.name)));
      if (colorSkuAttr) {
        // 检查是否需要匹配（值不是"中文（俄语）"格式 = 未经匹配的原始 1688 值）
        const needsMatch = colorSkuAttr.values.some(v => v && !v.includes('（') && !v.includes('('));
        if (needsMatch) {
          const descCatId = window._selectedCategory?.description_category_id;
          const typeId = window._selectedCategory?.type_id;
          if (descCatId && typeId) {
            try {
              const dictValues = await loadColorDictionary(colorAttr.id, colorAttr.dictionary_id, descCatId, typeId);
              if (dictValues.length > 0) {
                const matched = colorSkuAttr.values.map(v => autoMatchColor(v, dictValues));
                // 同步更新 SKU combo 的颜色值（旧值 → 匹配后的字典值文本）
                const oldValues = [...colorSkuAttr.values];
                colorSkuAttr.values = matched.map(m => m.text);
                colorSkuAttr.valueIds = matched.map(m => m.value_id);
                // 同步更新 product.skus 中的 combo 颜色值
                if (window._editingProduct?.skus && Array.isArray(window._editingProduct.skus)) {
                  window._editingProduct.skus.forEach(sku => {
                    if (sku.combo && sku.combo[colorSkuAttr.name] !== undefined) {
                      const oldVal = sku.combo[colorSkuAttr.name];
                      const matchIdx = oldValues.indexOf(oldVal);
                      if (matchIdx >= 0) {
                        sku.combo[colorSkuAttr.name] = colorSkuAttr.values[matchIdx];
                      }
                    }
                  });
                }
                renderSkuAttrs();
                generateSkuTable();
                console.log('[颜色自动匹配] 完成:', matched.map(m => ({ text: m.text, id: m.value_id })));
              }
            } catch (e) {
              console.warn('[颜色自动匹配] 失败:', e);
            }
          }
        }
      }
    }
  }
  if (colorNameAttr) {
    const existing = window._skuAttrs.find(a => String(a.attrId) === String(colorNameAttr.id) ||
      (a.name && /颜色名称|название цвета|color name/i.test(a.name)));
    const saved = findSaved(colorNameAttr, /颜色名称|название цвета|color name/i);
    // 使用外层保存的 1688 原始颜色名（自动匹配前的值）填充"颜色名称"
    // 注意：此时"商品颜色"的 values 已被自动匹配替换为字典文本（如"蓝色（синий）"），
    // 不能再从 colorSkuAttr.values 读取，否则会丢失 1688 原始名（如"蓝色史迪仔"）
    const originalColorNames = originalColorValues;
    if (!existing) {
      // 优先使用已保存的值；否则用 1688 原始颜色名填充
      let nameValues = (preserveSkuAttrs && saved?.values) ? saved.values : [];
      if (nameValues.length === 0 && originalColorNames.length > 0) {
        // 用 1688 原始颜色名填充"颜色名称"（保留原始中文描述，不截取）
        nameValues = [...originalColorNames];
      }
      window._skuAttrs.push({
        name: colorNameAttr.name,
        values: nameValues,
        skuType: 'text',
        attrId: colorNameAttr.id,
        required: !!colorNameAttr.required,
        description: colorNameAttr.description || '',
        ozonType: colorNameAttr.ozon_type || '',
        attrCategory: 'info'
      });
    } else {
      // 补全缺失的元数据字段
      if (!existing.attrId) existing.attrId = colorNameAttr.id;
      if (!existing.description) existing.description = colorNameAttr.description || '';
      if (!existing.ozonType) existing.ozonType = colorNameAttr.ozon_type || '';
      if (existing.required === undefined) existing.required = !!colorNameAttr.required;
      if (!existing.attrCategory) existing.attrCategory = 'info';
      // 如果"颜色名称"为空但 1688 原始颜色名有值，自动填充
      if ((!existing.values || existing.values.every(v => !v)) && originalColorNames.length > 0) {
        existing.values = [...originalColorNames];
      }
      safeUpdateValues(existing, saved);
    }
  }

  // 同步"颜色名称"的 values 长度与"商品颜色"一致，避免渲染时 textAttrIdx 找到但 values 数组过短
  // 场景：商品颜色已有多个值（如从 1688 迁移），颜色名称刚被创建时 values 为空
  const colorAttrForSync = window._skuAttrs.find(a => a.skuType === 'color');
  const textAttrForSync = window._skuAttrs.find((a, i) => i !== window._skuAttrs.indexOf(colorAttrForSync) && a.skuType === 'text');
  if (colorAttrForSync && textAttrForSync && Array.isArray(colorAttrForSync.values)) {
    const colorLen = colorAttrForSync.values.length;
    if (!Array.isArray(textAttrForSync.values)) textAttrForSync.values = [];
    while (textAttrForSync.values.length < colorLen) {
      textAttrForSync.values.push('');
    }
  }

  // 通用处理：其他 is_aspect=1 的 SKU 属性（非 商品颜色/颜色名称/件数）
  // 这些属性不再通过硬编码关键词识别，而是基于 Ozon Seller API 的 is_aspect 字段自动识别
  // - 销售属性（有字典 dictionary_id>0）：参与笛卡尔积，skuType='select'，渲染为下拉选择卡片
  // - SKU信息（无字典 dictionary_id=0）：不参与笛卡尔积，skuType='info'，作为表格列按SKU填写
  const handledSkuAttrIds = new Set([unitAttr?.id, colorAttr?.id, colorNameAttr?.id].filter(Boolean).map(String));
  const isHandledSkuAttr = attr => handledSkuAttrIds.has(String(attr.id || ''));

  attributes.forEach(attr => {
    if (isHandledSkuAttr(attr)) return;        // 已由上方专门处理
    if (!isSkuAttr(attr)) return;              // 非 SKU 属性跳过
    if (isCommonAttr(attr)) return;            // 通用属性跳过（理论已被后端过滤，双保险）

    const category = getAttrCategory(attr);    // 'sales' or 'info'
    if (!category) return;

    const existing = window._skuAttrs.find(a => a.attrId === attr.id || (a.name && a.name === attr.name));
    const saved = savedSkuAttrs ? savedSkuAttrs.find(a => a.attrId === attr.id || (a.name && a.name === attr.name)) : null;

    if (!existing) {
      const newAttr = {
        name: attr.name,
        values: (preserveSkuAttrs && saved?.values) ? saved.values : [],
        skuType: category === 'sales' ? 'select' : 'info',
        attrId: attr.id,
        required: !!attr.required,
        description: attr.description || '',
        ozonType: attr.ozon_type || '',
        attrCategory: category,
      };
      if (category === 'sales') {
        newAttr.dictionaryId = attr.dictionary_id;
        newAttr.valueIds = [];
        newAttr.isCollection = !!attr.is_collection;
      }
      window._skuAttrs.push(newAttr);
      console.log(`[renderCategoryAttributes] 自动识别 SKU ${category === 'sales' ? '销售属性' : '信息属性'}: ${attr.name} (attrId=${attr.id}, dictionary_id=${attr.dictionary_id || 0})`);
    } else {
      // 补全元数据（保留已存在的 values 与 skuType 以兼容旧数据）
      if (!existing.attrId) existing.attrId = attr.id;
      if (!existing.attrCategory) existing.attrCategory = category;
      if (!existing.skuType) existing.skuType = category === 'sales' ? 'select' : 'info';
      if (!existing.description) existing.description = attr.description || '';
      if (!existing.ozonType) existing.ozonType = attr.ozon_type || '';
      if (existing.required === undefined) existing.required = !!attr.required;
      if (category === 'sales') {
        if (!existing.dictionaryId) existing.dictionaryId = attr.dictionary_id;
        if (!existing.valueIds) existing.valueIds = [];
        if (existing.isCollection === undefined) existing.isCollection = !!attr.is_collection;
      }
      safeUpdateValues(existing, saved);
    }
  });

  // 通用 SKU 属性迁移：将无 attrId 的 1688 属性迁移到同类型的 Ozon 属性（有 attrId）
  // 覆盖颜色之外的属性（件数/颜色名称等），避免类目切换后 combo key 不匹配
  migrateAliSkuAttrsToOzon();

  // 清理不属于新类目的 SKU 属性（类目切换后，旧类目的属性应当移除）
  // - 有 attrId 的 Ozon 属性：若 attrId 不在新类目 attributes 中，移除
  // - 无 attrId 的 1688 属性：迁移后仍保留的，说明新类目无对应属性，移除
  const newSkuAttrIds = new Set(skuAttrs.filter(a => a.id).map(a => a.id));
  const removedAttrNames = [];
  for (let i = window._skuAttrs.length - 1; i >= 0; i--) {
    const attr = window._skuAttrs[i];
    const belongsToNewCategory = attr.attrId ? newSkuAttrIds.has(attr.attrId) : false;
    if (!belongsToNewCategory) {
      removedAttrNames.push(attr.name);
      window._skuAttrs.splice(i, 1);
      console.log('[renderCategoryAttributes] 移除不属于新类目的SKU属性:', attr.name, `(attrId=${attr.attrId || '无'})`);
    }
  }
  // 同步清理 product.skus 中已移除属性的 combo key，保持数据一致
  // 避免 generateSkuTable 的 savedSkuMap 因 combo key 不匹配而回填失败
  if (removedAttrNames.length > 0 && window._editingProduct?.skus && Array.isArray(window._editingProduct.skus)) {
    window._editingProduct.skus.forEach(sku => {
      if (sku.combo) {
        removedAttrNames.forEach(name => {
          if (name && sku.combo[name] !== undefined) {
            delete sku.combo[name];
          }
        });
      }
    });
  }

  // 渲染SKU属性卡片 + 生成SKU表格
  renderSkuAttrs();
  generateSkuTable();

  // 渲染属性分组（动态属性展开）
  const renderAttrGroup = (groupName, attrs, collapsed) => {
    if (!attrs || attrs.length === 0) return '';
    let h = `<div class="attr-group" style="margin-bottom:12px;">
      <div class="attr-group-header" onclick="toggleAttrGroup(this)" style="display:flex;align-items:center;gap:6px;cursor:pointer;padding:6px 0;user-select:none;">
        <svg class="attr-group-arrow" style="width:12px;height:12px;transform:rotate(${collapsed ? -90 : 0}deg);transition:transform 0.2s;" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M6 9l6 6 6-6"/></svg>
        <span style="font-size:12px;color:var(--text-tertiary);font-weight:500;">${groupName}</span>
        <span style="font-size:11px;color:var(--text-tertiary);opacity:0.6;">(${attrs.length})</span>
      </div>
      <div class="attr-group-body" style="display:${collapsed ? 'none' : 'block'};">
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px 16px;">`;

    attrs.forEach(attr => {
      const requiredMark = attr.required ? '<span class="required">*</span>' : '';
      const label = attr.name;
      const descTip = attr.description ? `<span class="label-tooltip" title="${attr.description.replace(/"/g, '&quot;')}">?</span>` : '';
      const requiredClass = attr.required ? 'attr-required' : '';

      // 品牌（Бренд）等大字典属性：使用搜索输入框，不走全量下拉加载
      const isBrandAttr = attr.id === 85 || (attr.name && (attr.name.includes('品牌') || attr.name.includes('Бренд')));

      if (isBrandAttr && attr.dictionary_id && attr.dictionary_id > 0) {
        h += `<div class="attr-item ${requiredClass} brand-attr-item">
          <span class="brand-attr-label">${label} ${requiredMark} ${descTip}</span>
          <div class="brand-input-row">
            <input type="text" class="form-input attr-field attr-search-field" data-attr-id="${attr.id}" data-attr-name="${attr.name}" data-dictionary-id="${attr.dictionary_id}" data-desc-cat-id="${window._selectedCategory?.description_category_id}" data-type-id="${window._selectedCategory?.type_id}" data-required="${attr.required ? '1' : '0'}" data-value-id="" data-submit-value="Нет бренда" value="无品牌（Нет бренда）" placeholder="点击选择品牌..." onfocus="showBrandDropdown(this)" oninput="searchAttrValues(this)" autocomplete="off">
          </div>
          <div class="attr-search-dropdown brand-dropdown"></div>
        </div>`;
      } else if (attr.type === 'select' || (attr.dictionary_id && attr.dictionary_id > 0)) {
        if (attr.is_collection) {
          // 多选字典属性：显示已选标签 + "选择"按钮，点击弹窗选择
          h += `<div class="attr-item ${requiredClass}" style="display:flex;flex-direction:column;align-items:flex-start;">
            <span style="font-size:12px;color:var(--text-secondary);text-align:left;width:100%;">${label} ${requiredMark} <span style="font-size:10px;color:var(--text-tertiary);">（可多选）</span> ${descTip}</span>
            <div class="form-input attr-field multi-select-display" data-attr-id="${attr.id}" data-attr-name="${attr.name}" data-dictionary-id="${attr.dictionary_id}" data-desc-cat-id="${window._selectedCategory?.description_category_id}" data-type-id="${window._selectedCategory?.type_id}" data-required="${attr.required ? '1' : '0'}" data-is-collection="1" data-value-ids="" onclick="openMultiSelectModal(${attr.id})" style="width:100%;margin-top:4px;padding:6px 10px;border-radius:6px;border:1px solid var(--border-color);background:var(--bg-card);color:var(--text-primary);font-size:13px;min-height:34px;cursor:pointer;display:flex;flex-wrap:wrap;gap:4px;align-items:center;" onmouseenter="this.style.borderColor='var(--color-primary)'" onmouseleave="this.style.borderColor='var(--border-color)'">
              <span class="multi-select-placeholder" style="color:var(--text-tertiary);font-size:12px;">点击选择...</span>
            </div>
          </div>`;
        } else {
          h += `<div class="attr-item ${requiredClass}" style="display:flex;flex-direction:column;align-items:flex-start;">
            <span style="font-size:12px;color:var(--text-secondary);text-align:left;width:100%;">${label} ${requiredMark} ${descTip}</span>
            <select class="form-input attr-field" data-attr-id="${attr.id}" data-attr-name="${attr.name}" data-dictionary-id="${attr.dictionary_id}" data-desc-cat-id="${window._selectedCategory?.description_category_id}" data-type-id="${window._selectedCategory?.type_id}" data-required="${attr.required ? '1' : '0'}" onclick="loadAttrOptions(this)" style="width:100%;margin-top:4px;padding:6px 10px;border-radius:6px;border:1px solid var(--border-color);background:var(--bg-primary);color:var(--text-primary);font-size:13px;">
              <option value="">加载中...</option>
            </select>
          </div>`;
        }
      } else if (attr.type === 'boolean') {
        // Boolean 类型：无 dictionary_id，渲染 Yes/No 下拉
        h += `<div class="attr-item ${requiredClass}" style="display:flex;flex-direction:column;align-items:flex-start;">
          <span style="font-size:12px;color:var(--text-secondary);text-align:left;width:100%;">${label} ${requiredMark} ${descTip}</span>
          <select class="form-input attr-field" data-attr-id="${attr.id}" data-attr-name="${attr.name}" data-attr-type="boolean" data-required="${attr.required ? '1' : '0'}" style="width:100%;margin-top:4px;padding:6px 10px;border-radius:6px;border:1px solid var(--border-color);background:var(--bg-primary);color:var(--text-primary);font-size:13px;">
            <option value="">请选择</option>
            <option value="true">是 (Да)</option>
            <option value="false">否 (Нет)</option>
          </select>
        </div>`;
      } else if (attr.type === 'number') {
        h += `<div class="attr-item ${requiredClass}" style="display:flex;flex-direction:column;align-items:flex-start;">
          <span style="font-size:12px;color:var(--text-secondary);text-align:left;width:100%;">${label} ${requiredMark} ${descTip}</span>
          <input type="number" class="form-input attr-field" data-attr-id="${attr.id}" data-attr-name="${attr.name}" data-required="${attr.required ? '1' : '0'}" placeholder="${attr.ozon_type || ''}" style="width:100%;margin-top:4px;" oninput="validateAttrField(this)">
        </div>`;
      } else if (attr.type === 'textarea') {
        h += `<div class="attr-item ${requiredClass}" style="grid-column:span 2;display:flex;flex-direction:column;align-items:flex-start;">
          <span style="font-size:12px;color:var(--text-secondary);text-align:left;width:100%;">${label} ${requiredMark} ${descTip}</span>
          <textarea class="form-input attr-field" data-attr-id="${attr.id}" data-attr-name="${attr.name}" data-required="${attr.required ? '1' : '0'}" placeholder="${attr.ozon_type || ''}" rows="2" style="width:100%;margin-top:4px;resize:vertical;" oninput="validateAttrField(this)"></textarea>
        </div>`;
      } else if (attr.type === 'url') {
        h += `<div class="attr-item ${requiredClass}" style="display:flex;flex-direction:column;align-items:flex-start;">
          <span style="font-size:12px;color:var(--text-secondary);text-align:left;width:100%;">${label} ${requiredMark} ${descTip}</span>
          <input type="url" class="form-input attr-field" data-attr-id="${attr.id}" data-attr-name="${attr.name}" data-required="${attr.required ? '1' : '0'}" placeholder="https://" style="width:100%;margin-top:4px;" oninput="validateAttrField(this)">
        </div>`;
      } else {
        h += `<div class="attr-item ${requiredClass}" style="display:flex;flex-direction:column;align-items:flex-start;">
          <span style="font-size:12px;color:var(--text-secondary);text-align:left;width:100%;">${label} ${requiredMark} ${descTip}</span>
          <input type="text" class="form-input attr-field" data-attr-id="${attr.id}" data-attr-name="${attr.name}" data-required="${attr.required ? '1' : '0'}" placeholder="${attr.ozon_type || ''}" style="width:100%;margin-top:4px;" oninput="validateAttrField(this)">
        </div>`;
      }
    });

    h += '</div></div></div>';
    return h;
  };

  // 动态属性（类目特有）展开显示，通用属性已过滤不渲染
  let html = '';
  if (dynamicAttrs.length > 0) {
    const dynGroups = {};
    dynamicAttrs.forEach(attr => {
      const g = attr.group_name || '类目特有属性';
      if (!dynGroups[g]) dynGroups[g] = [];
      dynGroups[g].push(attr);
    });
    const dynGroupNames = Object.keys(dynGroups);
    dynGroupNames.forEach((groupName, gi) => {
      html += renderAttrGroup(groupName, dynGroups[groupName], gi > 0);
    });
  }
  // 无任何动态属性时显示提示
  if (!html) {
    html = '<div style="text-align:center;color:var(--text-tertiary);padding:16px 0;font-size:13px;">该类目暂无动态特征</div>';
  }

  attrList.innerHTML = html;

  // JSON富内容渲染到基本信息区（描述下方），作为通用属性独立展示
  renderRichContentAttr(richContentAttr);
  // 型号名称渲染到基本信息区（合并编号下方），作为通用属性独立展示
  renderModelAttr(modelNameAttr);
  // 简介渲染到基本信息区（JSON富内容下方），作为通用属性独立展示
  renderAnnotationAttr(annotationAttr);

  // 批量预加载所有 select 的下拉选项（await 确保加载完成）
  await batchPreloadAttrOptions();

  // 智能映射：本地字段 ↔ Ozon属性字段
  setupSmartFieldBindings(attrList);
  const skuAttrListEl = document.getElementById('skuAttrList');
  if (skuAttrListEl) setupSmartFieldBindings(skuAttrListEl);
}

/**
 * 渲染JSON富内容（Rich-контент JSON）字段到基本信息区描述下方
 *
 * 该属性作为通用属性独立展示，不放在类目属性列表中。
 * 使用 textarea 便于编辑多行 JSON 内容。字段保留 attr-item / attr-field 类名
 * 和 data-attr-id 等数据属性，确保 collectCategoryAttributes 和 fillAttributeValues
 * 能正常收集和回填。
 *
 * 永久固定：无论当前类目是否包含 11254 属性，该字段始终渲染。
 * 类目无此属性时使用默认元数据（id=11254, required=false），确保用户始终可编辑。
 *
 * @param {Object|null} attr - Ozon 类目属性对象（含 id/name/description/required），无则用默认值
 */
/**
 * 渲染JSON富内容字段（Rich-контент JSON）
 *
 * 采用"创建/更新分离"模式：
 *   - 首次调用时创建完整 DOM（含 textarea、预览按钮、预览区）
 *   - 后续调用只更新元数据（data-*、label、tooltip），不动 textarea，用户输入永不丢失
 *
 * @param {Object|null} attr - Ozon 类目属性对象（含 id/name/description/required）
 */
function renderRichContentAttr(attr) {
  const container = document.getElementById('richContentAttr');
  if (!container) return;

  const field = container.querySelector('.attr-field');
  if (!field) {
    buildRichContentField(container, attr);
  } else {
    updateRichContentMeta(container, attr);
  }
}

const RICH_CONTENT_DEFAULT = {
  id: 11254,
  name: 'JSON富内容（Rich-контент JSON）',
  description: '使用JSON格式的模板添加带有照片和视频的扩展产品描述。 有关填写此特征的详细信息，请参阅知识库中的文章"丰富内容"。',
  required: false,
};

// 注入富内容悬停工具栏样式（仅注入一次）
if (!document.getElementById('rich-hover-toolbar-style')) {
  const style = document.createElement('style');
  style.id = 'rich-hover-toolbar-style';
  style.textContent = `
    .rich-workspace { width:100%; border:1px solid var(--border-color,#dfe5ec); background:var(--bg-primary,#fff); border-radius:6px; overflow:hidden; }
    .rich-workspace-head { min-height:52px; display:flex; align-items:center; justify-content:space-between; gap:12px; padding:10px 12px; border-bottom:1px solid var(--border-color,#e5e9ef); background:var(--bg-secondary,#f8fafc); }
    .rich-workspace-title { min-width:0; display:flex; align-items:center; gap:8px; font-size:13px; font-weight:600; color:var(--text-primary,#17202a); }
    .rich-status { flex:0 0 auto; display:inline-flex; align-items:center; min-height:22px; padding:2px 8px; border-radius:999px; font-size:11px; font-weight:500; background:#eef2f6; color:#5f6f7f; }
    .rich-status.is-valid { background:#e9f7ef; color:#16794b; }
    .rich-status.is-error { background:#fff0ed; color:#b93824; }
    .rich-toolbar { display:flex; align-items:center; justify-content:space-between; flex-wrap:wrap; gap:8px; padding:10px 12px; border-bottom:1px solid var(--border-color,#e5e9ef); }
    .rich-toolbar-group { display:flex; align-items:center; gap:6px; }
    .rich-toolbar button { min-height:30px; font-size:12px; padding:5px 10px; border:1px solid var(--border-color,#cbd5e1); border-radius:4px; cursor:pointer; background:var(--bg-primary,#fff); color:var(--text-secondary,#475569); white-space:nowrap; }
    .rich-toolbar button:hover { background:var(--bg-secondary,#f4f7fb); border-color:#94a3b8; }
    .rich-toolbar .rich-primary { color:#fff; background:#2563eb; border-color:#2563eb; font-weight:500; }
    .rich-toolbar .rich-primary:hover { background:#1d4ed8; border-color:#1d4ed8; }
    .rich-segmented { display:inline-flex; padding:2px; border:1px solid var(--border-color,#d7dee7); border-radius:5px; background:var(--bg-secondary,#f4f6f8); }
    .rich-segmented button { min-height:26px; padding:3px 10px; border:0; background:transparent; }
    .rich-segmented button.is-active { background:var(--bg-primary,#fff); color:var(--text-primary,#17202a); box-shadow:0 1px 2px rgba(15,23,42,.12); }
    .rich-meta { display:flex; align-items:center; gap:14px; min-height:34px; padding:7px 12px; border-bottom:1px solid var(--border-color,#e5e9ef); font-size:11px; color:var(--text-tertiary,#778493); }
    .rich-inline-preview { width:100%; min-height:300px; max-height:580px; overflow:auto; background:#fff; padding:18px; }
    .rich-inline-preview img { display:block; max-width:100%; object-fit:cover; }
    .rich-preview-empty, .rich-preview-error { min-height:260px; display:flex; flex-direction:column; gap:12px; align-items:center; justify-content:center; color:#8491a0; font-size:13px; text-align:center; }
    .rich-preview-empty button { min-height:32px; padding:6px 12px; border:1px solid #2563eb; border-radius:4px; background:#fff; color:#2563eb; cursor:pointer; }
    .rich-preview-error { color:#c2410c; }
    .rc-widget { width:100%; margin:0 0 20px; }
    .rc-text-block { padding:16px 20px; }
    .rc-title { margin:0 0 8px; font-size:22px; line-height:1.3; font-weight:700; color:#001a34; }
    .rc-body { margin:0; font-size:15px; line-height:1.55; color:#3d5165; white-space:normal; }
    .rc-roll img { width:100%; height:auto; }
    .rc-billboard img { width:100%; height:auto; }
    .rc-billboard-copy { padding:14px 4px 0; }
    .rc-chess-row { display:flex; align-items:center; gap:24px; margin-bottom:18px; }
    .rc-chess-row.reverse { flex-direction:row-reverse; }
    .rc-chess-media, .rc-chess-copy { flex:1 1 0; min-width:0; }
    .rc-chess-media img { width:100%; aspect-ratio:1; }
    .rc-tiles { display:grid; gap:16px; }
    .rc-tiles.cols-2 { grid-template-columns:repeat(2,minmax(0,1fr)); }
    .rc-tiles.cols-3 { grid-template-columns:repeat(3,minmax(0,1fr)); }
    .rc-tiles.cols-4 { grid-template-columns:repeat(4,minmax(0,1fr)); }
    .rc-tile img { width:100%; aspect-ratio:1; }
    .rc-tile-copy { padding-top:10px; }
    .rc-list { margin:0; padding-left:24px; color:#3d5165; }
    .rc-list li { margin-bottom:8px; }
    .rc-table { width:100%; border-collapse:collapse; font-size:13px; }
    .rc-table th, .rc-table td { border:1px solid #dfe5ec; padding:8px; text-align:left; }
    .rich-code-pane { display:none; background:#111827; }
    .rich-code-pane.is-visible { display:block; }
    .rich-code-actions { display:flex; justify-content:flex-end; gap:6px; padding:8px 10px; border-bottom:1px solid #273244; }
    .rich-code-actions button { min-height:28px; padding:4px 9px; border:1px solid #3b475a; border-radius:4px; background:#1f2937; color:#d7deea; font-size:11px; cursor:pointer; }
    .rich-code-editor { display:block; width:100%; min-height:320px; margin:0; padding:14px; border:0!important; border-radius:0!important; outline:none; background:#111827!important; color:#dbe7f5!important; font-family:Consolas,'Courier New',monospace; font-size:12px; line-height:1.6; resize:vertical; }
    @media (max-width:760px) {
      .rich-workspace-head { align-items:flex-start; }
      .rich-toolbar { align-items:stretch; }
      .rich-toolbar-group { width:100%; justify-content:space-between; overflow-x:auto; }
      .rich-segmented { flex:0 0 auto; }
      .rich-inline-preview { min-height:240px; padding:12px; }
      .rc-chess-row, .rc-chess-row.reverse { flex-direction:column; align-items:stretch; }
      .rc-tiles.cols-3, .rc-tiles.cols-4 { grid-template-columns:repeat(2,minmax(0,1fr)); }
    }
  `;
  document.head.appendChild(style);
}

function buildRichContentField(container, attr) {
  const finalAttr = (attr && attr.id) ? attr : RICH_CONTENT_DEFAULT;

  // 初始值优先级：
  // 1. attr.value（类目属性中的值）
  // 2. product.attributes 中 id=11254 的属性值
  // 3. product.richContent（采集到的 Rich Content JSON 对象/字符串）
  // 注意：不再使用 product.description（纯文本描述，非 Rich Content JSON）
  let defaultVal = '';
  if (attr && attr.value) {
    defaultVal = typeof attr.value === 'string' ? attr.value : JSON.stringify(attr.value);
  } else if (window._editingProduct) {
    const richAttr = (window._editingProduct.attributes || []).find(a => {
      const id = a && (a.id ?? a.attrId ?? a.attribute_id);
      const name = String((a && a.name) || '').toLowerCase();
      return String(id || '') === '11254'
        || name.includes('json富内容')
        || name.includes('rich-контент')
        || name.includes('rich content')
        || name.includes('rich-content');
    });
    if (richAttr && richAttr.value) {
      defaultVal = typeof richAttr.value === 'string' ? richAttr.value : JSON.stringify(richAttr.value);
    } else if (window._editingProduct.richContent) {
      defaultVal = typeof window._editingProduct.richContent === 'string'
        ? window._editingProduct.richContent
        : JSON.stringify(window._editingProduct.richContent);
    }
  }
  if (defaultVal === '[object Object]') defaultVal = '';

  const requiredMark = finalAttr.required ? '<span class="required">*</span>' : '';
  const descTip = finalAttr.description ? `<span class="label-tooltip" title="${finalAttr.description.replace(/"/g, '&quot;')}">?</span>` : '';
  const requiredClass = finalAttr.required ? 'attr-required' : '';

  container.innerHTML = `
    <div class="attr-item ${requiredClass}" style="display:flex;flex-direction:column;align-items:flex-start;position:relative;">
      <div class="rich-workspace">
        <div class="rich-workspace-head">
          <div class="rich-workspace-title"><span>${escapeHtml(finalAttr.name)}</span>${requiredMark}${descTip}</div>
          <span id="richPreviewStatus" class="rich-status">空内容</span>
        </div>
        <div class="rich-toolbar">
          <div class="rich-toolbar-group">
            <button type="button" class="rich-primary" onclick="openRichEditorModal()">可视化编辑</button>
            <div class="rich-segmented" role="tablist" aria-label="富内容视图">
              <button type="button" class="is-active" data-rich-view="preview" onclick="selectRichView('preview')">预览</button>
              <button type="button" data-rich-view="code" onclick="selectRichView('code')">JSON</button>
            </div>
          </div>
          <div class="rich-toolbar-group">
            <button type="button" onclick="previewRichJson(this)" title="全屏预览">全屏</button>
            <button type="button" onclick="clearRichContent(this)" title="清空富内容">清空</button>
          </div>
        </div>
        <div id="richContentMeta" class="rich-meta"><span>0 个组件</span><span>0 张图片</span><span>版本 -</span></div>
        <div id="richInlinePreview" class="rich-inline-preview"></div>
        <div id="richCodePane" class="rich-code-pane">
          <div class="rich-code-actions">
            <button type="button" onclick="formatRichCode()">格式化</button>
            <button type="button" onclick="copyRichCode(this)">复制</button>
          </div>
          <textarea class="form-input attr-field rich-code-editor" data-attr-id="${finalAttr.id}" data-attr-name="${escapeAttr(finalAttr.name)}" data-required="${finalAttr.required ? '1' : '0'}" rows="12" placeholder="粘贴 JSON 富内容模板..." spellcheck="false" oninput="validateAttrField(this);renderRichInlinePreview();">${escapeHtml(defaultVal)}</textarea>
        </div>
      </div>
    </div>`;
  renderRichInlinePreview();
}

function updateRichContentMeta(container, attr) {
  const finalAttr = (attr && attr.id) ? attr : RICH_CONTENT_DEFAULT;
  const wrapper = container.querySelector('.attr-item');
  if (!wrapper) return buildRichContentField(container, attr);

  const field = wrapper.querySelector('.attr-field');
  if (!field) return;

  // 更新 data-*（不动 textarea 的值）
  field.dataset.attrId = String(finalAttr.id);
  field.dataset.attrName = finalAttr.name;
  field.dataset.required = finalAttr.required ? '1' : '0';

  // 更新 label 文本
  const labelSpan = wrapper.querySelector('.rich-workspace-title > span:first-child');
  if (labelSpan) {
    labelSpan.textContent = finalAttr.name;
  }

  // 更新 required 样式
  if (finalAttr.required) wrapper.classList.add('attr-required');
  else wrapper.classList.remove('attr-required');
}

function _richItemsHtml(format) {
  if (!format) return '';
  const items = Array.isArray(format.items) ? format.items : [];
  if (!items.length && Array.isArray(format.content)) return format.content.map(_escapeHtml).join('<br>');
  return items.map(item => {
    if (!item) return '';
    if (item.type === 'br') return '<br>';
    const value = _escapeHtml(String(item.content || '')).replace(/\n/g, '<br>');
    if (item.type === 'link' && item.href) {
      return '<a href="' + _escapeHtml(String(item.href)) + '" target="_blank" rel="noopener">' + value + '</a>';
    }
    return value;
  }).join('');
}

function _richCopyHtml(block, className = '') {
  if (!block) return '';
  const title = block.title ? '<h3 class="rc-title" style="text-align:' + (block.title.align || 'left') + '">' + _richItemsHtml(block.title) + '</h3>' : '';
  const body = block.text ? '<p class="rc-body" style="text-align:' + (block.text.align || 'left') + '">' + _richItemsHtml(block.text) + '</p>' : '';
  return (title || body) ? '<div class="' + className + '">' + title + body + '</div>' : '';
}

function _richImageHtml(block, className = '') {
  const img = block?.img || {};
  const src = img.src || img.srcMobile || '';
  if (!src) return '';
  return '<div class="' + className + '"><img src="' + escapeAttr(src) + '" alt="' + escapeAttr(img.alt || '') + '" loading="lazy"></div>';
}

function _renderRichWidgetHtml(widget) {
  if (!widget || !widget.widgetName) return '';
  if (widget.widgetName === 'raTextBlock') {
    return '<section class="rc-widget rc-text-block">' + _richCopyHtml(widget) + '</section>';
  }
  if (widget.widgetName === 'raShowcase') {
    const blocks = Array.isArray(widget.blocks) ? widget.blocks : [];
    if (widget.type === 'roll') {
      return '<section class="rc-widget rc-roll">' + blocks.map(block => _richImageHtml(block)).join('') + '</section>';
    }
    if (widget.type === 'billboard') {
      return '<section class="rc-widget rc-billboard">' + blocks.map(block =>
        _richImageHtml(block) + _richCopyHtml(block, 'rc-billboard-copy')
      ).join('') + '</section>';
    }
    if (widget.type === 'chess') {
      return '<section class="rc-widget rc-chess">' + blocks.map(block =>
        '<div class="rc-chess-row' + (block.reverse ? ' reverse' : '') + '">' +
          _richImageHtml(block, 'rc-chess-media') + _richCopyHtml(block, 'rc-chess-copy') +
        '</div>'
      ).join('') + '</section>';
    }
    const columns = widget.type === 'tileXL' ? 2 : (widget.type === 'tileL' ? 3 : 4);
    return '<section class="rc-widget rc-tiles cols-' + columns + '">' + blocks.map(block =>
      '<div class="rc-tile">' + _richImageHtml(block) + _richCopyHtml(block, 'rc-tile-copy') + '</div>'
    ).join('') + '</section>';
  }
  if (widget.widgetName === 'list') {
    const tag = widget.theme === 'number' ? 'ol' : 'ul';
    return '<section class="rc-widget"><' + tag + ' class="rc-list">' + (widget.blocks || []).map(block =>
      '<li>' + _richCopyHtml(block) + '</li>'
    ).join('') + '</' + tag + '></section>';
  }
  if (widget.widgetName === 'raTable' && widget.table) {
    const header = (widget.table.header || []).map(cell => '<th>' + _escapeHtml(String(cell)) + '</th>').join('');
    const rows = (widget.table.body || []).map(row => '<tr>' + row.map(cell => '<td>' + _escapeHtml(String(cell)) + '</td>').join('') + '</tr>').join('');
    return '<section class="rc-widget">' + _richCopyHtml(widget) + '<table class="rc-table">' + (header ? '<thead><tr>' + header + '</tr></thead>' : '') + '<tbody>' + rows + '</tbody></table></section>';
  }
  if (widget.widgetName === 'raVideo') {
    return '<section class="rc-widget rich-preview-empty">视频内容</section>';
  }
  return '';
}

function _renderRichContentHtml(obj) {
  const content = obj && Array.isArray(obj.content) ? obj.content : [];
  return content.map(_renderRichWidgetHtml).join('');
}

function renderRichInlinePreview() {
  const ta = document.querySelector('#richContentAttr textarea.attr-field');
  const preview = document.getElementById('richInlinePreview');
  if (!ta || !preview) return;
  const raw = ta.value.trim();
  const status = document.getElementById('richPreviewStatus');
  const meta = document.getElementById('richContentMeta');
  if (!raw) {
    preview.innerHTML = '<div class="rich-preview-empty"><span>暂无富内容</span><button type="button" onclick="openRichEditorModal()">创建富内容</button></div>';
    if (status) { status.textContent = '空内容'; status.className = 'rich-status'; }
    if (meta) meta.innerHTML = '<span>0 个组件</span><span>0 张图片</span><span>版本 -</span>';
    return;
  }
  try {
    const obj = JSON.parse(raw);
    if (!obj || !Array.isArray(obj.content)) throw new Error('缺少 content 数组');
    const html = _renderRichContentHtml(obj);
    preview.innerHTML = html || '<div class="rich-preview-empty">暂无可预览内容</div>';
    const imageCount = preview.querySelectorAll('img').length;
    if (status) { status.textContent = '有效'; status.className = 'rich-status is-valid'; }
    if (meta) meta.innerHTML = '<span>' + obj.content.length + ' 个组件</span><span>' + imageCount + ' 张图片</span><span>版本 ' + _escapeHtml(obj.version || '-') + '</span>';
  } catch (e) {
    preview.innerHTML = '<div class="rich-preview-error">JSON 格式错误：' + _escapeHtml(e.message) + '</div>';
    if (status) { status.textContent = '格式错误'; status.className = 'rich-status is-error'; }
    if (meta) meta.innerHTML = '<span>无法读取内容统计</span>';
  }
}

function selectRichView(view) {
  const preview = document.getElementById('richInlinePreview');
  const pane = document.getElementById('richCodePane');
  if (!preview || !pane) return;
  const codeMode = view === 'code';
  preview.style.display = codeMode ? 'none' : 'block';
  pane.classList.toggle('is-visible', codeMode);
  document.querySelectorAll('[data-rich-view]').forEach(button => {
    button.classList.toggle('is-active', button.dataset.richView === view);
  });
  if (codeMode) pane.querySelector('textarea')?.focus();
}

function toggleRichCode() {
  const pane = document.getElementById('richCodePane');
  selectRichView(pane?.classList.contains('is-visible') ? 'preview' : 'code');
}

function formatRichCode() {
  const ta = document.querySelector('#richContentAttr textarea.attr-field');
  if (!ta || !ta.value.trim()) return;
  try {
    ta.value = JSON.stringify(JSON.parse(ta.value), null, 2);
    renderRichInlinePreview();
    validateAttrField(ta);
  } catch (_) {
    renderRichInlinePreview();
  }
}

async function copyRichCode(btn) {
  const ta = document.querySelector('#richContentAttr textarea.attr-field');
  if (!ta || !ta.value) return;
  try {
    await navigator.clipboard.writeText(ta.value);
    const old = btn.textContent;
    btn.textContent = '已复制';
    setTimeout(() => { btn.textContent = old; }, 1200);
  } catch (_) {
    ta.select();
    document.execCommand('copy');
  }
}

/**
 * 清空 JSON 富内容 textarea
 */
function clearRichContent(btn) {
  const ta = document.querySelector('#richContentAttr .attr-field');
  if (!ta) return;
  if (ta.value && !confirm('确定要清空 JSON 富内容吗？此操作不可撤销。')) return;
  ta.value = '';
  selectRichView('preview');
  renderRichInlinePreview();

  validateAttrField(ta);
}

/* ============================================================
 * JSON 富内容预览与编辑器
 * ============================================================ */

/**
 * 预览 JSON 富内容（弹出预览窗口）
 */
function previewRichJson(btn) {
  const ta = document.querySelector('#richContentAttr .attr-field');
  if (!ta) return;
  const raw = ta.value.trim();
  if (!raw) { alert('请先输入 JSON 富内容'); return; }

  let obj;
  try {
    obj = JSON.parse(raw);
  } catch (e) {
    alert('JSON 格式错误：' + e.message);
    return;
  }

  // 格式化写回
  ta.value = JSON.stringify(obj, null, 2);
  validateAttrField(ta);

  // 创建预览弹窗
  _openRichPreviewModal(obj);
}

/**
 * 打开富内容预览弹窗
 */
function _openRichPreviewModal(obj) {
  // 移除已有弹窗
  const existing = document.getElementById('richPreviewHost');
  if (existing) existing.remove();

  const host = document.createElement('div');
  host.id = 'richPreviewHost';
  host.style.cssText = 'position:fixed;top:0;left:0;right:0;bottom:0;z-index:10000;display:flex;align-items:center;justify-content:center;padding:20px;background:rgba(0,26,52,0.5);animation:richPreviewFadeIn 0.2s ease;';
  document.body.appendChild(host);

  const shadow = host.attachShadow({mode:'open'});

  // 样式
  const style = document.createElement('style');
  style.textContent = `
    :host { font-family: GTEestiPro, arial, sans-serif; box-sizing: border-box; }
    @keyframes richPreviewFadeIn { from { opacity: 0; } to { opacity: 1; } }
    @keyframes richPreviewSlideUp { from { transform: translateY(20px); opacity: 0; } to { transform: translateY(0); opacity: 1; } }
    .preview-box { background:#fff; border-radius:8px; box-shadow:0 4px 20px rgba(0,0,0,0.15); width:100%; max-width:900px; max-height:85vh; display:flex; flex-direction:column; overflow:hidden; animation: richPreviewSlideUp 0.25s ease; }
    .preview-header { display:flex; align-items:center; justify-content:space-between; padding:12px 20px; border-bottom:1px solid #e2e7ec; }
    .preview-header h3 { margin:0; font-size:16px; color:#001a34; }
    .preview-close { width:28px; height:28px; border:none; background:transparent; cursor:pointer; color:#707f8d; font-size:18px; border-radius:4px; display:flex; align-items:center; justify-content:center; }
    .preview-close:hover { background:#eff3f6; color:#f91155; }
    .preview-body { flex:1; overflow-y:auto; padding:20px; }
    .preview-empty { text-align:center; color:#9ca3af; padding:40px 0; font-size:14px; }
    .rc-widget { width:100%; margin:0 0 20px; } .rc-widget img { display:block; max-width:100%; object-fit:cover; }
    .rc-text-block { padding:16px 20px; } .rc-title { margin:0 0 8px;font-size:22px;line-height:1.3;color:#001a34; }
    .rc-body { margin:0;font-size:15px;line-height:1.55;color:#3d5165; } .rc-roll img,.rc-billboard img { width:100%;height:auto; }
    .rc-billboard-copy,.rc-tile-copy { padding-top:12px; } .rc-chess-row { display:flex;align-items:center;gap:24px;margin-bottom:18px; }
    .rc-chess-row.reverse { flex-direction:row-reverse; } .rc-chess-media,.rc-chess-copy { flex:1 1 0;min-width:0; }
    .rc-chess-media img,.rc-tile img { width:100%;aspect-ratio:1; } .rc-tiles { display:grid;gap:16px; }
    .rc-tiles.cols-2 { grid-template-columns:repeat(2,minmax(0,1fr)); } .rc-tiles.cols-3 { grid-template-columns:repeat(3,minmax(0,1fr)); }
    .rc-tiles.cols-4 { grid-template-columns:repeat(4,minmax(0,1fr)); } .rc-list { padding-left:24px;color:#3d5165; }
    .rc-table { width:100%;border-collapse:collapse; } .rc-table th,.rc-table td { border:1px solid #dfe5ec;padding:8px;text-align:left; }
  `;
  shadow.appendChild(style);

  // DOM
  const box = document.createElement('div');
  box.className = 'preview-box';

  const content = obj && Array.isArray(obj.content) ? obj.content : [];
  const version = obj && obj.version ? obj.version : '';

  box.innerHTML = `
    <div class="preview-header">
      <h3>JSON 富内容预览${version ? ' (v' + version + ')' : ''} — ${content.length} 个 widget</h3>
      <button class="preview-close" title="关闭">×</button>
    </div>
    <div class="preview-body">
      ${content.length === 0 ? '<div class="preview-empty">暂无 widget 内容</div>' : _renderRichContentHtml(obj)}
    </div>
  `;
  shadow.appendChild(box);

  // 关闭事件
  const close = box.querySelector('.preview-close');
  close.addEventListener('click', () => host.remove());
  host.addEventListener('click', (e) => { if (e.target === host) host.remove(); });
  document.addEventListener('keydown', function esc(e) {
    if (e.key === 'Escape' && document.getElementById('richPreviewHost')) {
      host.remove();
      document.removeEventListener('keydown', esc);
    }
  });
}

function _escapeHtml(s) {
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

/**
 * 打开富内容可视化编辑器弹窗
 *
 * 完整复刻 Ozon 官方 Rich Content 编辑器：
 * - iframe 加载后端 /api/rich_content/editor 页面（含 main.css + m=el_main_css + main.js）
 * - 使用 Ozon 官方 DOM 结构（RA-a8）和 Vue 应用（main.js）提供完整交互
 * - 通过 postMessage 实现 JSON 桥接（iframe ↔ 父页面 textarea）
 *
 * 资源均通过本地后端 http://localhost:5000 提供，不依赖外部 CDN，符合项目硬约束。
 */
async function openRichEditorModal() {
  try {
    // ===== 1. 定位当前 textarea（保存目标） =====
    const textarea = document.querySelector('#richContentAttr textarea.attr-field');
    if (!textarea) {
      alert('未找到 JSON 富内容字段，无法打开编辑器');
      return;
    }

    // ===== 2. 清理旧弹窗 =====
    const oldHost = document.getElementById('richEditorHost');
    if (oldHost) oldHost.remove();

    // ===== 3. 创建弹窗容器（普通 DOM，非 Shadow DOM —— iframe 自带隔离） =====
    const host = document.createElement('div');
    host.id = 'richEditorHost';
    host.style.cssText = 'position:fixed;inset:0;z-index:99999;background:rgba(0,0,0,0.55);display:flex;flex-direction:column;align-items:center;justify-content:center;font-family:Inter,system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;';
    document.body.appendChild(host);

    // ===== 4. 顶部工具栏 =====
    const toolbar = document.createElement('div');
    toolbar.style.cssText = 'width:min(96vw,1400px);background:#fff;border-radius:8px 8px 0 0;padding:8px 16px;display:flex;align-items:center;justify-content:space-between;box-shadow:0 -2px 8px rgba(0,0,0,0.05);flex-shrink:0;';
    toolbar.innerHTML = `
      <div style="display:flex;align-items:center;gap:12px;">
        <strong style="font-size:15px;color:#0f172a;">Rich-контент 可视化编辑器</strong>
        <span style="font-size:12px;color:#64748b;" id="richEditorStatus">加载中...</span>
      </div>
      <div style="display:flex;gap:6px;">
        <button data-act="load" style="padding:7px 14px;background:#fff;color:#0f172a;border:1px solid #e2e8f0;border-radius:8px;font-size:13px;cursor:pointer;">从字段加载 JSON</button>
        <button data-act="save" style="padding:7px 14px;background:#00a046;color:#fff;border:none;border-radius:8px;font-size:13px;cursor:pointer;font-weight:500;">保存到字段</button>
        <button data-act="copy" style="padding:7px 14px;background:#fff;color:#0f172a;border:1px solid #e2e8f0;border-radius:8px;font-size:13px;cursor:pointer;">复制 JSON</button>
        <button data-act="paste" style="padding:7px 14px;background:#fff;color:#0f172a;border:1px solid #e2e8f0;border-radius:8px;font-size:13px;cursor:pointer;">粘贴 JSON</button>
        <button data-act="close" style="padding:7px 14px;background:#fff;color:#475569;border:1px solid #e2e8f0;border-radius:8px;font-size:13px;cursor:pointer;">关闭</button>
      </div>
    `;
    host.appendChild(toolbar);

    // ===== 5. iframe 加载完整 Ozon 编辑器页面 =====
    const iframeWrap = document.createElement('div');
    iframeWrap.style.cssText = 'width:min(96vw,1400px);height:min(94vh,860px);background:#fff;border-radius:0 0 8px 8px;overflow:hidden;flex:1;box-shadow:0 20px 60px rgba(0,0,0,0.3);';
    const iframe = document.createElement('iframe');
    iframe.src = 'http://localhost:5000/api/rich_content/editor';
    iframe.style.cssText = 'width:100%;height:100%;border:none;display:block;';
    iframe.allow = 'clipboard-read; clipboard-write';
    iframe.setAttribute('referrerpolicy', 'no-referrer');
    iframeWrap.appendChild(iframe);
    host.appendChild(iframeWrap);

    // ===== 6. 状态管理 =====
    let editorReady = false;
    const statusEl = toolbar.querySelector('#richEditorStatus');

    // 监听 iframe 消息
    const messageHandler = (e) => {
      const msg = e.data || {};
      if (typeof msg !== 'object' || !msg.type) return;
      console.log('[RichEditor 父页面] 收到消息:', msg.type, msg);
      if (msg.type === 'EDITOR_READY') {
        editorReady = true;
        if (msg.warning) {
          statusEl.textContent = '已就绪（WELCOME 页）';
          statusEl.style.color = '#f59e0b';
          console.warn('[RichEditor 父页面] 警告:', msg.warning);
        } else {
          statusEl.textContent = '已就绪';
          statusEl.style.color = '#10ad44';
        }
        // 自动加载现有 JSON
        const existingJson = (textarea.value || '').trim();
        if (existingJson) {
          console.log('[RichEditor 父页面] 自动加载现有 JSON，长度:', existingJson.length);
          iframe.contentWindow.postMessage({ type: 'LOAD_JSON', json: existingJson }, '*');
        }
      } else if (msg.type === 'JSON_RESULT') {
        if (msg.json) {
          // 保存到 textarea
          textarea.value = msg.json;
          textarea.dispatchEvent(new Event('input', { bubbles: true }));
          if (typeof validateAttrField === 'function') validateAttrField(textarea);
          statusEl.textContent = '已保存到字段';
          statusEl.style.color = '#10ad44';
          setTimeout(() => { statusEl.textContent = '已就绪'; }, 1500);
          // 同时复制到剪贴板（方便用户）
          try { navigator.clipboard.writeText(msg.json); } catch (e) {}
        } else {
          const errMsg = msg.error || '未知错误';
          statusEl.textContent = '获取失败: ' + errMsg;
          statusEl.style.color = '#dc2626';
          setTimeout(() => { statusEl.textContent = '已就绪'; statusEl.style.color = '#10ad44'; }, 3000);
        }
      } else if (msg.type === 'LOAD_RESULT') {
        if (msg.success) {
          statusEl.textContent = '已加载到编辑器 (' + (msg.count || 0) + ' widgets)';
          statusEl.style.color = '#10ad44';
          console.log('[RichEditor 父页面] LOAD_JSON 成功，widget 数:', msg.count);
        } else {
          statusEl.textContent = '加载失败: ' + (msg.error || '未知错误');
          statusEl.style.color = '#dc2626';
          console.error('[RichEditor 父页面] LOAD_JSON 失败:', msg.error);
        }
        setTimeout(() => { statusEl.textContent = '已就绪'; statusEl.style.color = '#10ad44'; }, 2000);
      } else if (msg.type === 'PONG') {
        editorReady = true;
      }
    };
    window.addEventListener('message', messageHandler);

    // ===== 7. 工具栏按钮事件 =====
    toolbar.addEventListener('click', async (e) => {
      const btn = e.target.closest('button[data-act]');
      if (!btn) return;
      const act = btn.dataset.act;

      if (act === 'close') {
        window.removeEventListener('message', messageHandler);
        host.remove();
        return;
      }

      if (!editorReady) {
        alert('编辑器尚未就绪，请稍候...');
        return;
      }

      if (act === 'save') {
        // 向 iframe 请求 JSON
        const requestId = Date.now().toString();
        iframe.contentWindow.postMessage({ type: 'GET_JSON', requestId }, '*');
        statusEl.textContent = '获取中...';
        statusEl.style.color = '#64748b';
      } else if (act === 'load') {
        const json = (textarea.value || '').trim();
        if (!json) { alert('当前字段无 JSON 内容'); return; }
        iframe.contentWindow.postMessage({ type: 'LOAD_JSON', json }, '*');
        statusEl.textContent = '已加载到编辑器';
        statusEl.style.color = '#10ad44';
        setTimeout(() => { statusEl.textContent = '已就绪'; }, 1500);
      } else if (act === 'copy') {
        // 向 iframe 请求 JSON 并复制到剪贴板
        const requestId = Date.now().toString();
        iframe.contentWindow.postMessage({ type: 'GET_JSON', requestId }, '*');
        statusEl.textContent = '获取中...';
        statusEl.style.color = '#64748b';
      } else if (act === 'paste') {
        try {
          const text = await navigator.clipboard.readText();
          if (text) {
            // 验证是否为有效 JSON
            try { JSON.parse(text); } catch (e) {
              alert('剪贴板内容不是有效 JSON');
              return;
            }
            textarea.value = text;
            textarea.dispatchEvent(new Event('input', { bubbles: true }));
            if (typeof validateAttrField === 'function') validateAttrField(textarea);
            // 同时加载到编辑器
            iframe.contentWindow.postMessage({ type: 'LOAD_JSON', json: text }, '*');
            statusEl.textContent = '已粘贴';
            statusEl.style.color = '#10ad44';
            setTimeout(() => { statusEl.textContent = '已就绪'; }, 1500);
          }
        } catch (err) {
          alert('剪贴板读取失败：' + err.message + '\n请手动粘贴到字段中');
        }
      }
    });

    // ===== 8. 点击遮罩关闭 =====
    host.addEventListener('click', (e) => {
      if (e.target === host) {
        window.removeEventListener('message', messageHandler);
        host.remove();
      }
    });

    // ===== 9. ESC 关闭 =====
    const escHandler = (e) => {
      if (e.key === 'Escape') {
        window.removeEventListener('message', messageHandler);
        document.removeEventListener('keydown', escHandler);
        host.remove();
      }
    };
    document.addEventListener('keydown', escHandler);

    // ===== 10. 超时检测（15s 未就绪提示） =====
    setTimeout(() => {
      if (!editorReady) {
        statusEl.textContent = '加载超时（仍可使用）';
        statusEl.style.color = '#dc2626';
        console.warn('[RichEditor 父页面] 编辑器 15s 未发送 ready 信号，可能 main.js 加载失败');
      }
    }, 15000);

    console.log('[RichEditor 父页面] 弹窗已打开，iframe 加载中...');
  } catch (err) {
    console.error('[RichEditor] 打开失败:', err);
    alert('编辑器打开失败：' + err.message);
    const h = document.getElementById('richEditorHost');
    if (h) h.remove();
  }
}


/**
 * 渲染型号名称（Название модели）字段到基本信息区合并编号下方
 *
 * 该属性作为通用属性独立展示，不放在类目属性列表中。
 * 字段保留 attr-item / attr-field 类名和 data-attr-id 等数据属性，
 * 确保 collectCategoryAttributes 和 fillAttributeValues 能正常收集和回填。
 *
 * 永久固定：无论当前类目是否包含型号名称属性，该字段始终渲染。
 * 类目无此属性时使用默认元数据，确保用户始终可编辑。
 *
 * @param {Object|null} attr - Ozon 类目属性对象（含 id/name/description/required），无则用默认值
 */
function renderModelAttr(attr) {
  const container = document.getElementById('modelAttr');
  if (!container) return;

  const field = container.querySelector('.attr-field');
  if (!field) {
    buildModelNameField(container, attr);
  } else {
    updateModelNameMeta(container, attr);
  }
}

const MODEL_ATTR_DEFAULT = {
  id: '',
  name: '型号名称（针对合并为一张商品卡片）（Название модели）',
  description: '在该字段中填写要合并的产品的任何相同值。并以不同的方式，如果货物需要分开。如果产品具有相同的类型和品牌，并且在组合中的所有产品上不同地填充至少一个可变特征，则将发生组合。',
  required: true,
};

function generateMergeCode() {
  const now = new Date();
  const pad = n => String(n).padStart(2, '0');
  const ts = `${String(now.getFullYear()).slice(2)}${pad(now.getMonth() + 1)}${pad(now.getDate())}${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  const rand = String(Math.floor(Math.random() * 1000000)).padStart(6, '0');
  return `mz-${ts}-${rand}`;
}

function buildModelNameField(container, attr) {
  const finalAttr = (attr && attr.id) ? attr : MODEL_ATTR_DEFAULT;

  const savedVal = (attr && attr.value) ? attr.value : '';
  let defaultVal = savedVal || (window._editingProduct?.mergeCode || '');
  if (!defaultVal) defaultVal = generateMergeCode();

  const requiredMark = finalAttr.required ? '<span class="required">*</span>' : '';
  const descTip = finalAttr.description ? `<span class="label-tooltip" title="${finalAttr.description.replace(/"/g, '&quot;')}">?</span>` : '';
  const requiredClass = finalAttr.required ? 'attr-required' : '';

  container.innerHTML = `
    <div class="attr-item ${requiredClass}" style="display:flex;flex-direction:column;align-items:flex-start;">
      <span style="font-size:12px;color:var(--text-secondary);text-align:left;width:100%;">${escapeHtml(finalAttr.name)} ${requiredMark} ${descTip}</span>
      <input type="text" class="form-input attr-field" data-attr-id="${finalAttr.id}" data-attr-name="${escapeAttr(finalAttr.name)}" data-required="${finalAttr.required ? '1' : '0'}" placeholder="String" style="width:100%;margin-top:4px;" oninput="validateAttrField(this)" value="${escapeAttr(defaultVal)}">
    </div>`;
}

function updateModelNameMeta(container, attr) {
  const finalAttr = (attr && attr.id) ? attr : MODEL_ATTR_DEFAULT;
  const wrapper = container.querySelector('.attr-item');
  if (!wrapper) return buildModelNameField(container, attr);

  const field = wrapper.querySelector('.attr-field');
  if (!field) return;

  // 若当前值为空且需要自动生成（首次构建时生成了但后续被清空），重新生成
  if (!field.value) field.value = generateMergeCode();

  field.dataset.attrId = String(finalAttr.id);
  field.dataset.attrName = finalAttr.name;
  field.dataset.required = finalAttr.required ? '1' : '0';

  const labelSpan = wrapper.querySelector('span');
  if (labelSpan) {
    const requiredMark = finalAttr.required ? '<span class="required">*</span>' : '';
    const descTip = finalAttr.description ? '<span class="label-tooltip" title="' + finalAttr.description.replace(/"/g, '&quot;') + '">?</span>' : '';
    labelSpan.innerHTML = escapeHtml(finalAttr.name) + ' ' + requiredMark + ' ' + descTip;
  }

  if (finalAttr.required) wrapper.classList.add('attr-required');
  else wrapper.classList.remove('attr-required');
}

/**
 * 渲染简介（Аннотация）字段到基本信息区JSON富内容下方
 *
 * 该属性作为通用属性独立展示，不放在类目属性列表中。
 * 字段保留 attr-item / attr-field 类名和 data-attr-id 等数据属性，
 * 确保 collectCategoryAttributes 和 fillAttributeValues 能正常收集和回填。
 *
 * 永久固定：无论当前类目是否包含简介属性，该字段始终渲染。
 * 类目无此属性时使用默认元数据，确保用户始终可编辑。
 *
 * @param {Object|null} attr - Ozon 类目属性对象（含 id/name/description/required），无则用默认值
 */
function renderAnnotationAttr(attr) {
  const container = document.getElementById('annotationAttr');
  if (!container) return;

  const field = container.querySelector('.attr-field');
  if (!field) {
    buildAnnotationField(container, attr);
  } else {
    updateAnnotationMeta(container, attr);
  }
}

const ANNOTATION_DEFAULT = {
  id: '',
  name: '简介（Аннотация）',
  description: '商品描述、营销文本',
  required: false,
};

function buildAnnotationField(container, attr) {
  const finalAttr = (attr && attr.id) ? attr : ANNOTATION_DEFAULT;

  const savedVal = (attr && attr.value) ? attr.value : '';
  let defaultVal = savedVal || (window._editingProduct?.description || '');

  const requiredMark = finalAttr.required ? '<span class="required">*</span>' : '';
  const descTip = finalAttr.description ? `<span class="label-tooltip" title="${finalAttr.description.replace(/"/g, '&quot;')}">?</span>` : '';
  const requiredClass = finalAttr.required ? 'attr-required' : '';

  container.innerHTML = `
    <div class="attr-item ${requiredClass}" style="display:flex;flex-direction:column;align-items:flex-start;">
      <span style="font-size:12px;color:var(--text-secondary);text-align:left;width:100%;">${escapeHtml(finalAttr.name)} ${requiredMark} ${descTip}</span>
      <textarea class="form-input attr-field" data-attr-id="${finalAttr.id}" data-attr-name="${escapeAttr(finalAttr.name)}" data-required="${finalAttr.required ? '1' : '0'}" placeholder="请输入商品描述..." rows="6" style="width:100%;margin-top:4px;resize:vertical;font-family:inherit;" oninput="validateAttrField(this)">${escapeHtml(defaultVal)}</textarea>
    </div>`;
}

function updateAnnotationMeta(container, attr) {
  const finalAttr = (attr && attr.id) ? attr : ANNOTATION_DEFAULT;
  const wrapper = container.querySelector('.attr-item');
  if (!wrapper) return buildAnnotationField(container, attr);

  const field = wrapper.querySelector('.attr-field');
  if (!field) return;

  field.dataset.attrId = String(finalAttr.id);
  field.dataset.attrName = finalAttr.name;
  field.dataset.required = finalAttr.required ? '1' : '0';

  const labelSpan = wrapper.querySelector('span');
  if (labelSpan) {
    const requiredMark = finalAttr.required ? '<span class="required">*</span>' : '';
    const descTip = finalAttr.description ? '<span class="label-tooltip" title="' + finalAttr.description.replace(/"/g, '&quot;') + '">?</span>' : '';
    labelSpan.innerHTML = escapeHtml(finalAttr.name) + ' ' + requiredMark + ' ' + descTip;
  }

  if (finalAttr.required) wrapper.classList.add('attr-required');
  else wrapper.classList.remove('attr-required');
}

/** 折叠/展开属性分组 */
function toggleAttrGroup(headerEl) {
  const body = headerEl.nextElementSibling;
  const arrow = headerEl.querySelector('.attr-group-arrow');
  if (body.style.display === 'none') {
    body.style.display = 'block';
    arrow.style.transform = 'rotate(0deg)';
  } else {
    body.style.display = 'none';
    arrow.style.transform = 'rotate(-90deg)';
  }
}

/** 前端字典值内存缓存 */
const _attrValuesCache = {};

/** 批量预加载所有 select 的下拉选项 */
async function batchPreloadAttrOptions() {
  const selects = document.querySelectorAll('#attrList select[data-attr-id], #skuAttrList select[data-attr-id]');
  if (selects.length === 0) return;

  const descCatId = window._selectedCategory?.description_category_id;
  const typeId = window._selectedCategory?.type_id;
  if (!descCatId || !typeId) return;

  // 收集需要加载的 attribute_id
  const attrIds = [];
  selects.forEach(sel => {
    if (sel.dataset.loaded === '1') return;
    const attrId = parseInt(sel.dataset.attrId);
    const dictId = parseInt(sel.dataset.dictionaryId);
    if (attrId && dictId) attrIds.push(attrId);
  });

  if (attrIds.length === 0) return;

  console.log('[batchPreloadAttrOptions] 开始批量加载', attrIds.length, '个属性', { descCatId, typeId, attrIds });

  // 第一次请求：maxRetries=0，不等待同步，先用已有数据填充
  // 避免单个属性未同步阻塞所有属性的下拉选项
  try {
    const res = await Api.batchGetAttributeValues(descCatId, typeId, attrIds, 'ZH_HANS', 0);
    console.log('[batchPreloadAttrOptions] 批量响应:', { code: res.code, syncing: res.syncing, msg: res.msg, dataKeys: res.data ? Object.keys(res.data) : null });

    if (res.code === 200 && res.data) {
      const pendingSelects = [];
      // 填充各 select
      selects.forEach(sel => {
        const attrId = sel.dataset.attrId;
        const values = res.data[attrId];
        if (values && values.length > 0) {
          sel.innerHTML = '<option value="">请选择</option>' + values.map(v =>
            `<option value="${v.value_id}">${v.value}</option>`
          ).join('');
          sel.dataset.loaded = '1';
          // 写入内存缓存
          _attrValuesCache[`${descCatId}_${typeId}_${attrId}`] = values;
        } else if (res.syncing) {
          // 该属性正在同步，保持"加载中..."状态，稍后单独重试
          pendingSelects.push(sel);
        } else {
          sel.innerHTML = '<option value="">无选项</option>';
          sel.dataset.loaded = '1';
        }
      });

      console.log('[batchPreloadAttrOptions] 填充完成，待同步属性', pendingSelects.length, '个');

      // 对正在同步的属性，逐个异步加载（不阻塞主流程）
      // 使用 maxRetries=2（约4秒），避免长时间阻塞
      if (pendingSelects.length > 0) {
        pendingSelects.forEach(sel => {
          loadAttrOptions(sel, 2).catch(() => {});
        });
      }
    } else {
      console.warn('[batchPreloadAttrOptions] 批量响应异常，回退逐个加载', res);
      selects.forEach(sel => loadAttrOptions(sel));
    }
  } catch (e) {
    console.warn('[batchPreloadAttrOptions] 批量预加载异常，回退逐个加载:', e);
    // 回退：逐个加载
    selects.forEach(sel => loadAttrOptions(sel));
  }
}

/** 单个属性字典值加载（带内存缓存） */
async function loadAttrOptions(selectEl, maxRetries = 15) {
  if (selectEl.dataset.loaded === '1') return;

  const dictionaryId = parseInt(selectEl.dataset.dictionaryId);
  const descCatId = parseInt(selectEl.dataset.descCatId);
  const typeId = parseInt(selectEl.dataset.typeId);
  const attrId = parseInt(selectEl.dataset.attrId);

  if (!dictionaryId || !descCatId || !typeId) return;

  // 检查内存缓存
  const cacheKey = `${descCatId}_${typeId}_${attrId}`;
  if (_attrValuesCache[cacheKey]) {
    const values = _attrValuesCache[cacheKey];
    selectEl.innerHTML = '<option value="">请选择</option>' + values.map(v =>
      `<option value="${v.value_id}">${v.value}</option>`
    ).join('');
    selectEl.dataset.loaded = '1';
    _applySavedValueId(selectEl);
    return;
  }

  selectEl.innerHTML = '<option value="">加载中...</option>';

  try {
    const res = await Api.getAttributeValues(descCatId, typeId, attrId, 'ZH_HANS', maxRetries);
    if (res.code === 200 && res.data && res.data.length > 0) {
      const values = res.data;
      selectEl.innerHTML = '<option value="">请选择</option>' + values.map(v =>
        `<option value="${v.value_id}">${v.value}</option>`
      ).join('');
      selectEl.dataset.loaded = '1';
      _attrValuesCache[cacheKey] = values;
      _applySavedValueId(selectEl);
    } else if (res.syncing) {
      // 同步失败或仍在同步（可能 API Key 无效导致同步失败）
      selectEl.innerHTML = '<option value="">同步失败，点击重试</option>';
      selectEl.dataset.loaded = '0';  // 允许点击重试
    } else {
      selectEl.innerHTML = '<option value="">无选项</option>';
      selectEl.dataset.loaded = '1';
      // 即使无选项，也保留 savedValueId，便于 collectCategoryAttributes 兜底
    }
  } catch (e) {
    selectEl.innerHTML = '<option value="">加载失败，点击重试</option>';
    selectEl.dataset.loaded = '0';
  }
}

/**
 * 应用 savedValueId 到 select.value
 * 用于 fillAttributeValues 暂存的值在 loadAttrOptions 完成后自动选中
 */
function _applySavedValueId(selectEl) {
  const savedId = selectEl.dataset.savedValueId;
  if (!savedId) return;
  // 检查 option 中是否存在该 value
  const exists = Array.from(selectEl.options).some(opt => opt.value === savedId);
  if (exists) {
    selectEl.value = savedId;
    delete selectEl.dataset.savedValueId;
  }
  // 若 option 中不存在（如字典值已下架），保留 savedValueId 供 collect 兜底
}

// ===== 多选字典属性弹窗选择 =====

/** 打开多选弹窗 */
async function openMultiSelectModal(attrId) {
  const displayEl = document.querySelector(`.multi-select-display[data-attr-id="${attrId}"]`);
  if (!displayEl) return;

  const dictionaryId = parseInt(displayEl.dataset.dictionaryId);
  const descCatId = parseInt(displayEl.dataset.descCatId);
  const typeId = parseInt(displayEl.dataset.typeId);
  const attrName = displayEl.dataset.attrName || '';
  const currentIds = (displayEl.dataset.valueIds || '').split(',').filter(v => v).map(Number);

  if (!dictionaryId || !descCatId || !typeId) {
    Toast.show('属性参数缺失，无法加载选项', 'error');
    return;
  }

  // 先展示加载中弹窗
  Modal.show({
    title: `选择 - ${attrName}`,
    size: 'sm',
    body: `<div style="text-align:center;padding:40px 0;color:var(--text-tertiary);font-size:13px;">加载中...</div>`,
    footer: [
      { text: '取消', class: 'btn-ghost', onClick: () => Modal.close() },
    ],
  });

  // 加载字典值（优先内存缓存）
  const cacheKey = `${descCatId}_${typeId}_${attrId}`;
  let values = _attrValuesCache[cacheKey];
  if (!values) {
    try {
      const res = await Api.getAttributeValues(descCatId, typeId, attrId, 'ZH_HANS', 15);
      if (res.code === 200 && res.data && res.data.length > 0) {
        values = res.data;
        _attrValuesCache[cacheKey] = values;
      } else if (res.syncing) {
        Modal.close();
        Toast.show('字典值同步中，请稍后重试', 'warning');
        return;
      } else {
        Modal.close();
        Toast.show('该属性暂无可选值', 'warning');
        return;
      }
    } catch (e) {
      Modal.close();
      Toast.show('加载选项失败: ' + (e.message || ''), 'error');
      return;
    }
  }

  // 关闭加载中弹窗，再展示正式内容（避免两个弹窗堆叠）
  Modal.close();

  // 重新渲染弹窗内容
  Modal.show({
    title: `选择 - ${attrName}`,
    size: 'sm',
    body: `
      <div style="margin-bottom:12px;">
        <div style="position:relative;">
          <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#9ca3af" stroke-width="1.5"
            style="position:absolute;left:10px;top:50%;transform:translateY(-50%);pointer-events:none;">
            <circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/>
          </svg>
          <input type="text" id="multiSelectSearch" class="form-input" placeholder="搜索..." value=""
            oninput="filterMultiSelectList(this.value)" style="padding-left:32px;">
        </div>
      </div>
      <div style="margin-bottom:8px;padding-bottom:8px;border-bottom:1px solid var(--border-color);">
        <label style="display:flex;align-items:center;gap:6px;font-size:13px;cursor:pointer;">
          <input type="checkbox" id="multiSelectAll" style="accent-color:var(--color-primary);width:15px;height:15px;" onchange="toggleMultiSelectAll(this.checked)">
          <span>全选</span>
          <span id="multiSelectCount" style="margin-left:auto;color:var(--text-tertiary);font-size:12px;">已选 ${currentIds.length} 项</span>
        </label>
      </div>
      <div id="multiSelectList" style="max-height:360px;overflow-y:auto;padding-right:4px;">
        ${renderMultiSelectList(values, currentIds)}
      </div>
    `,
    footer: [
      { text: '取消', class: 'btn-ghost', onClick: () => Modal.close() },
      { text: '确定', class: 'btn-primary', id: 'btnMultiSelectConfirm', onClick: () => confirmMultiSelect(attrId) },
    ],
    onOpen: () => {
      const input = document.getElementById('multiSelectSearch');
      if (input) {
        setTimeout(() => input.focus(), 100);
        input.addEventListener('keydown', (e) => { if (e.key === 'Enter') e.preventDefault(); });
      }
      // 同步全选框状态
      syncMultiSelectAllState();
    },
  });
}

/** 渲染多选复选框列表 */
function renderMultiSelectList(values, selectedIds) {
  if (!values || values.length === 0) {
    return '<div style="text-align:center;color:var(--text-tertiary);padding:24px 0;font-size:13px;">无选项</div>';
  }
  return values.map(v => {
    const vid = v.value_id;
    const isChecked = selectedIds.includes(vid);
    const label = v.value || v.value_zh || '';
    return `
      <label class="multi-check-item" data-vid="${vid}" data-label="${label.replace(/"/g, '&quot;')}"
        style="display:flex;align-items:center;gap:6px;padding:5px 4px;font-size:13px;cursor:pointer;border-radius:3px;"
        onmouseenter="this.style.background='var(--bg-secondary)'" onmouseleave="this.style.background=''">
        <input type="checkbox" class="multi-check-box" value="${vid}" ${isChecked ? 'checked' : ''}
          style="accent-color:var(--color-primary);width:15px;height:15px;margin:0;flex-shrink:0;"
          onchange="onMultiSelectCheckChange()">
        <span style="white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${label}</span>
      </label>
    `;
  }).join('');
}

/** 过滤多选列表 */
function filterMultiSelectList(keyword) {
  const kw = (keyword || '').toLowerCase().trim();
  document.querySelectorAll('.multi-check-item').forEach(item => {
    const label = (item.dataset.label || '').toLowerCase();
    item.style.display = (!kw || label.includes(kw)) ? '' : 'none';
  });
  syncMultiSelectAllState();
}

/** 全选/取消全选（仅对当前可见项） */
function toggleMultiSelectAll(checked) {
  document.querySelectorAll('.multi-check-item').forEach(item => {
    if (item.style.display !== 'none') {
      const cb = item.querySelector('.multi-check-box');
      if (cb) cb.checked = checked;
    }
  });
  updateMultiSelectCount();
}

/** 单个 checkbox 变化时同步全选框和计数 */
function onMultiSelectCheckChange() {
  syncMultiSelectAllState();
  updateMultiSelectCount();
}

/** 同步全选框状态 */
function syncMultiSelectAllState() {
  const visibleItems = Array.from(document.querySelectorAll('.multi-check-item')).filter(i => i.style.display !== 'none');
  const visibleCbs = visibleItems.map(i => i.querySelector('.multi-check-box')).filter(Boolean);
  const allCb = document.getElementById('multiSelectAll');
  if (allCb && visibleCbs.length > 0) {
    allCb.checked = visibleCbs.every(cb => cb.checked);
  }
}

/** 更新已选计数 */
function updateMultiSelectCount() {
  const checked = document.querySelectorAll('.multi-check-box:checked');
  const countEl = document.getElementById('multiSelectCount');
  if (countEl) countEl.textContent = `已选 ${checked.length} 项`;
}

/** 确认多选选择 */
function confirmMultiSelect(attrId) {
  const checked = document.querySelectorAll('.multi-check-box:checked');
  const displayEl = document.querySelector(`.multi-select-display[data-attr-id="${attrId}"]`);
  if (!displayEl) { Modal.close(); return; }

  // 收集选中的 value_id 和对应文本
  const selectedIds = [];
  const selectedLabels = [];
  checked.forEach(cb => {
    const vid = parseInt(cb.value);
    if (vid > 0) {
      selectedIds.push(vid);
      const item = cb.closest('.multi-check-item');
      if (item) selectedLabels.push(item.dataset.label || '');
    }
  });

  // 更新显示区
  displayEl.dataset.valueIds = selectedIds.join(',');

  // 渲染标签
  if (selectedLabels.length > 0) {
    displayEl.innerHTML = selectedLabels.map(label =>
      `<span style="display:inline-flex;align-items:center;padding:2px 8px;background:rgba(99,102,241,0.1);color:var(--color-primary);border-radius:4px;font-size:12px;gap:4px;">${label}</span>`
    ).join('');
  } else {
    displayEl.innerHTML = '<span class="multi-select-placeholder" style="color:var(--text-tertiary);font-size:12px;">点击选择...</span>';
  }

  // 必填校验
  if (displayEl.dataset.required === '1') {
    if (selectedIds.length === 0) {
      displayEl.style.borderColor = '#ef4444';
      displayEl.style.boxShadow = '0 0 0 1px #ef4444';
    } else {
      displayEl.style.borderColor = '';
      displayEl.style.boxShadow = '';
    }
  }

  Modal.close();
}

/** 必填属性实时校验 */
function validateAttrField(el) {
  const isRequired = el.dataset.required === '1';
  if (!isRequired) return;

  const isEmpty = !el.value.trim();
  if (isEmpty) {
    el.style.borderColor = '#ef4444';
    el.style.boxShadow = '0 0 0 1px #ef4444';
  } else {
    el.style.borderColor = '';
    el.style.boxShadow = '';
  }
}

/** 校验所有必填属性是否已填写 */
function validateAllRequiredAttrs() {
  let valid = true;
  const requiredFields = document.querySelectorAll('#attrList .attr-field[data-required="1"], #skuAttrList .attr-field[data-required="1"], #richContentAttr .attr-field[data-required="1"], #modelAttr .attr-field[data-required="1"], #annotationAttr .attr-field[data-required="1"]');
  requiredFields.forEach(el => {
    // 多选显示区：检查 data-value-ids 是否为空
    let isEmpty;
    if (el.classList.contains('multi-select-display')) {
      const ids = (el.dataset.valueIds || '').split(',').filter(v => v);
      isEmpty = ids.length === 0;
    } else {
      isEmpty = !el.value.trim();
    }
    if (isEmpty) {
      valid = false;
      el.style.borderColor = '#ef4444';
      el.style.boxShadow = '0 0 0 1px #ef4444';
      // 确保所在分组展开
      const groupBody = el.closest('.attr-group-body');
      if (groupBody && groupBody.style.display === 'none') {
        groupBody.style.display = 'block';
        const arrow = groupBody.previousElementSibling?.querySelector('.attr-group-arrow');
        if (arrow) arrow.style.transform = 'rotate(0deg)';
      }
    } else {
      el.style.borderColor = '';
      el.style.boxShadow = '';
    }
  });
  return valid;
}

/** 智能映射：本地字段 ↔ Ozon属性字段（基于属性元数据的精确匹配） */
function setupSmartFieldBindings(attrListEl) {
  if (!attrListEl) return;

  const attrs = window._currentAttributes || [];

  // 映射规则：本地字段ID → 匹配函数（优先精确匹配，回退关键词匹配）
  const mappings = [
    {
      localId: 'editTitle',
      match: attr => {
        const n = attr.name || '';
        const ozon = attr.ozon_type || '';
        // 精确匹配常见属性名
        if (['名称', '标题', 'Name', 'Название', 'name'].includes(n)) return true;
        // 合并格式匹配：名称（Название）
        if (/^名称[（(]/.test(n) || /^标题[（(]/.test(n)) return true;
        // Ozon 标准属性：type=String 且是第一个 String 属性
        return false;
      }
    },
    {
      localId: 'editBrand',
      match: attr => {
        const n = attr.name || '';
        if (['品牌', 'Brand', 'Бренд', 'brand', 'Производитель'].includes(n)) return true;
        if (/^品牌[（(]/.test(n) || /^Бренд[（(]/.test(n)) return true;
        return false;
      }
    },
    {
      localId: 'editWeight',
      match: attr => {
        const n = attr.name || '';
        if (['重量', 'Weight', 'Вес', 'weight', 'Вес с упаковкой'].includes(n)) return true;
        if (/^重量[（(]/.test(n) || /^Вес[（(]/.test(n)) return true;
        return false;
      }
    },
  ];

  mappings.forEach(({ localId, match }) => {
    const localEl = document.getElementById(localId);
    if (!localEl) return;

    // 通过匹配函数找到对应的属性
    const matchedAttr = attrs.find(match);
    if (!matchedAttr) return;

    // 通过属性 ID 精确定位表单元素（含基本信息区的独立容器：简介/富内容/型号名称）
    const scope = document.querySelector('#editProductModal') || document;
    const attrInput = scope.querySelector(`[data-attr-id="${matchedAttr.id}"] input, [data-attr-id="${matchedAttr.id}"] textarea`);
    if (!attrInput) return;

    // 初始填充：优先用本地字段值
    if (localEl.value && !attrInput.value) {
      attrInput.value = localEl.value;
    } else if (attrInput.value && !localEl.value) {
      localEl.value = attrInput.value;
    }

    let syncing = false;
    localEl.addEventListener('input', () => {
      if (syncing) return;
      syncing = true;
      attrInput.value = localEl.value;
      syncing = false;
    });
    attrInput.addEventListener('input', () => {
      if (syncing) return;
      syncing = true;
      localEl.value = attrInput.value;
      syncing = false;
    });
  });
}

/**
 * 标准化采集来的 attributes 字段格式
 *
 * 采集侧可能产生 3 种格式：
 * 1. 对象（来自 ozon-scanner.js 的 _parseAttributes）：{color:'черный', size:'M'}
 * 2. Ozon 原生 API 数组（来自 data-card.js）：[{key:'4497', value:'200', name:'Вес'}, ...]
 * 3. 已是前端标准格式：[{id:4497, value:'200', dictionary_value_id:5}, ...]
 *
 * 本函数统一转成 [{id|name, value, dictionary_value_id?}] 数组，方便 fillAttributeValues 处理
 *
 * @param {object|Array|undefined} attrs - 采集来的原始 attributes
 * @returns {Array} 标准化后的属性数组
 */
function normalizeCollectedOzonColorData(product) {
  if (!product || product.platform !== 'ozon') return product;
  const attrs = Array.isArray(product.skuAttrs) ? product.skuAttrs : [];
  const skus = Array.isArray(product.skus) ? product.skus : [];
  const colorAttr = attrs.find(a => String(a.attrId || a.id || '') === '10096');
  const colorNameAttr = attrs.find(a => String(a.attrId || a.id || '') === '10097');
  if (!colorAttr) return product;

  const colorKey = colorAttr.name;
  const colorNameKey = colorNameAttr?.name;
  const sourceValues = Array.isArray(colorAttr.values) ? colorAttr.values : [];
  const sourceIds = Array.isArray(colorAttr.valueIds) ? colorAttr.valueIds : [];
  const normalizedValues = [];
  const normalizedIds = [];
  const normalizedNames = [];

  const splitColor = value => String(value || '').split(/[,，;]+/).map(v => v.trim()).filter(Boolean);
  const collectedColorPattern = /(黑|白|灰|米|红|蓝|绿|黄|粉|紫|棕|橙|черн|бел|сер|беж|красн|син|голуб|зелен|зелён|желт|жёлт|розов|фиолет|сирен|корич|оранж|black|white|grey|gray|beige|red|blue|green|yellow|pink|purple|brown|orange)/i;
  const selectPrimaryColor = value => {
    const parts = splitColor(value);
    const colorParts = parts.filter(part => collectedColorPattern.test(part));
    const hasNonColorSpec = parts.some(part => !collectedColorPattern.test(part));
    if (hasNonColorSpec && colorParts.length) return colorParts[colorParts.length - 1];
    return colorParts[0] || parts[0] || '';
  };
  const cleanColorName = value => String(value || '')
    .replace(/^\s*\d+\s*(?:спиц(?:ы)?|骨)?\s*[-–—:]\s*/i, '')
    .replace(/\s*\([^)]*[A-ZА-Я]-?\d{3,}[^)]*\)\s*$/i, '')
    .trim();

  skus.forEach((sku, index) => {
    if (!sku || typeof sku !== 'object') return;
    if (!sku.combo || typeof sku.combo !== 'object') sku.combo = {};
    let rawColor = sku.combo[colorKey] ?? sourceValues[index] ?? sourceValues[0] ?? '';
    const rawNameForColor = sku.combo[colorNameKey] ?? colorNameAttr?.values?.[index] ?? colorNameAttr?.values?.[0] ?? '';
    if (rawColor && !collectedColorPattern.test(String(rawColor)) && rawNameForColor) rawColor = rawNameForColor;
    const primaryColor = selectPrimaryColor(rawColor);
    const rawIds = sourceIds[index] ?? sourceIds[0] ?? null;
    const ids = Array.isArray(rawIds) ? rawIds.flat(Infinity).filter(Boolean) : [rawIds].filter(Boolean);
    const primaryId = ids[0] ?? null;
    if (primaryColor) {
      sku.combo[colorKey] = primaryColor;
      if (!normalizedValues.includes(primaryColor)) {
        normalizedValues.push(primaryColor);
        normalizedIds.push(primaryId);
      }
    }
    if (colorNameKey) {
      const rawName = sku.combo[colorNameKey] ?? colorNameAttr?.values?.[index] ?? colorNameAttr?.values?.[0] ?? primaryColor;
      const cleanName = cleanColorName(rawName) || primaryColor;
      sku.combo[colorNameKey] = cleanName;
      if (cleanName && !normalizedNames.includes(cleanName)) normalizedNames.push(cleanName);
    }
    if (product.title) sku.title = product.title;
  });

  if (normalizedValues.length) {
    colorAttr.values = normalizedValues;
    colorAttr.valueIds = normalizedIds;
  }
  if (colorNameAttr && normalizedNames.length) colorNameAttr.values = normalizedNames;
  return product;
}

function normalizeCollectedAttributes(attrs) {
  if (!attrs) return [];

  const normalizeAttributeValue = value => {
    if (value === undefined || value === null) return '';
    if (typeof value === 'object') {
      try { return JSON.stringify(value); } catch (_) { return ''; }
    }
    return String(value);
  };

  // 1. 对象格式：{key1: val1, key2: val2} → [{name: key1, value: val1}, ...]
  if (!Array.isArray(attrs) && typeof attrs === 'object') {
    const keys = Object.keys(attrs);
    if (keys.length === 0) return [];
    console.log('[normalizeCollectedAttributes] 检测到对象格式 attributes，转换为数组');
    return keys.map(k => ({
      name: k,
      value: normalizeAttributeValue(attrs[k]),
    })).filter(a => a.value && a.value !== 'undefined' && a.value !== 'null');
  }

  // 2. 数组格式：检查每个元素的字段
  if (Array.isArray(attrs)) {
    return attrs.map(a => {
      if (!a || typeof a !== 'object') return null;
      const attrId = a.id ?? a.attrId ?? a.attribute_id ?? a.key;
      const isRichContent = String(attrId || '') === '11254'
        || /json富内容|rich[-\s]?контент|rich[-\s]?content/i.test(String(a.name || ''));
      // 兼容 Ozon 原生：{key: '4497', value: '200', name: 'Вес'}
      // 把 key 转 id（保留 name 作回退）
      if (a.key !== undefined && a.id === undefined) {
        const normalized = {
          id: parseInt(a.key),
          value: normalizeAttributeValue(a.value),
        };
        // 保留 Ozon 原生 name 字段（俄文），方便 fillAttributeValues 按名称匹配
        if (a.name && !normalized.name) normalized.name = a.name;
        // 保留已有 dictionary_value_id（单选字典值）
        if (a.dictionary_value_id !== undefined) normalized.dictionary_value_id = a.dictionary_value_id;
        // 保留已有 dictionary_value_ids（多选字典值，如性别、多色等）
        if (Array.isArray(a.dictionary_value_ids) && a.dictionary_value_ids.length > 0) {
          normalized.dictionary_value_ids = a.dictionary_value_ids;
        }
        return normalized;
      }
      // 已是标准格式，透传
      const normalized = Object.assign({}, a, {
        value: normalizeAttributeValue(a.value),
      });
      // Older records may contain the Ozon API nested values shape.
      if (isRichContent && !normalized.value && Array.isArray(a.values)) {
        const nested = a.values.find(v => v && v.value !== undefined);
        if (nested) normalized.value = normalizeAttributeValue(nested.value);
      }
      return normalized;
    }).filter(a => a && (a.value !== ''
      || a.dictionary_value_id !== undefined
      || (Array.isArray(a.dictionary_value_ids) && a.dictionary_value_ids.length > 0)));
  }

  console.warn('[normalizeCollectedAttributes] 未识别的 attributes 格式:', attrs);
  return [];
}

/**
 * 自动匹配 select 字典值属性的源值到 Ozon 字典 value_id
 * 借鉴 autoMatchColor 的多层匹配逻辑，支持中→俄、俄→俄、英→俄匹配
 *
 * @param {HTMLSelectElement} selectEl - select 元素（含 dataset.attrId / descCatId / typeId）
 * @param {string} sourceValue - 源值（如"中国"/"Китай"/"China"）
 * @returns {Promise<{value_id:number, text:string}|null>}
 */
async function autoMatchAttrValue(selectEl, sourceValue) {
  if (!sourceValue) return null;
  const src = String(sourceValue).trim();
  const srcLower = src.toLowerCase();
  if (!src || src === 'undefined' || src === 'null') return null;

  const attrId = selectEl.dataset.attrId;
  const descCatId = selectEl.dataset.descCatId;
  const typeId = selectEl.dataset.typeId;
  if (!attrId || !descCatId || !typeId) return null;

  const cacheKey = `${descCatId}_${typeId}_${attrId}`;
  let dictValues = _attrValuesCache[cacheKey];

  // 缓存未命中，从后端拉取（不写入缓存，loadAttrOptions 会自己缓存）
  if (!dictValues) {
    try {
      const res = await Api.getAttributeValues(descCatId, typeId, attrId, 'ZH_HANS', 5);
      if (res.code === 200 && res.data && res.data.length > 0) {
        dictValues = res.data;
        _attrValuesCache[cacheKey] = dictValues;
      } else {
        return null;
      }
    } catch (e) {
      console.warn('[autoMatchAttrValue] 拉取字典值失败:', e);
      return null;
    }
  }

  // 多层匹配（参考 autoMatchColor）
  // 1. 精确匹配（中文 value_zh 或俄文 value 或英文）
  let match = dictValues.find(v =>
    v.value_zh === src ||
    (v.value && String(v.value).toLowerCase() === srcLower) ||
    (v.value_ru && v.value_ru.toLowerCase() === srcLower) ||
    (v.value_en && v.value_en.toLowerCase() === srcLower)
  );
  if (match) return { value_id: match.value_id, text: match.value };

  // 2. 包含匹配（双向，源值包含字典值的中/俄/英名）
  match = dictValues.find(v =>
    (v.value_zh && src.includes(v.value_zh)) ||
    (v.value && src.includes(v.value)) ||
    (v.value_zh && v.value_zh.includes(src)) ||
    (v.value && v.value.includes(src))
  );
  if (match) return { value_id: match.value_id, text: match.value };

  // 3. 常见中→俄属性值关键词匹配
  //    产地、保修期、性别、季节等通用值的翻译
  const VALUE_SYNONYMS = [
    // 产地
    ['中国', 'китай', 'china'],
    ['俄罗斯', 'россия', 'russia'],
    ['美国', 'сша', 'usa'],
    ['日本', 'япония', 'japan'],
    ['韩国', 'корея', 'korea'],
    ['德国', 'германия', 'germany'],
    ['法国', 'франция', 'france'],
    ['英国', 'великобритания', 'uk'],
    ['意大利', 'италия', 'italy'],
    ['西班牙', 'испания', 'spain'],
    ['土耳其', 'турция', 'turkey'],
    ['印度', 'индия', 'india'],
    ['越南', 'вьетнам', 'vietnam'],
    ['泰国', 'тайланд', 'thailand'],
    // 保修期
    ['12个月', '12 мес', '12 months'],
    ['12月', '12 мес'],
    ['6个月', '6 мес', '6 months'],
    ['6月', '6 мес'],
    ['24个月', '24 мес', '24 months'],
    ['24月', '24 мес'],
    ['1年', '12 мес', '1 year'],
    ['2年', '24 мес', '2 years'],
    ['无保修', 'нет гарантии', 'no warranty'],
    // 性别
    ['男', 'мужской', 'male'],
    ['女', 'женский', 'female'],
    ['男女通用', 'унисекс', 'unisex'],
    ['儿童', 'детский', 'kids'],
    // 季节
    ['春', 'весна', 'spring'],
    ['夏', 'лето', 'summer'],
    ['秋', 'осень', 'autumn'],
    ['冬', 'зима', 'winter'],
    // 是/否
    ['是', 'да', 'yes', 'true'],
    ['否', 'нет', 'no', 'false'],
  ];
  for (const [zh, ru, en] of VALUE_SYNONYMS) {
    if (src === zh || srcLower === ru || (en && srcLower === en)) {
      match = dictValues.find(v =>
        (v.value_zh && v.value_zh === zh) ||
        (v.value && String(v.value).toLowerCase() === ru) ||
        (v.value_ru && v.value_ru.toLowerCase() === ru)
      );
      if (match) return { value_id: match.value_id, text: match.value };
    }
    // 包含匹配：源值包含中文关键词，或俄文/英文值包含
    if (src.includes(zh)) {
      match = dictValues.find(v =>
        (v.value && String(v.value).toLowerCase().includes(ru)) ||
        (v.value_zh && v.value_zh.includes(zh))
      );
      if (match) return { value_id: match.value_id, text: match.value };
    }
  }

  return null;
}

/**
 * 自动匹配品牌搜索框的源值到 Ozon 品牌字典
 * 调用后端搜索接口找到匹配的品牌 dictionary_value_id
 *
 * @param {HTMLInputElement} inputEl - 品牌搜索输入框
 * @param {string} sourceValue - 源品牌名（如"小米"/"Xiaomi"）
 * @returns {Promise<void>}
 */
async function autoMatchBrand(inputEl, sourceValue) {
  if (!sourceValue) return;
  const src = String(sourceValue).trim();
  if (!src || src === 'undefined') return;

  // 先清除旧的 data-submit-value 和 data-value-id，避免残留"无品牌"默认值
  inputEl.dataset.submitValue = '';
  inputEl.dataset.valueId = '';

  const attrId = inputEl.dataset.attrId;
  const descCatId = inputEl.dataset.descCatId;
  const typeId = inputEl.dataset.typeId;

  try {
    // 调用后端属性字典值搜索接口（与 _doBrandSearch 使用的接口一致）
    if (typeof Api !== 'undefined' && Api.searchAttributeValues && attrId && descCatId && typeId) {
      const res = await Api.searchAttributeValues(descCatId, typeId, attrId, src);
      if (res.code === 200 && res.data && res.data.length > 0) {
        // 取第一个匹配（最相关）
        const brand = res.data[0];
        inputEl.dataset.valueId = brand.id || brand.value_id || '';
        inputEl.dataset.submitValue = '';
        inputEl.value = brand.value || brand.name || src;
        console.log('[autoMatchBrand] 匹配到品牌:', src, '→', brand.value || brand.name, '(id:', inputEl.dataset.valueId + ')');
        return;
      }
    }
    // 兜底：保留原值，不设 valueId（保存时按文本提交）
    inputEl.value = src;
    console.log('[autoMatchBrand] 未匹配到品牌字典值，使用文本值:', src);
  } catch (e) {
    console.warn('[autoMatchBrand] 失败:', e);
    inputEl.value = src;
  }
}

/** 回填已保存的类目属性值（等待字典值加载完成后再设置 select） */
function fillAttributeValues(savedAttrs) {
  if (!savedAttrs || !savedAttrs.length) return;

  // 统一兼容采集扁平格式、ERP 格式和 Ozon API 嵌套 values 格式。
  savedAttrs = savedAttrs.filter(a => a && typeof a === 'object').map(raw => {
    const attr = Object.assign({}, raw);
    attr.id = attr.id || attr.attrId || attr.attribute_id || attr.attributeId;
    const nested = Array.isArray(attr.values) ? attr.values : [];
    const nestedIds = nested.map(v => v && (v.dictionary_value_id || v.id)).filter(Boolean);
    const nestedTexts = nested.map(v => v && v.value).filter(v => v !== undefined && v !== null && v !== '');
    if (!attr.dictionary_value_id && nestedIds.length === 1) attr.dictionary_value_id = nestedIds[0];
    if ((!attr.dictionary_value_ids || attr.dictionary_value_ids.length === 0) && nestedIds.length > 1) {
      attr.dictionary_value_ids = nestedIds;
    }
    if ((attr.value === undefined || attr.value === null || attr.value === '') && nestedTexts.length) {
      attr.value = nestedTexts.join('; ');
    }
    return attr;
  });

  // 收集所有 Ozon 类目属性表单元素（id + name），用于名称回退匹配
  // 含基本信息区的 JSON富内容字段（#richContentAttr）、型号名称字段（#modelAttr）和简介字段（#annotationAttr）
  const ozonFields = [];
  document.querySelectorAll('#attrList [data-attr-id], #skuAttrList [data-attr-id], #richContentAttr [data-attr-id], #modelAttr [data-attr-id], #annotationAttr [data-attr-id]').forEach(el => {
    ozonFields.push({
      el,
      attrId: el.dataset.attrId,
      attrName: (el.dataset.attrName || '').toLowerCase(),
    });
  });

  // 属性名同义词映射（中 → 俄/英），解决 1688 中文属性名与 Ozon 俄文/英文属性名的跨语言匹配
  const NAME_SYNONYMS = {
    '品牌': ['бренд', 'brand', 'производитель', 'торговая марка'],
    '材质': ['материал', 'material', 'состав'],
    '颜色': ['цвет', 'color'],
    '尺寸': ['размер', 'size'],
    '重量': ['вес', 'weight', 'масса'],
    '产地': ['страна', 'country', 'страна производства', 'происхождение'],
    '型号': ['модель', 'model', 'артикул производителя'],
    '年份': ['год', 'year', 'год выпуска'],
    '季节': ['сезон', 'season'],
    '风格': ['стиль', 'style'],
    '图案': ['узор', 'pattern', 'рисунок'],
    '性别': ['пол', 'gender'],
    '包装数量': ['количество в упаковке', 'package quantity', 'комплектация'],
    '目的年龄': ['возраст', 'age', 'целевой возраст'],
    '目标受众': ['целевая аудитория', 'target audience'],
    '保修期': ['гарантия', 'warranty', 'гарантийный срок'],
    '电池容量': ['емкость батареи', 'battery capacity', 'аккумулятор'],
    '电池续航': ['время работы', 'battery life', 'автономность'],
    '充电接口': ['зарядка', 'charging', 'порт зарядки', 'разъем зарядки'],
    '防水等级': ['водонепроницаемость', 'waterproof', 'защита от воды'],
    '蓝牙版本': ['версия bluetooth', 'bluetooth version', 'bluetooth'],
    '连接方式': ['подключение', 'connection', 'способ подключения'],
    '功率': ['мощность', 'power', 'ватт'],
    '电压': ['напряжение', 'voltage'],
    '容量': ['объем', 'capacity', 'вместимость'],
    '形状': ['форма', 'shape'],
    '用途': ['назначение', 'usage', 'применение'],
    '适用场景': ['случай применения', 'occasion', 'сценарий применения'],
    '功能': ['функция', 'function', 'функции'],
    '配件': ['комплектация', 'accessories', 'в комплекте'],
    '生产国': ['страна производства', 'country of origin', 'страна-производитель'],
    '保质期': ['срок годности', 'shelf life', 'срок хранения'],
    '存储条件': ['условия хранения', 'storage conditions'],
    '面料': ['ткань', 'fabric', 'материал верха'],
    '里料': ['подкладка', 'lining'],
    '袖长': ['длина рукава', 'sleeve length'],
    '裤长': ['длина брюк', 'pants length'],
    '领型': ['воротник', 'collar', 'тип воротника'],
    '鞋码': ['размер обуви', 'shoe size'],
    '尺码': ['размер', 'size'],
    '厚度': ['толщина', 'thickness'],
    '直径': ['диаметр', 'diameter'],
    '长度': ['длина', 'length'],
    '宽度': ['ширина', 'width'],
    '高度': ['высота', 'height'],
    '深度': ['глубина', 'depth'],
    '频率': ['частота', 'frequency'],
    '分辨率': ['разрешение', 'resolution'],
    '屏幕尺寸': ['размер экрана', 'screen size', 'диагональ экрана'],
    '存储容量': ['объем памяти', 'storage', 'память'],
    '运行内存': ['оперативная память', 'ram', 'ram-память'],
    '处理器': ['процессор', 'processor', 'cpu'],
    '核心数': ['количество ядер', 'cores', 'ядра'],
  };

  const normalize = s => String(s || '').toLowerCase().trim();
  const nameMatch = (saName, ozonName) => {
    if (!saName || !ozonName) return false;
    if (saName === ozonName) return true;
    // 短词禁止包含匹配，避免俄文 "пол" 误命中 "купол"。
    if (Math.min(saName.length, ozonName.length) >= 4 &&
        (ozonName.includes(saName) || saName.includes(ozonName))) return true;
    // 同义词匹配（中文键 → 同义词列表）
    const syns = NAME_SYNONYMS[saName] || [];
    if (syns.some(s => ozonName.includes(s))) return true;
    // 反向查找：saName 是英文/俄文时，找对应的中文同义词组
    // 例如 saName='пол'（俄文），找到 NAME_SYNONYMS['性别']=['пол','gender',...]，
    // 再检查 ozonName 是否匹配中文键'性别'或同义词列表中的任意项
    for (const [zh, zhSyns] of Object.entries(NAME_SYNONYMS)) {
      if (zhSyns.includes(saName)) {
        // ozonName 是中文时，直接匹配中文键（如 "性别" === "性别" 或 "商品颜色" includes "颜色"）
        if (ozonName === zh || ozonName.includes(zh)) return true;
        if (zhSyns.some(s => ozonName.includes(s))) return true;
        break;
      }
    }
    return false;
  };

  let matchedCount = 0;
  // 未匹配到类目属性表单元素的属性，稍后尝试回填到 SKU 属性（商品颜色/颜色名称）
  const unmatchedForSku = [];
  savedAttrs.forEach(sa => {
    let targetEl = null;

    // 1. 优先按 id 精确匹配（Ozon 属性已有 id 的情况，如用户曾手动填过）
    if (sa.id) {
      targetEl = ozonFields.find(f => f.attrId === String(sa.id))?.el;
    }

    // 2. id 匹配失败时，按名称匹配（1688 采集属性只有 name，无 id）
    if (!targetEl && sa.name) {
      const saName = normalize(sa.name);
      // 全字段精确匹配优先，再做同义词/受限包含匹配。
      const found = ozonFields.find(f => f.attrName === saName) ||
        ozonFields.find(f => nameMatch(saName, f.attrName));
      if (found) {
        targetEl = found.el;
        // 同步 id 到 sa，方便后续保存时收集
        sa.id = parseInt(found.attrId);
      }
    }

    if (!targetEl) {
      unmatchedForSku.push(sa);
      return;
    }
    matchedCount++;

    // 多选字典属性：回填到显示区
    if (targetEl.classList.contains('multi-select-display')) {
      const savedIds = Array.isArray(sa.dictionary_value_ids) ? sa.dictionary_value_ids
        : (sa.dictionary_value_id ? [sa.dictionary_value_id] : []);
      console.log('[fillAttributeValues] 多选属性回填:', { attrId: sa.id, savedIds, sa });

      // 没有已保存的字典 ID，但有文本值（采集来的俄文/中文文本，如"женский"）
      // 自动匹配文本值到字典 value_id，再回填到多选显示区
      if (savedIds.length === 0 && sa.value !== undefined && sa.value !== null && sa.value !== '') {
        const valueParts = String(sa.value).split(/[;,/\n、]+/).map(v => v.trim()).filter(v => v);
        if (valueParts.length === 0) return;
        const displayEl = targetEl;
        (async () => {
          const matchedIds = [];
          const matchedLabels = [];
          for (const v of valueParts) {
            try {
              const matched = await autoMatchAttrValue(displayEl, v);
              if (matched && matched.value_id) {
                matchedIds.push(matched.value_id);
                matchedLabels.push(matched.text);
              }
            } catch (e) { /* 忽略单项匹配失败 */ }
          }
          if (matchedIds.length > 0) {
            displayEl.dataset.valueIds = matchedIds.join(',');
            displayEl.innerHTML = matchedLabels.map(label =>
              `<span style="display:inline-flex;align-items:center;padding:2px 8px;background:rgba(99,102,241,0.1);color:var(--color-primary);border-radius:4px;font-size:12px;gap:4px;">${label}</span>`
            ).join('');
            console.log('[fillAttributeValues] 多选属性自动匹配:', sa.value, '→', matchedIds, matchedLabels);
          } else {
            console.log('[fillAttributeValues] 多选属性字典值未匹配:', sa.value);
          }
        })();
        return;
      }

      if (savedIds.length === 0) return;

      targetEl.dataset.valueIds = savedIds.join(',');

      // 尝试从缓存渲染标签
      const descCatId = targetEl.dataset.descCatId;
      const typeId = targetEl.dataset.typeId;
      const attrId = targetEl.dataset.attrId;
      const cacheKey = `${descCatId}_${typeId}_${attrId}`;
      const renderLabels = (values) => {
        if (!values) return;
        const labels = savedIds.map(vid => {
          const found = values.find(v => v.value_id === vid);
          return found ? (found.value || found.value_zh || '') : '';
        }).filter(l => l);
        if (labels.length > 0) {
          targetEl.innerHTML = labels.map(label =>
            `<span style="display:inline-flex;align-items:center;padding:2px 8px;background:rgba(99,102,241,0.1);color:var(--color-primary);border-radius:4px;font-size:12px;gap:4px;">${label}</span>`
          ).join('');
        }
      };

      if (_attrValuesCache[cacheKey]) {
        renderLabels(_attrValuesCache[cacheKey]);
      } else {
        // 显示临时占位，后台加载缓存后渲染
        targetEl.innerHTML = `<span style="color:var(--text-tertiary);font-size:12px;">已选 ${savedIds.length} 项，加载中...</span>`;
        (async () => {
          try {
            const res = await Api.getAttributeValues(descCatId, typeId, attrId, 'ZH_HANS', 15);
            if (res.code === 200 && res.data) {
              _attrValuesCache[cacheKey] = res.data;
              renderLabels(res.data);
            }
          } catch (e) { /* 忽略，用户可点击重新选择 */ }
        })();
      }
      return;
    }

    if (targetEl.tagName === 'SELECT') {
      if (targetEl.dataset.attrType === 'boolean') {
        // Boolean 类型：直接设置 true/false
        const boolValue = String(sa.value).toLowerCase();
        if (boolValue === 'true' || boolValue === 'false') {
          targetEl.value = boolValue;
        }
      } else {
        // 单选字典值：暂存 savedValueId，避免异步轮询且回填不可靠
        // loadAttrOptions 加载完成（设置 dataset.loaded='1'）后会自动读取 savedValueId 设置 value
        // 即使选项加载失败，保存时 collectCategoryAttributes 也会用 savedValueId 兜底
        if (sa.dictionary_value_id) {
          targetEl.dataset.savedValueId = String(sa.dictionary_value_id);
          // 若选项已加载，立即设置；否则交给 loadAttrOptions 完成时设置
          if (targetEl.dataset.loaded === '1') {
            targetEl.value = String(sa.dictionary_value_id);
          } else {
            // 主动触发加载（如果用户尚未点击 select）
            if (typeof loadAttrOptions === 'function') {
              loadAttrOptions(targetEl).catch(e => console.warn('[fillAttributeValues] 触发 loadAttrOptions 失败:', e));
            }
          }
        } else if (sa.value !== undefined && sa.value !== null && sa.value !== '') {
          // 没有 dictionary_value_id，但有 value 文本（采集来的中文/俄文文本，如"中国"/"Китай"）
          // 异步从字典值列表中匹配 dictionary_value_id
          autoMatchAttrValue(targetEl, sa.value).then(matched => {
            if (matched && matched.value_id) {
              targetEl.dataset.savedValueId = String(matched.value_id);
              if (targetEl.dataset.loaded === '1') {
                targetEl.value = String(matched.value_id);
              }
              console.log('[fillAttributeValues] 自动匹配属性值:', sa.value, '→', matched.text, '(id:', matched.value_id + ')');
            } else {
              console.log('[fillAttributeValues] 字典值未匹配:', sa.value);
            }
          }).catch(e => console.warn('[fillAttributeValues] autoMatchAttrValue 失败:', e));
        }
      }
    } else if (targetEl.classList.contains('attr-search-field')) {
      // 品牌搜索输入框：先清除旧的 data-submit-value，避免残留"无品牌"默认值
      targetEl.dataset.submitValue = '';
      targetEl.dataset.valueId = '';
      if (sa.dictionary_value_id) {
        targetEl.dataset.valueId = sa.dictionary_value_id;
        targetEl.dataset.submitValue = '';
        if (sa.value) targetEl.value = sa.value;
      } else if (sa.value === 'Нет бренда' || sa.value === '无品牌') {
        // 无品牌：显示双语，提交俄语
        targetEl.dataset.submitValue = 'Нет бренда';
        targetEl.value = '无品牌（Нет бренда）';
      } else if (sa.value !== undefined && sa.value !== null && sa.value !== '') {
        // 没有字典 ID，但有品牌名（如"小米"），尝试模糊匹配品牌字典
        autoMatchBrand(targetEl, sa.value).catch(e => console.warn('[fillAttributeValues] autoMatchBrand 失败:', e));
      }
      if (!targetEl.value) targetEl.value = sa.value ?? '';
    } else if (sa.value !== undefined && sa.value !== null && sa.value !== '') {
      // 自由文本
      // 如果用户已在固定字段中输入了内容，不覆盖（用户已编辑的值优先于旧保存值）
      const isPinnedField = targetEl.closest('#annotationAttr, #richContentAttr, #modelAttr');
      if (isPinnedField && targetEl.value && targetEl.value.trim()) {
        return;
      }
      let value = sa.value;
      if (typeof value === 'object') {
        try { value = JSON.stringify(value); } catch (_) { value = ''; }
      }
      if (value === '[object Object]') value = '';
      targetEl.value = value;
      if (targetEl.closest('#richContentAttr')) renderRichInlinePreview();
    }
  });

  // 回填未匹配的属性到 SKU 销售属性（商品颜色/颜色名称等）
  // 这些属性的 input 没有 data-attr-id，通过 window._skuAttrs 数组管理
  let skuFilled = 0;
  if (unmatchedForSku.length > 0 && Array.isArray(window._skuAttrs) && window._skuAttrs.length > 0) {
    // SKU 属性名匹配：双向 includes + 颜色同义词
    const matchSkuAttrName = (saName, skuAttrName) => {
      if (!saName || !skuAttrName) return false;
      const sn = normalize(saName);
      const an = normalize(skuAttrName);
      if (an === sn) return true;
      if (Math.min(an.length, sn.length) >= 4 && (an.includes(sn) || sn.includes(an))) return true;
      // 颜色同义词匹配
      const COLOR_SYN = ['цвет', 'color', '颜色'];
      const NAME_SYN = ['название', 'name', '名称'];
      const snIsColor = COLOR_SYN.some(s => sn.includes(s));
      const anIsColor = COLOR_SYN.some(s => an.includes(s));
      if (snIsColor && anIsColor) {
        // 区分"商品颜色"与"颜色名称"：含 name/название/名称 的是颜色名称
        const snIsName = NAME_SYN.some(s => sn.includes(s));
        const anIsName = NAME_SYN.some(s => an.includes(s));
        return snIsName === anIsName;
      }
      return false;
    };

    // 第一轮：填充所有匹配到的 SKU 属性文本值
    const colorOriginalValues = []; // 保存商品颜色原始文本，用于回填颜色名称
    unmatchedForSku.forEach(sa => {
      if (!sa.value) return;
      for (let i = 0; i < window._skuAttrs.length; i++) {
        const skuAttr = window._skuAttrs[i];
        const idMatches = sa.id && skuAttr.attrId && String(sa.id) === String(skuAttr.attrId);
        if (!idMatches && !matchSkuAttrName(sa.name, skuAttr.name)) continue;

        if (!Array.isArray(skuAttr.values)) skuAttr.values = [];

        // color 类型可能含多值（如 "синий; красный"），拆分后分别填充
        // text 类型（颜色名称）保持原值不拆分
        let parts = [sa.value];
        if (skuAttr.skuType === 'color') {
          parts = String(sa.value).split(/[;,\n、]+/).map(v => v.trim()).filter(v => v);
          if (parts.length === 0) parts = [sa.value];
        }

        let filledAny = false;
        parts.forEach((part, pi) => {
          const existingVal = skuAttr.values[pi];
          if (existingVal && String(existingVal).trim()) return; // 不覆盖已有值
          skuAttr.values[pi] = part;
          if (skuAttr.skuType === 'color') {
            if (!Array.isArray(skuAttr.valueIds)) skuAttr.valueIds = [];
            skuAttr.valueIds[pi] = null; // 手动文本，清除字典 valueId
            colorOriginalValues[pi] = part; // 保存原始文本
          }
          filledAny = true;
        });

        if (filledAny) {
          skuFilled++;
          console.log('[fillAttributeValues] SKU属性回填:', {
            saName: sa.name, skuAttrName: skuAttr.name, value: sa.value, skuType: skuAttr.skuType,
            filledValues: parts
          });
        }
        break;
      }
    });

    // 第二轮：颜色名称回退——如果颜色名称没被采集数据匹配到，用商品颜色原始文本填充
    if (colorOriginalValues.length > 0) {
      const colorNameAttr = window._skuAttrs.find(a =>
        a.skuType === 'text' && a.name && (a.name.includes('颜色名称') || a.name.toLowerCase().includes('название'))
      );
      if (colorNameAttr) {
        if (!Array.isArray(colorNameAttr.values)) colorNameAttr.values = [];
        let nameFilled = false;
        colorOriginalValues.forEach((origVal, vi) => {
          if (!origVal) return;
          const existing = colorNameAttr.values[vi];
          if (existing && String(existing).trim()) return; // 不覆盖已有值
          colorNameAttr.values[vi] = origVal;
          nameFilled = true;
        });
        if (nameFilled) {
          skuFilled++;
          console.log('[fillAttributeValues] 颜色名称回退填充:', colorOriginalValues);
        }
      }
    }

    // 第三轮：异步触发商品颜色字典匹配（将原始文本匹配为"中文（俄语）"双语格式 + value_id）
    const colorSkuAttr = window._skuAttrs.find(a => a.skuType === 'color' && a.dictionaryId && a.attrId);
    const descCatId = window._selectedCategory?.description_category_id;
    const typeId = window._selectedCategory?.type_id;
    const willAsyncMatch = !!(colorSkuAttr && colorOriginalValues.length > 0 && descCatId && typeId);
    if (willAsyncMatch) {
      (async () => {
        try {
          const dictValues = await loadColorDictionary(colorSkuAttr.attrId, colorSkuAttr.dictionaryId, descCatId, typeId);
          if (dictValues.length > 0) {
            const matched = colorSkuAttr.values.map(v => autoMatchColor(v, dictValues));
            // 同步更新 SKU combo 的颜色值
            const oldValues = [...colorSkuAttr.values];
            colorSkuAttr.values = matched.map(m => m.text);
            colorSkuAttr.valueIds = matched.map(m => m.value_id);
            // 同步更新 product.skus 中的 combo 颜色值
            if (window._editingProduct?.skus && Array.isArray(window._editingProduct.skus)) {
              window._editingProduct.skus.forEach(sku => {
                if (sku.combo && sku.combo[colorSkuAttr.name] !== undefined) {
                  const oldVal = sku.combo[colorSkuAttr.name];
                  const matchIdx = oldValues.indexOf(oldVal);
                  if (matchIdx >= 0) {
                    sku.combo[colorSkuAttr.name] = colorSkuAttr.values[matchIdx];
                  }
                }
              });
            }
            renderSkuAttrs();
            generateSkuTable();
            // 颜色匹配完成后自动生成平台SKU编码
            setTimeout(() => { try { autoGenerateSkuCodes(); } catch (e) { console.warn('[autoGenerateSkuCodes] 失败:', e); } }, 100);
            console.log('[fillAttributeValues] 商品颜色字典匹配完成:', matched.map(m => ({ text: m.text, id: m.value_id })));
          }
        } catch (e) {
          console.warn('[fillAttributeValues] 商品颜色字典匹配失败:', e);
        }
      })();
    }

    if (skuFilled > 0) {
      if (typeof renderSkuAttrs === 'function') renderSkuAttrs();
      if (typeof generateSkuTable === 'function') generateSkuTable();
      // 无异步颜色匹配时，直接自动生成平台SKU编码
      if (!willAsyncMatch) {
        setTimeout(() => { try { autoGenerateSkuCodes(); } catch (e) { console.warn('[autoGenerateSkuCodes] 失败:', e); } }, 100);
      }
    }
  }

  console.log('[fillAttributeValues] 属性填充完成:', {
    总数: savedAttrs.length,
    已匹配: matchedCount,
    未匹配: savedAttrs.length - matchedCount,
    SKU属性回填: skuFilled,
  });
}

// ===== 品牌属性搜索 =====
// 点击输入框弹出下拉：首项"Нет бренда"(无品牌)，后跟品牌列表
// 输入文字时过滤匹配品牌

/** 搜索防抖计时器 */
let _brandSearchTimer = null;

/**
 * onfocus：立即弹出下拉框，首项为"Нет бренда"，后跟品牌列表（前50条）
 */
function showBrandDropdown(inputEl) {
  const dropdown = inputEl.closest('.attr-item')?.querySelector('.attr-search-dropdown');
  if (!dropdown) return;
  clearTimeout(_brandSearchTimer);
  _doBrandSearch(inputEl, dropdown, '');
}

/**
 * oninput：防抖 500ms 后按输入文字过滤品牌
 */
function searchAttrValues(inputEl) {
  const query = inputEl.value.trim();
  const dropdown = inputEl.closest('.attr-item')?.querySelector('.attr-search-dropdown');
  if (!dropdown) return;

  // 用户修改输入时重置已选的字典值 ID 和提交值
  inputEl.dataset.valueId = '';
  inputEl.dataset.submitValue = '';

  clearTimeout(_brandSearchTimer);
  _brandSearchTimer = setTimeout(() => _doBrandSearch(inputEl, dropdown, query), 500);
}

/**
 * 核心：调用后端 API 获取品牌列表，渲染下拉框
 * 下拉框首项始终为"Нет бренда"（Ozon 系统特殊值，无 dictionary_value_id）
 */
async function _doBrandSearch(inputEl, dropdown, query) {
  const { descCatId, typeId, attrId } = inputEl.dataset;

  // 显示加载中 + 定位
  dropdown.innerHTML = '<div class="brand-dropdown-hint">加载中...</div>';
  _positionBrandDropdown(inputEl, dropdown);
  dropdown.style.display = 'block';

  try {
    const res = await Api.searchAttributeValues(descCatId, typeId, attrId, query);
    const values = (res.code === 200 && Array.isArray(res.data)) ? res.data : [];

    // 构建 HTML：首项"无品牌"（双语显示，提交值为"Нет бренда"），后跟品牌列表
    let html = '<div class="brand-dropdown-item brand-no-brand-option" data-vid="" data-submit="Нет бренда">无品牌（Нет бренда）</div>';
    if (values.length === 0) {
      html += '<div class="brand-dropdown-hint">未找到匹配品牌</div>';
    } else {
      html += values.map(v =>
        `<div class="brand-dropdown-item" data-vid="${v.id}">${v.value}</div>`
      ).join('');
    }
    dropdown.innerHTML = html;

    // 绑定 mousedown 选中（preventDefault 防止 input 失焦）
    dropdown.querySelectorAll('.brand-dropdown-item').forEach(item => {
      item.onmousedown = (e) => {
        e.preventDefault();
        inputEl.value = item.textContent;
        inputEl.dataset.valueId = item.dataset.vid;
        // 存储实际提交值（无品牌选项显示双语但提交俄语）
        inputEl.dataset.submitValue = item.dataset.submit || '';
        dropdown.style.display = 'none';
        validateAttrField(inputEl);
      };
    });
  } catch (e) {
    console.warn('[品牌搜索] 失败:', e);
    dropdown.innerHTML = '<div class="brand-dropdown-hint">加载失败，可手动输入</div>';
  }
}

/** 根据 input 位置计算下拉框 fixed 定位（避免被 overflow:auto 裁剪） */
function _positionBrandDropdown(inputEl, dropdown) {
  const rect = inputEl.getBoundingClientRect();
  dropdown.style.top = (rect.bottom + 2) + 'px';
  dropdown.style.left = rect.left + 'px';
  dropdown.style.width = rect.width + 'px';
}

/** 关闭所有品牌下拉框 */
function _closeAllBrandDropdowns() {
  document.querySelectorAll('.attr-search-dropdown').forEach(d => {
    d.style.display = 'none';
  });
}

// 全局事件绑定（仅一次）：滚动/resize/点击外部时关闭下拉框
if (!window._brandDropdownEventsBound) {
  window._brandDropdownEventsBound = true;
  // 捕获阶段监听 scroll：modal-body 滚动时关闭，但下拉框内部滚动时保持打开
  document.addEventListener('scroll', (e) => {
    if (e.target && e.target.closest && e.target.closest('.attr-search-dropdown')) return;
    _closeAllBrandDropdowns();
  }, true);
  window.addEventListener('resize', _closeAllBrandDropdowns);
  document.addEventListener('click', (e) => {
    if (!e.target.closest('.attr-search-field') && !e.target.closest('.attr-search-dropdown')) {
      _closeAllBrandDropdowns();
    }
  });
}

// 页面渲染后加载数据的钩子
Store.subscribe((state) => {
  if (state.currentPage === 'collect') {
    setTimeout(loadProducts, 50);
  }
});
