/**
 * GeekOzon 扩展 - 采集器基类
 * 各平台 scanner 的通用逻辑：商品数据提取、提交后端、采集按钮注入
 * 子类需实现 extractProductData() 方法
 */
;(function () {
  'use strict';

  const G = window.GeekOzon;
  if (!G || G.isLoaded('scanner-base')) return;

  const ApiClient = G.core.ApiClient;

  /**
   * 采集器基类
   * 用法：
   *   class OzonScanner extends GeekOzon.core.ScannerBase {
   *     getPlatform() { return 'ozon'; }
   *     extractProductData() { ... return productData; }
   *   }
   */
  class ScannerBase {
    constructor() {
      this.platform = this.getPlatform();
      this.collecting = false;
    }

    /** 子类实现：返回平台标识 */
    getPlatform() { return 'unknown'; }

    /** 子类实现：从当前页面提取商品数据，返回 productData 对象 */
    extractProductData() { return null; }

    /** 子类实现：从 URL 提取商品 SKU/ID */
    getSkuFromUrl() { return ''; }

    /** 同步采集（若数据已在 DOM） */
    scan() {
      try { return this.extractProductData(); }
      catch (e) { console.error('[GeekOzon] scan 异常:', e); return null; }
    }

    /** 异步采集（需等待异步数据加载完成） */
    async scanAsync() {
      // 默认调用同步方法，子类可重写
      return this.scan();
    }

    /**
     * 采集并提交到后端
     * @param {object} extra - 附加数据
     * @returns {Promise<object>} 后端响应
     */
    async collect(extra) {
      if (this.collecting) {
        return { code: -1, msg: '正在采集中，请勿重复提交' };
      }
      this.collecting = true;
      try {
        // scanAsync 由各扫描器负责同步基础采集和异步增强。避免先 scan()
        // 再 scanAsync() 导致动态页面被读取两次并产生不同快照。
        let productData = null;
        try {
          productData = await this.scanAsync();
        } catch (enhanceErr) {
          console.warn('[GeekOzon] scanAsync 增强失败，使用同步采集兜底:', enhanceErr.message);
          productData = this.scan();
        }

        if (!productData) {
          return { code: -1, msg: '未检测到商品数据' };
        }
        if (this.platform !== 'ozon' && G.core.StructuredData) {
          productData = G.core.StructuredData.merge(productData);
        }
        // 合并附加数据
        if (extra) Object.assign(productData, extra);
        productData.platform = this.platform;
        productData.sourceUrl = location.href;
        productData.collectedAt = new Date().toISOString();

        const resp = await ApiClient.collectProduct(productData);
        return resp;
      } catch (e) {
        console.error('[GeekOzon] collect 异常:', e);
        return { code: -1, msg: e.message };
      } finally {
        this.collecting = false;
      }
    }

    /** 标准商品数据结构（子类填充） */
    createBlankProduct() {
      return {
        platform: this.platform,
        sku: '',
        title: '',
        price: '',
        currency: '',
        mainImage: '',
        images: [],
        skuList: [],
        category: '',
        categoryPath: '',
        categoryId: '',
        brand: '',
        shopName: '',
        sourceUrl: location.href,
        description: '',
        attributes: [],
        weight: 0,
        length: 0,
        width: 0,
        height: 0,
      };
    }
  }

  G.core.ScannerBase = ScannerBase;
  G.markLoaded('scanner-base');
})();
