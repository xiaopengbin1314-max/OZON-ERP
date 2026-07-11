"""
公告相关 API 路由
提供系统公告的查询接口
"""
from flask import Blueprint, request
from models.product import Notice
from utils.response import success_response, paginate_response, handle_errors
from utils.validators import extract_pagination

notice_bp = Blueprint('notices', __name__)


@notice_bp.route('/notices', methods=['GET'])
@handle_errors
def get_notices():
    """获取公告列表（支持分页）"""
    pagination = extract_pagination(request.args)
    all_notices = Notice.find_all()
    total = len(all_notices)

    # 按时间倒序排列
    all_notices.sort(key=lambda x: x.get('publishedAt', ''), reverse=True)

    # 分页
    start = (pagination['page'] - 1) * pagination['pageSize']
    end = start + pagination['pageSize']

    return paginate_response(all_notices[start:end], total, **pagination)
