/**
 * 1688采集数据 → 编辑表单 → Ozon API 完整映射系统
 *
 * 数据流:
 *   1688采集 → cleanProductData() 清洗 → autoFillEditForm() 填充表单
 *   → 用户修改 → saveProductData() 保存 → buildOzonPayload() 打包 → Ozon API 创建商品
 */

// ============================================================================
// 1. 字段映射表（1688字段 → 编辑表单字段 → Ozon API字段）
// ============================================================================

const FIELD_MAPPING = {
  // 基本信息
  title:        { source: 'title',        form: 'editTitle',       ozon: 'name' },
  description:  { source: 'description',  form: null,              ozon: 'description' },
  mergeCode:    { source: 'productId',    form: null,              ozon: 'model_name' },
  vatRate:      { source: null,           form: 'vatRate',         ozon: 'vat',           default: '' },

  // 包裹重量尺寸
  weight:       { source: 'weight',       form: 'editWeight',      ozon: 'weight' },
  length:       { source: null,           form: 'editLength',      ozon: 'depth',         default: 0 },
  width:        { source: null,           form: 'editWidth',       ozon: 'width',         default: 0 },
  height:       { source: null,           form: 'editHeight',      ozon: 'height',        default: 0 },
  packageMode:  { source: null,           form: 'packageMode',     ozon: null,            default: 'sku' },

  // 图片
  images:       { source: 'images',       form: null,              ozon: 'images' },
  primaryImage: { source: 'images[0]',    form: null,              ozon: 'primary_image' },

  // 视频
  videos:       { source: null,           form: 'editCoverVideoUrl', ozon: 'videos',      default: [] },

  // 其他
  pointsForReviews: { source: null,       form: 'editPointsForReviews', ozon: 'points_for_reviews', default: 'disable' },
  brand:        { source: 'brand',        form: null,              ozon: 'vendor' },
  barcode:      { source: null,           form: null,              ozon: 'barcode' },
  oldPrice:     { source: null,           form: null,              ozon: 'old_price' },
  price:        { source: 'price',        form: null,              ozon: 'price' },

  // 类目
  descriptionCategoryId: { source: 'descriptionCategoryId', form: null, ozon: 'description_category_id' },
  typeId:                { source: 'typeId',                form: null, ozon: 'type_id' },

  // 货源
  sourceLinks:  { source: 'sourceLinks',  form: 'sourceLinksList', ozon: null },
  sourceLink:   { source: 'sourceLink',   form: null,              ozon: null },
  sourceName:   { source: 'sourceName',   form: null,              ozon: null },
  sourceId:     { source: 'sourceId',     form: null,              ozon: null },
  sourcePrice:  { source: 'price',        form: null,              ozon: null },

  // SKU数据
  skuAttrs:     { source: 'variants',     form: 'skuAttrList',     ozon: 'attributes' },
  skus:         { source: 'skuList',      form: 'skuTableWrap',    ozon: 'sources' },

  // 类目属性
  attributes:   { source: 'attributes',   form: 'attrList',        ozon: 'attributes' },
};

// ============================================================================
// 2. 数据清洗规则
// ============================================================================

/**
 * 清洗1688采集数据，转换为编辑表单可用的格式
 *
 * 适配真实1688数据结构：
 *   - attributes: [{id, value}] 数组格式（已是Ozon类目属性）
 *   - skuAttrs: [{attrId, name, values, skuType, dictionaryId}] 销售属性定义
 *   - skus: [{combo, price, stock, weight, length, width, height, skuCode}] SKU行
 *   - price/skuList/variants: 可能为空（1688采集器未捕获价格时）
 *
 * @param {Object} rawData - 1688采集器返回的原始数据
 * @returns {Object} 清洗后的数据
 */
