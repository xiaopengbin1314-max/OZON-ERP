"""
商品相关 API 路由
提供商品的增删改查、搜索、批量操作、统计等接口
"""
import json
import html
import re
from flask import Blueprint, request
from models.product import Product
from utils.response import success_response, error_response, paginate_response, handle_errors
from utils.validators import extract_pagination
from services.platform_sku_service import ensure_platform_sku_codes

product_bp = Blueprint('products', __name__)

# 商品可更新字段白名单（保护 id/createdAt 等不可变字段，防止写入任意字段）
ALLOWED_UPDATE_FIELDS = {
    # 基础信息
    'title', 'price', 'priceRange', 'oldPrice', 'description',
    'brand', 'barcode', 'currencyCode', 'currency', 'vatRate', 'mergeCode', 'offerId',
    'model_id', 'modelId', 'publishMode', 'publish_mode',
    # 状态
    'status', 'publishStatus', 'publishTaskId', 'ozonProductId', 'aiDescription',
    # 来源
    'originalUrl', 'platform', 'productId', 'sourceId', 'sourceName', 'sourceLink',
    'sourcePrice', 'seller', 'sourceLinks',
    # 类目
    'category', 'categoryPath', 'categoryName', 'categoryId', 'sourceCategoryId',
    'descriptionCategoryId', 'typeId', 'categoryMatch',
    # 图片
    'images', 'detailImages', 'videos', 'coverVideoUrl', 'videoList',
    # SKU
    'skuList', 'skuAttrs', 'skus', 'variants', 'attributes', 'barcodes',
    # 重量尺寸
    'weight', 'weightValue', 'weightUnit', 'dimensions', 'width', 'height', 'length',
    # 包裹与积分
    'packageMode', 'pointsForReviews',
    # 采集箱管理
    'group', 'store', 'storeId', 'assignee', 'note', 'claimedAt',
    # 富内容
    'richContent', 'contentType', 'contentEvidence', 'scannerVersion',
    'variantDetailCoverage',
    # 清洗标记（持久化，避免前端重复清洗覆盖用户编辑）
    '_cleaned',
}

# 批量更新允许的字段（更严格，仅允许状态和分组类字段）
ALLOWED_BATCH_UPDATE_FIELDS = {
    'status', 'group', 'store', 'storeId', 'assignee', 'note',
}


def _is_empty_value(value):
    return value is None or value == '' or value == [] or value == {}


def _strip_description_heading(value):
    """Remove Ozon's rendered description heading without touching body text."""
    if value is None:
        return ''
    text = html.unescape(str(value)).replace('\r\n', '\n').replace('\r', '\n').strip()
    return re.sub(
        r'^Описание(?:\s*[:：\-–—]\s*|\s+)(?=\S)',
        '',
        text,
        count=1,
        flags=re.IGNORECASE,
    ).strip()


def _should_accept_category_match(match_result, platform):
    """Reject weak keyword guesses for Ozon's untranslated category names."""
    if not isinstance(match_result, dict) or not match_result.get('matched'):
        return False
    confidence = str(match_result.get('confidence') or 'low').lower()
    if confidence == 'high':
        return True
    source = str(match_result.get('_source') or 'keyword').lower()
    return confidence == 'medium' and not (
        str(platform or '').lower() == 'ozon' and source == 'keyword'
    )


def _normalize_source_category(product_data):
    """Canonicalize category signals emitted by different 1688 page versions."""
    platform = str(product_data.get('platform') or '').strip().lower()
    if platform in {'alibaba', 'alibaba1688', '1688.com'}:
        platform = '1688'
        product_data['platform'] = platform

    raw_path = (
        product_data.get('categoryPath')
        or product_data.get('category_path')
        or product_data.get('categoryName')
        or product_data.get('category')
        or ''
    )
    if isinstance(raw_path, (list, tuple)):
        segments = [str(value).strip() for value in raw_path if str(value).strip()]
    else:
        import re
        segments = [part.strip() for part in re.split(r'[>/、|]+', str(raw_path)) if part.strip()]

    if segments:
        product_data['categoryPath'] = ' / '.join(segments)
        product_data['category'] = segments[-1]
    if platform == '1688':
        source_id = product_data.get('sourceCategoryId') or product_data.get('categoryId')
        if source_id not in (None, ''):
            product_data['sourceCategoryId'] = str(source_id).strip()

    return product_data.get('categoryPath') or product_data.get('category') or ''


def _extract_ozon_product_type_signal(product_data):
    """Return Ozon's own product type characteristic as a strong L3 signal."""
    if str(product_data.get('platform') or '').strip().lower() != 'ozon':
        return ''
    for attr in product_data.get('attributes') or []:
        if not isinstance(attr, dict):
            continue
        attr_id = str(attr.get('id') or attr.get('attrId') or attr.get('attribute_id') or '')
        name = re.sub(r'\s+', ' ', str(attr.get('name') or '')).strip().lower()
        if attr_id == '8229' or name in {'тип', '类型', 'product type'}:
            value = attr.get('sourceValue') or attr.get('value') or ''
            return re.sub(r'\s+', ' ', str(value)).strip()
    return ''


OZON_VIDEO_ATTRIBUTE_IDS = {
    '21845': 'cover',
    '21841': 'description',
}
OZON_UNUSED_VIDEO_ATTRIBUTE_IDS = {'21837', '22273'}


def _normalize_product_video_fields(product_data):
    """Classify Ozon video attributes into ERP's dedicated video fields."""
    attrs = product_data.get('attributes') if isinstance(product_data.get('attributes'), list) else []
    values_by_kind = {}

    def text_values(attr):
        values = []
        nested = attr.get('values') if isinstance(attr.get('values'), list) else []
        for item in nested:
            if isinstance(item, dict):
                value = item.get('value') or item.get('url') or item.get('src')
            else:
                value = item
            if value is not None and str(value).strip():
                values.append(str(value).strip())
        scalar = attr.get('sourceValue') or attr.get('value')
        if scalar is not None and str(scalar).strip():
            values.extend(part.strip() for part in re.split(r'[\r\n;；]+', str(scalar)) if part.strip())
        return list(dict.fromkeys(values))

    for attr in attrs:
        if not isinstance(attr, dict):
            continue
        attr_id = str(attr.get('id') or attr.get('attrId') or attr.get('attribute_id') or '')
        kind = OZON_VIDEO_ATTRIBUTE_IDS.get(attr_id)
        if kind:
            values_by_kind[kind] = text_values(attr)

    # Seller Center exposes only video cover and video upload. Do not publish
    # auxiliary video metadata returned by the category schema.
    product_data['attributes'] = [
        attr for attr in attrs
        if str(attr.get('id') or attr.get('attrId') or attr.get('attribute_id') or '')
        not in OZON_UNUSED_VIDEO_ATTRIBUTE_IDS
    ]

    def video_url(value):
        if isinstance(value, dict):
            value = value.get('url') or value.get('src') or value.get('video_url') or value.get('videoUrl')
        text = str(value or '').strip()
        return text if text.startswith(('http://', 'https://', '/api/')) else ''

    has_dedicated_fields = 'coverVideoUrl' in product_data or 'videoList' in product_data
    existing_videos = [video_url(value) for value in (product_data.get('videos') or [])]
    existing_videos = list(dict.fromkeys(value for value in existing_videos if value))
    explicit_cover = next(iter(values_by_kind.get('cover') or []), '')
    cover = str(product_data.get('coverVideoUrl') or explicit_cover or '').strip()
    explicit_description = [video_url(value) for value in values_by_kind.get('description', [])]
    explicit_description = [value for value in explicit_description if value]

    if has_dedicated_fields:
        description_videos = [video_url(value) for value in (product_data.get('videoList') or [])]
    elif values_by_kind.get('cover') is not None or values_by_kind.get('description') is not None:
        description_videos = explicit_description + [value for value in existing_videos if value != cover]
    else:
        # Backward compatibility: old ERP data stored cover first in videos[].
        cover = cover or (existing_videos[0] if existing_videos else '')
        description_videos = product_data.get('videoList') or existing_videos[1:]
        description_videos = [video_url(value) for value in description_videos]

    description_videos = list(dict.fromkeys(
        value for value in description_videos if value and value != cover
    ))[:5]
    product_data['coverVideoUrl'] = cover
    product_data['videoList'] = description_videos
    product_data['videos'] = list(dict.fromkeys(([cover] if cover else []) + description_videos))
    product_data['attributes'] = [
        attr for attr in product_data['attributes']
        if str(attr.get('id') or attr.get('attrId') or attr.get('attribute_id') or '')
        not in set(OZON_VIDEO_ATTRIBUTE_IDS) | OZON_UNUSED_VIDEO_ATTRIBUTE_IDS
    ]
    if cover:
        product_data['attributes'].append({
            'id': 21845,
            'name': '视频封面',
            'values': [{'value': cover}],
        })
    if description_videos:
        product_data['attributes'].append({
            'id': 21841,
            'name': '产品描述视频',
            'values': [{'value': value} for value in description_videos],
        })
    return product_data


