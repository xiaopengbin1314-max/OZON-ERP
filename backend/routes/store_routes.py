"""
店铺管理 API 路由
提供店铺的增删改查、批量操作、授权管理等接口
"""
from flask import Blueprint, request
from models.account import Store
from db import get_connection
from utils.response import success_response, error_response, paginate_response, handle_errors
from utils.validators import extract_pagination

store_bp = Blueprint('store', __name__)


def _mask_store_for_response(store):
    """掩码店铺的 api_key，避免明文泄露给前端

    返回是否已设置（hasApiKey）而非真实密钥。
    """
    if not store:
        return store
    api_key = store.get('api_key')
    store['hasApiKey'] = bool(api_key)
    store['apiKey'] = '******' if api_key else ''
    store.pop('api_key', None)
    return store


@store_bp.route('/stores', methods=['GET'])
@handle_errors
def get_stores():
    """获取店铺列表，支持筛选和搜索"""
    auth_status = request.args.get('authStatus', '')
    store_group = request.args.get('group', '')
    keyword = request.args.get('keyword', '')
    notify = request.args.get('notify', '')
    account_id = request.args.get('accountId', '')

    # 通知推送筛选
    stores = Store.find_all(
        account_id=int(account_id) if account_id else None,
        auth_status=auth_status or None,
        store_group=store_group or None,
        keyword=keyword or None,
    )

    # 通知推送是内存筛选（SQLite 中存为 0/1）
    if notify == 'on':
        stores = [s for s in stores if s.get('notify_on') == 1]
    elif notify == 'off':
        stores = [s for s in stores if s.get('notify_on') == 0]

    # 格式化输出：将 notify_on 转为布尔，添加前端需要的字段名
    for s in stores:
        s['notifyOn'] = bool(s.pop('notify_on', 0))
        s['storeGroup'] = s.pop('store_group', '')
        s['authType'] = 'API授权' if s.pop('auth_type', 'api') == 'api' else 'Cookie授权'
        s['authStatus'] = s.pop('auth_status', 'pending')
        s['authTime'] = s.pop('auth_time', '')
        s['todayLimit'] = s.pop('today_limit', 0)
        s['accountId'] = s.pop('account_id', None)
        _mask_store_for_response(s)

    return success_response(data={
        "list": stores,
        "total": len(stores),
    })


@store_bp.route('/stores', methods=['POST'])
@handle_errors
def create_store():
    """添加店铺（授权绑定）"""
    data = request.get_json() or {}

    store_id = data.get('storeId', '').strip()
    alias = data.get('alias', '').strip()
    currency = data.get('currency', 'RUB')
    store_group = data.get('group', '默认')
    notify_on = data.get('notifyOn', True)
    auth_type = data.get('authType', 'api')
    client_id = data.get('clientId', '').strip()
    api_key = data.get('apiKey', '').strip()
    auth_status = data.get('authStatus', 'pending')
    account_id = data.get('accountId')

    # 校验必填字段
    if not store_id:
        return error_response("店铺ID不能为空")
    if not alias:
        return error_response("店铺别名不能为空")

    # 检查店铺ID是否已存在
    existing = Store.find_by_store_id(store_id)
    if existing:
        return error_response(f"店铺ID {store_id} 已存在")

    store = Store.create(
        store_id=store_id,
        alias=alias,
        currency=currency,
        store_group=store_group,
        notify_on=notify_on,
        auth_type='api' if auth_type in ('api', 'API授权') else 'cookie',
        client_id=client_id or None,
        api_key=api_key or None,
        auth_status=auth_status,
        account_id=int(account_id) if account_id else None,
    )

    return success_response(data=_mask_store_for_response(store), msg="店铺添加成功")