function cleanProductData(rawData) {
  if (!rawData || typeof rawData !== 'object') return {};

  const cleaned = {};

  // --- 标题清洗：去除公司名后缀 ---
  cleaned.title = cleanTitle(rawData.title || '');

  // --- 描述清洗：去HTML标签 ---
  cleaned.description = cleanDescription(rawData.description || '');

  // --- 价格清洗：从多来源提取货源价，计算建议售价 ---
  const priceInfo = cleanPrice(rawData.price, rawData.priceRange, rawData.skuList, rawData.skus);
  cleaned.price = priceInfo.price;
  cleaned.sourcePrice = priceInfo.sourcePrice;
  cleaned.oldPrice = priceInfo.oldPrice;

  // --- 重量/尺寸清洗：从多来源提取（兼容attributes数组和对象两种格式） ---
  const dimInfo = cleanDimensions(rawData.weight, rawData.length, rawData.width, rawData.height, rawData.attributes);
  cleaned.weight = dimInfo.weight;
  cleaned.length = dimInfo.length;
  cleaned.width = dimInfo.width;
  cleaned.height = dimInfo.height;

  // --- 图片清洗：去重、URL标准化 ---
  cleaned.images = cleanImages(rawData.images || []);
  cleaned.detailImages = cleanImages(rawData.detailImages || []);

  // --- SKU数据清洗：优先使用已存在的skuAttrs/skus，回退到原始skuList/variants ---
  const skuInfo = cleanSkuData(rawData.skuList || [], rawData.variants || [], rawData.skuAttrs || [], rawData.skus || [], rawData.skuAttrs || []);
  cleaned.skuAttrs = skuInfo.skuAttrs;
  cleaned.skus = skuInfo.skus;

  // --- 类目属性清洗：保留已存在的Ozon属性格式 ---
  cleaned.attributes = cleanAttributes(rawData.attributes || []);

  // 1688产品文本描述经常为空，当无文本描述时，
  // 用商品属性和包装信息生成纯文本描述填入 editDesc
  if (!cleaned.description) {
    cleaned.description = buildDescriptionFromAttrsAndPackage(cleaned.attributes, dimInfo);
  }

  // --- 货源信息 ---
  cleaned.sourceLink = rawData.sourceLink || rawData.originalUrl || rawData.url || '';
  cleaned.sourceName = rawData.sourceName || '1688分销';
  cleaned.sourceId = rawData.sourceId || rawData.productId || '';
  cleaned.sourceLinks = rawData.sourceLinks && rawData.sourceLinks.length > 0
    ? rawData.sourceLinks
    : [{ remark: cleaned.sourceName, url: cleaned.sourceLink }];

  // --- 品牌清洗：从attributes或标题中提取，默认"无品牌" ---
  cleaned.brand = rawData.brand || extractBrandFromAttributes(rawData.attributes || []) || extractBrandFromTitle(rawData.title || '') || '无品牌';

  // --- 合并编号：优先用productId ---
  cleaned.mergeCode = rawData.mergeCode || rawData.productId || '';

  // --- 原始分类 ---
  cleaned.categoryPath = rawData.categoryPath || rawData.category_path || rawData.categoryName || '';
  cleaned.category = rawData.category || (
    cleaned.categoryPath
      ? String(cleaned.categoryPath).split(/[>/、|]+/).map(s => s.trim()).filter(Boolean).pop() || ''
      : ''
  );
  cleaned.categoryId = rawData.categoryId || rawData.sourceCategoryId || '';

  // --- 类目ID（已自动匹配的保留） ---
  cleaned.descriptionCategoryId = rawData.descriptionCategoryId || null;
  cleaned.typeId = rawData.typeId || null;

  return cleaned;
}

/** 标题清洗：去除公司名后缀、多余空格 */
function cleanTitle(title) {
  if (!title) return '';
  return title
    .replace(/[-_—]\s*(官方旗舰店|旗舰店|专营店|专卖店|直销店|工厂店).*$/i, '')
    .replace(/\s*(官方旗舰店|旗舰店|专营店|专卖店|直销店|工厂店)\s*$/i, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 200);
}

/** 描述清洗：去除HTML标签、多余空行 */
function cleanDescription(desc) {
  if (!desc) return '';
  return desc
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/^\s*Описание(?:\s*[:：\-–—]\s*|\s+)(?=\S)/i, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
    .slice(0, 5000);
}

/**
 * 根据货源价计算 Ozon 售价和划线价（可复用，供商品级和SKU级共用）
 *
 * 价格体系说明：
 *   货源价 (sourcePrice) = 1688 采集商品的价格（CNY）
 *   售价   (price)       = Ozon 售价（店铺币种，由货源价 × 汇率 × 利润系数计算）
 *   划线价 (oldPrice)     = Ozon 划线价（由售价 × 划线价系数计算）
 *
 * 计算公式：
 *   售价   = ceil(货源价 × 汇率 × 利润系数 / 10) × 10 - 1  （向上取整到尾数9）
 *   划线价 = ceil(售价 × 划线价系数 / 10) × 10 - 1
 *
 * 汇率和系数从后端 /api/config/pricing 获取：
 *   CNY 店铺：汇率=1（货源价已是 CNY）；RUB 店铺：汇率≈12.5（CNY→RUB）
 *
 * @param {number} sourcePrice - 货源价（CNY）
 * @returns {{price: number, oldPrice: number}} 售价和划线价（均为 0 时表示无法计算）
 */
