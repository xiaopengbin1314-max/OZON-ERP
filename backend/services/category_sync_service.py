"""
Ozon 类目树数据库同步服务
- 启动时检查是否需要同步（30 天 TTL）
- 后台线程从 Ozon API 拉取完整类目树写入数据库
- 支持手动触发同步
"""
import os
import time
import threading
import datetime

# 同步间隔（30 天）
SYNC_INTERVAL_DAYS = 30

# 同步锁（防止并发同步）
_sync_lock = threading.Lock()
_sync_running = False


def _set_running(flag):
    """设置同步状态（线程安全）"""
    global _sync_running
    _sync_running = flag


def is_syncing():
    """是否正在同步中"""
    return _sync_running


def should_sync():
    """检查是否需要同步

    规则：
    1. 数据库无类目数据 → 需要同步
    2. 最后一次成功同步超过 30 天 → 需要同步
    3. 最后一次同步状态为 failed → 需要重试
    """
    from models.category import OzonCategory, CategorySyncLog

    # 数据库无数据
    if OzonCategory.count() == 0:
        return True, '数据库为空，需要首次同步'

    # 检查最后一次同步
    last = CategorySyncLog.get_last_success()
    if not last:
        return True, '从未成功同步过'

    # 检查是否超过 30 天
    try:
        last_time = datetime.datetime.strptime(last['created_at'], '%Y-%m-%d %H:%M:%S')
        days_passed = (datetime.datetime.now() - last_time).days
        if days_passed >= SYNC_INTERVAL_DAYS:
            return True, f'距上次同步已 {days_passed} 天，超过 {SYNC_INTERVAL_DAYS} 天阈值'
    except (ValueError, TypeError):
        return True, '无法解析上次同步时间'

    return False, f'数据最新（上次同步: {last["created_at"]}）'


