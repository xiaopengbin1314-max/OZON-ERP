"""
Ozon 商品类目 API 路由
通过 Ozon Seller API 拉取真实类目树和特征（属性）
"""
from flask import Blueprint, request
from utils.response import success_response, error_response, handle_errors

category_bp = Blueprint('categories', __name__)


@category_bp.route('/categories', methods=['GET'])
@handle_errors
def get_categories():
    """获取 Ozon 真实类目树（双语：中文（俄语）格式）

    Ozon 类目树三级结构:
    - L1: description_category_id, category_name（中文（俄语））
    - L2: description_category_id, category_name（中文（俄语））
    - L3: type_id, type_name（中文（俄语）） (叶子节点，选择后用于拉取特征)
    """
    from services.ozon_api import get_category_tree_bilingual, OzonAPIError

    refresh = request.args.get('refresh', '0')

    try:
        tree = get_category_tree_bilingual(use_cache=(refresh != '1'))
        return success_response(data=tree, msg=f'从 Ozon API 拉取类目树（{len(tree)}个一级类目）')
    except OzonAPIError as e:
        return error_response(msg=str(e), code=e.status_code or 500)


# 全类目通用属性关键词
# 这些属性已作为 item 顶层字段（name/description/weight/width/height/depth/vat）提交
# 类目属性 API 返回时直接过滤掉，不拉取到前端，避免重复提交
COMMON_ATTR_IDS = {4180}
COMMON_ATTR_EXACT_NAMES = {
    '名称', 'название', 'название товара', 'name', 'title', '标题',
    '描述', 'описание', 'description',
    '增值税', 'ндс', 'vat',
}


def _filter_common_attrs(attrs):
    """过滤掉全类目通用属性（已作为 item 顶层字段提交，不需要作为 attributes 拉取）

    仅过滤明确等同于 item 顶层字段的属性。禁止使用“名称/重量/长度”等
    包含匹配，否则会误删处理器型号、商品重量、包装长度等真实类目属性。
    """
    result = []
    for a in attrs:
        name = str(a.get('name') or '').strip().lower()
        attr_id = a.get('id') or a.get('attribute_id')
        is_common = attr_id in COMMON_ATTR_IDS or name in COMMON_ATTR_EXACT_NAMES
        if not is_common:
            result.append(a)
    return result


@category_bp.route('/categories/attributes', methods=['GET'])
@handle_errors
def get_category_attributes():
    """获取类目下的特征（属性）列表

    需要传入 Ozon 的 description_category_id 和 type_id
    优先从数据库属性库读取，未同步时从 Ozon API 拉取并写入数据库
    """
    description_category_id = request.args.get('description_category_id', type=int)
    type_id = request.args.get('type_id', type=int)
    force_refresh = request.args.get('refresh', '0') == '1'

    if not description_category_id or not type_id:
        return error_response(msg='缺少 description_category_id 或 type_id 参数', code=400)

    # 1. 优先从数据库属性库读取
    if not force_refresh:
        from models.category import CategoryAttribute
        if CategoryAttribute.has_attributes(type_id):
            attrs = CategoryAttribute.get_attributes_with_dict(type_id)
            # 过滤掉全类目通用属性（已作为 item 顶层字段提交）
            attrs = _filter_common_attrs(attrs)
            # 按 group_name 分组排序，必填在前
            attrs.sort(key=lambda x: (0 if x.get('is_required') else 1, x.get('group_name', ''), x.get('name', '')))
            return success_response(data=attrs, msg=f'从属性库读取 {len(attrs)} 个特征')

    # 2. 数据库无数据，从 Ozon API 拉取并写入数据库
    from services.category_sync_service import sync_single_category_attributes
    result = sync_single_category_attributes(description_category_id, type_id, force=force_refresh)

    if not result.get('success'):
        return error_response(msg=result.get('message', '拉取属性失败'), code=500)

    # 从数据库读取刚写入的属性
    from models.category import CategoryAttribute
    attrs = CategoryAttribute.get_attributes_with_dict(type_id)
    # 过滤掉全类目通用属性（已作为 item 顶层字段提交）
    attrs = _filter_common_attrs(attrs)
    attrs.sort(key=lambda x: (0 if x.get('is_required') else 1, x.get('group_name', ''), x.get('name', '')))
    return success_response(data=attrs, msg=result.get('message', f'拉取到 {len(attrs)} 个特征'))


