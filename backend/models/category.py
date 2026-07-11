"""
Ozon 类目与映射数据模型
- OzonCategory: 完整类目树（L1/L2/L3）
- CategoryMapping: 动态映射缓存（替代 JSON 文件）
- CategorySyncLog: 类目同步日志
"""
from db import query, execute


class OzonCategory:
    """Ozon 完整类目树模型"""

    @staticmethod
    def count():
        """类目总数"""
        row = query("SELECT COUNT(*) AS cnt FROM ozon_categories", one=True)
        return row['cnt'] if row else 0

    @staticmethod
    def count_by_level(level):
        """按层级统计"""
        row = query("SELECT COUNT(*) AS cnt FROM ozon_categories WHERE level = ?", (level,), one=True)
        return row['cnt'] if row else 0

    @staticmethod
    def find_by_type_id(type_id):
        """根据 type_id 查询 L3 叶子节点"""
        return query("SELECT * FROM ozon_categories WHERE type_id = ? AND level = 3", (type_id,), one=True)

    @staticmethod
    def find_by_description_category_id(desc_cat_id, level=None):
        """根据 description_category_id 查询"""
        if level:
            return query(
                "SELECT * FROM ozon_categories WHERE description_category_id = ? AND level = ?",
                (desc_cat_id, level), one=True
            )
        return query(
            "SELECT * FROM ozon_categories WHERE description_category_id = ?",
            (desc_cat_id,), one=True
        )

    @staticmethod
    def get_tree():
        """获取完整类目树（嵌套结构，与原 JSON 缓存格式兼容）

        返回: [
            { description_category_id, category_name, category_name_zh, category_name_ru,
              disabled, children: [  # L2
                { description_category_id, category_name, ..., children: [  # L3
                    { type_id, type_name, type_name_zh, type_name_ru, disabled, children: [] }
                ]}
              ]}
        ]
        """
        all_rows = query(
            "SELECT * FROM ozon_categories ORDER BY level, id"
        )
        if not all_rows:
            return []

        # 构建 by_id 索引（同一个 dict 对象，后续直接修改它以添加 children）
        by_id = {}
        for row in all_rows:
            node = dict(row)
            # 标准化字段名（兼容前端期望的格式）
            if node.get('level') == 3:
                node['type_name'] = node.get('category_name', '')
                node['type_name_zh'] = node.get('category_name_zh', '')
                node['type_name_ru'] = node.get('category_name_ru', '')
            node['children'] = []
            by_id[node['id']] = node

        # 组装树结构：把子节点挂到父节点的 children 数组
        l1_list = []
        for row in all_rows:
            node = by_id[row['id']]
            if row.get('level') == 1:
                l1_list.append(node)
            else:
                parent_id = row.get('parent_id')
                if parent_id and parent_id in by_id:
                    by_id[parent_id]['children'].append(node)

        return l1_list

    @staticmethod
    def get_all_flat():
        """获取扁平化全部类目（用于关键词匹配打分）"""
        return query("SELECT * FROM ozon_categories ORDER BY level, category_name")

    @staticmethod
    def replace_all(rows):
        """全量替换类目树（事务内删除+插入）

        参数 rows: list of dict，每个 dict 含:
            description_category_id, type_id, parent_id(本表), level,
            category_name, category_name_zh, category_name_ru, disabled
        """
        from db import get_connection
        conn = get_connection()
        try:
            conn.execute("DELETE FROM ozon_categories")
            conn.executemany(
                """INSERT INTO ozon_categories
                   (description_category_id, type_id, parent_id, level,
                    category_name, category_name_zh, category_name_ru, disabled)
                   VALUES (?, ?, ?, ?, ?, ?, ?, ?)""",
                [(
                    r.get('description_category_id'),
                    r.get('type_id'),
                    r.get('parent_id'),
                    r.get('level'),
                    r.get('category_name', ''),
                    r.get('category_name_zh', ''),
                    r.get('category_name_ru', ''),
                    1 if r.get('disabled') else 0,
                ) for r in rows]
            )
            conn.commit()
        finally:
            conn.close()

    @staticmethod
    def search(keyword, limit=20):
        """关键词搜索类目（用于手动选择）

        返回 L3 叶子节点，并附带从父节点(L2)继承的 description_category_id
        （L3 节点本身只存 type_id，description_category_id 存在 L2 上）
        """
        like = f'%{keyword}%'
        return query(
            """SELECT c3.*,
                      COALESCE(c3.description_category_id, c2.description_category_id) AS description_category_id,
                      c2.category_name AS parent_category_name,
                      c2.category_name_zh AS parent_category_name_zh
               FROM ozon_categories c3
               LEFT JOIN ozon_categories c2 ON c3.parent_id = c2.id
               WHERE c3.level = 3
                 AND (c3.category_name LIKE ? OR c3.category_name_zh LIKE ? OR c3.category_name_ru LIKE ?
                      OR c2.category_name LIKE ? OR c2.category_name_zh LIKE ?)
               LIMIT ?""",
            (like, like, like, like, like, limit)
        )


