/**
 * GeekOzon 扩展 - 1688（阿里巴巴）商品采集器
 * 支持 detail.1688.com/offer/{id}.html 详情页采集
 * 继承 ScannerBase，提供 extractProductData / getSkuFromUrl / scan / scanAsync
 */
;(function () {
  'use strict';

  const G = window.GeekOzon;
  if (!G || G.isLoaded('alibaba-scanner')) return;
  if (!G.core || !G.core.ScannerBase) return;

  const DomUtils = G.core.DomUtils;

  /**
   * 从一组选择器中取第一个匹配元素的文本
   * @param {string[]} selectors
   * @returns {string}
   */
  function pickText(selectors) {
    for (let i = 0; i < selectors.length; i++) {
      const el = document.querySelector(selectors[i]);
      if (el) return (el.textContent || '').trim();
    }
    return '';
  }

  /**
   * 从一组选择器中取第一个匹配元素的 src
   * @param {string[]} selectors
   * @returns {string}
   */
  function pickSrc(selectors) {
    for (let i = 0; i < selectors.length; i++) {
      const el = document.querySelector(selectors[i]);
      if (el) {
        const src = el.getAttribute('src') || el.getAttribute('data-src') || el.src || '';
        if (src) return src;
      }
    }
    return '';
  }

  /** 规范化图片 URL（补全协议） */
  function normalizeImgUrl(url) {
    if (!url) return '';
    if (url.startsWith('//')) return location.protocol + url;
    if (url.startsWith('/')) return location.origin + url;
    return url;
  }

  function original1688Image(url) {
    url = normalizeImgUrl(url || '');
    return url.replace(/\.jpg_(?:sum|b)\.jpg$/i, '.jpg').replace(/_\d+x\d+\.(jpg|png|webp)$/i, '.$1');
  }

  function elementImage(el) {
    if (!el) return '';
    const img = el.matches && el.matches('img') ? el : el.querySelector('img');
    let url = img && (img.getAttribute('data-src') || img.getAttribute('data-lazy') || img.src);
    if (!url) {
      const background = window.getComputedStyle(el).backgroundImage || '';
      const match = background.match(/url\(["']?([^"')]+)["']?\)/i);
      url = match ? match[1] : '';
    }
    return original1688Image(url);
  }

  function numericPrice(text) {
    const match = String(text || '').replace(/,/g, '.').match(/\d+(?:\.\d+)?/);
    return match ? Number(match[0]) : 0;
  }

  function collectSkuRows() {
    const strategies = [
      {
        selector: '.sku-item-wrapper',
        name: '.sku-item-name, .sku-item-name-text',
        price: '.discountPrice-price, .sku-item-price',
        image: '.sku-item-image, .sku-item-img, .sku-wrapper-img',
      },
      {
        selector: '.expand-view-item',
        name: '.item-label', price: '.item-price-stock', image: 'img',
      },
      {
        selector: '.sku-list-item',
        name: '.sku-item-name-text, .sku-item-name', price: '.sku-item-price', image: 'img',
      },
      {
        selector: '.single-sku-list-wrap',
        name: '.single-sku-title span:last-child', price: '.price-title', image: '.single-sku-img-pop',
      },
      {
        selector: '.next-table-body table tr',
        name: 'span.normal-text', price: '.price', image: '.od-gyp-pc-sku-selection-sku',
      },
    ];
    for (let s = 0; s < strategies.length; s++) {
      const strategy = strategies[s];
      const rows = [];
      document.querySelectorAll(strategy.selector).forEach(function (node, index) {
        const nameEl = node.querySelector(strategy.name);
        const name = (nameEl && nameEl.textContent || '').replace(/\s+/g, ' ').trim() || ('规格' + (index + 1));
        const priceEl = node.querySelector(strategy.price);
        const imageEl = node.querySelector(strategy.image) || node;
        if (name) rows.push({ name: name, price: numericPrice(priceEl && priceEl.textContent), image: elementImage(imageEl) });
      });
      if (rows.length) return rows;
    }
    return [];
  }

  function collectSkuOptions() {
    const options = [];
    const selectors = [
      '.prop-item-inner-wrapper', '.sku-filter-button',
      '.sku-props-list .selector-prop-item', '.od-gyp-pc-sku-selection-sku',
      '[class*="sku"] [class*="prop-item"]', '[class*="sku"] [class*="filter-button"]',
    ];
    document.querySelectorAll(selectors.join(',')).forEach(function (node) {
      const labelEl = node.querySelector(
        '.prop-name, .label-name, .prop-item-text, .sku-item-name, ' +
        '[class*="label"], [class*="name"], span'
      );
      const name = (labelEl && labelEl.textContent || node.getAttribute('title') || '')
        .replace(/\s+/g, ' ').trim();
      if (!name || name.length > 100 || options.some(function (item) { return item.name === name; })) return;
      options.push({ name: name, image: elementImage(node) });
    });
    return options;
  }

  function imagesFromInlineScripts() {
    const output = [];
    document.querySelectorAll('script:not([src])').forEach(function (script) {
      const text = script.textContent || '';
      if (text.indexOf('alicdn') === -1 && text.indexOf('1688') === -1) return;
      const matches = text.match(/https?:\\?\/\\?\/[A-Za-z0-9._~:/?#[\]@!$&'()*+,;=%-]+?\.(?:jpg|jpeg|png|webp)(?:_[A-Za-z0-9.]+)?/gi) || [];
      matches.slice(0, 200).forEach(function (url) {
        url = original1688Image(url.replace(/\\\//g, '/'));
        if (url && output.indexOf(url) === -1) output.push(url);
      });
    });
    return output;
  }

  function collectAttributes() {
    const result = [];
    document.querySelectorAll(
      '.offer-attr-item, .attr-item, .offer-attr-list li, .mod-detail-attributes tr, ' +
      '#productPackInfo tr, .od-pc-attribute-list li, .od-pc-offer-attribute li, ' +
      '[class*="attribute-item"], [class*="offer-attr"] li'
    ).forEach(function (row) {
      const nameEl = row.querySelector('.name, .attr-name, th, dt, [class*="name"]');
      const valueEl = row.querySelector('.value, .attr-value, td, dd, [class*="value"]');
      const name = (nameEl && nameEl.textContent || '').replace(/[:：]\s*$/, '').trim();
      const value = (valueEl && valueEl.textContent || '').trim();
      if (name && value && name !== value && !result.some(function (item) { return item.name === name; })) {
        result.push({ name: name, value: value });
      }
    });
    return result;
  }

  /**
   * 1688 采集器
   */
  class AlibabaScanner extends G.core.ScannerBase {
    /** 平台标识 */
    getPlatform() {
      return '1688';
    }

    /** 从 URL 提取 1688 商品 ID（/offer/{id}.html） */
    getSkuFromUrl() {
      const u = location.href;
      const m = u.match(/\/offer\/(\d+)/i);
      return m ? m[1] : '';
    }

    /** 从页面 DOM 提取商品数据 */
    extractProductData() {
      const product = this.createBlankProduct();
      product.sku = this.getSkuFromUrl();
      product.currency = 'CNY';

      // 标题：多个选择器兜底
      product.title = pickText([
        '.module-od-title .title-content h1',
        '.title-content h1',
        '.title-content',
        '.title-text',
        '[data-module="offerTitle"]',
        '.offer-title',
        '.mod-detail-title',
        'h1.title',
      ]);

      // 价格
      const priceText = pickText([
        '.price-content',
        '[data-module="price"]',
        '.price .value',
        '.mod-detail-price .value',
        '.obj-price',
      ]);
      product.price = priceText.replace(/[^\d.]/g, '');

      // 主图
      const mainImg = pickSrc([
        '.detail-gallery-img',
        '[data-module="gallery"] img',
        '.gallery-img img',
        '#dt-tab img',
      ]);
      product.mainImage = normalizeImgUrl(mainImg);

      // 图片集
      const imgEls = document.querySelectorAll(
        '.gallery-img img, .main-image img, .detail-gallery-img img, .thumb-img img, .thumbnail img, ' +
        '.detail-gallery img, .preview-list img, .fd-clr img, .od-pc-offer-tab img, ' +
        '.offer-detail-tab img, .main-pic img, .pic-view img, .detail-pic img, ' +
        '[data-module="gallery"] img, .gallery-list img, .tab-trigger img'
      );
      const imgs = [];
      imgEls.forEach(function (img) {
        const src = original1688Image(img.getAttribute('src') || img.getAttribute('data-src') || img.getAttribute('data-lazy') || '');
        if (src && imgs.indexOf(src) === -1) imgs.push(src);
      });
      if (imgs.length === 0 && product.mainImage) imgs.push(product.mainImage);
      product.images = imgs;
      imagesFromInlineScripts().forEach(function (url) {
        if (product.images.indexOf(url) === -1) product.images.push(url);
      });
      if (!product.mainImage && product.images.length) product.mainImage = product.images[0];
      product.detailImages = Array.from(document.querySelectorAll(
        '.detail-content img, .detail-desc img, .desc-lazyload-container img, ' +
        '.offer-detail-content img, [class*="detail"] [data-src], [class*="description"] img'
      )).map(function (img) {
        return original1688Image(img.getAttribute('data-src') || img.getAttribute('data-lazy') || img.src || '');
      }).filter(function (url, index, all) { return url && all.indexOf(url) === index; });

      const video = document.querySelector('video source, .video-player source, video');
      product.videos = video && (video.src || video.getAttribute('src')) ? [video.src || video.getAttribute('src')] : [];

      let skuRows = collectSkuRows();
      const skuOptions = collectSkuOptions();
      if (skuOptions.length > 1 && skuRows.length <= 1) {
        const base = skuRows[0] || { price: numericPrice(priceText), image: '' };
        skuRows = skuOptions.map(function (option) {
          return { name: option.name, price: base.price, image: option.image || base.image };
        });
      }
      if (skuRows.length) {
        const values = skuRows.map(function (row) { return row.name; });
        product.skuAttrs = [{ name: '规格选项', values: values, skuType: 'text', attrCategory: 'sales' }];
        product.skus = skuRows.map(function (row, index) {
          return {
            skuCode: product.sku + '-' + (index + 1),
            offerId: product.sku + '-' + (index + 1),
            price: row.price,
            images: row.image ? [row.image] : [],
            combo: { '规格选项': row.name },
          };
        });
        product.skuList = product.skus.map(function (row) { return Object.assign({}, row); });
      }
      product.attributes = collectAttributes();

      // 类目：1688 多次改版，提供多个兜底选择器
      // 取面包屑最后一级文本作为源类目
      product.category = pickText([
        // 当前 1688 详情页常用选择器
        '.crumb .last',
        '.breadcrumb .last',
        '.mod-crumb a:last-child',
        // 1688 新版面包屑
        '.obj-header .crumb a:last-child',
        '[data-spm="breadcrumb"] a:last-child',
        '[data-spm-filter="breadcrumb"] a:last-child',
        // 通用面包屑
        'nav[aria-label="breadcrumb"] a:last-child',
        'nav[aria-label="面包屑"] a:last-child',
        '.breadcrumb a:last-child',
        '[class*="crumb"] a:last-child',
        '[class*="Crumb"] a:last-child',
        // 1688 SKU 区上方的分类标签
        '.obj-content .cat-name',
        '.detail-attr .cat',
      ]);

      // Keep the complete breadcrumb because a leaf name alone is often
      // ambiguous when mapping a 1688 category to the Ozon category tree.
      try {
        const breadcrumbSelectors = [
          '.crumb a', '.breadcrumb a', '.mod-crumb a',
          '.od-pc-breadcrumb a', '.module-od-breadcrumb a',
          '.obj-header .crumb a', '[data-spm="breadcrumb"] a',
          '[data-spm-filter="breadcrumb"] a',
          'nav[aria-label="breadcrumb"] a',
          '[class*="crumb"] a', '[class*="Crumb"] a',
        ];
        for (let i = 0; i < breadcrumbSelectors.length; i++) {
          const segments = Array.from(document.querySelectorAll(breadcrumbSelectors[i]))
            .map(function (el) { return (el.textContent || '').replace(/\s+/g, ' ').trim(); })
            .filter(function (text) { return text && text.length <= 100; });
          const unique = segments.filter(function (text, index) { return segments.indexOf(text) === index; });
          if (unique.length) {
            product.categoryPath = unique.join(' / ');
            product.category = unique[unique.length - 1];
            break;
          }
        }
      } catch (_) {}

      // 兜底1: 从页面 JSON 提取 categoryName（1688 内嵌 JSON 常含类目路径）
      if (!product.category) {
        try {
          const scripts = document.querySelectorAll('script:not([src])');
          for (let i = 0; i < scripts.length; i++) {
            const txt = scripts[i].textContent || '';
            if (txt.indexOf('categoryName') < 0) continue;
            // 匹配 "categoryName":"XXX > YYY" 或多级路径
            const m = txt.match(/"categoryName"\s*:\s*"([^"]{2,200})"/);
            if (m) {
              const cat = m[1].trim();
              // 取路径最后一级作为类目
              const parts = cat.split(/[>/、|]+/).map(function (s) { return s.trim(); }).filter(Boolean);
              if (parts.length) {
                product.categoryPath = parts.join(' / ');
                product.category = parts[parts.length - 1];
                break;
              }
            }
          }
        } catch (_) {}
      }

      // 兜底2: 从 title 标签反推（1688 标题常含类目名，如 "XXX_价格_厂家_1688采购批发"）
      // 仅在前两个策略都失败时使用，取第一个分隔段作类目
      if (!product.category) {
        try {
          const titleText = document.title || '';
          // 1688 详情页 title 形如 "商品名-价格-厂家-批发" 或 "商品名_厂家"
          const parts = titleText.split(/[-_|·]+/).map(function (s) { return s.trim(); }).filter(Boolean);
          // 排除明显的非类目段
          const STOP = new Set(['1688', '阿里巴巴', '批发', '价格', '厂家', '采购', 'alibaba', '淘宝', '天猫']);
          for (let i = 0; i < parts.length; i++) {
            const p = parts[i];
            if (p.length >= 2 && p.length <= 20 && !STOP.has(p.toLowerCase())) {
              // 第一个非停用词段作为类目（弱信号，仅作兜底）
              product.category = p;
              break;
            }
          }
        } catch (_) {}
      }

      // 品牌
      product.brand = pickText([
        '.offer-attr .brand',
        '.attr-item[data-key="品牌"] .value',
      ]);

      // 店铺名
      product.shopName = pickText([
        '.shop-name',
        '.company-name',
        '.mod-detail-shop .name',
        '[data-module="shopCard"] .name',
      ]);

      return product;
    }

    /** 异步采集：等待异步渲染完成后再提取 */
    async scanAsync() {
      // 等待标题元素出现
      await DomUtils.waitForElement(
        '.module-od-title .title-content h1, .title-content h1, .title-text, ' +
        '[data-module="offerTitle"], .offer-title, .mod-detail-title',
        8000
      );
      // 二次保险：再等一小段让价格/图片渲染
      await new Promise(function (r) { setTimeout(r, 400); });
      return this.scan();
    }
  }

  /** 单例 */
  const scanner = new AlibabaScanner();

  // 防重复注入标志
  if (window.__geekOzonAlibabaScannerLoaded) return;
  window.__geekOzonAlibabaScannerLoaded = true;

  /** 同步采集入口 */
  window.__geekOzonScan = function () {
    return scanner.scan();
  };

  /** 异步采集入口 */
  window.__geekOzonScanAsync = function () {
    return scanner.scanAsync();
  };

  /** 提交采集（含后端写入） */
  window.__geekOzonCollect = function (extra) {
    return scanner.collect(extra);
  };

  G.features = G.features || {};
  G.features.AlibabaScanner = scanner;

  G.markLoaded('alibaba-scanner');
  console.log('[GeekOzon] 1688 采集器已加载');
})();
