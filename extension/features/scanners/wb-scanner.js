/**
 * GeekOzon 扩展 - Wildberries 商品采集器
 * 支持 wildberries.ru/catalog/{id}/detail.aspx 详情页采集
 * 继承 ScannerBase，提供 extractProductData / getSkuFromUrl / scan / scanAsync
 */
;(function () {
  'use strict';

  const G = window.GeekOzon;
  if (!G || G.isLoaded('wb-scanner')) return;
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
   * Wildberries 采集器
   */
  class WbScanner extends G.core.ScannerBase {
    /** 平台标识 */
    getPlatform() {
      return 'wildberries';
    }

    /** 从 URL 提取 WB 商品 ID（/catalog/{id}/detail.aspx） */
    getSkuFromUrl() {
      const u = location.href;
      const m = u.match(/\/catalog\/(\d+)/i);
      return m ? m[1] : '';
    }

    /** 从页面 DOM 提取商品数据 */
    extractProductData() {
      const product = this.createBlankProduct();
      product.sku = this.getSkuFromUrl();
      product.currency = 'RUB';

      // 标题
      product.title = pickText([
        '.product-name',
        'h1',
        '.goods-name',
        '[class*="product-name"]',
      ]);

      // 价格
      const priceText = pickText([
        '.price-block',
        '.final-price',
        '.price-block .price',
        '[class*="price-block"] [class*="price"]',
        '.product-price .price',
      ]);
      product.price = priceText.replace(/[^\d.]/g, '');

      // 主图
      const mainImg = pickSrc([
        '.preview-slide img',
        '.photo-carousel img',
        '.swiper-slide-active img',
        '.main-img img',
        '[class*="preview-slide"] img',
      ]);
      product.mainImage = normalizeImgUrl(mainImg);

      // 图片集
      const imgEls = document.querySelectorAll(
        '.preview-slide img, .photo-carousel img, .swiper-slide img, [class*="preview-slide"] img'
      );
      const imgs = [];
      imgEls.forEach(function (img) {
        const src = normalizeImgUrl(img.getAttribute('src') || img.getAttribute('data-src') || '');
        if (src && imgs.indexOf(src) === -1) imgs.push(src);
      });
      if (imgs.length === 0 && product.mainImage) imgs.push(product.mainImage);
      product.images = imgs;

      // 品牌
      product.brand = pickText([
        '.brand-name',
        '[class*="brand"] a',
        '.goods-brand',
      ]);

      // 店铺名（WB 没有"店铺"概念，取销售方/卖家）
      product.shopName = pickText([
        '.seller-name',
        '[class*="seller"] .name',
        '.shop-name',
      ]);

      return product;
    }

    /** 异步采集（WB 是 SPA，等待更久） */
    async scanAsync() {
      await DomUtils.waitForElement(
        '.product-name, h1, .goods-name, [class*="product-name"]',
        10000
      );
      await new Promise(function (r) { setTimeout(r, 600); });
      return this.scan();
    }
  }

  const scanner = new WbScanner();

  // 防重复注入
  if (window.__geekOzonWbScannerLoaded) return;
  window.__geekOzonWbScannerLoaded = true;

  window.__geekOzonScan = function () { return scanner.scan(); };
  window.__geekOzonScanAsync = function () { return scanner.scanAsync(); };
  window.__geekOzonCollect = function (extra) { return scanner.collect(extra); };

  G.features = G.features || {};
  G.features.WbScanner = scanner;

  G.markLoaded('wb-scanner');
  console.log('[GeekOzon] Wildberries 采集器已加载');
})();
