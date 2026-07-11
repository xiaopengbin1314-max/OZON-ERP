/**
 * 利润计算器页 - Profit Calculator Page
 * 完整的利润计算工具，支持：
 * - 基础信息录入（售价/采购成本/类目佣金/重量/体积）
 * - 物流信息配置（跨境物流商/国内运费/代贴单费用）
 * - 其他费用设置（广告费占比/其他费用占比）
 * - 实时利润分解显示（毛利润/净利润/利润率）
 * - localStorage 数据暂存（防误操作丢失）
 * - 结果复制/导出
 *
 * 字段映射策略：
 * - 售价 → sellPriceRub（RUB）
 * - 采购成本 → costCny（CNY）
 * - 类目佣金率(%) → overrides.commission_rate（小数）
 * - 重量(g) → weightG
 * - 体积(cm) → lengthMm/widthMm/heightMm（×10 转 mm）
 * - 国内运费(CNY) → overrides.other_cost（按汇率转 RUB）
 * - 代贴单费用(CNY) → overrides.packaging_fee（按汇率转 RUB）
 * - 广告费占比(%) → overrides.acquisition_rate（小数）
 * - 其他费用占比(%) → 转金额后累加到 overrides.other_cost
 */

// ===== 状态 =====
let calcState = {
  sellPrice: '',
  costCny: '',
  commissionRate: '',
  weightG: '',
  lengthCm: '',
  widthCm: '',
  heightCm: '',
  logisticsProvider: 'fbo',
  domesticShipping: '',
  packingFee: '',
  adFeeRate: '',
  otherFeeRate: '',
};

let calcResult = null;
let pricingConfig = null;
let calcSubmitting = false;

const CALC_STORAGE_KEY = 'geekozon_calc_state_v1';

// 物流商选项（含主流跨境物流服务商）
const LOGISTICS_PROVIDERS = [
  { value: 'fbo', label: 'Ozon FBO（俄罗斯海外仓）' },
  { value: 'fbs', label: 'Ozon FBS（卖家自发货）' },
  { value: 'realfbs', label: 'realFBS（真实自发货）' },
  { value: 'cainiao', label: '菜鸟跨境物流' },
  { value: 'yanwen', label: '燕文物流' },
  { value: '4px', label: '4PX 递四方' },
  { value: 'yunexpress', label: '云途物流' },
  { value: 'correos', label: 'Correos（西班牙邮政）' },
  { value: 'postnl', label: 'PostNL（荷兰邮政）' },
];

// 物流商 → logistics_mode 映射
const LOGISTICS_MODE_MAP = {
  fbo: 'fbo', fbs: 'fbs', realfbs: 'realfbs',
  cainiao: 'fbo', yanwen: 'fbo', '4px': 'fbo',
  yunexpress: 'fbo', correos: 'fbo', postnl: 'fbo',
};