def sync_category_tree(force=False):
    """同步 Ozon 类目树到数据库

    流程：
    1. 检查是否正在同步（防止重复）
    2. 创建同步日志（status=running）
    3. 调用 Ozon API 拉取双语类目树
    4. 扁平化并写入 ozon_categories 表（全量替换）
    5. 更新同步日志（status=success/failed）

    参数:
        force: 是否强制同步（忽略 TTL 检查）

    返回:
        dict: { success, message, total_count, duration }
    """
    if not _sync_lock.acquire(blocking=False):
        return {'success': False, 'message': '已有同步任务正在运行', 'total_count': 0, 'duration': 0}

    _set_running(True)
    start_time = time.time()

    from models.category import OzonCategory, CategorySyncLog

    # 创建同步日志
    log_id = CategorySyncLog.create(sync_type='category_tree', status='running')

    try:
        # 检查是否需要同步
        if not force:
            need, reason = should_sync()
            if not need:
                CategorySyncLog.update(log_id, status='success',
                                       total_count=OzonCategory.count(),
                                       duration_seconds=0,
                                       error_message='跳过（数据已最新）')
                return {'success': True, 'message': reason, 'total_count': OzonCategory.count(), 'duration': 0}

        print('[类目同步] 开始从 Ozon API 拉取完整类目树...')

        # 拉取双语类目树（绕过缓存，从 Ozon API 直接拉取）
        from services.ozon_api import get_category_tree_bilingual
        tree = get_category_tree_bilingual(use_cache=False)

        if not tree:
            raise Exception('Ozon API 返回空类目树')

        # 扁平化类目树（保留层级关系，记录 parent_id 本表 id）
        flat_rows = []

        def _flatten(nodes, parent_id=None, level=1):
            for node in nodes:
                # L3 叶子节点用 type_name 系列字段，L1/L2 用 category_name 系列字段
                if level == 3:
                    row = {
                        'level': level,
                        'parent_id': parent_id,
                        'category_name': node.get('type_name', ''),
                        'category_name_zh': node.get('type_name_zh', ''),
                        'category_name_ru': node.get('type_name_ru', ''),
                        'disabled': 1 if node.get('disabled') else 0,
                        'description_category_id': None,
                        'type_id': node.get('type_id'),
                    }
                else:
                    row = {
                        'level': level,
                        'parent_id': parent_id,
                        'category_name': node.get('category_name', ''),
                        'category_name_zh': node.get('category_name_zh', ''),
                        'category_name_ru': node.get('category_name_ru', ''),
                        'disabled': 1 if node.get('disabled') else 0,
                        'description_category_id': node.get('description_category_id'),
                        'type_id': None,
                    }
                flat_rows.append(row)
                children = node.get('children', [])
                if children:
                    _flatten(children, parent_id=None, level=level + 1)

        _flatten(tree, parent_id=None, level=1)

        # 由于 parent_id 需要本表 id，分两阶段插入：
        # 阶段1: 按 level 顺序插入，记录 Ozon ID → 本表 id 的映射
        # 阶段2: 用映射表更新 parent_id
        from db import get_connection
        conn = get_connection()
        try:
            conn.execute("DELETE FROM ozon_categories")

            # 按 level 升序插入（L1 → L2 → L3）
            flat_rows.sort(key=lambda r: r['level'])

            # 记录 Ozon ID → 本表 id 的映射
            # L1/L2 用 description_category_id，L3 用 type_id
            id_map = {}  # (level, ozon_id) → 本表 id

            for row in flat_rows:
                cursor = conn.execute(
                    """INSERT INTO ozon_categories
                       (description_category_id, type_id, parent_id, level,
                        category_name, category_name_zh, category_name_ru, disabled)
                       VALUES (?, ?, ?, ?, ?, ?, ?, ?)""",
                    (
                        row.get('description_category_id'),
                        row.get('type_id'),
                        None,  # parent_id 稍后更新
                        row['level'],
                        row['category_name'],
                        row['category_name_zh'],
                        row['category_name_ru'],
                        row['disabled'],
                    )
                )
                this_id = cursor.lastrowid
                if row['level'] < 3:
                    ozon_id = row.get('description_category_id')
                    if ozon_id:
                        id_map[(row['level'], ozon_id)] = this_id
                else:
                    ozon_id = row.get('type_id')
                    if ozon_id:
                        id_map[(row['level'], ozon_id)] = this_id

            # 由于扁平化时丢失了 parent 的 Ozon ID，需要重新遍历原始树来建立映射
            # 重新遍历，构建 (level, ozon_id) → parent 本表 id 的映射
            parent_map = {}  # (level, ozon_id) → parent 本表 id

            def _build_parent_map(nodes, parent_table_id=None, parent_level=0, level=1):
                for node in nodes:
                    if level < 3:
                        ozon_id = node.get('description_category_id')
                    else:
                        ozon_id = node.get('type_id')
                    if ozon_id:
                        this_table_id = id_map.get((level, ozon_id))
                        if this_table_id and parent_table_id:
                            parent_map[this_table_id] = parent_table_id
                        children = node.get('children', [])
                        if children:
                            _build_parent_map(children, parent_table_id=this_table_id,
                                              parent_level=level, level=level + 1)

            _build_parent_map(tree, parent_table_id=None, parent_level=0, level=1)

            # 批量更新 parent_id
            for child_id, parent_id in parent_map.items():
                conn.execute(
                    "UPDATE ozon_categories SET parent_id = ? WHERE id = ?",
                    (parent_id, child_id)
                )

            conn.commit()
            total = len(flat_rows)
        finally:
            conn.close()

        duration = round(time.time() - start_time, 2)
        print(f'[类目同步] 同步完成: 共 {total} 个类目，耗时 {duration}s')

        CategorySyncLog.update(log_id, status='success', total_count=total,
                               duration_seconds=duration, error_message=None)

        return {
            'success': True,
            'message': f'同步成功，共 {total} 个类目',
            'total_count': total,
            'duration': duration,
        }

    except Exception as e:
        duration = round(time.time() - start_time, 2)
        error_msg = str(e)
        print(f'[类目同步] 同步失败: {error_msg} (耗时 {duration}s)')

        CategorySyncLog.update(log_id, status='failed', total_count=0,
                               duration_seconds=duration, error_message=error_msg)

        return {
            'success': False,
            'message': f'同步失败: {error_msg}',
            'total_count': 0,
            'duration': duration,
        }
    finally:
        _set_running(False)
        _sync_lock.release()


def sync_category_tree_async(force=False):
    """异步同步（后台线程执行，立即返回）"""
    thread = threading.Thread(
        target=sync_category_tree,
        kwargs={'force': force},
        name='ozon-category-sync',
        daemon=True
    )
    thread.start()
    return {'success': True, 'message': '后台同步任务已启动'}


