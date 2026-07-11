"""
Ozon SKU 数据缓存 API 路由
前端通过 seller-bridge 借权从 seller.ozon.ru 获取 sales/variant 数据聚合后缓存到本地
供 popup / ERP 管理面板 / 数据卡片复用，避免重复请求 seller.ozon.ru

接口:
- POST   /api/ozon/sku_data              提交（upsert）单个 SKU 聚合数据
- POST   /api/ozon/sku_data/batch        批量提交
- GET    /api/ozon/sku_data               列表查询（分页 + 关键词）
- GET    /api/ozon/sku_data/<sku>         查询单个 SKU 缓存
- DELETE /api/ozon/sku_data/<sku>         删除单个缓存
- POST   /api/ozon/sku_data/batch_get     批量查询（按 sku 数组）
"""
import json
from flask import Blueprint, request
from db import get_connection
from utils.response import success_response, error_response, paginate_response, handle_errors
from utils.validators import extract_pagination

ozon_data_bp = Blueprint('ozon_data', __name__)


@ozon_data_bp.route('/ozon/sku_data', methods=['POST'])
@handle_errors
def upsert_sku_data():
    """提交（upsert）单个 SKU 聚合数据

    请求体:
    {
        "sku": "xxx",            // 必填
        "title": "商品标题",      // 可空
        "data": {...},           // 必填，聚合后的字段对象
        "source": "seller_bridge" // 可空，数据来源
    }
    """
    data = request.get_json()
    if not data:
        return error_response("请求体不能为空")

    sku = str(data.get('sku') or '').strip()
    if not sku:
        return error_response("sku 不能为空")

    payload = data.get('data')
    if payload is None:
        return error_response("data 不能为空")

    title = str(data.get('title') or '').strip()
    source = str(data.get('source') or 'seller_bridge').strip()
    data_str = json.dumps(payload, ensure_ascii=False)

    conn = get_connection()
    try:
        conn.execute(
            """INSERT INTO ozon_sku_data (sku, title, data, source, created_at, updated_at)
               VALUES (?, ?, ?, ?, datetime('now'), datetime('now'))
               ON CONFLICT(sku) DO UPDATE SET
                   title = excluded.title,
                   data = excluded.data,
                   source = excluded.source,
                   updated_at = datetime('now')""",
            (sku, title, data_str, source),
        )
        conn.commit()
    finally:
        conn.close()

    return success_response(data={'sku': sku, 'cached': True}, msg="SKU 数据已缓存")


@ozon_data_bp.route('/ozon/sku_data/batch', methods=['POST'])
@handle_errors
def batch_upsert_sku_data():
    """批量提交 SKU 聚合数据

    请求体:
    {
        "items": [
            {"sku": "xxx", "title": "...", "data": {...}, "source": "..."},
            ...
        ]
    }
    """
    data = request.get_json()
    if not data or not isinstance(data.get('items'), list):
        return error_response("items 必须是数组")

    items = data['items']
    if not items:
        return error_response("items 不能为空")

    conn = get_connection()
    success_count = 0
    try:
        for item in items:
            sku = str(item.get('sku') or '').strip()
            if not sku:
                continue
            payload = item.get('data')
            if payload is None:
                continue
            title = str(item.get('title') or '').strip()
            source = str(item.get('source') or 'seller_bridge').strip()
            data_str = json.dumps(payload, ensure_ascii=False)
            conn.execute(
                """INSERT INTO ozon_sku_data (sku, title, data, source, created_at, updated_at)
                   VALUES (?, ?, ?, ?, datetime('now'), datetime('now'))
                   ON CONFLICT(sku) DO UPDATE SET
                       title = excluded.title,
                       data = excluded.data,
                       source = excluded.source,
                       updated_at = datetime('now')""",
                (sku, title, data_str, source),
            )
            success_count += 1
        conn.commit()
    finally:
        conn.close()

    return success_response(data={'success': success_count, 'total': len(items)},
                           msg=f"批量缓存完成（{success_count}/{len(items)}）")