/** 渲染页面主体 */
function renderCalculatorPage(route) {
  const providersHtml = LOGISTICS_PROVIDERS.map(p =>
    `<option value="${p.value}">${p.label}</option>`
  ).join('');

  return `
    <div class="calc-page" style="animation: pageEnter 0.35s ease;">
      <!-- 页面标题 -->
      <div class="calc-page-header">
        <div>
          <h2 class="calc-page-title">利润计算器</h2>
          <p class="calc-page-desc">综合售价、采购成本、物流、佣金、广告等各项费用，精确计算 Ozon 跨境利润</p>
        </div>
        <div class="calc-header-actions">
          <button class="btn btn-sm btn-ghost" onclick="resetCalcForm()">
            <i data-lucide="rotate-ccw" style="width:14px;height:14px;"></i> 重置
          </button>
          <button class="btn btn-sm btn-ghost" onclick="loadPricingConfig(true)">
            <i data-lucide="refresh-cw" style="width:14px;height:14px;"></i> 刷新配置
          </button>
        </div>
      </div>

      <!-- 配置提示条 -->
      <div class="calc-config-banner" id="calcConfigBanner">
        <i data-lucide="loader-2" style="width:14px;height:14px;animation: spin 1s linear infinite;"></i>
        <span>加载定价配置中...</span>
      </div>

      <div class="calc-layout">
        <!-- 左侧：输入表单 -->
        <div class="calc-form-side">
          <!-- 1. 基础信息录入模块 -->
          <div class="calc-section">
            <div class="calc-section-header">
              <span class="calc-section-icon" style="background:rgba(99,102,241,0.1);color:var(--color-primary);">1</span>
              <h3>基础信息录入</h3>
            </div>
            <div class="calc-grid">
              <div class="form-group">
                <label class="form-label">产品售价 (RUB) <span class="calc-required">*</span></label>
                <input type="number" class="form-input" id="calc-sellPrice"
                       placeholder="如 1500.00" step="0.01" min="0"
                       oninput="onCalcInput('sellPrice', this.value)">
                <span class="calc-hint">Ozon 售价，俄罗斯卢布</span>
              </div>
              <div class="form-group">
                <label class="form-label">采购成本 (CNY) <span class="calc-required">*</span></label>
                <input type="number" class="form-input" id="calc-costCny"
                       placeholder="如 100.00" step="0.01" min="0"
                       oninput="onCalcInput('costCny', this.value)">
                <span class="calc-hint">人民币采购价</span>
              </div>
              <div class="form-group">
                <label class="form-label">类目佣金率 (%)</label>
                <input type="number" class="form-input" id="calc-commissionRate"
                       placeholder="如 15" step="0.1" min="0" max="100"
                       oninput="onCalcInput('commissionRate', this.value)">
                <span class="calc-hint">范围 0-100%，留空使用系统默认</span>
              </div>
              <div class="form-group">
                <label class="form-label">包裹重量 (克)</label>
                <input type="number" class="form-input" id="calc-weightG"
                       placeholder="如 500" step="1" min="0"
                       oninput="onCalcInput('weightG', this.value)">
                <span class="calc-hint">整数，单位克</span>
              </div>
              <div class="form-group">
                <label class="form-label">长 (cm)</label>
                <input type="number" class="form-input" id="calc-lengthCm"
                       placeholder="如 20.0" step="0.1" min="0"
                       oninput="onCalcInput('lengthCm', this.value)">
              </div>
              <div class="form-group">
                <label class="form-label">宽 (cm)</label>
                <input type="number" class="form-input" id="calc-widthCm"
                       placeholder="如 10.0" step="0.1" min="0"
                       oninput="onCalcInput('widthCm', this.value)">
              </div>
              <div class="form-group">
                <label class="form-label">高 (cm)</label>
                <input type="number" class="form-input" id="calc-heightCm"
                       placeholder="如 5.0" step="0.1" min="0"
                       oninput="onCalcInput('heightCm', this.value)">
                <span class="calc-hint">体积用于计算体积重（计费重 = max(实重, 体积重)）</span>
              </div>
            </div>
          </div>

          <!-- 2. 物流信息配置模块 -->
          <div class="calc-section">
            <div class="calc-section-header">
              <span class="calc-section-icon" style="background:rgba(74,144,217,0.1);color:var(--color-accent-blue);">2</span>
              <h3>物流信息配置</h3>
            </div>
            <div class="calc-grid">
              <div class="form-group">
                <label class="form-label">跨境物流商</label>
                <select class="form-select" id="calc-logisticsProvider"
                        onchange="onCalcInput('logisticsProvider', this.value)">
                  ${providersHtml}
                </select>
                <span class="calc-hint">不同物流商对应不同运费单价</span>
              </div>
              <div class="form-group">
                <label class="form-label">国内运费 (CNY)</label>
                <input type="number" class="form-input" id="calc-domesticShipping"
                       placeholder="如 5.00" step="0.01" min="0"
                       oninput="onCalcInput('domesticShipping', this.value)">
                <span class="calc-hint">国内段运费，人民币</span>
              </div>
              <div class="form-group">
                <label class="form-label">代贴单费用 (CNY)</label>
                <input type="number" class="form-input" id="calc-packingFee"
                       placeholder="如 1.00" step="0.01" min="0"
                       oninput="onCalcInput('packingFee', this.value)">
                <span class="calc-hint">贴标/打包服务费，人民币</span>
              </div>
            </div>
          </div>

          <!-- 3. 其他费用设置模块 -->
          <div class="calc-section">
            <div class="calc-section-header">
              <span class="calc-section-icon" style="background:rgba(139,92,246,0.1);color:var(--color-accent-purple);">3</span>
              <h3>其他费用设置</h3>
            </div>
            <div class="calc-grid">
              <div class="form-group">
                <label class="form-label">广告费占比 (%)</label>
                <input type="number" class="form-input" id="calc-adFeeRate"
                       placeholder="如 5" step="0.1" min="0" max="100"
                       oninput="onCalcInput('adFeeRate', this.value)">
                <span class="calc-hint">范围 0-100%，按售价计提</span>
              </div>
              <div class="form-group">
                <label class="form-label">其他费用占比 (%)</label>
                <input type="number" class="form-input" id="calc-otherFeeRate"
                       placeholder="如 2" step="0.1" min="0" max="100"
                       oninput="onCalcInput('otherFeeRate', this.value)">
                <span class="calc-hint">含提现手续费、货损等，按售价计提</span>
              </div>
            </div>
          </div>

          <!-- 4. 计算按钮 -->
          <div class="calc-action-bar">
            <button class="btn btn-primary calc-submit-btn" id="calc-submitBtn"
                    onclick="handleCalcSubmit()">
              <i data-lucide="calculator" style="width:16px;height:16px;"></i>
              <span>开始计算</span>
            </button>
            <span class="calc-auto-save-hint" id="calc-autoSaveHint">
              <i data-lucide="check-circle" style="width:12px;height:12px;"></i>
              <span>数据已自动暂存</span>
            </span>
          </div>
        </div>

        <!-- 右侧：结果展示 -->
        <div class="calc-result-side" id="calcResultSide">
          <div class="calc-result-empty" id="calcResultEmpty">
            <i data-lucide="bar-chart-3" style="width:48px;height:48px;opacity:0.3;"></i>
            <p>填写左侧参数后点击"开始计算"</p>
            <p class="calc-result-empty-sub">系统将展示完整的利润分解</p>
          </div>
          <div class="calc-result-content" id="calcResultContent" style="display:none;"></div>
        </div>
      </div>
    </div>
  `;
}