def get_sync_status():
    """获取同步状态

    返回:
        dict: {
            is_syncing,         # 是否正在同步
            needs_sync,         # 是否需要同步
            reason,             # 原因说明
            last_success,       # 上次成功同步信息
            last_sync,          # 上次同步信息（不论成功失败）
            category_count,     # 数据库类目总数
            sync_interval_days, # 同步间隔天数
        }
    """
    from models.category import OzonCategory, CategorySyncLog

    need, reason = should_sync()
    last_success = CategorySyncLog.get_last_success()
    last_sync = CategorySyncLog.get_last()
    category_count = OzonCategory.count()

    return {
        'is_syncing': is_syncing(),
        'needs_sync': need,
        'reason': reason,
        'last_success': dict(last_success) if last_success else None,
        'last_sync': dict(last_sync) if last_sync else None,
        'category_count': category_count,
        'l1_count': OzonCategory.count_by_level(1),
        'l2_count': OzonCategory.count_by_level(2),
        'l3_count': OzonCategory.count_by_level(3),
        'sync_interval_days': SYNC_INTERVAL_DAYS,
    }


def init_sync_on_startup():
    """启动时初始化：检查并触发后台同步（如果需要）

    应在 Flask create_app 中调用
    """
    try:
        need, reason = should_sync()
        if need:
            print(f'[类目同步] 启动检查: {reason}，触发后台同步...')
            sync_category_tree_async(force=False)
        else:
            print(f'[类目同步] 启动检查: {reason}')
    except Exception as e:
        print(f'[类目同步] 启动检查异常: {e}')


# ============================================================================
# 类目属性同步（按需 + 批量）
# ============================================================================

# 属性同步锁
_attr_sync_lock = threading.Lock()
_attr_sync_running = False

# 批量同步的并发数（避免 Ozon 限流）
ATTR_SYNC_MAX_WORKERS = 3


def _set_attr_sync_running(flag):
    global _attr_sync_running
    _attr_sync_running = flag


def is_attr_syncing():
    """属性是否正在批量同步"""
    return _attr_sync_running


def sync_single_category_attributes(description_category_id, type_id, force=False):
    """同步单个类目的属性到数据库（按需同步）

    流程：
    1. 检查数据库是否已有该类目属性（非 force 时跳过）
    2. 调用 Ozon API 拉取中文和俄语属性
    3. 合并名称，写入 ozon_category_attributes 表

    返回:
        dict: { success, message, attr_count, from_cache }
    """
    from models.category import CategoryAttribute

    # 一次读取同时完成存在性检查，避免 COUNT + SELECT 两次查询。
    if not force:
        cached_attrs = CategoryAttribute.find_by_category(description_category_id, type_id)
        if cached_attrs:
            return {
                'success': True,
                'message': '属性已存在（从数据库读取）',
                'attr_count': len(cached_attrs),
                'from_cache': True,
            }

    try:
        from services.ozon_api import get_category_attributes as ozon_get_attrs

        # 拉取中文和俄语属性
        result_zh = ozon_get_attrs(
            description_category_id=description_category_id,
            type_id=type_id,
            language='ZH_HANS',
            refresh=force,
        )
        result_ru = ozon_get_attrs(
            description_category_id=description_category_id,
            type_id=type_id,
            language='DEFAULT',
            refresh=force,
        )

        raw_attrs_zh = result_zh.get('result', []) if result_zh else []
        raw_attrs_ru = result_ru.get('result', []) if result_ru else []

        if not raw_attrs_zh and not raw_attrs_ru:
            return {
                'success': False,
                'message': 'Ozon 未返回任何类目属性，已保留本地属性库',
                'attr_count': 0,
                'from_cache': False,
            }

        zh_by_id = {a.get('id'): a for a in raw_attrs_zh if a.get('id') is not None}
        ru_by_id = {a.get('id'): a for a in raw_attrs_ru if a.get('id') is not None}
        attribute_ids = list(zh_by_id)
        attribute_ids.extend(attr_id for attr_id in ru_by_id if attr_id not in zh_by_id)

        # 按属性 ID 合并两种语言，避免某个语言端点暂时缺项造成特征丢失。
        attrs = []
        for attr_id in attribute_ids:
            zh_attr = zh_by_id.get(attr_id, {})
            ru_attr = ru_by_id.get(attr_id, {})
            source_attr = zh_attr or ru_attr
            zh_name = zh_attr.get('name', '')
            ru_name = ru_attr.get('name', '')
            if zh_name and ru_name and ru_name != zh_name:
                merged_name = f'{zh_name}（{ru_name}）'
            else:
                merged_name = zh_name or ru_name

            attrs.append({
                'attribute_id': attr_id,
                'name': merged_name,
                'name_zh': zh_name,
                'name_ru': ru_name,
                'description': zh_attr.get('description') or ru_attr.get('description') or '',
                'attr_type': source_attr.get('type', 'String'),
                'is_required': source_attr.get('is_required', False),
                'is_collection': source_attr.get('is_collection', False),
                'is_aspect': source_attr.get('is_aspect', False),
                'group_name': source_attr.get('group_name', '') or '基本信息',
                'group_id': source_attr.get('group_id', 0),
                'dictionary_id': source_attr.get('dictionary_id', 0),
                'max_value_count': source_attr.get('max_value_count', 0),
            })

        # 写入数据库
        CategoryAttribute.replace_for_category(description_category_id, type_id, attrs)

        return {
            'success': True,
            'message': f'同步成功，共 {len(attrs)} 个属性',
            'attr_count': len(attrs),
            'from_cache': False,
        }

    except Exception as e:
        return {
            'success': False,
            'message': f'同步失败: {e}',
            'attr_count': 0,
            'from_cache': False,
        }


