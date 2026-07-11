"""
GeekOzon ERP - 在线商品数据模型
基于 SQLite，管理从 Ozon 店铺同步的在售商品

字段对齐前端 online-products.js 的 22 个展示字段（不改变前端数据结构），
DB 列名 grp/original_price 在 to_dict() 时映射为前端 group/originalPrice。
"""
from datetime import datetime
from db import query, execute, get_connection
from services.ozon_api import map_ozon_status_to_frontend


# DB 列名 → 前端字段名映射（仅列名不同的字段，其余字段名 DB 与前端一致）
_DB_TO_FRONTEND = {
    'grp': 'group',
    'original_price': 'originalPrice',
    'source_id': 'sourceId',
    'product_id': 'productId',
    'merge_no': 'mergeNo',
    'sku_id': 'skuId',
    'platform_sku': 'platformSku',
    'source_link': 'sourceLink',
    'source_name': 'sourceName',
    'store_id': 'storeId',
    'ozon_product_id': 'ozonProductId',
    'ozon_offer_id': 'ozonOfferId',
    'ozon_status': 'ozonStatus',
    'last_synced_at': 'lastSyncedAt',
    'created_at': 'createdAt',
    'updated_at': 'updatedAt',
}

# 前端字段名 → DB 列名映射（反向）
_FRONTEND_TO_DB = {v: k for k, v in _DB_TO_FRONTEND.items()}

# 前端展示字段白名单
DISPLAY_FIELDS = [
    'id', 'sku', 'title', 'image', 'group', 'rating', 'status',
    'price', 'originalPrice', 'sales', 'stock',
    'category', 'store', 'publisher', 'time', 'note',
    'sourceId', 'productId', 'mergeNo', 'skuId', 'platformSku',
    'sourceLink', 'sourceName',
]

# 前端可编辑字段白名单（editOnlineProduct / batchUpdate 允许修改的字段）
EDITABLE_FIELDS = {
    'group', 'rating', 'status', 'price', 'originalPrice', 'stock',
    'note', 'publisher', 'category',
}

# 批量更新允许的字段（更严格）
BATCH_EDITABLE_FIELDS = {
    'group', 'rating', 'status', 'note', 'publisher',
}


def _now():
    return datetime.now().strftime('%Y-%m-%d %H:%M:%S')


def _row_to_dict(row):
    """将数据库行转换为前端字段结构（DB 列名 → 前端字段名）"""
    if not row:
        return None
    d = dict(row)
    # id 转为字符串（前端用字符串拼接 tr data-id）
    if 'id' in d:
        d['id'] = str(d['id'])
    # 列名映射
    result = {}
    for db_key, value in d.items():
        front_key = _DB_TO_FRONTEND.get(db_key, db_key)
        result[front_key] = value
    return result


def _frontend_to_db_field(frontend_field):
    """前端字段名 → DB 列名"""
    return _FRONTEND_TO_DB.get(frontend_field, frontend_field)