function calcPriceFromSource(sourcePrice) {
  const src = parseFloat(sourcePrice) || 0;
  if (src <= 0) return { price: 0, oldPrice: 0 };

  const EXCHANGE_RATE = window._pricingConfig?.effectiveExchangeRate || 1.0;
  const PROFIT_MARGIN = window._pricingConfig?.profitMargin || 1.3;
  const OLD_PRICE_RATIO = window._pricingConfig?.oldPriceRatio || 1.2;

  // 售价 = 货源价 × 汇率 × 利润系数，向上取整到尾数9
  const price = Math.ceil(src * EXCHANGE_RATE * PROFIT_MARGIN / 10) * 10 - 1;
  // 划线价 = 售价 × 划线价系数，向上取整到尾数9
  const oldPrice = Math.ceil(price * OLD_PRICE_RATIO / 10) * 10 - 1;

  return { price, oldPrice };
}

/**
 * 价格清洗：从多来源提取货源价，并计算建议售价和划线价
 *
 * 三种价格含义：
 *   货源价 (sourcePrice) = 1688 采集商品的价格（CNY），取所有SKU最低价
 *   售价   (price)       = Ozon 售价（店铺币种），由货源价计算得出
 *   划线价 (oldPrice)     = Ozon 划线价，由售价计算得出
 *
 * @param {string|number} priceStr - price字段
 * @param {string} priceRange - 价格区间
 * @param {Array} skuList - 原始1688 SKU列表
 * @param {Array} skus - 已转换的SKU行（含sourcePrice）
 * @returns {{price, sourcePrice, oldPrice}}
 */
function cleanPrice(priceStr, priceRange, skuList, skus) {
  let sourcePrice = 0;

  // 来源1：已转换的skus数组中的sourcePrice
  if (Array.isArray(skus) && skus.length > 0) {
    const prices = skus
      .map(s => parseFloat(s.sourcePrice || s.price))
      .filter(p => !isNaN(p) && p > 0);
    if (prices.length > 0) {
      sourcePrice = Math.min(...prices);
    }
  }

  // 来源2：原始skuList中的price
  if (!sourcePrice && Array.isArray(skuList) && skuList.length > 0) {
    const prices = skuList
      .map(s => parseFloat(s.price))
      .filter(p => !isNaN(p) && p > 0);
    if (prices.length > 0) {
      sourcePrice = Math.min(...prices);
    }
  }

  // 来源3：price字段
  if (!sourcePrice && priceStr) {
    sourcePrice = parseFloat(String(priceStr).replace(/[^\d.]/g, '')) || 0;
  }

  // 来源4：priceRange
  if (!sourcePrice && priceRange) {
    const match = String(priceRange).match(/([\d.]+)/);
    if (match) sourcePrice = parseFloat(match[1]) || 0;
  }

  // 使用统一函数计算售价和划线价
  const { price, oldPrice } = calcPriceFromSource(sourcePrice);

  return {
    price: price,
    sourcePrice: sourcePrice,
    oldPrice: oldPrice,
  };
}

/**
 * 重量/尺寸清洗：从多来源提取数值
 * @param {string|number} weightStr - 重量字段
 * @param {number} existLength - 已存在的length
 * @param {number} existWidth - 已存在的width
 * @param {number} existHeight - 已存在的height
 * @param {Array|Object} attributes - 属性（数组[{id,value}]或对象{key:value}）
 */
