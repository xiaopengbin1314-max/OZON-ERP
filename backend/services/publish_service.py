"""
发布服务模块
处理商品发布到 Ozon 平台的业务逻辑
"""
import os
import threading
import time
import urllib.request
import urllib.parse
import urllib.error
import json
import copy
import re
import uuid as _uuid
from concurrent.futures import ThreadPoolExecutor
from models.product import PublishTask, Product, PublishRecord
from services.ozon_api import (
    import_products, get_import_info, get_attribute_values_full,
    update_prices, update_stocks, OzonAPIError,
)
from config import Config

# 发布任务后台线程池（并发数可通过环境变量 OZON_PUBLISH_WORKERS 配置，默认 3）
_executor = ThreadPoolExecutor(
    max_workers=int(os.environ.get('OZON_PUBLISH_WORKERS', '3')),
    thread_name_prefix='publish'
)
# 图片下载并发线程池（独立于发布线程池，避免图片下载占用发布通道）
_image_executor = ThreadPoolExecutor(
    max_workers=int(os.environ.get('OZON_IMAGE_WORKERS', '5')),
    thread_name_prefix='img-dl'
)


class _TokenBucket:
    """令牌桶限流器（线程安全）

    用于限制 Ozon API 调用速率，避免批量发布时触发 429 速率限制。
    令牌按固定速率补充，调用前必须 acquire 一个令牌；桶容量允许有限突发。

    通过环境变量配置：
      OZON_API_RPS   - 每秒补充的令牌数（默认 1，即每秒 1 个 API 请求）
      OZON_API_BURST - 桶容量（突发上限，默认 3）
    """

    def __init__(self, rate, burst):
        self.rate = float(rate)
        self.capacity = float(burst)
        self.tokens = float(burst)
        self.last_refill = time.monotonic()
        self._cond = threading.Condition(threading.Lock())

    def acquire(self, timeout=60):
        """获取一个令牌；超时则强制返回（避免无限阻塞业务流程）"""
        deadline = time.monotonic() + timeout
        with self._cond:
            while True:
                now = time.monotonic()
                elapsed = now - self.last_refill
                self.tokens = min(self.capacity, self.tokens + elapsed * self.rate)
                self.last_refill = now

                if self.tokens >= 1.0:
                    self.tokens -= 1.0
                    self._cond.notify_all()
                    return True

                # 计算还需等待多久才能攒到 1 个令牌
                wait = (1.0 - self.tokens) / self.rate if self.rate > 0 else 1.0
                remaining = deadline - now
                if wait >= remaining:
                    # 超时：强制放行（避免限流器卡死业务），扣至 0
                    self.tokens = 0.0
                    self._cond.notify_all()
                    return False

                # 释放锁并等待，期间其他线程可以 acquire
                self._cond.wait(timeout=wait)


# Ozon API 调用限流器（保护 import_products 等接口的调用速率）
_ozon_rate_limiter = _TokenBucket(
    rate=float(os.environ.get('OZON_API_RPS', '1')),
    burst=float(os.environ.get('OZON_API_BURST', '3')),
)

OZON_IMPORT_SUCCESS_STATUSES = {
    'imported',
}
OZON_IMPORT_PROCESSING_STATUSES = {
    'pending', 'processing', 'validation',
}
OZON_IMPORT_FAILED_STATUSES = {
    'failed', 'rejected', 'not_processed',
}


def _format_ozon_errors(errors):
    details = []
    for err in errors or []:
        if not isinstance(err, dict):
            details.append(str(err))
            continue
        attr_name = err.get('attribute_name') or err.get('field') or err.get('attribute_id') or ''
        msg = (
            err.get('message')
            or err.get('description')
            or err.get('detail')
            or err.get('code')
            or str(err)
        )
        details.append(f'[{attr_name}] {msg}' if attr_name else str(msg))
    return [d for d in details if d]


# VAT 税率映射：前端值 → Ozon API 值
VAT_MAP = {
    '': '0',
    '0': '0',
    '10': '0.1',
    '20': '0.2',
}

# 颜色字典值缓存：{(description_category_id, type_id, attribute_id): {color_name: dictionary_value_id}}
_color_cache = {}
_color_cache_lock = threading.Lock()

# 通用颜色映射（中文→俄语）从通用层导入，便于统一维护
from data.category_mapping_general import translate_color_to_ru as _translate_color_to_ru