@category_bp.route('/categories/attribute-values', methods=['GET'])
@handle_errors
def get_attribute_values():
    """获取特征的可选值（字典值）

    优先从数据库属性库读取，未同步时启动后台同步并返回 syncing=true。
    前端收到 syncing=true 后应轮询重试（每 2 秒一次）。
    """
    description_category_id = request.args.get('description_category_id', type=int)
    type_id = request.args.get('type_id', type=int)
    attribute_id = request.args.get('attribute_id', type=int)
    force_refresh = request.args.get('refresh', '0') == '1'

    if not all([description_category_id, type_id, attribute_id]):
        return error_response(msg='缺少必要参数', code=400)

    # 查询属性的 dictionary_id
    from models.category import CategoryAttribute, AttributeDictionaryValue
    attr = CategoryAttribute.find_by_type_id_and_attr_id(type_id, attribute_id)
    dictionary_id = attr.get('dictionary_id', 0) if attr else 0

    # 1. 优先从数据库读取（有 dictionary_id 且已同步）
    if dictionary_id and not force_refresh:
        if AttributeDictionaryValue.has_values(dictionary_id, type_id, description_category_id):
            rows = AttributeDictionaryValue.find_by_dictionary_id(dictionary_id, type_id, description_category_id)
            values = [dict(r) for r in rows]
            return success_response(data=values, msg=f'从属性库读取 {len(values)} 个可选值')

    # 2. 有 dictionary_id 但未同步 → 异步后台同步，立即返回 syncing
    if dictionary_id:
        sync_key = f'{type_id}_{attribute_id}'
        if not is_attr_values_syncing(sync_key):
            start_attr_values_sync(
                sync_key,
                description_category_id, type_id, attribute_id, dictionary_id, force_refresh
            )
        # 返回 syncing 状态，前端轮询重试
        return success_response(data=[], msg='字典值同步中，请稍后重试', syncing=True)

    # 3. 无 dictionary_id，直接从 Ozon API 拉取（不缓存，仍可能慢）
    from services.ozon_api import get_attribute_values as ozon_get_values, OzonAPIError
    try:
        result = ozon_get_values(
            description_category_id=description_category_id,
            type_id=type_id,
            attribute_id=attribute_id,
            language='ZH_HANS',
        )
        values = result.get('result', [])
        return success_response(data=values, msg=f'拉取到 {len(values)} 个可选值')
    except OzonAPIError as e:
        return error_response(msg=str(e), code=e.status_code or 500)


# ===== 属性字典值异步同步管理 =====
import threading as _threading

_attr_values_sync_lock = _threading.Lock()
_attr_values_syncing = set()  # 正在同步的属性 key集合


def is_attr_values_syncing(sync_key):
    """检查某个属性是否正在同步"""
    with _attr_values_sync_lock:
        return sync_key in _attr_values_syncing


def start_attr_values_sync(sync_key, desc_cat_id, type_id, attr_id, dict_id, force):
    """启动后台线程同步属性字典值"""
    with _attr_values_sync_lock:
        if sync_key in _attr_values_syncing:
            return  # 已在同步中
        _attr_values_syncing.add(sync_key)

    def _do_sync():
        try:
            from services.category_sync_service import sync_single_attribute_values
            sync_single_attribute_values(desc_cat_id, type_id, attr_id, dict_id, force=force)
        except Exception as e:
            print(f'[属性同步] 后台同步失败 {sync_key}: {e}')
        finally:
            with _attr_values_sync_lock:
                _attr_values_syncing.discard(sync_key)

    t = _threading.Thread(target=_do_sync, daemon=True, name=f'attr_sync_{sync_key}')
    t.start()


