"""
在线商品 API 路由
管理从 Ozon 店铺同步的在售商品，支持双向同步（拉取展示 + 反向更新价格/库存）

接口:
- GET    /api/online-products              列表查询（分页/状态/关键词/分组/评级/店铺）
- GET    /api/online-products/stats        状态统计
- GET    /api/online-products/<id>         单个详情
- POST   /api/online-products/sync         全量同步店铺商品（从 Ozon 拉取并 upsert）
- POST   /api/online-products/<id>/sync    同步单个商品
- PUT    /api/online-products/<id>         更新本地字段
- PUT    /api/online-products/<id>/price   更新价格并推送到 Ozon
- PUT    /api/online-products/<id>/stock   更新库存并推送到 Ozon
- POST   /api/online-products/batch/update 批量更新
- POST   /api/online-products/batch/delete 批量删除
- DELETE /api/online-products/<id>         删除单个
"""
from flask import Blueprint, request
import json
from models.online_product import OnlineProduct, from_ozon_info
from models.account import Store
from services.ozon_api import (
    list_all_products, get_product_info_list, get_product_info,
    get_product_attributes, get_product_description, import_products,
    get_category_tree_bilingual,
    update_prices, update_stocks, get_product_content_ratings,
    _get_store_credentials, OzonAPIError,
)
from utils.response import success_response, error_response, paginate_response, handle_errors
from utils.validators import extract_pagination
from services.publish_service import build_ozon_product_items, _get_bilingual_category_attributes

online_product_bp = Blueprint('online_products', __name__)


def _get_store_info(store_id=None):
    """获取店铺凭证和展示信息

    Returns:
        tuple: (client_id, api_key, store_name, store_pk)
    """
    store = None
    if store_id:
        try:
            store = Store.find_by_id(int(store_id))
        except (TypeError, ValueError):
            store = None
        if not store:
            store = Store.find_by_store_id(store_id)
    else:
        stores = Store.find_all(auth_status='active')
        store = stores[0] if stores else None
    if not store:
        return None, None, '', None
    from utils.security import decrypt_secret
    client_id = store.get('client_id') or store.get('store_id')
    api_key = decrypt_secret(store.get('api_key'))
    if not client_id or not api_key:
        return None, None, '', store.get('id')
    return (
        str(client_id), api_key,
        store.get('alias') or store.get('store_id') or '', store.get('id'),
    )


@online_product_bp.route('/online-products', methods=['GET'])
@handle_errors
def list_online_products():
    """在线商品列表（分页 + 筛选）

    查询参数:
    - page, pageSize: 分页
    - status: onsale/ready/reviewing/rejected/offline/archived
    - group: 分组
    - rating: 评级
    - store: 店铺名
    - storeId: 店铺主键 ID
    - keyword: 关键词
    """
    pagination = extract_pagination(request.args)
    filters = {
        'status': request.args.get('status', '').strip(),
        'group': request.args.get('group', '').strip(),
        'rating': request.args.get('rating', '').strip(),
        'store': request.args.get('store', '').strip(),
        'storeId': request.args.get('storeId', '').strip(),
    }
    keyword = request.args.get('keyword', '').strip()

    items, total = OnlineProduct.find_all(
        filters=filters,
        page=pagination['page'],
        page_size=pagination['pageSize'],
        keyword=keyword,
    )
    return paginate_response(items, total, **pagination)


@online_product_bp.route('/online-products/stats', methods=['GET'])
@handle_errors
def get_online_product_stats():
    """各状态统计"""
    stats = OnlineProduct.get_stats()
    return success_response(data=stats)


@online_product_bp.route('/online-products/<int:item_id>', methods=['GET'])
@handle_errors
def get_online_product(item_id):
    """单个商品详情"""
    item = OnlineProduct.find_by_id(item_id)
    if not item:
        return error_response("在线商品不存在", 404)
    return success_response(data=item)


