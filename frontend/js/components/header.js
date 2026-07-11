/**
 * 顶部导航栏组件
 * 管理 Tab 切换、搜索、用户操作
 */
const Header = (() => {
  let elements = {};

  function init() {
    // 缓存 DOM 引用
    elements.tabs = document.querySelectorAll('#headerTabs .header-tab');
    elements.searchInput = document.getElementById('globalSearch');

    // 绑定 Tab 切换事件
    elements.tabs.forEach((tab) => {
      tab.addEventListener('click', () => handleTabSwitch(tab));
    });

    // 搜索框交互
    if (elements.searchInput) {
      elements.searchInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') handleSearch();
      });
    }

    // 新增操作按钮
    const newActionBtn = document.getElementById('newActionBtn');
    if (newActionBtn) {
      newActionBtn.addEventListener('click', () => {
        Modal.show({
          title: '新增操作',
          body: `
            <div class="form-group">
              <label class="form-label">选择操作类型</label>
              <select class="form-select">
                <option>手动添加商品</option>
                <option>批量导入 URL</option>
                <option>创建发布任务</option>
              </select>
            </div>
          `,
          footer: [
            { text: '取消', class: 'btn-ghost' },
            { text: '确认', class: 'btn-primary', onClick: () => Toast.show('功能开发中...', 'info') },
          ],
        });
      });
    }
  }

  /** 处理 Tab 切换 */
  function handleTabSwitch(activeTab) {
    elements.tabs.forEach((t) => t.classList.remove('active'));
    activeTab.classList.add('active');

    const tabName = activeTab.dataset.tab;
    switch (tabName) {
      case 'engine':
        Router.navigate('/ai-write');
        break;
      case 'products':
        Router.navigate('/collect');
        break;
      case 'publish':
        Router.navigate('/publish');
        break;
      default:
        Router.navigate('/home');
    }
  }

  /** 处理搜索 */
  function handleSearch() {
    const query = elements.searchInput?.value?.trim();
    if (!query) return;
    console.log('[Header] 搜索:', query);
    Toast.show(`搜索「${query}」的结果...`, 'info');
  }

  /** 设置激活的 Tab */
  function setActiveTab(tabKey) {
    elements.tabs.forEach((tab) => {
      tab.classList.toggle('active', tab.dataset.tab === tabKey);
    });
  }

  return { init, setActiveTab };
})();