def sync_single_attribute_values(description_category_id, type_id, attribute_id, dictionary_id, force=False):
    """同步单个属性字典的值到数据库（按需同步）

    返回:
        dict: { success, message, value_count, from_cache }
    """
    from models.category import AttributeDictionaryValue

    if not dictionary_id:
        return {'success': False, 'message': '无 dictionary_id', 'value_count': 0, 'from_cache': False}

    # 检查是否已同步（按类目上下文检查，避免共享字典污染）
    if not force:
        cached_values = AttributeDictionaryValue.find_by_dictionary_id(
            dictionary_id, type_id, description_category_id
        )
        if cached_values:
            return {
                'success': True,
                'message': '字典值已存在（从数据库读取）',
                'value_count': len(cached_values),
                'from_cache': True,
            }

    try:
        from services.ozon_api import get_attribute_values_full

        # 拉取中文和俄语字典值
        result_zh = get_attribute_values_full(
            description_category_id=description_category_id,
            type_id=type_id,
            attribute_id=attribute_id,
            language='ZH_HANS',
        )
        result_ru = get_attribute_values_full(
            description_category_id=description_category_id,
            type_id=type_id,
            attribute_id=attribute_id,
            language='DEFAULT',
        )

        vals_zh = result_zh.get('result', []) if result_zh else []
        vals_ru = result_ru.get('result', []) if result_ru else []

        # 构建俄语值映射
        ru_val_map = {v.get('id'): v for v in vals_ru}

        # 合并字典值
        values = []
        for v in vals_zh:
            val_id = v.get('id')
            zh_val = v.get('value', '')
            ru_v = ru_val_map.get(val_id, {})
            ru_val = ru_v.get('value', '')
            merged_val = f'{zh_val}（{ru_val}）' if ru_val and ru_val != zh_val else zh_val

            values.append({
                'value_id': val_id,
                'value': merged_val,
                'value_zh': zh_val,
                'value_ru': ru_val,
                'info': v.get('info', '') or '',
                'picture_url': v.get('picture', '') or '',
            })

        # 写入数据库（按类目上下文存储，避免共享字典污染）
        AttributeDictionaryValue.replace_for_dictionary(
            dictionary_id, attribute_id, values,
            type_id=type_id, description_category_id=description_category_id
        )

        return {
            'success': True,
            'message': f'同步成功，共 {len(values)} 个字典值',
            'value_count': len(values),
            'from_cache': False,
        }

    except Exception as e:
        return {
            'success': False,
            'message': f'同步失败: {e}',
            'value_count': 0,
            'from_cache': False,
        }