def _reverse_ozon_product(info, attr_info, description, online_item):
    """把 Ozon 已发布数据转换为共享编辑器使用的商品结构。"""
    attrs = attr_info.get('attributes') or info.get('attributes') or []
    description_category_id = attr_info.get('description_category_id') or info.get('description_category_id')
    type_id = attr_info.get('type_id') or info.get('type_id')
    try:
        category_defs = _get_bilingual_category_attributes(description_category_id, type_id)
    except Exception as e:
        print(f'[在线商品反向读取] 双语属性名称加载失败: {e}')
        category_defs = []
    defs_by_id = {str(row.get('id')): row for row in category_defs if isinstance(row, dict)}

    category_label = ''
    type_name = ''
    type_name_zh = ''
    type_name_ru = ''
    try:
        for level1 in get_category_tree_bilingual(use_cache=True) or []:
            for level2 in level1.get('children') or []:
                if int(level2.get('description_category_id') or 0) != int(description_category_id or 0):
                    continue
                for level3 in level2.get('children') or []:
                    if int(level3.get('type_id') or 0) == int(type_id or 0):
                        type_name = str(level3.get('type_name') or '')
                        type_name_zh = str(level3.get('type_name_zh') or '')
                        type_name_ru = str(level3.get('type_name_ru') or '')
                        parts = [
                            level1.get('category_name'), level2.get('category_name'),
                            level3.get('type_name'),
                        ]
                        category_label = ' / '.join(str(part) for part in parts if part)
                        break
                if category_label:
                    break
            if category_label:
                break
    except Exception as e:
        print(f'[在线商品反向读取] 类目名称加载失败: {e}')

    def bilingual_attr(attr_id, fallback_ru=''):
        definition = defs_by_id.get(str(attr_id), {})
        ru_name = str(definition.get('name') or fallback_ru or '').strip()
        zh_name = str(definition.get('name_zh') or '').strip()
        if zh_name and ru_name and zh_name != ru_name:
            return f'{zh_name}（{ru_name}）', zh_name, ru_name, definition
        return zh_name or ru_name, zh_name, ru_name, definition

    normalized_attrs = []
    rich_content = ''
    sku_value_map = {}
    for attr in attrs:
        if not isinstance(attr, dict):
            continue
        values = attr.get('values') or []
        attr_id = attr.get('id') or attr.get('attribute_id')
        display_name, zh_name, ru_name, definition = bilingual_attr(attr_id)
        if str(attr_id) == '11254' and values:
            rich_content = str(values[0].get('value') or '')
        if str(attr_id) in ('10096', '10097') and values:
            sku_value_map[str(attr_id)] = values
        normalized_attrs.append({
            'id': attr_id,
            'name': display_name,
            'nameZh': zh_name,
            'nameRu': ru_name,
            'dictionaryId': definition.get('dictionary_id') or 0,
            'dictionary_value_id': (
                values[0].get('dictionary_value_id')
                if len(values) == 1 and isinstance(values[0], dict) else None
            ),
            'dictionary_value_ids': [
                value.get('dictionary_value_id') for value in values
                if isinstance(value, dict) and value.get('dictionary_value_id')
            ],
            'complexId': attr.get('complex_id', 0),
            'value': ', '.join(str(v.get('value', '')) for v in values if isinstance(v, dict)),
            'values': values,
        })
    def image_urls(value):
        if not value:
            return []
        values = value if isinstance(value, list) else [value]
        return [
            x if isinstance(x, str) else x.get('file_name', '')
            for x in values if isinstance(x, (str, dict))
        ]

    images = []
    for source in (
        attr_info.get('primary_image'), info.get('primary_image'),
        attr_info.get('images'), info.get('images'),
        attr_info.get('color_image'), info.get('color_image'),
    ):
        for url in image_urls(source):
            if url and url not in images:
                images.append(url)
    offer_id = info.get('offer_id') or online_item.get('ozonOfferId') or online_item.get('sku')
    price = info.get('price')
    if isinstance(price, dict):
        price = price.get('price')
    raw_stocks = info.get('stocks') or []
    if isinstance(raw_stocks, dict):
        raw_stocks = raw_stocks.get('stocks') or []
    stock = sum(
        int(row.get('present', 0) or 0)
        for row in raw_stocks if isinstance(row, dict)
    )
    if not raw_stocks:
        stock = int(online_item.get('stock') or 0)
    color_values = sku_value_map.get('10096') or []
    color_name_values = sku_value_map.get('10097') or []
    color = color_values[0].get('value', '') if color_values else ''
    color_name = color_name_values[0].get('value', '') if color_name_values else color
    color_label, color_zh, color_ru, color_def = bilingual_attr(10096, 'Цвет товара')
    color_name_label, color_name_zh, color_name_ru, color_name_def = bilingual_attr(10097, 'Название цвета')
    combo = {}
    if color:
        combo[color_label] = color
    if color_name:
        combo[color_name_label] = color_name
    sku_attrs = []
    if color_values:
        sku_attrs.append({
            'name': color_label, 'nameZh': color_zh, 'nameRu': color_ru,
            'attrId': 10096, 'dictionaryId': color_def.get('dictionary_id') or 1494,
            'skuType': 'color', 'attrCategory': 'sales',
            'values': [v.get('value', '') for v in color_values],
            'valueIds': [v.get('dictionary_value_id') for v in color_values],
        })
    if color_name_values:
        sku_attrs.append({
            'name': color_name_label, 'nameZh': color_name_zh, 'nameRu': color_name_ru,
            'attrId': 10097, 'dictionaryId': color_name_def.get('dictionary_id') or 0,
            'skuType': 'text', 'attrCategory': 'info',
            'values': [v.get('value', '') for v in color_name_values],
        })
    detail_images = []
    if rich_content:
        try:
            rich_data = json.loads(rich_content)
            def walk_rich(node):
                if isinstance(node, dict):
                    for key, value in node.items():
                        if key.lower() in ('src', 'url', 'image', 'imageurl', 'image_url'):
                            for url in image_urls(value):
                                if url.startswith(('http://', 'https://')) and url not in detail_images:
                                    detail_images.append(url)
                        walk_rich(value)
                elif isinstance(node, list):
                    for child in node:
                        walk_rich(child)
            walk_rich(rich_data)
        except (TypeError, ValueError):
            pass
    sku_entry = {
        'offerId': str(offer_id or ''),
        'offer_id': str(offer_id or ''),
        'skuCode': str(offer_id or ''),
        'sku': str(attr_info.get('sku') or info.get('sku') or ''),
        'skuId': str(attr_info.get('sku') or info.get('sku') or ''),
        'title': info.get('name') or '',
        'price': float(price or 0),
        'oldPrice': float(info.get('old_price') or 0),
        'old_price': float(info.get('old_price') or 0),
        'stock': stock,
        'weight': attr_info.get('weight') or info.get('weight') or 0,
        'length': attr_info.get('depth') or info.get('depth') or 0,
        'depth': attr_info.get('depth') or info.get('depth') or 0,
        'width': attr_info.get('width') or info.get('width') or 0,
        'height': attr_info.get('height') or info.get('height') or 0,
        'dimensionUnit': attr_info.get('dimension_unit') or info.get('dimension_unit') or 'mm',
        'image': images[0] if images else '',
        'images': [x for x in images if x],
        'color': color,
        'colorName': color_name,
        'combo': combo,
    }
    return {
        'id': str(online_item['id']),
        '_editorMode': 'online',
        'onlineProductId': str(online_item['id']),
        'ozonProductId': str(info.get('id') or online_item.get('ozonProductId') or ''),
        'offerId': str(offer_id or ''),
        'productId': str(info.get('id') or ''),
        'title': info.get('name') or online_item.get('title') or '',
        'description': description.get('description') or info.get('description') or '',
        'richContent': rich_content or description.get('rich_content_json') or description.get('rich_content') or '',
        'contentType': 'rich' if rich_content or description.get('rich_content_json') or description.get('rich_content') else 'description',
        'images': [x for x in images if x],
        'detailImages': detail_images,
        'attributes': normalized_attrs,
        'descriptionCategoryId': description_category_id,
        'typeId': type_id,
        'typeName': type_name,
        'typeNameZh': type_name_zh,
        'typeNameRu': type_name_ru,
        'category': category_label,
        'categoryMatch': {
            'matched': bool(category_label),
            'confidence': 'exact',
            'label': category_label,
            'description_category_id': description_category_id,
            'type_id': type_id,
            'source': 'ozon_reverse',
        },
        'price': float(price or online_item.get('price') or 0),
        'oldPrice': float(info.get('old_price') or online_item.get('originalPrice') or 0),
        'stock': stock,
        'weight': attr_info.get('weight') or info.get('weight') or 0,
        'weightValue': attr_info.get('weight') or info.get('weight') or 0,
        'weightUnit': attr_info.get('weight_unit') or info.get('weight_unit') or 'g',
        'dimensions': {
            'length': attr_info.get('depth') or info.get('depth') or 0,
            'width': attr_info.get('width') or info.get('width') or 0,
            'height': attr_info.get('height') or info.get('height') or 0,
            'unit': attr_info.get('dimension_unit') or info.get('dimension_unit') or 'mm',
        },
        'length': attr_info.get('depth') or info.get('depth') or 0,
        'width': attr_info.get('width') or info.get('width') or 0,
        'height': attr_info.get('height') or info.get('height') or 0,
        'skuList': [dict(sku_entry)],
        'skuAttrs': sku_attrs,
        'skus': [sku_entry],
        'store': online_item.get('store') or '',
        'storeId': online_item.get('storeId'),
        'group': online_item.get('group') or '未分组',
        'note': online_item.get('note') or '',
        'platform': 'ozon',
        'status': 'published',
    }