function cleanDimensions(weightStr, existLength, existWidth, existHeight, attributes) {
  let weight = 0, length = 0, width = 0, height = 0;

  // 优先使用已存在的尺寸值
  length = parseFloat(existLength) || 0;
  width = parseFloat(existWidth) || 0;
  height = parseFloat(existHeight) || 0;

  // 从weight字段提取
  if (weightStr !== undefined && weightStr !== null && weightStr !== '') {
    const match = String(weightStr).match(/([\d.]+)\s*(kg|g|克|千克)?/i);
    if (match) {
      const val = parseFloat(match[1]) || 0;
      const unit = (match[2] || 'g').toLowerCase();
      weight = unit === 'kg' || unit === '千克' ? val * 1000 : val;
    }
  }

  // 从attributes中补充提取缺失的尺寸/重量
  // 兼容数组格式 [{id, value}] 和对象格式 {key: value}
  const attrEntries = normalizeAttributes(attributes);
  for (const [key, val] of attrEntries) {
    const keyLower = key.toLowerCase();
    const valStr = String(val);
    const numMatch = valStr.replace(',', '.').match(/([\d.]+)/);
    if (!numMatch) continue;
    const numVal = parseFloat(numMatch[1]) || 0;
    const dimensionText = `${keyLower} ${valStr.toLowerCase()}`;
    const toMillimeters = value => {
      if (/(毫米|mm|мм)/i.test(dimensionText)) return value;
      if (/(厘米|公分|cm|см)/i.test(dimensionText)) return value * 10;
      if (/(^|[^а-я])м([^а-я]|$)|米/i.test(dimensionText)) return value * 1000;
      return value;
    };

    if (keyLower.includes('长') || keyLower.includes('length') || keyLower.includes('длина')) {
      if (!length) length = toMillimeters(numVal);
    } else if (keyLower.includes('宽') || keyLower.includes('width') || keyLower.includes('ширина')) {
      if (!width) width = toMillimeters(numVal);
    } else if (keyLower.includes('高') || keyLower.includes('height') || keyLower.includes('высота')) {
      if (!height) height = toMillimeters(numVal);
    } else if (keyLower.includes('重量') || keyLower.includes('weight') || keyLower.includes('вес')) {
      if (!weight) {
        const unitMatch = valStr.match(/(kg|g|克|千克)/i);
        const unit = (unitMatch?.[1] || 'g').toLowerCase();
        weight = unit === 'kg' || unit === '千克' ? numVal * 1000 : numVal;
      }
    }
  }

  return { weight, length, width, height };
}

/**
 * 将attributes标准化为 [key, value] 数组
 * 兼容 [{id, value}] 数组格式和 {key: value} 对象格式
 */
function normalizeAttributes(attributes) {
  if (!attributes) return [];
  if (Array.isArray(attributes)) {
    // 数组格式：[{id, value, name}] 或 [{id, value}]
    return attributes
      .filter(a => a && (a.value !== undefined && a.value !== null && a.value !== ''))
      .map(a => [a.name || `属性${a.id || ''}`, a.value]);
  }
  if (typeof attributes === 'object') {
    return Object.entries(attributes).filter(([, v]) => v !== undefined && v !== null && v !== '');
  }
  return [];
}

/** 图片清洗：去重、过滤无效URL */
function cleanImages(images) {
  if (!Array.isArray(images)) return [];
  const seen = new Set();
  return images
    .filter(url => {
      if (!url || typeof url !== 'string') return false;
      if (url.startsWith('data:')) return false;
      if (seen.has(url)) return false;
      seen.add(url);
      return true;
    })
    .map(url => url.startsWith('//') ? 'https:' + url : url)
    .slice(0, 15);
}

/**
 * 根据商品属性和包装信息生成纯文本描述
 * 当1688产品文本描述为空时，用类目属性 + 重量尺寸生成描述填入 editDesc。
 * @param {Array} attributes - 清洗后的类目属性数组 [{id, value, name?}] 或 [{name, value}]
 * @param {Object} dimInfo - 重量尺寸信息 {weight, length, width, height}（单位：g、cm）
 * @returns {string} 纯文本描述（无可用信息时返回空字符串）
 */
function buildDescriptionFromAttrsAndPackage(attributes, dimInfo) {
  const lines = [];

  // 商品属性
  const attrEntries = normalizeAttributes(attributes || []);
  if (attrEntries.length > 0) {
    lines.push('商品属性：');
    attrEntries.forEach(([key, value]) => {
      const valStr = String(value).trim();
      if (valStr) lines.push(`- ${key}: ${valStr}`);
    });
  }

  // 包装信息（重量 + 尺寸）
  const pkgLines = [];
  if (dimInfo && dimInfo.weight) {
    pkgLines.push(`- 重量: ${dimInfo.weight}g`);
  }
  if (dimInfo && (dimInfo.length || dimInfo.width || dimInfo.height)) {
    pkgLines.push(`- 尺寸(长x宽x高): ${dimInfo.length || 0}x${dimInfo.width || 0}x${dimInfo.height || 0}cm`);
  }
  if (pkgLines.length > 0) {
    if (lines.length > 0) lines.push('');
    lines.push('包装信息：');
    lines.push(...pkgLines);
  }

  return lines.join('\n');
}

/**
 * SKU数据清洗：优先使用已存在的skuAttrs/skus，回退到原始skuList/variants
 * @param {Array} skuList - 原始1688 SKU列表
 * @param {Array} variants - 原始1688规格定义
 * @param {Array} existSkuAttrs - 已存在的销售属性定义
 * @param {Array} existSkus - 已存在的SKU行
 * @returns {{skuAttrs, skus}}
 */