class CategoryMapping:
    """动态类目映射缓存模型（替代 JSON 文件存储）"""

    @staticmethod
    def find_by_key(cache_key):
        """根据 cache_key 查询映射"""
        return query(
            "SELECT * FROM category_mappings WHERE cache_key = ?",
            (cache_key,), one=True
        )

    @staticmethod
    def find_all(limit=200, offset=0, matched_only=False):
        """获取全部映射（分页）"""
        sql = "SELECT * FROM category_mappings"
        params = []
        if matched_only:
            sql += " WHERE matched = 1"
        sql += " ORDER BY updated_at DESC LIMIT ? OFFSET ?"
        params.extend([limit, offset])
        return query(sql, tuple(params))

    @staticmethod
    def upsert(cache_key, source_category, title, description_category_id, type_id,
               label, confidence, matched, manual=0):
        """新增或更新映射（INSERT OR REPLACE）"""
        return execute(
            """INSERT INTO category_mappings
               (cache_key, source_category, title, description_category_id, type_id,
                label, confidence, matched, manual, hit_count, created_at, updated_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, datetime('now'), datetime('now'))
               ON CONFLICT(cache_key) DO UPDATE SET
                   source_category = excluded.source_category,
                   title = excluded.title,
                   description_category_id = excluded.description_category_id,
                   type_id = excluded.type_id,
                   label = excluded.label,
                   confidence = excluded.confidence,
                   matched = excluded.matched,
                   manual = excluded.manual,
                   updated_at = datetime('now')""",
            (cache_key, source_category, title, description_category_id, type_id,
             label, confidence, 1 if matched else 0, 1 if manual else 0)
        )

    @staticmethod
    def increment_hit_count(cache_key):
        """命中次数 +1"""
        execute(
            "UPDATE category_mappings SET hit_count = hit_count + 1, updated_at = datetime('now') WHERE cache_key = ?",
            (cache_key,)
        )

    @staticmethod
    def delete_by_key(cache_key):
        """根据 key 删除"""
        execute("DELETE FROM category_mappings WHERE cache_key = ?", (cache_key,))

    @staticmethod
    def delete_by_source(source_category, title=''):
        """根据源类目删除（返回是否删除成功）"""
        import hashlib
        cache_key = hashlib.md5(f"{source_category}||{title}".encode('utf-8')).hexdigest()[:16]
        row = CategoryMapping.find_by_key(cache_key)
        if row:
            CategoryMapping.delete_by_key(cache_key)
            return True
        return False

    @staticmethod
    def clear_all():
        """清空所有映射"""
        execute("DELETE FROM category_mappings")

    @staticmethod
    def count(matched_only=False):
        """统计总数"""
        if matched_only:
            row = query("SELECT COUNT(*) AS cnt FROM category_mappings WHERE matched = 1", one=True)
        else:
            row = query("SELECT COUNT(*) AS cnt FROM category_mappings", one=True)
        return row['cnt'] if row else 0

    @staticmethod
    def get_stats():
        """获取统计信息"""
        total = CategoryMapping.count()
        matched = CategoryMapping.count(matched_only=True)
        manual_row = query("SELECT COUNT(*) AS cnt FROM category_mappings WHERE manual = 1", one=True)
        total_hits_row = query("SELECT COALESCE(SUM(hit_count), 0) AS cnt FROM category_mappings", one=True)
        return {
            'total_entries': total,
            'matched_entries': matched,
            'manual_entries': manual_row['cnt'] if manual_row else 0,
            'total_hits': total_hits_row['cnt'] if total_hits_row else 0,
        }