def _match_category_with_product_signals(product_data, source_category):
    """Match Ozon's exact product type first, then use the collected category."""
    from services.ozon_api import match_category

    platform = product_data.get('platform', 'ozon')
    title = product_data.get('title', '')
    description = product_data.get('description', '')
    type_signal = _extract_ozon_product_type_signal(product_data)
    if type_signal:
        type_result = match_category(
            type_signal, platform, title=title, description=description,
        )
        if _should_accept_category_match(type_result, platform):
            type_result = dict(type_result)
            type_result['_matchSignal'] = 'ozon_product_type'
            type_result['_matchSignalValue'] = type_signal
            return type_result

    result = match_category(
        source_category, platform, title=title, description=description,
    )
    if isinstance(result, dict):
        result = dict(result)
        result.setdefault('_matchSignal', 'source_category')
        result.setdefault('_matchSignalValue', source_category)
    return result


def _clean_marketplace_product(product_data):
    """Normalize extension payloads before ERP persistence and form backfill."""
    platform = str(product_data.get('platform') or '').strip().lower()
    if platform not in {'1688', 'alibaba', 'alibaba1688', 'taobao', 'tmall', 'pdd', 'jd', 'aliexpress', 'amazon', 'wb'}:
        return product_data

    def clean_text(value):
        if value is None:
            return ''
        return re.sub(r'\s+', ' ', html.unescape(str(value))).strip()

    def number(value, integer=False):
        match = re.search(r'-?\d+(?:[.,]\d+)?', str(value or '').replace(' ', ''))
        if not match:
            return 0
        parsed = float(match.group(0).replace(',', '.'))
        return int(parsed) if integer else parsed

    product_data['title'] = clean_text(product_data.get('title') or product_data.get('name'))
    product_data['description'] = clean_text(re.sub(r'<[^>]+>', ' ', str(product_data.get('description') or '')))
    product_data['currency'] = clean_text(product_data.get('currency') or 'CNY').upper()
    product_data['currencyCode'] = product_data['currency']

    images = product_data.get('images') or []
    if isinstance(images, str):
        images = [part.strip() for part in re.split(r'[\r\n,]+', images) if part.strip()]
    product_data['images'] = list(dict.fromkeys(
        str(url).strip() for url in images if str(url).strip().startswith(('http://', 'https://'))
    ))
    if not product_data['images'] and product_data.get('mainImage'):
        main_image = str(product_data['mainImage']).strip()
        if main_image.startswith(('http://', 'https://')):
            product_data['images'] = [main_image]

    attributes = product_data.get('attributes') or []
    if isinstance(attributes, dict):
        attributes = [{'name': key, 'value': value} for key, value in attributes.items()]
    clean_attrs = []
    for attr in attributes if isinstance(attributes, list) else []:
        if not isinstance(attr, dict):
            continue
        value = attr.get('value')
        if value is None or clean_text(value) == '':
            continue
        item = dict(attr)
        if item.get('name') is not None:
            item['name'] = clean_text(item['name'])
        item['value'] = clean_text(value)
        clean_attrs.append(item)
    product_data['attributes'] = clean_attrs

    raw_skus = product_data.get('skus') or product_data.get('skuList') or product_data.get('variants') or []
    clean_skus = []
    for index, raw in enumerate(raw_skus if isinstance(raw_skus, list) else []):
        if not isinstance(raw, dict):
            raw = {'title': clean_text(raw)}
        sku = dict(raw)
        source_price = number(sku.get('sourcePrice') or sku.get('price'))
        sku_code = clean_text(sku.get('skuCode') or sku.get('offerId') or sku.get('offer_id') or sku.get('sku'))
        sku['skuCode'] = sku_code
        sku['offerId'] = clean_text(sku.get('offerId') or sku.get('offer_id') or sku_code)
        sku['sourcePrice'] = source_price
        sku['price'] = number(sku.get('price'))
        sku['stock'] = max(0, number(sku.get('stock'), integer=True))
        sku['title'] = clean_text(sku.get('title') or sku.get('name'))
        sku['combo'] = sku.get('combo') if isinstance(sku.get('combo'), dict) else {}
        sku_images = sku.get('images') or []
        if isinstance(sku_images, str):
            sku_images = [sku_images]
        sku['images'] = list(dict.fromkeys(str(url).strip() for url in sku_images if str(url).strip().startswith(('http://', 'https://'))))
        clean_skus.append(sku)
    product_data['skus'] = clean_skus
    ensure_platform_sku_codes(product_data)
    clean_skus = product_data['skus']
    product_data['skuList'] = json.loads(json.dumps(clean_skus, ensure_ascii=False))
    product_data['variants'] = json.loads(json.dumps(clean_skus, ensure_ascii=False))

    prices = [sku['sourcePrice'] for sku in clean_skus if sku.get('sourcePrice', 0) > 0]
    source_price = min(prices) if prices else number(product_data.get('sourcePrice') or product_data.get('price'))
    product_data['sourcePrice'] = source_price
    product_data['price'] = number(product_data.get('price'))
    product_data['sourceId'] = clean_text(product_data.get('sourceId') or product_data.get('productId') or product_data.get('sku'))
    product_data['sourceName'] = clean_text(product_data.get('sourceName') or ('1688分销' if platform in {'1688', 'alibaba', 'alibaba1688'} else platform))
    product_data['_cleaned'] = False
    return product_data


def _normalize_publish_fields_for_persistence(product_data):
    """Persist the same canonical SKU/color data later used by Ozon assembly."""
    _normalize_product_video_fields(product_data)
    ensure_platform_sku_codes(product_data)
    try:
        from services.publish_service import (
            normalize_collected_color_skus,
            clean_legacy_flattened_sku_aspects,
            promote_collected_sku_combos,
            promote_product_color_to_skus,
        )
        clean_legacy_flattened_sku_aspects(product_data)
        promote_collected_sku_combos(product_data)
        promote_product_color_to_skus(product_data)
        normalize_collected_color_skus(product_data)
    except Exception as color_error:
        print(f'[采集] 颜色字段规范化失败（保留原始数据）: {color_error}')

    skus = product_data.get('skus')
    if isinstance(skus, list) and skus:
        product_data['skuList'] = json.loads(json.dumps(skus, ensure_ascii=False))
        product_data['variants'] = json.loads(json.dumps(skus, ensure_ascii=False))
    return product_data


def _item_key(item, fields):
    if isinstance(item, dict):
        for field in fields:
            value = item.get(field)
            if value is not None and str(value).strip() != '':
                return f'{field}:{str(value).strip().lower()}'
        return ''
    if item is not None and str(item).strip() != '':
        return f'value:{str(item).strip().lower()}'
    return ''


