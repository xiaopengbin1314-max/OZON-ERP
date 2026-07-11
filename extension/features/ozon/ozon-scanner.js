/**
 * GeekOzon 扩展 - Ozon 商品页采集器
 * 继承 ScannerBase，从 Ozon 商品详情页 DOM 提取商品数据
 * 暴露：
 *   - window.GeekOzon.features.OzonScanner（class）
 *   - window.__geekOzonScan()           同步采集（仅 DOM）
 *   - window.__geekOzonScanAsync()     异步采集（含等待加载）
 *   - window.__geekOzonOzonScannerLoaded 防重复注入标志
 */
;(function () {
  'use strict';

  const G = window.GeekOzon;
  if (!G || G.isLoaded('ozon-scanner')) return;

  const ScannerBase = G.core.ScannerBase;
  const DomUtils = G.core.DomUtils;

  /** DOM 选择器常量 */
  const SELECTORS = {
    TITLE: 'h1',                                  // 标题
    PRICE: '[data-widget="webPrice"]',            // 价格区
    // 主图相册：Ozon 多次改版，提供多个兜底选择器
    GALLERY: [
      '[data-widget="webGallery"]',
      '[data-widget="webGallery1"]',
      '[data-widget*="allery"]',
      '.gallery',
      '[class*="gallery"]',
      '[class*="Gallery"]',
      '[class*="product-gallery"]',
      '[class*="sku-gallery"]',
    ],
    GALLERY_IMG: '[data-widget="webGallery"] img',  // 保留兼容（extractImages 已改用 GALLERY 数组）
    // 面包屑（类目）：Ozon 多次改版，提供多个兜底选择器
    BREADCRUMB: [
      '[data-widget="webBreadcrumb"]',
      'nav[aria-label="breadcrumb"]',
      'nav[aria-label="Breadcrumb"]',
      '.breadcrumb',
      '[class*="breadcrumb"]',
      '[class*="Breadcrumb"]',
      '[data-widget*="readcrumb"]',
      // Ozon PDP 面包屑 ol（混淆类名前缀 e3c_7 / e3c_*）
      'ol[class*="e3c"]',
      'ol[class*="e4c"]',
    ],
    SKU_LIST: '[data-widget="webSKU"]',            // SKU 列表
    BRAND: '[data-widget="webBrand"]',             // 品牌
    // 特征区（Характеристики）：可能多种 widget 名
    CHARACTERISTICS: [
      '[data-widget="webCharacteristics"]',
      '[data-widget="webProductAttributes"]',
      '[data-widget="webSpecs"]',
      '[data-widget="webProductSpecs"]',
      '.characteristics-full',
      '[class*="characteristics"]:not([class*="characteristics-"])',
      // Ozon PDP 页面特征区容器（dl/dt/dd 结构）
      '.pdp_i5a',
      '[data-widget="webCharacteristicsList"]',
    ],
    // 描述区（注意：webRichContent 已由 extractRichContent() 单独提取 JSON，不在此提取纯文本）
    DESCRIPTION: [
      '[data-widget="webProductDescription"]',
      '[data-widget="webDescription"]',
      '.product-description',
      '[class*="product-description"]',
      '[class*="description-text"]',
    ],
  };

  /**
   * 从一组选择器中取第一个匹配到的面包屑元素
   * SELECTORS.BREADCRUMB 是数组，逐个尝试直到命中
   * @returns {Element|null}
   */
  function findBreadcrumb() {
    const list = SELECTORS.BREADCRUMB;
    if (Array.isArray(list)) {
      for (let i = 0; i < list.length; i++) {
        const el = document.querySelector(list[i]);
        if (el) return el;
      }
    } else {
      const el = document.querySelector(list);
      if (el) return el;
    }
    // 结构化兜底：查找包含 2+ 个 /category/ 链接的 ol/ul/nav（面包屑特征）
    const containers = document.querySelectorAll('ol, ul, nav');
    for (let i = 0; i < containers.length; i++) {
      const catLinks = containers[i].querySelectorAll('a[href*="/category/"]');
      if (catLinks.length >= 2) return containers[i];
    }
    return null;
  }

  /**
   * 解析 Ozon 价格文本为数字
   * 处理 "1 299 ₽" / "1290.50 ₽" / "1 299,50 ₽" 等格式
   */
  function parsePrice(text) {
    if (text == null) return 0;
    if (typeof text === 'number') return text;
    // 去除空白 + 货币符号/文字，但保留小数点
    // 注意：不能用 [₽rubед.] 字符类，因为 . 是字面量句点，会删除小数点
    const s = String(text)
      .replace(/\s+/g, '')            // 去除空白
      .replace(/₽/g, '')              // 去除卢布符号
      .replace(/руб\.?/gi, '')        // 去除 "руб" 或 "руб."
      .replace(/ед\.?/gi, '')         // 去除 "ед" 或 "ед."
      .replace(/\$/g, '')              // 去除美元符号
      .replace(/€/g, '')              // 去除欧元符号
      .replace(/₸/g, '')              // 去除坚戈符号
      .replace(/Br/gi, '')            // 去除白俄卢布符号
      .replace(/¥/g, '')              // 去除人民币符号
      .replace(',', '.');            // 逗号 → 句点（俄式小数分隔符）
    const m = s.match(/-?\d+(?:\.\d+)?/);
    return m ? parseFloat(m[0]) : 0;
  }

  /**
   * 货币符号 → 代码映射（对齐毛子 ERP T 对象）
   * T={CNY:"¥",RUB:"₽",USD:"$",EUR:"€",BYN:"Br",KZT:"₸"}
   */
  const SYMBOL_TO_CODE = {
    '₽': 'RUB',
    '¥': 'CNY',
    '$': 'USD',
    '€': 'EUR',
    'Br': 'BYN',
    '₸': 'KZT',
  };

  /**
   * 从价格字符串检测货币代码（对齐毛子 ERP ee() 函数）
   * 从价格字符串末尾提取非数字字符，在货币符号映射表中反查代码
   * @param {string} priceStr - 价格字符串（如 "1 299 ₽" / "¥126.85"）
   * @returns {string} 货币代码（如 "RUB" / "CNY"），无法识别时返回空字符串
   */
  function detectCurrencyFromPrice(priceStr) {
    if (!priceStr || typeof priceStr !== 'string') return '';
    // 对齐毛子 ee() 正则：提取末尾非数字、非空白、非逗号句点字符
    const m = priceStr.match(/[^\d\s,.]+$/);
    if (!m) return '';
    const sym = m[0].trim();
    if (!sym || sym.length > 4) return '';
    return SYMBOL_TO_CODE[sym] || '';
  }

  /**
   * 安全解析 widgetStates 中的 widget JSON
   */
  function parseWidget(json, keyPrefix) {
    if (!json || !json.widgetStates) return null;
    const key = Object.keys(json.widgetStates).find(function (k) {
      return k.indexOf(keyPrefix) === 0;
    });
    if (!key) return null;
    const raw = json.widgetStates[key];
    try { return typeof raw === 'string' ? JSON.parse(raw) : raw; }
    catch (_) { return null; }
  }

  /**
   * 去除 Ozon CDN 图片 URL 中的尺寸后缀（/wc500 等）
   */
  function stripImageSize(url) {
    return String(url || '').replace(/\/wc\d+/g, '');
  }

  /**
   * 解析重量文本为克数（整数）
   * 支持 "250 г" / "0.25 кг" / "250g" / "0.25 kg" / "250 грамм"
   * 若值中无单位，从 fieldName 中提取单位（如 "Вес, кг" → kg）
   */
  function parseWeightValue(text, fieldName) {
    if (text == null) return 0;
    const s = String(text).toLowerCase().replace(',', '.').trim();
    let m = s.match(/(\d+(?:\.\d+)?)\s*(кг|kg|г|g|гр|gram)/);
    let num = 0;
    let unit = '';
    if (m) {
      num = parseFloat(m[1]);
      unit = m[2];
    } else {
      // 值中无单位，尝试从字段名提取
      const fn = String(fieldName || '').toLowerCase();
      const m2 = fn.match(/(кг|kg|г|g|гр|gram)/);
      const m3 = s.match(/(\d+(?:\.\d+)?)/);
      if (!m2 || !m3) return 0;
      num = parseFloat(m3[1]);
      unit = m2[1];
    }
    if (unit === 'кг' || unit === 'kg') return Math.round(num * 1000);
    return Math.round(num);
  }

  /**
   * 解析尺寸文本为毫米数（整数）
   * 支持 "42 см" / "420 мм" / "0.42 м" / "42 cm"
   * 若值中无单位，从 fieldName 中提取单位（如 "Ширина, см" → cm）
   */
  function parseDimensionValue(text, fieldName) {
    if (text == null) return 0;
    const s = String(text).toLowerCase().replace(',', '.').trim();
    let m = s.match(/(\d+(?:\.\d+)?)\s*(см|cm|мм|mm|м(?![а-я]))/);
    let num = 0;
    let unit = '';
    if (m) {
      num = parseFloat(m[1]);
      unit = m[2];
    } else {
      // 值中无单位，尝试从字段名提取
      const fn = String(fieldName || '').toLowerCase();
      const m2 = fn.match(/(см|cm|мм|mm|м(?![а-я]))/);
      const m3 = s.match(/(\d+(?:\.\d+)?)/);
      if (!m2 || !m3) return 0;
      num = parseFloat(m3[1]);
      unit = m2[1];
    }
    if (unit === 'м' || unit === 'm') return Math.round(num * 1000);
    if (unit === 'мм' || unit === 'mm') return Math.round(num);
    return Math.round(num * 10);  // см → mm
  }

  /**
   * 解析尺寸三元组文本（如 "15х46х10.6" / "15x46x10.6" / "15*46*10.6"）
   * 返回 {length, width, height} 毫米数，或 null
   */
  function parseDimensionTriple(text, fieldName) {
    if (!text) return null;
    const s = String(text).toLowerCase().replace(',', '.').trim();
    // 匹配 "15х46х10.6" / "15 x 46 x 10.6" / "15*46*10.6"
    const m = s.match(/(\d+(?:\.\d+)?)\s*[хx\*]\s*(\d+(?:\.\d+)?)\s*[хx\*]\s*(\d+(?:\.\d+)?)/);
    if (!m) return null;
    // 从字段名提取单位（如 "Размер (ДхШхВ), см" → см）
    const fn = String(fieldName || '').toLowerCase();
    const unitMatch = fn.match(/(см|cm|мм|mm|м(?![а-я]))/);
    const unit = unitMatch ? unitMatch[1] : 'см';
    const factor = (unit === 'м' || unit === 'm') ? 1000
      : (unit === 'мм' || unit === 'mm') ? 1
      : 10; // см → mm
    return {
      length: Math.round(parseFloat(m[1]) * factor),
      width: Math.round(parseFloat(m[2]) * factor),
      height: Math.round(parseFloat(m[3]) * factor),
    };
  }

  /**
   * 从特征项名称判断是否匹配目标字段
   * 支持中俄英多语言模糊匹配
   */
  function matchCharField(name, keywords) {
    const n = String(name || '').toLowerCase();
    return keywords.some(function (k) { return n.indexOf(k) >= 0; });
  }

  /**
   * Ozon 商品页采集器
   */
  class OzonScanner extends ScannerBase {
    constructor() {
      super();
    }

    /** 平台标识 */
    getPlatform() {
      return 'ozon';
    }

    /** 从 URL 提取商品 SKU（Ozon 商品 ID） */
    getSkuFromUrl() {
      return DomUtils.getOzonSkuFromUrl();
    }

    /**
     * 从 URL 提取 productId（纯数字部分）
     * 例：/product/televizor-led-42-12345-678/ -> '12345'
     */
    getProductIdFromUrl() {
      const sku = this.getSkuFromUrl();
      if (!sku) return '';
      const m = String(sku).match(/(\d+)$/);
      return m ? m[1] : '';
    }

    /**
     * 从 DOM 提取标题
     */
    extractTitle() {
      const el = document.querySelector(SELECTORS.TITLE);
      if (!el) return '';
      return (el.innerText || el.textContent || '').trim();
    }

    /**
     * 从 DOM 提取当前售价文本（不含划线价）
     * Ozon webPrice widget 通常含两部分：
     *   1. 划线价（原价/折扣前） - DOM 中靠前，带 text-decoration: line-through
     *   2. 当前售价（折扣后）   - DOM 中靠后，粗体大字
     * 取最后一个金额作为当前售价，对齐毛子 ERP 行为
     */
    extractPrice() {
      const el = document.querySelector(SELECTORS.PRICE);
      if (!el) return '';
      const text = (el.innerText || el.textContent || '').trim();
      // 匹配所有"数字(空格/逗号/句点)*货币符号"片段，取最后一个
      // 支持 "1 299 ₽" / "1290.50 ₽" / "1 299,50 ₽" / "1290 ₽" 等格式
      const matches = text.match(/[\d][\d\s,.]*\s*[₽$€¥₸]?/g);
      if (matches && matches.length) {
        // 取最后一个（通常是当前售价，划线价在前）
        return matches[matches.length - 1].replace(/\s+/g, '').trim();
      }
      // 兜底：取第一个数字片段
      const m = text.match(/[\d\s,.]+/);
      return m ? m[0].replace(/\s+/g, '').trim() : text;
    }

    /**
     * 从相册提取主图与全部图片 URL
     *
     * 关键修复：Ozon 相册 <img> 的 src 是缩略图（wc50 = 50px），
     * 必须用 stripImageSize() 去除尺寸后缀得到原图 URL，否则主图是 50px 模糊缩略图。
     * 去尺寸后按原图 URL 去重（wc50/X.jpg 和 wc1000/X.jpg 是同一张图）。
     */
    extractImages() {
      // 逐个尝试 GALLERY 选择器数组，命中第一个即用
      const list = SELECTORS.GALLERY;
      let galleryEl = null;
      if (Array.isArray(list)) {
        for (let i = 0; i < list.length; i++) {
          galleryEl = document.querySelector(list[i]);
          if (galleryEl) break;
        }
      } else {
        galleryEl = document.querySelector(list);
      }
      const imgs = galleryEl ? galleryEl.querySelectorAll('img') : [];
      const urls = [];
      const seen = Object.create(null);
      for (let i = 0; i < imgs.length; i++) {
        const rawSrc = imgs[i].src || imgs[i].getAttribute('data-src') || imgs[i].getAttribute('data-srcset') || '';
        if (!rawSrc) continue;
        // 去除尺寸后缀得到原图 URL（wc50/X.jpg → X.jpg）
        const src = stripImageSize(rawSrc);
        if (!src || seen[src]) continue;
        seen[src] = 1;
        urls.push(src);
      }
      return {
        mainImage: urls[0] || '',
        images: urls,
      };
    }

    /**
     * 提取类目（面包屑最后一级）
     * 兜底链：面包屑 → JSON-LD → 空字符串
     *
     * 注意：移除了 meta description 兜底，因为 Ozon meta 格式为
     * "{title} — купить на Ozon: ..."，正则会误提取"купить/покупайте"等动词。
     */
    extractCategory() {
      // 俄文购买动词黑名单（不应作为类目名）
      const BUY_VERBS = new Set([
        'купить', 'покупайте', 'заказывайте', 'заказать', 'продавать',
        'продается', 'продаются', 'приобрести', 'оформить',
        'ozon', 'ru', 'com', 'домой', 'home',
      ]);
      // 筛选标签黑名单（URL 子路径标签，非实际类目）
      // Ozon 面包屑最后一级可能是 popular/new/hit/sale 等筛选标签
      const FILTER_TAGS = new Set([
        'popular', 'популярное', 'популярные', 'популярная',
        'new', 'новинки', 'новое', 'новые',
        'hit', 'хиты', 'хит', 'бестселлеры', 'бестселлер',
        'sale', 'распродажа', 'скидки', 'акция', 'акции',
        'top', 'топ', 'топ-продаж',
        'recommend', 'рекомендуем', 'рекомендуемые',
      ]);
      // 判断链接 href 是否为筛选子路径（如 /category/xxx-123/popular-456/）
      // 筛选 URL 在类目 ID 后还有额外路径段，实际类目 URL 为 /category/{slug}-{id}/
      const isFilterLink = function (href) {
        if (!href) return false;
        // 匹配 /category/...-{id}/{filter}-{filterId}/ 形式
        return /\/category\/[^\/?#]+-\d+\/[^\/?#]+-\d+/.test(href);
      };

      // 主：从面包屑提取最后一级非动词、非筛选标签文本
      const bc = findBreadcrumb();
      if (bc) {
        // 优先取 <a> 元素（带 href），便于判断是否筛选链接
        const anchors = bc.querySelectorAll('a[href]');
        let last = '';
        for (let i = 0; i < anchors.length; i++) {
          const href = anchors[i].getAttribute('href') || '';
          if (isFilterLink(href)) continue;  // 跳过筛选链接
          const t = (anchors[i].innerText || '').trim();
          if (t && !BUY_VERBS.has(t.toLowerCase()) && !FILTER_TAGS.has(t.toLowerCase())) last = t;
        }
        if (last) return last;

        // 兜底：span/itemprop（无 href，无法判断筛选，仅用文本黑名单过滤）
        const spans = bc.querySelectorAll('span, [itemprop="name"]');
        for (let i = 0; i < spans.length; i++) {
          const t = (spans[i].innerText || '').trim();
          if (t && !BUY_VERBS.has(t.toLowerCase()) && !FILTER_TAGS.has(t.toLowerCase())) last = t;
        }
        if (last) return last;
      }

      // 兜底1: 从 JSON-LD 提取 category 字段
      try {
        const ldScripts = document.querySelectorAll('script[type="application/ld+json"]');
        for (let i = 0; i < ldScripts.length; i++) {
          const txt = ldScripts[i].textContent || '';
          const m = txt.match(/"category"\s*:\s*"([^"]+)"/);
          if (m) {
            const cat = m[1].trim();
            if (cat && !BUY_VERBS.has(cat.toLowerCase())) return cat;
          }
        }
      } catch (_) {}

      // 兜底2: 从页面 <script> JSON 中提取 type_name 字段
      // Ozon 商品页 __NEXT_DATA__ / widget JSON 中常含 type_name（L3 类目名）
      try {
        const scripts = document.querySelectorAll('script[type="application/json"], script:not([src])');
        for (let i = 0; i < scripts.length; i++) {
          const txt = scripts[i].textContent || '';
          if (txt.indexOf('type_name') < 0 && txt.indexOf('typeName') < 0) continue;
          // 匹配 "type_name":"XXX" 或 "typeName":"XXX"
          const m = txt.match(/"type[_-]?[Nn]ame"\s*:\s*"([^"]{2,80})"/);
          if (m) {
            const cat = m[1].trim();
            if (cat && !BUY_VERBS.has(cat.toLowerCase())) return cat;
          }
        }
      } catch (_) {}

      // 兜底3: 从面包屑链接的 URL slug 反推类目名
      // URL 形如 /category/smartfony-15502/，slug "smartfony" 可作俄文类目名
      try {
        const bc2 = findBreadcrumb();
        if (bc2) {
          const links = bc2.querySelectorAll('a[href]');
          for (let i = links.length - 1; i >= 0; i--) {
            const href = links[i].getAttribute('href') || '';
            const m = href.match(/\/category\/([a-z0-9-]+)-\d{3,}/i);
            if (m) {
              // slug 形如 "smartfony"，转成首字母大写作类目名
              const slug = m[1].replace(/-/g, ' ');
              if (slug) {
                return slug.charAt(0).toUpperCase() + slug.slice(1);
              }
            }
          }
        }
      } catch (_) {}

      return '';
    }

    /**
     * 从面包屑最后一级链接 URL 提取 Ozon description_category_id
     * Ozon 类目 URL 形如 /category/smartfony-15502/ -> "15502"
     * 兜底链：面包屑链接 → 页面 script JSON → JSON-LD → 空字符串
     */
    extractDescriptionCategoryId() {
      // 主：从面包屑链接提取
      // 跳过筛选子路径链接（如 /category/xxx-123/popular-456/），只取实际类目链接
      const bc = findBreadcrumb();
      if (bc) {
        const links = bc.querySelectorAll('a[href]');
        for (let i = links.length - 1; i >= 0; i--) {
          const href = links[i].getAttribute('href') || '';
          if (!href) continue;
          // 跳过筛选链接：URL 在类目 ID 后还有额外路径段（/category/...-{id}/{filter}-{filterId}/）
          if (/\/category\/[^\/?#]+-\d+\/[^\/?#]+-\d+/.test(href)) continue;
          const m = href.match(/\/category\/[^\/?#]*-(\d{3,})\/?(?:[?#]|$)/i);
          if (m) return m[1];
        }
      }

      // 兜底1: 从页面 <script> JSON 中提取 descriptionCategoryId（仅精确字段名，不匹配泛化的 categoryId）
      // 注意：不匹配泛化的 "categoryId"，因为页面 JSON 中存在多种不同的 categoryId 字段
      // （如导航 ID、搜索 facet ID），会导致提取到无效 ID（如 12317）。
      try {
        const scripts = document.querySelectorAll('script[type="application/json"], script:not([src])');
        for (let i = 0; i < scripts.length; i++) {
          const txt = scripts[i].textContent || '';
          if (txt.indexOf('description') < 0) continue;
          // 仅匹配 "descriptionCategoryId":"12345" 或 "description_category_id":12345
          const m1 = txt.match(/"description[_-]?[Cc]ategory[_-]?[Ii]d"\s*:\s*"?(\d{4,})"?/);
          if (m1) return m1[1];
        }
      } catch (_) {}

      // 兜底2: 从 JSON-LD 的 category 字段 URL 提取
      try {
        const ldScripts = document.querySelectorAll('script[type="application/ld+json"]');
        for (let i = 0; i < ldScripts.length; i++) {
          const txt = ldScripts[i].textContent || '';
          // JSON-LD 的 category 可能是 URL，如 "https://ozon.ru/category/...-12345/"
          const m = txt.match(/"category"\s*:\s*"[^"]*-(\d{4,})\/?"/);
          if (m) return m[1];
        }
      } catch (_) {}

      return '';
    }

    /**
     * 从面包屑倒数第二级链接 URL 提取父类目 ID（备用，作 L1/L2 推断）
     */
    extractParentCategoryId() {
      const bc = findBreadcrumb();
      if (!bc) return '';
      const links = bc.querySelectorAll('a[href]');
      const ids = [];
      for (let i = 0; i < links.length; i++) {
        const href = links[i].getAttribute('href') || '';
        if (!href) continue;
        // 跳过筛选链接（与 extractDescriptionCategoryId 一致）
        if (/\/category\/[^\/?#]+-\d+\/[^\/?#]+-\d+/.test(href)) continue;
        const m = href.match(/\/category\/[^\/?#]*-(\d{3,})\/?(?:[?#]|$)/i);
        if (m) ids.push(m[1]);
      }
      // 倒数第二级（父类目），用于辅助后端匹配 L1
      return ids.length >= 2 ? ids[ids.length - 2] : '';
    }

    /**
     * 提取 Ozon 三级类型 ID（typeId / type_id）
     *
     * Ozon 商品页的 __NEXT_DATA__ / 内嵌 JSON 中通常包含完整的类目信息：
     *   - description_category_id（L2，由 extractDescriptionCategoryId 提取）
     *   - type_id（L3，本方法提取）
     *
     * 抓到 typeId 后，后端 product_routes.collect_product 会跳过模糊匹配，
     * 直接复用 Ozon 原生类目 ID，零匹配成本。
     *
     * 提取策略：
     *   1. 主：从页面 <script> JSON 中匹配独立的 type_id/typeId 字段
     *      （排除 content_type_id、product_type_id 等带前缀的干扰字段）
     *   2. 兜底：从 JSON-LD 提取
     *
     * @returns {string} typeId（数字字符串，无匹配时返回空字符串）
     */
    extractTypeId() {
      // 主：从页面 <script> JSON 中提取独立的 type_id/typeId
      // Ozon 商品页通常在 __NEXT_DATA__ 或内嵌 JSON 中携带此字段
      try {
        const scripts = document.querySelectorAll(
          'script[type="application/json"], script:not([src])'
        );
        for (let i = 0; i < scripts.length; i++) {
          const txt = scripts[i].textContent || '';
          if (txt.indexOf('type') < 0) continue;

          // 匹配 "xxx_type_id" 或 "typeId" 字段，捕获组1为前缀
          // 干扰字段示例：content_type_id / product_type_id / offer_type_id
          const re = /"(?:([a-z_]+)_)?type[_-]?[Ii]d"\s*:\s*"?(\d{4,})"?/g;
          let m;
          while ((m = re.exec(txt)) !== null) {
            const prefix = m[1] || '';
            // 只接受独立的 type_id/typeId，排除带前缀的干扰字段
            if (!prefix) {
              return m[2];
            }
          }
        }
      } catch (_) {}

      // 兜底：从 JSON-LD 提取（部分页面会暴露 additionalType 或 type_id）
      try {
        const ldScripts = document.querySelectorAll('script[type="application/ld+json"]');
        for (let i = 0; i < ldScripts.length; i++) {
          const txt = ldScripts[i].textContent || '';
          const m = txt.match(/"type[_-]?[Ii]d"\s*:\s*"?(\d{4,})"?/);
          if (m) return m[1];
        }
      } catch (_) {}

      return '';
    }

    /**
     * 提取品牌
     */
    extractBrand() {
      const el = document.querySelector(SELECTORS.BRAND);
      if (!el) return '';
      // 品牌区常同时包含“Оригинальный товар”等徽标链接，不能把徽标
      // 当成品牌。优先选择品牌 URL，并排除状态文案。
      const invalidLabels = ['оригинальный товар', 'original product', '正品'];
      const links = Array.from(el.querySelectorAll('a'));
      const brandLink = links.find(function (link) {
        const text = (link.innerText || link.textContent || '').trim().toLowerCase();
        const href = String(link.getAttribute('href') || '').toLowerCase();
        return text && !invalidLabels.includes(text) && (href.includes('/brand/') || href.includes('brand='));
      }) || links.find(function (link) {
        const text = (link.innerText || link.textContent || '').trim().toLowerCase();
        return text && !invalidLabels.includes(text);
      });
      if (brandLink) return (brandLink.innerText || brandLink.textContent || '').trim();
      const txt = (el.innerText || el.textContent || '').trim();
      const cleaned = txt.replace(/^Бренд\s*:\s*/i, '').trim();
      return invalidLabels.includes(cleaned.toLowerCase()) ? '' : cleaned;
    }

    /**
     * 从 Ozon 商品页"Характеристики"特征区提取完整属性列表
     * 返回 [{name, value}] 数组（Ozon 原生格式，前端 normalizeCollectedAttributes 会处理）
     *
     * DOM 结构兜底链：
     *   1. [data-widget="webCharacteristics"] dl/dt/dd（标准）
     *   2. .characteristics-full dl/dt/dd（旧版）
     *   3. 通用 div/span 结构兜底
     */
    extractCharacteristics() {
      let wrap = null;
      for (let i = 0; i < SELECTORS.CHARACTERISTICS.length; i++) {
        wrap = document.querySelector(SELECTORS.CHARACTERISTICS[i]);
        if (wrap) break;
      }

      const out = [];
      const seenNames = Object.create(null);

      if (wrap) {
      // 策略1: dl/dt/dd 结构（最常见）
      const dlItems = wrap.querySelectorAll('dl');
      for (let i = 0; i < dlItems.length; i++) {
        const dt = dlItems[i].querySelector('dt');
        const dd = dlItems[i].querySelector('dd');
        if (!dt || !dd) continue;
        const name = (dt.innerText || dt.textContent || '').trim();
        const value = (dd.innerText || dd.textContent || '').trim();
        if (name && value && value !== '—' && !seenNames[name]) {
          out.push({ name: name, value: value });
          seenNames[name] = 1;
        }
      }
      if (out.length > 0) return out;

      // 策略2: 通用 div/span 结构（class 含 attribute/characteristic/item）
      const itemSelectors = [
        '[class*="attribute"]',
        '[class*="characteristic"]',
        '[class*="spec"]',
        '[class*="property"]',
        '[class*="param"]',
      ];
      for (let s = 0; s < itemSelectors.length; s++) {
        const items = wrap.querySelectorAll(itemSelectors[s]);
        if (items.length === 0) continue;
        for (let i = 0; i < items.length; i++) {
          const item = items[i];
          // 子元素结构：[0]=name, [1]=value
          const children = item.children;
          if (children.length >= 2) {
            const name = (children[0].innerText || children[0].textContent || '').trim();
            const value = (children[1].innerText || children[1].textContent || '').trim();
            if (name && value && value !== '—' && !seenNames[name]) {
              out.push({ name: name, value: value });
              seenNames[name] = 1;
            }
          }
        }
        if (out.length > 0) return out;
      }

      // 策略3: 文本拆分兜底（"属性名: 值" 每行一个）
      const text = (wrap.innerText || wrap.textContent || '').trim();
      const lines = text.split('\n');
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i].trim();
        const m = line.match(/^(.+?)\s*[:：]\s*(.+)$/);
        if (m && !seenNames[m[1]]) {
          out.push({ name: m[1].trim(), value: m[2].trim() });
          seenNames[m[1]] = 1;
        }
      }
      if (out.length > 0) return out;
      } // end if (wrap)

      // 策略4: 全局兜底——搜索页面中所有 dl[dt+dd] 对（不依赖容器选择器）
      // 处理 Ozon 页面类名动态变化、容器选择器全部失效的情况
      const allDls = document.querySelectorAll('dl');
      for (let i = 0; i < allDls.length; i++) {
        const dt = allDls[i].querySelector('dt');
        const dd = allDls[i].querySelector('dd');
        if (!dt || !dd) continue;
        const name = (dt.innerText || dt.textContent || '').trim();
        const value = (dd.innerText || dd.textContent || '').trim();
        // 值必须存在且非占位符
        if (name && value && value !== '—' && value !== '-' && !seenNames[name]) {
          out.push({ name: name, value: value });
          seenNames[name] = 1;
        }
      }
      return out;
    }

    /**
     * 从特征列表中提取关键字段（重量/尺寸/品牌/制造商/零件号/条形码）
     * 写入 product 对象，避免重复提取
     */
    applyCharacteristicsToProduct(product, characteristics) {
      if (!characteristics || characteristics.length === 0) return;

      // 关键词定义（中俄英）
      const WEIGHT_KEYS = ['вес', 'масса', 'weight', '净重'];
      const LENGTH_KEYS = ['длина', 'length', 'длин'];
      const WIDTH_KEYS = ['ширина', 'width', 'шир'];
      const HEIGHT_KEYS = ['высота', 'height', 'выс'];
      const SIZE_TRIPLE_KEYS = ['размер', 'size', 'габариты', 'dimensions', 'дхшхв'];
      const BRAND_KEYS = ['бренд', 'brand', 'торговая марка'];
      const MANUFACTURER_KEYS = ['изготовитель', 'manufacturer', 'made by', 'страна-изготовитель', 'страна производства'];
      const PART_NUMBER_KEYS = ['артикул', 'part number', 'part_number', 'sku производителя', 'model number'];
      const BARCODE_KEYS = ['штрихкод', 'штрих-код', 'barcode', 'ean', 'upc'];

      // === 第 0 步：重量字段特殊处理（统一克重，全部以 Ozon 克重为计算形式）===
      // 用户需求：统一以"克(g)"为单位，并优先采用 Ozon 平台原生"克重"字段
      //   - "克"单位字段（字段名含 г/g/гр/gram 但不含 кг/kg）
      //     例：attributes[23]"Вес товара, г = 11000" → 11000g（Ozon 平台原生克重）
      //   - "千克"单位字段（字段名含 кг/kg）作为兜底
      //     例：attributes[15]"Вес, кг = 10" → 10000g（换算值）
      // 优先采用克单位字段值，避免单位换算导致精度损失
      if (!product.weight) {
        let gramWeight = 0;  // "克"单位字段值（Ozon 平台原生克重）
        let kgWeight = 0;    // "千克"单位字段换算后的克数
        for (let i = 0; i < characteristics.length; i++) {
          const c = characteristics[i];
          const name = c.name;
          const val = c.value;
          if (!val || val === '—') continue;
          if (!matchCharField(name, WEIGHT_KEYS)) continue;
          const fnLower = String(name || '').toLowerCase();
          // 字段名含 кг/kg 视为"千克"字段；否则（含 г/g/гр/gram）视为"克"字段
          const isKg = /(кг|kg)/.test(fnLower);
          const w = parseWeightValue(val, name);
          if (w <= 0) continue;
          if (isKg) {
            if (!kgWeight) kgWeight = w;
          } else {
            if (!gramWeight) gramWeight = w;
          }
        }
        // 优先采用"克"单位字段（Ozon 平台原生克重），其次用"千克"换算值
        product.weight = gramWeight || kgWeight || 0;
      }

      // === 第 1 步：处理其他字段（length/width/height/brand/manufacturer/...）===
      for (let i = 0; i < characteristics.length; i++) {
        const c = characteristics[i];
        const name = c.name;
        const val = c.value;
        if (!val || val === '—') continue;

        // 重量已在第 0 步统一处理，这里跳过避免覆盖
        if (matchCharField(name, WEIGHT_KEYS)) continue;

        // 优先处理三元组尺寸（如 "15х46х10.6"）—— 必须在单独 length/width/height 之前
        if (!product.length && matchCharField(name, SIZE_TRIPLE_KEYS)) {
          const triple = parseDimensionTriple(val, name);
          if (triple) {
            product.length = triple.length;
            product.width = triple.width;
            product.height = triple.height;
            continue;  // 已处理，跳过后续
          }
        }

        if (!product.length && matchCharField(name, LENGTH_KEYS)) {
          const d = parseDimensionValue(val, name);
          if (d > 0) product.length = d;
        } else if (!product.width && matchCharField(name, WIDTH_KEYS)) {
          const d = parseDimensionValue(val, name);
          if (d > 0) product.width = d;
        } else if (!product.height && matchCharField(name, HEIGHT_KEYS)) {
          const d = parseDimensionValue(val, name);
          if (d > 0) product.height = d;
        } else if (!product.brand && matchCharField(name, BRAND_KEYS)) {
          product.brand = val;
        } else if (!product.manufacturer && matchCharField(name, MANUFACTURER_KEYS)) {
          product.manufacturer = val;
        } else if (!product.partNumber && matchCharField(name, PART_NUMBER_KEYS)) {
          product.partNumber = val;
        } else if ((!product.barcodes || product.barcodes.length === 0) && matchCharField(name, BARCODE_KEYS)) {
          product.barcodes = val.split(/[,;\s]+/).map(function (s) { return s.trim(); }).filter(Boolean);
        }
      }
    }

    /**
     * 提取 Ozon 商品原有的 Rich Content JSON（富文本详情页）
     *
     * 兜底链：
     *   1. webRichContent 元素内 <script type="application/json"> 提取
     *   2. webRichContent 元素 data-state 属性提取
     *   3. 页面全局 <script> JSON 中匹配 richContent / rich-content 字段
     *
     * Ozon Rich Content v0.3 schema: { content: [...widgets], version: 0.3 }
     * widget 类型: raShowcase（文字/图片混排）、billboard（全宽图）、video 等
     *
     * @returns {object|null} Ozon Rich Content JSON 对象，未提取到返回 null
     */
    extractRichContent() {
      // 搜索容器优先级：
      // 1. [data-widget="webRichContent"] —— Ozon Rich Content 官方容器
      // 2. #section-description —— 描述区域（可能包含 Rich Content）
      // 3. [data-widget="webDescription"] —— 描述 widget
      const containers = [];
      [
        '[data-widget="webRichContent"]',
        '[data-widget*="RichContent"]',
        '[data-widget*="richContent"]',
        '[data-widget*="rich-content"]',
      ].forEach(selector => {
        try {
          document.querySelectorAll(selector).forEach(el => {
            if (containers.indexOf(el) < 0) containers.push(el);
          });
        } catch (_) {}
      });

      // 兜底1-3: 在各容器内搜索 <script type="application/json"> 和 <script>
      for (let c = 0; c < containers.length; c++) {
        const el = containers[c];
        // 兜底1: 容器内 <script type="application/json">
        try {
          const scripts = el.querySelectorAll('script[type="application/json"]');
          for (let i = 0; i < scripts.length; i++) {
            const txt = (scripts[i].textContent || '').trim();
            if (!txt) continue;
            const rc = this._parseRichContentJson(txt, true);
            if (rc) return rc;
          }
        } catch (_) {}
        // 兜底2: 容器的 data-state 属性
        try {
          const state = el.getAttribute('data-state');
          if (state) {
            const rc = this._parseRichContentJson(state, true);
            if (rc) return rc;
          }
        } catch (_) {}
        // 兜底3: 容器内所有 <script> 标签（不限 type）
        try {
          const scripts = el.querySelectorAll('script');
          for (let i = 0; i < scripts.length; i++) {
            const txt = (scripts[i].textContent || '').trim();
            if (!txt || txt.length < 20) continue;
            const rc = this._parseRichContentJson(txt, true);
            if (rc) return rc;
          }
        } catch (_) {}
      }

      // 兜底4: 页面全局 <script type="application/json"> 中匹配 richContent 字段
      try {
        const scripts = document.querySelectorAll('script[type="application/json"]');
        for (let i = 0; i < scripts.length; i++) {
          const txt = scripts[i].textContent || '';
          if (!this._containsRichContentKey(txt)) continue;
          const rc = this._parseRichContentJson(txt, false);
          if (rc) return rc;
        }
      } catch (_) {}

      // 兜底5: 页面所有 <script> 标签（含 inline JS），匹配 richContent 赋值
      try {
        const scripts = document.querySelectorAll('script:not([src])');
        for (let i = 0; i < scripts.length; i++) {
          const txt = scripts[i].textContent || '';
          if (txt.length < 50) continue;
          // 匹配 richContent = {...} 或 "richContent":{...} 模式
          if (!this._containsRichContentKey(txt)) continue;
          const rc = this._parseRichContentJson(txt, false);
          if (rc) return rc;
        }
      } catch (_) {}

      // Some Ozon builds expose each original widget on the rendered node.
      // Prefer that data because it preserves exact types (chess/tile/billboard)
      // and block order better than geometry reconstruction can.
      try {
        const widgetNodes = document.querySelectorAll(
          '[widgetdata], [data-widget-data], [data-rich-content], [data-rich-content-json]'
        );
        const widgets = [];
        for (let i = 0; i < widgetNodes.length; i++) {
          const node = widgetNodes[i];
          const raw = node.getAttribute('widgetdata') || node.getAttribute('data-widget-data') ||
            node.getAttribute('data-rich-content') || node.getAttribute('data-rich-content-json') || '';
          if (!raw || raw === '[object Object]') continue;
          let parsed = null;
          try { parsed = JSON.parse(raw); } catch (_) { continue; }
          if (this._isRichContent(parsed, true)) return this._normalizeRichContent(parsed);
          if (parsed && parsed.widgetName) widgets.push(parsed);
          else {
            const nested = this._findRichContentDeep(parsed, 0, true);
            if (nested) return nested;
          }
        }
        if (widgets.length) return this._normalizeRichContent({ content: widgets, version: 0.3 });
      } catch (_) {}

      // Ozon increasingly renders Rich Content from internal state without
      // exposing the original JSON in a script tag. Rebuild a valid v0.3
      // document from the rendered DOM so visible text/images are not lost.
      return this._buildRichContentFromDom(containers);
    }

    _buildRichContentFromDom(knownContainers) {
      const containers = Array.isArray(knownContainers) ? knownContainers.slice() : [];
      [
        '[data-widget="webRichContent"]',
        '[data-widget*="RichContent"]',
        '#section-description',
      ].forEach(selector => {
        try {
          document.querySelectorAll(selector).forEach(el => {
            if (containers.indexOf(el) < 0) containers.push(el);
          });
        } catch (_) {}
      });

      const root = containers.filter(function (el) {
        return el && (el.querySelector('img') || (el.innerText || '').trim());
      }).sort(function (a, b) {
        const score = function (el) {
          return el.querySelectorAll('img,h1,h2,h3,h4,h5,h6,p,li').length;
        };
        return score(b) - score(a);
      })[0];
      if (!root) return null;

      const content = [];
      const widgets = [];
      const cards = [];
      const usedTextElements = new Set();
      const seenImages = Object.create(null);
      const textOf = function (el) {
        if (!el) return '';
        const direct = Array.from(el.childNodes || []).filter(function (node) {
          return node.nodeType === Node.TEXT_NODE;
        }).map(function (node) { return node.nodeValue || ''; }).join(' ');
        return (direct || el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim();
      };
      const collectTextElements = function (scope) {
        if (!scope) return [];
        const result = [];
        const seen = Object.create(null);
        Array.from(scope.querySelectorAll('*')).forEach(function (el) {
          if (/^(SCRIPT|STYLE|NOSCRIPT|SVG|BUTTON|INPUT|TEXTAREA)$/.test(el.tagName)) return;
          const directText = Array.from(el.childNodes || []).some(function (node) {
            return node.nodeType === Node.TEXT_NODE && String(node.nodeValue || '').trim();
          });
          if (!directText && el.childElementCount > 0) return;
          const value = textOf(el);
          if (value.length < 2) return;
          const key = value + '|' + el.tagName;
          if (seen[key]) return;
          seen[key] = true;
          result.push(el);
        });
        return result;
      };
      const formatText = function (value, size, align) {
        return {
          size: size,
          align: align || 'left',
          color: 'color1',
          items: [{ type: 'text', content: value }],
        };
      };
      const nodeOrder = function (a, b) {
        if (a === b) return 0;
        return a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1;
      };
      const getAlign = function (el) {
        try {
          const value = window.getComputedStyle(el).textAlign;
          return ['left', 'center', 'right'].indexOf(value) >= 0 ? value : 'left';
        } catch (_) { return 'left'; }
      };
      const getRect = function (el) {
        try { return el.getBoundingClientRect(); }
        catch (_) { return { left: 0, right: 0, top: 0, bottom: 0, width: 0, height: 0 }; }
      };
      const isHeading = function (el) {
        if (/^H[1-6]$/.test(el.tagName)) return true;
        try {
          const style = window.getComputedStyle(el);
          return parseFloat(style.fontSize || '0') >= 16 && parseInt(style.fontWeight || '400', 10) >= 600;
        } catch (_) { return false; }
      };
      const unionRect = function (elements) {
        const rects = elements.map(getRect).filter(function (r) { return r.width || r.height; });
        if (!rects.length) return getRect(elements[0]);
        const left = Math.min.apply(null, rects.map(function (r) { return r.left; }));
        const right = Math.max.apply(null, rects.map(function (r) { return r.right; }));
        const top = Math.min.apply(null, rects.map(function (r) { return r.top; }));
        const bottom = Math.max.apply(null, rects.map(function (r) { return r.bottom; }));
        return { left: left, right: right, top: top, bottom: bottom, width: right - left, height: bottom - top };
      };
      const layoutHint = function (el) {
        let cursor = el;
        for (let level = 0; cursor && cursor !== root && level < 5; level++, cursor = cursor.parentElement) {
          const marker = ((cursor.className || '') + ' ' +
            (cursor.getAttribute && (cursor.getAttribute('data-widget-type') || cursor.getAttribute('data-type')) || '')).toLowerCase();
          if (/tile[-_]?secondary/.test(marker)) return 'tileSecondary';
          if (/tile[-_]?xl/.test(marker)) return 'tileXL';
          if (/tile[-_]?l/.test(marker)) return 'tileL';
          if (/tile[-_]?m/.test(marker)) return 'tileM';
          if (/billboard/.test(marker)) return 'billboard';
          if (/chess/.test(marker)) return 'chess';
          if (/roll/.test(marker)) return 'roll';
        }
        return '';
      };
      const makeBlock = function (img, src, textElements) {
        const heading = textElements.find(isHeading);
        const bodyParts = textElements.filter(function (el) { return el !== heading; })
          .map(textOf).filter(Boolean);
        const block = {
          imgLink: '',
          img: {
            src: src,
            srcMobile: src,
            alt: (img.getAttribute('alt') || '').trim(),
            position: textElements.length ? 'to_the_edge' : 'width_full',
            positionMobile: 'width_full',
          },
        };
        if (heading) block.title = formatText(textOf(heading), 'size4', getAlign(heading));
        if (bodyParts.length) block.text = formatText(bodyParts.join('\n').slice(0, 3000), 'size2', getAlign(textElements[0]));
        return block;
      };

      try {
        root.querySelectorAll('img').forEach(function (img) {
          let src = img.currentSrc || img.getAttribute('src') || img.getAttribute('data-src') || '';
          src = stripImageSize(src);
          if (!src || !/^https?:\/\//i.test(src) || seenImages[src]) return;
          seenImages[src] = true;

          // Find the smallest local layout block that contains this image and
          // nearby text. This preserves Ozon's image/title/body relationship.
          let section = img.parentElement;
          let textElements = [];
          for (let level = 0; section && section !== root && level < 7; level++) {
            const imagesInSection = section.querySelectorAll('img').length;
            const candidates = collectTextElements(section);
            if (candidates.length > 0 && imagesInSection <= 3) {
              textElements = candidates;
              break;
            }
            section = section.parentElement;
          }

          const freshText = textElements.filter(function (el) { return !usedTextElements.has(el); });
          freshText.forEach(function (el) { usedTextElements.add(el); });
          cards.push({
            img: img,
            section: section || img.parentElement,
            parent: section && section.parentElement,
            textElements: freshText,
            block: makeBlock(img, src, freshText),
          });
        });

        // Group two/three/four sibling cards into Ozon's tile layouts.
        const groupedCards = new Set();
        const parentGroups = new Map();
        cards.forEach(function (card) {
          if (!card.parent || !card.textElements.length) return;
          if (!parentGroups.has(card.parent)) parentGroups.set(card.parent, []);
          parentGroups.get(card.parent).push(card);
        });
        parentGroups.forEach(function (group) {
          if (group.length < 2 || group.length > 4) return;
          const sectionRects = group.map(function (card) { return getRect(card.section); });
          const averageHeight = sectionRects.reduce(function (sum, r) { return sum + r.height; }, 0) / group.length;
          const topSpread = Math.max.apply(null, sectionRects.map(function (r) { return r.top; })) -
            Math.min.apply(null, sectionRects.map(function (r) { return r.top; }));
          if (averageHeight > 0 && topSpread > averageHeight * 0.6) return;
          const hintedType = layoutHint(group[0].parent);
          const type = /^tile/.test(hintedType) ? hintedType :
            (group.length === 2 ? 'tileXL' : (group.length === 3 ? 'tileL' : 'tileM'));
          group.sort(function (a, b) { return getRect(a.section).left - getRect(b.section).left; });
          group.forEach(function (card) { groupedCards.add(card); });
          widgets.push({
            node: group[0].section,
            data: { widgetName: 'raShowcase', type: type, blocks: group.map(function (card) { return card.block; }) },
          });
        });

        cards.forEach(function (card) {
          if (groupedCards.has(card)) return;
          let type = layoutHint(card.section) || 'roll';
          if (card.textElements.length) {
            const imageRect = getRect(card.img);
            const textRect = unionRect(card.textElements);
            const imageCenterX = imageRect.left + imageRect.width / 2;
            const textCenterX = textRect.left + textRect.width / 2;
            const horizontal = Math.abs(imageCenterX - textCenterX) > Math.max(imageRect.width, textRect.width) * 0.35;
            if (type === 'roll' || /^tile/.test(type)) type = horizontal ? 'chess' : 'billboard';
            if (type === 'chess') card.block.reverse = imageCenterX > textCenterX;
          }
          widgets.push({
            node: card.img,
            data: { widgetName: 'raShowcase', type: type, blocks: [card.block] },
          });
        });

        // Keep independent text sections as styled Rich Content widgets.
        collectTextElements(root).forEach(function (el) {
          const value = textOf(el);
          if (!value || value.length < 2 || usedTextElements.has(el)) return;
          usedTextElements.add(el);
          const heading = isHeading(el);
          const data = {
            widgetName: 'raTextBlock',
            theme: 'primary',
            padding: 'type2',
            gapSize: 'm',
          };
          if (heading) data.title = formatText(value, el.tagName === 'H1' ? 'size5' : 'size4', getAlign(el));
          else data.text = formatText(value, 'size2', getAlign(el));
          widgets.push({ node: el, data: data });
        });
      } catch (_) {}

      widgets.sort(function (a, b) { return nodeOrder(a.node, b.node); });
      widgets.forEach(function (item) { content.push(item.data); });

      return content.length ? this._normalizeRichContent({ content: content, version: 0.3 }) : null;
    }

    /**
     * 解析 Rich Content JSON（从字符串中提取）
     *
     * 支持两种输入：
     *   - 直接是 Rich Content JSON 字符串: {"content":[...],"version":0.3}
     *   - 包含 Rich Content 字段的外层 JSON: {"richContent":{"content":[...]}}
     *
     * 校验：必须有 content 数组且长度 > 0
     *
     * @param {string} txt - JSON 字符串
     * @returns {object|null} Rich Content 对象，无效返回 null
     */
    _parseRichContentJson(txt, trustedSource) {
      if (!txt) return null;
      trustedSource = !!trustedSource;

      // 尝试1: 直接 JSON.parse
      let obj = null;
      try {
        obj = JSON.parse(txt);
      } catch (_) {
        // 尝试2: 从非纯 JSON 文本中用正则提取 JSON 片段
        // 匹配 "richContent":{...} 或 richContent = {...} 模式
        const literal = this._extractRichContentObjectLiteral(txt);
        if (literal) {
          try {
            obj = JSON.parse(literal);
          } catch (_) {}
        }
        if (!obj) return null;
        return this._isRichContent(obj, trustedSource) ? this._normalizeRichContent(obj) : this._findRichContentDeep(obj, 0, trustedSource);
        // 尝试3: 提取 {"content":[...]} 片段
      }

      if (!obj || typeof obj !== 'object') return null;

      // 直接是 Rich Content 格式
      if (this._isRichContent(obj, trustedSource)) return this._normalizeRichContent(obj);

      // 递归搜索：从嵌套 JSON 中查找 Rich Content
      return this._findRichContentDeep(obj, 0, trustedSource);
    }

    /**
     * 判断对象是否是 Rich Content JSON
     * 特征：有 content 数组，且数组元素是 widget 对象
     */
    _isRichContent(obj, trustedSource) {
      if (!obj || !Array.isArray(obj.content) || obj.content.length === 0) return false;
      // widget 元素必须是对象，且包含 blocks/widget/image/title 等字段之一
      return obj.content.some(item => {
        if (!item || typeof item !== 'object') return false;
        const widgetName = String(item.widgetName || item.widget || item.type || '').trim();
        if (widgetName && this._isKnownRichContentWidget(widgetName)) return true;
        if (item.blocks && (Array.isArray(item.blocks) || typeof item.blocks === 'object')) return true;
        if (trustedSource && (item.raShowcase || item.raBillboard || item.raVideo)) return true;
        return false;
      });
    }

    /**
     * 递归搜索 JSON 对象中的 Rich Content（深度限制 5 层）
     */
    _findRichContentDeep(obj, depth, underRichContentKey) {
      if (!obj || typeof obj !== 'object' || depth > 20) return null;
      underRichContentKey = !!underRichContentKey;
      if (this._isRichContent(obj, underRichContentKey)) {
        return this._normalizeRichContent(obj);
      }
      // 递归搜索数组
      if (Array.isArray(obj)) {
        for (let i = 0; i < obj.length; i++) {
          const found = this._findRichContentDeep(obj[i], depth + 1, underRichContentKey);
          if (found) return found;
        }
        return null;
      }
      // 递归搜索对象属性
      for (const key in obj) {
        if (!Object.prototype.hasOwnProperty.call(obj, key)) continue;
        const val = obj[key];
        const nextUnderRichContentKey = underRichContentKey || this._isRichContentKey(key);
        if (nextUnderRichContentKey && typeof val === 'string') {
          const parsed = this._parseRichContentJson(val, true);
          if (parsed) return parsed;
        }
        if (val && typeof val === 'object') {
          const found = this._findRichContentDeep(val, depth + 1, nextUnderRichContentKey);
          if (found) return found;
        }
      }
      return null;
    }

    _normalizeRichContent(obj) {
      if (!obj || !Array.isArray(obj.content)) return null;
      let normalized;
      try { normalized = JSON.parse(JSON.stringify(obj)); }
      catch (_) { return null; }

      const isSectionLabel = function (value) {
        return String(value || '').replace(/\s+/g, ' ').trim().toLowerCase() === 'описание';
      };
      const cleanText = function (format) {
        if (!format || typeof format !== 'object') return null;
        if (Array.isArray(format.items)) {
          format.items = format.items.filter(function (item) {
            return !item || item.type === 'br' || !isSectionLabel(item.content);
          });
        }
        if (Array.isArray(format.content)) {
          format.content = format.content.filter(function (value) { return !isSectionLabel(value); });
        }
        const hasItems = Array.isArray(format.items) && format.items.some(function (item) {
          return item && (item.type === 'br' || String(item.content || '').trim());
        });
        const hasContent = Array.isArray(format.content) && format.content.some(function (value) {
          return String(value || '').trim();
        });
        return hasItems || hasContent ? format : null;
      };

      normalized.content = normalized.content.filter(function (widget) {
        if (!widget || typeof widget !== 'object') return false;
        const widgetTitle = cleanText(widget.title);
        const widgetText = cleanText(widget.text);
        if (widgetTitle) widget.title = widgetTitle; else delete widget.title;
        if (widgetText) widget.text = widgetText; else delete widget.text;
        if (Array.isArray(widget.blocks)) {
          widget.blocks.forEach(function (block) {
            if (!block || typeof block !== 'object') return;
            const blockTitle = cleanText(block.title);
            const blockText = cleanText(block.text);
            if (blockTitle) block.title = blockTitle; else delete block.title;
            if (blockText) block.text = blockText; else delete block.text;
          });
        }
        if (widget.widgetName === 'raTextBlock') return !!(widget.title || widget.text);
        return true;
      });
      normalized.version = normalized.version || 0.3;
      return normalized.content.length ? normalized : null;
    }

    _containsRichContentKey(txt) {
      const lower = String(txt || '').toLowerCase();
      return lower.indexOf('richcontent') >= 0 ||
             lower.indexOf('rich_content') >= 0 ||
             lower.indexOf('rich-content') >= 0 ||
             lower.indexOf('rich content') >= 0;
    }

    _isRichContentKey(key) {
      return this._containsRichContentKey(key);
    }

    _isKnownRichContentWidget(name) {
      const normalized = String(name || '').replace(/[_\-\s]/g, '').toLowerCase();
      return [
        'rashowcase',
        'rabillboard',
        'ravideo',
        'ratilexl',
        'ratilel',
        'ratilem',
        'ratextblock',
        'ralist',
        'ratable',
        'showcase',
        'billboard',
        'video',
        'tilexl',
        'tilel',
        'tilem',
        'textblock',
        'list',
        'table',
      ].indexOf(normalized) >= 0;
    }

    _extractRichContentObjectLiteral(txt) {
      if (!this._containsRichContentKey(txt)) return '';
      const text = String(txt || '');
      const keyPatterns = [
        /["']richContent["']\s*[:=]/g,
        /["']rich_content["']\s*[:=]/g,
        /["']rich-content["']\s*[:=]/g,
        /\brichContent\b\s*=/g,
      ];

      for (let p = 0; p < keyPatterns.length; p++) {
        const re = keyPatterns[p];
        re.lastIndex = 0;
        let match;
        while ((match = re.exec(text))) {
          const start = text.indexOf('{', re.lastIndex);
          if (start < 0) continue;
          const literal = this._readBalancedJsonObject(text, start);
          if (literal) return literal;
        }
      }
      return '';
    }

    _readBalancedJsonObject(text, start) {
      let depth = 0;
      let inString = false;
      let quote = '';
      let escaped = false;

      for (let i = start; i < text.length; i++) {
        const ch = text[i];
        if (inString) {
          if (escaped) {
            escaped = false;
          } else if (ch === '\\') {
            escaped = true;
          } else if (ch === quote) {
            inString = false;
          }
          continue;
        }
        if (ch === '"' || ch === "'") {
          inString = true;
          quote = ch;
          continue;
        }
        if (ch === '{') depth++;
        if (ch === '}') {
          depth--;
          if (depth === 0) return text.slice(start, i + 1);
        }
      }
      return '';
    }

    /**
     * 提取商品描述
     * 兜底链：webProductDescription widget → .product-description → 文本提取
     */
    extractDescription() {
      for (let i = 0; i < SELECTORS.DESCRIPTION.length; i++) {
        const el = document.querySelector(SELECTORS.DESCRIPTION[i]);
        if (el) {
          const text = (el.innerText || el.textContent || '').trim();
          if (text && text.length > 10) return text;
        }
      }
      // 兜底：从页面 dataLayer 或 initialState 中提取
      try {
        const scripts = document.querySelectorAll('script[type="application/json"]');
        for (let i = 0; i < scripts.length; i++) {
          const txt = scripts[i].textContent || '';
          if (txt.indexOf('"description"') >= 0) {
            const m = txt.match(/"description"\s*:\s*"([^"]{20,})"/);
            if (m) return m[1].replace(/\\n/g, '\n').replace(/\\"/g, '"');
          }
        }
      } catch (_) {}
      return '';
    }

    /**
     * 提取详情图片（detailImages）
     *
     * Ozon 产品页面的描述区域（#section-description）有两种形态：
     *   1. 纯文本描述（webProductDescription widget）—— 无图片
     *   2. Rich Content 富文本（div.RA-a 容器）—— 包含 img.RA-k2 图片
     *
     * 本方法从 Rich Content 区域提取所有图片 URL，作为 detailImages 返回。
     * 与主图（gallery images）去重，避免重复。
     */
    extractDetailImages() {
      var detailImgs = [];
      // 描述区域容器：#section-description 或 [data-widget="webProductDescription"]
      var descWrap = document.querySelector('#section-description') ||
                     document.querySelector('[data-widget="webRichContent"]') ||
                     document.querySelector('[data-widget="webProductDescription"]') ||
                     document.querySelector('[data-widget="webDescription"]');
      if (!descWrap) return detailImgs;

      // Rich Content 图片选择器：.RA-k2 是 Rich Content 中的图片类
      // 兜底：描述区域内所有 img 标签
      var imgs = descWrap.querySelectorAll('img.RA-k2, .RA-d3 img, img');
      var seen = {};
      // 先收集主图用于去重
      try {
        var mainImgs = this.extractImages();
        if (mainImgs && mainImgs.images) {
          for (var i = 0; i < mainImgs.images.length; i++) {
            seen[mainImgs.images[i]] = true;
          }
        }
      } catch (_) {}

      for (var j = 0; j < imgs.length; j++) {
        var src = imgs[j].getAttribute('src') || imgs[j].getAttribute('data-src') || '';
        if (!src) continue;
        // 去除尺寸后缀，统一用原图 URL
        src = stripImageSize(src);
        if (!src || seen[src]) continue;
        seen[src] = true;
        detailImgs.push(src);
      }
      return detailImgs;
    }

    /**
     * 提取 Ozon 商品页面的主题标签（hashtags）
     *
     * 对应 Ozon 属性 "#主题标签"（id=23171，String 类型）
     * 格式：标签以 # 开头，用空格分隔，最多 30 个
     *
     * HTML 结构：
     * <div data-widget="webHashtags">
     *   <div class="pdp_ua1 ...">
     *     <div class="b5_7_0-a3">
     *       <div title="#антиветер" class="b5_7_0-a4">#антиветер</div>
     *     </div>
     *   </div>
     *   ...
     * </div>
     *
     * @returns {string} 标签字符串，如 "#антиветер #антишторм #зонтавтомат"，无标签返回 ''
     */
    extractHashtags() {
      var wrap = document.querySelector('[data-widget="webHashtags"]');
      if (!wrap) return '';

      // 提取所有标签元素（优先 title 属性，兜底用 textContent）
      var tagEls = wrap.querySelectorAll('[title^="#"], .b5_7_0-a4, .pdp_ua1 [title]');
      var seen = {};
      var tags = [];

      for (var i = 0; i < tagEls.length; i++) {
        var tag = (tagEls[i].getAttribute('title') || tagEls[i].textContent || '').trim();
        if (!tag || tag.indexOf('#') !== 0) continue;
        // 去重
        if (seen[tag]) continue;
        seen[tag] = true;
        tags.push(tag);
      }

      return tags.join(' ');
    }

    /**
     * 从 DOM 同步提取 SKU 列表（结构化对象数组）
     * 兜底方案：仅当 API 调用失败时使用
     * 对齐毛子 ERP row 字段：sku/title/price/originalPrice/coverImage/searchableText/picture
     */
    extractSkuList() {
      const wrap = document.querySelector(SELECTORS.SKU_LIST);
      if (!wrap) return [];
      const items = wrap.querySelectorAll('[data-widget="webSKUItem"], [class*="sku"]');
      const list = [];
      const seenSku = Object.create(null);
      for (let i = 0; i < items.length; i++) {
        const el = items[i];
        const text = (el.innerText || el.textContent || '').trim();
        if (!text) continue;
        // Maozi-compatible two-line variant card:
        // line 1 = product title, line 2 = variant label (e.g. "4 - черный").
        const lineEls = el.querySelectorAll('.line-clamp-1, [class*="line-clamp"]');
        const lines = Array.from(lineEls).map(function (node) {
          return (node.textContent || '').replace(/\s+/g, ' ').trim();
        }).filter(Boolean);
        const cardTitle = lines[0] || '';
        const variantLabel = lines.length > 1 ? lines[1] : '';
        // 尝试从元素或子元素拿 sku id（aria-label / data-sku / 链接 href 中的数字）
        let skuId = '';
        const link = el.querySelector('a[href*="/product/"]') || (el.tagName === 'A' ? el : null);
        if (link) {
          const m = (link.getAttribute('href') || '').match(/\/product\/[^\/]*-(\d{4,})/);
          if (m) skuId = m[1];
        }
        if (!skuId) {
          skuId = el.getAttribute('data-sku') || el.getAttribute('data-sku-id') || '';
        }
        // 去重
        const dedup = skuId || text;
        if (seenSku[dedup]) continue;
        seenSku[dedup] = 1;

        // 从文本中尝试拆出价格（如 "Red 64GB\n1 299 ₽"）
        const priceMatch = text.match(/([\d\s,.]+)\s*[₽]/);
        const price = priceMatch ? parsePrice(priceMatch[1]) : 0;
        const titleText = cardTitle || (priceMatch ? text.replace(priceMatch[0], '').trim() : text);
        const variantText = variantLabel || titleText;

        list.push({
          sku: skuId,
          title: titleText,
          price: price,
          originalPrice: 0,
          coverImage: '',
          searchableText: variantText,
          variantLabel: variantLabel,
          picture: '',
          stock: 0,
          attributes: this._parseAttributes(variantText),
          _source: 'dom',
        });
      }
      return list;
    }

    /**
     * 调用 Ozon entrypoint-api 获取完整变体列表
     * 端点：/api/entrypoint-api.bx/page/json/v2?url=/modal/aspectsNew?product_id={id}
     * 对齐毛子 ERP content.js 第 400 行 q 函数
     * @param {string} productId - Ozon 商品 ID（纯数字）
     * @returns {Promise<Array>} 结构化变体数组
     */
    async fetchVariants(productId) {
      if (!productId) {
        console.warn('[GeekOzon] fetchVariants: productId 为空，跳过 aspectsNew 请求');
        return [];
      }
      // 对齐毛子 ERP q 函数：url 参数不使用 encodeURIComponent，
      // Ozon entrypoint-api 内部路由不会解码 %3F/%3D，编码会导致 aspectsNew 请求失败，
      // 变体标题（如 "1- черный"）丢失，只剩 DOM 兜底数据。
      const url = location.origin +
        '/api/entrypoint-api.bx/page/json/v2?url=/modal/aspectsNew?product_id=' + productId;
      console.log('[GeekOzon] fetchVariants 请求:', url);
      const ctrl = new AbortController();
      const timer = setTimeout(function () { ctrl.abort(); }, 8000);
      try {
        const resp = await fetch(url, { credentials: 'include', signal: ctrl.signal });
        clearTimeout(timer);
        console.log('[GeekOzon] fetchVariants 响应状态:', resp.status);
        if (!resp.ok) {
          console.warn('[GeekOzon] fetchVariants 响应不正常，返回空数组');
          return [];
        }
        const json = await resp.json();
        const w = parseWidget(json, 'webAspectsModal-');
        if (!w || !Array.isArray(w.aspects)) {
          console.warn('[GeekOzon] fetchVariants: webAspectsModal widget 未找到或无 aspects 字段', json.widgetStates ? Object.keys(json.widgetStates) : 'no widgetStates');
          return [];
        }
        const out = [];
        const seenSku = Object.create(null);
        for (let i = 0; i < w.aspects.length; i++) {
          const a = w.aspects[i] || {};
          const variants = Array.isArray(a.variants) ? a.variants : [];
          for (let j = 0; j < variants.length; j++) {
            const v = variants[j] || {};
            const d = v.data || {};
            const skuId = String(v.sku || '');
            if (!skuId || seenSku[skuId]) continue;
            seenSku[skuId] = 1;
            out.push({
              sku: skuId,
              title: d.title || '',
              price: parsePrice(d.price),
              originalPrice: parsePrice(d.originalPrice),
              cardPrice: parsePrice(d.cardPrice || d.price),
              coverImage: stripImageSize(d.coverImage || ''),
              searchableText: d.searchableText || '',
              variantLabel: d.searchableText || '',
              picture: stripImageSize(d.picture || ''),
              stock: 0,
              attributes: this._parseAttributes(d.searchableText || d.title || ''),
              _source: 'aspectsNew',
            });
          }
        }
        console.log('[GeekOzon] fetchVariants 提取到 ' + out.length + ' 个变体', out.length ? '首个标题: ' + out[0].title : '(无)');
        return out;
      } catch (e) {
        console.warn('[GeekOzon] fetchVariants 异常:', e.message || e);
        return [];
      }
    }

    /**
     * 调用 Ozon entrypoint-api 获取主商品详情 + 内嵌 webAspects 变体
     * 端点：/api/entrypoint-api.bx/page/json/v2?url=/product/{sku}/
     * 对齐毛子 ERP content.js 第 400 行 oe 函数
     * @param {string} sku - Ozon 商品 SKU
     * @returns {Promise<object>} { product, variants }
     */
    async fetchProductDetail(sku) {
      if (!sku) return { product: null, variants: [] };
      // 对齐毛子 ERP oe 函数 + R 函数：使用纯数字 ID 调用 API，不用完整 slug
      // 毛子 R 函数：url.match(/\/product\/(?:[^\/]+\-)?(\d+)(?:\/|\?|$)/) 只取数字 ID
      // GeekOzon 的 sku 是完整 slug（含西里尔字符），直接拼到 URL 会导致 API 失败
      var numId = String(sku).match(/(\d+)$/);
      var id = numId ? numId[1] : sku;
      const url = location.origin +
        '/api/entrypoint-api.bx/page/json/v2?url=/product/' + id + '/';
      console.log('[GeekOzon] fetchProductDetail 请求 (id=' + id + '):', url);
      const ctrl = new AbortController();
      const timer = setTimeout(function () { ctrl.abort(); }, 8000);
      try {
        const resp = await fetch(url, { credentials: 'include', signal: ctrl.signal });
        clearTimeout(timer);
        console.log('[GeekOzon] fetchProductDetail 响应状态:', resp.status);
        if (!resp.ok) return { product: null, variants: [] };
        const json = await resp.json();

        // 解析 webAspects- widget（内嵌变体列表）
        const aspectsWidget = parseWidget(json, 'webAspects-');
        const variants = [];
        if (aspectsWidget && Array.isArray(aspectsWidget.aspects)) {
          const seenSku = Object.create(null);
          for (let i = 0; i < aspectsWidget.aspects.length; i++) {
            const a = aspectsWidget.aspects[i] || {};
            const aVariants = Array.isArray(a.variants) ? a.variants : [];
            for (let j = 0; j < aVariants.length; j++) {
              const v = aVariants[j] || {};
              const d = v.data || {};
              const skuId = String(v.sku || '');
              if (!skuId || seenSku[skuId]) continue;
              seenSku[skuId] = 1;
              variants.push({
                sku: skuId,
                title: d.title || '',
                price: parsePrice(d.price),
                originalPrice: parsePrice(d.originalPrice),
                cardPrice: parsePrice(d.cardPrice || d.price),
                coverImage: stripImageSize(d.coverImage || ''),
                searchableText: d.searchableText || '',
                variantLabel: d.searchableText || '',
                picture: stripImageSize(d.picture || ''),
                stock: 0,
                attributes: this._parseAttributes(d.searchableText || d.title || ''),
                _source: 'productDetail',
              });
            }
          }
        }

        // 解析 webProductHeading-（标题）
        const heading = parseWidget(json, 'webProductHeading-');
        const product = heading ? {
          title: heading.title || heading.name || '',
          sku: sku,
        } : null;

        // 解析 webGallery-（图片集 + 视频）
        // 对齐毛子 ERP oe() 函数：从 webGallery 提取 images 和 videos
        // 毛子 oe() 中：gt = We?.images?.map(un => un.src) || [], ot = We?.videos || []
        const gallery = parseWidget(json, 'webGallery-');
        if (gallery && product) {
          const imgs = Array.isArray(gallery.images) ? gallery.images : [];
          product.images = imgs.map(function (img) {
            return stripImageSize(typeof img === 'string' ? img : (img.url || img.src || ''));
          }).filter(Boolean);
          // 视频提取（对齐毛子 ERP：直接取 widget.videos 数组）
          // 数组元素结构由 Ozon 决定，原样透传给后端/前端使用
          product.videos = Array.isArray(gallery.videos) ? gallery.videos.slice() : [];
        }

        // 解析 webPrice- widget（当前售价 - 与商品页显示一致）
        // 对齐毛子 ERP oe() 函数：从 webPrice 取 price/originalPrice/cardPrice
        // 同时调用 ee()/detectCurrencyFromPrice() 从价格字符串检测货币（对齐毛子 ee(Ve.price)）
        const priceWidget = parseWidget(json, 'webPrice-');
        if (priceWidget && product) {
          const regularPrice = parsePrice(priceWidget.price);
          const cardPrice = parsePrice(priceWidget.cardPrice);
          // 用户需求：原售价列应显示商品的折扣价（最低价部分），而非普通售价
          // 当存在 cardPrice（Ozon 卡折扣价）且小于 regularPrice 时，页面显示的是 cardPrice
          // 对齐毛子 ERP LJ 函数（编辑上架）的 sell_price: Ve.cardPrice||Ve.price 行为
          // 故主商品的 price 也设为折扣价，保证 _extractRows() 兜底取到正确值
          const displayedPrice = (cardPrice > 0 && (regularPrice === 0 || cardPrice < regularPrice))
            ? cardPrice
            : regularPrice;
          product.price = displayedPrice;
          product.originalPrice = parsePrice(priceWidget.originalPrice);
          product.cardPrice = cardPrice;
          // 对齐毛子 ERP ee() 函数：从 webPrice.price 字符串检测源货币
          // ee() 会更新 E.value (ozonUserCurrency)，此处存入 product.currency 供 publish-modal 使用
          const detectedCurrency = detectCurrencyFromPrice(priceWidget.price);
          if (detectedCurrency) {
            product.currency = detectedCurrency;
          }
        }

        return { product: product, variants: variants };
      } catch (e) {
        return { product: null, variants: [] };
      }
    }

    /**
     * 获取单个变体 SKU 的当前售价（来自 webPrice widget）
     * 对齐毛子 ERP we() 函数中调用 oe(sku, false) 的行为
     * 用于覆盖 aspectsNew API 返回的不准确价格
     * @param {string} sku - 变体 SKU
     * @returns {Promise<object|null>} { price, originalPrice, cardPrice } 或 null
     */
    async fetchVariantPrice(sku) {
      if (!sku) return null;
      // 对齐毛子 ERP oe 函数：url 参数不使用 encodeURIComponent
      const url = location.origin +
        '/api/entrypoint-api.bx/page/json/v2?url=/product/' + sku + '/';
      const ctrl = new AbortController();
      const timer = setTimeout(function () { ctrl.abort(); }, 6000);
      try {
        const resp = await fetch(url, { credentials: 'include', signal: ctrl.signal });
        clearTimeout(timer);
        if (!resp.ok) return null;
        const json = await resp.json();
        const priceWidget = parseWidget(json, 'webPrice-');
        if (!priceWidget) return null;
        const regularPrice = parsePrice(priceWidget.price);
        const cardPrice = parsePrice(priceWidget.cardPrice);
        const originalPrice = parsePrice(priceWidget.originalPrice);
        // 对齐毛子 ERP se() 函数：变体的 price 与 cardPrice 都设为页面显示的当前售价
        // 毛子 se() 中 cardPrice:W(data.price), price:W(data.price)（同值）
        // 当存在 cardPrice（Ozon 卡折扣价）且小于 regularPrice 时，
        // 页面实际显示的是 cardPrice（用户登录了 Ozon 卡），故两字段都设为 cardPrice
        // 这样 _extractRows() 中 sell_price = v.price||v.cardPrice 即可取到正确值
        const displayedPrice = (cardPrice > 0 && (regularPrice === 0 || cardPrice < regularPrice))
          ? cardPrice
          : regularPrice;
        return {
          price: displayedPrice,
          cardPrice: displayedPrice,
          originalPrice: originalPrice,
        };
      } catch (e) {
        return null;
      }
    }

    /**
     * 跨 tab 借权采集变体（对齐毛子 ERP ah() 函数的 seller.ozon.ru 兜底链）
     *
     * 当页面端 webAspects- / webAspectsModal- 返回的变体不足时，
     * 通过 seller.ozon.ru API 获取变体数据（需卖家已登录 seller.ozon.ru）。
     *
     * 兜底链（对齐毛子 ERP）：
     *   方法4: fetchWhatToSell    - /api/site/seller-analytics/what_to_sell/data/v3
     *                             返回 items[]，含 variantId + 销量/佣金等 24+ 字段
     *   方法5: fetchVariantModels - /api/v1/search-variant-model
     *                             按 SKU 名称搜索，返回 items[] 变体列表
     *
     * @param {string} sku - Ozon 商品 SKU
     * @returns {Promise<Array>} 结构化变体数组（可能为空）
     */
    async fetchVariantsViaSeller(sku) {
      if (!sku) return [];
      // 依赖 CrossTab 模块（仅在 seller.ozon.ru 已登录时可用）
      const CrossTab = window.GeekOzon && window.GeekOzon.core && window.GeekOzon.core.CrossTab;
      if (!CrossTab) return [];

      const out = [];
      const seenSku = Object.create(null);

      // 方法4: what_to_sell API（获取 variantId + 销量数据）
      // 对齐毛子 ERP ah() 中 oc(e, "sales") 调用
      try {
        const salesResp = await CrossTab.fetchWhatToSell(sku);
        if (salesResp && salesResp.success && salesResp.data) {
          const items = (salesResp.data.items || salesResp.data.result || []);
          if (Array.isArray(items)) {
            for (let i = 0; i < items.length; i++) {
              const it = items[i] || {};
              const variantId = String(it.variant_id || it.variantId || it.sku || '');
              const itemSku = String(it.sku || variantId);
              if (!itemSku || seenSku[itemSku]) continue;
              seenSku[itemSku] = 1;
              out.push({
                sku: itemSku,
                title: it.title || it.name || '',
                price: parsePrice(it.price),
                originalPrice: parsePrice(it.old_price || it.originalPrice),
                cardPrice: parsePrice(it.card_price || it.cardPrice || it.price),
                coverImage: stripImageSize(it.cover_image || it.coverImage || ''),
                searchableText: '',
                picture: '',
                stock: Number(it.stock || it.qty || 0) || 0,
                attributes: {},
                _source: 'what_to_sell',
                _variantId: variantId,
                _salesData: {
                  soldCount: it.sold_count || it.soldCount || 0,
                  soldSum: it.sold_sum || it.soldSum || 0,
                  drr: it.drr || 0,
                },
              });
            }
          }
        }
      } catch (e) {
        // what_to_sell 失败不阻断，继续尝试 variant search
      }

      // 方法5: search-variant-model API（按名称搜索变体）
      // 对齐毛子 ERP ah() 中 oc(e, "variant") 调用
      if (out.length === 0) {
        try {
          const variantResp = await CrossTab.fetchVariantModels(sku);
          if (variantResp && variantResp.success && variantResp.data) {
            const items = (variantResp.data.items || variantResp.data.result || []);
            if (Array.isArray(items)) {
              for (let i = 0; i < items.length; i++) {
                const it = items[i] || {};
                const itemSku = String(it.sku || it.variant_id || it.id || '');
                if (!itemSku || seenSku[itemSku]) continue;
                seenSku[itemSku] = 1;
                out.push({
                  sku: itemSku,
                  title: it.title || it.name || '',
                  price: parsePrice(it.price),
                  originalPrice: parsePrice(it.old_price || it.originalPrice),
                  cardPrice: parsePrice(it.card_price || it.cardPrice || it.price),
                  coverImage: stripImageSize(it.cover_image || it.coverImage || ''),
                  searchableText: '',
                  picture: '',
                  stock: 0,
                  attributes: {},
                  _source: 'search-variant-model',
                  _variantId: String(it.variant_id || it.variantId || ''),
                });
              }
            }
          }
        } catch (e) {
          // variant search 失败不阻断
        }
      }

      return out;
    }

    /**
     * 解析 searchableText 为属性对象
     * 例："Цвет: черный; Размер: M" -> { color: 'черный', size: 'M' }
     * 也支持 "черный M"（按分号/空格分割）
     */
    _parseAttributes(text) {
      const out = {};
      if (!text) return out;
      // 按分号或换行分割键值对
      const parts = text.split(/[;\n]/).map(function (s) { return s.trim(); }).filter(Boolean);
      for (let i = 0; i < parts.length; i++) {
        const p = parts[i];
        const kv = p.split(':').map(function (s) { return s.trim(); });
        if (kv.length >= 2) {
          const k = kv[0].toLowerCase();
          const v = kv.slice(1).join(':').trim();
          if (k && v) {
            if (k.indexOf('цвет') !== -1 || k.indexOf('color') !== -1) out.color = v;
            else if (k.indexOf('размер') !== -1 || k.indexOf('size') !== -1) out.size = v;
            else out[k] = v;
          }
        } else if (p) {
          // 无冒号，按位置分（"черный M" → color/size）
          const cleanPart = p.replace(/^\s*\d+\s*(?:спиц(?:ы)?|骨)?\s*[-–—:]\s*/i, '').trim();
          if (!cleanPart) continue;
          if (!out.color) out.color = cleanPart;
          else if (!out.size) out.size = cleanPart;
          else out['attr' + (Object.keys(out).length + 1)] = cleanPart;
        }
      }
      return out;
    }

    /**
     * 合并 DOM 和 API 两路变体数据（按 sku 去重，API 数据优先）
     */
    mergeVariants(domVariants, apiVariants) {
      const map = Object.create(null);
      const out = [];
      // 先放 API 数据（更准确）
      for (let i = 0; i < apiVariants.length; i++) {
        const v = apiVariants[i];
        if (v.sku && !map[v.sku]) {
          map[v.sku] = 1;
          out.push(v);
        }
      }
      // 再补充 DOM 数据中 sku 不重复的
      for (let i = 0; i < domVariants.length; i++) {
        const v = domVariants[i];
        const key = v.sku || v.title;
        if (key && !map[key]) {
          map[key] = 1;
          out.push(v);
        }
      }
      return out;
    }

    /** Exclude Ozon's discounted/damaged offer from normal SKU variants. */
    filterDiscountedVariants(variants, currentSku) {
      const list = Array.isArray(variants) ? variants : [];
      const currentMatch = String(currentSku || '').match(/(\d+)(?:\D*)$/);
      const currentId = currentMatch ? currentMatch[1] : String(currentSku || '');
      const variantText = function (variant) {
        const attrs = variant && variant.attributes && typeof variant.attributes === 'object'
          ? Object.values(variant.attributes).join(' ')
          : '';
        return [variant && variant.searchableText, variant && variant.title, attrs]
          .filter(Boolean).join(' ').toLowerCase();
      };
      const isDiscounted = function (variant) {
        return /уцен|discounted|damaged|折价|瑕疵/.test(variantText(variant));
      };
      const currentIsDiscounted = list.some(function (variant) {
        return String((variant && (variant.sku || variant.id)) || '') === currentId && isDiscounted(variant);
      });
      return list.filter(function (variant) {
        const variantId = String((variant && (variant.sku || variant.id)) || '');
        if (currentIsDiscounted) return variantId === currentId;
        if (currentId && variantId === currentId) return true;
        return !isDiscounted(variant);
      });
    }

    /** 从标准 JSON-LD 提取 Product，作为 Ozon DOM 改版时的通用回退。 */
    extractStructuredProduct() {
      const scripts = document.querySelectorAll('script[type="application/ld+json"]');
      const findProduct = function (node) {
        if (!node) return null;
        if (Array.isArray(node)) {
          for (let i = 0; i < node.length; i++) {
            const found = findProduct(node[i]);
            if (found) return found;
          }
          return null;
        }
        if (typeof node !== 'object') return null;
        const type = node['@type'];
        if (type === 'Product' || (Array.isArray(type) && type.includes('Product'))) return node;
        return findProduct(node['@graph']) || findProduct(node.mainEntity) || findProduct(node.itemListElement);
      };
      for (let i = 0; i < scripts.length; i++) {
        try {
          const found = findProduct(JSON.parse(scripts[i].textContent || '{}'));
          if (found) return found;
        } catch (_) {}
      }
      return null;
    }

    /** 用结构化数据补空字段，并合并图片和 additionalProperty。 */
    applyStructuredProduct(product, structured) {
      if (!structured || !product) return product;
      if (!product.title) product.title = String(structured.name || '').trim();
      if (!product.description && !product.richContent) product.description = String(structured.description || '').trim();
      if (!product.sku) product.sku = String(structured.sku || structured.mpn || '').trim();
      if (!product.brand) {
        product.brand = String(typeof structured.brand === 'string'
          ? structured.brand : (structured.brand && structured.brand.name) || '').trim();
      }
      const offers = Array.isArray(structured.offers) ? structured.offers[0] : structured.offers;
      if (!product.price && offers) product.price = parsePrice(offers.price || offers.lowPrice || offers.highPrice || 0);
      if (!product.currency && offers && offers.priceCurrency) product.currency = offers.priceCurrency;

      const structuredImages = [];
      (Array.isArray(structured.image) ? structured.image : [structured.image]).forEach(function (image) {
        const url = typeof image === 'string' ? image : image && (image.url || image.contentUrl);
        if (url) structuredImages.push(stripImageSize(url));
      });
      product.images = Array.from(new Set((product.images || []).concat(structuredImages).filter(Boolean)));
      product.mainImage = product.images[0] || product.mainImage || '';

      const attrs = Array.isArray(product.attributes) ? product.attributes : [];
      const seen = new Set(attrs.map(function (a) { return String(a && a.name || '').trim().toLowerCase(); }));
      (Array.isArray(structured.additionalProperty) ? structured.additionalProperty : []).forEach(function (property) {
        const name = String(property && (property.name || property.propertyID) || '').trim();
        const value = String(property && property.value || '').trim();
        if (name && value && !seen.has(name.toLowerCase())) {
          attrs.push({ name: name, value: value });
          seen.add(name.toLowerCase());
        }
      });
      product.attributes = attrs;
      return product;
    }

    /** 生成唯一最终快照和完整度诊断，供采集与一键上架共同使用。 */
    finalizeProductSnapshot(product, sources) {
      if (!product) return product;
      product.images = Array.from(new Set((product.images || []).map(stripImageSize).filter(Boolean)));
      product.videos = Array.from(new Set((product.videos || []).filter(Boolean)));
      const attrs = [];
      const seen = new Set();
      (product.attributes || []).forEach(function (attr) {
        if (!attr || typeof attr !== 'object') return;
        const attrId = String(attr.id || attr.attrId || attr.attribute_id || '').trim();
        const attrName = String(attr.name || '').trim().toLowerCase();
        const key = attrId ? 'id:' + attrId : (attrName ? 'name:' + attrName : '');
        if (key && !seen.has(key)) {
          attrs.push(attr);
          seen.add(key);
        }
      });
      product.attributes = attrs;
      const checks = {
        title: !!product.title,
        price: Number(product.price) > 0,
        images: product.images.length > 0,
        category: !!(product.category || product.descriptionCategoryId),
        attributes: product.attributes.length > 0,
        sku: !!(product.sku || (product.skuList && product.skuList.length)),
        dimensions: Number(product.weight) > 0 && Number(product.length) > 0 && Number(product.width) > 0 && Number(product.height) > 0,
        content: !!(product.richContent || product.description),
      };
      const missing = Object.keys(checks).filter(function (key) { return !checks[key]; });
      product.collectionDiagnostics = {
        score: Math.round((Object.keys(checks).length - missing.length) / Object.keys(checks).length * 100),
        missing: missing,
        sources: (sources || []).filter(Boolean),
        capturedAt: new Date().toISOString(),
      };
      this.lastProduct = product;
      return product;
    }

    /**
     * 同步提取商品数据（仅 DOM 已渲染部分）
     * 实现 ScannerBase.extractProductData
     */
    extractProductData() {
      const sku = this.getSkuFromUrl();
      const productId = this.getProductIdFromUrl();
      const imgs = this.extractImages();
      const product = this.createBlankProduct();
      const structuredProduct = this.extractStructuredProduct();
      product.sku = sku;
      product.productId = productId;
      product.title = this.extractTitle();
      product.price = this.extractPrice();
      product.currency = 'RUB';
      product.mainImage = imgs.mainImage;
      product.images = imgs.images;
      // 视频字段初始化（对齐毛子 ERP，异步 scanAsync 中由 webGallery widget 填充）
      product.videos = [];
      // skuList 兼容字符串数组格式（后端旧字段）
      const skuList = this.extractSkuList();
      product.skuList = skuList;
      // variants 新字段（结构化对象数组，含 sku/title/price/originalPrice/coverImage/searchableText/picture/attributes）
      product.variants = skuList;
      product.category = this.extractCategory();
      product.brand = this.extractBrand();
      product.shopName = 'Ozon';
      // 直接从 Ozon 面包屑 URL 提取平台原生类目 ID
      // （传给后端后，product_routes.collect_product 会跳过模糊匹配）
      product.descriptionCategoryId = this.extractDescriptionCategoryId();
      product.parentCategoryId = this.extractParentCategoryId();
      // 提取 Ozon 三级类型 ID（typeId），与 descriptionCategoryId 一起构成完整类目定位
      // 抓到后后端可直接复用 Ozon 原生类目，跳过关键词打分和 AI 匹配
      product.typeId = this.extractTypeId();

      // === 新增：提取"Характеристики"特征区，作为动态属性 + 关键字段补全 ===
      const characteristics = this.extractCharacteristics();
      if (characteristics.length > 0) {
        // 特征列表转成 Ozon 原生 attributes 格式（前端 normalizeCollectedAttributes 会处理）
        // 注意：这里没有 key/id（Ozon API 的属性 id），只有 name+value，前端会按名称匹配
        product.attributes = characteristics.map(function (c) {
          return { name: c.name, value: c.value };
        });
        // 从特征中提取关键字段（重量/尺寸/品牌/制造商/零件号/条形码）
        this.applyCharacteristicsToProduct(product, characteristics);
      }

      // === 新增：提取 Ozon 原有 Rich Content JSON（富文本详情页） ===
      // 抓取判断：extractRichContent 返回非 null 对象即视为有效
      // 创建编译：把 richContent 对象序列化为 JSON 字符串，作为 11254 属性值写入 attributes
      //           前端 fillAttributeValues 会按 data-attr-id=11254 回填到 textarea
      //           上架时作为类目属性提交到 Ozon
      const richContent = this.extractRichContent();
      if (richContent) {
        product.richContent = richContent;

        // 编译：richContent 对象 → JSON 字符串（紧凑格式，减少体积）
        let richContentJsonStr = '';
        try {
          richContentJsonStr = JSON.stringify(richContent);
        } catch (_) {
          richContentJsonStr = '';
        }

        // 写入 product.attributes 作为 11254 属性值
        // Ozon 的 "JSON富内容（Rich-контент JSON）" 属性 ID 固定为 11254
        if (richContentJsonStr) {
          if (!Array.isArray(product.attributes)) {
            product.attributes = [];
          }
          // 去重：移除已存在的 11254 条目（避免重复采集导致冲突）
          product.attributes = product.attributes.filter(function (a) {
            return String(a.id || '') !== '11254' &&
                   !(a.name && /JSON富内容|Rich-контент|Rich content/i.test(a.name));
          });
          product.attributes.push({
            id: 11254,
            name: 'JSON富内容（Rich-контент JSON）',
            value: richContentJsonStr,
          });
        }
      }

      // === 新增：提取商品描述（纯文本） ===
      product.description = richContent ? '' : this.extractDescription();

      // === 新增：提取详情图片（Rich Content 富文本中的图片） ===
      // Ozon 描述区有两种形态：纯文本描述（无图片）和 Rich Content 富文本（含 img.RA-k2）
      // extractDetailImages 会自动判断并提取 Rich Content 中的图片，与主图去重
      product.detailImages = this.extractDetailImages();

      // === 新增：提取主题标签（hashtags）===
      // 对应 Ozon 属性 "#主题标签"（id=23171，String 类型）
      // 前端 fillAttributeValues 会按 id=23171 回填到对应属性输入框
      const hashtags = this.extractHashtags();
      if (hashtags) {
        if (!Array.isArray(product.attributes)) product.attributes = [];
        // 去重：移除已存在的 23171 条目
        product.attributes = product.attributes.filter(function (a) {
          return String(a.id || '') !== '23171' &&
                 !(a.name && /主题标签|hashtag|#.*тег/i.test(a.name));
        });
        product.attributes.push({
          id: 23171,
          name: '#主题标签',
          value: hashtags,
        });
      }

      // === 新增：源链接与平台名（之前缺失） ===
      product.sourceLink = location.href;
      product.sourceName = 'Ozon';

      // === 确保 brand 也在 product.attributes 中 ===
      // product.brand 由 extractBrand() 从 webBrand widget 提取，可能不在特征区 dl/dt/dd 中
      // 前端 fillAttributeValues 只处理 product.attributes，需确保品牌在 attributes 中才能回填
      if (product.brand) {
        if (!Array.isArray(product.attributes)) product.attributes = [];
        // 检查是否已有品牌条目（特征区可能已包含 "Бренд"）
        const BRAND_KEYS = ['бренд', 'brand', 'торговая марка', '品牌'];
        const hasBrand = product.attributes.some(function (a) {
          const n = String(a.name || '').toLowerCase();
          return BRAND_KEYS.some(function (k) { return n.indexOf(k) >= 0; });
        });
        if (!hasBrand) {
          product.attributes.push({ name: 'Бренд', value: product.brand });
        }
      }

      this.applyStructuredProduct(product, structuredProduct);
      return this.finalizeProductSnapshot(product, ['dom', structuredProduct ? 'json-ld' : '']);
    }

    /**
     * 异步采集（等待 DOM + 调用 Ozon entrypoint-api 拉取完整变体数据）
     * 重写 ScannerBase.scanAsync
     *
     * 5 方法变体采集兜底链（对齐毛子 ERP ah()/oe() 函数）：
     *   方法1: webAspects- widget       - /product/{sku}/ 内嵌变体（页面端，主）
     *   方法2: webAspectsModal- widget  - /modal/aspectsNew?product_id={id}（页面端，补充）
     *   方法3: DOM 提取                 - webSKUItem 元素（页面端，兜底）
     *   方法4: what_to_sell API         - seller.ozon.ru 跨 tab 借权（销量+变体）
     *   方法5: search-variant-model API - seller.ozon.ru 跨 tab 借权（按名搜索变体）
     *
     * 流程：
     *   1. 等待关键 DOM（标题/价格）
     *   2. 并行调用方法1+方法2（页面端 API）
     *   3. 合并三路页面端变体（方法2 > 方法1 > 方法3）
     *   4. 若变体为空，调用方法4+方法5（seller.ozon.ru 跨 tab 借权）
     *   5. 用 API 返回的标题/图片/视频/价格补全（DOM 缺失时）
     *   6. 为每个变体获取真实页面价格（fetchVariantPrice，最多 15 个）
     */
    async scanAsync() {
      // 1. 等待标题/价格区出现（最长 6 秒）
      const tasks = [
        DomUtils.waitForElement(SELECTORS.TITLE, 6000),
        DomUtils.waitForElement(SELECTORS.PRICE, 6000),
      ];
      await Promise.all(tasks);
      // 主图相册稍后渲染，等 300ms
      await new Promise(function (r) { setTimeout(r, 300); });

      // 2. 同步采集基础数据
      const product = this.scan();
      if (!product) return null;

      // 3. 并行调用方法1+方法2（页面端 API，带 8s 超时保护）
      // 容错：单个 API 失败不影响整体，返回 null 即可
      const sku = product.sku || this.getSkuFromUrl();
      const productId = product.productId || this.getProductIdFromUrl();
      console.log('[GeekOzon] scanAsync: sku=' + sku + ', productId=' + productId);
      const self = this;
      const [detailRes, apiVariants] = await Promise.all([
        self.fetchProductDetail(sku).catch(function (e) {
          console.warn('[GeekOzon] fetchProductDetail 失败:', e);
          return null;
        }),
        self.fetchVariants(productId).catch(function (e) {
          console.warn('[GeekOzon] fetchVariants 失败:', e);
          return [];
        }),
      ]);

      // 4. 合并三路页面端变体数据：方法2(aspectsNew) > 方法1(productDetail) > 方法3(DOM)
      const detailVariants = (detailRes && detailRes.variants) || [];
      const domVariants = product.skuList || [];
      console.log('[GeekOzon] scanAsync 变体来源: detail=' + detailVariants.length + ', aspectsNew=' + apiVariants.length + ', dom=' + domVariants);
      // 先合并两个 API 来源（aspectsNew 优先于 productDetail）
      const mergedApi = self.mergeVariants(detailVariants, apiVariants);
      // 再合并 DOM 兜底
      let allVariants = self.mergeVariants(domVariants, mergedApi);
      allVariants = self.filterDiscountedVariants(allVariants, sku);
      console.log('[GeekOzon] scanAsync 合并后变体数: ' + allVariants.length, allVariants.slice(0, 3).map(function (v) { return { sku: v.sku, title: v.title, coverImage: v.coverImage ? v.coverImage.slice(0, 40) : '(无)' }; }));

      // 4.1 若页面端变体为空，调用方法4+方法5（seller.ozon.ru 跨 tab 借权）
      // 对齐毛子 ERP ah() 函数：当页面端无法获取变体时，通过卖家中心 API 兜底
      if (allVariants.length === 0) {
        try {
          const sellerVariants = await self.fetchVariantsViaSeller(sku);
          if (sellerVariants && sellerVariants.length > 0) {
            allVariants = self.filterDiscountedVariants(sellerVariants, sku);
          }
        } catch (e) {
          // 跨 tab 借权失败不阻断主流程
          console.warn('[GeekOzon] seller.ozon.ru 变体兜底失败', e);
        }
      }

      product.variants = allVariants;
      product.skuList = allVariants;

      // 5. 用 API 返回的商品信息补全 DOM 缺失的字段
      if (detailRes && detailRes.product) {
        if (!product.title && detailRes.product.title) {
          product.title = detailRes.product.title;
        }
        if (detailRes.product.images && detailRes.product.images.length) {
          // DOM 可能只渲染当前可见缩略图，API 图集必须做并集合并而非仅在空时兜底。
          const apiImages = detailRes.product.images.map(function (u) {
            return stripImageSize(typeof u === 'string' ? u : (u.url || u.src || ''));
          }).filter(Boolean);
          product.images = Array.from(new Set((product.images || []).concat(apiImages)));
          product.mainImage = product.images[0] || product.mainImage;
        }
        // 视频补全（对齐毛子 ERP oe() 函数：从 webGallery.videos 提取）
        if (detailRes.product.videos && detailRes.product.videos.length > 0) {
          product.videos = detailRes.product.videos;
        }
        // 关键修复：用 webPrice widget 的 price 覆盖 DOM 提取的价格
        // DOM extractPrice() 可能取到划线价，且 aspectsNew API 返回的 price 可能与页面显示不一致
        // webPrice widget 的 price 字段是用户在商品页看到的当前售价（最准确）
        if (detailRes.product.price != null && detailRes.product.price > 0) {
          product.price = detailRes.product.price;
          product.originalPrice = detailRes.product.originalPrice || 0;
          product.cardPrice = detailRes.product.cardPrice || 0;
          // 对齐毛子 ERP：使用 webPrice 检测到的货币（ee() 函数的等效行为）
          // detailRes.product.currency 由 detectCurrencyFromPrice() 从 priceWidget.price 字符串检测得到
          if (detailRes.product.currency) {
            product.currency = detailRes.product.currency;
          }
        }
      }

      // 6. 为每个变体获取真实页面价格（对齐毛子 ERP we() 函数）
      // aspectsNew API 返回的 price 字段不准确，需调用 /product/{sku}/ 读取 webPrice widget
      // 分批获取最多 60 个变体，兼顾大规格商品覆盖率和 Ozon 限流。
      if (allVariants.length > 0) {
        try {
          const variantsToPrice = allVariants.slice(0, 60);
          const priceResults = [];
          for (let start = 0; start < variantsToPrice.length; start += 6) {
            const batch = variantsToPrice.slice(start, start + 6);
            const batchResults = await Promise.all(batch.map(function (v) {
              return self.fetchVariantPrice(v.sku).then(function (priceInfo) {
                return { sku: v.sku, priceInfo: priceInfo };
              }).catch(function () {
                return { sku: v.sku, priceInfo: null };
              });
            }));
            priceResults.push.apply(priceResults, batchResults);
          }
          const priceMap = Object.create(null);
          for (let i = 0; i < priceResults.length; i++) {
            const r = priceResults[i];
            if (r && r.sku && r.priceInfo) {
              priceMap[r.sku] = r.priceInfo;
            }
          }
          // 用真实页面价格覆盖 aspectsNew 返回的不准确价格
          for (let i = 0; i < allVariants.length; i++) {
            const v = allVariants[i];
            const pi = priceMap[v.sku];
            if (pi) {
              // 仅当 webPrice 返回有效价格时才覆盖
              if (pi.price != null && pi.price > 0) {
                v.price = pi.price;
              }
              if (pi.originalPrice != null) {
                v.originalPrice = pi.originalPrice;
              }
              if (pi.cardPrice != null && pi.cardPrice > 0) {
                v.cardPrice = pi.cardPrice;
              }
              v._source = 'webPrice';
            }
          }
          if (allVariants.length > variantsToPrice.length) {
            product.variantPriceCoverage = {
              total: allVariants.length,
              checked: variantsToPrice.length,
              truncated: true,
            };
          }
        } catch (e) {
          // 价格获取失败不影响主流程，使用 aspectsNew 兜底
          console.warn('[GeekOzon] 变体价格获取失败，使用 aspectsNew 兜底', e);
        }
      }

      // === 字段统一：originalPrice → oldPrice ===
      // 全系统（后端 ALLOWED_UPDATE_FIELDS、前端 generateSkuTable/collectSkuTableData、
      // product-mapping.js buildOzonPayload）统一使用 oldPrice。
      // Ozon scanner 历史代码使用 originalPrice，此处做兼容映射，避免划线价丢失。
      if (product.originalPrice != null && product.oldPrice == null) {
        product.oldPrice = product.originalPrice;
      }
      // variants / skuList 中的 originalPrice 也统一映射到 oldPrice
      const _syncArrays = [product.variants, product.skuList];
      for (const arr of _syncArrays) {
        if (Array.isArray(arr)) {
          for (const v of arr) {
            if (v && v.originalPrice != null && v.oldPrice == null) {
              v.oldPrice = v.originalPrice;
            }
          }
        }
      }

      // Rich Content often finishes rendering after the price/gallery widgets.
      // Re-read it at the end of the async scan and replace the early snapshot.
      const latestRichContent = this.extractRichContent();
      if (latestRichContent) {
        product.richContent = latestRichContent;
        product.description = '';
        let richJson = '';
        try { richJson = JSON.stringify(latestRichContent); } catch (_) {}
        if (richJson) {
          if (!Array.isArray(product.attributes)) product.attributes = [];
          product.attributes = product.attributes.filter(function (a) {
            return String(a && (a.id || a.attrId || a.attribute_id) || '') !== '11254' &&
                   !(a && a.name && /JSON富内容|Rich-контент|Rich content/i.test(a.name));
          });
          product.attributes.push({
            id: 11254,
            name: 'JSON富内容（Rich-контент JSON）',
            value: richJson,
          });
        }
      }
      product.detailImages = this.extractDetailImages();

      return this.finalizeProductSnapshot(product, ['dom', 'json-ld', 'product-detail-api', 'variants-api']);
    }
  }

  // ===== 实例化 + 暴露入口 =====
  const scannerInstance = new OzonScanner();

  /** 同步采集（仅当前 DOM） */
  window.__geekOzonScan = function () {
    return scannerInstance.scan();
  };

  /** 异步采集（等待加载完成） */
  window.__geekOzonScanAsync = function () {
    return scannerInstance.scanAsync();
  };

  /** 返回采集与一键上架共用的最后一次完整快照。 */
  window.__geekOzonGetLastProduct = function () {
    return scannerInstance.lastProduct || null;
  };

  /** 异步采集并提交到后端 */
  window.__geekOzonCollect = function (extra) {
    return scannerInstance.collect(extra);
  };

  /** 防重复注入标志 */
  window.__geekOzonOzonScannerLoaded = true;

  /** 暴露 class 与实例 */
  G.features.OzonScanner = OzonScanner;
  G.features.ozonScannerInstance = scannerInstance;

  G.markLoaded('ozon-scanner');
  console.log('[GeekOzon] ozon-scanner 已加载');
})();