@store_bp.route('/stores/<int:store_pk>', methods=['PUT'])
@handle_errors
def update_store(store_pk):
    """更新店铺信息"""
    data = request.get_json() or {}

    existing = Store.find_by_id(store_pk)
    if not existing:
        return error_response("店铺不存在", 404)

    # 映射前端字段名到数据库字段名
    field_map = {
        'alias': 'alias',
        'currency': 'currency',
        'group': 'store_group',
        'notifyOn': 'notify_on',
        'authType': 'auth_type',
        'clientId': 'client_id',
        'apiKey': 'api_key',
        'authStatus': 'auth_status',
        'authTime': 'auth_time',
        'todayLimit': 'today_limit',
    }

    update_data = {}
    for front_key, db_key in field_map.items():
        if front_key in data:
            val = data[front_key]
            # 特殊转换
            if db_key == 'notify_on':
                val = 1 if val else 0
            elif db_key == 'auth_type':
                val = 'api' if val in ('api', 'API授权') else 'cookie'
            elif db_key == 'api_key':
                # 掩码占位符或空值表示不修改密钥
                if not val or val == '******':
                    continue
            update_data[db_key] = val

    result = Store.update(store_pk, **update_data)
    if result is None:
        return error_response("更新失败")

    return success_response(data=_mask_store_for_response(result), msg="更新成功")


@store_bp.route('/stores/<int:store_pk>', methods=['DELETE'])
@handle_errors
def delete_store(store_pk):
    """删除店铺"""
    existing = Store.find_by_id(store_pk)
    if not existing:
        return error_response("店铺不存在", 404)

    Store.delete(store_pk)
    return success_response(msg="删除成功")


@store_bp.route('/stores/batch/group', methods=['PUT'])
@handle_errors
def batch_set_group():
    """批量设置分组"""
    data = request.get_json() or {}
    ids = data.get('ids', [])
    group = data.get('group', '')

    if not ids:
        return error_response("请选择店铺")
    if not group:
        return error_response("请指定分组")

    Store.batch_update_group(ids, group)
    return success_response(msg=f"已将 {len(ids)} 个店铺移至「{group}」")


@store_bp.route('/stores/batch/currency', methods=['PUT'])
@handle_errors
def batch_set_currency():
    """批量设置币种"""
    data = request.get_json() or {}
    ids = data.get('ids', [])
    currency = data.get('currency', '')

    if not ids:
        return error_response("请选择店铺")
    if not currency:
        return error_response("请指定币种")

    Store.batch_update_currency(ids, currency)
    return success_response(msg=f"已将 {len(ids)} 个店铺币种设置为「{currency}」")


@store_bp.route('/stores/batch/delete', methods=['POST'])
@handle_errors
def batch_delete_stores():
    """批量删除店铺"""
    data = request.get_json() or {}
    ids = data.get('ids', [])

    if not ids:
        return error_response("请选择店铺")

    Store.batch_delete(ids)
    return success_response(msg=f"已删除 {len(ids)} 个店铺")


@store_bp.route('/stores/<int:store_pk>/refresh-auth', methods=['POST'])
@handle_errors
def refresh_auth(store_pk):
    """更新店铺授权（刷新授权时间）"""
    from datetime import datetime

    existing = Store.find_by_id(store_pk)
    if not existing:
        return error_response("店铺不存在", 404)

    now = datetime.now().strftime('%Y-%m-%d %H:%M:%S')
    Store.update(store_pk, auth_time=now, auth_status='active')
    return success_response(msg="授权更新成功")


@store_bp.route('/stores/groups', methods=['GET'])
@handle_errors
def get_groups():
    """获取所有分组列表"""
    groups = Store.get_groups()
    return success_response(data=groups)


# ===== 毛子 ERP 云端接口替代 =====
# 替代 /api.shop/lists：精简版店铺列表，仅返回 popup/扩展程序所需的字段
@store_bp.route('/shops/lists', methods=['GET'])
@handle_errors
def get_shops_lists():
    """获取店铺精简列表（替代毛子 ERP /api.shop/lists）

    查询参数:
    - page: 页码（默认 1）
    - pageSize: 每页数量（默认 10）
    - keyword: 按 alias 或 store_id 模糊搜索（可空）
    - group: 按分组筛选（可空）
    - authStatus: 按授权状态筛选（可空）

    返回字段：id / store_id / alias / currency / store_group / auth_status / today_limit
    """
    pagination = extract_pagination(request.args)
    keyword = request.args.get('keyword', '').strip()
    group = request.args.get('group', '').strip()
    auth_status = request.args.get('authStatus', '').strip()

    conn = get_connection()
    try:
        sql = (
            "SELECT id, store_id, alias, currency, store_group, auth_status, today_limit "
            "FROM stores WHERE 1=1"
        )
        params = []
        if keyword:
            sql += " AND (alias LIKE ? OR store_id LIKE ?)"
            params.extend([f'%{keyword}%', f'%{keyword}%'])
        if group:
            sql += " AND store_group = ?"
            params.append(group)
        if auth_status:
            sql += " AND auth_status = ?"
            params.append(auth_status)

        # 总数
        count_sql = sql.replace(
            "SELECT id, store_id, alias, currency, store_group, auth_status, today_limit",
            "SELECT COUNT(*) AS cnt",
        )
        total = conn.execute(count_sql, params).fetchone()['cnt']

        # 分页
        sql += " ORDER BY id ASC LIMIT ? OFFSET ?"
        params.extend([pagination['pageSize'], (pagination['page'] - 1) * pagination['pageSize']])
        rows = conn.execute(sql, params).fetchall()
    finally:
        conn.close()

    items = [{
        'id': row['id'],
        'storeId': row['store_id'],
        'alias': row['alias'],
        'currency': row['currency'],
        'storeGroup': row['store_group'],
        'authStatus': row['auth_status'],
        'todayLimit': row['today_limit'],
    } for row in rows]

    return paginate_response(items, total, **pagination)