def _merge_dict_keep_existing(existing, incoming, replace=False):
    if not isinstance(existing, dict):
        return incoming
    if not isinstance(incoming, dict):
        return existing
    if replace:
        merged = dict(existing)
        for key, value in incoming.items():
            if not _is_empty_value(value):
                merged[key] = value
        return merged
    merged = dict(existing)
    for key, value in incoming.items():
        if _is_empty_value(merged.get(key)) and not _is_empty_value(value):
            merged[key] = value
    return merged


def _merge_unique_list(existing, incoming, key_fields=None, replace=False):
    if not isinstance(existing, list):
        existing = [] if _is_empty_value(existing) else [existing]
    if not isinstance(incoming, list):
        incoming = [] if _is_empty_value(incoming) else [incoming]
    if replace and incoming:
        return incoming

    merged = list(existing)
    key_fields = key_fields or []
    index = {}
    for idx, item in enumerate(merged):
        key = _item_key(item, key_fields)
        if key:
            index[key] = idx

    for item in incoming:
        if _is_empty_value(item):
            continue
        key = _item_key(item, key_fields)
        if key and key in index:
            idx = index[key]
            if isinstance(merged[idx], dict) and isinstance(item, dict):
                merged[idx] = _merge_dict_keep_existing(merged[idx], item)
            continue
        if item not in merged:
            if key:
                index[key] = len(merged)
            merged.append(item)
    return merged


def _merge_sku_attrs(existing, incoming, replace=False):
    merged = _merge_unique_list(existing, incoming, ['attrId', 'id', 'name'], replace=replace)
    for attr in merged:
        if not isinstance(attr, dict):
            continue
        values = attr.get('values')
        value_ids = attr.get('valueIds') or attr.get('value_ids')
        if isinstance(values, list):
            attr['values'] = _merge_unique_list([], values)
        if isinstance(value_ids, list):
            attr['valueIds'] = _merge_unique_list([], value_ids)
    return merged


def _merge_product_field(key, existing_value, incoming_value, force_replace=False):
    if _is_empty_value(incoming_value):
        return existing_value
    if force_replace:
        return incoming_value
    if _is_empty_value(existing_value):
        return incoming_value
    if key in {'images', 'detailImages', 'videos', 'videoList'}:
        return _merge_unique_list(existing_value, incoming_value)
    if key == 'sourceLinks':
        return _merge_unique_list(existing_value, incoming_value, ['url', 'remark'])
    if key == 'attributes':
        return _merge_unique_list(existing_value, incoming_value, ['id', 'attrId', 'attribute_id', 'name'])
    if key == 'skuAttrs':
        return _merge_sku_attrs(existing_value, incoming_value)
    if key in {'skus', 'variants', 'skuList', 'rows'}:
        return _merge_unique_list(existing_value, incoming_value, ['offerId', 'offer_id', 'skuCode', 'sku', 'id', 'title'])
    if isinstance(existing_value, dict) and isinstance(incoming_value, dict):
        return _merge_dict_keep_existing(existing_value, incoming_value)
    if isinstance(existing_value, list) or isinstance(incoming_value, list):
        return _merge_unique_list(existing_value, incoming_value)
    return existing_value


def _merge_scanner_skus(existing_value, incoming_value):
    """Refresh source data by sourceSku while retaining ERP-managed fields."""
    existing = existing_value if isinstance(existing_value, list) else []
    incoming = incoming_value if isinstance(incoming_value, list) else []
    def source_identity(item):
        if not isinstance(item, dict):
            return ''
        return str(
            item.get('sourceSku') or item.get('source_sku') or
            item.get('sourceId') or item.get('sku') or item.get('id') or ''
        ).strip()

    by_source = {
        source_identity(item): item
        for item in existing if source_identity(item)
    }
    managed_fields = {
        'skuCode', 'offerId', 'offer_id', 'price', 'oldPrice', 'stock',
        'weight', 'length', 'width', 'height', 'barcode', 'custom_barcode',
    }
    refreshed = []
    for raw in incoming:
        if not isinstance(raw, dict):
            continue
        item = dict(raw)
        source_sku = source_identity(item)
        if source_sku:
            item['sourceSku'] = source_sku
        saved = by_source.get(source_sku)
        if saved:
            for field in managed_fields:
                if not _is_empty_value(saved.get(field)):
                    item[field] = saved[field]
        refreshed.append(item)
    return refreshed


def _is_rich_content_attr(attr):
    if not isinstance(attr, dict):
        return False
    attr_id = attr.get('id') or attr.get('attrId') or attr.get('attribute_id')
    if str(attr_id or '') == '11254':
        return True
    name = str(attr.get('name') or '').lower()
    compact_name = name.replace(' ', '').replace('-', '').replace('_', '')
    if (
        'richcontent' in compact_name
        or ('json' in name and 'rich' in name)
        or ('json' in name and '\u5bcc\u5185\u5bb9' in name)
        or ('json' in name and '\u043a\u043e\u043d\u0442\u0435\u043d\u0442' in name)
    ):
        return True
    return any(token in name for token in ('json富内容', 'rich-контент', 'rich content', 'rich-content'))


def _sanitize_rich_content(value):
    """Remove Ozon UI section labels that are not product content."""
    if not isinstance(value, dict) or not isinstance(value.get('content'), list):
        return value
    try:
        cleaned = json.loads(json.dumps(value, ensure_ascii=False))
    except (TypeError, ValueError):
        return value

    def clean_format(fmt):
        if not isinstance(fmt, dict):
            return None
        items = fmt.get('items')
        if isinstance(items, list):
            fmt['items'] = [
                item for item in items
                if not (
                    isinstance(item, dict)
                    and str(item.get('content') or '').strip().lower() == 'описание'
                )
            ]
        content = fmt.get('content')
        if isinstance(content, list):
            fmt['content'] = [
                item for item in content
                if str(item or '').strip().lower() != 'описание'
            ]
        has_items = isinstance(fmt.get('items'), list) and any(
            isinstance(item, dict)
            and (item.get('type') == 'br' or str(item.get('content') or '').strip())
            for item in fmt['items']
        )
        has_content = isinstance(fmt.get('content'), list) and any(
            str(item or '').strip() for item in fmt['content']
        )
        return fmt if has_items or has_content else None

    widgets = []
    for widget in cleaned['content']:
        if not isinstance(widget, dict):
            continue
        for key in ('title', 'text'):
            formatted = clean_format(widget.get(key))
            if formatted:
                widget[key] = formatted
            else:
                widget.pop(key, None)
        if isinstance(widget.get('blocks'), list):
            for block in widget['blocks']:
                if not isinstance(block, dict):
                    continue
                for key in ('title', 'text'):
                    formatted = clean_format(block.get(key))
                    if formatted:
                        block[key] = formatted
                    else:
                        block.pop(key, None)
        if widget.get('widgetName') != 'raTextBlock' or widget.get('title') or widget.get('text'):
            widgets.append(widget)
    cleaned['content'] = widgets
    return cleaned


def _rich_content_to_json(value):
    if _is_empty_value(value):
        return ''
    if isinstance(value, str):
        raw = value.strip()
        if not raw or raw == '[object Object]':
            return ''
        try:
            parsed = json.loads(raw)
        except (TypeError, ValueError):
            return ''
        # Some extension builds serialized the JSON twice.
        if isinstance(parsed, str):
            return _rich_content_to_json(parsed)
        return _rich_content_to_json(parsed)
    if isinstance(value, dict):
        # Accept common wrappers returned by Ozon widgets and older extension builds.
        if not isinstance(value.get('content'), list):
            for key in ('richContent', 'rich_content', 'rich-content', 'value', 'json'):
                if key in value:
                    normalized = _rich_content_to_json(value.get(key))
                    if normalized:
                        return normalized
            return ''
        if not value.get('content'):
            return ''
        value = _sanitize_rich_content(value)
        if not value.get('content'):
            return ''
        value.setdefault('version', 0.3)
    try:
        return json.dumps(value, ensure_ascii=False, separators=(',', ':'))
    except (TypeError, ValueError):
        return ''