// ===== 初始化 =====

/** 异步初始化（在 render 后由 setTimeout 触发） */
function initCalculatorPage() {
  loadCalcStateFromStorage();
  fillCalcForm();
  loadPricingConfig();
  // 如果之前已计算过且暂存了结果，尝试恢复（仅恢复输入，结果需重新计算）
  if (window.lucide) lucide.createIcons();
}

/** 加载定价配置 */
async function loadPricingConfig(showToast = false) {
  const banner = document.getElementById('calcConfigBanner');
  try {
    const res = await Api.getPricingConfig();
    if (res.code === 200 && res.data) {
      pricingConfig = res.data;
      renderConfigBanner();
      if (showToast) Toast.show('定价配置已刷新', 'success');
    } else {
      if (banner) {
        banner.innerHTML = `<i data-lucide="alert-circle" style="width:14px;height:14px;color:var(--color-accent-red);"></i><span style="color:var(--color-accent-red);">配置加载失败：${res.msg || '未知错误'}</span>`;
      }
    }
  } catch (e) {
    console.error('[计算器] 加载配置失败:', e);
    if (banner) {
      banner.innerHTML = `<i data-lucide="alert-circle" style="width:14px;height:14px;color:var(--color-accent-red);"></i><span style="color:var(--color-accent-red);">后端服务未响应，请检查</span>`;
    }
  }
  if (window.lucide) lucide.createIcons();
}

/** 渲染配置提示条 */
function renderConfigBanner() {
  const banner = document.getElementById('calcConfigBanner');
  if (!banner || !pricingConfig) return;
  const rate = pricingConfig.exchange_rate_cny_to_rub || 12.5;
  const currency = pricingConfig.storeCurrency || 'RUB';
  const divisor = pricingConfig.volumetric_divisor || 5000;
  banner.innerHTML = `
    <i data-lucide="info" style="width:14px;height:14px;color:var(--color-accent-blue);"></i>
    <span>当前汇率：<strong>1 CNY = ${rate} ${currency}</strong>　|　店铺币种：<strong>${currency}</strong>　|　体积重系数：<strong>${divisor}</strong></span>
  `;
  if (window.lucide) lucide.createIcons();
}

