/**
 * GeekOzon 扩展 - 速卖通（AliExpress）商品采集器
 * 支持 aliexpress.ru/item/{id}.html 或 aliexpress.com/item/{id}.html 详情页采集
 * 继承 ScannerBase，提供 extractProductData / getSkuFromUrl / scan / scanAsync
 */
;(function () {
  'use strict';

  const G = window.GeekOzon;
  if (!G || G.isLoaded('aliexpress-scanner')) return;
  if (!G.core || !G.core.ScannerBase) return;

  const DomUtils = G.core.DomUtils;

  /** 从一组选择器中取第一个匹配元素的文本 */
  function pickText(selectors) {
    for (let i = 0; i < selectors.length; i++) {
      const el = document.querySelector(selectors[i]);
      if (el) return (el.textContent || '').trim();
    }
    return '';
  }

  /** 从一组选择器中取第一个匹配元素的 src */
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

  /** 规范化图片 URL */
  function normalizeImgUrl(url) {
    if (!url) return '';
    if (url.startsWith('//')) return location.protocol + url;
    if (url.startsWith('/')) return location.origin + url;
    return url;
  }

  /**
   * 速卖通采集器
   */
  class AliexpressScanner extends G.core.ScannerBase {
    /** 平台标识 */
    getPlatform() {
      return 'aliexpress';
    }

    /** 从 URL 提取速卖通商品 ID（/item/{id}.html） */
    getSkuFromUrl() {
      const u = location.href;
      let m = u.match(/\/item\/(\d+)/i);
      if (m) return m[1];
      // 兜底：?item_id= 或 ?productId= 或 ?spm=...&id=
      m = u.match(/[?&](?:item_id|productId|id)=(\d+)/i);
      return m ? m[1] : '';
    }

    /** 从页面 DOM 提取商品数据 */
    extractProductData() {
      const product = this.createBlankProduct();
      product.sku = this.getSkuFromUrl();
      // 速卖通俄罗斯站价格可能是 RUB，国际站 USD
      const host = location.hostname || '';
      product.currency = /aliexpress\.ru/i.test(host) ? 'RUB' : 'USD';

      // 标题
      product.title = pickText([
        '.product-title',
        'h1.title',
        'h1[class*="title"]',
        '[data-pl="product-title"]',
        '.product-info-text h1',
      ]);

      // 价格
      const priceText = pickText([
        '.product-price-value',
        '.price--current',
        '.product-price .price',
        '[data-pl="product-price"]',
        '.p-price .price',
      ]);
      product.price = priceText.replace(/[^\d.]/g, '');

      // 主图
      const mainImg = pickSrc([
        '.magnifier img',
        '.slider-image',
        '.product-image img',
        '[data-pl="image"] img',
        '.main-image img',
      ]);
      product.mainImage = normalizeImgUrl(mainImg);

      // 图片集
      const imgEls = document.querySelectorAll(
        '.slider-image, .product-image img, .preview-list img, .magnifier img, [data-pl="image"] img'
      );
      const imgs = [];
      imgEls.forEach(function (img) {
        const src = normalizeImgUrl(img.getAttribute('src') || img.getAttribute('data-src') || '');
        if (src && imgs.indexOf(src) === -1) imgs.push(src);
      });
      if (imgs.length === 0 && product.mainImage) imgs.push(product.mainImage);
      product.images = imgs;

      // 店铺名
      product.shopName = pickText([
        '.shop-name',
        '.store-name',
        '[data-pl="store-name"]',
        '.seller-name',
      ]);

      return product;
    }

    /** 异步采集（速卖通是 SPA，等待更久） */
    async scanAsync() {
      await DomUtils.waitForElement(
        '.product-title, h1.title, h1[class*="title"], [data-pl="product-title"]',
        10000
      );
      await new Promise(function (r) { setTimeout(r, 600); });
      return this.scan();
    }
  }

  const scanner = new AliexpressScanner();

  // 防重复注入
  if (window.__geekOzonAliexpressScannerLoaded) return;
  window.__geekOzonAliexpressScannerLoaded = true;

  window.__geekOzonScan = function () { return scanner.scan(); };
  window.__geekOzonScanAsync = function () { return scanner.scanAsync(); };
  window.__geekOzonCollect = function (extra) { return scanner.collect(extra); };

  G.features = G.features || {};
  G.features.AliexpressScanner = scanner;

  G.markLoaded('aliexpress-scanner');
  console.log('[GeekOzon] 速卖通采集器已加载');
})();