function cleanSkuData(skuList, variants, existSkuAttrs, existSkus, rawSkuAttrs) {
  // 优先使用已存在的skuAttrs（已经是Ozon格式）
  let skuAttrs = [];
  if (Array.isArray(existSkuAttrs) && existSkuAttrs.length > 0) {
    skuAttrs = existSkuAttrs.map(a => ({ ...a }));
  } else if (Array.isArray(rawSkuAttrs) && rawSkuAttrs.length > 0) {
    // 回退：从1688扫描器输出的 skuAttrs 转换
    rawSkuAttrs.forEach(v => {
      if (!v.name || !Array.isArray(v.values) || v.values.length === 0) return;
      skuAttrs.push({
        name: v.name,
        values: v.values.filter(o => o && String(o).trim()),
        skuType: v.skuType || 'text',
        attrId: null,
        required: false,
        description: '',
      });
    });
  } else if (Array.isArray(variants)) {
    // 回退：从旧版 variants 转换（兼容）
    variants.forEach(v => {
      if (!v.name || !Array.isArray(v.options) || v.options.length === 0) return;
      const nameLower = v.name.toLowerCase();
      let skuType = 'text';
      if (nameLower.includes('颜色') || nameLower.includes('color') || nameLower.includes('цвет')) {
        skuType = 'color';
      } else if (nameLower.includes('数量') || nameLower.includes('件数') || nameLower.includes('number')) {
        skuType = 'number';
      }
      skuAttrs.push({
        name: v.name,
        values: v.options.filter(o => o && String(o).trim()),
        skuType: skuType,
        attrId: null,
        required: false,
        description: '',
      });
    });
  }

  // 优先使用已存在的skus（已经包含combo、weight、dimensions等）
  let skus = [];
  if (Array.isArray(existSkus) && existSkus.length > 0) {
    skus = existSkus.map(s => {
      const cloned = { ...s };
      // 补全缺失的售价/划线价：若已有货源价但售价为空，则自动计算
      const src = parseFloat(cloned.sourcePrice) || 0;
      if (src > 0 && (!cloned.price || parseFloat(cloned.price) === 0)) {
        const { price, oldPrice } = calcPriceFromSource(src);
        cloned.price = price;
        if (!cloned.oldPrice || parseFloat(cloned.oldPrice) === 0) {
          cloned.oldPrice = oldPrice;
        }
      }
      return cloned;
    });
  } else if (Array.isArray(skuList)) {
    // 回退：从原始1688 skuList 转换
    skuList.forEach(sku => {
      if (!sku) return;
      // 货源价 = 1688 采集价格（CNY）
      const sourcePrice = parseFloat(sku.price) || 0;
      const stock = parseInt(sku.stock) || 0;
      const combo = {};

      // 优先使用 sku 上的 color/size 字段构建 combo
      if (sku.color || sku.size) {
        if (sku.color) {
          const colorAttr = skuAttrs.find(a => a.skuType === 'color');
          if (colorAttr) combo[colorAttr.name] = sku.color;
        }
        if (sku.size) {
          const sizeAttr = skuAttrs.find(a => a.skuType !== 'color' && a.skuType !== 'number');
          if (sizeAttr) combo[sizeAttr.name] = sku.size;
        }
      } else if (sku.name) {
        // 回退：从 name 字段按空格拆分
        const parts = sku.name.split(/\s+/);
        skuAttrs.forEach((attr, idx) => {
          if (parts[idx]) combo[attr.name] = parts[idx];
        });
      }

      // 售价和划线价由货源价自动计算
      const { price, oldPrice } = calcPriceFromSource(sourcePrice);

      skus.push({
        title: sku.name || sku.spec || '',
        combo: combo,
        sourcePrice: sourcePrice,
        price: price,
        oldPrice: oldPrice,
        stock: stock,
        weight: 0,
        length: 0,
        width: 0,
        height: 0,
        skuCode: sku.skuId || '',
      });
    });
  }

  return { skuAttrs, skus };
}

/**
 * 类目属性清洗：保留已存在的Ozon属性格式
 * 兼容数组格式 [{id, value}] 和对象格式 {key: value}
 * @param {Array|Object} attributes - 属性数据
 * @returns {Array} 统一为数组格式 [{id, value}] 或 [{name, value}]
 */
function cleanAttributes(attributes) {
  if (!attributes) return [];
  if (Array.isArray(attributes)) {
    // 已是数组格式（Ozon风格），直接过滤无效项
    return attributes.filter(a => a && a.value !== undefined && a.value !== null && String(a.value).trim() !== '');
  }
  if (typeof attributes === 'object') {
    // 对象格式（旧1688风格），转换为数组
    const result = [];
    for (const [key, value] of Object.entries(attributes)) {
      if (!key || !value || String(value).trim() === '') continue;
      result.push({ name: key, value: String(value).trim() });
    }
    return result;
  }
  return [];
}