def _sync_rich_content_attribute(product_data):
    """Keep product.richContent and attributes[11254] in sync for ERP edit backfill."""
    if 'rich_content' in product_data and 'richContent' not in product_data:
        product_data['richContent'] = product_data.pop('rich_content')

    attrs = product_data.get('attributes')
    rich_attr_value = ''
    if isinstance(attrs, list):
        for attr in attrs:
            if _is_rich_content_attr(attr):
                rich_attr_value = _rich_content_to_json(attr.get('value'))
                if not rich_attr_value and isinstance(attr.get('values'), list):
                    for item in attr['values']:
                        if isinstance(item, dict):
                            rich_attr_value = _rich_content_to_json(item.get('value'))
                            if rich_attr_value:
                                break
                if rich_attr_value:
                    break

    rich_json = _rich_content_to_json(product_data.get('richContent')) or rich_attr_value
    if not rich_json:
        if 'richContent' in product_data or rich_attr_value:
            product_data['richContent'] = ''
        return

    product_data['richContent'] = rich_json
    if not isinstance(attrs, list):
        attrs = []
    attrs = [attr for attr in attrs if not _is_rich_content_attr(attr)]
    attrs.append({
        'id': 11254,
        'name': 'JSON富内容（Rich-контент JSON）',
        'value': rich_json,
    })
    product_data['attributes'] = attrs


def _classify_ozon_content(product_data):
    """Classify mutually exclusive Ozon description modes from validated data."""
    if str(product_data.get('platform') or '').lower() != 'ozon':
        return ''
    product_data['description'] = _strip_description_heading(product_data.get('description'))
    evidence = product_data.get('contentEvidence') if isinstance(product_data.get('contentEvidence'), dict) else {}
    evidence_mode = str(evidence.get('mode') or '').strip().lower()
    if evidence_mode == 'plain_description':
        product_data['richContent'] = ''
        attrs = product_data.get('attributes')
        if isinstance(attrs, list):
            product_data['attributes'] = [attr for attr in attrs if not _is_rich_content_attr(attr)]
        mode = 'plain_description' if str(product_data.get('description') or '').strip() else 'none'
        product_data['contentType'] = mode
        return mode
    rich_json = _rich_content_to_json(product_data.get('richContent'))
    if rich_json and evidence_mode != 'none':
        product_data['richContent'] = rich_json
        product_data['contentType'] = 'rich_content'
        product_data['description'] = ''
        return 'rich_content'

    product_data['richContent'] = ''
    attrs = product_data.get('attributes')
    if isinstance(attrs, list):
        product_data['attributes'] = [attr for attr in attrs if not _is_rich_content_attr(attr)]
    mode = 'plain_description' if str(product_data.get('description') or '').strip() else 'none'
    product_data['contentType'] = mode
    return mode


def _merge_attributes_with_rich_content(existing_attrs, incoming_attrs, force_replace=False):
    if force_replace:
        return incoming_attrs

    merged = _merge_unique_list(existing_attrs, incoming_attrs, ['id', 'attrId', 'attribute_id', 'name'])
    incoming_rich = None
    if isinstance(incoming_attrs, list):
        for attr in incoming_attrs:
            if _is_rich_content_attr(attr) and not _is_empty_value(attr.get('value') if isinstance(attr, dict) else None):
                incoming_rich = attr
                break

    if not incoming_rich:
        return merged

    replaced = False
    next_attrs = []
    for attr in merged if isinstance(merged, list) else []:
        if _is_rich_content_attr(attr):
            if not replaced:
                next_attrs.append(incoming_rich)
                replaced = True
            continue
        next_attrs.append(attr)
    if not replaced:
        next_attrs.append(incoming_rich)
    return next_attrs


@product_bp.route('/products', methods=['GET'])
@handle_errors
def get_products():
    """获取商品列表（支持分页、状态筛选、关键词搜索）"""
    pagination = extract_pagination(request.args)
    status = request.args.get('status', '')
    keyword = request.args.get('keyword', '')
    group = request.args.get('group', '')

    all_products = Product.find_all()

    # 筛选
    filtered = all_products
    if status:
        filtered = [p for p in filtered if p.get('status') == status]
    if group:
        filtered = [p for p in filtered if p.get('group') == group]
    if keyword:
        kw = keyword.lower()
        filtered = [p for p in filtered if
                     kw in (p.get('title', '') or '').lower()
                     or kw in (p.get('sourceId', '') or '').lower()
                     or kw in (p.get('sourceName', '') or '').lower()
                     or kw in (p.get('assignee', '') or '').lower()
                     or kw in (p.get('category', '') or '').lower()
                     or kw in (p.get('note', '') or '').lower()]

    # 按创建时间倒序
    filtered.sort(key=lambda x: x.get('createdAt', ''), reverse=True)

    total = len(filtered)
    start = (pagination['page'] - 1) * pagination['pageSize']
    end = start + pagination['pageSize']
    page_items = filtered[start:end]

    return paginate_response(page_items, total, **pagination)


@product_bp.route('/products/stats', methods=['GET'])
@handle_errors
def get_product_stats():
    """获取商品各状态统计"""
    stats = Product.get_status_stats()
    total = sum(stats.values())
    return success_response(data={
        "stats": stats,
        "total": total,
    })


