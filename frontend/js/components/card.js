/**
 * 功能卡片组件
 * 用于首页展示 Premium会员/商品采集/AI撰装等插件卡片
 */
const Card = (() => {
  /**
   * 创建功能卡片 HTML
   * @param {object} config - 卡片配置
   * @returns {string} HTML 字符串
   */
  function createFeatureCard(config) {
    const { icon, badgeColor, badgeText, badgeIcon, title, subtitle, features, primaryAction, secondaryAction } = config;

    return `
      <div class="feature-card" data-card="${config.id || ''}">
        <!-- 彩色标签 -->
        <div class="card-badge ${badgeColor || 'blue'}">
          ${badgeIcon ? `<span class="badge-icon">${badgeIcon}</span>` : ''}
          ${badgeText || ''}
        </div>

        <!-- 标题与描述 -->
        <h3 class="card-title">${title}</h3>
        <p class="card-subtitle">${subtitle}</p>

        <!-- 特性列表 -->
        ${features && features.length > 0 ? `
          <ul class="card-features">
            ${features.map(f => `<li>${f}</li>`).join('')}
          </ul>
        ` : ''}

        <!-- 操作按钮 -->
        <div class="card-actions">
          ${primaryAction ? `<button class="btn btn-primary" onclick="${primaryAction.onClick || ''}">${primaryAction.text}</button>` : ''}
          ${secondaryAction ? `
            <button class="btn ${secondaryAction.class || 'btn-success-outline'}" onclick="${secondaryAction.onClick || ''}">
              ${secondaryAction.icon || ''}${secondaryAction.text}
            </button>
          ` : ''}
        </div>
      </div>`;
  }

  /**
   * 创建占位卡片（更多工具开发中）
   * @param {object} config
   * @returns {string}
   */
  function createPlaceholderCard(config = {}) {
    const { icon = '+', title = '更多工具开发中', desc = '敬请期待更多强大功能加入 GeekOzon。' } = config;
    return `
      <div class="placeholder-card" data-placeholder>
        <div class="placeholder-icon">${icon}</div>
        <p class="placeholder-text">${title}</p>
        <p class="placeholder-sub">${desc}</p>
      </div>`;
  }

  return { createFeatureCard, createPlaceholderCard };
})();