@ozon_data_bp.route('/ozon/sku_data/batch_get', methods=['POST'])
@handle_errors
def batch_get_sku_data():
    """批量查询 SKU 缓存

    请求体:
    {
        "skus": ["sku1", "sku2", ...]
    }
    """
    data = request.get_json()
    if not data or not isinstance(data.get('skus'), list):
        return error_response("skus 必须是数组")

    skus = [str(s).strip() for s in data['skus'] if s]
    if not skus:
        return error_response("skus 不能为空")

    placeholders = ','.join('?' * len(skus))
    conn = get_connection()
    try:
        rows = conn.execute(
            f"SELECT sku, title, data, source, updated_at FROM ozon_sku_data WHERE sku IN ({placeholders})",
            skus,
        ).fetchall()
    finally:
        conn.close()

    result = {}
    for row in rows:
        try:
            result[row['sku']] = {
                'sku': row['sku'],
                'title': row['title'],
                'data': json.loads(row['data']),
                'source': row['source'],
                'updatedAt': row['updated_at'],
            }
        except (json.JSONDecodeError, KeyError):
            continue

    return success_response(data={'items': result, 'found': len(result), 'requested': len(skus)})


@ozon_data_bp.route('/ozon/sku_data/<sku>', methods=['GET'])
@handle_errors
def get_sku_data(sku):
    """查询单个 SKU 缓存"""
    sku = str(sku).strip()
    if not sku:
        return error_response("sku 不能为空")

    conn = get_connection()
    try:
        row = conn.execute(
            "SELECT sku, title, data, source, created_at, updated_at FROM ozon_sku_data WHERE sku = ?",
            (sku,),
        ).fetchone()
    finally:
        conn.close()

    if not row:
        return error_response("未找到 SKU 缓存", 404)

    try:
        data_obj = json.loads(row['data'])
    except json.JSONDecodeError:
        data_obj = {}

    return success_response(data={
        'sku': row['sku'],
        'title': row['title'],
        'data': data_obj,
        'source': row['source'],
        'createdAt': row['created_at'],
        'updatedAt': row['updated_at'],
    })


@ozon_data_bp.route('/ozon/sku_data/<sku>', methods=['DELETE'])
@handle_errors
def delete_sku_data(sku):
    """删除单个 SKU 缓存"""
    sku = str(sku).strip()
    if not sku:
        return error_response("sku 不能为空")

    conn = get_connection()
    try:
        cur = conn.execute("DELETE FROM ozon_sku_data WHERE sku = ?", (sku,))
        conn.commit()
        deleted = cur.rowcount
    finally:
        conn.close()

    if deleted == 0:
        return error_response("未找到 SKU 缓存", 404)

    return success_response(msg=f"已删除 SKU {sku} 的缓存")


@ozon_data_bp.route('/ozon/sku_data', methods=['GET'])
@handle_errors
def list_sku_data():
    """SKU 缓存列表（分页 + 关键词搜索）

    查询参数:
    - keyword: 按 sku 或 title 模糊匹配
    - source: 按数据来源筛选
    """
    pagination = extract_pagination(request.args)
    keyword = request.args.get('keyword', '').strip()
    source = request.args.get('source', '').strip()

    conn = get_connection()
    try:
        sql = "SELECT sku, title, source, created_at, updated_at FROM ozon_sku_data WHERE 1=1"
        params = []
        if keyword:
            sql += " AND (sku LIKE ? OR title LIKE ?)"
            params.extend([f'%{keyword}%', f'%{keyword}%'])
        if source:
            sql += " AND source = ?"
            params.append(source)

        # 总数
        count_sql = sql.replace("SELECT sku, title, source, created_at, updated_at", "SELECT COUNT(*) AS cnt")
        total = conn.execute(count_sql, params).fetchone()['cnt']

        # 分页
        sql += " ORDER BY updated_at DESC LIMIT ? OFFSET ?"
        params.extend([pagination['pageSize'], (pagination['page'] - 1) * pagination['pageSize']])
        rows = conn.execute(sql, params).fetchall()
    finally:
        conn.close()

    items = [{
        'sku': row['sku'],
        'title': row['title'],
        'source': row['source'],
        'createdAt': row['created_at'],
        'updatedAt': row['updated_at'],
    } for row in rows]

    return paginate_response(items, total, **pagination)