@product_bp.route('/products/collect', methods=['POST'])
@handle_errors
def collect_product():
    """新增商品采集 - 接收浏览器扩展采集的完整商品数据

    已发布回查：如果同 URL/SKU 的商品已存在，返回已有商品（含发布状态），
    而不是创建新记录。前端可据此提示用户"该商品已发布过"。
    """
    data = request.get_json()

    if not data:
        return error_response("请求体不能为空")

    # Marketplace data must be normalized before validation and persistence.
    # Different page versions return prices, attributes and SKU rows in
    # incompatible shapes; storing those raw values breaks ERP backfill.
    product_data = _clean_marketplace_product(dict(data))

    # 基本校验：标题必填
    title = product_data.get('title', '')
    if not title:
        return error_response("商品标题不能为空")

    source_category = _normalize_source_category(product_data)
    _sync_rich_content_attribute(product_data)
    incoming_content_type = _classify_ozon_content(product_data)
    has_ozon_rich_content = incoming_content_type == 'rich_content'

    # ===== 采集全过程日志 =====
    print(f'\n{"="*60}')
    print(f'[采集] ===== 开始采集商品 =====')
    print(f'[采集] 标题: {title[:80]!r}')
    print(f'[采集] 平台: {product_data.get("platform", "unknown")}')
    raw_url = product_data.get('originalUrl') or product_data.get('sourceUrl') or product_data.get('url') or ''
    print(f'[采集] 来源URL: {raw_url[:100]}')
    print(f'[采集] 主SKU: {product_data.get("sku", "")}')
    print(f'[采集] SKU列表数: {len(product_data.get("skuList") or [])}')
    print(f'[采集] 图片数: {len(product_data.get("images") or [])}')
    print(f'[采集] 详情图数: {len(product_data.get("detailImages") or [])}')
    print(f'[采集] 源类目: {(product_data.get("category") or "")[:80]!r}')
    print(f'[采集] descriptionCategoryId: {product_data.get("descriptionCategoryId", "")}')
    print(f'[采集] typeId: {product_data.get("typeId", "")}')

    # 字段名映射：扩展 ScannerBase 用 sourceUrl，前端手动添加用 url，后端统一用 originalUrl
    if 'originalUrl' not in product_data:
        if 'sourceUrl' in product_data:
            product_data['originalUrl'] = product_data.pop('sourceUrl', '')
        elif 'url' in product_data:
            product_data['originalUrl'] = product_data.pop('url', '')

    # 货源链接重组：扩展发布弹窗提交 source_url/source_remark（下划线命名），
    # 后端统一用 sourceLinks 数组 + sourceLink/sourceName（驼峰命名）
    # 将用户在弹窗中输入的货源链接重组为 sourceLinks，并同步 sourceLink/sourceName
    ext_source_url = product_data.pop('source_url', '') or ''
    ext_source_remark = product_data.pop('source_remark', '') or ''
    if ext_source_url:
        # 用户在弹窗中输入了货源链接，重组为 sourceLinks
        existing_links = product_data.get('sourceLinks')
        if not isinstance(existing_links, list) or len(existing_links) == 0:
            product_data['sourceLinks'] = [{
                'remark': ext_source_remark or product_data.get('sourceName', '') or '',
                'url': ext_source_url,
            }]
        # 同步 sourceLink/sourceName（向后兼容）
        product_data['sourceLink'] = ext_source_url
        if ext_source_remark:
            product_data['sourceName'] = ext_source_remark
        print(f'[采集] 货源链接重组: 用户输入 url={ext_source_url[:80]}, remark={ext_source_remark}, sourceLinks={len(product_data.get("sourceLinks", []))}条')
    else:
        # 用户未输入货源链接，从 sourceLink/originalUrl 初始化 sourceLinks
        existing_links = product_data.get('sourceLinks')
        fallback_url = product_data.get('sourceLink', '') or product_data.get('originalUrl', '')
        fallback_name = product_data.get('sourceName', '') or ''
        if (not isinstance(existing_links, list) or len(existing_links) == 0) and fallback_url:
            product_data['sourceLinks'] = [{
                'remark': fallback_name or '货源链接',
                'url': fallback_url,
            }]
            print(f'[采集] 货源链接初始化: 从 sourceLink/originalUrl 创建, url={fallback_url[:80]}, name={fallback_name}')

    # 已发布回查：通过 originalUrl 或 sku 查找已有商品
    existing = Product.find_by_original_url(product_data.get('originalUrl', ''))
    if not existing:
        # 尝试通过主商品 SKU 查找（Ozon scanner 设置的 product.sku）
        main_sku = product_data.get('sku', '')
        if main_sku:
            existing = Product.find_by_sku(main_sku)
    if not existing:
        # 尝试通过 skuList 首项查找
        first_sku = ''
        sku_list = product_data.get('skuList') or []
        if sku_list and isinstance(sku_list[0], dict):
            first_sku = sku_list[0].get('sku', '') or sku_list[0].get('skuId', '')
        if first_sku:
            existing = Product.find_by_sku(first_sku)

    if existing:
        # 已有商品：合并新数据到已有商品
        # 策略：保护用户已编辑的字段，仅用新数据填充空字段 + 更新采集特有字段
        print(f'[采集] 已有商品: id={existing.get("id")}, 已发布={bool(existing.get("ozonProductId"))}, 发布状态={existing.get("publishStatus", "")}')
        print(f'[采集] 合并更新已有商品数据...')
        merged = dict(existing)
        is_publish_modal = product_data.get('source') == 'extension-publish-modal'
        is_scanner_refresh = (
            product_data.get('platform') == 'ozon'
            and bool(product_data.get('collectedAt'))
            and not is_publish_modal
        )
        repair_unclean_1688 = (
            product_data.get('platform') == '1688'
            and not bool(existing.get('_cleaned'))
        )

        # 完全保护的系统字段（永不被覆盖）
        preserve_keys = {'id', 'createdAt', 'status', 'publishStatus', 'publishTaskId', 'ozonProductId'}

        # 用户可编辑字段：仅当 existing 中为空时才用新数据填充（不覆盖用户已编辑的内容）
        # 这些字段用户可能在编辑界面手动修改过，重新采集时不应覆盖
        user_edit_fields = {
            'title', 'description', 'images', 'detailImages',
            'weight', 'length', 'width', 'height',
            'price', 'oldPrice', 'sourcePrice',
            'brand', 'mergeCode', 'vatRate', 'barcode', 'partNumber',
            'attributes', 'skuAttrs', 'skus',
            'videos', 'coverVideoUrl',
            'sourceLinks',
        }

        # 采集刷新字段：允许新数据覆盖（这些是采集器的核心数据，刷新时应该更新）
        refresh_fields = {
            'skuList', 'variants', 'category', 'sourceLink', 'sourceName',
            'descriptionCategoryId', 'typeId', 'parentCategoryId',
            'currency', 'currencyCode', 'richContent', 'contentType', 'contentEvidence',
            'scannerVersion', 'variantDetailCoverage',
        }
        merge_list_fields = {
            'images', 'detailImages', 'videos', 'videoList',
            'attributes', 'skuAttrs', 'skus', 'rows', 'sourceLinks',
        }
        publish_modal_replace_fields = {
            'price', 'oldPrice', 'sourcePrice', 'mergeCode',
            'weight', 'length', 'width', 'height', 'barcode',
            'skus', 'rows', 'skuAttrs', 'variants',
        }

        for k, v in product_data.items():
            if k in preserve_keys:
                continue  # 系统字段永不覆盖

            if k in merge_list_fields:
                if k == 'attributes':
                    merged[k] = _merge_attributes_with_rich_content(
                        existing.get(k),
                        v,
                        force_replace=(is_publish_modal and k in publish_modal_replace_fields),
                    )
                elif is_scanner_refresh and k in {'skus', 'variants', 'skuList', 'rows'}:
                    merged[k] = _merge_scanner_skus(existing.get(k), v)
                elif is_scanner_refresh and k == 'skuAttrs':
                    merged[k] = v
                else:
                    merged[k] = _merge_product_field(
                        k,
                        existing.get(k),
                        v,
                        force_replace=(
                            (is_publish_modal and k in publish_modal_replace_fields)
                            or (repair_unclean_1688 and k in {'skuAttrs', 'skus', 'attributes'})
                        ),
                    )
                continue

            if k in refresh_fields:
                # 采集刷新字段：允许覆盖（但新值为空时不覆盖已有值）
                if not _is_empty_value(v):
                    merged[k] = v
                continue

            if k in user_edit_fields:
                if is_publish_modal and k in publish_modal_replace_fields and not _is_empty_value(v):
                    merged[k] = v
                    continue
                if repair_unclean_1688 and not _is_empty_value(v):
                    merged[k] = v
                    continue
                # 用户可编辑字段：仅当 existing 中为空时才填充
                existing_val = existing.get(k)
                is_empty = _is_empty_value(existing_val)
                if is_empty and not _is_empty_value(v):
                    merged[k] = v
                continue

            # 其他字段：默认仅填充空值（保守策略，避免覆盖未知字段）
            existing_val = existing.get(k)
            is_empty = _is_empty_value(existing_val)
            if is_empty and not _is_empty_value(v):
                merged[k] = v

        # Description and Rich Content are mutually exclusive Ozon modes.
        # A fresh plain-description collection must remove stale attribute 11254.
        if incoming_content_type == 'plain_description':
            merged['description'] = product_data.get('description', '')
            merged['richContent'] = ''
            merged['contentType'] = 'plain_description'
            merged['attributes'] = [
                attr for attr in (merged.get('attributes') or [])
                if not _is_rich_content_attr(attr)
            ]
        elif incoming_content_type == 'rich_content':
            merged['description'] = ''
            merged['contentType'] = 'rich_content'

        _normalize_publish_fields_for_persistence(merged)

        # skus 是 ERP 编辑和 Ozon 发布的唯一权威 SKU 集合。采集刷新可能带来
        # 新的 raw variants；若已有已编辑 skus，兼容视图必须跟随 skus，
        # 否则扩展重开弹窗时会看到不同的 SKU 数量。
        canonical_skus = merged.get('skus')
        if isinstance(canonical_skus, list) and canonical_skus:
            merged['variants'] = json.loads(json.dumps(canonical_skus, ensure_ascii=False))
            merged['skuList'] = json.loads(json.dumps(canonical_skus, ensure_ascii=False))

        # categoryMatch 是验证后的规范类目来源，必须同步回顶层字段。
        # 历史数据曾出现顶层 39417、categoryMatch 17027904 的双重状态。
        canonical_category = merged.get('categoryMatch') or {}
        if canonical_category.get('matched'):
            canonical_desc_id = canonical_category.get('description_category_id') or canonical_category.get('descriptionCategoryId')
            canonical_type_id = canonical_category.get('type_id') or canonical_category.get('typeId')
            if canonical_desc_id and canonical_type_id:
                merged['descriptionCategoryId'] = int(canonical_desc_id)
                merged['typeId'] = int(canonical_type_id)

        # 类目已知时就在采集阶段补全属性 ID 并持久化，ERP 编辑页才能
        # 立即回填，而不是等发布线程临时转换后又丢失。
        if merged.get('descriptionCategoryId') and merged.get('typeId'):
            try:
                from services.publish_service import match_attributes_by_name
                match_attributes_by_name(merged, resolve_large_dictionaries=False)
            except Exception as attr_error:
                print(f'[采集] 属性回填匹配失败（保留原始数据）: {attr_error}')

        # Attribute matching can add the canonical 10096/10097 IDs to legacy
        # rows, so run the idempotent persistence normalization once more.
        _normalize_publish_fields_for_persistence(merged)

        merged['updatedAt'] = Product.now_iso()

        # 用户在弹窗中主动输入了货源链接，强制覆盖 sourceLinks（绕过 user_edit_fields 保护）
        if ext_source_url and product_data.get('sourceLinks'):
            merged['sourceLinks'] = product_data['sourceLinks']

        # Remove description text that older extension builds extracted from
        # the Rich Content DOM. The complete text now lives in attribute 11254.
        if has_ozon_rich_content:
            merged['description'] = ''

        # 1688 商品重新采集时重置 _cleaned 标记，让前端再次执行清洗逻辑
        # 避免首次清洗后 _cleaned=true 持久化导致后续重新采集时清洗被跳过，
        # 新采集的原始数据（标题带公司名、图片未去重等）无法被清洗转换
        if product_data.get('platform') == '1688':
            merged['_cleaned'] = False
        Product.update(existing['id'], {k: v for k, v in merged.items() if k not in preserve_keys})
        # 标记为已存在商品（前端可据此提示）
        merged['_isExisting'] = True
        merged['_wasPublished'] = bool(existing.get('ozonProductId') or existing.get('status') == 'published')
        print(f'[采集] 合并完成: id={existing.get("id")}, 已发布过={merged["_wasPublished"]}')
        print(f'[采集] ===== 采集完成（已有商品更新） =====\n')
        return success_response(data=merged, msg="商品已存在（已更新数据）" + ('，该商品已发布过' if merged['_wasPublished'] else ''))

    # 新商品同样在入口统一 SKU 数据源。旧采集器仍可只提交 variants/skuList，
    # 但一旦提交了 skus，后续所有业务都以 skus 为准。
    canonical_skus = product_data.get('skus')
    if isinstance(canonical_skus, list) and canonical_skus:
        product_data['variants'] = json.loads(json.dumps(canonical_skus, ensure_ascii=False))
        product_data['skuList'] = json.loads(json.dumps(canonical_skus, ensure_ascii=False))

    # 确保关键字段存在
    product_data.setdefault('originalUrl', '')
    product_data.setdefault('platform', 'ozon')
    product_data.setdefault('images', [])
    product_data.setdefault('detailImages', [])
    product_data.setdefault('skuList', [])
    product_data.setdefault('skuAttrs', [])
    product_data.setdefault('variants', [])
    product_data.setdefault('skus', [])
    product_data.setdefault('attributes', [])
    product_data.setdefault('category', '')
    product_data.setdefault('brand', '')
    product_data.setdefault('seller', None)

    print(f'[采集] 新商品，开始类目匹配流程...')

    # 自动匹配 Ozon 类目（采集时即完成，包含俄文精确匹配+关键词+AI 多层匹配）
    # 用户需求：类目匹配不要从标题推断，直接从产品类目（source_category）进行判断
    #   - 必须有 source_category 才触发匹配；否则标记为待匹配，由用户在编辑界面手动选择
    #   - 当 descriptionCategoryId 存在但无效（采集器误提取）或 typeId 缺失时，仍触发匹配
    source_category = source_category or product_data.get('category', '')
    # 手动创建的商品跳过类目自动匹配，由用户在编辑界面自行选择类目
    if product_data.get('platform') == 'manual':
        product_data.setdefault('categoryMatch', {
            'matched': False,
            'confidence': 'low',
            'sourceCategory': source_category or '',
            'candidates': [],
            'reason': '手动创建商品，请在编辑页选择类目',
        })
    else:
        # 验证采集器提取的 descriptionCategoryId 是否有效
        raw_desc_id = product_data.get('descriptionCategoryId')
        need_match = True
        if raw_desc_id:
            try:
                from services.ozon_api import validate_category_pair, validate_description_category_id
                v = validate_description_category_id(raw_desc_id)
                if v.get('valid') and product_data.get('typeId'):
                    pair = validate_category_pair(raw_desc_id, product_data.get('typeId'))
                    if pair.get('valid'):
                        need_match = False
                        product_data['descriptionCategoryId'] = pair['description_category_id']
                        product_data['typeId'] = pair['type_id']
                        product_data['categoryMatch'] = {
                            'matched': True,
                            'confidence': 'high',
                            'label': pair.get('label', ''),
                            'sourceCategory': source_category,
                            'description_category_id': pair['description_category_id'],
                            'type_id': pair['type_id'],
                            'reason': '采集器类目 ID 对已通过 Ozon 类目树验证',
                            '_source': 'scanner_pair_verified',
                        }
                    else:
                        product_data['descriptionCategoryId'] = ''
                        product_data['typeId'] = ''
                        print(f'[采集] 扫描器类目 ID 对无效，触发重新匹配: {pair.get("reason", "")})')
                elif v.get('valid') and not product_data.get('typeId'):
                    # descriptionCategoryId 有效但 typeId 缺失 → 用 L3 候选填充 categoryMatch
                    need_match = False
                    product_data['categoryMatch'] = {
                        'matched': False,
                        'confidence': 'medium',
                        'sourceCategory': source_category,
                        'description_category_id': v['description_category_id'],
                        'candidates': v.get('l3_candidates', []),
                        'reason': '已定位到 L2 类目，请选择具体的 L3 类型',
                        '_source': 'validate_l2',
                    }
                    print(f'[采集] descriptionCategoryId={raw_desc_id} 有效但 typeId 缺失，已填充 L3 候选 {len(v.get("l3_candidates", []))} 个')
                else:
                    # descriptionCategoryId 无效（采集器误提取）→ 清除后触发匹配
                    print(f'[采集] descriptionCategoryId={raw_desc_id} 在类目树中无效，已清除并触发匹配')
                    product_data['descriptionCategoryId'] = ''
            except Exception as e:
                import logging
                logging.warning(f'[采集] descriptionCategoryId 验证异常: {e}')

        if need_match and source_category:
            try:
                print(f'[采集] 开始类目匹配: source={source_category[:60]!r}, platform={product_data.get("platform", "ozon")}')
                # 多信号匹配：传入 title + description 作为辅助信号（对齐妙手做法）
                # 当类目精确匹配失败时，AI 层会结合标题+描述做语义匹配
                match_result = _match_category_with_product_signals(product_data, source_category)

                if _should_accept_category_match(match_result, product_data.get('platform')):
                    # 匹配成功：写入类目 ID 和匹配信息
                    product_data['descriptionCategoryId'] = match_result['description_category_id']
                    product_data['typeId'] = match_result['type_id']
                    product_data['categoryMatch'] = {
                        'matched': True,
                        'confidence': match_result.get('confidence', 'medium'),
                        'label': match_result.get('label', ''),
                        'sourceCategory': source_category,
                        'description_category_id': match_result['description_category_id'],
                        'type_id': match_result['type_id'],
                        'reason': match_result.get('reason', ''),
                        '_source': match_result.get('_source', 'keyword'),
                        'matchSignal': match_result.get('_matchSignal', 'source_category'),
                        'matchSignalValue': match_result.get('_matchSignalValue', source_category),
                    }
                    print(f'[采集] 类目匹配成功: {match_result.get("label", "")} (置信度 {match_result.get("confidence", "")}, 来源 {match_result.get("_source", "keyword")})')
                else:
                    # 匹配失败：保存候选列表，供编辑页用户手动选择
                    product_data['categoryMatch'] = {
                        'matched': False,
                        'confidence': match_result.get('confidence', 'low'),
                        'sourceCategory': source_category,
                        'candidates': match_result.get('candidates', []),
                        'reason': match_result.get('reason', ''),
                    }
                    print(f'[采集] 类目匹配未成功: {match_result.get("reason", "无候选")} (候选 {len(match_result.get("candidates", []))} 个)')
            except Exception as e:
                # 匹配失败不影响采集流程，标记为待匹配
                import logging
                logging.warning(f'[采集] 类目自动匹配异常: {e}')
                product_data['categoryMatch'] = {
                    'matched': False,
                    'confidence': 'low',
                    'sourceCategory': source_category,
                    'candidates': [],
                    'reason': f'匹配异常: {e}',
                }
        elif need_match and not source_category:
            # source_category 为空：尝试多信号 AI 匹配（用标题+描述走 AI 兜底）
            # 对齐妙手 ERP 做法：采集器未抓到类目时，用商品标题+描述做语义匹配
            prod_title = product_data.get('title', '') or ''
            prod_desc = product_data.get('description', '') or ''
            if prod_title.strip() or prod_desc.strip():
                try:
                    print(f'[采集] source_category 为空，启用多信号 AI 匹配: title={prod_title[:40]!r}')
                    match_result = match_category(
                        '',
                        product_data.get('platform', 'ozon'),
                        title=prod_title,
                        description=prod_desc,
                    )
                    if _should_accept_category_match(match_result, product_data.get('platform')):
                        product_data['descriptionCategoryId'] = match_result['description_category_id']
                        product_data['typeId'] = match_result['type_id']
                        product_data['categoryMatch'] = {
                            'matched': True,
                            'confidence': match_result.get('confidence', 'medium'),
                            'label': match_result.get('label', ''),
                            'sourceCategory': '',
                            'description_category_id': match_result['description_category_id'],
                            'type_id': match_result['type_id'],
                            'reason': match_result.get('reason', ''),
                            '_source': match_result.get('_source', 'ai_multi_signal'),
                        }
                        print(f'[采集] 多信号 AI 匹配成功: {match_result.get("label", "")}')
                    else:
                        product_data['categoryMatch'] = {
                            'matched': False,
                            'confidence': match_result.get('confidence', 'low'),
                            'sourceCategory': '',
                            'candidates': match_result.get('candidates', []),
                            'reason': match_result.get('reason', '多信号 AI 匹配未成功'),
                        }
                        print(f'[采集] 多信号 AI 匹配未成功: {match_result.get("reason", "")}')
                except Exception as e:
                    import logging
                    logging.warning(f'[采集] 多信号 AI 匹配异常: {e}')
                    product_data.setdefault('categoryMatch', {
                        'matched': False,
                        'confidence': 'low',
                        'sourceCategory': '',
                        'candidates': [],
                        'reason': f'多信号匹配异常: {e}',
                    })
            else:
                # 既无类目也无标题/描述，无法匹配
                product_data.setdefault('categoryMatch', {
                    'matched': False,
                    'confidence': 'low',
                    'sourceCategory': '',
                    'candidates': [],
                    'reason': '缺少产品类目信息',
                })

    if product_data.get('descriptionCategoryId') and product_data.get('typeId'):
        try:
            from services.publish_service import match_attributes_by_name
            match_attributes_by_name(product_data, resolve_large_dictionaries=False)
        except Exception as attr_error:
            print(f'[采集] 属性回填匹配失败（保留原始数据）: {attr_error}')

    _normalize_publish_fields_for_persistence(product_data)
    product = Product.create(product_data)
    print(f'[采集] 商品创建成功: id={product.get("id")}')
    print(f'[采集] 类目匹配结果: {product_data.get("categoryMatch", {}).get("matched", False)}, 类目={product_data.get("categoryMatch", {}).get("label", "")}')
    print(f'[采集] ===== 采集完成（新商品创建） =====\n')
    return success_response(data=product, msg="采集成功" + ('，类目已自动匹配' if product_data.get('categoryMatch', {}).get('matched') else '，类目待匹配'))


