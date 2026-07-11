"""
数据模型定义模块
定义商品、公告、发布任务、用户等核心数据结构
提供 JSON 文件读写的基础数据访问方法
"""
import json
import os
import uuid
import threading
from datetime import datetime, timezone
from config import Config


class BaseModel:
    """基础模型，提供通用 CRUD 操作

    使用 threading.Lock 保护内存缓存和文件写入，避免多线程并发导致数据丢失。
    注意：此锁仅保护单进程内的并发，多进程部署需额外使用文件锁。
    """

    FILE_PATH = ""  # 子类需指定数据文件路径
    _cache = {}     # 内存缓存
    _loaded = False
    _lock = threading.Lock()  # 类级线程锁，保护 _cache 和文件写入

    @classmethod
    def _ensure_loaded(cls):
        """懒加载：首次使用时读取文件到内存"""
        if cls._loaded:
            return
        with cls._lock:
            if cls._loaded:  # 双重检查，避免重复加载
                return
            cls._load_from_file()
            cls._loaded = True

    @classmethod
    def _load_from_file(cls):
        """从 JSON 文件加载数据（调用方需持有锁）"""
        if os.path.exists(cls.FILE_PATH):
            try:
                with open(cls.FILE_PATH, 'r', encoding='utf-8') as f:
                    cls._cache = json.load(f)
            except (json.JSONDecodeError, IOError):
                cls._cache = []
        else:
            cls._cache = []

    @classmethod
    def _save_to_file(cls):
        """将内存数据写入文件（调用方需持有锁）

        采用先写临时文件再原子替换的策略，避免写入过程中崩溃导致数据损坏。
        """
        tmp_path = cls.FILE_PATH + '.tmp'
        with open(tmp_path, 'w', encoding='utf-8') as f:
            json.dump(cls._cache, f, ensure_ascii=False, indent=2, default=str)
        # Windows 下 os.replace 可原子替换
        os.replace(tmp_path, cls.FILE_PATH)

    @classmethod
    def generate_id(cls, prefix="id"):
        """生成唯一 ID"""
        return f"{prefix}_{uuid.uuid4().hex[:10]}"

    @classmethod
    def now_iso(cls):
        """获取当前 ISO 格式时间"""
        return datetime.now(timezone.utc).isoformat()

    @classmethod
    def find_all(cls, filters=None):
        """查询全部记录，支持简单过滤"""
        cls._ensure_loaded()
        with cls._lock:
            items = list(cls._cache)
        if filters:
            for key, value in filters.items():
                if value is not None and value != '':
                    items = [item for item in items if item.get(key) == value]
        return items

    @classmethod
    def find_by_id(cls, item_id):
        """按 ID 查找单条记录"""
        cls._ensure_loaded()
        with cls._lock:
            for item in cls._cache:
                if item.get('id') == item_id:
                    return item
        return None

    @classmethod
    def create(cls, data):
        """创建新记录"""
        cls._ensure_loaded()
        with cls._lock:
            data['id'] = cls.generate_id()
            data['createdAt'] = cls.now_iso()
            data['updatedAt'] = cls.now_iso()
            cls._cache.append(data)
            cls._save_to_file()
            return data

    @classmethod
    def update(cls, item_id, update_data):
        """更新记录"""
        cls._ensure_loaded()
        with cls._lock:
            for i, item in enumerate(cls._cache):
                if item.get('id') == item_id:
                    update_data['updatedAt'] = cls.now_iso()
                    cls._cache[i] = {**item, **update_data}
                    cls._save_to_file()
                    return cls._cache[i]
        return None

    @classmethod
    def delete(cls, item_id):
        """删除记录"""
        cls._ensure_loaded()
        with cls._lock:
            original_len = len(cls._cache)
            cls._cache = [item for item in cls._cache if item.get('id') != item_id]
            if len(cls._cache) < original_len:
                cls._save_to_file()
                return True
        return False

    @classmethod
    def count(cls, filters=None):
        """统计数量"""
        return len(cls.find_all(filters))


