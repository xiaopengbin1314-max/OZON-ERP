"""
选品规则 API 路由
替代毛子 ERP 云端 /api.selection.plugin/*，本地管理选品规则

接口:
- GET    /api/selection/rules              获取选品规则列表
- POST   /api/selection/rules              新增选品规则
- PUT    /api/selection/rules/<id>         更新选品规则
- DELETE /api/selection/rules/<id>         删除选品规则
- POST   /api/selection/rules/<id>/toggle  启用/禁用选品规则
"""
import json
from flask import Blueprint, request
from db import get_connection
from utils.response import success_response, error_response, handle_errors

selection_bp = Blueprint('selection', __name__)


def _row_to_dict(row):
    """将数据库行转换为前端响应字典（JSON 字段反序列化）"""
    try:
        conditions = json.loads(row['conditions']) if row['conditions'] else []
    except json.JSONDecodeError:
        conditions = []
    return {
        'id': row['id'],
        'name': row['name'],
        'label': row['label'],
        'priority': row['priority'],
        'cardColor': row['card_color'],
        'isAutoFavorite': bool(row['is_auto_favorite']),
        'isOpen': bool(row['is_open']),
        'conditions': conditions,
        'createdAt': row['created_at'],
        'updatedAt': row['updated_at'],
    }


@selection_bp.route('/selection/rules', methods=['GET'])
@handle_errors
def list_selection_rules():
    """获取选品规则列表

    查询参数:
    - keyword: 按 name 或 label 模糊搜索（可空）
    - isOpen: 0/1，按启用状态筛选（可空）
    - autoFavorite: 0/1，按是否自动收藏筛选（可空）
    """
    keyword = request.args.get('keyword', '').strip()
    is_open = request.args.get('isOpen', '').strip()
    auto_favorite = request.args.get('autoFavorite', '').strip()

    conn = get_connection()
    try:
        sql = (
            "SELECT id, name, label, priority, card_color, is_auto_favorite, is_open, "
            "conditions, created_at, updated_at FROM selection_rules WHERE 1=1"
        )
        params = []
        if keyword:
            sql += " AND (name LIKE ? OR label LIKE ?)"
            params.extend([f'%{keyword}%', f'%{keyword}%'])
        if is_open in ('0', '1'):
            sql += " AND is_open = ?"
            params.append(int(is_open))
        if auto_favorite in ('0', '1'):
            sql += " AND is_auto_favorite = ?"
            params.append(int(auto_favorite))
        sql += " ORDER BY priority DESC, id ASC"
        rows = conn.execute(sql, params).fetchall()
    finally:
        conn.close()

    items = [_row_to_dict(row) for row in rows]
    return success_response(data={'list': items, 'total': len(items)})


@selection_bp.route('/selection/rules', methods=['POST'])
@handle_errors
def create_selection_rule():
    """新增选品规则

    请求体:
    {
        "name": "high_profit",          // 必填，规则唯一标识
        "label": "高利润商品",          // 可空，显示名（缺省时取 name）
        "priority": 100,               // 可空，优先级（默认 0）
        "cardColor": "#52c41a",         // 可空，卡片颜色
        "isAutoFavorite": true,         // 可空，命中后是否自动收藏（默认 false）
        "isOpen": true,                // 可空，是否启用（默认 false）
        "conditions": [...]            // 可空，规则条件数组（默认 []）
    }
    """
    data = request.get_json()
    if not data:
        return error_response("请求体不能为空")

    name = str(data.get('name') or '').strip()
    if not name:
        return error_response("规则名称不能为空")

    label = str(data.get('label') or '').strip() or name
    priority = int(data.get('priority') or 0)
    card_color = str(data.get('cardColor') or '').strip()
    is_auto_favorite = 1 if data.get('isAutoFavorite') else 0
    is_open = 1 if data.get('isOpen') else 0

    conditions = data.get('conditions', [])
    if not isinstance(conditions, (list, dict)):
        return error_response("conditions 必须为数组或对象")
    conditions_str = json.dumps(conditions, ensure_ascii=False)

    conn = get_connection()
    try:
        # 名称唯一性校验
        existing = conn.execute(
            "SELECT id FROM selection_rules WHERE name = ?", (name,),
        ).fetchone()
        if existing:
            return error_response(f"规则名称 {name} 已存在")

        cur = conn.execute(
            """INSERT INTO selection_rules
               (name, label, priority, card_color, is_auto_favorite, is_open, conditions, created_at, updated_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))""",
            (name, label, priority, card_color, is_auto_favorite, is_open, conditions_str),
        )
        conn.commit()
        new_id = cur.lastrowid
        row = conn.execute(
            "SELECT id, name, label, priority, card_color, is_auto_favorite, is_open, conditions, created_at, updated_at "
            "FROM selection_rules WHERE id = ?",
            (new_id,),
        ).fetchone()
    finally:
        conn.close()

    return success_response(data=_row_to_dict(row), msg="选品规则创建成功")