@product_bp.route('/products/<product_id>', methods=['GET'])
@handle_errors
def get_product(product_id):
    """获取单个商品详情"""
    product = Product.find_by_id(product_id)
    if not product:
        return error_response("商品不存在", 404)
    # Lazy-migrate recoverable historical Rich Content shapes when the ERP
    # opens an item. This fixes old object/nested-values records without a
    # destructive bulk migration.
    normalized = dict(product)
    before_rich = normalized.get('richContent')
    before_attrs = normalized.get('attributes')
    before_type = normalized.get('contentType')
    before_description = normalized.get('description')
    before_sku_attrs = normalized.get('skuAttrs')
    before_skus = normalized.get('skus')
    _sync_rich_content_attribute(normalized)
    _classify_ozon_content(normalized)
    _normalize_publish_fields_for_persistence(normalized)
    if (
        normalized.get('richContent') != before_rich
        or normalized.get('attributes') != before_attrs
        or normalized.get('contentType') != before_type
        or normalized.get('description') != before_description
        or normalized.get('skuAttrs') != before_sku_attrs
        or normalized.get('skus') != before_skus
    ):
        product = Product.update(product_id, {
            'richContent': normalized.get('richContent', ''),
            'attributes': normalized.get('attributes', []),
            'contentType': normalized.get('contentType', ''),
            'description': normalized.get('description', ''),
            'skuAttrs': normalized.get('skuAttrs', []),
            'skus': normalized.get('skus', []),
            'skuList': normalized.get('skuList', []),
            'variants': normalized.get('variants', []),
        }) or normalized
    return success_response(data=product)