def _download_and_save_image(img_url):
    """下载图片并保存到后端托管，返回新的 URL

    自动选择存储方式：本地 uploads 目录 或 七牛云对象存储（按配置）。
    """
    # 解析代理 URL
    if '/api/image_proxy?url=' in img_url:
        parsed = urllib.parse.parse_qs(urllib.parse.urlparse(img_url).query)
        actual_url = parsed.get('url', [''])[0]
        if actual_url:
            img_url = actual_url

    base_url = Config.IMAGE_BASE_URL.rstrip('/') if Config.IMAGE_BASE_URL else 'http://localhost:5000'

    # 已经是本地托管的图片，直接返回
    if '/uploads/' in img_url:
        if img_url.startswith('http'):
            return img_url
        return f'{base_url}{img_url}'

    # 下载图片
    try:
        req = urllib.request.Request(img_url)
        req.add_header('User-Agent', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36')
        req.add_header('Referer', 'https://detail.1688.com/')
        req.add_header('Accept', 'image/webp,image/apng,image/*,*/*;q=0.8')

        with urllib.request.urlopen(req, timeout=15) as resp:
            content_type = resp.headers.get('Content-Type', 'image/jpeg')
            image_data = resp.read()

        ext = 'jpg'
        if 'png' in content_type:
            ext = 'png'
        elif 'webp' in content_type:
            ext = 'webp'
        elif 'gif' in content_type:
            ext = 'gif'

        # 使用 storage_service 保存（本地或对象存储）
        from services.storage_service import save_image
        return save_image(image_data, ext)
    except Exception as e:
        print(f'[图片转存] 下载失败 {img_url[:80]}: {e}')
        return None


def preprocess_images_for_publish(product):
    """发布前预处理商品所有图片，确保它们是公网可访问的 URL

    处理逻辑（智能转存，零配置即可发布）：
    1. base64 图片 → 保存到后端/对象存储 → 返回 URL
    2. 代理 URL (/api/image_proxy?url=...) → 提取实际 URL → 下载转存
    3. 公网 CDN 图片（alicdn 等）→ 直接保留原 URL（Ozon 可直接访问）
       - 若配置了 IMAGE_BASE_URL 或对象存储，则转存到自有托管（更可靠）
    4. 已是 /uploads/ 的本地托管图片 → 补全为完整 URL
    5. 其他公网 URL → 保持不变

    使用线程池并发处理图片下载，大幅提升多图商品的预处理速度。
    修改 product 对象的 images、skus 中的图片字段。

    Returns:
        tuple: (success: bool, errors: list[str])
    """
    import base64 as _b64

    errors = []
    base_url = Config.IMAGE_BASE_URL.rstrip('/') if Config.IMAGE_BASE_URL else 'http://localhost:5000'
    os.makedirs(Config.UPLOAD_DIR, exist_ok=True)

    # 公网 CDN 域名：这些图片本身就是公网可访问的，无需转存
    PUBLIC_CDN_DOMAINS = ('alicdn.com', 'taobaocdn.com', 'tbcdn.cn', 'ozoncdn.ru')

    def _has_public_hosting():
        """是否已配置公网图片托管"""
        if Config.IMAGE_BASE_URL:
            return True
        if (Config.OBJECT_STORAGE_TYPE or 'local').lower() == 'qiniu' and Config.QINIU_ACCESS_KEY:
            return True
        return False

    def _is_public_cdn_url(url):
        """判断 URL 是否为公网 CDN 图片（无需转存）"""
        if not url.startswith(('http://', 'https://')):
            return False
        if '://localhost' in url or '://127.0.0.1' in url:
            return False
        return any(domain in url for domain in PUBLIC_CDN_DOMAINS)

    has_public_hosting = _has_public_hosting()

    def _process_single_image(url):
        """处理单张图片 URL，返回新的 URL 或 None（线程安全）"""
        if not url or not isinstance(url, str):
            return None

        # base64 图片：解码保存
        if url.startswith('data:'):
            try:
                header, _, base64_data = url.partition(',')
                ext = 'jpg'
                if 'image/png' in header:
                    ext = 'png'
                elif 'image/webp' in header:
                    ext = 'webp'
                elif 'image/gif' in header:
                    ext = 'gif'

                image_data = _b64.b64decode(base64_data)
                if len(image_data) > Config.MAX_IMAGE_SIZE:
                    return ('__ERROR__', '图片大小超过限制')

                from services.storage_service import save_image
                return save_image(image_data, ext)
            except Exception as e:
                return ('__ERROR__', f'base64 图片处理失败: {e}')

        # 代理 URL：提取实际 URL 后下载转存
        if '/api/image_proxy?' in url:
            parsed = urllib.parse.parse_qs(urllib.parse.urlparse(url).query)
            actual_url = parsed.get('url', [''])[0]
            if actual_url:
                new_url = _download_and_save_image(actual_url)
                if not new_url:
                    return ('__ERROR__', f'代理图片转存失败: {actual_url[:60]}')
                return new_url
            return None

        # 已是本地托管的图片：补全 URL
        if url.startswith('/uploads/'):
            return f'{base_url}{url}'

        # 已是完整 URL 的本地托管图片：
        # 若为 localhost 且配置了公网 IMAGE_BASE_URL，重写为公网地址（Ozon 服务器无法访问 localhost）
        if '/uploads/' in url and url.startswith('http'):
            if Config.IMAGE_BASE_URL and ('://localhost' in url or '://127.0.0.1' in url):
                idx = url.find('/uploads/')
                return f'{Config.IMAGE_BASE_URL.rstrip("/")}{url[idx:]}'
            return url

        # 公网 CDN 图片（alicdn 等）：未配置公网托管时直接用原 URL
        if _is_public_cdn_url(url) and not has_public_hosting:
            return url

        # 其他 HTTP/HTTPS URL
        if url.startswith(('http://', 'https://')):
            # 已配置公网托管时，转存到自有托管（更可靠）
            # 否则公网 URL 直接使用
            if has_public_hosting:
                new_url = _download_and_save_image(url)
                if not new_url:
                    # 转存失败时回退使用原 URL
                    return url
                return new_url
            return url

        # 其他格式（相对路径等）
        return ('__ERROR__', f'不支持的图片格式: {url[:60]}')

    # === 收集所有需要处理的图片 URL（去重） ===
    all_urls = set()
    # 主图
    for img in product.get('images', []) or []:
        if img:
            all_urls.add(img)
    # SKU 图片
    for sku in product.get('skus', []) or []:
        if sku.get('image'):
            all_urls.add(sku['image'])
        # SKU 可能有 images 列表字段
        for img in sku.get('images', []) or []:
            if img:
                all_urls.add(img)
        # 注意：combo 字段存储的是 SKU 属性值（颜色名、尺码、件数等文本），
        # 不是图片 URL，不应收集到图片处理集合中。
        # 仅当 combo 值本身看起来像图片 URL 时才收集（保留兼容性）。
        combo = sku.get('combo') or {}
        for val in combo.values():
            if isinstance(val, str) and val:
                if val.startswith(('http://', 'https://', 'data:', '/api/image_proxy', '/uploads/')):
                    all_urls.add(val)
    # 详情图
    for img in product.get('detailImages', []) or []:
        if img:
            all_urls.add(img)

    # === 并发处理所有图片 ===
    url_map = {}  # original_url → new_url
    if all_urls:
        futures = {
            _image_executor.submit(_process_single_image, url): url
            for url in all_urls
        }
        for future in futures:
            original_url = futures[future]
            try:
                result = future.result(timeout=60)
                if isinstance(result, tuple) and len(result) == 2 and result[0] == '__ERROR__':
                    errors.append(result[1])
                    url_map[original_url] = None
                elif result:
                    url_map[original_url] = result
                else:
                    url_map[original_url] = None
            except Exception as e:
                errors.append(f'图片处理异常: {original_url[:60]} - {e}')
                url_map[original_url] = None

    # === 将处理结果写回 product 对象 ===
    def _replace_url(url):
        if not url:
            return url
        return url_map.get(url, url) or url

    # 主图
    if product.get('images'):
        product['images'] = [u for u in (_replace_url(img) for img in product['images']) if u]
    # SKU 图片
    for sku in product.get('skus', []) or []:
        if sku.get('image'):
            sku['image'] = _replace_url(sku['image'])
        # SKU 可能有 images 列表字段
        if sku.get('images'):
            sku['images'] = [u for u in (_replace_url(img) for img in sku['images']) if u]
        # combo 中只有像 URL 的值才会出现在 url_map 中，其他文本值保持不变
        combo = sku.get('combo') or {}
        for key, val in list(combo.items()):
            if isinstance(val, str) and val in url_map:
                new_val = url_map[val]
                if new_val:
                    combo[key] = new_val
    # 详情图
    if product.get('detailImages'):
        product['detailImages'] = [u for u in (_replace_url(img) for img in product['detailImages']) if u]

    # 检查是否有足够的主图
    if not product.get('images') or len(product.get('images', [])) == 0:
        errors.append('商品没有有效的主图（所有图片转存失败或无图片）')

    # 最终校验：主图若仍是 localhost URL 且未配置公网托管，Ozon 服务器无法访问
    # （公网 CDN 图片如 alicdn 不受此限制，Ozon 可直接访问）
    if not has_public_hosting:
        localhost_imgs = [
            u for u in product.get('images', [])
            if isinstance(u, str) and ('://localhost' in u or '://127.0.0.1' in u)
            and not _is_public_cdn_url(u)
        ]
        if localhost_imgs:
            errors.append(
                '图片为 localhost URL，Ozon 无法访问。解决方案（任选其一）：\n'
                '1. 在 backend/.env 配置 IMAGE_BASE_URL 为公网地址（如内网穿透地址 cpolar/ngrok）\n'
                '2. 配置对象存储：OBJECT_STORAGE_TYPE=qiniu 并填写七牛云凭证\n'
                '3. 重新采集商品，让图片保持公网 CDN 源 URL（alicdn 等）'
            )

    return (len(errors) == 0, errors)


# 属性名同义词映射（中 → 俄/英），用于采集属性与 Ozon 类目属性的跨语言匹配
_ATTR_NAME_SYNONYMS = {
    '品牌': ['бренд', 'brand', 'производитель', 'торговая марка'],
    '材质': ['материал', 'material', 'состав'],
    '颜色': ['цвет', 'color'],
    '尺寸': ['размер', 'size'],
    '重量': ['вес', 'weight', 'масса'],
    '产地': ['страна', 'country', 'страна производства', 'происхождение'],
    '生产国': ['страна производства', 'country of origin', 'страна-производитель'],
    '型号': ['модель', 'model', 'артикул производителя'],
    '年份': ['год', 'year', 'год выпуска'],
    '季节': ['сезон', 'season'],
    '风格': ['стиль', 'style'],
    '图案': ['узор', 'pattern', 'рисунок'],
    '性别': ['пол', 'gender'],
    '包装数量': ['количество в упаковке', 'package quantity', 'комплектация'],
    '目的年龄': ['возраст', 'age', 'целевой возраст'],
    '目标受众': ['целевая аудитория', 'target audience'],
    '保修期': ['гарантия', 'warranty', 'гарантийный срок'],
    '电池容量': ['емкость батареи', 'battery capacity', 'аккумулятор'],
    '电池续航': ['время работы', 'battery life', 'автономность'],
    '充电接口': ['зарядка', 'charging', 'порт зарядки', 'разъем зарядки'],
    '防水等级': ['водонепроницаемость', 'waterproof', 'защита от воды'],
    '蓝牙版本': ['версия bluetooth', 'bluetooth version', 'bluetooth'],
    '连接方式': ['подключение', 'connection', 'способ подключения'],
    '功率': ['мощность', 'power', 'ватт'],
    '电压': ['напряжение', 'voltage'],
    '容量': ['объем', 'capacity', 'вместимость'],
    '形状': ['форма', 'shape'],
    '用途': ['назначение', 'usage', 'применение'],
    '适用场景': ['случай применения', 'occasion', 'сценарий применения'],
    '功能': ['функция', 'function', 'функции'],
    '配件': ['комплектация', 'accessories', 'в комплекте'],
    '保质期': ['срок годности', 'shelf life', 'срок хранения'],
    '存储条件': ['условия хранения', 'storage conditions'],
    '面料': ['ткань', 'fabric', 'материал верха'],
    '里料': ['подкладка', 'lining'],
    '袖长': ['длина рукава', 'sleeve length'],
    '裤长': ['длина брюк', 'pants length'],
    '领型': ['воротник', 'collar', 'тип воротника'],
    '厚度': ['толщина', 'thickness'],
    '直径': ['диаметр', 'diameter'],
    '长度': ['длина', 'length'],
    '宽度': ['ширина', 'width'],
    '高度': ['высота', 'height'],
    '深度': ['глубина', 'depth'],
    '频率': ['частота', 'frequency'],
    '分辨率': ['разрешение', 'resolution'],
    '屏幕尺寸': ['размер экрана', 'screen size', 'диагональ экрана'],
    '存储容量': ['объем памяти', 'storage', 'память'],
    '运行内存': ['оперативная память', 'ram', 'ram-память'],
    '处理器': ['процессор', 'processor', 'cpu'],
    '核心数': ['количество ядер', 'cores', 'ядра'],
}

# 常见属性值同义词（中 → 俄/英），用于字典值匹配
_ATTR_VALUE_SYNONYMS = [
    ['中国', 'китай', 'china'],
    ['俄罗斯', 'россия', 'russia'],
    ['美国', 'сша', 'usa'],
    ['日本', 'япония', 'japan'],
    ['韩国', 'корея', 'korea'],
    ['德国', 'германия', 'germany'],
    ['法国', 'франция', 'france'],
    ['英国', 'великобритания', 'uk'],
    ['意大利', 'италия', 'italy'],
    ['西班牙', 'испания', 'spain'],
    ['土耳其', 'турция', 'turkey'],
    ['印度', 'индия', 'india'],
    ['男', 'мужской', 'male'],
    ['女', 'женский', 'female'],
    ['中性', 'унисекс', 'unisex'],
    ['春', 'весна', 'spring'],
    ['夏', 'лето', 'summer'],
    ['秋', 'осень', 'autumn'],
    ['冬', 'зима', 'winter'],
    ['是', 'да', 'yes', 'true'],
    ['否', 'нет', 'no', 'false'],
]


def _match_attr_name(src_name, ozon_name, ozon_name_zh):
    """属性名跨语言匹配（中/俄/英同义词）

    Args:
        src_name: 采集的属性名（可能是中文/俄文/英文）
        ozon_name: Ozon 类目属性名（通常是俄文）
        ozon_name_zh: Ozon 类目属性中文名
    Returns:
        bool: 是否匹配
    """
    if not src_name:
        return False
    s = str(src_name).lower().strip()
    o = str(ozon_name or '').lower().strip()
    oz = str(ozon_name_zh or '').lower().strip()

    # 精确匹配
    if s == o or s == oz:
        return True
    # 包含匹配（双向）
    if (o and (s in o or o in s)) or (oz and (s in oz or oz in s)):
        return True
    # 同义词匹配：src 是中文键
    syns = _ATTR_NAME_SYNONYMS.get(s)
    if syns:
        if any(syn in o or syn in oz for syn in syns):
            return True
    # 同义词匹配：src 是俄文/英文，反查中文键
    for zh_key, zh_syns in _ATTR_NAME_SYNONYMS.items():
        if s in zh_syns:
            if zh_key in o or zh_key in oz:
                return True
            if any(syn in o or syn in oz for syn in zh_syns):
                return True
            break
    return False


def _match_dict_value(src_value, dict_values):
    """字典值跨语言匹配

    Args:
        src_value: 采集的属性值（中文/俄文/英文）
        dict_values: Ozon 字典值列表 [{ value_id, value, value_zh, value_ru, value_en }]
    Returns:
        dict: 匹配到的字典值 { value_id, value } 或 None
    """
    if not src_value or not dict_values:
        return None
    src = str(src_value).strip()
    src_lower = src.lower()

    # 1. 精确匹配
    for v in dict_values:
        if not isinstance(v, dict):
            continue
        if (v.get('value_zh') == src or
            (v.get('value') and str(v['value']).lower() == src_lower) or
            (v.get('value_ru') and v['value_ru'].lower() == src_lower) or
            (v.get('value_en') and v['value_en'].lower() == src_lower)):
            return {'value_id': v.get('id') or v.get('value_id'), 'value': v.get('value', '')}

    # 2. 包含匹配（双向）
    for v in dict_values:
        if not isinstance(v, dict):
            continue
        vzh = str(v.get('value_zh') or '')
        vru = str(v.get('value') or '')
        if (vzh and (src in vzh or vzh in src)) or \
           (vru and (src_lower in vru.lower() or vru.lower() in src_lower)):
            return {'value_id': v.get('id') or v.get('value_id'), 'value': v.get('value', '')}

    # 3. 同义词匹配
    for syns in _ATTR_VALUE_SYNONYMS:
        if src_lower in [s.lower() for s in syns]:
            for v in dict_values:
                if not isinstance(v, dict):
                    continue
                vru = str(v.get('value') or '').lower()
                vzh = str(v.get('value_zh') or '').lower()
                if any(syn.lower() in vru or syn.lower() in vzh for syn in syns):
                    return {'value_id': v.get('id') or v.get('value_id'), 'value': v.get('value', '')}
            break

    return None


def _match_large_dictionary_values(description_category_id, type_id, attribute_id, source_values):
    """Find exact values in large dictionaries without downloading every brand."""
    from services.ozon_api import get_attribute_values

    remaining = {str(value).strip().lower() for value in source_values if str(value).strip()}
    matches = []
    last_value_id = 0
    for _ in range(50):
        result = get_attribute_values(
            description_category_id,
            type_id,
            attribute_id,
            language='RU',
            last_value_id=last_value_id,
            limit=2000,
        )
        values = result.get('result', []) if result else []
        for item in values:
            value = str(item.get('value') or '').strip().lower()
            if value in remaining and (item.get('id') or item.get('value_id')):
                matches.append({'value_id': item.get('id') or item.get('value_id'), 'value': item.get('value', '')})
                remaining.discard(value)
        if not remaining or not values or not result.get('has_next'):
            break
        last_value_id = values[-1].get('id') or 0
        if not last_value_id:
            break
    return matches


def _normalize_product_category_ids(product):
    """Prefer the matched Ozon category ids before assembling publish payloads."""
    if not isinstance(product, dict):
        return product

    match = product.get('categoryMatch') or {}
    if not isinstance(match, dict) or not match.get('matched'):
        return product

    desc_id = match.get('description_category_id') or match.get('descriptionCategoryId')
    type_id = match.get('type_id') or match.get('typeId')
    if desc_id and type_id:
        if product.get('descriptionCategoryId') != desc_id or product.get('typeId') != type_id:
            print(f'[发布] 使用 categoryMatch 类目: descriptionCategoryId={desc_id}, typeId={type_id}', flush=True)
        product['descriptionCategoryId'] = desc_id
        product['typeId'] = type_id
    return product


def _get_bilingual_category_attributes(description_category_id, type_id):
    """Load a category schema with Russian and Chinese names keyed by ID."""
    from services.ozon_api import get_category_attributes

    ru_result = get_category_attributes(description_category_id, type_id, language='RU')
    zh_result = get_category_attributes(description_category_id, type_id, language='ZH_HANS')
    ru_attrs = ru_result.get('result', []) if ru_result else []
    zh_attrs = zh_result.get('result', []) if zh_result else []
    ru_by_id = {a.get('id'): a for a in ru_attrs if isinstance(a, dict) and a.get('id')}
    zh_by_id = {a.get('id'): a for a in zh_attrs if isinstance(a, dict) and a.get('id')}
    result = []
    for attr_id in dict.fromkeys(list(ru_by_id) + list(zh_by_id)):
        merged = dict(ru_by_id.get(attr_id) or zh_by_id.get(attr_id) or {})
        merged['name_zh'] = (zh_by_id.get(attr_id) or {}).get('name') or merged.get('name_zh') or ''
        result.append(merged)
    return result


def match_attributes_by_name(product, resolve_large_dictionaries=True):
    """为无 id 的采集属性按名称匹配 Ozon 类目属性，补全 id 和 dictionary_value_id

    扩展采集的 attributes 格式为 [{name, value}]（无 Ozon 属性 id），
    直接提交到后端后 build_ozon_attributes 会因缺少 id 而丢弃这些属性。
    本函数在发布前根据商品的 descriptionCategoryId + typeId 拉取类目属性列表，
    按 name 匹配补全 id，并对字典值属性匹配 dictionary_value_id。

    Args:
        product: 商品对象（将被修改，attributes 字段会被更新）

    Returns:
        dict: { 'matched': int, 'total_no_id': int, 'skipped': int }
    """
    normalize_collected_color_skus(product)
    _normalize_product_category_ids(product)
    desc_cat_id = product.get('descriptionCategoryId')
    type_id = product.get('typeId')
    attrs = product.get('attributes')

    if not isinstance(attrs, list) or not attrs:
        return {'matched': 0, 'total_no_id': 0, 'skipped': 0}
    if not desc_cat_id or not type_id:
        return {'matched': 0, 'total_no_id': 0, 'skipped': 0}

    # 筛选无 id 的属性（需要匹配的）
    no_id_attrs = [a for a in attrs if isinstance(a, dict) and not a.get('id') and a.get('name')]
    # 拉取 Ozon 类目属性列表（带缓存）
    try:
        from services.ozon_api import get_attribute_values_full
        all_attrs = _get_bilingual_category_attributes(desc_cat_id, type_id)
    except Exception as e:
        print(f'[属性匹配] 拉取类目属性失败: {e}')
        return {'matched': 0, 'total_no_id': len(no_id_attrs), 'skipped': len(no_id_attrs)}

    if not all_attrs:
        return {'matched': 0, 'total_no_id': len(no_id_attrs), 'skipped': len(no_id_attrs)}

    print(f'[属性匹配] 开始匹配 {len(no_id_attrs)} 个无 id 属性（类目属性列表 {len(all_attrs)} 条）')

    matched_count = 0
    matched_no_id_count = 0
    attrs_to_normalize = [
        a for a in attrs
        if isinstance(a, dict) and (a.get('id') or a.get('name'))
    ]
    category_by_id = {a.get('id'): a for a in all_attrs if a.get('id')}
    for attr in attrs_to_normalize:
        had_id = bool(attr.get('id'))
        src_name = attr.get('name', '')
        src_value = attr.get('value', '')

        # 在类目属性列表中按名称匹配
        matched_attr = category_by_id.get(attr.get('id'))
        if not matched_attr:
            src_normalized = str(src_name).lower().strip()
            matched_attr = next((cat_attr for cat_attr in all_attrs if
                src_normalized in {
                    str(cat_attr.get('name') or '').lower().strip(),
                    str(cat_attr.get('name_zh') or '').lower().strip(),
                }
            ), None)
        if not matched_attr:
            for cat_attr in all_attrs:
                if _match_attr_name(src_name, cat_attr.get('name', ''), cat_attr.get('name_zh', '')):
                    matched_attr = cat_attr
                    break

        if not matched_attr:
            print(f'[属性匹配] 未匹配到类目属性: name="{src_name}", value="{str(src_value)[:50]}"')
            continue

        attr_id = matched_attr.get('id')
        attr_dict_id = matched_attr.get('dictionary_id')
        attr_type = matched_attr.get('type', '')
        attr_name = matched_attr.get('name_zh') or matched_attr.get('name', src_name)

        # 补全 id
        attr['id'] = attr_id
        if not attr.get('name') or attr['name'] != attr_name:
            attr['name'] = attr_name

        # 对字典值属性，匹配 dictionary_value_id
        if attr_dict_id and src_value and not (attr.get('dictionary_value_id') or attr.get('dictionary_value_ids')):
            try:
                if attr_id == 85 and not resolve_large_dictionaries:
                    # 品牌字典有数万项。采集保存阶段先持久化 id + 原始文本，
                    # 发布阶段再分页查 ID，避免扩展请求超过 20 秒。
                    matched_count += 1
                    if not had_id:
                        matched_no_id_count += 1
                    continue
                source_values = [v.strip() for v in str(src_value).replace(';', ',').replace('，', ',').split(',') if v.strip()]
                if attr_id == 85:
                    matched_values = _match_large_dictionary_values(
                        desc_cat_id, type_id, attr_id, source_values
                    )
                else:
                    dict_result = get_attribute_values_full(desc_cat_id, type_id, attr_id, language='RU')
                    dict_values = dict_result.get('result', []) if dict_result else []
                    matched_values = [_match_dict_value(value, dict_values) for value in source_values]
                matched_values = [value for value in matched_values if value and value.get('value_id')]
                matched_ids = list(dict.fromkeys(value['value_id'] for value in matched_values))
                if matched_ids:
                    if matched_attr.get('is_collection') or len(matched_ids) > 1:
                        attr['dictionary_value_ids'] = matched_ids
                    else:
                        attr['dictionary_value_id'] = matched_ids[0]
                    attr.pop('value', None)
                    print(f'[属性匹配] 匹配成功: "{src_name}" → id={attr_id}, dict_ids={matched_ids}')
                    matched_count += 1
                    if not had_id:
                        matched_no_id_count += 1
                else:
                    # 字典属性不能发送任意文本，否则 Ozon 会接受任务但商品信息
                    # 实际丢失。移除无效条目，让必填预填逻辑补合法默认值。
                    attr['_invalid_dictionary_value'] = True
                    print(f'[属性匹配] 属性匹配但字典值未匹配: "{src_name}" → id={attr_id}, value="{str(src_value)[:50]}" (dict_id={attr_dict_id})')
            except Exception as e:
                print(f'[属性匹配] 拉取字典值失败 attr_id={attr_id}: {e}')
                matched_count += 1  # id 已匹配，算成功
        else:
            # 非字典值属性，id 匹配成功即可
            print(f'[属性匹配] 匹配成功: "{src_name}" → id={attr_id}, value="{str(src_value)[:50]}"')
            matched_count += 1
            if not had_id:
                matched_no_id_count += 1

    product['attributes'] = [
        attr for attr in attrs
        if not (isinstance(attr, dict) and attr.pop('_invalid_dictionary_value', False))
    ]
    print(f'[属性匹配] 完成: {matched_no_id_count}/{len(no_id_attrs)} 个无ID属性已匹配')

    return {
        'matched': matched_no_id_count,
        'total_no_id': len(no_id_attrs),
        'skipped': max(0, len(no_id_attrs) - matched_no_id_count),
    }


def build_ozon_attributes(product_attrs):
    """将本地属性格式转换为 Ozon API 要求的 attributes 格式

    支持三种输入格式：
    1. 扁平格式（旧）: [{ id, value, dictionary_value_id }]
    2. 嵌套格式（新，与 Ozon API 一致）: [{ id, name?, values: [{ value?, dictionary_value_id? }] }]
    3. 多选扁平格式: [{ id, dictionary_value_ids: [v1, v2, ...] }]  （性别、颜色等多选字典属性）

    Ozon格式: [{ id, values: [{ value }] | [{ dictionary_value_id }] }]

    注意：采集商品的原始属性可能是 dict 格式（如 {'品牌': '优乐奇'}），
    这是 1688 源属性，不是 Ozon 类目属性，应忽略。
    只有用户在编辑弹窗中填写 Ozon 类目属性后，attributes 才是 list 格式。
    """
    # 非列表格式（如 dict 类型的源属性）直接返回空，不属于 Ozon 类目属性
    if not isinstance(product_attrs, list):
        return []

    # 按属性 ID 聚合，避免采集属性、ERP 编辑属性和 SKU 属性重复写入
    # 同一个字段。Ozon 对重复 id 会返回“Поле указано повторно”。
    by_id = {}
    for attr in product_attrs:
        if not isinstance(attr, dict) or not attr.get('id'):
            continue
        item = {'id': attr['id'], 'values': []}

        # 优先识别嵌套 values 格式（扩展端发送）
        nested_values = attr.get('values')
        if isinstance(nested_values, list):
            for v in nested_values:
                if not isinstance(v, dict):
                    continue
                if v.get('dictionary_value_id'):
                    item['values'].append({'dictionary_value_id': v['dictionary_value_id']})
                elif v.get('value'):
                    item['values'].append({'value': str(v['value'])})
        else:
            # 扁平格式（旧版兼容）
            # 多选字典属性：dictionary_value_ids 数组（性别、多色等多选场景）
            dict_value_ids = attr.get('dictionary_value_ids')
            if isinstance(dict_value_ids, list) and len(dict_value_ids) > 0:
                for vid in dict_value_ids:
                    if vid:
                        item['values'].append({'dictionary_value_id': vid})
            elif attr.get('dictionary_value_id'):
                item['values'].append({'dictionary_value_id': attr['dictionary_value_id']})
            elif attr.get('value'):
                item['values'].append({'value': str(attr['value'])})

        if item['values']:
            target = by_id.setdefault(item['id'], {'id': item['id'], 'values': []})
            seen = {
                (value.get('dictionary_value_id'), str(value.get('value') or ''))
                for value in target['values']
            }
            for value in item['values']:
                signature = (value.get('dictionary_value_id'), str(value.get('value') or ''))
                if signature not in seen:
                    target['values'].append(value)
                    seen.add(signature)
    return list(by_id.values())


def validate_ozon_product_items(product, items):
    """Validate assembled items against the target category's live schema."""
    errors = []
    warnings = []
    desc_cat_id = product.get('descriptionCategoryId')
    type_id = product.get('typeId')
    if not desc_cat_id or not type_id:
        return {
            'valid': False,
            'errors': ['缺少 descriptionCategoryId 或 typeId'],
            'warnings': [],
        }

    try:
        from services.ozon_api import get_category_attributes, validate_category_pair
        pair_result = validate_category_pair(desc_cat_id, type_id)
        if not pair_result.get('valid'):
            return {
                'valid': False,
                'errors': [f'类目 ID 对无效: {pair_result.get("reason", "未知原因")}'],
                'warnings': [],
                'category': pair_result,
            }
        result = get_category_attributes(desc_cat_id, type_id, language='RU')
        category_attrs = result.get('result', []) if result else []
    except Exception as exc:
        return {
            'valid': False,
            'errors': [f'无法加载 Ozon 类目属性定义: {exc}'],
            'warnings': [],
        }

    schema = {
        attr.get('id'): attr
        for attr in category_attrs
        if isinstance(attr, dict) and attr.get('id')
    }
    required_ids = {
        attr_id for attr_id, attr in schema.items()
        if attr.get('is_required') or attr.get('required')
    }

    for index, item in enumerate(items or [], start=1):
        prefix = f'item[{index}]'
        for field in ('name', 'offer_id', 'description_category_id', 'type_id', 'price'):
            if item.get(field) in (None, '', []):
                errors.append(f'{prefix} 缺少 {field}')
        if not item.get('images'):
            errors.append(f'{prefix} 缺少商品图片')
        for field in ('weight', 'width', 'height', 'depth'):
            try:
                if float(item.get(field) or 0) <= 0:
                    errors.append(f'{prefix} {field} 必须大于 0')
            except (TypeError, ValueError):
                errors.append(f'{prefix} {field} 格式无效')

        attrs = item.get('attributes') if isinstance(item.get('attributes'), list) else []
        attr_ids = []
        for attr in attrs:
            if not isinstance(attr, dict) or not attr.get('id'):
                continue
            attr_id = attr['id']
            attr_ids.append(attr_id)
            attr_schema = schema.get(attr_id)
            if not attr_schema:
                warnings.append(f'{prefix} 属性 {attr_id} 不属于当前类目，已忽略风险')
                continue
            values = attr.get('values') if isinstance(attr.get('values'), list) else []
            if attr_schema.get('dictionary_id'):
                invalid = [value for value in values if not value.get('dictionary_value_id')]
                if invalid:
                    errors.append(f'{prefix} 字典属性 {attr_schema.get("name") or attr_id} 缺少 dictionary_value_id')
            max_count = int(attr_schema.get('max_value_count') or 0)
            if max_count and len(values) > max_count:
                errors.append(f'{prefix} 属性 {attr_schema.get("name") or attr_id} 最多允许 {max_count} 个值')

        duplicate_ids = sorted({attr_id for attr_id in attr_ids if attr_ids.count(attr_id) > 1})
        if duplicate_ids:
            errors.append(f'{prefix} 存在重复属性 ID: {duplicate_ids}')
        missing_required = sorted(required_ids - set(attr_ids))
        for attr_id in missing_required:
            errors.append(f'{prefix} 缺少必填属性: {schema[attr_id].get("name") or attr_id} ({attr_id})')

        for source_index, source in enumerate(item.get('sources') or [], start=1):
            source_prefix = f'{prefix}.sources[{source_index}]'
            if not source.get('offer_id'):
                errors.append(f'{source_prefix} 缺少 offer_id')
            if source.get('price') in (None, ''):
                errors.append(f'{source_prefix} 缺少 price')
            source_attr_ids = []
            for attr in source.get('attributes') or []:
                if not isinstance(attr, dict) or not attr.get('id'):
                    continue
                attr_id = attr['id']
                source_attr_ids.append(attr_id)
                attr_schema = schema.get(attr_id)
                if not attr_schema:
                    warnings.append(f'{source_prefix} 属性 {attr_id} 不属于当前类目')
                    continue
                values = attr.get('values') if isinstance(attr.get('values'), list) else []
                if attr_schema.get('dictionary_id') and any(
                    not value.get('dictionary_value_id') for value in values
                ):
                    errors.append(
                        f'{source_prefix} 字典属性 {attr_schema.get("name") or attr_id} 缺少 dictionary_value_id'
                    )
            duplicate_source_ids = sorted({
                attr_id for attr_id in source_attr_ids if source_attr_ids.count(attr_id) > 1
            })
            if duplicate_source_ids:
                errors.append(f'{source_prefix} 存在重复属性 ID: {duplicate_source_ids}')

    return {'valid': not errors, 'errors': errors, 'warnings': warnings}


COLOR_NAME_KEYWORDS = ('颜色名称', 'Название цвета', 'название цвета', 'color name')


def normalize_collected_color_skus(product):
    """Flatten Ozon collection colors into one valid value per SKU."""
    sku_attrs = product.get('skuAttrs') or []
    skus = product.get('skus') or []
    color_attr = next((a for a in sku_attrs if str(_sku_attr_id(a) or '') == '10096'), None)
    color_name_attr = next((a for a in sku_attrs if str(_sku_attr_id(a) or '') == '10097'), None)
    if not color_attr or not isinstance(skus, list):
        return product

    color_key = color_attr.get('name') or '商品颜色（Цвет товара）'
    color_name_key = color_name_attr.get('name') if color_name_attr else ''
    source_values = color_attr.get('values') if isinstance(color_attr.get('values'), list) else []
    source_ids = color_attr.get('valueIds') if isinstance(color_attr.get('valueIds'), list) else []
    normalized_values = []
    normalized_ids = []
    normalized_names = []

    def primary_color(value):
        return next((part.strip() for part in str(value or '').split(',') if part.strip()), '')

    def clean_color_name(value):
        value = re.sub(r'^\s*\d+\s*(?:спиц(?:ы)?|骨)?\s*[-–—:]\s*', '', str(value or ''), flags=re.I)
        value = re.sub(r'\s*\([^)]*[A-ZА-Я]-?\d{3,}[^)]*\)\s*$', '', value, flags=re.I)
        return value.strip()

    for index, sku in enumerate(skus):
        if not isinstance(sku, dict):
            continue
        combo = sku.get('combo') if isinstance(sku.get('combo'), dict) else {}
        sku['combo'] = combo
        raw_color = combo.get(color_key) or (source_values[index] if index < len(source_values) else (source_values[0] if source_values else ''))
        color = primary_color(raw_color)
        raw_ids = source_ids[index] if index < len(source_ids) else (source_ids[0] if source_ids else None)
        ids = raw_ids if isinstance(raw_ids, list) else [raw_ids]
        ids = [item for nested in ids for item in (nested if isinstance(nested, list) else [nested]) if item]
        color_id = ids[0] if ids else None
        if color:
            combo[color_key] = color
            if color not in normalized_values:
                normalized_values.append(color)
                normalized_ids.append(color_id)
        if color_name_key:
            names = color_name_attr.get('values') if isinstance(color_name_attr.get('values'), list) else []
            raw_name = combo.get(color_name_key) or (names[index] if index < len(names) else (names[0] if names else color))
            color_name = clean_color_name(raw_name) or color
            combo[color_name_key] = color_name
            if color_name and color_name not in normalized_names:
                normalized_names.append(color_name)
        if product.get('title'):
            sku['title'] = product['title']

    if normalized_values:
        color_attr['values'] = normalized_values
        color_attr['valueIds'] = normalized_ids
    if color_name_attr is not None and normalized_names:
        color_name_attr['values'] = normalized_names
    return product


def _is_color_name_attr(attr):
    if not isinstance(attr, dict):
        return False
    if str(_sku_attr_id(attr) or '') == '10097':
        return True
    name = str(attr.get('name') or '').lower()
    return any(kw.lower() in name for kw in COLOR_NAME_KEYWORDS)


def _sku_attr_id(attr):
    if not isinstance(attr, dict):
        return None
    return attr.get('attrId') or attr.get('id') or attr.get('attribute_id') or attr.get('attributeId')


def _sku_attr_dictionary_id(attr):
    if not isinstance(attr, dict):
        return None
    return attr.get('dictionaryId') or attr.get('dictionary_id') or attr.get('dictionary')


def _match_sku_category_attr(attr, category_attrs):
    src_name = str(attr.get('name') or '')
    src_lower = src_name.lower()
    wants_color_name = _is_color_name_attr(attr)
    wants_color = (
        attr.get('skuType') == 'color'
        or src_lower in ('color', 'colour', 'цвет')
        or '颜色' in src_lower
        or 'цвет товара' in src_lower
    ) and not wants_color_name

    if wants_color_name:
        for cat_attr in category_attrs:
            if not isinstance(cat_attr, dict):
                continue
            name = (str(cat_attr.get('name') or '') + ' ' + str(cat_attr.get('name_zh') or '')).lower()
            if any(kw.lower() in name for kw in COLOR_NAME_KEYWORDS):
                return cat_attr

    if wants_color:
        for cat_attr in category_attrs:
            if not isinstance(cat_attr, dict):
                continue
            name = (str(cat_attr.get('name') or '') + ' ' + str(cat_attr.get('name_zh') or '')).lower()
            if (
                'цвет товара' in name
                or '商品颜色' in name
                or ('color' in name and not any(kw.lower() in name for kw in COLOR_NAME_KEYWORDS))
            ):
                return cat_attr

    for cat_attr in category_attrs:
        if isinstance(cat_attr, dict) and _match_attr_name(src_name, cat_attr.get('name', ''), cat_attr.get('name_zh', '')):
            return cat_attr

    return None


def _resolve_sku_attr_defs(sku_attrs, product=None):
    if not isinstance(sku_attrs, list):
        return []

    resolved = [dict(attr) for attr in sku_attrs if isinstance(attr, dict)]
    missing_id_attrs = [a for a in resolved if a.get('name') and not _sku_attr_id(a)]
    if not missing_id_attrs or not product:
        return resolved

    desc_cat_id = product.get('descriptionCategoryId')
    type_id = product.get('typeId')
    if not desc_cat_id or not type_id:
        return resolved

    try:
        category_attrs = _get_bilingual_category_attributes(desc_cat_id, type_id)
    except Exception as e:
        print(f'[build_ozon_skus] SKU属性ID匹配失败: {e}', flush=True)
        return resolved

    for attr in missing_id_attrs:
        matched_attr = _match_sku_category_attr(attr, category_attrs)
        if not matched_attr:
            continue

        attr['attrId'] = matched_attr.get('id')
        if matched_attr.get('dictionary_id'):
            attr['dictionaryId'] = matched_attr.get('dictionary_id')
        if _is_color_name_attr(attr):
            attr['skuType'] = attr.get('skuType') or 'text'
        elif attr.get('skuType') == 'color' or _sku_attr_dictionary_id(attr):
            attr['skuType'] = attr.get('skuType') or 'select'

    return resolved


def _ensure_color_name_in_sku_combos(skus, sku_attrs):
    """Backfill per-SKU color name values before publishing.

    The edit UI stores "Название цвета" as a SKU info attribute in skuAttrs.
    Older saved products, or products saved before the UI sync ran, may have the
    values in skuAttrs but not in each SKU combo. Ozon only receives SKU-level
    attributes from combo, so fill the missing combo key here as a final guard.
    """
    if not isinstance(skus, list) or not isinstance(sku_attrs, list):
        return

    color_attr = next((a for a in sku_attrs if isinstance(a, dict) and a.get('skuType') == 'color'), None)
    color_name_attr = next((a for a in sku_attrs if _is_color_name_attr(a)), None)
    if not color_name_attr:
        return

    color_name = color_attr.get('name') if color_attr else ''
    color_name_attr_name = color_name_attr.get('name')
    color_values = color_attr.get('values') if color_attr and isinstance(color_attr.get('values'), list) else []
    color_name_values = color_name_attr.get('values') if isinstance(color_name_attr.get('values'), list) else []
    if not color_name_attr_name or not color_name_values:
        return

    color_to_name = {}
    for idx, color_value in enumerate(color_values):
        if color_value and idx < len(color_name_values) and color_name_values[idx]:
            color_to_name[str(color_value)] = color_name_values[idx]

    for idx, sku in enumerate(skus):
        if not isinstance(sku, dict):
            continue
        combo = sku.setdefault('combo', {})
        if not isinstance(combo, dict):
            combo = {}
            sku['combo'] = combo
        if combo.get(color_name_attr_name):
            continue

        direct_value = (
            sku.get('colorName')
            or sku.get('color_name')
            or sku.get('Название цвета')
            or sku.get('颜色名称')
        )
        if direct_value:
            combo[color_name_attr_name] = direct_value
            continue

        color_value = combo.get(color_name) if color_name else None
        mapped_value = color_to_name.get(str(color_value)) if color_value is not None else None
        if not mapped_value and idx < len(color_name_values):
            mapped_value = color_name_values[idx]
        if mapped_value:
            combo[color_name_attr_name] = mapped_value


def build_ozon_skus(skus, sku_attrs, product=None):
    """将本地SKU数据转换为 Ozon API 要求的 sources 格式

    本地格式: [{ title, combo, price, oldPrice, stock, weight, length, width, height, skuCode }]
    扩展格式: [{ sku, offerId, price, oldPrice, weight, length, width, height, barcode, title, image, images }]
    Ozon格式: [{ offer_id, price, stock, old_price, weight, dimensions, attributes }]

    Args:
        skus: SKU 列表
        sku_attrs: SKU 属性定义列表
        product: 完整商品对象（用于获取 descriptionCategoryId/typeId 以拉取颜色字典值）
    """
    if not skus or not isinstance(skus, list):
        return []

    sku_attrs = _resolve_sku_attr_defs(sku_attrs, product)
    _ensure_color_name_in_sku_combos(skus, sku_attrs)

    ozon_skus = []
    for sku in skus:
        if not sku or not isinstance(sku, dict):
            continue

        # offer_id 兼容多种字段名：扩展发送 offerId，本地存储为 skuCode
        offer_id = sku.get('offerId') or sku.get('skuCode') or sku.get('offer_id') or sku.get('title') or ''
        source = {
            'offer_id': offer_id,
            'price': str(sku.get('price', 0) or 0),
            'stock': int(sku.get('stock', 0) or 0),
        }

        # 划线价
        old_price = sku.get('oldPrice')
        if old_price:
            source['old_price'] = str(old_price)

        # 条形码
        barcode = sku.get('barcode', '')
        if barcode:
            source['barcode'] = barcode

        # SKU级别重量
        weight = sku.get('weight')
        if weight and float(weight) > 0:
            source['weight'] = float(weight)
            source['weight_unit'] = 'g'

        # SKU级别尺寸
        length = _normalize_dimension_mm(sku.get('length') or sku.get('depth') or 0)
        width = _normalize_dimension_mm(sku.get('width') or 0)
        height = _normalize_dimension_mm(sku.get('height') or 0)
        if length or width or height:
            source['dimension_unit'] = 'mm'
            if length:
                source['depth'] = float(length)
            if width:
                source['width'] = float(width)
            if height:
                source['height'] = float(height)

        # SKU属性（颜色、尺码等组合）
        combo = sku.get('combo') or {}
        if combo and sku_attrs:
            sku_attr_list = []
            # SKU 图片列表（用于颜色样本图上传）
            sku_images = sku.get('images') or []
            print(f'[build_ozon_skus] SKU combo: {combo}', flush=True)
            print(f'[build_ozon_skus] sku_attrs: {[(a.get("name"), _sku_attr_id(a), a.get("skuType")) for a in sku_attrs if isinstance(a, dict)]}', flush=True)
            for attr_name, attr_value in combo.items():
                if not attr_value:
                    continue
                # 查找属性定义
                attr_def = None
                for a in (sku_attrs if isinstance(sku_attrs, list) else []):
                    if a and a.get('name') == attr_name:
                        attr_def = a
                        break
                attr_id = _sku_attr_id(attr_def)
                dictionary_id = _sku_attr_dictionary_id(attr_def)
                if not attr_def or not attr_id:
                    print(f'[build_ozon_skus] 跳过属性 "{attr_name}": attr_def={attr_def is not None}, attrId={_sku_attr_id(attr_def) if attr_def else None}', flush=True)
                    continue

                if attr_def.get('skuType') == 'color' and dictionary_id:
                    # 颜色属性：需要查找 dictionary_value_id
                    color_id = _find_color_id(
                        attr_value,
                        description_category_id=(product or {}).get('descriptionCategoryId'),
                        type_id=(product or {}).get('typeId'),
                        attribute_id=attr_id,
                        dictionary_id=dictionary_id,
                    )
                    color_attr_item = {
                        'id': attr_id,
                        'values': [{'dictionary_value_id': color_id}] if color_id
                                   else [{'value': str(attr_value)}],
                    }
                    # 颜色样本图：将 SKU 图片作为颜色样本上传到 Ozon
                    # Ozon API 中颜色属性的 images 字段用于上传颜色样本图，
                    # 买家在商品页颜色切换器中可看到这些图片（而非标准圆形色块）
                    if sku_images:
                        # Ozon 限制每个颜色样本最多 8 张图片，取前 8 张
                        color_attr_item['images'] = sku_images[:8]
                    sku_attr_list.append(color_attr_item)
                elif attr_def.get('skuType') == 'select' and dictionary_id:
                    # 销售属性（有字典，如尺码/尺寸等）：需要查找 dictionary_value_id
                    # 复用 _find_color_id 的字典查找逻辑（该函数适用于任何字典属性）
                    dict_value_id = _find_color_id(
                        attr_value,
                        description_category_id=(product or {}).get('descriptionCategoryId'),
                        type_id=(product or {}).get('typeId'),
                        attribute_id=attr_id,
                        dictionary_id=dictionary_id,
                    )
                    sku_attr_list.append({
                        'id': attr_id,
                        'values': [{'dictionary_value_id': dict_value_id}] if dict_value_id
                                   else [{'value': str(attr_value)}],
                    })
                else:
                    # 文本属性（包括 SKU信息属性：件数/颜色名称/长度/重量等）
                    sku_attr_list.append({
                        'id': attr_id,
                        'values': [{'value': str(attr_value)}]
                    })

            if sku_attr_list:
                source_attrs = {}
                for attr in sku_attr_list:
                    target = source_attrs.setdefault(attr['id'], {'id': attr['id'], 'values': []})
                    existing = {
                        (value.get('dictionary_value_id'), str(value.get('value') or ''))
                        for value in target['values']
                    }
                    for value in attr.get('values', []):
                        signature = (value.get('dictionary_value_id'), str(value.get('value') or ''))
                        if signature not in existing:
                            target['values'].append(value)
                            existing.add(signature)
                    if attr.get('images'):
                        target['images'] = list(dict.fromkeys(
                            (target.get('images') or []) + attr['images']
                        ))[:8]
                source['attributes'] = list(source_attrs.values())

        ozon_skus.append(source)

    return ozon_skus


def _find_color_id(color_name, description_category_id=None, type_id=None,
                   attribute_id=None, dictionary_id=None):
    """查找颜色名称对应的 Ozon dictionary_value_id

    查找策略（按优先级）：
    1. 从内存缓存查找（基于 description_category_id + type_id + attribute_id）
    2. 从 Ozon API 拉取颜色字典值并缓存，再查找
    3. 通过中文→俄语颜色名映射进行模糊匹配

    Args:
        color_name: 颜色名称（中文或俄语，可能包含"白色（белый）"格式）
        description_category_id: Ozon 二级类目 ID
        type_id: Ozon 三级类型 ID
        attribute_id: 颜色属性 ID
        dictionary_id: 颜色属性的字典 ID

    Returns:
        str: dictionary_value_id，未找到返回 None
    """
    if not color_name or not description_category_id or not type_id or not attribute_id:
        return None

    # 清理颜色名：去除括号内的俄语部分，取中文部分
    clean_name = color_name.split('（')[0].split('(')[0].strip().lower()

    cache_key = (description_category_id, type_id, attribute_id)

    # 1. 检查缓存
    with _color_cache_lock:
        cached_values = _color_cache.get(cache_key)
        if cached_values:
            # 精确匹配（忽略大小写）
            for name, did in cached_values.items():
                if name.lower() == clean_name:
                    return did
            # 模糊匹配：颜色名包含缓存中的关键词
            for name, did in cached_values.items():
                if clean_name in name.lower() or name.lower() in clean_name:
                    return did

    # 2. 从 Ozon API 拉取颜色字典值
    try:
        result = get_attribute_values_full(
            description_category_id, type_id, attribute_id, language='RU'
        )
        values = result.get('result', []) if result else []

        if not values:
            return None

        # 构建缓存：color_name -> dictionary_value_id
        with _color_cache_lock:
            cached_values = {}
            for v in values:
                vid = v.get('id')
                vname = v.get('value', '')
                vinfo = v.get('info', '')
                if vid and vname:
                    # 同时缓存中文名和俄语名
                    cached_values[vname] = str(vid)
                    if vinfo:
                        cached_values[vinfo] = str(vid)
                    # 从 info 中提取俄语名（info 格式通常是 "中文 俄语"）
                    parts = vinfo.split()
                    for part in parts:
                        if part and part not in cached_values:
                            cached_values[part] = str(vid)
            _color_cache[cache_key] = cached_values

        # 3. 在拉取的字典值中查找
        # 精确匹配
        for name, did in cached_values.items():
            if name.lower() == clean_name:
                return did

        # 通过通用层中文→俄语映射查找（统一颜色解析器第二阶段）
        ru_name = _translate_color_to_ru(color_name)
        if ru_name and ru_name != clean_name:
            for name, did in cached_values.items():
                if ru_name.lower() in name.lower() or name.lower() in ru_name.lower():
                    return did

        # 模糊匹配
        for name, did in cached_values.items():
            if clean_name in name.lower() or name.lower() in clean_name:
                return did

    except OzonAPIError as e:
        print(f'[颜色字典] 拉取失败: {e.message}')
    except Exception as e:
        print(f'[颜色字典] 查找异常: {e}')

    return None


def _get_store_currency(store_id=None):
    """获取店铺合同币种（权威来源，Ozon 不允许跨币种发布）

    跨境店铺通常使用 CNY（人民币），本地俄罗斯店铺使用 RUB。

    Args:
        store_id: 指定店铺 ID（即 Store.store_id 字段，非主键）。

    Returns: 币种代码字符串（如 'CNY'/'RUB'），无可用店铺时返回 None
    """
    try:
        from models.account import Store
        if store_id:
            store = Store.find_by_store_id(store_id)
            if store:
                return store.get('currency') or None
    except Exception as e:
        print(f'[币种] 查询店铺币种失败: {e}')
    return None


def _first_positive_number(*values):
    for value in values:
        if value in (None, '', []):
            continue
        try:
            number = float(value)
        except (TypeError, ValueError):
            continue
        if number > 0:
            return number
    return 0


def _normalize_dimension_mm(value, sku_hint=0):
    number = _first_positive_number(value)
    hint = _first_positive_number(sku_hint)
    if not number:
        return 0

    # If SKU has a plausible value and the product-level value is an exact
    # unit-conversion multiple, trust the SKU value. This catches 330 -> 33000
    # and 330 -> 330000 without changing correctly entered dimensions.
    if hint:
        for factor in (10, 100, 1000):
            if abs(number - hint * factor) < 0.01:
                return hint

    # Ozon expects millimeters. Values above a few meters are almost always a
    # duplicated conversion from cm/m to mm in this workflow.
    while number > 3000:
        number = number / 10
    return number


def _resolve_item_dimensions(product):
    dimensions = product.get('dimensions') if isinstance(product.get('dimensions'), dict) else {}
    skus = product.get('skus') or []
    first_sku = next((sku for sku in skus if isinstance(sku, dict)), None)
    sku_length = _first_positive_number(first_sku.get('length'), first_sku.get('depth')) if first_sku else 0
    sku_width = _first_positive_number(first_sku.get('width')) if first_sku else 0
    sku_height = _first_positive_number(first_sku.get('height')) if first_sku else 0

    length = _normalize_dimension_mm(
        _first_positive_number(product.get('length'), dimensions.get('length'), dimensions.get('depth')),
        sku_length,
    )
    width = _normalize_dimension_mm(
        _first_positive_number(product.get('width'), dimensions.get('width')),
        sku_width,
    )
    height = _normalize_dimension_mm(
        _first_positive_number(product.get('height'), dimensions.get('height')),
        sku_height,
    )

    if first_sku and (not length or not width or not height) and sku_length and sku_width and sku_height:
        return sku_length, sku_width, sku_height

    return length, width, height


# "型号名称"类目属性的关键词（中/俄/英），用于将 mergeCode 注入对应属性
_MODEL_ATTR_KEYWORDS = ('型号', 'Название модели', 'Артикул производителя', '厂商型号', 'model_name', 'Model Name')


def _inject_merge_code_to_model_attr(attrs, merge_code):
    """将"合并编号"(mergeCode) 注入到"型号名称"类目属性中

    匹配规则：属性名/中文名包含型号相关关键词（型号/Название модели/Артикул производителя 等）
    注入策略：
    - 若找到型号属性且其 value 为空 → 填充 mergeCode
    - 若型号属性已有值 → 不覆盖
    - 若未找到型号属性 → 不新增（需 prefill_required_attributes 预填以保证 attribute_id 正确）

    Args:
        attrs: 商品属性列表 [{ id, name?, value?, ... }]
        merge_code: 合并编号字符串

    Returns:
        list: 处理后的属性列表（原列表的浅拷贝）
    """
    if not merge_code or not isinstance(attrs, list):
        return attrs

    result = []
    for attr in attrs:
        if not isinstance(attr, dict):
            result.append(attr)
            continue
        # 检查是否为型号类属性
        attr_name = str(attr.get('name', '')) + str(attr.get('name_zh', ''))
        is_model_attr = any(kw.lower() in attr_name.lower() for kw in _MODEL_ATTR_KEYWORDS)
        if is_model_attr:
            # 已有非空值则保留，否则填充 mergeCode
            existing_val = attr.get('value')
            if not existing_val:
                new_attr = dict(attr)
                new_attr['value'] = merge_code
                result.append(new_attr)
                continue
        result.append(attr)
    return result


def build_ozon_product_item(product, store_id=None):
    """将本地商品数据组装为 Ozon /v3/product/import 要求的 item 格式

    分层处理：
    - 顶层固定字段：name, offer_id, price, weight, dimensions 等
    - 动态类目属性：attributes 数组（内容因类目而异）
    - SKU多规格数据：sources 数组（多规格商品）

    Args:
        product: 本地商品对象
        store_id: 目标店铺 ID（用于确定币种）。
    """
    _normalize_product_category_ids(product)
    images = product.get('images') or []
    primary_image = images[0] if images else ''
    depth, width, height = _resolve_item_dimensions(product)

    # 产品级 offer_id（货号）：使用第一个 SKU 的平台SKU（skuCode）
    # 与 Ozon 创建商品页"货号"字段对应；回退到商品 ID
    skus = product.get('skus') or []
    first_sku_code = ''
    if skus and isinstance(skus, list) and skus[0]:
        first_sku_code = skus[0].get('skuCode') or skus[0].get('offerId') or ''

    # 将"合并编号"(mergeCode) 注入"型号名称"类目属性
    # 与 Ozon 创建商品页"型号名称"(Название модели) 字段对应
    # 在 build_ozon_attributes 之前处理，确保空值的型号属性被填充
    product_attrs = product.get('attributes', [])
    if isinstance(product_attrs, list):
        product_attrs = _inject_merge_code_to_model_attr(product_attrs, product.get('mergeCode', ''))

    # 基础 item（产品级）
    # currency_code: 必须与店铺合同币种一致（Ozon 不允许跨币种发布）
    # 优先级：店铺合同币种（权威） > 环境变量 OZON_CURRENCY_CODE > 默认 CNY
    # 注意：不使用商品的 currencyCode 字段，因为它可能被错误设置（如 RUB）导致发布失败
    currency_code = _get_store_currency(store_id) or os.environ.get('OZON_CURRENCY_CODE', 'CNY')
    item = {
        'name': product.get('title', ''),
        'offer_id': first_sku_code or str(product.get('id', '')),
        'description_category_id': product.get('descriptionCategoryId'),
        'type_id': product.get('typeId'),
        'price': str(product.get('price', '') or ''),
        'currency_code': currency_code,
        'vat': VAT_MAP.get(str(product.get('vatRate', '')), '0'),
        'weight': product.get('weight', 0),
        'weight_unit': 'g',
        'dimension_unit': 'mm',
        'width': width,
        'height': height,
        'depth': depth,
        'primary_image': primary_image,
        'images': images,
        'attributes': build_ozon_attributes(product_attrs),
    }

    # 可选字段：仅在有值时添加
    old_price = product.get('oldPrice') or ''
    if old_price:
        item['old_price'] = str(old_price)

    # 商品描述（纯文本）
    description = product.get('description') or ''
    if description:
        item['description'] = description

    barcode = product.get('barcode') or ''
    if barcode:
        item['barcode'] = barcode

    brand = product.get('brand') or '无品牌'
    item['vendor'] = brand

    # 视频URL列表
    videos = product.get('videos') or []
    if videos:
        item['videos'] = videos

    # 评价积分
    points_for_reviews = product.get('pointsForReviews') or ''
    if points_for_reviews:
        item['points_for_reviews'] = points_for_reviews

    # SKU多规格数据（sources）
    skus = product.get('skus') or []
    sku_attrs = product.get('skuAttrs') or []
    if skus:
        item['sources'] = build_ozon_skus(skus, sku_attrs, product)

    return item


def _sku_offer_id(sku):
    if not isinstance(sku, dict):
        return ''
    return str(
        sku.get('offerId')
        or sku.get('skuCode')
        or sku.get('offer_id')
        or sku.get('title')
        or ''
    ).strip()


def _valid_skus(product):
    skus = product.get('skus') or product.get('skuList') or product.get('variants') or []
    if not isinstance(skus, list):
        return []
    return [sku for sku in skus if isinstance(sku, dict) and (_sku_offer_id(sku) or sku.get('price'))]


def _normalize_publish_mode(mode):
    mode = str(mode or '').strip().lower()
    if mode in ('split', 'separate', 'single', 'sku', 'sku_items', 'separate_skus'):
        return 'split'
    if mode in ('merge', 'variant', 'variants', 'group', 'grouped'):
        return 'merge'
    return ''


def _has_merge_model_id(product):
    # model_id comes from the extension "merge variants" field. mergeCode is not used
    # here because it may be auto-filled with the first offer_id for Ozon model attributes.
    for key in ('model_id', 'modelId', 'mergeModelId', 'merge_model_id'):
        value = product.get(key)
        if value is not None and str(value).strip():
            return True
    return False


def _should_split_sku_items(product, publish_mode=None):
    mode = _normalize_publish_mode(publish_mode or product.get('publishMode') or product.get('publish_mode'))
    if mode == 'split':
        return True
    if mode == 'merge':
        return False
    return len(_valid_skus(product)) > 1 and not _has_merge_model_id(product)


def _product_for_single_sku(product, sku):
    split_product = copy.deepcopy(product)
    split_sku = copy.deepcopy(sku)
    offer_id = _sku_offer_id(sku)
    if offer_id:
        split_sku.setdefault('skuCode', offer_id)
        split_sku.setdefault('offerId', offer_id)
    base_title = str(product.get('title') or '').strip()

    split_product['skus'] = [split_sku]
    split_product['skuList'] = [copy.deepcopy(split_sku)]
    split_product['variants'] = [copy.deepcopy(split_sku)]
    split_product['offerId'] = offer_id
    split_product['mergeCode'] = offer_id or product.get('mergeCode') or ''
    # SKU dimensions such as color, size and quantity belong exclusively in
    # Ozon attributes. Appending combo values here polluted the product name.
    split_product['title'] = base_title or str(sku.get('title') or '').strip()

    for sku_key, product_key in (
        ('price', 'price'),
        ('oldPrice', 'oldPrice'),
        ('barcode', 'barcode'),
        ('weight', 'weight'),
        ('length', 'length'),
        ('width', 'width'),
        ('height', 'height'),
    ):
        value = sku.get(sku_key)
        if value not in (None, '', []):
            split_product[product_key] = value

    sku_images = sku.get('images') or []
    if isinstance(sku_images, list) and sku_images:
        product_images = product.get('images') if isinstance(product.get('images'), list) else []
        # SKU 主图排在最前，但不能覆盖商品完整图集。一键上架采集的 SKU
        # 通常只有当前变体封面，旧逻辑会把 20 多张商品图缩成 1 张。
        split_product['images'] = list(dict.fromkeys(
            [image for image in sku_images + product_images if image]
        ))

    return split_product


def _merge_source_attrs_to_item(item):
    sources = item.get('sources') or []
    if not sources or not isinstance(sources[0], dict):
        return item

    source_attrs = sources[0].get('attributes') or []
    if not isinstance(source_attrs, list) or not source_attrs:
        return item

    item_attrs = item.get('attributes') if isinstance(item.get('attributes'), list) else []
    by_id = {attr.get('id'): idx for idx, attr in enumerate(item_attrs) if isinstance(attr, dict) and attr.get('id')}

    for attr in source_attrs:
        if not isinstance(attr, dict) or not attr.get('id') or not attr.get('values'):
            continue
        if attr['id'] in by_id:
            item_attrs[by_id[attr['id']]] = attr
        else:
            by_id[attr['id']] = len(item_attrs)
            item_attrs.append(attr)

    item['attributes'] = item_attrs
    return item


def build_ozon_product_items(product, store_id=None, publish_mode=None):
    """Build one or many Ozon import items from one ERP product.

    merge mode: one Ozon card with multiple sources.
    split mode: one Ozon card per SKU, each card keeps a single source.
    """
    normalize_collected_color_skus(product)
    skus = _valid_skus(product)
    if not skus or not _should_split_sku_items(product, publish_mode):
        item = build_ozon_product_item(product, store_id=store_id)
        # Ozon item.attributes 是最终商品属性。单 SKU 及合并模式此前只把
        # 颜色名称等 SKU 属性放在 sources 中，导致后台看不到 10097。
        _merge_source_attrs_to_item(item)
        return [item]

    items = []
    seen_offer_ids = set()
    for index, sku in enumerate(skus, start=1):
        split_product = _product_for_single_sku(product, sku)
        item = build_ozon_product_item(split_product, store_id=store_id)
        _merge_source_attrs_to_item(item)

        offer_id = str(item.get('offer_id') or '').strip()
        if not offer_id or offer_id in seen_offer_ids:
            offer_id = f'{product.get("id", "sku")}-{index}'
            item['offer_id'] = offer_id
            if item.get('sources'):
                item['sources'][0]['offer_id'] = offer_id
        seen_offer_ids.add(offer_id)
        items.append(item)

    return items or [build_ozon_product_item(product, store_id=store_id)]


# 品牌属性关键词（用于按 name 查重，防止扫描器提取的品牌被默认"无品牌"覆盖）
BRAND_KEYWORDS = ('品牌', 'бренд', 'brand', 'производитель')


def _is_no_brand_value(value):
    text = str(value or '').strip().lower()
    return not text or text in ('无品牌', 'нет бренда', 'none', 'copy', 'no brand')


def prefill_required_attributes(product):
    """为商品预填 Ozon 类目必填属性的默认值

    根据商品的 descriptionCategoryId + typeId，拉取该类目的属性列表，
    对必填属性尝试自动填充常见默认值（如品牌、年份、型号名等）。

    Args:
        product: 商品对象（将被修改，添加 attributes 字段）

    Returns:
        dict: {
            'prefilled': int,           # 已预填的属性数
            'required_remaining': list, # 仍需手动填写的必填属性
            'all_required': int,        # 必填属性总数
        }
    """
    desc_cat_id = product.get('descriptionCategoryId')
    type_id = product.get('typeId')
    if not desc_cat_id or not type_id:
        return {'prefilled': 0, 'required_remaining': [], 'all_required': 0}

    try:
        all_attrs = _get_bilingual_category_attributes(desc_cat_id, type_id)
    except Exception as e:
        print(f'[属性预填] 拉取类目属性失败: {e}')
        return {'prefilled': 0, 'required_remaining': [], 'all_required': 0, 'error': str(e)}

    # 筛选必填属性
    required_attrs = [a for a in all_attrs if a.get('is_required') or a.get('required')]

    # 通用必填属性默认值（配置化，可在 data/category_mapping_general.py 调整）
    from data.category_mapping_general import resolve_default_value

    # 现有属性（可能是 dict 格式的 1688 源属性，或扫描器添加的无 id 条目）
    existing_attrs = product.get('attributes', [])
    existing_attr_ids = set()
    existing_attr_names = set()  # 已有属性名（小写），用于品牌等无 id 属性的查重
    existing_brand_value = None  # 扫描器提取的真实品牌值
    if isinstance(existing_attrs, list):
        for a in existing_attrs:
            if not isinstance(a, dict):
                continue
            if a.get('id'):
                existing_attr_ids.add(a.get('id'))
            name = (a.get('name') or '').strip()
            if name:
                existing_attr_names.add(name.lower())
                # 记录扫描器提取的品牌值（无 id 但有 name + value 的品牌条目）
                name_lower = name.lower()
                if any(kw in name_lower for kw in BRAND_KEYWORDS):
                    val = (a.get('value') or '').strip()
                    if not _is_no_brand_value(val):
                        existing_brand_value = val

    # 尝试预填
    prefilled_attrs = list(existing_attrs) if isinstance(existing_attrs, list) else []
    prefilled_count = 0
    remaining = []

    for attr in required_attrs:
        attr_id = attr.get('id')
        if attr_id in existing_attr_ids:
            continue  # 已有值（按 id 匹配）

        attr_name = attr.get('name', '') or ''
        attr_name_zh = attr.get('name_zh', '') or attr_name
        attr_name_lower = attr_name.lower()
        attr_name_zh_lower = attr_name_zh.lower()

        # 品牌类属性：按 name 查重，防止扫描器提取的真实品牌被默认"无品牌"覆盖
        is_brand_attr = any(kw in attr_name_lower or kw in attr_name_zh_lower for kw in BRAND_KEYWORDS)
        if is_brand_attr:
            # 扫描器已添加品牌条目（无 id 但有 name）→ 跳过预填默认值
            if any(any(kw in n for kw in BRAND_KEYWORDS) for n in existing_attr_names):
                continue
            # 商品本身已有真实品牌字段 → 跳过预填默认值
            product_brand = (product.get('brand') or '').strip()
            if not _is_no_brand_value(product_brand):
                continue

        # 只自动填写能从商品自身确定的字段。材质、颜色、产地、年份等
        # 不能跨类目猜默认值，否则任务虽然提交成功，商品信息却是错误的。
        is_model_attr = any(
            keyword.lower() in (attr_name + ' ' + attr_name_zh).lower()
            for keyword in _MODEL_ATTR_KEYWORDS
        )
        if is_brand_attr or is_model_attr:
            default_val = resolve_default_value(attr_name, attr_name_zh, product)
        else:
            default_val = None

        if default_val:
            # 品牌类属性：若已有真实品牌值，用真实品牌而非默认"无品牌"
            if is_brand_attr and existing_brand_value:
                default_val = existing_brand_value
            prefilled_attrs.append({
                'id': attr_id,
                'name': attr_name_zh,
                'value': default_val,
                '_prefilled': True,  # 标记为预填，前端可高亮提示
            })
            prefilled_count += 1
        else:
            remaining.append({
                'id': attr_id,
                'name': attr_name_zh,
                'description': attr.get('description', ''),
                'type': attr.get('type', ''),
                'dictionary_id': attr.get('dictionary_id'),
            })

    # 更新商品的 attributes
    if prefilled_count > 0:
        product['attributes'] = prefilled_attrs

    return {
        'prefilled': prefilled_count,
        'required_remaining': remaining,
        'all_required': len(required_attrs),
    }


def _is_retryable_error(error):
    """判断错误是否值得重试

    不可重试的错误（参数错误、认证错误、业务逻辑错误）：
    - 400 客户端错误（参数格式错误）
    - 401 认证失败
    - 403 权限不足
    - 货币不符（currency_differs_from_contract）
    - 必填字段缺失（error_attribute_values_empty 等）
    - "not_found" 类错误

    可重试的错误（临时性故障）：
    - 网络超时、连接失败
    - 429 速率限制
    - 5xx 服务器错误
    - 未返回 task_id（可能是临时性故障）
    """
    if isinstance(error, OzonAPIError):
        status_code = error.status_code
        message = str(error.message).lower()

        # 不可重试的 HTTP 状态码
        if status_code in (400, 401, 403, 404):
            return False

        # 不可重试的业务错误关键词
        non_retryable_keywords = [
            'currency_differs_from_contract',  # 货币不符
            'not_found',                       # 资源不存在
            'invalid',                         # 参数无效
            'required',                        # 必填字段缺失
            'format',                          # 格式错误
            '已经存在',                         # 商品已存在
            '不存在',                           # 资源不存在
            '未配置',                           # 配置缺失
        ]
        for kw in non_retryable_keywords:
            if kw in message:
                return False

        # 429 速率限制：可重试但需要更长间隔
        if status_code == 429:
            return True

        # 5xx 服务器错误：可重试
        if status_code and status_code >= 500:
            return True

        # 其他 OzonAPIError 默认不可重试（保守策略，避免浪费配额）
        return False

    # 网络相关异常（Timeout、ConnectionError 被包装为 OzonAPIError，但其他异常可能是可重试的）
    error_str = str(error).lower()
    if any(kw in error_str for kw in ['timeout', 'connection', 'timed out', '连接']):
        return True

    # 其他未知错误：不重试（保守策略）
    return False


def _apply_price_offset(product, price_offset):
    try:
        offset = float(price_offset or 0)
    except (TypeError, ValueError):
        offset = 0
    if not offset:
        return product

    for key in ('price', 'oldPrice'):
        value = product.get(key)
        if value not in (None, ''):
            try:
                product[key] = round(float(value) + offset, 2)
            except (TypeError, ValueError):
                pass

    for sku in (product.get('skus') or []):
        if not isinstance(sku, dict):
            continue
        for key in ('price', 'oldPrice'):
            value = sku.get(key)
            if value not in (None, ''):
                try:
                    sku[key] = round(float(value) + offset, 2)
                except (TypeError, ValueError):
                    pass

    return product


def _publish_product_async(task_id, product_id, platform, store_id=None, publish_mode=None, price_offset=0, max_retries=3):
    """后台线程执行的完整发布流程：图片预处理 → 数据组装 → 调用 Ozon API（含分类重试）

    所有耗时操作（图片下载、数据组装、API 调用）都在后台线程执行，
    避免阻塞 HTTP 请求线程。

    支持断点续传：每完成一个步骤会将进度写入 task.progress 字段。
    重试时（retry_task 调用本函数）若商品未被修改且已组装完成，则跳过
    图片预处理和数据组装，直接复用缓存的 ozon_item 调用 Ozon API。

    Args:
        task_id: 本地发布任务 ID
        product_id: 商品 ID
        platform: 目标平台
        store_id: 目标店铺 ID（用于多店铺发布时透传 Ozon API 凭证和币种）。
                  必须传入，避免误用其他店铺凭证。
        max_retries: Ozon API 调用最大重试次数
    """
    # 注意：本系统使用 JSON 文件存储（threading.Lock 保护）+ SQLite（db.py 直连），
    # 不依赖 Flask-SQLAlchemy，因此后台线程无需 app context。
    # 之前的 `from flask import create_app` 是错误的（Flask 不导出 create_app），
    # 会导致 ImportError 使后台线程立即崩溃，任务永远卡在 pending。

    # === 步骤1: 重新加载商品数据 ===
    product = Product.find_by_id(product_id)
    if not product:
        PublishTask.update(task_id, {
            "status": "failed",
            "error": f'商品不存在: {product_id}',
        })
        return

    # 读取断点续传进度
    task = PublishTask.find_by_id(task_id) or {}
    publish_mode = publish_mode or task.get('publishMode') or task.get('publish_mode')
    price_offset = price_offset if price_offset not in (None, '') else task.get('priceOffset', 0)
    progress = task.get('progress') or {}
    diagnostics = progress.get('diagnostics') or {}
    cached_items = None
    # 仅当缓存的商品 updatedAt 与当前一致时才复用（保证数据一致性）
    if (progress.get('step') == 'assembled'
            and progress.get('productUpdatedAt') == product.get('updatedAt')):
        cached_items = progress.get('ozonItems')
        if cached_items is None and progress.get('ozonItem'):
            cached_items = [progress.get('ozonItem')]
        print(f'[发布] 商品 {product_id} 命中断点续传缓存，跳过图片预处理和数据组装')

    # === 步骤2: 图片预处理（并发下载转存） ===
    # 断点续传命中时跳过此步骤
    if cached_items is None:
        try:
            _normalize_product_category_ids(product)
            _apply_price_offset(product, price_offset)
            img_ok, img_errors = preprocess_images_for_publish(product)
            if not img_ok:
                error_msg = '图片预处理失败: ' + '; '.join(img_errors[:5])
                PublishTask.update(task_id, {
                    "status": "failed",
                    "error": error_msg,
                })
                Product.update(product_id, {"publishStatus": "failed"})
                print(f'[发布] 商品 {product_id} 图片预处理失败: {img_errors[:3]}')
                return
        except Exception as e:
            PublishTask.update(task_id, {
                "status": "failed",
                "error": f'图片预处理异常: {str(e)}',
            })
            Product.update(product_id, {"publishStatus": "failed"})
            print(f'[发布] 商品 {product_id} 图片预处理异常: {e}')
            return

        # === 步骤3: 组装 Ozon 商品数据 ===
        try:
            # 日志：打印商品属性状态
            raw_attrs = product.get('attributes', [])
            print(f'[发布] 商品 {product_id} attributes 类型: {type(raw_attrs).__name__}, 数量: {len(raw_attrs) if isinstance(raw_attrs, list) else "N/A"}')
            if isinstance(raw_attrs, list):
                for a in raw_attrs[:10]:
                    if isinstance(a, dict):
                        print(f'  - id={a.get("id")}, name={a.get("name","")}, value={str(a.get("value",""))[:50]}, dict_id={a.get("dictionary_value_id")}, dict_ids={a.get("dictionary_value_ids")}')

            # 按名称匹配补全无 id 的采集属性（扩展一键上架场景）
            # 扩展采集的 attributes 只有 name+value，无 Ozon 属性 id，
            # build_ozon_attributes 会因缺少 id 而丢弃这些属性
            try:
                match_result = match_attributes_by_name(product)
                if match_result.get('total_no_id', 0) > 0:
                    print(f'[发布] 商品 {product_id} 属性名称匹配: {match_result["matched"]}/{match_result["total_no_id"]} 成功, {match_result["skipped"]} 未匹配')
            except Exception as match_err:
                print(f'[发布] 商品 {product_id} 属性名称匹配失败（非致命）: {match_err}')

            # 预填必填类目属性（型号名称/品牌/年份/产地等）
            # 确保型号属性(Название модели)存在于 attributes 列表中，以便后续注入 mergeCode
            try:
                prefill_result = prefill_required_attributes(product)
                if prefill_result.get('prefilled', 0) > 0:
                    print(f'[发布] 商品 {product_id} 预填 {prefill_result["prefilled"]} 个必填属性')
                    # 预填的品牌等字段也可能是字典属性，必须再次转换为
                    # dictionary_value_id 后才能进入最终 payload。
                    match_attributes_by_name(product)
            except Exception as prefill_err:
                print(f'[发布] 商品 {product_id} 属性预填失败（非致命）: {prefill_err}')

            ozon_items = build_ozon_product_items(product, store_id=store_id, publish_mode=publish_mode)
            normalized_mode = _normalize_publish_mode(publish_mode)
            valid_sku_count = len(_valid_skus(product))
            if normalized_mode == 'split' and valid_sku_count and len(ozon_items) != valid_sku_count:
                raise ValueError(
                    f'SKU组装数量不一致: ERP={valid_sku_count}, Ozon items={len(ozon_items)}'
                )
            diagnostics = validate_ozon_product_items(product, ozon_items)
            diagnostics['summary'] = {
                'itemCount': len(ozon_items),
                'erpSkuCount': valid_sku_count,
                'offerIds': [item.get('offer_id') for item in ozon_items],
                'attributeIds': sorted({
                    attr.get('id')
                    for item in ozon_items
                    for attr in (item.get('attributes') or [])
                    if isinstance(attr, dict) and attr.get('id')
                }),
                'hasProductColor10096': any(
                    attr.get('id') == 10096
                    for item in ozon_items
                    for attr in (item.get('attributes') or [])
                    if isinstance(attr, dict)
                ),
                'hasColorName10097': any(
                    attr.get('id') == 10097
                    for item in ozon_items
                    for attr in (item.get('attributes') or [])
                    if isinstance(attr, dict)
                ),
            }
            if diagnostics['warnings']:
                print(f'[发布] 商品 {product_id} payload 警告: {diagnostics["warnings"][:10]}')
            if not diagnostics['valid']:
                raise ValueError('Payload校验失败: ' + '; '.join(diagnostics['errors'][:12]))
            first_item = ozon_items[0] if ozon_items else {}
            print(f'[发布] 商品 {product_id} Ozon items 提交: {len(ozon_items)} 个, mode={_normalize_publish_mode(publish_mode) or "auto"}')
            print(f'[发布] 商品 {product_id} Ozon attributes 提交: {len(first_item.get("attributes", []))} 条')
            for a in first_item.get('attributes', [])[:10]:
                print(f'  → id={a.get("id")}, values={a.get("values", [])}')
        except Exception as e:
            PublishTask.update(task_id, {
                "status": "failed",
                "error": f'商品数据组装失败: {str(e)}',
            })
            Product.update(product_id, {"publishStatus": "failed"})
            _sync_publish_record(product, PublishTask.find_by_id(task_id), store_name='')
            print(f'[发布] 商品 {product_id} 数据组装失败: {e}')
            return

        # 保存断点续传进度：组装完成，可跳过前两步
        PublishTask.update(task_id, {
            "progress": {
                "step": "assembled",
                "ozonItems": ozon_items,
                "ozonItem": ozon_items[0] if len(ozon_items) == 1 else None,
                "productUpdatedAt": product.get('updatedAt'),
                "publishMode": publish_mode,
                "diagnostics": diagnostics,
            },
        })
    else:
        ozon_items = cached_items

    # === 步骤4: 调用 Ozon API（含令牌桶限流 + 分类重试） ===
    # 解析目标店铺凭证（多店铺发布：按 store_id 取对应 client_id/api_key）
    try:
        if not store_id:
            raise ValueError('缺少目标店铺，请先选择要发布到的 Ozon 店铺')
        from services.ozon_api import _get_store_credentials
        client_id, api_key = _get_store_credentials(store_id)
    except Exception as e:
        error_msg = f'店铺授权信息读取失败: {str(e)}'
        PublishTask.update(task_id, {
            "status": "failed",
            "error": error_msg,
        })
        Product.update(product_id, {
            "publishStatus": "failed",
            "publishError": error_msg,
        })
        _sync_publish_record(product, PublishTask.find_by_id(task_id), store_name='')
        print(f'[发布] 商品 {product_id} {error_msg}')
        return

    last_error = None
    for attempt in range(1, max_retries + 1):
        # 令牌桶限流：批量发布时避免触发 Ozon 429 速率限制
        _ozon_rate_limiter.acquire(timeout=60)

        try:
            result = import_products(ozon_items, client_id=client_id, api_key=api_key)
            ozon_task_id = result.get('result', {}).get('task_id')

            if ozon_task_id:
                PublishTask.update(task_id, {
                    "status": "processing",
                    "ozonTaskId": ozon_task_id,
                    "error": None,
                    "progress": {
                        "step": "submitted",
                        "ozonTaskId": ozon_task_id,
                        "diagnostics": diagnostics,
                    },
                })
                _sync_publish_record(product, PublishTask.find_by_id(task_id), store_name='')
                print(f'[发布] 商品 {product_id} 提交成功 (task_id={ozon_task_id}, 尝试 {attempt}/{max_retries})')

                return
            else:
                last_error = OzonAPIError('Ozon API 未返回 task_id')
        except OzonAPIError as e:
            last_error = e
            print(f'[发布] 商品 {product_id} 第 {attempt} 次失败: {e.message}')
        except Exception as e:
            last_error = e
            print(f'[发布] 商品 {product_id} 第 {attempt} 次异常: {str(e)}')

        # 分类重试：判断错误是否可重试
        if not _is_retryable_error(last_error):
            print(f'[发布] 商品 {product_id} 错误不可重试，立即终止: {last_error}')
            break

        # 如果不是最后一次尝试，等待后重试（429 速率限制等待更久）
        if attempt < max_retries:
            wait_time = PublishService.RETRY_INTERVAL
            if isinstance(last_error, OzonAPIError) and last_error.status_code == 429:
                wait_time = PublishService.RETRY_INTERVAL * 3  # 速率限制等待更久
            time.sleep(wait_time)

    # 所有重试都失败，标记为 failed（保留 progress 以便手动重试时可复用）
    final_error = f'发布失败: {str(last_error) if last_error else "未知错误"}'
    PublishTask.update(task_id, {
        "status": "failed",
        "error": final_error,
    })
    Product.update(product_id, {
        "publishStatus": "failed",
        "publishError": final_error,
    })
    _sync_publish_record(product, PublishTask.find_by_id(task_id), store_name='')
    print(f'[发布] 商品 {product_id} 发布最终失败: {last_error}')


def _sync_publish_record(product, task, store_name=''):
    """创建或更新上架记录（PublishRecord），与 PublishTask 状态同步

    每次发布时创建一条上架记录，后续状态变更时通过 productId 查找并更新。
    """
    if not product:
        return None
    product_id = product.get('id')
    if not product_id:
        return None

    # 查找是否已有该商品的上架记录（同商品复用，不重复创建）
    existing = None
    all_records = PublishRecord.find_all()
    for r in all_records:
        if r.get('productId') == product_id:
            existing = r
            break

    record_data = {
        'productId': product_id,
        'title': product.get('title', ''),
        'price': product.get('price', 0),
        'images': product.get('images', []),
        'status': task.get('status', 'pending') if task else 'pending',
        'platform': 'ozon',
        'storeId': task.get('storeId') if task else None,
        'storeName': store_name,
        'sourceUrl': product.get('originalUrl', '') or (product.get('sourceLinks', [{}])[0].get('url', '') if product.get('sourceLinks') else ''),
        'sourceName': product.get('sourceName', ''),
        'sourceId': product.get('sourceId', '') or product.get('productId', ''),
        'publisher': product.get('assignee', '') or product.get('publisher', ''),
        'ozonProductId': product.get('ozonProductId'),
        'ozonTaskId': task.get('ozonTaskId') if task else None,
        'error': task.get('error') if task else None,
        'errors': task.get('errors', []) if task else [],
    }

    if existing:
        return PublishRecord.update(existing['id'], record_data)
    else:
        return PublishRecord.create(record_data)


class PublishService:
    """发布任务管理服务

    支持异步发布和失败重试。发布任务通过线程池在后台执行，
    避免阻塞 HTTP 请求线程，批量发布时尤为关键。
    """

    # 发布失败最大重试次数
    MAX_RETRIES = 3
    # 重试间隔（秒）
    RETRY_INTERVAL = 5

    @staticmethod
    def create_task(product_id, platform='ozon', store_id=None, publish_mode=None, price_offset=0):
        """创建发布任务并异步提交到 Ozon

        流程（全异步，HTTP 请求立即返回）：
        1. 验证商品存在
        2. 创建本地任务记录（status=pending）
        3. 提交到后台线程池：图片预处理 → 数据组装 → 调用 Ozon API（含分类重试）
        4. 立即返回任务对象，前端通过轮询查询状态

        所有耗时操作（图片下载、数据组装、API 调用）均在后台线程执行，
        HTTP 请求不会阻塞，批量发布时尤为关键。

        :param product_id: 商品 ID
        :param platform: 目标平台
        :param store_id: 目标店铺 ID（多店铺发布时透传 API 凭证和币种）。
        :return: 任务对象
        """
        # 验证商品存在
        product = Product.find_by_id(product_id)
        if not product:
            raise ValueError(f'商品不存在: {product_id}')
        if not store_id:
            raise ValueError('请选择要发布到的 Ozon 店铺')

        # 创建本地任务记录（status=pending）
        # storeId 持久化到任务记录，便于重试/状态查询时复用同一店铺凭证
        task = PublishTask.create({
            "productId": product_id,
            "platform": platform,
            "storeId": store_id,
            "publishMode": _normalize_publish_mode(publish_mode) or publish_mode,
            "priceOffset": price_offset,
            "status": "pending",
        })

        # 更新商品发布状态
        Product.update(product_id, {
            "publishStatus": "processing",
            "publishTaskId": task['id'],
        })

        # 创建/更新上架记录
        store_name = ''
        if store_id:
            from models.account import Store
            store = Store.find_by_store_id(store_id)
            if store:
                store_name = store.get('store_name', '') or store.get('name', '')
        _sync_publish_record(product, task, store_name=store_name)

        # 提交到后台线程池异步执行完整发布流程
        # （图片预处理 + 数据组装 + Ozon API 调用 + 分类重试）
        _executor.submit(_publish_product_async, task['id'], product_id, platform, store_id, publish_mode, price_offset)

        return task

    @staticmethod
    def retry_task(task_id):
        """重试失败的发布任务（支持断点续传）

        将 failed 状态的任务重新提交到后台线程池。
        若任务在失败前已完成"图片预处理 + 数据组装"（task.progress.step == 'assembled'），
        且商品未被修改，则跳过前两步直接调用 Ozon API，节省图片下载和组装时间。

        :param task_id: 失败的发布任务 ID
        :return: 更新后的任务对象
        :raises ValueError: 任务不存在或不可重试
        """
        task = PublishTask.find_by_id(task_id)
        if not task:
            raise ValueError(f'任务不存在: {task_id}')

        # 仅允许 failed 状态的任务重试
        if task.get('status') not in ('failed',):
            raise ValueError(f'任务当前状态为 {task.get("status")}，仅 failed 状态可重试')

        product_id = task.get('productId')
        platform = task.get('platform', 'ozon')
        store_id = task.get('storeId')  # 复用任务创建时的目标店铺
        publish_mode = task.get('publishMode') or task.get('publish_mode')
        price_offset = task.get('priceOffset', 0)

        # 已成功提交到 Ozon（有 ozonTaskId）则不应重试，改为查询状态
        if task.get('ozonTaskId'):
            raise ValueError('任务已提交到 Ozon，请使用状态查询而非重试')

        # 重置任务状态为 pending，保留 progress 字段供断点续传使用
        PublishTask.update(task_id, {
            "status": "pending",
            "error": None,
        })
        Product.update(product_id, {"publishStatus": "processing"})

        # 同步上架记录状态
        product = Product.find_by_id(product_id)
        if product:
            _sync_publish_record(product, PublishTask.find_by_id(task_id), store_name='')

        # 重新提交到后台线程池
        _executor.submit(_publish_product_async, task_id, product_id, platform, store_id, publish_mode, price_offset)

        return PublishTask.find_by_id(task_id)

    @staticmethod
    def check_status(task):
        """
        查询 Ozon 发布任务的真实状态
        :param task: 发布任务对象
        :return: 状态信息字典
        """
        ozon_task_id = task.get('ozonTaskId')
        if not ozon_task_id:
            return {'status': task.get('status', 'pending'), 'message': '无Ozon任务ID'}

        # 多店铺发布：从任务记录读取目标店铺凭证
        store_id = task.get('storeId')
        client_id, api_key = (None, None)
        if store_id:
            from services.ozon_api import _get_store_credentials
            client_id, api_key = _get_store_credentials(store_id)

        # 调用 Ozon API 查询真实状态
        try:
            result = get_import_info(ozon_task_id, client_id=client_id, api_key=api_key)
            items = result.get('result', {}).get('items', [])

            if not items:
                return {'status': 'processing', 'message': 'Ozon正在处理中...'}

            statuses = [str(item.get('status', '') or '').strip().lower() for item in items]
            all_errors = []
            for item in items:
                for err in (item.get('errors') or []):
                    all_errors.append(err)

            product_ids = [str(item.get('product_id')) for item in items if item.get('product_id')]
            error_details = _format_ozon_errors(all_errors)

            if all_errors and product_ids:
                local_status = 'published_with_errors'
            elif all_errors:
                local_status = 'failed'
            elif any(status in OZON_IMPORT_PROCESSING_STATUSES for status in statuses):
                local_status = 'processing'
            elif statuses and all(status in OZON_IMPORT_SUCCESS_STATUSES for status in statuses) and not all_errors:
                local_status = 'published'
            elif product_ids and (all_errors or any(status in OZON_IMPORT_SUCCESS_STATUSES for status in statuses)):
                local_status = 'published_with_errors'
            elif any(status in OZON_IMPORT_FAILED_STATUSES for status in statuses):
                local_status = 'failed'
            elif all(status == 'skipped' for status in statuses):
                local_status = 'skipped'
            else:
                local_status = 'processing'

            # 更新本地任务状态
            update_data = {'status': local_status, 'queryLastError': None}

            if local_status in ('published', 'published_with_errors'):
                if product_ids:
                    update_data['ozonProductId'] = product_ids[0]
                    update_data['ozonProductIds'] = product_ids
                    Product.update(task['productId'], {
                        'publishStatus': local_status,
                        'ozonProductId': product_ids[0],
                        'ozonProductIds': product_ids,
                    })

                # 收集错误详情
                if error_details:
                    update_data['errors'] = error_details

            elif local_status == 'failed':
                error_msg = '; '.join(error_details) if error_details else f'发布失败（Ozon状态: {", ".join(statuses) or "未知"}）'
                update_data['error'] = error_msg
                Product.update(task['productId'], {
                    'publishStatus': 'failed',
                    'publishError': error_msg,
                })

            elif local_status == 'skipped':
                Product.update(task['productId'], {
                    'publishStatus': 'skipped',
                })

            PublishTask.update(task['id'], update_data)

            # 同步上架记录
            updated_task = PublishTask.find_by_id(task['id'])
            product = Product.find_by_id(task.get('productId'))
            if product and updated_task:
                _sync_publish_record(product, updated_task, store_name='')

            message_map = {
                'published': f'发布成功 (Ozon ID: {update_data.get("ozonProductId", "-")})',
                'published_with_errors': f'已创建但需修正 (Ozon ID: {update_data.get("ozonProductId", "-")})',
                'processing': 'Ozon正在审核中...',
                'failed': update_data.get('error', '发布失败'),
                'skipped': '商品被 Ozon 跳过',
            }

            response = {
                'status': local_status,
                'message': message_map.get(local_status, '未知状态'),
            }
            if update_data.get('errors'):
                response['errors'] = update_data['errors']

            return response

        except OzonAPIError as e:
            error_msg = f'状态查询失败: {str(e.message)}'
            PublishTask.update(task['id'], {
                'queryLastError': error_msg,
            })
            return {'status': 'processing', 'message': error_msg}
        except Exception as e:
            error_msg = f'状态查询异常: {str(e)}'
            PublishTask.update(task['id'], {
                'queryLastError': error_msg,
            })
            return {'status': 'processing', 'message': error_msg}

    @staticmethod
    def batch_refresh(tasks):
        """批量刷新多个任务的状态"""
        results = []
        for task in tasks:
            result = PublishService.check_status(task)
            results.append(result)
        return results

    @staticmethod
    def get_processing_tasks():
        """获取所有处于 processing 状态的发布任务（供后台轮询使用）"""
        all_tasks = PublishTask.find_all()
        return [t for t in all_tasks if t.get('status') == 'processing' and t.get('ozonTaskId')]

    @staticmethod
    def refresh_all_processing():
        """刷新所有 processing 状态的发布任务（后台定时调用）

        遍历所有 processing 状态的任务，调用 check_status 更新状态。
        返回更新数量统计。
        """
        tasks = PublishService.get_processing_tasks()
        updated = 0
        for task in tasks:
            try:
                result = PublishService.check_status(task)
                if result.get('status') != 'processing':
                    updated += 1
            except Exception as e:
                print(f'[后台轮询] 任务 {task.get("id")} 刷新失败: {e}')
        if updated > 0:
            print(f'[后台轮询] 共刷新 {len(tasks)} 个任务，{updated} 个状态已更新')
        return {'total': len(tasks), 'updated': updated}

    @staticmethod
    def recover_stuck_tasks():
        """恢复卡住的发布任务（启动时调用）

        服务重启后，所有尚未拿到 Ozon taskId 的任务（线程池已丢失或提交前异常）需要重新入队。
        - pending/processing 且无 ozonTaskId：重新提交到后台线程池
        - processing 且有 ozonTaskId：交给后台轮询线程刷新状态

        Returns:
            dict: {'requeued': int, 'total': int}
        """
        all_tasks = PublishTask.find_all()
        stuck = [
            t for t in all_tasks
            if t.get('status') in ('pending', 'processing') and not t.get('ozonTaskId')
        ]
        if not stuck:
            return {'requeued': 0, 'total': 0}

        requeued = 0
        for task in stuck:
            task_id = task.get('id')
            product_id = task.get('productId')
            platform = task.get('platform', 'ozon')
            store_id = task.get('storeId')  # 恢复时复用任务创建时的目标店铺
            publish_mode = task.get('publishMode') or task.get('publish_mode')
            price_offset = task.get('priceOffset', 0)
            if not product_id:
                PublishTask.update(task_id, {
                    'status': 'failed',
                    'error': '任务缺少 productId，无法恢复',
                })
                continue
            # 重新提交到后台线程池
            _executor.submit(_publish_product_async, task_id, product_id, platform, store_id, publish_mode, price_offset)
            requeued += 1
            print(f'[启动恢复] 重新入队任务 {task_id} (商品 {product_id})')

        if requeued > 0:
            print(f'[启动恢复] 共重新入队 {requeued} 个卡住的发布任务')
        return {'requeued': requeued, 'total': len(stuck)}


def _build_price_stock_items(product, updates):
    """根据更新数据构建 prices_items / stocks_items

    支持三种输入格式（按优先级匹配）：
    1. 显式分项格式：
       { prices: [{offer_id, price, old_price?}], stocks: [{offer_id, stock}] }
    2. SKU 列表格式（使用商品的 skuList 中各 SKU 的 offer_id）：
       { skuList: [{offerId/skuCode, price, oldPrice, stock}] }
    3. 整体格式（用同一价格/库存覆盖商品的所有 SKU）：
       { price, oldPrice?, stock? }

    Returns:
        tuple: (prices_items, stocks_items)
    """
    prices_items = []
    stocks_items = []

    # 格式1：显式分项
    if isinstance(updates.get('prices'), list) or isinstance(updates.get('stocks'), list):
        for p in updates.get('prices') or []:
            if not p or not p.get('offer_id'):
                continue
            price_data = {'offer_id': str(p['offer_id']), 'price': {'price': str(p.get('price', 0))}}
            if p.get('old_price') is not None:
                price_data['price']['old_price'] = str(p['old_price'])
            prices_items.append(price_data)
        for s in updates.get('stocks') or []:
            if not s or not s.get('offer_id'):
                continue
            stocks_items.append({
                'offer_id': str(s['offer_id']),
                'stock': int(s.get('stock', 0) or 0),
            })
        return prices_items, stocks_items

    # 格式2：SKU 列表
    if isinstance(updates.get('skuList'), list):
        for sku in updates['skuList']:
            if not isinstance(sku, dict):
                continue
            offer_id = sku.get('offerId') or sku.get('skuCode') or sku.get('offer_id')
            if not offer_id:
                continue
            offer_id = str(offer_id)
            # 价格（仅当 sku 中包含 price 字段时构建价格项）
            if sku.get('price') is not None:
                price_data = {'offer_id': offer_id, 'price': {'price': str(sku.get('price', 0))}}
                if sku.get('oldPrice') is not None or sku.get('old_price') is not None:
                    price_data['price']['old_price'] = str(sku.get('oldPrice') or sku.get('old_price') or 0)
                prices_items.append(price_data)
            # 库存（仅当 sku 中包含 stock 字段时构建库存项）
            if sku.get('stock') is not None:
                stocks_items.append({
                    'offer_id': offer_id,
                    'stock': int(sku.get('stock', 0) or 0),
                })
        return prices_items, stocks_items

    # 格式3：整体覆盖（用同一价格/库存覆盖商品的所有 SKU）
    product_skus = product.get('skuList') or product.get('skus') or []
    has_price = updates.get('price') is not None
    has_stock = updates.get('stock') is not None
    if not has_price and not has_stock:
        return [], []

    # 若商品没有 SKU 列表，使用 product.offerId/mergeCode 作为单一 offer_id
    if not product_skus:
        offer_id = product.get('offerId') or product.get('mergeCode') or str(product.get('id', ''))
        if not offer_id:
            return [], []
        if has_price:
            price_data = {'offer_id': str(offer_id), 'price': {'price': str(updates.get('price', 0))}}
            if updates.get('oldPrice') is not None or updates.get('old_price') is not None:
                price_data['price']['old_price'] = str(updates.get('oldPrice') or updates.get('old_price') or 0)
            prices_items.append(price_data)
        if has_stock:
            stocks_items.append({
                'offer_id': str(offer_id),
                'stock': int(updates.get('stock', 0) or 0),
            })
        return prices_items, stocks_items

    # 遍历商品的所有 SKU，用整体值覆盖
    for sku in product_skus:
        if not isinstance(sku, dict):
            continue
        offer_id = sku.get('offerId') or sku.get('skuCode') or sku.get('offer_id') or sku.get('sku')
        if not offer_id:
            continue
        offer_id = str(offer_id)
        if has_price:
            price_data = {'offer_id': offer_id, 'price': {'price': str(updates.get('price', 0))}}
            if updates.get('oldPrice') is not None or updates.get('old_price') is not None:
                price_data['price']['old_price'] = str(updates.get('oldPrice') or updates.get('old_price') or 0)
            prices_items.append(price_data)
        if has_stock:
            stocks_items.append({
                'offer_id': offer_id,
                'stock': int(updates.get('stock', 0) or 0),
            })
    return prices_items, stocks_items


def update_published_product(product_id, updates, store_id=None):
    """独立更新已发布商品的价格/库存（不重新发布商品）

    适用于"已发布商品管理"场景：商品已在 Ozon 上架，仅需调整价格/库存。
    通过 Ozon /v3/products/update-prices 和 /v3/products/update-stocks 接口实现。

    支持的 updates 格式参见 _build_price_stock_items。

    Args:
        product_id: 本地商品 ID
        updates: 更新数据（prices/stocks/skuList/整体字段）
        store_id: 目标店铺 ID（多店铺时透传凭证）。

    Returns:
        dict: {
            'updated': bool,           # 是否成功
            'priceUpdated': int,       # 价格更新 SKU 数
            'stockUpdated': int,       # 库存更新 SKU 数
            'priceResult': dict,       # Ozon 价格 API 返回
            'stockResult': dict,       # Ozon 库存 API 返回
            'errors': list[str],       # 错误列表
        }

    Raises:
        ValueError: 商品不存在/未发布/无可更新数据
        OzonAPIError: Ozon API 调用失败
    """
    product = Product.find_by_id(product_id)
    if not product:
        raise ValueError(f'商品不存在: {product_id}')
    if not store_id:
        raise ValueError('缺少目标店铺，无法更新 Ozon 商品')

    ozon_product_id = product.get('ozonProductId')
    if not ozon_product_id and product.get('status') != 'published':
        raise ValueError('商品尚未发布到 Ozon，无法独立更新。请先使用"一键上架"功能发布商品。')

    if not isinstance(updates, dict) or not updates:
        raise ValueError('更新数据不能为空')

    # 构建 prices_items / stocks_items
    prices_items, stocks_items = _build_price_stock_items(product, updates)
    if not prices_items and not stocks_items:
        raise ValueError('未识别到有效的价格/库存更新数据。支持格式：{prices:[...]}/{{stocks:[...]}}/{skuList:[...]} 或 {price,oldPrice,stock} 整体覆盖')

    # 解析店铺凭证
    from services.ozon_api import _get_store_credentials
    client_id, api_key = _get_store_credentials(store_id)
    if not client_id or not api_key:
        raise ValueError('未配置 Ozon API 凭证，请先在店铺管理中添加 API Key')

    errors = []
    price_result = None
    stock_result = None

    # 调用价格更新接口
    if prices_items:
        try:
            _ozon_rate_limiter.acquire(timeout=60)
            price_result = update_prices(prices_items, client_id=client_id, api_key=api_key)
            print(f'[已发布更新] 商品 {product_id} 价格更新 {len(prices_items)} 个 SKU')
        except OzonAPIError as e:
            errors.append(f'价格更新失败: {e.message}')
            print(f'[已发布更新] 商品 {product_id} 价格更新失败: {e.message}')

    # 调用库存更新接口
    if stocks_items:
        try:
            _ozon_rate_limiter.acquire(timeout=60)
            stock_result = update_stocks(stocks_items, client_id=client_id, api_key=api_key)
            print(f'[已发布更新] 商品 {product_id} 库存更新 {len(stocks_items)} 个 SKU')
        except OzonAPIError as e:
            errors.append(f'库存更新失败: {e.message}')
            print(f'[已发布更新] 商品 {product_id} 库存更新失败: {e.message}')

    # 同步更新本地商品数据
    local_update = {}
    if updates.get('price') is not None and prices_items:
        local_update['price'] = updates['price']
    if updates.get('oldPrice') is not None and prices_items:
        local_update['oldPrice'] = updates['oldPrice']
    if isinstance(updates.get('skuList'), list):
        # 合并 SKU 列表的价格/库存到本地
        local_update['skuList'] = updates['skuList']
    if local_update:
        Product.update(product_id, local_update)

    return {
        'updated': len(errors) == 0,
        'priceUpdated': len(prices_items) if price_result else 0,
        'stockUpdated': len(stocks_items) if stock_result else 0,
        'priceResult': price_result,
        'stockResult': stock_result,
        'errors': errors,
    }