@category_bp.route('/categories/attribute-values/search', methods=['GET'])
@handle_errors
def search_attribute_values_endpoint():
    """搜索属性字典值（适用于品牌等大字典）

    Ozon API 的 query 参数对大字典不生效（始终返回前 N 条），
    因此改为：全量加载（24h 缓存 + 翻页）→ 本地按 query 过滤。

    查询参数: ?description_category_id=X&type_id=Y&attribute_id=Z&query=关键词&lang=ZH_HANS
    返回: { code: 200, data: [{id, value, info, picture}, ...] }
    """
    description_category_id = request.args.get('description_category_id', type=int)
    type_id = request.args.get('type_id', type=int)
    attribute_id = request.args.get('attribute_id', type=int)
    query = request.args.get('query', '').strip()
    language = request.args.get('lang', 'ZH_HANS')

    if not all([description_category_id, type_id, attribute_id]):
        return error_response(msg='缺少必要参数', code=400)

    from services.ozon_api import get_attribute_values_full, OzonAPIError
    try:
        full_result = get_attribute_values_full(
            description_category_id=description_category_id,
            type_id=type_id,
            attribute_id=attribute_id,
            language=language,
        )
        all_values = full_result.get('result', [])

        if not query:
            return success_response(data=all_values[:50], msg=f'共 {len(all_values)} 个值')

        # 本地过滤：大小写不敏感子串匹配 value 和 info 字段
        q_lower = query.lower()
        matched = [
            v for v in all_values
            if q_lower in (v.get('value', '') or '').lower()
            or q_lower in (v.get('info', '') or '').lower()
        ]
        return success_response(data=matched[:50], msg=f'搜索到 {len(matched)} 个匹配项')
    except OzonAPIError as e:
        return error_response(msg=str(e), code=e.status_code or 500)


@category_bp.route('/categories/match', methods=['POST'])
@handle_errors
def match_category_endpoint():
    """根据采集的原始分类名称，自动匹配 Ozon 类目树

    请求体: { "category": "电子 > 手机", "platform": "1688" }
    返回: { "matched": true, "description_category_id": 123, "type_id": 456, "label": "...", "confidence": "high", "candidates": [...] }

    用户需求：类目匹配不要从标题推断，必须提供 category 参数。
    """
    from services.ozon_api import match_category as do_match

    body = request.get_json(silent=True) or {}
    source_category = body.get('category', '')
    source_platform = body.get('platform', 'ozon')

    if not source_category:
        return error_response(msg='缺少 category 参数（不再从标题推断类目）', code=400)

    result = do_match(source_category, source_platform)
    return success_response(data=result, msg='匹配成功' if result.get('matched') else '未找到匹配类目')


@category_bp.route('/categories/ai-match', methods=['POST'])
@handle_errors
def ai_match_category_endpoint():
    """使用 AI 强制重新匹配类目（跳过关键词匹配和缓存）

    请求体: { "category": "男装 > T恤", "description": "商品描述" }
    返回: { "matched": true, "description_category_id": 123, "type_id": 456, "label": "...", "confidence": "high", "reason": "..." }

    用户需求：AI 匹配也不再依赖标题，必须提供 category 参数。
    """
    from services.ai_category_matcher import ai_match_category

    body = request.get_json(silent=True) or {}
    source_category = body.get('category', '')
    description = body.get('description', '')

    if not source_category:
        return error_response(msg='缺少 category 参数（不再从标题推断类目）', code=400)

    result = ai_match_category(source_category, '', description)
    return success_response(data=result, msg='AI匹配成功' if result.get('matched') else 'AI匹配未成功')


# ============================================================================
# 类目映射表管理 API
# ============================================================================

@category_bp.route('/categories/mappings', methods=['GET'])
@handle_errors
def list_mappings():
    """获取所有动态映射条目

    查询参数: ?page=1&page_size=20
    返回: { "entries": [...], "stats": {...} }
    """
    from services.category_mapping_cache import get_all_mappings, get_cache_stats

    page = int(request.args.get('page', 1))
    page_size = int(request.args.get('page_size', 50))

    entries = get_all_mappings()
    stats = get_cache_stats()

    # 分页
    start = (page - 1) * page_size
    end = start + page_size
    paged = entries[start:end]

    return success_response(data={
        'entries': paged,
        'total': len(entries),
        'page': page,
        'page_size': page_size,
        'stats': stats,
    })


