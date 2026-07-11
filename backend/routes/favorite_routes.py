"""
商品收藏 API 路由
替代毛子 ERP 云端 /api.product.favorite/*，本地收藏商品

接口:
- POST   /api/products/favorite/toggle   收藏/取消收藏
- GET    /api/products/favorite/skus      获取已收藏 SKU 列表
- GET    /api/products/favorites          收藏列表（分页）
- DELETE /api/products/favorites/<sku>    取消收藏
"""
import json
from flask import Blueprint, request
from db import get_connection
from utils.response import success_response, error_response, paginate_response, handle_errors
from utils.validators import extract_pagination

favorite_bp = Blueprint('favorite', __name__)


def _row_to_dict(row):
    """将数据库行转换为前端响应字典（JSON 字段反序列化）"""
    try:
        price_info = json.loads(row['price_info']) if row['price_info'] else {}
    except json.JSONDecodeError:
        price_info = {}
    try:
        rule_ids = json.loads(row['rule_ids']) if row['rule_ids'] else []
    except json.JSONDecodeError:
        rule_ids = []
    return {
        'id': row['id'],
        'sku': row['sku'],
        'title': row['title'],
        'coverImage': row['cover_image'],
        'priceInfo': price_info,
        'ruleIds': rule_ids,
        'autoFavorite': bool(row['auto_favorite']),
        'createdAt': row['created_at'],
        'updatedAt': row['updated_at'],
    }


@favorite_bp.route('/products/favorite/toggle', methods=['POST'])
@handle_errors
def toggle_favorite():
    """收藏/取消收藏商品

    请求体:
    {
        "sku": "xxx",                    // 必填
        "productInfo": {...},            // 可空，商品信息（含 title/coverImage/priceInfo）
        "status": true                   // 可空，true=收藏 false=取消收藏；缺省时取反当前状态
    }
    """
    data = request.get_json()
    if not data:
        return error_response("请求体不能为空")

    sku = str(data.get('sku') or '').strip()
    if not sku:
        return error_response("sku 不能为空")

    product_info = data.get('productInfo') or {}
    status = data.get('status')

    conn = get_connection()
    try:
        row = conn.execute(
            "SELECT id FROM product_favorites WHERE sku = ?", (sku,),
        ).fetchone()

        # 取反当前状态：未指定 status 时按是否已存在决定
        if status is None:
            status = not bool(row)

        if status:
            # 收藏（upsert）
            title = str(product_info.get('title') or '').strip()
            cover_image = str(product_info.get('coverImage') or '').strip()
            price_info = product_info.get('priceInfo', {})
            if not isinstance(price_info, (dict, list)):
                price_info = {}
            price_info_str = json.dumps(price_info, ensure_ascii=False)
            rule_ids = product_info.get('ruleIds', [])
            if not isinstance(rule_ids, list):
                rule_ids = []
            rule_ids_str = json.dumps(rule_ids, ensure_ascii=False)
            auto_favorite = 1 if product_info.get('autoFavorite') else 0

            conn.execute(
                """INSERT INTO product_favorites
                   (sku, title, cover_image, price_info, rule_ids, auto_favorite, created_at, updated_at)
                   VALUES (?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))
                   ON CONFLICT(sku) DO UPDATE SET
                       title = excluded.title,
                       cover_image = excluded.cover_image,
                       price_info = excluded.price_info,
                       rule_ids = excluded.rule_ids,
                       auto_favorite = excluded.auto_favorite,
                       updated_at = datetime('now')""",
                (sku, title, cover_image, price_info_str, rule_ids_str, auto_favorite),
            )
            conn.commit()
            msg = "已收藏"
            favorited = True
        else:
            # 取消收藏
            cur = conn.execute("DELETE FROM product_favorites WHERE sku = ?", (sku,))
            conn.commit()
            deleted = cur.rowcount
            msg = "已取消收藏" if deleted else "商品未收藏"
            favorited = False
    finally:
        conn.close()

    return success_response(data={'sku': sku, 'favorited': favorited}, msg=msg)


@favorite_bp.route('/products/favorite/skus', methods=['GET'])
@handle_errors
def list_favorite_skus():
    """获取已收藏 SKU 列表（仅返回 SKU 字符串数组，便于前端批量查询）"""
    conn = get_connection()
    try:
        rows = conn.execute(
            "SELECT sku FROM product_favorites ORDER BY created_at DESC"
        ).fetchall()
    finally:
        conn.close()

    skus = [row['sku'] for row in rows]
    return success_response(data={'skus': skus, 'total': len(skus)})


@favorite_bp.route('/products/favorites', methods=['GET'])
@handle_errors
def list_favorites():
    """收藏列表（分页）

    查询参数:
    - page: 页码（默认 1）
    - pageSize: 每页数量（默认 10）
    - keyword: 按 sku 或 title 模糊搜索（可空）
    - autoFavorite: 0/1，按是否自动收藏筛选（可空）
    """
    pagination = extract_pagination(request.args)
    keyword = request.args.get('keyword', '').strip()
    auto_favorite = request.args.get('autoFavorite', '').strip()

    conn = get_connection()
    try:
        sql = (
            "SELECT id, sku, title, cover_image, price_info, rule_ids, auto_favorite, created_at, updated_at "
            "FROM product_favorites WHERE 1=1"
        )
        params = []
        if keyword:
            sql += " AND (sku LIKE ? OR title LIKE ?)"
            params.extend([f'%{keyword}%', f'%{keyword}%'])
        if auto_favorite in ('0', '1'):
            sql += " AND auto_favorite = ?"
            params.append(int(auto_favorite))

        # 总数
        count_sql = sql.replace(
            "SELECT id, sku, title, cover_image, price_info, rule_ids, auto_favorite, created_at, updated_at",
            "SELECT COUNT(*) AS cnt",
        )
        total = conn.execute(count_sql, params).fetchone()['cnt']

        # 分页
        sql += " ORDER BY created_at DESC LIMIT ? OFFSET ?"
        params.extend([pagination['pageSize'], (pagination['page'] - 1) * pagination['pageSize']])
        rows = conn.execute(sql, params).fetchall()
    finally:
        conn.close()

    items = [_row_to_dict(row) for row in rows]
    return paginate_response(items, total, **pagination)


@favorite_bp.route('/products/favorites/<sku>', methods=['DELETE'])
@handle_errors
def delete_favorite(sku):
    """取消收藏（按 SKU 删除）"""
    sku = str(sku).strip()
    if not sku:
        return error_response("sku 不能为空")

    conn = get_connection()
    try:
        row = conn.execute(
            "SELECT id FROM product_favorites WHERE sku = ?", (sku,),
        ).fetchone()
        if not row:
            return error_response("商品未收藏", 404)

        cur = conn.execute("DELETE FROM product_favorites WHERE sku = ?", (sku,))
        conn.commit()
        deleted = cur.rowcount
    finally:
        conn.close()

    if deleted == 0:
        return error_response("删除失败", 500)

    return success_response(msg=f"已取消收藏 SKU {sku}")