/**
 * 从attributes中提取品牌
 * 兼容数组格式 [{id, value, name}] 和对象格式 {key: value}
 */
function extractBrandFromAttributes(attributes) {
  if (!attributes) return '';
  const entries = normalizeAttributes(attributes);
  for (const [key, value] of entries) {
    if (key.toLowerCase().includes('品牌') || key.toLowerCase().includes('brand')) {
      return String(value).trim();
    }
  }
  return '';
}

/**
 * 从标题中提取品牌（常见品牌名模式）
 */
function extractBrandFromTitle(title) {
  if (!title) return '';
  // 匹配常见品牌模式：标题开头的英文品牌名
  const match = title.match(/^([A-Za-z]{2,20})\s/);
  if (match && !['TPR', 'PVC', 'LED', 'USB', 'PC', 'ABS'].includes(match[1].toUpperCase())) {
    return match[1];
  }
  return '';
}

// ============================================================================
// 3. 自动填充编辑表单
// ============================================================================

/**
 * 将清洗后的数据自动填充到编辑表单
 * @param {Object} product - 商品数据（已清洗）
 * @param {Object} cleaned - 清洗后的数据（可选，用于覆盖）
 */
function autoFillEditForm(product, cleaned) {
  const data = cleaned || product;

  // 基本信息（描述和合并编号字段已移除，值通过类目属性渲染时从 window._editingProduct 获取）
  setFieldValue('editTitle', data.title);

  // 重量尺寸：空值显示为空字符串（而非 0），便于用户区分"未填写"与"0"
  setFieldValue('editWeight', data.weight || '');
  setFieldValue('editLength', data.length || '');
  setFieldValue('editWidth', data.width || '');
  setFieldValue('editHeight', data.height || '');

  // VAT（默认豁免）
  setRadioValue('vat', data.vatRate || '');

  // 包裹模式（默认按SKU）
  setRadioValue('packageMode', data.packageMode || 'sku');

  // 积分评价（默认关闭）
  const pointsCheckbox = document.getElementById('editPointsForReviews');
  if (pointsCheckbox) pointsCheckbox.checked = (data.pointsForReviews === 'enable');

  // 货源链接
  if (data.sourceLinks && Array.isArray(data.sourceLinks)) {
    fillSourceLinks(data.sourceLinks);
  }

  // 更新标题字数计数
  updateTitleCount();
}

/** 设置输入框值 */
function setFieldValue(id, value) {
  const el = document.getElementById(id);
  if (el) el.value = value ?? '';
}

/** 设置单选按钮值 */
function setRadioValue(name, value) {
  const radio = document.querySelector(`input[name="${name}"][value="${value}"]`);
  if (!radio) return;
  radio.checked = true;
  // 同步同组所有 radio 的 is-checked 状态（清除旧的，设置新的）
  const group = radio.closest('.jx-radio-group');
  if (group) {
    group.querySelectorAll('.jx-radio').forEach(label => {
      const input = label.querySelector('.jx-radio__original');
      const isChecked = !!(input && input.checked);
      label.classList.toggle('is-checked', isChecked);
      label.querySelector('.jx-radio__input')?.classList.toggle('is-checked', isChecked);
    });
  }
  // 触发 onchange 以同步关联 UI（如包裹模式切换 dimsGrid 显示/隐藏、VAT 单选样式）
  radio.dispatchEvent(new Event('change', { bubbles: true }));
}

/** 填充货源链接列表 */
function fillSourceLinks(links) {
  const list = document.getElementById('sourceLinksList');
  if (!list) return;
  list.innerHTML = '';
  links.forEach((link, idx) => {
    addSourceLinkRow(link.remark || '', link.url || '');
  });
}

/** 更新标题字数计数 */
function updateTitleCount() {
  const titleInput = document.getElementById('editTitle');
  const countEl = document.getElementById('titleCount');
  if (titleInput && countEl) {
    countEl.textContent = `${titleInput.value.length} / 200`;
  }
}

// ============================================================================
// 4. Ozon API 打包（编辑表单 → Ozon API 请求体）
// ============================================================================

// "型号名称"类目属性的关键词（中/俄/英），用于将 mergeCode 注入对应属性
const MODEL_ATTR_KEYWORDS = ['型号', 'Название модели', 'Артикул производителя', '厂商型号', 'model_name', 'Model Name'];