@selection_bp.route('/selection/rules/<int:rule_id>', methods=['PUT'])
@handle_errors
def update_selection_rule(rule_id):
    """更新选品规则

    请求体（任一字段可选）:
    {
        "name": "new_name",
        "label": "新显示名",
        "priority": 200,
        "cardColor": "#1677ff",
        "isAutoFavorite": false,
        "isOpen": true,
        "conditions": [...]
    }
    """
    data = request.get_json()
    if not data:
        return error_response("请求体不能为空")

    conn = get_connection()
    try:
        row = conn.execute(
            "SELECT id, name FROM selection_rules WHERE id = ?", (rule_id,),
        ).fetchone()
        if not row:
            return error_response("选品规则不存在", 404)

        set_clauses = []
        params = []

        name = str(data.get('name') or '').strip()
        if name and name != row['name']:
            # 名称唯一性校验
            dup = conn.execute(
                "SELECT id FROM selection_rules WHERE name = ? AND id != ?",
                (name, rule_id),
            ).fetchone()
            if dup:
                return error_response(f"规则名称 {name} 已存在")
            set_clauses.append("name = ?")
            params.append(name)

        if 'label' in data:
            label = str(data.get('label') or '').strip()
            set_clauses.append("label = ?")
            params.append(label)

        if 'priority' in data:
            try:
                priority = int(data['priority'])
            except (TypeError, ValueError):
                return error_response("priority 必须为整数")
            set_clauses.append("priority = ?")
            params.append(priority)

        if 'cardColor' in data:
            set_clauses.append("card_color = ?")
            params.append(str(data['cardColor'] or '').strip())

        if 'isAutoFavorite' in data:
            set_clauses.append("is_auto_favorite = ?")
            params.append(1 if data['isAutoFavorite'] else 0)

        if 'isOpen' in data:
            set_clauses.append("is_open = ?")
            params.append(1 if data['isOpen'] else 0)

        if 'conditions' in data:
            conditions = data['conditions']
            if not isinstance(conditions, (list, dict)):
                return error_response("conditions 必须为数组或对象")
            set_clauses.append("conditions = ?")
            params.append(json.dumps(conditions, ensure_ascii=False))

        if not set_clauses:
            return error_response("无有效更新字段")

        set_clauses.append("updated_at = datetime('now')")
        params.append(rule_id)
        conn.execute(
            f"UPDATE selection_rules SET {', '.join(set_clauses)} WHERE id = ?",
            params,
        )
        conn.commit()

        row = conn.execute(
            "SELECT id, name, label, priority, card_color, is_auto_favorite, is_open, conditions, created_at, updated_at "
            "FROM selection_rules WHERE id = ?",
            (rule_id,),
        ).fetchone()
    finally:
        conn.close()

    return success_response(data=_row_to_dict(row), msg="选品规则更新成功")


@selection_bp.route('/selection/rules/<int:rule_id>', methods=['DELETE'])
@handle_errors
def delete_selection_rule(rule_id):
    """删除选品规则"""
    conn = get_connection()
    try:
        row = conn.execute(
            "SELECT id FROM selection_rules WHERE id = ?", (rule_id,),
        ).fetchone()
        if not row:
            return error_response("选品规则不存在", 404)

        cur = conn.execute("DELETE FROM selection_rules WHERE id = ?", (rule_id,))
        conn.commit()
        deleted = cur.rowcount
    finally:
        conn.close()

    if deleted == 0:
        return error_response("删除失败", 500)

    return success_response(msg="选品规则已删除")


@selection_bp.route('/selection/rules/<int:rule_id>/toggle', methods=['POST'])
@handle_errors
def toggle_selection_rule(rule_id):
    """启用/禁用选品规则

    请求体（可空）:
    {
        "isOpen": true      // 可空，指定目标状态；缺省时取反当前状态
    }
    """
    data = request.get_json(silent=True) or {}
    conn = get_connection()
    try:
        row = conn.execute(
            "SELECT id, is_open FROM selection_rules WHERE id = ?", (rule_id,),
        ).fetchone()
        if not row:
            return error_response("选品规则不存在", 404)

        if 'isOpen' in data:
            new_status = 1 if data['isOpen'] else 0
        else:
            new_status = 0 if row['is_open'] else 1

        conn.execute(
            "UPDATE selection_rules SET is_open = ?, updated_at = datetime('now') WHERE id = ?",
            (new_status, rule_id),
        )
        conn.commit()

        result_row = conn.execute(
            "SELECT id, name, label, priority, card_color, is_auto_favorite, is_open, conditions, created_at, updated_at "
            "FROM selection_rules WHERE id = ?",
            (rule_id,),
        ).fetchone()
    finally:
        conn.close()

    return success_response(
        data=_row_to_dict(result_row),
        msg=f"规则已{'启用' if new_status else '禁用'}",
    )