@online_product_bp.route('/online-products/<int:item_id>/edit-data', methods=['GET'])
@handle_errors
def get_online_product_edit_data(item_id):
    item = OnlineProduct.find_by_id(item_id)
    if not item:
        return error_response('在线商品不存在', 404)
    client_id, api_key, _, _ = _get_store_info(item.get('storeId'))
    if not client_id:
        return error_response('未配置 Ozon API 凭证', 401)
    product_id = item.get('ozonProductId') or item.get('productId')
    try:
        info = get_product_info(product_id=product_id, client_id=client_id, api_key=api_key)
        rows = get_product_attributes(product_id, client_id=client_id, api_key=api_key)
        attr_info = rows[0] if rows else {}
        try:
            description = get_product_description(product_id, client_id=client_id, api_key=api_key)
        except OzonAPIError:
            description = {}
    except OzonAPIError as e:
        return error_response(f'Ozon 商品反向读取失败: {e.message}', e.status_code or 502)
    return success_response(data=_reverse_ozon_product(info, attr_info, description, item))


@online_product_bp.route('/online-products/<int:item_id>/edit-data', methods=['PUT'])
@handle_errors
def save_online_product_edit_data(item_id):
    online_item = OnlineProduct.find_by_id(item_id)
    if not online_item:
        return error_response('在线商品不存在', 404)
    product = request.get_json(silent=True) or {}
    expected_offer = str(online_item.get('ozonOfferId') or online_item.get('sku') or '')
    submitted = product.get('skus') or []
    offers = {str(s.get('offerId') or s.get('skuCode') or '') for s in submitted if isinstance(s, dict)}
    offers.discard('')
    if offers and offers != {expected_offer}:
        return error_response('在线编辑只能更新原 offer_id，不能新增或替换 SKU', 400)
    product['offerId'] = expected_offer
    product['storeId'] = online_item.get('storeId')
    product['ozonProductId'] = online_item.get('ozonProductId')
    client_id, api_key, _, _ = _get_store_info(online_item.get('storeId'))
    if not client_id:
        return error_response('未配置 Ozon API 凭证', 401)
    try:
        items = build_ozon_product_items(product, store_id=online_item.get('storeId'), publish_mode='merge')
        if len(items) != 1:
            return error_response('在线商品编辑当前仅允许更新当前 SKU', 400)
        result = import_products(items, client_id=client_id, api_key=api_key)
    except (OzonAPIError, ValueError) as e:
        message = e.message if isinstance(e, OzonAPIError) else str(e)
        return error_response(f'Ozon 更新失败: {message}', getattr(e, 'status_code', None) or 502)
    return success_response(data={'taskId': (result.get('result') or {}).get('task_id'), 'ozon': result}, msg='已提交 Ozon 更新')


