/**
 * GeekOzon 扩展 - 天猫商品采集器
 * 支持 detail.tmall.com/item.htm?id={id} 详情页采集
 * 继承 ScannerBase，提供 extractProductData / getSkuFromUrl / scan / scanAsync
 */
;(function () {
  'use strict';

  const G = window.GeekOzon;
  if (!G || G.isLoaded('tmall-scanner')) return;
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
   * 天猫采集器
   */
  class TmallScanner extends G.core.ScannerBase {
    /** 平台标识 */
    getPlatform() {
      return 'tmall';
    }

    /** 从 URL 提取天猫商品 ID（?id={id}） */
    getSkuFromUrl() {
      const u = location.href;
      const m = u.match(/[?&]id=(\d+)/i);
      return m ? m[1] : '';
    }

    /** 从页面 DOM 提取商品数据 */
    extractProductData() {
      const product = this.createBlankProduct();
      product.sku = this.getSkuFromUrl();
      product.currency = 'CNY';

      // 标题
      product.title = pickText([
        '#J_Title h3',
        '.ItemHeader--mainTitle',
        '.tb-detail-title',
        '.tm-title',
      ]);

      // 价格
      const priceText = pickText([
        '#J_StrPrice',
        '.Price--current',
        '.tm-price',
        '.tb-detail-price .tm-rmb-num',
      ]);
      product.price = priceText.replace(/[^\d.]/g, '');

      // 主图
      const mainImg = pickSrc([
        '#J_ImgBooth',
        '.PicGallery--mainImg img',
        '.tb-main-pic img',
        '#J_ImgView',
      ]);
      product.mainImage = normalizeImgUrl(mainImg);

      // 图片集
      const imgEls = document.querySelectorAll(
        '#J_UlThumb img, .PicGallery--thumb img, .tb-thumb img, .thumbnails img'
      );
      const imgs = [];
      imgEls.forEach(function (img) {
        const src = normalizeImgUrl(img.getAttribute('src') || img.getAttribute('data-src') || '');
        const big = src.replace(/_\d+x\d+\.(jpg|png|webp)/i, '.$1');
        if (big && imgs.indexOf(big) === -1) imgs.push(big);
      });
      if (imgs.length === 0 && product.mainImage) imgs.push(product.mainImage);
      product.images = imgs;

      // 店铺名
      product.shopName = pickText([
        '.shop-name',
        '.tb-seller-name',
        '.SellerInfo--shopName',
        '.tm-shop-name',
      ]);

      // 品牌（天猫详情通常带品牌）
      product.brand = pickText([
        '.attr-list .brand',
        '.tb-attr .brand',
        '[data-key="品牌"] .value',
      ]);

      return product;
    }

    /** 异步采集 */
    async scanAsync() {
      await DomUtils.waitForElement(
        '#J_Title h3, .ItemHeader--mainTitle, .tb-detail-title, .tm-title',
        8000
      );
      await new Promise(function (r) { setTimeout(r, 400); });
      return this.scan();
    }
  }

  const scanner = new TmallScanner();

  // 防重复注入
  if (window.__geekOzonTmallScannerLoaded) return;
  window.__geekOzonTmallScannerLoaded = true;

  window.__geekOzonScan = function () { return scanner.scan(); };
  window.__geekOzonScanAsync = function () { return scanner.scanAsync(); };
  window.__geekOzonCollect = function (extra) { return scanner.collect(extra); };

  G.features = G.features || {};
  G.features.TmallScanner = scanner;

  G.markLoaded('tmall-scanner');
  console.log('[GeekOzon] 天猫采集器已加载');
})();