/**
 * 将"合并编号"(mergeCode) 注入到"型号名称"类目属性中
 * - 若找到型号属性且其 value 为空 → 填充 mergeCode
 * - 若型号属性已有值 → 不覆盖
 * - 若未找到型号属性 → 不新增（需后端 prefill_required_attributes 保证 attribute_id 正确）
 * @param {Array} attrs - 商品属性列表
 * @param {string} mergeCode - 合并编号
 * @returns {Array} 处理后的属性列表
 */
function injectMergeCodeToModelAttr(attrs, mergeCode) {
  if (!mergeCode || !Array.isArray(attrs)) return attrs;
  return attrs.map(attr => {
    if (!attr || typeof attr !== 'object') return attr;
    const attrName = String(attr.name || '') + String(attr.name_zh || '');
    const isModelAttr = MODEL_ATTR_KEYWORDS.some(kw => attrName.toLowerCase().includes(kw.toLowerCase()));
    if (isModelAttr && !attr.value) {
      return { ...attr, value: mergeCode };
    }
    return attr;
  });
}

/**
 * 将编辑表单数据打包为Ozon API创建商品的请求体
 * @param {Object} product - 保存后的商品数据
 * @returns {Object} Ozon API item 格式
 */
function buildOzonPayload(product) {
  // 产品级 offer_id（货号）：使用第一个 SKU 的平台SKU（skuCode）
  const firstSkuCode = (Array.isArray(product.skus) && product.skus[0] &&
    (product.skus[0].skuCode || product.skus[0].offerId)) || '';
  // 将"合并编号"(mergeCode) 注入"型号名称"类目属性
  const productAttrs = injectMergeCodeToModelAttr(product.attributes || [], product.mergeCode || '');

  const item = {
    // 必填字段
    name: product.title || '',
    offer_id: firstSkuCode || product.id || '',
    description_category_id: product.descriptionCategoryId || 0,
    type_id: product.typeId || 0,
    price: String(product.price || 0),
    vat: mapVatRate(product.vatRate),
    weight: Number(product.weight) || 0,
    weight_unit: 'g',
    dimension_unit: 'mm',
    width: Number(product.width) || 0,
    height: Number(product.height) || 0,
    depth: Number(product.length) || 0,
    primary_image: (product.images && product.images[0]) || '',
    images: product.images || [],
    attributes: buildOzonAttributes(productAttrs),
  };

  // 选填字段（仅有值时添加）
  if (product.oldPrice) item.old_price = String(product.oldPrice);
  // 商品描述（纯文本）
  if (product.description) {
    item.description = product.description;
  }
  if (product.barcode) item.barcode = product.barcode;
  // 品牌默认"无品牌"，Ozon 部分类目要求必填
  item.vendor = product.brand || '无品牌';
  if (product.videos && product.videos.length > 0) item.videos = product.videos;
  if (product.pointsForReviews === 'enable') item.points_for_reviews = 10;

  // SKU数据（多规格商品）
  if (product.skus && product.skus.length > 0) {
    item.sources = buildOzonSkus(product.skus, product.skuAttrs || []);
  }

  return item;
}

/** VAT税率映射 */
function mapVatRate(vatRate) {
  const VAT_MAP = { '': '0', '0': '0', '10': '0.1', '20': '0.2' };
  return VAT_MAP[vatRate] || '0';
}

/** 构建Ozon attributes 数组 */
function buildOzonAttributes(attrs) {
  if (!Array.isArray(attrs)) return [];
  const result = [];
  attrs.forEach(attr => {
    if (!attr.id) return;
    // 多选字典值：收集所有 dictionary_value_id 为 values 数组
    if (Array.isArray(attr.dictionary_value_ids) && attr.dictionary_value_ids.length > 0) {
      result.push({
        id: attr.id,
        values: attr.dictionary_value_ids.map(vid => ({ dictionary_value_id: vid }))
      });
    } else if (attr.dictionary_value_id) {
      result.push({ id: attr.id, values: [{ dictionary_value_id: attr.dictionary_value_id }] });
    } else if (attr.value !== undefined && attr.value !== null && String(attr.value).trim()) {
      result.push({ id: attr.id, values: [{ value: String(attr.value) }] });
    }
  });
  return result;
}

