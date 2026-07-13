"""ERP 平台 SKU 生成服务。"""

import re
from datetime import datetime


_COLOR_KEYS = ('颜色名称', 'название цвета', 'color name', '商品颜色', 'цвет товара', 'color', 'colour', '颜色')


def _clean_part(value, fallback=''):
    text = str(value or '').strip()
    text = re.sub(r'\s+', '-', text)
    text = re.sub(r'[^0-9A-Za-z\u0400-\u04FF\u4e00-\u9fff._-]+', '-', text)
    return text.strip('-_.')[:48] or fallback


def _source_platform(product):
    source = product.get('sourceName') or product.get('platform') or ''
    source = re.sub(r'分销|代理|直供|批发', '', str(source), flags=re.IGNORECASE).strip()
    return _clean_part(source)


def _sku_color(sku):
    combo = sku.get('combo') or sku.get('attributes') or {}
    if not isinstance(combo, dict):
        return ''
    for expected in _COLOR_KEYS:
        for key, value in combo.items():
            if expected in str(key).strip().lower() and str(value or '').strip():
                return _clean_part(value)
    return ''


def ensure_platform_sku_codes(product, now=None):
    """为 ERP SKU 行补齐唯一平台 SKU，已有唯一值不覆盖。

    生成规则与 ERP 编辑页一致：来源平台-MMDDHHMM-颜色。
    """
    skus = product.get('skus') or product.get('skuList') or product.get('variants') or []
    if not isinstance(skus, list):
        return []

    timestamp = (now or datetime.now()).strftime('%m%d%H%M')
    platform = _source_platform(product)
    used = set()
    for index, sku in enumerate(skus, start=1):
        if not isinstance(sku, dict):
            continue
        source_sku = str(sku.get('sourceSku') or sku.get('source_sku') or sku.get('sku') or '').strip()
        if source_sku:
            sku['sourceSku'] = source_sku
        existing = str(sku.get('skuCode') or sku.get('offerId') or sku.get('offer_id') or '').strip()
        if existing and existing not in used:
            platform_sku = existing
        else:
            color = _sku_color(sku)
            parts = [part for part in (platform, timestamp, color) if part]
            base = '-'.join(parts) or f'SKU-{timestamp}'
            platform_sku = base
            suffix = index
            while platform_sku in used:
                suffix += 1
                platform_sku = f'{base}-{suffix}'

        used.add(platform_sku)
        sku['skuCode'] = platform_sku
        sku['offerId'] = platform_sku
        sku['sku'] = platform_sku

    product['skus'] = skus
    return skus