def from_ozon_info(ozon_info, store_name='', store_id=None, publisher=''):
    """将 Ozon /v3/product/info 返回的商品详情转换为本地字段结构

    兼容 v2 和 v3 两种响应格式：
    - v3: price/old_price 是顶层字符串，stocks 是 {has_stock, stocks[]} 对象
    - v2: price 是 {price, old_price, marketing_price} 对象，stocks 是 [{present, reserved}] 数组

    Args:
        ozon_info: Ozon API 返回的单个商品详情 dict
        store_name: 店铺名称（展示用）
        store_id: 本地店铺主键 ID
        publisher: 发布人员（本地字段，Ozon API 不返回）

    Returns:
        dict: 本地字段结构（DB 列名），可传入 upsert
    """
    raw_price = ozon_info.get('price')
    if isinstance(raw_price, dict):
        # v2 格式: price 是对象 {price, old_price, marketing_price}
        price = _parse_price(raw_price.get('price'))
        old_price = _parse_price(raw_price.get('old_price'))
        marketing_price = _parse_price(raw_price.get('marketing_price'))
    else:
        # v3 格式: price/old_price 是顶层字符串
        price = _parse_price(raw_price)
        old_price = _parse_price(ozon_info.get('old_price'))
        marketing_price = _parse_price(ozon_info.get('min_price'))

    # 库存：v3 是 {has_stock, stocks[]} 对象，v2 是 [{present, reserved}] 数组
    raw_stocks = ozon_info.get('stocks', []) or []
    if isinstance(raw_stocks, dict):
        # v3 格式
        stock_list = raw_stocks.get('stocks', []) or []
        total_present = sum(int(s.get('present', 0) or 0) for s in stock_list if isinstance(s, dict))
    elif isinstance(raw_stocks, list):
        # v2 格式
        total_present = sum(int(s.get('present', 0) or 0) for s in raw_stocks if isinstance(s, dict))
    else:
        total_present = 0

    # 销量：sources 数组每项 {source, count, ...}（部分商品无此字段）
    sources = ozon_info.get('sources', []) or []
    sales = sum(int(s.get('count', 0) or 0) for s in sources if isinstance(s, dict))

    # 状态：v3 无 status 字段，用 is_archived 推断
    ozon_status = ozon_info.get('status', '') or ''
    if not ozon_status:
        if ozon_info.get('is_archived'):
            ozon_status = 'archived'
        elif ozon_info.get('errors'):
            ozon_status = 'failed'
        else:
            ozon_status = 'active'
    frontend_status = map_ozon_status_to_frontend(ozon_status)

    ozon_product_id = str(ozon_info.get('id', '') or '')
    offer_id = str(ozon_info.get('offer_id', '') or '')

    # 主图：v3 的 primary_image 是 ['url'] 列表，v2 是 'url' 字符串
    primary_image = ozon_info.get('primary_image', '') or ''
    if isinstance(primary_image, list):
        primary_image = primary_image[0] if primary_image else ''
    if not primary_image:
        images = ozon_info.get('images', []) or []
        if images:
            primary_image = images[0] if isinstance(images[0], str) else (images[0].get('file_name') or '')

    # 类目：v3 用 description_category_id，v2 用 category_id
    category_id = ozon_info.get('description_category_id') or ozon_info.get('category_id', '')

    return {
        'sku': offer_id,                       # 本地 SKU 沿用 Ozon offer_id
        'title': ozon_info.get('name', '') or '',
        'image': primary_image,
        'status': frontend_status,
        'price': price,
        'original_price': old_price or marketing_price,
        'sales': sales,
        'stock': total_present,
        'category': f'Ozon类目#{category_id}' if category_id else '',
        'store': store_name,
        'publisher': publisher,
        'time': _now(),
        'product_id': ozon_product_id,
        'ozon_product_id': ozon_product_id,
        'ozon_offer_id': offer_id,
        'store_id': store_id,
        'ozon_status': ozon_status,
        'last_synced_at': _now(),
    }


def _parse_price(value):
    """解析 Ozon 价格字段（字符串/数字 → float）"""
    if value is None or value == '':
        return 0.0
    try:
        return float(value)
    except (ValueError, TypeError):
        return 0.0


