/**
 * 公告列表组件
 * 展示系统通知与公告信息
 */
const NoticeList = (() => {
  /**
   * 渲染公告面板
   * @param {Array} notices - 公告数据数组
   * @returns {string} HTML 字符串
   */
  function render(notices = []) {
    const displayNotices = notices;

    return `
      <section class="notice-panel notices-section">
        <div class="notice-header">
          <h3>
            <i data-lucide="megaphone" style="width:16px;height:16px;color:#F59E0B;"></i>
            通知公告
          </h3>
          <div style="display:flex;align-items:center;gap:8px;">
            <span class="notice-count">${displayNotices.length}条</span>
            <a class="view-all" id="viewAllNotices">查看全部 →</a>
          </div>
        </div>
        <div class="notice-list">
          ${displayNotices.length > 0 ? displayNotices.slice(0, 6).map(notice => `
            <div class="notice-item" data-notice-id="${notice.id}">
              <span class="tag tag-new notice-tag">新</span>
              <div class="notice-content">
                <span class="notice-title">${notice.title}</span>
              </div>
              <span class="notice-time">${notice.time}</span>
            </div>
          `).join('') : '<div class="notice-item"><div class="notice-content"><span class="notice-title">暂无公告</span></div></div>'}
        </div>
      </section>`;
  }

  /** 绑定事件 */
  function bindEvents(container) {
    const viewAllBtn = container.querySelector('#viewAllNotices');
    if (viewAllBtn) {
      viewAllBtn.addEventListener('click', () => {
        Toast.show('公告详情页开发中...', 'info');
      });
    }
  }

  return { render, bindEvents };
})();