@online_product_bp.route('/online-products/sync', methods=['POST'])
@handle_errors
def sync_online_products():
    """全量同步店铺商品（从 Ozon 拉取并 upsert 到本地）

    请求体（可选）:
    {
        "storeId": "店铺ID",           // 可选，不传则用第一个可用店铺
        "statusFilter": "active",       // 可选，Ozon 原始状态过滤（默认全部）
        "limit": 1000                   // 可选，限制拉取数量（调试用）
    }

    同步流程:
    1. 取店铺凭证
    2. /v2/product/list 分页拉取全部商品 ID
    3. /v3/product/info/list 分批（每 100 个）获取详情
    4. from_ozon_info 转换字段后 upsert 到 online_products 表
    """
    data = request.get_json(silent=True) or {}
    store_id = (data.get('storeId') or '').strip() or None
    status_filter = (data.get('statusFilter') or '').strip() or None
    limit = data.get('limit')

    client_id, api_key, store_name, store_pk = _get_store_info(store_id)
    if not client_id:
        return error_response("未配置 Ozon API 凭证，请先在店铺管理中添加 API Key", 401)

    # 1. 拉取商品 ID 列表
    try:
        all_items = list_all_products(
            client_id=client_id, api_key=api_key,
            status_filter=status_filter,
        )
    except OzonAPIError as e:
        return error_response(f"拉取商品列表失败: {e.message}", e.status_code or 502)

    # 限制数量（调试用）
    if limit and isinstance(limit, int) and limit > 0:
        all_items = all_items[:limit]

    total = len(all_items)
    if total == 0:
        # 只有全量同步才能据此判断店铺为空；筛选结果为空不能删除其他状态商品。
        orphan_deleted = 0
        if not status_filter:
            orphan_deleted = OnlineProduct.cleanup_orphans([], store_id=store_pk)
        return success_response(data={
            'total': 0, 'synced': 0, 'inserted': 0, 'updated': 0, 'failed': 0,
            'orphanDeleted': orphan_deleted,
        }, msg=f"店铺无在售商品，已清理 {orphan_deleted} 条残留记录")

    # 2. 分批获取详情并 upsert
    product_ids = [item.get('product_id') for item in all_items if item.get('product_id')]
    list_items_by_id = {
        str(item.get('product_id')): item for item in all_items if item.get('product_id')
    }
    synced = 0
    inserted = 0
    updated = 0
    failed = 0
    batch_size = 100

    for i in range(0, len(product_ids), batch_size):
        batch = product_ids[i:i + batch_size]
        try:
            info_list = get_product_info_list(batch, client_id=client_id, api_key=api_key)
        except OzonAPIError as e:
            print(f'[在线商品同步] 第 {i}-{i + len(batch)} 批获取详情失败: {e.message}')
            failed += len(batch)
            continue

        rating_by_sku = {}
        try:
            rating_rows = get_product_content_ratings(
                [info.get('sku') for info in info_list if info.get('sku')],
                client_id=client_id, api_key=api_key,
            )
            for row in rating_rows:
                rating_by_sku[str(row.get('sku', ''))] = row
        except OzonAPIError as e:
            print(f'[在线商品同步] 内容评分拉取失败（不影响商品同步）: {e.message}')

        for ozon_info in info_list:
            try:
                ozon_info = dict(ozon_info)
                ozon_info.update({
                    k: v for k, v in list_items_by_id.get(str(ozon_info.get('id')), {}).items()
                    if k not in ('product_id', 'offer_id') and v not in (None, '')
                })
                score_row = rating_by_sku.get(str(ozon_info.get('sku', '')))
                if score_row:
                    ozon_info['content_rating'] = score_row.get('rating', score_row.get('score'))
                local_data = from_ozon_info(
                    ozon_info,
                    store_name=store_name,
                    store_id=store_pk,
                )
                # 检查是否已存在（统计 insert/update）
                existing = OnlineProduct.find_by_ozon_product_id(local_data.get('ozon_product_id'))
                OnlineProduct.upsert(local_data)
                if existing:
                    updated += 1
                else:
                    inserted += 1
                synced += 1
            except Exception as e:
                print(f'[在线商品同步] upsert 失败 (product_id={ozon_info.get("id")}): {e}')
                failed += 1

    # 3. 清理已不在 Ozon 店铺中的残留商品（下架/删除的）
    valid_ozon_ids = [str(pid) for pid in product_ids if pid]
    orphan_deleted = 0
    try:
        if not status_filter:
            orphan_deleted = OnlineProduct.cleanup_orphans(valid_ozon_ids, store_id=store_pk)
        if orphan_deleted > 0:
            print(f'[在线商品同步] 清理 {orphan_deleted} 个已下架/删除的残留商品')
    except Exception as e:
        print(f'[在线商品同步] 清理残留商品失败（非致命）: {e}')

    return success_response(data={
        'total': total,
        'synced': synced,
        'inserted': inserted,
        'updated': updated,
        'failed': failed,
        'orphanDeleted': orphan_deleted,
        'storeId': store_id,
        'storeName': store_name,
    }, msg=f"同步完成：共 {total} 个，新增 {inserted}，更新 {updated}，失败 {failed}，清理残留 {orphan_deleted}")


