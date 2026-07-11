/**
 * AI 撰写页 - AI Write Page
 * 基于 AI 的商品内容生成工具：标题优化、描述生成、关键词推荐
 */
function renderAiWritePage(route) {
  return `
    <div class="ai-write-layout" style="animation:pageEnter 0.35s ease;">
      <!-- 左侧：输入面板 -->
      <div class="ai-panel ai-input-panel">
        <div class="ai-panel-header">
          <i data-lucide="edit-3" style="width:18px;height:18px;color:#8B5CF6;"></i>
          <h3>输入源内容</h3>
        </div>

        <!-- 类型选择器 -->
        <div class="ai-type-selector" id="aiTypeSelector">
          <button class="ai-type-btn active" data-type="title">标题优化</button>
          <button class="ai-type-btn" data-type="description">描述生成</button>
          <button class="ai-type-btn" data-type="keywords">关键词推荐</button>
          <button class="ai-type-btn" data-type="translate">多语言翻译</button>
        </div>

        <!-- 输入区 -->
        <div class="form-group">
          <label class="form-label">目标平台</label>
          <select class="form-select" id="aiPlatform">
            <option value="ozon">Ozon (俄罗斯)</option>
            <option value="wildberries">Wildberries (俄罗斯)</option>
            <option value="aliexpress">AliExpress (全球)</option>
          </select>
        </div>
        <div class="form-group">
          <label class="form-label">目标语言</label>
          <select class="form-select" id="aiLang">
            <option value="ru">俄语 (Русский)</option>
            <option value="en">英语 (English)</option>
            <option value="de">德语 (Deutsch)</option>
            <option value="zh">中文 (简体)</option>
          </select>
        </div>
        <div class="form-group">
          <label class="form-label">输入原文 / 关键词</label>
          <textarea class="form-textarea" id="aiInput"
            style="min-height:180px;"
            placeholder="请输入需要优化的商品标题、描述原文或关键词...&#10;&#10;例如：无线蓝牙耳机 降噪 长续航 运动 IPX7防水"></textarea>
        </div>

        <!-- 操作按钮 -->
        <div class="ai-generate-bar">
          <button class="btn btn-primary" onclick="handleAiGenerate()" id="generateBtn">
            <i data-lucide="sparkles" style="width:16px;height:16px;"></i>
            AI 生成
          </button>
          <button class="btn btn-ghost" onclick="clearAiInput()">清空</button>
        </div>
      </div>

      <!-- 右侧：输出面板 -->
      <div class="ai-panel ai-output-panel">
        <div class="ai-panel-header">
          <i data-lucide="file-text" style="width:18px;height:18px;color:#4A90D9;"></i>
          <h3>AI 生成结果</h3>
          <button class="btn btn-sm btn-ghost" onclick="copyAiResult()" id="copyBtn" style="margin-left:auto;">
            <i data-lucide="copy" style="width:13px;height:13px;"></i> 复制
          </button>
        </div>
        <div class="ai-output-area" id="aiOutput">
          <span style="color:var(--text-tertiary);font-style:italic;">AI 生成的内容将在此处展示...</span>
        </div>
        <div class="ai-generate-bar">
          <button class="btn btn-success-outline" onclick="applyToProduct()" id="applyBtn" disabled>
            <i data-lucide="check-circle" style="width:15px;height:15px;"></i> 应用到商品
          </button>
          <button class="btn btn-ghost" onclick="regenerate()" id="regenBtn" disabled>
            <i data-lucide="refresh-cw" style="width:14px;height:14px;"></i> 重新生成
          </button>
        </div>
      </div>
    </div>
  `;
}

let currentAiType = 'title';
let lastGeneratedContent = '';

/** 初始化 AI 页面事件 */
function initAiPageEvents() {
  // 类型切换
  const selector = document.getElementById('aiTypeSelector');
  if (selector) {
    selector.querySelectorAll('.ai-type-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        selector.querySelectorAll('.ai-type-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        currentAiType = btn.dataset.type;
      });
    });
  }
}

/** 处理 AI 生成 */
async function handleAiGenerate() {
  const input = document.getElementById('aiInput');
  const output = document.getElementById('aiOutput');
  const generateBtn = document.getElementById('generateBtn');
  const applyBtn = document.getElementById('applyBtn');
  const regenBtn = document.getElementById('regenBtn');

  const content = input.value.trim();
  if (!content) {
    Toast.show('请输入需要处理的内容', 'warning');
    return;
  }

  // UI 反馈
  generateBtn.disabled = true;
  generateBtn.innerHTML = '<i data-lucide="loader-2" style="width:16px;height:16px;animation:spin 1s linear infinite;"></i> 生成中...';
  output.innerHTML = '<span style="color:var(--text-tertiary);">AI 正在思考中，请稍候...</span>';
  if (window.lucide) lucide.createIcons();

  try {
    const res = await Api.aiGenerate({
      type: currentAiType,
      content: content,
      params: {
        platform: document.getElementById('aiPlatform')?.value || 'ozon',
        language: document.getElementById('aiLang')?.value || 'ru',
      },
    });

    if (res.code === 200 && res.data?.result) {
      lastGeneratedContent = res.data.result;
      output.textContent = lastGeneratedContent;
      applyBtn.disabled = false;
      regenBtn.disabled = false;
      Toast.show('AI 生成完成', 'success');
    } else {
      output.textContent = res.msg || '生成失败，请重试';
    }
  } catch (e) {
    output.textContent = '网络异常，请检查后端连接';
  } finally {
    generateBtn.disabled = false;
    generateBtn.innerHTML = '<i data-lucide="sparkles" style="width:16px;height:16px;"></i> AI 生成';
    if (window.lucide) lucide.createIcons();
  }
}

/** 清空输入 */
function clearAiInput() {
  document.getElementById('aiInput').value = '';
  document.getElementById('aiOutput').innerHTML = '<span style="color:var(--text-tertiary);font-style:italic;">AI 生成的内容将在此处展示...</span>';
  lastGeneratedContent = '';
}

/** 复制结果 */
function copyAiResult() {
  if (!lastGeneratedContent) {
    Toast.show('没有可复制的内容', 'warning');
    return;
  }
  navigator.clipboard.writeText(lastGeneratedContent).then(() => {
    Toast.show('已复制到剪贴板', 'success');
  }).catch(() => {
    Toast.show('复制失败', 'error');
  });
}

/** 应用到商品 */
function applyToProduct() {
  if (!lastGeneratedContent) return;
  Modal.show({
    title: '应用到商品',
    body: `<p>将以下内容应用到哪个商品？</p>
      <select class="form-select"><option>选择目标商品...</option></select>
      <div style="margin-top:12px;background:var(--bg-input);padding:12px;border-radius:8px;font-size:13px;max-height:150px;overflow-y:auto;">${lastGeneratedContent.slice(0, 500)}...</div>`,
    footer: [
      { text: '取消', class: 'btn-ghost' },
      { text: '应用', class: 'btn-primary', onClick: () => { Toast.show('已应用到商品', 'success'); Modal.close(); } },
    ],
  });
}

/** 重新生成 */
function regenerate() {
  handleAiGenerate();
}

// 注册路由
Router.register('/ai-write', renderAiWritePage);

// 页面初始化钩子
Store.subscribe((state) => {
  if (state.currentPage === 'ai-write') {
    setTimeout(initAiPageEvents, 100);
  }
});
