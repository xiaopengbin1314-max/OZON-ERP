/**
 * GeekOzon 扩展 - 淘宝商品采集器
 * 支持 item.taobao.com/item.htm?id={id} 详情页采集
 * 继承 ScannerBase，提供 extractProductData / getSkuFromUrl / scan / scanAsync
 */
;(function () {
  'use strict';

  const G = window.GeekOzon;
  if (!G || G.isLoaded('taobao-scanner')) return;
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
   * 淘宝采集器
   */
  class TaobaoScanner extends G.core.ScannerBase {
    /** 平台标识 */
    getPlatform() {
      return 'taobao';
    }

    /** 从 URL 提取淘宝商品 ID（?id={id}） */
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
        '.tb-main-title',
        'h1[data-title]',
      ]);

      // 价格
      const priceText = pickText([
        '#J_StrPrice',
        '.Price--current',
        '.tb-rmb-num',
        '.tb-detail-price .tb-rmb-num',
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
        // 缩略图通常 _60x60.jpg，替换为原图
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
        'a.shopname',
      ]);

      return product;
    }

    /** 异步采集 */
    async scanAsync() {
      await DomUtils.waitForElement(
        '#J_Title h3, .ItemHeader--mainTitle, .tb-main-title',
        8000
      );
      await new Promise(function (r) { setTimeout(r, 400); });
      return this.scan();
    }
  }

  const scanner = new TaobaoScanner();

  // 防重复注入
  if (window.__geekOzonTaobaoScannerLoaded) return;
  window.__geekOzonTaobaoScannerLoaded = true;

  window.__geekOzonScan = function () { return scanner.scan(); };
  window.__geekOzonScanAsync = function () { return scanner.scanAsync(); };
  window.__geekOzonCollect = function (extra) { return scanner.collect(extra); };

  G.features = G.features || {};
  G.features.TaobaoScanner = scanner;

  G.markLoaded('taobao-scanner');
  console.log('[GeekOzon] 淘宝采集器已加载');
})();