@online_product_bp.route('/online-products/<int:item_id>/sync', methods=['POST'])
@handle_errors
def sync_single_online_product(item_id):
    """同步单个商品（从 Ozon 拉取最新信息并更新本地）"""
    item = OnlineProduct.find_by_id(item_id)
    if not item:
        return error_response("在线商品不存在", 404)

    ozon_product_id = item.get('productId') or item.get('ozonProductId')
    if not ozon_product_id:
        return error_response("该商品无 Ozon 商品 ID，无法同步", 400)

    store_id = item.get('storeId')
    client_id, api_key, store_name, store_pk = _get_store_info(store_id)
    if not client_id:
        return error_response("未配置 Ozon API 凭证", 401)

    try:
        ozon_info = get_product_info(
            product_id=ozon_product_id,
            client_id=client_id, api_key=api_key,
        )
    except OzonAPIError as e:
        return error_response(f"同步失败: {e.message}", e.status_code or 502)

    if not ozon_info:
        return error_response("Ozon 未返回商品信息", 404)

    try:
        sku = ozon_info.get('sku')
        rows = get_product_content_ratings(
            [sku] if sku else [], client_id=client_id, api_key=api_key,
        )
        if rows:
            ozon_info['content_rating'] = rows[0].get('rating', rows[0].get('score'))
    except OzonAPIError as e:
        print(f'[在线商品同步] 单品内容评分拉取失败（不影响同步）: {e.message}')

    # 保留本地的 publisher/note/group/rating 等字段（不覆盖）
    local_data = from_ozon_info(
        ozon_info,
        store_name=store_name or item.get('store', ''),
        store_id=store_pk or store_id,
    )
    # 保留本地用户编辑的字段（publisher/note/group/rating/sourceId 等）
    # 用前端字段名作为 key，upsert 时会自动转换为 DB 列名
    for preserve_key in ['publisher', 'note', 'group', 'rating', 'sourceId',
                         'sourceLink', 'sourceName', 'mergeNo', 'platformSku']:
        if item.get(preserve_key):
            local_data[preserve_key] = item[preserve_key]

    updated_item = OnlineProduct.upsert(local_data)
    return success_response(data=updated_item, msg="商品同步成功")