@product_bp.route('/products/<product_id>/prefill-attributes', methods=['POST'])
@handle_errors
def prefill_product_attributes(product_id):
    """预填 Ozon 类目必填属性的默认值

    根据商品的类目，拉取必填属性列表，对常见属性（品牌、年份、型号等）自动填充默认值。
    已有值的属性不会被覆盖。
    """
    product = Product.find_by_id(product_id)
    if not product:
        return error_response("商品不存在", 404)

    if not product.get('descriptionCategoryId') or not product.get('typeId'):
        return error_response("商品未匹配类目，无法预填属性")

    from services.publish_service import prefill_required_attributes
    result = prefill_required_attributes(product)

    # 保存更新后的商品（attributes 字段可能被修改）
    if result.get('prefilled', 0) > 0:
        Product.update(product_id, {'attributes': product.get('attributes', [])})

    return success_response(data=result, msg=f"已预填 {result.get('prefilled', 0)} 个属性，{len(result.get('required_remaining', []))} 个必填属性仍需手动填写")


@product_bp.route('/products/<product_id>', methods=['PUT'])
@handle_errors
def update_product(product_id):
    """更新商品信息"""
    data = request.get_json()
    if not data:
        return error_response("请求体不能为空")

    # 使用白名单过滤，仅允许合法字段更新
    update_data = {k: v for k, v in data.items() if k in ALLOWED_UPDATE_FIELDS}
    if not update_data:
        return error_response("没有可更新的字段")

    existing_product = Product.find_by_id(product_id)
    if not existing_product:
        return error_response("商品不存在", 404)

    # Keep description and attribute 11254 mutually exclusive on every edit.
    # An explicit plain-description mode is allowed to clear historical Rich Content.
    _sync_rich_content_attribute(update_data)
    content_candidate = dict(existing_product)
    content_candidate.update(update_data)
    explicit_plain = update_data.get('contentType') == 'plain_description'
    explicit_empty_rich = 'richContent' in update_data and not _rich_content_to_json(update_data.get('richContent'))
    if explicit_plain or (explicit_empty_rich and str(update_data.get('description') or '').strip()):
        content_candidate['richContent'] = ''
        content_candidate['attributes'] = [
            attr for attr in (content_candidate.get('attributes') or [])
            if not _is_rich_content_attr(attr)
        ]
    _sync_rich_content_attribute(content_candidate)
    _classify_ozon_content(content_candidate)
    for key in ('richContent', 'attributes', 'contentType', 'description'):
        update_data[key] = content_candidate.get(key, '' if key != 'attributes' else [])

    # 类目重新匹配：当 category 字段被更新且用户未同时手动指定 categoryMatch 时触发
    # 场景：商品采集时类目为空导致匹配失败，用户后续补填类目后应自动重新匹配
    # 注意：若用户同时在编辑页手动选择目标类目（提交 categoryMatch 字段），则跳过自动匹配，尊重用户选择
    if 'category' in update_data and 'categoryMatch' not in update_data:
        existing = existing_product
        if existing:
            old_category = existing.get('category', '') or ''
            new_category = update_data.get('category', '') or ''
            old_match = existing.get('categoryMatch', {}) or {}
            # 仅当类目确实变化，或原匹配状态为失败时才重新匹配
            should_rematch = (new_category != old_category) or (not old_match.get('matched'))
            # 手动创建商品不自动匹配
            is_manual = (existing.get('platform') == 'manual') or (update_data.get('platform') == 'manual')
            if should_rematch and not is_manual and new_category.strip():
                try:
                    from services.ozon_api import match_category
                    # 多信号：用更新后的 title/description（如有）+ 新类目一起匹配
                    rem_title = update_data.get('title', existing.get('title', '')) or ''
                    rem_desc = update_data.get('description', existing.get('description', '')) or ''
                    print(f'[更新] 检测到 category 变化({old_category[:30]!r}→{new_category[:30]!r})，重新匹配')
                    category_product = dict(existing)
                    category_product.update(update_data)
                    category_product['title'] = rem_title
                    category_product['description'] = rem_desc
                    match_result = _match_category_with_product_signals(category_product, new_category)
                    if _should_accept_category_match(
                        match_result, update_data.get('platform') or existing.get('platform')
                    ):
                        update_data['descriptionCategoryId'] = match_result['description_category_id']
                        update_data['typeId'] = match_result['type_id']
                        update_data['categoryMatch'] = {
                            'matched': True,
                            'confidence': match_result.get('confidence', 'medium'),
                            'label': match_result.get('label', ''),
                            'sourceCategory': new_category,
                            'description_category_id': match_result['description_category_id'],
                            'type_id': match_result['type_id'],
                            'reason': match_result.get('reason', ''),
                            '_source': match_result.get('_source', 'keyword'),
                            'matchSignal': match_result.get('_matchSignal', 'source_category'),
                            'matchSignalValue': match_result.get('_matchSignalValue', new_category),
                        }
                        print(f'[更新] 重新匹配成功: {match_result.get("label", "")}')
                    else:
                        update_data['categoryMatch'] = {
                            'matched': False,
                            'confidence': match_result.get('confidence', 'low'),
                            'sourceCategory': new_category,
                            'candidates': match_result.get('candidates', []),
                            'reason': match_result.get('reason', ''),
                        }
                        print(f'[更新] 重新匹配未成功: {match_result.get("reason", "")}')
                except Exception as e:
                    import logging
                    logging.warning(f'[更新] 类目重新匹配异常: {e}')
            elif should_rematch and not new_category.strip():
                # 新类目为空，标记为待匹配
                update_data['categoryMatch'] = {
                    'matched': False,
                    'confidence': 'low',
                    'sourceCategory': '',
                    'candidates': [],
                    'reason': '缺少产品类目信息',
                }

    updated = Product.update(product_id, update_data)
    if not updated:
        return error_response("商品不存在", 404)

    return success_response(data=updated, msg="更新成功")


