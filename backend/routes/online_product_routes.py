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
from models.online_product import OnlineProduct, from_ozon_info
from models.account import Store
from services.ozon_api import (
    list_all_products, get_product_info_list, get_product_info,
    update_prices, update_stocks, _get_store_credentials, OzonAPIError,
)
from utils.response import success_response, error_response, paginate_response, handle_errors
from utils.validators import extract_pagination

online_product_bp = Blueprint('online_products', __name__)


def _get_store_info(store_id=None):
    """获取店铺凭证和展示信息

    Returns:
        tuple: (client_id, api_key, store_name, store_pk)
    """
    client_id, api_key = _get_store_credentials(store_id)
    if not client_id or not api_key:
        return None, None, '', None

    store_name = ''
    store_pk = None
    if store_id:
        store = Store.find_by_store_id(store_id)
    else:
        stores = Store.find_all(auth_status='active')
        store = stores[0] if stores else None

    if store:
        store_name = store.get('alias') or store.get('store_id') or ''
        store_pk = store.get('id')

    return client_id, api_key, store_name, store_pk


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
        # 店铺无商品 → 清空该店铺的所有本地残留
        orphan_deleted = OnlineProduct.cleanup_orphans([], store_id=store_pk)
        return success_response(data={
            'total': 0, 'synced': 0, 'inserted': 0, 'updated': 0, 'failed': 0,
            'orphanDeleted': orphan_deleted,
        }, msg=f"店铺无在售商品，已清理 {orphan_deleted} 条残留记录")

    # 2. 分批获取详情并 upsert
    product_ids = [item.get('product_id') for item in all_items if item.get('product_id')]
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

        for ozon_info in info_list:
            try:
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