def sync_all_category_attributes_async():
    """异步批量同步所有 L3 类目的属性（后台线程）

    适合首次部署时全量同步。7422 个类目，并发 3 线程，预计 1-2 小时。
    """
    if not _attr_sync_lock.acquire(blocking=False):
        return {'success': False, 'message': '已有属性同步任务正在运行'}

    thread = threading.Thread(
        target=_sync_all_attributes_worker,
        name='ozon-attr-sync',
        daemon=True
    )
    thread.start()
    return {'success': True, 'message': '后台属性同步任务已启动'}


def _sync_all_attributes_worker():
    """批量同步所有属性的工作线程"""
    _set_attr_sync_running(True)
    start_time = time.time()

    from models.category import OzonCategory, CategoryAttribute, AttrSyncProgress, CategorySyncLog

    # 创建同步日志
    log_id = CategorySyncLog.create(sync_type='attributes', status='running')

    try:
        # 获取所有 L3 类目
        l3_categories = query_l3_categories()
        total = len(l3_categories)

        print(f'[属性同步] 开始批量同步 {total} 个类目的属性...')
        AttrSyncProgress.start(total)

        from concurrent.futures import ThreadPoolExecutor, as_completed

        synced = 0
        failed = 0

        # 并发同步（max_workers=3，避免 Ozon 限流）
        with ThreadPoolExecutor(max_workers=ATTR_SYNC_MAX_WORKERS) as executor:
            futures = {}
            for cat in l3_categories:
                type_id = cat['type_id']
                desc_cat_id = cat['description_category_id']
                future = executor.submit(
                    sync_single_category_attributes, desc_cat_id, type_id, force=True
                )
                futures[future] = (type_id, desc_cat_id)

            for future in as_completed(futures):
                type_id, desc_cat_id = futures[future]
                try:
                    result = future.result()
                    if result.get('success'):
                        synced += 1
                    else:
                        failed += 1
                        print(f'[属性同步] type_id={type_id} 失败: {result.get("message")}')
                except Exception as e:
                    failed += 1
                    print(f'[属性同步] type_id={type_id} 异常: {e}')

                # 更新进度
                AttrSyncProgress.update(
                    synced_delta=1 if future.result().get('success') else 0,
                    failed_delta=0 if future.result().get('success') else 1,
                    current_type_id=type_id,
                )

                # 每 100 个打印一次进度
                if (synced + failed) % 100 == 0:
                    print(f'[属性同步] 进度: {synced + failed}/{total} (成功 {synced}, 失败 {failed})')

        duration = round(time.time() - start_time, 2)
        AttrSyncProgress.finish(status='completed')

        print(f'[属性同步] 全量同步完成: 共 {total} 个类目，成功 {synced}，失败 {failed}，耗时 {duration}s')

        CategorySyncLog.update(log_id, status='success',
                               total_count=synced,
                               duration_seconds=duration,
                               error_message=f'失败 {failed} 个' if failed else None)

    except Exception as e:
        duration = round(time.time() - start_time, 2)
        AttrSyncProgress.finish(status='failed')
        CategorySyncLog.update(log_id, status='failed',
                               total_count=0,
                               duration_seconds=duration,
                               error_message=str(e))
        print(f'[属性同步] 同步失败: {e} (耗时 {duration}s)')
    finally:
        _set_attr_sync_running(False)
        _attr_sync_lock.release()


def query_l3_categories():
    """获取所有 L3 类目及其 description_category_id（来自父节点）

    返回: [ { type_id, description_category_id, category_name } ]
    """
    from db import query
    # L3 的 description_category_id 来自其父节点（L2）
    return query(
        """SELECT
               l3.type_id,
               l2.description_category_id,
               l3.category_name
           FROM ozon_categories l3
           JOIN ozon_categories l2 ON l3.parent_id = l2.id
           WHERE l3.level = 3
           ORDER BY l3.id"""
    )


def get_attr_sync_status():
    """获取属性同步状态"""
    from models.category import CategoryAttribute, AttributeDictionaryValue, AttrSyncProgress, CategorySyncLog

    progress = AttrSyncProgress.get()
    last_sync = CategorySyncLog.get_last_success('attributes')

    return {
        'is_syncing': is_attr_syncing(),
        'attr_count': CategoryAttribute.count(),
        'synced_type_count': CategoryAttribute.count_distinct_type_ids(),
        'dict_value_count': AttributeDictionaryValue.count(),
        'progress': dict(progress) if progress else None,
        'last_sync': dict(last_sync) if last_sync else None,
    }