@online_product_bp.route('/online-products/<int:item_id>', methods=['PUT'])
@handle_errors
def update_online_product(item_id):
    """更新本地字段（不推送到 Ozon）

    请求体: {字段名: 新值, ...}
    允许字段: group/rating/status/price/originalPrice/stock/note/publisher/category
    """
    data = request.get_json(silent=True)
    if not data:
        return error_response("请求体不能为空")

    updated = OnlineProduct.update(item_id, data)
    if not updated:
        return error_response("在线商品不存在", 404)
    return success_response(data=updated, msg="商品信息已更新")


@online_product_bp.route('/online-products/<int:item_id>/price', methods=['PUT'])
@handle_errors
def update_online_product_price(item_id):
    """更新价格并推送到 Ozon（双向同步：本地 + Ozon）

    请求体:
    {
        "price": 1199,           // 售价（₽）
        "oldPrice": 1599         // 划线价（₽，可选）
    }
    """
    data = request.get_json(silent=True)
    if not data:
        return error_response("请求体不能为空")

    price = data.get('price')
    old_price = data.get('oldPrice') or data.get('originalPrice')
    if price is None:
        return error_response("price 不能为空")

    try:
        price_val = float(price)
    except (ValueError, TypeError):
        return error_response("price 必须为数字")

    old_price_val = 0.0
    if old_price is not None:
        try:
            old_price_val = float(old_price)
        except (ValueError, TypeError):
            old_price_val = 0.0

    item = OnlineProduct.find_by_id(item_id)
    if not item:
        return error_response("在线商品不存在", 404)

    offer_id = item.get('ozonOfferId') or item.get('sku')
    if not offer_id:
        return error_response("该商品无 Ozon offer_id，无法更新价格", 400)

    store_id = item.get('storeId')
    client_id, api_key, _, _ = _get_store_info(store_id)
    if not client_id:
        return error_response("未配置 Ozon API 凭证", 401)

    # 推送到 Ozon
    price_item = {
        'offer_id': str(offer_id),
        'price': {
            'price': f'{price_val:.2f}',
        },
    }
    if old_price_val > 0:
        price_item['price']['old_price'] = f'{old_price_val:.2f}'

    try:
        update_prices([price_item], client_id=client_id, api_key=api_key)
    except OzonAPIError as e:
        return error_response(f"推送到 Ozon 失败: {e.message}", e.status_code or 502)

    # 更新本地
    OnlineProduct.update(item_id, {
        'price': price_val,
        'originalPrice': old_price_val,
    })
    updated = OnlineProduct.find_by_id(item_id)
    return success_response(data=updated, msg="价格已更新并推送到 Ozon")


