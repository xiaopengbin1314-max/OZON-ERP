/** Shared structured-data fallback for non-Ozon marketplace scanners. */
;(function () {
  'use strict';

  const G = window.GeekOzon;
  if (!G || G.isLoaded('structured-data')) return;

  function list(value) {
    if (!value) return [];
    return Array.isArray(value) ? value : [value];
  }

  function absoluteUrl(value) {
    if (!value || typeof value !== 'string') return '';
    try { return new URL(value, location.href).href; } catch (_) { return ''; }
  }

  function productNodes(value, output) {
    if (!value || typeof value !== 'object') return;
    if (Array.isArray(value)) {
      value.forEach(function (item) { productNodes(item, output); });
      return;
    }
    const type = value['@type'];
    if (type === 'Product' || (Array.isArray(type) && type.indexOf('Product') >= 0)) output.push(value);
    if (value['@graph']) productNodes(value['@graph'], output);
  }

  function readJsonLd() {
    const nodes = [];
    document.querySelectorAll('script[type="application/ld+json"]').forEach(function (script) {
      try { productNodes(JSON.parse(script.textContent || ''), nodes); } catch (_) {}
    });
    return nodes[0] || {};
  }

  function meta(selectors) {
    for (let i = 0; i < selectors.length; i++) {
      const el = document.querySelector(selectors[i]);
      const value = el && (el.getAttribute('content') || el.getAttribute('value'));
      if (value) return value.trim();
    }
    return '';
  }

  function merge(product) {
    product = product || {};
    const data = readJsonLd();
    const offers = Array.isArray(data.offers) ? data.offers[0] || {} : data.offers || {};
    const brand = typeof data.brand === 'object' ? data.brand.name : data.brand;
    const images = list(data.image).map(function (item) {
      return absoluteUrl(typeof item === 'object' ? item.url || item.contentUrl : item);
    }).filter(Boolean);
    const metaImage = absoluteUrl(meta(['meta[property="og:image"]', 'meta[name="twitter:image"]']));
    if (metaImage) images.push(metaImage);

    product.title = product.title || data.name || meta(['meta[property="og:title"]', 'meta[name="twitter:title"]']);
    product.description = product.description || data.description || meta(['meta[property="og:description"]', 'meta[name="description"]']);
    product.brand = product.brand || brand || '';
    product.category = product.category || data.category || '';
    product.price = product.price || String(offers.price || offers.lowPrice || meta(['meta[property="product:price:amount"]']) || '').replace(/[^0-9.,]/g, '').replace(',', '.');
    product.currency = product.currency || offers.priceCurrency || meta(['meta[property="product:price:currency"]']);
    product.sku = product.sku || data.sku || data.mpn || data.productID || '';
    product.mainImage = product.mainImage || images[0] || '';
    product.images = Array.from(new Set(list(product.images).concat(images).filter(Boolean)));
    product.sourceUrl = product.sourceUrl || data.url || location.href;

    const properties = list(data.additionalProperty).map(function (entry) {
      return entry && entry.name && entry.value ? { name: String(entry.name), value: String(entry.value) } : null;
    }).filter(Boolean);
    if ((!product.attributes || !product.attributes.length) && properties.length) product.attributes = properties;
    return product;
  }

  G.core.StructuredData = { merge: merge, readJsonLd: readJsonLd };
  G.markLoaded('structured-data');
})();