@category_bp.route('/categories/mappings', methods=['POST'])
@handle_errors
def add_mapping():
    """手动添加一条映射

    请求体: {
        "source_category": "玩具/毛绒玩具",
        "title": "",
        "description_category_id": 12345,
        "type_id": 67890,
        "label": "玩具 / 毛绒玩具",
        "confidence": "high"
    }
    """
    from services.category_mapping_cache import add_manual_mapping

    body = request.get_json(silent=True) or {}
    source_category = body.get('source_category', '')
    source_platform = str(body.get('source_platform') or body.get('platform') or '1688').strip().lower()
    description_category_id = body.get('description_category_id')
    type_id = body.get('type_id')
    label = body.get('label', '')
    confidence = body.get('confidence', 'high')

    if not description_category_id or not type_id:
        return error_response(msg='缺少 description_category_id 或 type_id', code=400)

    from services.ozon_api import validate_category_pair
    pair = validate_category_pair(description_category_id, type_id)
    if not pair.get('valid'):
        return error_response(msg=pair.get('reason') or 'Ozon category pair is invalid', code=400)

    label = label or pair.get('label', '')
    key = add_manual_mapping(source_category, source_platform, description_category_id,
                             type_id, label, confidence)
    return success_response(data={'key': key}, msg='映射添加成功')


@category_bp.route('/categories/mappings', methods=['DELETE'])
@handle_errors
def delete_mapping_endpoint():
    """删除一条映射

    请求体: { "source_category": "玩具/毛绒玩具", "title": "" }
    """
    from services.category_mapping_cache import delete_mapping

    body = request.get_json(silent=True) or {}
    source_category = body.get('source_category', '')
    title = body.get('title', '')

    deleted = delete_mapping(source_category, title)
    if deleted:
        return success_response(msg='映射删除成功')
    return error_response(msg='未找到对应映射', code=404)


@category_bp.route('/categories/mappings/clear', methods=['POST'])
@handle_errors
def clear_mappings():
    """清空所有动态映射"""
    from services.category_mapping_cache import clear_all_mappings

    clear_all_mappings()
    return success_response(msg='已清空所有动态映射')


@category_bp.route('/categories/mappings/stats', methods=['GET'])
@handle_errors
def mapping_stats():
    """获取动态映射缓存统计信息"""
    from services.category_mapping_cache import get_cache_stats

    stats = get_cache_stats()
    return success_response(data=stats)


@category_bp.route('/categories/mappings/promote-candidates', methods=['GET'])
@handle_errors
def promote_candidates():
    """获取可提升为通用映射的高命中动态映射候选

    查询 category_mappings 中 hit_count 较高、匹配成功、非手动的条目，
    排除已存在于 GENERAL_MAPPINGS 的 (description_category_id, type_id) 组合，
    便于运营审核后手动加入 data/category_mapping_general.py 扩大快路径覆盖。

    Query params:
        min_hits: 最小命中次数阈值（默认 5）
        limit: 返回条数上限（默认 50）
    """
    from db import query
    from data.category_mapping_general import get_general_mappings

    min_hits = int(request.args.get('min_hits', 5))
    limit = min(int(request.args.get('limit', 50)), 200)

    # 已在通用映射表中的 (desc_cat_id, type_id) 组合，用于排除
    existing = {
        (m['description_category_id'], m['type_id'])
        for m in get_general_mappings()
    }

    rows = query(
        """SELECT source_category, title, description_category_id, type_id,
                  label, confidence, hit_count, updated_at
           FROM category_mappings
           WHERE matched = 1 AND manual = 0 AND hit_count >= ?
           ORDER BY hit_count DESC, updated_at DESC
           LIMIT ?""",
        (min_hits, limit)
    ) or []

    candidates = []
    for r in rows:
        key = (r['description_category_id'], r['type_id'])
        if key in existing:
            continue  # 已是通用映射，跳过
        candidates.append({
            'source_category': r['source_category'],
            'title': r['title'],
            'description_category_id': r['description_category_id'],
            'type_id': r['type_id'],
            'label': r['label'],
            'confidence': r['confidence'],
            'hit_count': r['hit_count'],
            'updated_at': r['updated_at'],
            # 生成可直接粘贴到 GENERAL_MAPPINGS 的代码片段
            'general_entry': {
                'source_keywords': r['title'].split()[:3] if r['title'] else [r['source_category']],
                'description_category_id': r['description_category_id'],
                'type_id': r['type_id'],
                'label': r['label'],
            },
        })

    return success_response(data={
        'candidates': candidates,
        'total': len(candidates),
        'min_hits': min_hits,
        'existing_general_count': len(existing),
    })