@online_product_bp.route('/online-products/<int:item_id>/stock', methods=['PUT'])
@handle_errors
def update_online_product_stock(item_id):
    """更新库存并推送到 Ozon（双向同步：本地 + Ozon）

    请求体:
    {
        "stock": 100            // 库存数量
    }
    """
    data = request.get_json(silent=True)
    if not data:
        return error_response("请求体不能为空")

    stock = data.get('stock')
    if stock is None:
        return error_response("stock 不能为空")

    try:
        stock_val = int(stock)
    except (ValueError, TypeError):
        return error_response("stock 必须为整数")

    item = OnlineProduct.find_by_id(item_id)
    if not item:
        return error_response("在线商品不存在", 404)

    offer_id = item.get('ozonOfferId') or item.get('sku')
    if not offer_id:
        return error_response("该商品无 Ozon offer_id，无法更新库存", 400)

    store_id = item.get('storeId')
    client_id, api_key, _, _ = _get_store_info(store_id)
    if not client_id:
        return error_response("未配置 Ozon API 凭证", 401)

    # 推送到 Ozon
    stock_item = {
        'offer_id': str(offer_id),
        'stock': {'present': stock_val, 'reserved': 0},
    }

    try:
        update_stocks([stock_item], client_id=client_id, api_key=api_key)
    except OzonAPIError as e:
        return error_response(f"推送到 Ozon 失败: {e.message}", e.status_code or 502)

    # 更新本地
    OnlineProduct.update(item_id, {'stock': stock_val})
    updated = OnlineProduct.find_by_id(item_id)
    return success_response(data=updated, msg="库存已更新并推送到 Ozon")


@online_product_bp.route('/online-products/batch/update', methods=['POST'])
@handle_errors
def batch_update_online_products():
    """批量更新（仅本地字段，不推送 Ozon）

    请求体:
    {
        "ids": [1, 2, 3],
        "updates": {"group": "3C数码", "status": "onsale", "note": "..."}
    }
    允许字段: group/rating/status/note/publisher
    """
    data = request.get_json(silent=True)
    if not data:
        return error_response("请求体不能为空")

    ids = data.get('ids')
    updates = data.get('updates')
    if not isinstance(ids, list) or not ids:
        return error_response("ids 必须是非空数组")
    if not isinstance(updates, dict) or not updates:
        return error_response("updates 不能为空")

    affected = OnlineProduct.batch_update(ids, updates)
    return success_response(data={'affected': affected}, msg=f"已更新 {affected} 条商品")


@online_product_bp.route('/online-products/batch/delete', methods=['POST'])
@handle_errors
def batch_delete_online_products():
    """批量删除（仅本地，不影响 Ozon 店铺商品）"""
    data = request.get_json(silent=True)
    if not data:
        return error_response("请求体不能为空")

    ids = data.get('ids')
    if not isinstance(ids, list) or not ids:
        return error_response("ids 必须是非空数组")

    deleted = OnlineProduct.batch_delete(ids)
    return success_response(data={'deleted': deleted}, msg=f"已删除 {deleted} 条商品")


@online_product_bp.route('/online-products/<int:item_id>', methods=['DELETE'])
@handle_errors
def delete_online_product(item_id):
    """删除单个（仅本地，不影响 Ozon 店铺商品）"""
    ok = OnlineProduct.delete(item_id)
    if not ok:
        return error_response("在线商品不存在", 404)
    return success_response(msg="商品已删除")
