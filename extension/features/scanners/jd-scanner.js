/**
 * GeekOzon 扩展 - 京东（JD）商品采集器
 * 支持 item.jd.com/{id}.html 详情页采集
 * 继承 ScannerBase，提供 extractProductData / getSkuFromUrl / scan / scanAsync
 */
;(function () {
  'use strict';

  const G = window.GeekOzon;
  if (!G || G.isLoaded('jd-scanner')) return;
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
   * 京东采集器
   */
  class JdScanner extends G.core.ScannerBase {
    /** 平台标识 */
    getPlatform() {
      return 'jd';
    }

    /** 从 URL 提取京东商品 ID（item.jd.com/{id}.html） */
    getSkuFromUrl() {
      const u = location.href;
      let m = u.match(/item\.jd\.com\/(\d+)/i);
      if (m) return m[1];
      // 兜底：product/{id}.html
      m = u.match(/\/product\/(\d+)/i);
      if (m) return m[1];
      // 通用：路径首段纯数字
      m = u.match(/\/(\d{6,})\.html/i);
      return m ? m[1] : '';
    }

    /** 从页面 DOM 提取商品数据 */
    extractProductData() {
      const product = this.createBlankProduct();
      product.sku = this.getSkuFromUrl();
      product.currency = 'CNY';

      // 标题
      product.title = pickText([
        '.itemInfo-wrap .sku-name .sku-name-title',
        '.sku-title-name',
        '.itemInfo-wrap .sku-name',
        '#name',
        '.sku-name',
        '.product-intro .sku-name',
        '.itemInfo .sku-name',
      ]);

      // 价格
      const priceText = pickText([
        '#J_FinalPrice .price',
        '.product-price--value',
        '.price',
        '#jd-price',
        '.summary-price .price',
        '.p-price .price',
        '#jd-price-display',
      ]);
      product.price = priceText.replace(/[^\d.]/g, '');

      // 主图
      const mainImg = pickSrc([
        '#spec-img',
        '.spec-list img',
        '#preview .spec-img',
        '.product-intro img',
        '#spec-list .img-selected img',
      ]);
      product.mainImage = normalizeImgUrl(mainImg);

      // 图片集
      const imgEls = document.querySelectorAll(
        '#spec-list li img, .spec-list li img, .preview-list img, .gallery-thumbs img, ' +
        '.page-content-left .image-carousel-track .item img.image'
      );
      const imgs = [];
      imgEls.forEach(function (img) {
        // 京东缩略图常带 /s60x60_ 或 _60x60，替换为原图
        let src = img.getAttribute('src') || img.getAttribute('data-src') || '';
        src = normalizeImgUrl(src);
        src = src.replace(/\/s\d+x\d+_/i, '/');
        src = src.replace(/_\d+x\d+\.(jpg|png|webp)/i, '.$1');
        if (src && imgs.indexOf(src) === -1) imgs.push(src);
      });
      if (imgs.length === 0 && product.mainImage) imgs.push(product.mainImage);
      product.images = imgs;

      // 店铺名
      product.shopName = pickText([
        '.shop-name',
        '.J-hove-wrap .shop-name',
        '.p-shop a',
        '.shop-info .shop-name',
      ]);

      // 品牌
      product.brand = pickText([
        '#parameter-brand li',
        '.p-parameter .brand',
        '.attr-list .brand',
      ]);

      return product;
    }

    /** 异步采集 */
    async scanAsync() {
      await DomUtils.waitForElement(
        '.itemInfo-wrap .sku-name, #name, .sku-name, .product-intro .sku-name',
        8000
      );
      await new Promise(function (r) { setTimeout(r, 400); });
      return this.scan();
    }
  }

  const scanner = new JdScanner();

  // 防重复注入
  if (window.__geekOzonJdScannerLoaded) return;
  window.__geekOzonJdScannerLoaded = true;

  window.__geekOzonScan = function () { return scanner.scan(); };
  window.__geekOzonScanAsync = function () { return scanner.scanAsync(); };
  window.__geekOzonCollect = function (extra) { return scanner.collect(extra); };

  G.features = G.features || {};
  G.features.JdScanner = scanner;

  G.markLoaded('jd-scanner');
  console.log('[GeekOzon] 京东采集器已加载');
})();