/** 构建Ozon SKU sources 数组 */
function buildOzonSkus(skus, skuAttrs) {
  if (!Array.isArray(skus)) return [];
  return skus.map(sku => {
    const source = {
      offer_id: sku.skuCode || sku.title || '',
      price: String(sku.price || 0),
      stock: Number(sku.stock) || 0,
    };

    if (sku.oldPrice) source.old_price = String(sku.oldPrice);
    if (sku.barcode) source.barcode = sku.barcode;

    // SKU级别的重量和尺寸
    if (sku.weight) {
      source.weight = Number(sku.weight);
      source.weight_unit = 'g';
    }
    if (sku.length || sku.width || sku.height) {
      source.dimension_unit = 'mm';
      if (sku.length) source.depth = Number(sku.length);
      if (sku.width) source.width = Number(sku.width);
      if (sku.height) source.height = Number(sku.height);
    }

    // SKU属性（颜色、尺码等）
    if (sku.combo && Object.keys(sku.combo).length > 0) {
      source.attributes = [];
      for (const [attrName, attrValue] of Object.entries(sku.combo)) {
        const attrDef = skuAttrs.find(a => a.name === attrName);
        if (attrDef && attrDef.attrId) {
          if ((attrDef.skuType === 'color' || attrDef.skuType === 'select') && attrDef.dictionaryId) {
            // 字典类销售属性（颜色/尺码等）：优先使用 valueIds 查找 dictionary_value_id
            let dictVids = [];
            if (Array.isArray(attrDef.valueIds) && Array.isArray(attrDef.values)) {
              const valIdx = attrDef.values.indexOf(attrValue);
              if (valIdx >= 0) {
                const stored = attrDef.valueIds[valIdx];
                dictVids = (Array.isArray(stored) ? stored : [stored]).filter(Boolean);
              }
            }
            // 颜色属性回退：从颜色字典缓存中查找
            if (dictVids.length === 0 && attrDef.skuType === 'color' && window._colorDictCache && window._colorDictCache[`${attrDef.dictionaryId}`]) {
              const dictValues = window._colorDictCache[`${attrDef.dictionaryId}`];
              const colorValues = String(attrValue || '').split(/[,，;；]+/).map(v => v.trim()).filter(Boolean);
              dictVids = colorValues.map(colorValue => {
                const match = dictValues.find(v => v.value === colorValue || v.value_zh === colorValue || v.value_ru === colorValue);
                return match?.value_id || null;
              }).filter(Boolean);
            }
            if (dictVids.length > 0) {
              source.attributes.push({
                id: attrDef.attrId,
                values: dictVids.map(dictionary_value_id => ({ dictionary_value_id }))
              });
            } else {
              // 无 value_id 时作为文本值提交
              source.attributes.push({
                id: attrDef.attrId,
                values: [{ value: attrValue }]
              });
            }
          } else {
            // 文本属性（包括 SKU信息属性：件数/颜色名称/长度/重量等）
            source.attributes.push({
              id: attrDef.attrId,
              values: [{ value: attrValue }]
            });
          }
        }
      }
    }

    return source;
  });
}

// ============================================================================
// 5. 发布前校验
// ============================================================================

/**
 * 校验商品数据是否满足Ozon发布要求
 * @param {Object} product - 商品数据
 * @returns {{ valid: boolean, errors: string[] }}
 */
function validateForPublish(product) {
  const errors = [];

  // 必填字段校验
  if (!product.title || product.title.trim().length < 2) {
    errors.push('产品标题不能为空且至少2个字符');
  }
  if (!product.descriptionCategoryId || !product.typeId) {
    errors.push('请选择Ozon类目');
  }
  if (!product.weight || product.weight <= 0) {
    errors.push('包裹重量必须大于0');
  }
  if (!product.images || product.images.length === 0) {
    errors.push('至少需要1张产品图片');
  }

  // SKU校验
  if (product.skus && product.skus.length > 0) {
    const hasPrice = product.skus.some(s => s.price > 0);
    if (!hasPrice) {
      errors.push('至少需要为1个SKU填写售价');
    }
  } else if (!product.price || product.price <= 0) {
    errors.push('商品售价必须大于0');
  }

  // 必填属性校验
  if (window._currentAttributes) {
    const requiredAttrs = window._currentAttributes.filter(a => a.required);
    const filledAttrIds = (product.attributes || []).map(a => a.id);
    requiredAttrs.forEach(attr => {
      if (!filledAttrIds.includes(attr.id)) {
        errors.push(`必填属性"${attr.name}"未填写`);
      }
    });
  }

  return { valid: errors.length === 0, errors };
}

// 导出（如果支持模块化）
if (typeof window !== 'undefined') {
  window.ProductMapping = {
    FIELD_MAPPING,
    cleanProductData,
    autoFillEditForm,
    buildOzonPayload,
    validateForPublish,
  };
}