# 注意：原 /config/pricing 路由已迁移到 routes/pricing_routes.py
# 新版支持持久化到 pricing_config 表（重启不丢失），并扩展为完整定价配置（汇率/利润率/3档佣金/运费/VAT等）
# 详见 pricing_bp 的 GET/PUT /api/config/pricing


# ===== Cookie 绑定（对齐毛子 ERP /api.shop/set_cookies） =====
@store_bp.route('/stores/set_cookies', methods=['POST'])
@handle_errors
def set_seller_cookies():
    """保存从 seller.ozon.ru 上传的 Cookie

    请求体:
        platform: 平台标识（固定 'ozon'）
        cookies:  Cookie JSON 字符串（由扩展序列化的 chrome.cookies 数组）
        source:   来源标识（用于日志）

    从 Cookie 中提取 sc_company_id 作为店铺 ID，
    若该店铺不存在则自动创建，存在则更新 seller_cookies 字段。
    """
    import json
    from datetime import datetime

    data = request.get_json(silent=True) or {}
    cookies_str = data.get('cookies', '')

    if not cookies_str:
        return error_response("cookies 参数不能为空", 400)

    # 反序列化 Cookie 数组
    try:
        cookies = json.loads(cookies_str) if isinstance(cookies_str, str) else cookies_str
    except (json.JSONDecodeError, TypeError):
        return error_response("cookies 格式无效", 400)

    if not isinstance(cookies, list) or len(cookies) == 0:
        return error_response("cookies 列表为空", 400)

    # 提取 sc_company_id 作为店铺 ID
    company_id = ''
    for c in cookies:
        if isinstance(c, dict) and c.get('name') == 'sc_company_id':
            company_id = c.get('value', '')
            break

    if not company_id:
        return error_response("未在 Cookie 中找到 sc_company_id，请确认已登录 seller.ozon.ru", 400)

    now = datetime.now().strftime('%Y-%m-%d %H:%M:%S')
    conn = get_connection()
    try:
        # 查找是否已有该店铺
        row = conn.execute(
            "SELECT id FROM stores WHERE store_id = ?", (company_id,)
        ).fetchone()

        if row:
            # 已存在：更新 seller_cookies 和授权状态
            conn.execute(
                "UPDATE stores SET seller_cookies = ?, auth_type = 'cookie', "
                "auth_status = 'active', auth_time = ?, updated_at = ? WHERE id = ?",
                (cookies_str, now, now, row['id'])
            )
            store_pk = row['id']
        else:
            # 不存在：自动创建新店铺
            cursor = conn.execute(
                "INSERT INTO stores (store_id, alias, currency, auth_type, "
                "auth_status, auth_time, seller_cookies, created_at, updated_at) "
                "VALUES (?, ?, 'RUB', 'cookie', 'active', ?, ?, ?, ?)",
                (company_id, 'Ozon-' + company_id[:6], now, cookies_str, now, now)
            )
            store_pk = cursor.lastrowid
        conn.commit()
    finally:
        conn.close()

    return success_response(
        data={'storeId': company_id, 'storePk': store_pk, 'cookieCount': len(cookies)},
        msg="Cookie 绑定成功（店铺ID: " + company_id[:4] + "****）"
    )
