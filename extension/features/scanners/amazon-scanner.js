/** Amazon product scanner, compatible with the shared marketplace data model. */
;(function () {
  'use strict';

  const G = window.GeekOzon;
  if (!G || G.isLoaded('amazon-scanner') || !G.core.ScannerBase) return;

  function text(selectors) {
    for (let i = 0; i < selectors.length; i++) {
      const el = document.querySelector(selectors[i]);
      if (el && el.textContent.trim()) return el.textContent.trim();
    }
    return '';
  }

  class AmazonScanner extends G.core.ScannerBase {
    getPlatform() { return 'amazon'; }

    getSkuFromUrl() {
      const match = location.pathname.match(/\/(?:dp|gp\/product)\/([A-Z0-9]{10})/i);
      return match ? match[1].toUpperCase() : '';
    }

    extractProductData() {
      const product = this.createBlankProduct();
      product.sku = this.getSkuFromUrl();
      product.title = text(['#productTitle', '#title', 'h1']);
      product.price = text([
        '.twisterSwatchPrice',
        '#corePrice_feature_div .a-offscreen',
        '#corePriceDisplay_desktop_feature_div .a-offscreen',
        '.priceToPay .a-offscreen', '#priceblock_ourprice', '#priceblock_dealprice',
      ]).replace(/[^0-9.,]/g, '').replace(',', '.');
      product.brand = text(['#bylineInfo', '#brand', 'tr.po-brand td.a-span9']);
      product.categoryPath = Array.from(document.querySelectorAll('#wayfinding-breadcrumbs_container a'))
        .map(function (el) { return el.textContent.trim(); }).filter(Boolean).join(' / ');
      if (product.categoryPath) product.category = product.categoryPath.split(' / ').pop();

      const images = [];
      document.querySelectorAll(
        '#altImages img, #imageBlock img, #imgTagWrapperId img, #main-image-container img, ' +
        '#landingImage, .background-image img, .aplus-card-image img, .aplus-module-wrapper img'
      ).forEach(function (img) {
        let src = img.getAttribute('data-old-hires') || img.getAttribute('data-a-dynamic-image') || img.src || '';
        if (src && src[0] === '{') {
          try { src = Object.keys(JSON.parse(src))[0] || ''; } catch (_) { src = ''; }
        }
        if (src) images.push(src.replace(/\._[^.]+_\./, '.'));
      });
      product.images = Array.from(new Set(images));
      product.mainImage = product.images[0] || '';
      product.description = text([
        '#feature-bullets .a-list-item', '.a-expander-content .a-unordered-list',
        '#productDescription', '#feature-bullets', '#aplus_feature_div',
      ]);
      return product;
    }

    async scanAsync() {
      await G.core.DomUtils.waitForElement('#productTitle, #title, h1', 10000);
      return this.scan();
    }
  }

  const scanner = new AmazonScanner();
  window.__geekOzonScan = function () { return scanner.scan(); };
  window.__geekOzonScanAsync = function () { return scanner.scanAsync(); };
  window.__geekOzonCollect = function (extra) { return scanner.collect(extra); };
  G.features = G.features || {};
  G.features.AmazonScanner = scanner;
  G.markLoaded('amazon-scanner');
})();
