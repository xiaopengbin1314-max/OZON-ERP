"""
水印模板 API 路由
替代毛子 ERP 云端 /api.watermark/templates，本地管理商品图片水印模板

接口:
- GET    /api/watermark/templates          获取水印模板列表
- POST   /api/watermark/templates          新增水印模板
- PUT    /api/watermark/templates/<id>      更新水印模板
- DELETE /api/watermark/templates/<id>     删除水印模板
"""
import json
from flask import Blueprint, request
from db import get_connection
from utils.response import success_response, error_response, handle_errors

watermark_bp = Blueprint('watermark', __name__)


def _row_to_dict(row):
    """将数据库行转换为前端响应字典（JSON 字段反序列化）"""
    try:
        config = json.loads(row['config']) if row['config'] else {}
    except json.JSONDecodeError:
        config = {}
    return {
        'id': row['id'],
        'name': row['name'],
        'config': config,
        'isDefault': bool(row['is_default']),
        'createdAt': row['created_at'],
        'updatedAt': row['updated_at'],
    }


@watermark_bp.route('/watermark/templates', methods=['GET'])
@handle_errors
def list_watermark_templates():
    """获取水印模板列表

    查询参数:
    - keyword: 按 name 模糊搜索（可空）
    """
    keyword = request.args.get('keyword', '').strip()

    conn = get_connection()
    try:
        sql = "SELECT id, name, config, is_default, created_at, updated_at FROM watermark_templates WHERE 1=1"
        params = []
        if keyword:
            sql += " AND name LIKE ?"
            params.append(f'%{keyword}%')
        sql += " ORDER BY is_default DESC, id ASC"
        rows = conn.execute(sql, params).fetchall()
    finally:
        conn.close()

    items = [_row_to_dict(row) for row in rows]
    return success_response(data={'list': items, 'total': len(items)})


@watermark_bp.route('/watermark/templates', methods=['POST'])
@handle_errors
def create_watermark_template():
    """新增水印模板

    请求体:
    {
        "name": "默认模板",          // 必填，模板名称
        "config": {...},            // 必填，水印配置
        "isDefault": false          // 可空，是否设为默认
    }
    """
    data = request.get_json()
    if not data:
        return error_response("请求体不能为空")

    name = str(data.get('name') or '').strip()
    if not name:
        return error_response("模板名称不能为空")

    config = data.get('config')
    if config is None:
        return error_response("config 不能为空")

    config_str = json.dumps(config, ensure_ascii=False) if not isinstance(config, str) else config
    is_default = 1 if data.get('isDefault') else 0

    conn = get_connection()
    try:
        # 设为默认前，清除其他默认标记
        if is_default:
            conn.execute("UPDATE watermark_templates SET is_default = 0 WHERE is_default = 1")

        cur = conn.execute(
            """INSERT INTO watermark_templates (name, config, is_default, created_at, updated_at)
               VALUES (?, ?, ?, datetime('now'), datetime('now'))""",
            (name, config_str, is_default),
        )
        conn.commit()
        new_id = cur.lastrowid
        row = conn.execute(
            "SELECT id, name, config, is_default, created_at, updated_at FROM watermark_templates WHERE id = ?",
            (new_id,),
        ).fetchone()
    finally:
        conn.close()

    return success_response(data=_row_to_dict(row), msg="水印模板创建成功")


@watermark_bp.route('/watermark/templates/<int:template_id>', methods=['PUT'])
@handle_errors
def update_watermark_template(template_id):
    """更新水印模板

    请求体（任一字段可选）:
    {
        "name": "新名称",
        "config": {...},
        "isDefault": true
    }
    """
    data = request.get_json()
    if not data:
        return error_response("请求体不能为空")

    conn = get_connection()
    try:
        row = conn.execute(
            "SELECT id FROM watermark_templates WHERE id = ?",
            (template_id,),
        ).fetchone()
        if not row:
            return error_response("水印模板不存在", 404)

        set_clauses = []
        params = []

        name = str(data.get('name') or '').strip()
        if name:
            set_clauses.append("name = ?")
            params.append(name)

        config = data.get('config')
        if config is not None:
            config_str = json.dumps(config, ensure_ascii=False) if not isinstance(config, str) else config
            set_clauses.append("config = ?")
            params.append(config_str)

        if 'isDefault' in data:
            is_default = 1 if data['isDefault'] else 0
            # 设为默认前，清除其他默认标记
            if is_default:
                conn.execute("UPDATE watermark_templates SET is_default = 0 WHERE is_default = 1")
            set_clauses.append("is_default = ?")
            params.append(is_default)

        if not set_clauses:
            return error_response("无有效更新字段")

        set_clauses.append("updated_at = datetime('now')")
        params.append(template_id)
        conn.execute(
            f"UPDATE watermark_templates SET {', '.join(set_clauses)} WHERE id = ?",
            params,
        )
        conn.commit()

        row = conn.execute(
            "SELECT id, name, config, is_default, created_at, updated_at FROM watermark_templates WHERE id = ?",
            (template_id,),
        ).fetchone()
    finally:
        conn.close()

    return success_response(data=_row_to_dict(row), msg="水印模板更新成功")


@watermark_bp.route('/watermark/templates/<int:template_id>', methods=['DELETE'])
@handle_errors
def delete_watermark_template(template_id):
    """删除水印模板"""
    conn = get_connection()
    try:
        row = conn.execute(
            "SELECT id FROM watermark_templates WHERE id = ?",
            (template_id,),
        ).fetchone()
        if not row:
            return error_response("水印模板不存在", 404)

        cur = conn.execute("DELETE FROM watermark_templates WHERE id = ?", (template_id,))
        conn.commit()
        deleted = cur.rowcount
    finally:
        conn.close()

    if deleted == 0:
        return error_response("删除失败", 500)

    return success_response(msg="水印模板已删除")