@category_bp.route('/categories/mappings/general', methods=['GET'])
@handle_errors
def general_mappings_info():
    """获取通用映射表信息（同义词映射 + 精确映射 + 分组）"""
    from data.category_mapping_general import (
        get_synonym_map, get_general_mappings, get_category_groups
    )

    synonym_map = get_synonym_map()
    general_mappings = get_general_mappings()
    groups = get_category_groups()

    return success_response(data={
        'synonym_count': len(synonym_map),
        'general_mappings_count': len(general_mappings),
        'general_mappings': general_mappings,
        'category_groups': groups,
        'synonym_keys': list(synonym_map.keys()),
    })


@category_bp.route('/categories/attribute-values/batch', methods=['POST'])
@handle_errors
def batch_get_attribute_values():
    """批量预加载多个属性的字典值

    请求体: { "description_category_id": 123, "type_id": 456, "attribute_ids": [1,2,3], "lang": "ZH_HANS" }
    返回: { "1": [...], "2": [...], "3": [...] }

    优先从数据库读取，未同步的属性启动后台同步并标记 syncing。
    前端收到 syncing=true 后应轮询重试。
    """
    from models.category import CategoryAttribute, AttributeDictionaryValue

    body = request.get_json(silent=True) or {}
    description_category_id = body.get('description_category_id')
    type_id = body.get('type_id')
    attribute_ids = body.get('attribute_ids', [])

    if not description_category_id or not type_id or not attribute_ids:
        return error_response(msg='缺少必要参数', code=400)

    results = {}
    pending_attrs = []  # 需要后台同步的属性

    for attr_id in attribute_ids:
        attr = CategoryAttribute.find_by_type_id_and_attr_id(type_id, attr_id)
        dictionary_id = attr.get('dictionary_id', 0) if attr else 0

        if dictionary_id and AttributeDictionaryValue.has_values(dictionary_id, type_id, description_category_id):
            # 已缓存，直接返回
            rows = AttributeDictionaryValue.find_by_dictionary_id(dictionary_id, type_id, description_category_id)
            results[str(attr_id)] = [dict(r) for r in rows]
        elif dictionary_id:
            # 未缓存，启动后台同步
            sync_key = f'{type_id}_{attr_id}'
            if not is_attr_values_syncing(sync_key):
                start_attr_values_sync(
                    sync_key, description_category_id, type_id, attr_id, dictionary_id, False
                )
            pending_attrs.append(str(attr_id))
            results[str(attr_id)] = []
        else:
            # 无 dictionary_id，跳过
            results[str(attr_id)] = []

    syncing = len(pending_attrs) > 0
    msg = f'批量读取 {len(attribute_ids)} 个属性'
    if pending_attrs:
        msg += f'，{len(pending_attrs)} 个正在同步'

    return success_response(data=results, msg=msg, syncing=syncing)


# ============================================================================
# 类目映射库同步管理 API（每月同步一次完整类目树到数据库）
# ============================================================================

@category_bp.route('/categories/sync/status', methods=['GET'])
@handle_errors
def category_sync_status():
    """获取类目映射库同步状态

    返回: {
        is_syncing, needs_sync, reason,
        last_success: { created_at, total_count, duration_seconds },
        last_sync: { created_at, status, error_message },
        category_count, l1_count, l2_count, l3_count,
        sync_interval_days
    }
    """
    from services.category_sync_service import get_sync_status
    status = get_sync_status()
    return success_response(data=status, msg='获取同步状态成功')


@category_bp.route('/categories/sync', methods=['POST'])
@handle_errors
def category_sync_trigger():
    """触发类目映射库同步（后台异步执行）

    请求体: { "force": false }  # force=true 强制同步（忽略 30 天 TTL）
    返回: { started: true, message: "后台同步任务已启动" }
    """
    from services.category_sync_service import sync_category_tree_async, is_syncing, should_sync

    if is_syncing():
        return success_response(data={'started': False, 'is_syncing': True},
                                msg='已有同步任务正在运行')

    body = request.get_json(silent=True) or {}
    force = bool(body.get('force', False))

    if not force:
        need, reason = should_sync()
        if not need:
            return success_response(data={'started': False, 'reason': reason},
                                    msg='数据已最新，无需同步')

    result = sync_category_tree_async(force=force)
    return success_response(data=result, msg='后台同步任务已启动')