// ===== 输入处理 =====

/** 输入事件处理（同时触发自动暂存） */
function onCalcInput(field, value) {
  calcState[field] = value;
  saveCalcStateToStorage();
}

/** 填充表单（从 state 恢复） */
function fillCalcForm() {
  Object.keys(calcState).forEach(key => {
    const el = document.getElementById(`calc-${key}`);
    if (el) el.value = calcState[key] || '';
  });
}

// ===== localStorage 暂存 =====

function saveCalcStateToStorage() {
  try {
    localStorage.setItem(CALC_STORAGE_KEY, JSON.stringify(calcState));
    const hint = document.getElementById('calc-autoSaveHint');
    if (hint) {
      hint.classList.add('visible');
      clearTimeout(saveCalcStateToStorage._t);
      saveCalcStateToStorage._t = setTimeout(() => hint.classList.remove('visible'), 1500);
    }
  } catch (e) {
    console.warn('[计算器] 暂存失败:', e);
  }
}

function loadCalcStateFromStorage() {
  try {
    const saved = localStorage.getItem(CALC_STORAGE_KEY);
    if (saved) {
      const parsed = JSON.parse(saved);
      if (parsed && typeof parsed === 'object') {
        calcState = { ...calcState, ...parsed };
      }
    }
  } catch (e) {
    console.warn('[计算器] 恢复暂存失败:', e);
  }
}

/** 重置表单 */
function resetCalcForm() {
  if (!confirm('确定要清空所有输入吗？暂存数据也会被清除。')) return;
  calcState = {
    sellPrice: '', costCny: '', commissionRate: '', weightG: '',
    lengthCm: '', widthCm: '', heightCm: '',
    logisticsProvider: 'fbo', domesticShipping: '', packingFee: '',
    adFeeRate: '', otherFeeRate: '',
  };
  calcResult = null;
  try { localStorage.removeItem(CALC_STORAGE_KEY); } catch (e) {}
  fillCalcForm();
  renderCalcResult();
  Toast.show('已重置', 'info');
  if (window.lucide) lucide.createIcons();
}

// ===== 输入验证 =====

function validateCalcInputs() {
  const errors = [];
  if (!calcState.sellPrice || parseFloat(calcState.sellPrice) <= 0) {
    errors.push('产品售价必须大于 0');
  }
  if (calcState.costCny === '' || parseFloat(calcState.costCny) < 0) {
    errors.push('采购成本不能为空');
  }
  const ranges = [
    { field: 'commissionRate', name: '类目佣金率', max: 100 },
    { field: 'adFeeRate', name: '广告费占比', max: 100 },
    { field: 'otherFeeRate', name: '其他费用占比', max: 100 },
  ];
  ranges.forEach(r => {
    if (calcState[r.field] !== '' && calcState[r.field] !== null && calcState[r.field] !== undefined) {
      const v = parseFloat(calcState[r.field]);
      if (isNaN(v) || v < 0 || v > r.max) {
        errors.push(`${r.name} 必须在 0-${r.max}% 之间`);
      }
    }
  });
  ['lengthCm', 'widthCm', 'heightCm', 'weightG', 'domesticShipping', 'packingFee'].forEach(k => {
    if (calcState[k] !== '' && parseFloat(calcState[k]) < 0) {
      errors.push('数值不能为负数');
    }
  });
  return errors;
}

// ===== 计算逻辑 =====

