/**
 * 模态弹窗组件
 * 统一管理弹窗的显示、隐藏与内容渲染
 */
const Modal = (() => {
  // 弹窗堆栈，支持嵌套弹窗
  const stack = [];
  const BASE_Z_INDEX = 999;

  function _getTop() {
    return stack.length > 0 ? stack[stack.length - 1] : null;
  }

  /**
   * 显示模态弹窗
   * @param {object} options - 弹窗配置
   * @param {string} options.title - 弹窗标题
   * @param {string} options.body - 弹窗内容（HTML字符串）
   * @param {Array} options.footer - 底部按钮配置 [{text, class, onClick}]
   * @param {string} [options.size] - 尺寸：sm/md/lg/xl
   * @param {function} [options.onClose] - 关闭回调
   * @param {function} [options.beforeClose] - 关闭前守卫，返回 false 阻止关闭；可返回 Promise<boolean>
   */
  function show(options = {}) {
    const overlay = document.createElement('div');
    const sizeClass = options.size === 'xl' ? 'modal-xl' : options.size === 'lg' ? 'modal-lg' : options.size === 'sm' ? 'modal-sm' : options.size === 'xs' ? 'modal-xs' : '';
    overlay.className = `modal-overlay${options.size ? ' ' + sizeClass : ''}`;
    // 根据堆栈深度设置 z-index，确保新弹窗在旧弹窗之上
    overlay.style.zIndex = BASE_Z_INDEX + stack.length;
    overlay.innerHTML = `
      <div class="modal-dialog" role="dialog" aria-modal="true" aria-label="${options.title || '对话框'}">
        <div class="modal-header">
          <h2>${options.title || '提示'}</h2>
          <button class="modal-close" aria-label="关闭">&times;</button>
        </div>
        <div class="modal-body">${options.body || ''}</div>
        ${options.footer ? `
          <div class="modal-footer">
            ${options.footer.map(btn =>
              `<button class="btn ${btn.class || 'btn-primary'}" data-action="${btn.text}">${btn.text}</button>`
            ).join('')}
          </div>
        ` : ''}
      </div>`;

    document.body.appendChild(overlay);

    // 关闭回调
    overlay._onClose = options.onClose;
    // 关闭前守卫
    overlay._beforeClose = options.beforeClose;

    // 压入堆栈
    stack.push(overlay);

    // 关闭按钮
    overlay.querySelector('.modal-close').addEventListener('click', () => close());

    // 点击遮罩层关闭
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) close();
    });

    // ESC 键关闭（仅关闭最顶层弹窗）
    const escHandler = (e) => {
      if (e.key === 'Escape' && _getTop() === overlay) close();
    };
    document.addEventListener('keydown', escHandler);
    overlay._escHandler = escHandler;

    // 底部按钮事件
    if (options.footer) {
      overlay.querySelectorAll('.modal-footer .btn').forEach((btn, idx) => {
        btn.addEventListener('click', () => {
          const actionConfig = options.footer[idx];
          if (actionConfig.onClick) actionConfig.onClick();
          else close();
        });
      });
    }

    // 重新初始化图标
    if (window.lucide) lucide.createIcons();

    // 表单元素聚焦
    const firstInput = overlay.querySelector('.form-input, .form-textarea');
    if (firstInput) setTimeout(() => firstInput.focus(), 100);

    // 打开回调
    if (options.onOpen) options.onOpen();
  }

  /**
   * 关闭当前（最顶层）弹窗
   * @param {object} [opts] - { force?: boolean } 强制关闭，跳过守卫
   * @returns {Promise<boolean>} 是否真正关闭
   */
  async function close(opts = {}) {
    const overlay = _getTop();
    if (!overlay) return false;

    // 执行关闭前守卫（force=true 时跳过，用于程序化确认后关闭）
    if (!opts.force && typeof overlay._beforeClose === 'function') {
      try {
        const result = await overlay._beforeClose();
        if (result === false) return false;
      } catch (e) {
        console.warn('[Modal] beforeClose 守卫异常:', e);
        return false;
      }
    }

    overlay.classList.add('closing');

    // 清理事件监听
    if (overlay._escHandler) {
      document.removeEventListener('keydown', overlay._escHandler);
    }

    // 从堆栈中移除
    const idx = stack.indexOf(overlay);
    if (idx !== -1) stack.splice(idx, 1);

    setTimeout(() => {
      if (overlay._onClose) overlay._onClose();
      overlay.remove();
    }, 200);
    return true;
  }

  /**
   * 强制关闭（跳过 beforeClose 守卫），用于程序化确认后关闭
   */
  function forceClose() {
    return close({ force: true });
  }

  /**
   * 确认对话框
   * @param {string} message - 提示消息
   * @returns {Promise<boolean>}
   */
  function confirm(message) {
    return new Promise((resolve) => {
      show({
        title: '确认操作',
        size: 'sm',
        body: `<p style="font-size:14px;color:#6B7280;">${message}</p>`,
        footer: [
          { text: '取消', class: 'btn-ghost', onClick: () => { close(); resolve(false); } },
          { text: '确定', class: 'btn-primary', onClick: () => { close(); resolve(true); } },
        ],
      });
    });
  }

  return { show, close, forceClose, confirm };
})();
