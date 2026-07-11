/**
 * GeekOzon 扩展 - 拼多多商品采集器
 * 支持 mobile.yangkeduo.com/goods.html?goods_id={id} 详情页采集
 * 继承 ScannerBase，提供 extractProductData / getSkuFromUrl / scan / scanAsync
 */
;(function () {
  'use strict';

  const G = window.GeekOzon;
  if (!G || G.isLoaded('pdd-scanner')) return;
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
   * 拼多多采集器
   */
  class PddScanner extends G.core.ScannerBase {
    /** 平台标识 */
    getPlatform() {
      return 'pdd';
    }

    /** 从 URL 提取拼多多商品 ID（?goods_id={id}） */
    getSkuFromUrl() {
      const u = location.href;
      const m = u.match(/[?&]goods_id=(\d+)/i);
      return m ? m[1] : '';
    }

    /** 从页面 DOM 提取商品数据 */
    extractProductData() {
      const product = this.createBlankProduct();
      product.sku = this.getSkuFromUrl();
      product.currency = 'CNY';

      // 标题
      product.title = pickText([
        '#goods-title',
        '.goods-title',
        '.goods-info-title',
        'h1.title',
      ]);

      // 价格（拼多多价格常带 ¥ 符号或团购价）
      const priceText = pickText([
        '.price',
        '.goods-price',
        '.goods-info-price',
        '.group-price',
      ]);
      product.price = priceText.replace(/[^\d.]/g, '');

      // 主图
      const mainImg = pickSrc([
        '.swiper-slide-active img',
        '.goods-img img',
        '.swiper-slide img',
        '.preview-img img',
      ]);
      product.mainImage = normalizeImgUrl(mainImg);

      // 图片集
      const imgEls = document.querySelectorAll(
        '.swiper-slide img, .goods-img img, .preview-list img, .thumb-list img'
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
        '.mall-name',
        '.goods-mall-name',
        '.merchant-name',
      ]);

      return product;
    }

    /** 异步采集（拼多多移动端 H5 异步渲染较慢，等待更久） */
    async scanAsync() {
      await DomUtils.waitForElement(
        '#goods-title, .goods-title, .goods-info-title, h1.title',
        10000
      );
      await new Promise(function (r) { setTimeout(r, 600); });
      return this.scan();
    }
  }

  const scanner = new PddScanner();

  // 防重复注入
  if (window.__geekOzonPddScannerLoaded) return;
  window.__geekOzonPddScannerLoaded = true;

  window.__geekOzonScan = function () { return scanner.scan(); };
  window.__geekOzonScanAsync = function () { return scanner.scanAsync(); };
  window.__geekOzonCollect = function (extra) { return scanner.collect(extra); };

  G.features = G.features || {};
  G.features.PddScanner = scanner;

  G.markLoaded('pdd-scanner');
  console.log('[GeekOzon] 拼多多采集器已加载');
})();