class CategorySyncLog:
    """类目同步日志模型"""

    @staticmethod
    def create(sync_type='category_tree', status='running'):
        """创建同步任务记录，返回 id"""
        return execute(
            "INSERT INTO ozon_category_sync_log (sync_type, status, created_at) VALUES (?, ?, datetime('now'))",
            (sync_type, status)
        )

    @staticmethod
    def update(log_id, status, total_count=0, duration_seconds=0, error_message=None):
        """更新同步任务状态"""
        execute(
            """UPDATE ozon_category_sync_log
               SET status = ?, total_count = ?, duration_seconds = ?,
                   error_message = ?, finished_at = datetime('now')
               WHERE id = ?""",
            (status, total_count, duration_seconds, error_message, log_id)
        )

    @staticmethod
    def get_last_success(sync_type='category_tree'):
        """获取最后一次成功同步记录"""
        return query(
            """SELECT * FROM ozon_category_sync_log
               WHERE sync_type = ? AND status = 'success'
               ORDER BY created_at DESC LIMIT 1""",
            (sync_type,), one=True
        )

    @staticmethod
    def get_last(sync_type='category_tree'):
        """获取最后一次同步记录（不论成功失败）"""
        return query(
            """SELECT * FROM ozon_category_sync_log
               WHERE sync_type = ?
               ORDER BY created_at DESC LIMIT 1""",
            (sync_type,), one=True
        )

    @staticmethod
    def get_recent(limit=10):
        """获取最近 N 条同步记录"""
        return query(
            """SELECT * FROM ozon_category_sync_log
               ORDER BY created_at DESC LIMIT ?""",
            (limit,)
        )


