"""
统一响应工具模块
封装标准 API 响应格式，确保所有接口返回一致的数据结构
"""
from functools import wraps
from flask import jsonify


def success_response(data=None, msg="操作成功", code=200, **extra):
    """构建成功响应

    可通过 extra 传递额外字段，如 syncing=True
    """
    resp = {
        "code": code,
        "msg": msg,
        "data": data,
    }
    resp.update(extra)
    return jsonify(resp), 200


def error_response(msg="操作失败", code=400, data=None):
    """构建错误响应"""
    return jsonify({
        "code": code,
        "msg": msg,
        "data": data,
    }), code


def paginate_response(items, total, page=1, page_size=10, **kwargs):
    """构建分页响应"""
    return success_response(data={
        "list": items,
        "total": total,
        "page": page,
        "pageSize": page_size,
        **kwargs,
    })


def handle_errors(f):
    """异常处理装饰器：捕获未处理异常并返回统一错误响应"""
    @wraps(f)
    def decorated_function(*args, **kwargs):
        try:
            return f(*args, **kwargs)
        except ValueError as e:
            return error_response(str(e), 400)
        except KeyError as e:
            return error_response(f"缺少必要参数: {str(e)}", 400)
        except Exception as e:
            if current_app.config.get('DEBUG'):
                import traceback
                traceback.print_exc()
            return error_response("服务器内部错误", 500)
    from flask import current_app
    return decorated_function