class OnlineProduct:
    """在线商品模型 - 基于 SQLite 的 ORM 封装"""

    @staticmethod
    def find_all(filters=None, page=1, page_size=50, keyword=''):
        """查询在线商品列表（分页 + 筛选）

        Args:
            filters: dict，支持 status/group/rating/store/storeId 筛选
            page: 页码（从 1 开始）
            page_size: 每页数量
            keyword: 关键词（匹配 title/sku/note/category）

        Returns:
            tuple: (items, total)
        """
        conditions = []
        params = []
        if filters:
            if filters.get('status'):
                conditions.append("status = ?")
                params.append(filters['status'])
            if filters.get('group'):
                conditions.append("grp = ?")
                params.append(filters['group'])
            if filters.get('rating'):
                conditions.append("rating = ?")
                params.append(filters['rating'])
            if filters.get('store'):
                conditions.append("store = ?")
                params.append(filters['store'])
            if filters.get('storeId'):
                conditions.append("store_id = ?")
                params.append(filters['storeId'])
        if keyword:
            kw = f'%{keyword}%'
            conditions.append("(title LIKE ? OR sku LIKE ? OR note LIKE ? OR product_id LIKE ? OR ozon_offer_id LIKE ?)")
            params.extend([kw, kw, kw, kw, kw])

        where = " WHERE " + " AND ".join(conditions) if conditions else ""
        count_sql = f"SELECT COUNT(*) AS cnt FROM online_products{where}"
        total = query(count_sql, params, one=True)['cnt']

        offset = (page - 1) * page_size
        list_sql = (
            f"SELECT * FROM online_products{where} "
            f"ORDER BY updated_at DESC LIMIT ? OFFSET ?"
        )
        rows = query(list_sql, params + [page_size, offset])
        items = [_row_to_dict(r) for r in rows]
        return items, total

    @staticmethod
    def find_by_id(item_id):
        """按主键 ID 查询"""
        try:
            pk = int(item_id)
        except (ValueError, TypeError):
            return None
        row = query("SELECT * FROM online_products WHERE id = ?", (pk,), one=True)
        return _row_to_dict(row)

    @staticmethod
    def find_by_ozon_product_id(ozon_product_id):
        """按 Ozon 商品 ID 查询（用于 upsert 判重）"""
        if not ozon_product_id:
            return None
        row = query(
            "SELECT * FROM online_products WHERE ozon_product_id = ?",
            (str(ozon_product_id),), one=True,
        )
        return _row_to_dict(row)

    @staticmethod
    def upsert(data):
        """插入或更新（按 ozon_product_id 去重）

        新记录插入时保留 data 中的所有字段；
        已存在记录仅更新 data 中提供的字段，未提供的字段保持原值。

        Returns:
            dict: 转换为前端字段结构后的记录
        """
        ozon_pid = str(data.get('ozon_product_id') or '').strip()
        if not ozon_pid:
            # 无 Ozon 商品 ID 时按 offer_id 兜底
            ozon_pid = str(data.get('ozon_offer_id') or '').strip()

        existing = None
        if ozon_pid:
            existing = OnlineProduct.find_by_ozon_product_id(ozon_pid)

        now = _now()

        if existing:
            # 更新：仅合并 data 中非 None 的字段
            pk = int(existing['id'])
            set_clauses = []
            params = []
            for k, v in data.items():
                if v is None:
                    continue
                db_col = _frontend_to_db_field(k)
                # 防止列名不在表中
                set_clauses.append(f"{db_col} = ?")
                params.append(v)
            if not set_clauses:
                return existing
            set_clauses.append("updated_at = ?")
            params.append(now)
            params.append(pk)
            execute(
                f"UPDATE online_products SET {', '.join(set_clauses)} WHERE id = ?",
                params,
            )
            return OnlineProduct.find_by_id(pk)
        else:
            # 插入新记录
            cols = []
            placeholders = []
            values = []
            for k, v in data.items():
                if v is None:
                    continue
                db_col = _frontend_to_db_field(k)
                cols.append(db_col)
                placeholders.append('?')
                values.append(v)
            cols.extend(['created_at', 'updated_at'])
            placeholders.extend(['?', '?'])
            values.extend([now, now])
            pk = execute(
                f"INSERT INTO online_products ({', '.join(cols)}) VALUES ({', '.join(placeholders)})",
                values,
            )
            return OnlineProduct.find_by_id(pk)

    @staticmethod
    def update(item_id, update_data):
        """更新单条记录（仅允许前端可编辑字段）

        Args:
            item_id: 主键 ID
            update_data: dict，前端字段名 → 新值

        Returns:
            dict: 更新后的记录（前端字段结构），未找到返回 None
        """
        try:
            pk = int(item_id)
        except (ValueError, TypeError):
            return None

        set_clauses = []
        params = []
        for k, v in update_data.items():
            if k not in EDITABLE_FIELDS:
                continue
            db_col = _frontend_to_db_field(k)
            set_clauses.append(f"{db_col} = ?")
            params.append(v)

        if not set_clauses:
            return OnlineProduct.find_by_id(pk)

        set_clauses.append("updated_at = ?")
        params.append(_now())
        params.append(pk)
        execute(
            f"UPDATE online_products SET {', '.join(set_clauses)} WHERE id = ?",
            params,
        )
        return OnlineProduct.find_by_id(pk)

    @staticmethod
    def batch_update(ids, updates):
        """批量更新（仅允许 BATCH_EDITABLE_FIELDS 字段）"""
        if not ids or not updates:
            return 0
        # 过滤允许的字段
        filtered = {k: v for k, v in updates.items() if k in BATCH_EDITABLE_FIELDS}
        if not filtered:
            return 0

        set_clauses = []
        params = []
        for k, v in filtered.items():
            db_col = _frontend_to_db_field(k)
            set_clauses.append(f"{db_col} = ?")
            params.append(v)
        set_clauses.append("updated_at = ?")
        params.append(_now())

        placeholders = ','.join('?' * len(ids))
        sql = f"UPDATE online_products SET {', '.join(set_clauses)} WHERE id IN ({placeholders})"

        conn = get_connection()
        try:
            cur = conn.execute(sql, params + [int(i) for i in ids])
            conn.commit()
            return cur.rowcount
        finally:
            conn.close()

    @staticmethod
    def delete(item_id):
        """删除单条记录"""
        try:
            pk = int(item_id)
        except (ValueError, TypeError):
            return False
        cur = execute("DELETE FROM online_products WHERE id = ?", (pk,))
        return cur > 0

    @staticmethod
    def batch_delete(ids):
        """批量删除"""
        if not ids:
            return 0
        placeholders = ','.join('?' * len(ids))
        conn = get_connection()
        try:
            cur = conn.execute(
                f"DELETE FROM online_products WHERE id IN ({placeholders})",
                [int(i) for i in ids],
            )
            conn.commit()
            return cur.rowcount
        finally:
            conn.close()

    @staticmethod
    def get_stats():
        """获取各状态统计"""
        rows = query(
            "SELECT status, COUNT(*) AS cnt FROM online_products GROUP BY status"
        )
        stats = {
            'onsale': 0, 'ready': 0, 'reviewing': 0,
            'rejected': 0, 'offline': 0, 'archived': 0,
        }
        for row in rows:
            s = row['status']
            if s in stats:
                stats[s] = row['cnt']
            else:
                stats[s] = row['cnt']
        total = sum(stats.values())
        return {'stats': stats, 'total': total}

    @staticmethod
    def count():
        """总数量"""
        result = query("SELECT COUNT(*) AS cnt FROM online_products", one=True)
        return result['cnt'] if result else 0

    @staticmethod
    def get_ozon_offer_id(item_id):
        """获取商品的 ozon_offer_id（用于价格/库存更新到 Ozon）"""
        try:
            pk = int(item_id)
        except (ValueError, TypeError):
            return None, None
        row = query(
            "SELECT ozon_offer_id, store_id FROM online_products WHERE id = ?",
            (pk,), one=True,
        )
        if not row:
            return None, None
        return row['ozon_offer_id'], row['store_id']

    @staticmethod
    def cleanup_orphans(valid_ozon_ids, store_id=None):
        """清理已不在 Ozon 店铺中的商品（下架/删除的残留数据）

        同步时调用：拉取 Ozon 最新商品列表后，删除本地表中 ozon_product_id
        不在列表中的记录（仅限同一店铺）。

        Args:
            valid_ozon_ids: 当前 Ozon 店铺中存在的商品 ID 集合（字符串列表）
            store_id: 店铺主键 ID，用于限定清理范围（避免误删其他店铺数据）

        Returns:
            int: 被删除的记录数
        """
        if not valid_ozon_ids:
            # Ozon 店铺无商品 → 清空该店铺的所有本地记录
            if store_id:
                conn = get_connection()
                try:
                    cur = conn.execute(
                        "DELETE FROM online_products WHERE store_id = ?",
                        [store_id],
                    )
                    conn.commit()
                    return cur.rowcount
                finally:
                    conn.close()
            return 0

        # 构建 NOT IN 查询：删除该店铺下不在 valid_ozon_ids 中的记录
        placeholders = ','.join('?' * len(valid_ozon_ids))
        sql = f"DELETE FROM online_products WHERE ozon_product_id NOT IN ({placeholders})"
        params = list(valid_ozon_ids)
        if store_id:
            sql += " AND store_id = ?"
            params.append(store_id)

        conn = get_connection()
        try:
            cur = conn.execute(sql, params)
            conn.commit()
            return cur.rowcount
        finally:
            conn.close()