/** 构建提交参数 */
function buildCalcParams() {
  const rate = pricingConfig?.exchange_rate_cny_to_rub || 12.5;
  const sellPrice = parseFloat(calcState.sellPrice) || 0;

  // 国内运费 + 代贴单费用：CNY → RUB
  const domesticShippingCny = parseFloat(calcState.domesticShipping) || 0;
  const packingFeeCny = parseFloat(calcState.packingFee) || 0;
  const domesticShippingRub = domesticShippingCny * rate;
  const packingFeeRub = packingFeeCny * rate;

  // 其他费用占比 → 金额（按售价计提）
  const otherFeeRatePercent = parseFloat(calcState.otherFeeRate) || 0;
  const otherFeeAmountRub = sellPrice * (otherFeeRatePercent / 100);

  // 构建 overrides
  const overrides = {
    other_cost: domesticShippingRub + otherFeeAmountRub,
    packaging_fee: packingFeeRub,
  };

  // 类目佣金率（百分比 → 小数）
  if (calcState.commissionRate !== '') {
    overrides.commission_rate = (parseFloat(calcState.commissionRate) || 0) / 100;
  }

  // 广告费占比（百分比 → 小数）
  if (calcState.adFeeRate !== '') {
    overrides.acquisition_rate = (parseFloat(calcState.adFeeRate) || 0) / 100;
  }

  // 物流商映射到 logistics_mode
  const logisticsMode = LOGISTICS_MODE_MAP[calcState.logisticsProvider] || 'fbo';

  // 店铺币种：CNY 店铺汇率=1，RUB 店铺用配置汇率
  const storeCurrency = pricingConfig?.storeCurrency || 'RUB';
  const exchangeRate = storeCurrency === 'CNY' ? 1.0 : rate;

  return {
    sellPriceRub: sellPrice,
    costCny: parseFloat(calcState.costCny) || 0,
    weightG: parseFloat(calcState.weightG) || 0,
    lengthMm: (parseFloat(calcState.lengthCm) || 0) * 10,
    widthMm: (parseFloat(calcState.widthCm) || 0) * 10,
    heightMm: (parseFloat(calcState.heightCm) || 0) * 10,
    logisticsMode,
    storeCurrency,
    exchangeRate,
    overrides,
  };
}

/** 提交计算 */
async function handleCalcSubmit() {
  const errors = validateCalcInputs();
  if (errors.length) {
    Toast.show(errors[0], 'error');
    return;
  }
  if (calcSubmitting) return;
  calcSubmitting = true;
  const btn = document.getElementById('calc-submitBtn');
  if (btn) {
    btn.disabled = true;
    btn.innerHTML = `<i data-lucide="loader-2" style="width:16px;height:16px;animation: spin 1s linear infinite;"></i><span>计算中...</span>`;
    if (window.lucide) lucide.createIcons();
  }
  try {
    const params = buildCalcParams();
    const res = await Api.calculateProfit(params);
    if (res.code === 200 && res.data) {
      calcResult = res.data;
      renderCalcResult();
      Toast.show('计算完成', 'success');
    } else {
      Toast.show(res.msg || '计算失败', 'error');
    }
  } catch (e) {
    console.error('[计算器] 计算失败:', e);
    Toast.show('计算失败：' + (e.message || '未知错误'), 'error');
  } finally {
    calcSubmitting = false;
    if (btn) {
      btn.disabled = false;
      btn.innerHTML = `<i data-lucide="calculator" style="width:16px;height:16px;"></i><span>开始计算</span>`;
      if (window.lucide) lucide.createIcons();
    }
  }
}

// ===== 结果渲染 =====

function renderCalcResult() {
  const empty = document.getElementById('calcResultEmpty');
  const content = document.getElementById('calcResultContent');
  if (!calcResult) {
    if (empty) empty.style.display = '';
    if (content) content.style.display = 'none';
    return;
  }
  if (empty) empty.style.display = 'none';
  if (content) {
    content.style.display = '';
    content.innerHTML = buildResultHtml(calcResult);
    if (window.lucide) lucide.createIcons();
  }
}