class CategoryAttribute:
    """类目属性模型（每个 L3 类目的特征/属性）"""

    @staticmethod
    def find_by_type_id(type_id):
        """获取某个 L3 类目的所有属性"""
        return query(
            "SELECT * FROM ozon_category_attributes WHERE type_id = ? ORDER BY is_required DESC, group_name, name",
            (type_id,)
        )

    @staticmethod
    def find_by_type_id_and_attr_id(type_id, attribute_id):
        """获取单个属性"""
        return query(
            "SELECT * FROM ozon_category_attributes WHERE type_id = ? AND attribute_id = ?",
            (type_id, attribute_id), one=True
        )

    @staticmethod
    def has_attributes(type_id):
        """检查某个类目是否已同步属性"""
        row = query(
            "SELECT COUNT(*) AS cnt FROM ozon_category_attributes WHERE type_id = ?",
            (type_id,), one=True
        )
        return (row['cnt'] if row else 0) > 0

    @staticmethod
    def count():
        """属性总数"""
        row = query("SELECT COUNT(*) AS cnt FROM ozon_category_attributes", one=True)
        return row['cnt'] if row else 0

    @staticmethod
    def count_distinct_type_ids():
        """已同步属性的类目数"""
        row = query("SELECT COUNT(DISTINCT type_id) AS cnt FROM ozon_category_attributes", one=True)
        return row['cnt'] if row else 0

    @staticmethod
    def replace_for_type_id(type_id, description_category_id, attrs):
        """全量替换某个类目的属性（先删后插）

        参数 attrs: list of dict，每个含:
            attribute_id, name, name_zh, name_ru, description, attr_type,
            is_required, is_collection, is_aspect, group_name, group_id,
            dictionary_id, max_value_count
        """
        from db import get_connection
        conn = get_connection()
        try:
            conn.execute("DELETE FROM ozon_category_attributes WHERE type_id = ?", (type_id,))
            conn.executemany(
                """INSERT OR REPLACE INTO ozon_category_attributes
                   (description_category_id, type_id, attribute_id, name, name_zh, name_ru,
                    description, attr_type, is_required, is_collection, is_aspect,
                    group_name, group_id, dictionary_id, max_value_count)
                   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
                [(
                    description_category_id,
                    type_id,
                    a.get('attribute_id'),
                    a.get('name', ''),
                    a.get('name_zh', ''),
                    a.get('name_ru', ''),
                    a.get('description', ''),
                    a.get('attr_type', 'String'),
                    1 if a.get('is_required') else 0,
                    1 if a.get('is_collection') else 0,
                    1 if a.get('is_aspect') else 0,
                    a.get('group_name', '') or '基本信息',
                    a.get('group_id', 0),
                    a.get('dictionary_id', 0),
                    a.get('max_value_count', 0),
                ) for a in attrs]
            )
            conn.commit()
        finally:
            conn.close()

    @staticmethod
    def get_attributes_with_dict(type_id):
        """获取类目属性列表，并标记哪些有字典值需要加载"""
        rows = CategoryAttribute.find_by_type_id(type_id)
        result = []
        for r in rows:
            attr = dict(r)
            # 兼容前端期望的字段名
            attr['id'] = attr['attribute_id']
            attr['type'] = _map_attr_type(attr.get('attr_type', 'String'))
            attr['ozon_type'] = attr.get('attr_type', 'String')
            attr['required'] = bool(attr.get('is_required'))
            # 有 dictionary_id 的属性无论 Ozon 类型如何，前端都应渲染为下拉选择
            # （Ozon 中 String+dictionary_id 是最常见的下拉属性，但 _map_attr_type 会返回 text）
            dict_id = attr.get('dictionary_id', 0) or 0
            if dict_id > 0:
                attr['type'] = 'select'
            result.append(attr)
        return result


def _map_attr_type(ozon_type):
    """Ozon 类型映射到前端类型

    注意：此函数只根据 Ozon 类型做基础映射。
    对于有 dictionary_id 的属性，应在调用处覆盖为 'select'。
    Boolean 类型映射为 'boolean'，由前端渲染 Yes/No 选项；
    若 Boolean 同时有 dictionary_id，则由调用处覆盖为 'select'。
    """
    type_map = {
        'String': 'text',
        'Text': 'textarea',
        'Integer': 'number',
        'Decimal': 'number',
        'Boolean': 'boolean',
        'Color': 'color',
        'URL': 'url',
    }
    return type_map.get(ozon_type, 'text')


class AttributeDictionaryValue:
    """属性字典值模型

    注意：dictionary_id 在 Ozon 中可能被多个类目共享（如"类型"属性 dictionary_id=1960
    被数百个类目使用），不同类目下同一 dictionary_id 返回不同的可选值。
    因此所有查询/写入都必须同时指定 description_category_id 和 type_id 来区分上下文。
    """

    @staticmethod
    def find_by_dictionary_id(dictionary_id, type_id=0, description_category_id=0):
        """获取某个字典在指定类目下的可选值"""
        return query(
            """SELECT * FROM ozon_attribute_dictionary_values
               WHERE dictionary_id = ? AND type_id = ? AND description_category_id = ?
               ORDER BY value""",
            (dictionary_id, type_id, description_category_id)
        )

    @staticmethod
    def has_values(dictionary_id, type_id=0, description_category_id=0):
        """检查某个字典在指定类目下是否已同步"""
        row = query(
            """SELECT COUNT(*) AS cnt FROM ozon_attribute_dictionary_values
               WHERE dictionary_id = ? AND type_id = ? AND description_category_id = ?""",
            (dictionary_id, type_id, description_category_id), one=True
        )
        return (row['cnt'] if row else 0) > 0

    @staticmethod
    def count():
        """字典值总数"""
        row = query("SELECT COUNT(*) AS cnt FROM ozon_attribute_dictionary_values", one=True)
        return row['cnt'] if row else 0

    @staticmethod
    def replace_for_dictionary(dictionary_id, attribute_id, values, type_id=0, description_category_id=0):
        """全量替换某个字典在指定类目下的值

        参数 values: list of dict，每个含:
            value_id, value, value_zh, value_ru, info, picture_url
        """
        from db import get_connection
        conn = get_connection()
        try:
            # 仅删除当前类目下的字典值，避免覆盖其他类目的共享字典
            conn.execute(
                """DELETE FROM ozon_attribute_dictionary_values
                   WHERE dictionary_id = ? AND type_id = ? AND description_category_id = ?""",
                (dictionary_id, type_id, description_category_id)
            )
            conn.executemany(
                """INSERT OR REPLACE INTO ozon_attribute_dictionary_values
                   (dictionary_id, attribute_id, description_category_id, type_id,
                    value_id, value, value_zh, value_ru, info, picture_url)
                   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
                [(
                    dictionary_id,
                    attribute_id,
                    description_category_id,
                    type_id,
                    v.get('value_id'),
                    v.get('value', ''),
                    v.get('value_zh', ''),
                    v.get('value_ru', ''),
                    v.get('info', ''),
                    v.get('picture_url', ''),
                ) for v in values]
            )
            conn.commit()
        finally:
            conn.close()