@category_bp.route('/categories/sync/run', methods=['POST'])
@handle_errors
def category_sync_run():
    """同步执行类目同步（阻塞等待完成，用于手动刷新按钮）

    请求体: { "force": false }
    返回: { success, message, total_count, duration }
    """
    from services.category_sync_service import sync_category_tree, is_syncing

    if is_syncing():
        return error_response(msg='已有同步任务正在运行，请稍后', code=409)

    body = request.get_json(silent=True) or {}
    force = bool(body.get('force', False))

    result = sync_category_tree(force=force)
    if result.get('success'):
        return success_response(data=result, msg=result.get('message', '同步成功'))
    return error_response(msg=result.get('message', '同步失败'), code=500)


@category_bp.route('/categories/sync/history', methods=['GET'])
@handle_errors
def category_sync_history():
    """获取同步历史记录"""
    from models.category import CategorySyncLog

    limit = int(request.args.get('limit', 10))
    rows = CategorySyncLog.get_recent(limit=limit)
    return success_response(data=[dict(r) for r in rows], msg=f'获取 {len(rows)} 条同步记录')


@category_bp.route('/categories/search', methods=['GET'])
@handle_errors
def category_search():
    """搜索 Ozon 类目（从数据库映射库查询）

    查询参数: ?keyword=毛绒&limit=20
    返回: [ { description_category_id, type_id, category_name, level, ... } ]
    """
    from models.category import OzonCategory

    keyword = request.args.get('keyword', '').strip()
    limit = int(request.args.get('limit', 20))

    if not keyword:
        return error_response(msg='缺少 keyword 参数', code=400)

    rows = OzonCategory.search(keyword, limit=limit)
    return success_response(data=[dict(r) for r in rows], msg=f'搜索到 {len(rows)} 个类目')


# ============================================================================
# 类目属性库同步管理 API
# ============================================================================

@category_bp.route('/categories/attributes/sync/status', methods=['GET'])
@handle_errors
def attr_sync_status():
    """获取属性库同步状态

    返回: {
        is_syncing, attr_count, synced_type_count, dict_value_count,
        progress: { total, synced, failed, current, status },
        last_sync: { created_at, total_count, duration_seconds }
    }
    """
    from services.category_sync_service import get_attr_sync_status
    status = get_attr_sync_status()
    return success_response(data=status, msg='获取属性同步状态成功')


@category_bp.route('/categories/attributes/sync', methods=['POST'])
@handle_errors
def attr_sync_trigger():
    """触发后台批量同步所有类目属性（异步）

    适合首次部署时全量同步。7422 个类目，并发 3 线程，预计 1-2 小时。
    返回: { started: true, message: "后台属性同步任务已启动" }
    """
    from services.category_sync_service import sync_all_category_attributes_async, is_attr_syncing

    if is_attr_syncing():
        return success_response(data={'started': False, 'is_syncing': True},
                                msg='已有属性同步任务正在运行')

    result = sync_all_category_attributes_async()
    return success_response(data=result, msg=result.get('message', '后台属性同步任务已启动'))


@category_bp.route('/categories/attributes/sync/single', methods=['POST'])
@handle_errors
def attr_sync_single():
    """同步单个类目的属性（同步执行，用于按需同步）

    请求体: { "description_category_id": 123, "type_id": 456, "force": false }
    返回: { success, message, attr_count, from_cache }
    """
    from services.category_sync_service import sync_single_category_attributes, is_attr_syncing

    body = request.get_json(silent=True) or {}
    desc_cat_id = body.get('description_category_id')
    type_id = body.get('type_id')
    force = bool(body.get('force', False))

    if not desc_cat_id or not type_id:
        return error_response(msg='缺少 description_category_id 或 type_id', code=400)

    result = sync_single_category_attributes(desc_cat_id, type_id, force=force)
    if result.get('success'):
        return success_response(data=result, msg=result.get('message'))
    return error_response(msg=result.get('message', '同步失败'), code=500)