function buildResultHtml(r) {
  const profitClass = r.profit >= 0 ? 'positive' : 'negative';
  const profitSign = r.profit >= 0 ? '+' : '';
  const profitRatePct = (r.profit_rate * 100).toFixed(2);
  const profitMarginPct = (r.profit_margin * 100).toFixed(2);

  // 毛利润 = 售价 - 采购成本 - 类目佣金 - 物流费用
  // 净利润 = 毛利润 - 国内运费 - 代贴单 - 广告 - 其他费用 - 税费 - 损耗 - 退货
  const grossProfit = r.sell_price - r.cost_rub - r.commission_fee - r.shipping_fee - r.logistics_commission_fee;

  return `
    <div class="calc-result-summary">
      <div class="calc-result-hero ${profitClass}">
        <div class="calc-hero-label">净利润</div>
        <div class="calc-hero-value">${profitSign}${r.profit.toFixed(2)} <span class="calc-hero-unit">RUB</span></div>
        <div class="calc-hero-rate">利润率 ${profitRatePct}%　|　成本利润率 ${profitMarginPct}%</div>
      </div>
      <div class="calc-result-mini-grid">
        <div class="calc-mini-card">
          <div class="calc-mini-label">售价</div>
          <div class="calc-mini-value">${r.sell_price.toFixed(2)} <span class="calc-mini-unit">RUB</span></div>
        </div>
        <div class="calc-mini-card">
          <div class="calc-mini-label">毛利润</div>
          <div class="calc-mini-value ${grossProfit >= 0 ? 'positive' : 'negative'}">${grossProfit >= 0 ? '+' : ''}${grossProfit.toFixed(2)} <span class="calc-mini-unit">RUB</span></div>
          <div class="calc-mini-sub">售价 - 采购 - 佣金 - 运费</div>
        </div>
        <div class="calc-mini-card">
          <div class="calc-mini-label">总成本</div>
          <div class="calc-mini-value">${r.total_cost.toFixed(2)} <span class="calc-mini-unit">RUB</span></div>
        </div>
      </div>
    </div>

    <div class="calc-result-detail">
      <h4 class="calc-detail-title">成本分解</h4>
      <table class="calc-detail-table">
        <thead>
          <tr><th>项目</th><th>金额 (RUB)</th><th>说明</th></tr>
        </thead>
        <tbody>
          ${buildDetailRow('采购成本', r.cost_rub, `${r.cost_cny.toFixed(2)} CNY × ${r.exchange_rate}`)}
          ${buildDetailRow('跨境运费', r.shipping_fee, `${(r.logistics_mode || '').toUpperCase()} 模式，计费重 ${r.shipping_detail?.chargeable_kg || 0} kg`)}
          ${buildDetailRow('销售佣金', r.commission_fee, `率 ${(r.commission_rate * 100).toFixed(2)}% (${r.commission_source})`)}
          ${r.logistics_commission_fee > 0 ? buildDetailRow('物流佣金', r.logistics_commission_fee, `率 ${(r.logistics_commission_rate * 100).toFixed(2)}%`) : ''}
          ${r.acquisition_fee > 0 ? buildDetailRow('广告/流量费', r.acquisition_fee, `率 ${(r.acquisition_rate * 100).toFixed(2)}%`) : ''}
          ${r.packaging_fee > 0 ? buildDetailRow('包装/代贴单', r.packaging_fee, '含代贴单费用') : ''}
          ${r.other_cost > 0 ? buildDetailRow('其他费用', r.other_cost, '含国内运费/提现/货损等') : ''}
          ${r.vat_fee > 0 ? buildDetailRow('VAT 增值税', r.vat_fee, `率 ${(r.vat_rate * 100).toFixed(2)}%`) : ''}
          ${r.individual_tax_fee > 0 ? buildDetailRow('个税', r.individual_tax_fee, `率 ${(r.individual_tax_rate * 100).toFixed(2)}%`) : ''}
          ${r.loss_cost > 0 ? buildDetailRow('损耗成本', r.loss_cost, `率 ${(r.loss_rate * 100).toFixed(2)}%`) : ''}
          ${r.return_cost > 0 ? buildDetailRow('退货损失', r.return_cost, `率 ${(r.return_rate * 100).toFixed(2)}%`) : ''}
          ${r.fbo_handling_fee > 0 ? buildDetailRow('FBO Handling', r.fbo_handling_fee, 'FBO 处理费') : ''}
          ${r.fbs_handling_fee > 0 ? buildDetailRow('FBS Handling', r.fbs_handling_fee, 'FBS 处理费') : ''}
        </tbody>
        <tfoot>
          <tr><td><strong>总成本</strong></td><td><strong>${r.total_cost.toFixed(2)}</strong></td><td></td></tr>
          <tr class="calc-profit-row ${profitClass}"><td><strong>净利润</strong></td><td><strong>${profitSign}${r.profit.toFixed(2)}</strong></td><td>利润率 ${profitRatePct}%</td></tr>
        </tfoot>
      </table>
    </div>

    <div class="calc-result-actions">
      <button class="btn btn-sm btn-secondary" onclick="copyCalcResult()">
        <i data-lucide="copy" style="width:13px;height:13px;"></i> 复制结果
      </button>
      <button class="btn btn-sm btn-ghost" onclick="exportCalcResult()">
        <i data-lucide="download" style="width:13px;height:13px;"></i> 导出文本
      </button>
    </div>
  `;
}