@product_bp.route('/products/<product_id>', methods=['DELETE'])
@handle_errors
def delete_product(product_id):
    """删除商品"""
    success = Product.delete(product_id)
    if not success:
        return error_response("商品不存在", 404)

    return success_response(msg="删除成功")


@product_bp.route('/products/batch/delete', methods=['POST'])
@handle_errors
def batch_delete_products():
    """批量删除商品"""
    data = request.get_json()
    if not data:
        return error_response("请求体不能为空")

    ids = data.get('ids', [])
    if not ids:
        return error_response("请选择要删除的商品")

    deleted = 0
    for pid in ids:
        if Product.delete(pid):
            deleted += 1

    return success_response(data={"deleted": deleted}, msg=f"已删除 {deleted} 个商品")


@product_bp.route('/products/batch/update', methods=['POST'])
@handle_errors
def batch_update_products():
    """批量更新商品字段（如分组、状态等）"""
    data = request.get_json()
    if not data:
        return error_response("请求体不能为空")

    ids = data.get('ids', [])
    updates = data.get('updates', {})

    if not ids:
        return error_response("请选择要更新的商品")
    if not updates:
        return error_response("无更新内容")

    # 批量更新使用更严格的白名单（仅允许状态和分组类字段）
    filtered_updates = {k: v for k, v in updates.items() if k in ALLOWED_BATCH_UPDATE_FIELDS}
    if not filtered_updates:
        return error_response("批量更新仅支持状态、分组、店铺、负责人、备注字段")

    updated_count = 0
    for pid in ids:
        result = Product.update(pid, filtered_updates)
        if result:
            updated_count += 1

    return success_response(data={"updated": updated_count}, msg=f"已更新 {updated_count} 个商品")


@product_bp.route('/products/<product_id>/publish-status', methods=['GET'])
@handle_errors
def get_product_publish_status(product_id):
    """获取商品的发布状态（用于"已发布商品管理"页面）

    返回商品的发布状态、Ozon 商品 ID、发布任务 ID、最新发布错误等。
    """
    product = Product.find_by_id(product_id)
    if not product:
        return error_response("商品不存在", 404)

    return success_response(data={
        "productId": product.get("id"),
        "status": product.get("status", "unpublished"),
        "publishStatus": product.get("publishStatus"),
        "publishTaskId": product.get("publishTaskId"),
        "ozonProductId": product.get("ozonProductId"),
        "storeId": product.get("storeId"),
        "title": product.get("title", ""),
        "price": product.get("price", 0),
        "oldPrice": product.get("oldPrice"),
        "skuList": product.get("skuList") or [],
        "skus": product.get("skus") or [],
    })


@product_bp.route('/products/<product_id>/update-published', methods=['PUT'])
@handle_errors
def update_published_product(product_id):
    """独立更新已发布商品的价格/库存（不重新发布商品）

    适用于"已发布商品管理"场景：商品已在 Ozon 上架，仅需调整价格/库存。

    请求体支持三种格式：
    1. 显式分项: { prices: [{offer_id, price, old_price?}], stocks: [{offer_id, stock}] }
    2. SKU 列表: { skuList: [{offerId/skuCode, price, oldPrice, stock}] }
    3. 整体覆盖: { price, oldPrice?, stock? }  (覆盖商品所有 SKU)

    可选参数:
      storeId: 目标店铺 ID（多店铺时透传凭证）
    """
    data = request.get_json()
    if not data:
        return error_response("请求体不能为空")

    store_id = data.pop('storeId', None) or data.pop('store_id', None)

    from services.publish_service import update_published_product as _do_update
    try:
        result = _do_update(product_id, data, store_id=store_id)
    except ValueError as e:
        return error_response(str(e), 400)
    except Exception as e:
        import logging
        logging.exception(f'[已发布更新] 商品 {product_id} 更新异常')
        return error_response(f"更新失败: {str(e)}", 500)

    if result.get('errors'):
        return success_response(
            data=result,
            msg=f"部分更新失败：{'; '.join(result['errors'])}"
        )
    return success_response(
        data=result,
        msg=f"已更新 {result.get('priceUpdated', 0)} 个价格、{result.get('stockUpdated', 0)} 个库存"
    )
