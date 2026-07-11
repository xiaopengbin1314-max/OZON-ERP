"""Ozon 类目动态映射表缓存管理（数据库版本）

动态映射表用于缓存 match_category 的匹配结果，避免重复计算。
当相同的源分类/标题再次匹配时，直接从缓存读取，大幅提升性能。

存储方式: SQLite 数据库 category_mappings 表（替代原 JSON 文件）

缓存策略:
- TTL: 30天（2592000秒）
- 最大条目数: 2000（超出时按 hit_count 升序淘汰）
- Key: source_category + title 的哈希（md5前16位）
"""

import time
import hashlib

# 缓存配置
_CACHE_TTL = 30 * 24 * 3600  # 30天
_MAX_ENTRIES = 2000


def _generate_key(source_category, title=''):
    """生成缓存键（source_category + title 的 md5 哈希前16位）"""
    raw = f"{source_category or ''}||{title or ''}"
    return hashlib.md5(raw.encode('utf-8')).hexdigest()[:16]


def _evict_if_needed():
    """如果超过最大条目数，淘汰最少使用的条目"""
    from db import get_connection
    conn = get_connection()
    try:
        cnt_row = conn.execute("SELECT COUNT(*) AS cnt FROM category_mappings").fetchone()
        total = cnt_row['cnt'] if cnt_row else 0
        if total <= _MAX_ENTRIES:
            return
        evict_count = total - _MAX_ENTRIES
        # 按 hit_count 升序删除最少使用的
        conn.execute(
            """DELETE FROM category_mappings
               WHERE id IN (
                   SELECT id FROM category_mappings
                   ORDER BY hit_count ASC, updated_at ASC
                   LIMIT ?
               )""",
            (evict_count,)
        )
        conn.commit()
    finally:
        conn.close()


def get_mapping(source_category, title=''):
    """从动态缓存中查询映射结果

    Args:
        source_category: 源分类路径
        title: 商品标题（可选）

    Returns:
        dict: 匹配结果（含 description_category_id, type_id, label, confidence），
              未命中返回 None
    """
    from models.category import CategoryMapping

    key = _generate_key(source_category, title)
    entry = CategoryMapping.find_by_key(key)
    if not entry:
        return None

    # 检查 TTL（按 updated_at 判断）
    updated_at_str = entry.get('updated_at', '')
    try:
        from datetime import datetime
        updated_time = datetime.strptime(updated_at_str, '%Y-%m-%d %H:%M:%S')
        if (datetime.now() - updated_time).total_seconds() > _CACHE_TTL:
            # 过期，删除
            CategoryMapping.delete_by_key(key)
            return None
    except (ValueError, TypeError):
        pass  # 时间解析失败，不删除

    # 仅返回已匹配的缓存
    if not entry.get('matched'):
        return None

    # 更新命中次数
    CategoryMapping.increment_hit_count(key)

    return {
        'description_category_id': entry.get('description_category_id'),
        'type_id': entry.get('type_id'),
        'label': entry.get('label', ''),
        'confidence': entry.get('confidence', 'medium'),
        'matched': True,
        'candidates': [],
        '_from_cache': True,
    }


def set_mapping(source_category, title, result):
    """保存映射结果到动态缓存

    Args:
        source_category: 源分类路径
        title: 商品标题
        result: match_category 的返回结果（需含 matched=True）
    """
    if not result or not result.get('matched'):
        return

    from models.category import CategoryMapping

    key = _generate_key(source_category, title)
    CategoryMapping.upsert(
        cache_key=key,
        source_category=source_category or '',
        title=title or '',
        description_category_id=result.get('description_category_id'),
        type_id=result.get('type_id'),
        label=result.get('label', ''),
        confidence=result.get('confidence', 'medium'),
        matched=True,
        manual=0,
    )
    _evict_if_needed()


def get_all_mappings():
    """获取所有动态映射条目（用于管理界面展示）"""
    from models.category import CategoryMapping
    rows = CategoryMapping.find_all(limit=500, offset=0)
    # 转换为与原 JSON 格式兼容的字典列表
    entries = []
    for row in rows:
        entries.append({
            'cache_key': row.get('cache_key'),
            'source_category': row.get('source_category', ''),
            'title': row.get('title', ''),
            'description_category_id': row.get('description_category_id'),
            'type_id': row.get('type_id'),
            'label': row.get('label', ''),
            'confidence': row.get('confidence', 'medium'),
            'matched': bool(row.get('matched')),
            'manual': bool(row.get('manual')),
            'hit_count': row.get('hit_count', 0),
            'created_at': row.get('created_at'),
            'updated_at': row.get('updated_at'),
        })
    return entries


def delete_mapping(source_category, title=''):
    """删除指定的动态映射条目"""
    from models.category import CategoryMapping
    return CategoryMapping.delete_by_source(source_category, title)


def clear_all_mappings():
    """清空所有动态映射"""
    from models.category import CategoryMapping
    CategoryMapping.clear_all()


def get_cache_stats():
    """获取缓存统计信息"""
    from models.category import CategoryMapping
    stats = CategoryMapping.get_stats()
    return {
        'total_entries': stats['total_entries'],
        'expired_entries': 0,  # 数据库版本不再有过期条目概念（查询时即时清理）
        'matched_entries': stats['matched_entries'],
        'manual_entries': stats['manual_entries'],
        'total_hits': stats['total_hits'],
        'cache_file': '(SQLite: category_mappings)',
        'ttl_days': _CACHE_TTL // (24 * 3600),
        'max_entries': _MAX_ENTRIES,
    }


def add_manual_mapping(source_category, title, description_category_id, type_id, label, confidence='high'):
    """手动添加一条映射（用于管理界面）"""
    from models.category import CategoryMapping

    key = _generate_key(source_category, title)
    CategoryMapping.upsert(
        cache_key=key,
        source_category=source_category or '',
        title=title or '',
        description_category_id=description_category_id,
        type_id=type_id,
        label=label,
        confidence=confidence,
        matched=True,
        manual=1,
    )
    return key