function buildDetailRow(name, amount, desc) {
  return `<tr><td>${name}</td><td>${amount.toFixed(2)}</td><td style="color:var(--text-tertiary);font-size:12px;">${desc || ''}</td></tr>`;
}

// ===== 结果导出/复制 =====

function buildResultText() {
  if (!calcResult) return '';
  const r = calcResult;
  const lines = [
    '===== Ozon 利润计算结果 =====',
    `计算时间: ${new Date().toLocaleString('zh-CN')}`,
    '',
    '【输入参数】',
    `产品售价: ${r.sell_price.toFixed(2)} RUB`,
    `采购成本: ${r.cost_cny.toFixed(2)} CNY (汇率 ${r.exchange_rate})`,
    `物流模式: ${(r.logistics_mode || '').toUpperCase()}`,
    '',
    '【成本分解】(RUB)',
    `采购成本: ${r.cost_rub.toFixed(2)}`,
    `跨境运费: ${r.shipping_fee.toFixed(2)}`,
    `销售佣金: ${r.commission_fee.toFixed(2)} (率 ${(r.commission_rate * 100).toFixed(2)}%)`,
    `物流佣金: ${r.logistics_commission_fee.toFixed(2)}`,
    `广告/流量费: ${r.acquisition_fee.toFixed(2)}`,
    `包装/代贴单: ${r.packaging_fee.toFixed(2)}`,
    `其他费用: ${r.other_cost.toFixed(2)}`,
    `VAT: ${r.vat_fee.toFixed(2)}`,
    `个税: ${r.individual_tax_fee.toFixed(2)}`,
    `损耗: ${r.loss_cost.toFixed(2)}`,
    `退货损失: ${r.return_cost.toFixed(2)}`,
    '',
    '【利润汇总】',
    `总成本: ${r.total_cost.toFixed(2)} RUB`,
    `净利润: ${r.profit.toFixed(2)} RUB`,
    `利润率: ${(r.profit_rate * 100).toFixed(2)}%`,
    `成本利润率: ${(r.profit_margin * 100).toFixed(2)}%`,
    '============================',
  ];
  return lines.join('\n');
}

function copyCalcResult() {
  const text = buildResultText();
  if (!text) return;
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(text).then(() => {
      Toast.show('结果已复制到剪贴板', 'success');
    }).catch(() => fallbackCopy(text));
  } else {
    fallbackCopy(text);
  }
}

function fallbackCopy(text) {
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.style.position = 'fixed';
  ta.style.opacity = '0';
  document.body.appendChild(ta);
  ta.select();
  try {
    document.execCommand('copy');
    Toast.show('结果已复制', 'success');
  } catch (e) {
    Toast.show('复制失败，请手动选择', 'error');
  }
  document.body.removeChild(ta);
}

function exportCalcResult() {
  const text = buildResultText();
  if (!text) return;
  const blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `ozon-profit-${new Date().toISOString().slice(0, 10)}.txt`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
  Toast.show('已导出文本文件', 'success');
}

// 路由注册
Router.register('/calculator', renderCalculatorPage);

// 页面挂载后异步初始化（监听 hashchange + 首次加载）
(function setupCalcAutoInit() {
  function tryInit() {
    if (window.location.hash === '#/calculator') {
      setTimeout(initCalculatorPage, 50);
    }
  }
  window.addEventListener('hashchange', tryInit);
  // 首次加载（如果直接打开 #/calculator）
  document.addEventListener('DOMContentLoaded', tryInit);
})();