class AttrSyncProgress:
    """属性同步进度模型"""

    @staticmethod
    def get():
        """获取进度记录（单行表）"""
        return query("SELECT * FROM ozon_attr_sync_progress ORDER BY id DESC LIMIT 1", one=True)

    @staticmethod
    def start(total):
        """开始同步"""
        from db import get_connection
        conn = get_connection()
        try:
            conn.execute("DELETE FROM ozon_attr_sync_progress")
            conn.execute(
                """INSERT INTO ozon_attr_sync_progress
                   (total_type_ids, synced_count, failed_count, status, started_at, updated_at)
                   VALUES (?, 0, 0, 'running', datetime('now'), datetime('now'))""",
                (total,)
            )
            conn.commit()
        finally:
            conn.close()

    @staticmethod
    def update(synced_delta=1, failed_delta=0, current_type_id=None):
        """更新进度"""
        from db import get_connection
        conn = get_connection()
        try:
            if current_type_id is not None:
                conn.execute(
                    """UPDATE ozon_attr_sync_progress
                       SET synced_count = synced_count + ?,
                           failed_count = failed_count + ?,
                           current_type_id = ?,
                           updated_at = datetime('now')""",
                    (synced_delta, failed_delta, current_type_id)
                )
            else:
                conn.execute(
                    """UPDATE ozon_attr_sync_progress
                       SET synced_count = synced_count + ?,
                           failed_count = failed_count + ?,
                           updated_at = datetime('now')""",
                    (synced_delta, failed_delta)
                )
            conn.commit()
        finally:
            conn.close()

    @staticmethod
    def finish(status='completed'):
        """完成同步"""
        execute(
            """UPDATE ozon_attr_sync_progress
               SET status = ?, finished_at = datetime('now'), updated_at = datetime('now')
               WHERE id = (SELECT MAX(id) FROM ozon_attr_sync_progress)""",
            (status,)
        )

    @staticmethod
    def is_running():
        """是否正在同步"""
        row = AttrSyncProgress.get()
        return bool(row) and row['status'] == 'running'