class Product(BaseModel):
    """商品模型"""
    FILE_PATH = Config.PRODUCTS_FILE

    @classmethod
    def create(cls, data):
        """创建商品，设置默认字段"""
        defaults = {
            "status": "unpublished",       # unpublished/scheduled/published
            "publishStatus": None,
            "publishTaskId": None,
            "ozonProductId": None,
            "aiDescription": None,
            # 基础信息
            "title": "",
            "price": 0,
            "priceRange": "",
            "originalUrl": "",
            "platform": "ozon",
            "productId": "",
            "description": "",
            "category": "",
            "categoryId": "",
            "brand": "",
            # 图片资源
            "images": [],                  # 主图列表
            "detailImages": [],            # 详情页图片列表
            # SKU / 规格
            "skuList": [],                 # SKU 列表 [{name, skuId, price, stock, sales}]
            "variants": [],                # 规格选项 [{name, options}]
            "skus": [],                    # 编辑后的 SKU 行 [{combo, price, oldPrice, sourcePrice, stock, ...}]
            "attributes": [],               # 产品属性 [{id|name, value, dictionary_value_id?}]
            # 卖家信息
            "seller": None,                # {name, shopId}
            "weight": "",
            # 采集页所需字段
            "group": "未分组",
            "store": "",
            "storeId": None,
            "assignee": "",
            "sourcePrice": None,
            "sourceId": "",
            "sourceLink": "",
            "sourceName": "",
            "note": "",
            "claimedAt": None,
            # 编辑弹窗所需字段
            "skuAttrs": [],
            "descriptionCategoryId": None,
            "typeId": None,
            "categoryMatch": None,          # 类目自动匹配结果 {matched, confidence, label, sourceCategory, candidates}
            "weightValue": None,
            "weightUnit": "g",
            "dimensions": {},
            "vat": "",
            "offerId": "",
            "barcodes": [],
        }
        defaults.update(data)
        return super().create(defaults)

    @classmethod
    def get_status_stats(cls):
        """获取各发布状态统计"""
        items = cls.find_all()
        stats = {
            "unpublished": 0,
            "scheduled": 0,
            "published": 0,
        }
        for item in items:
            s = item.get("status", "unpublished")
            if s in stats:
                stats[s] += 1
        return stats

    @classmethod
    def find_by_original_url(cls, url):
        """通过源 URL 查找商品（用于已发布回查）

        匹配规则：
        1. originalUrl 完全匹配
        2. url 字段匹配（兼容旧数据）
        3. 去除 query 参数后匹配
        """
        if not url:
            return None
        cls._ensure_loaded()
        # 去除 query 参数的 URL（用于宽松匹配）
        url_base = url.split('?')[0].split('#')[0].rstrip('/')
        with cls._lock:
            for item in cls._cache:
                item_url = item.get('originalUrl', '') or item.get('url', '')
                if not item_url:
                    continue
                # 精确匹配
                if item_url == url:
                    return item
                # 宽松匹配（去除 query/fragment/末尾斜杠）
                item_url_base = item_url.split('?')[0].split('#')[0].rstrip('/')
                if item_url_base == url_base:
                    return item
        return None

    @classmethod
    def find_by_sku(cls, sku):
        """通过源 SKU 查找商品（用于已发布回查）"""
        if not sku:
            return None
        cls._ensure_loaded()
        with cls._lock:
            for item in cls._cache:
                # 商品级 SKU
                if item.get('sku') == sku or item.get('productId') == sku:
                    return item
                # SKU 列表中的 SKU
                sku_list = item.get('skuList') or []
                for s in sku_list:
                    if isinstance(s, dict) and (s.get('sku') == sku or s.get('skuId') == sku):
                        return item
        return None


class Notice(BaseModel):
    """公告模型"""
    FILE_PATH = Config.NOTICES_FILE


class PublishTask(BaseModel):
    """发布任务模型"""
    FILE_PATH = Config.PUBLISH_TASKS_FILE

    @classmethod
    def create(cls, data):
        """创建发布任务，设置默认状态"""
        defaults = {
            "status": "pending",
            "error": None,
            "ozonProductId": None,
            "ozonTaskId": None,
        }
        defaults.update(data)
        return super().create(defaults)


class PublishRecord(BaseModel):
    """上架记录模型"""
    FILE_PATH = Config.PUBLISH_RECORDS_FILE

    @classmethod
    def create(cls, data):
        """创建上架记录，设置默认字段"""
        defaults = {
            "productId": None,
            "title": "",
            "price": 0,
            "images": [],
            "status": "pending",       # pending/processing/published/failed/cancelled/published_with_errors
            "platform": "ozon",
            "storeId": None,
            "storeName": "",
            "sourceUrl": "",
            "sourceName": "",
            "sourceId": "",
            "publisher": "",
            "ozonProductId": None,
            "ozonTaskId": None,
            "error": None,
            "errors": [],
            "note": "",
        }
        defaults.update(data)
        return super().create(defaults)

    @classmethod
    def get_stats(cls):
        """获取各状态统计"""
        items = cls.find_all()
        stats = {
            "pending": 0,
            "processing": 0,
            "published": 0,
            "failed": 0,
            "cancelled": 0,
            "published_with_errors": 0,
        }
        for item in items:
            s = item.get("status", "pending")
            if s in stats:
                stats[s] += 1
        return stats


class User(BaseModel):
    """用户模型"""
    FILE_PATH = Config.USERS_FILE
