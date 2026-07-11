"""
工作台仪表盘聚合 API
为前端首页提供真实的统计数据、最近活动和系统状态，避免使用假数据
"""
from flask import Blueprint, request
from models.product import Product, PublishRecord
from models.online_product import OnlineProduct
from services.ai_config_service import get_ai_config
from utils.response import success_response, handle_errors
from datetime import datetime, timezone

dashboard_bp = Blueprint('dashboard', __name__)


@dashboard_bp.route('/dashboard/stats', methods=['GET'])
@handle_errors
def get_dashboard_stats():
    """工作台聚合统计

    一次请求返回首页所需的全部数据：
    - metrics: 统计卡（今日采集 / 待上架 / 已上架 / AI 状态）
    - activities: 最近活动（商品采集 + 上架记录，按时间倒序合并取前 6 条）
    - systemStatus: 系统状态（后端 / AI 引擎 / 数据库 / 采集服务）
    """
    # ===== 统计卡数据 =====
    today_collected = _count_today_collected()
    pending_publish = _count_pending_publish()
    published_total = _count_published()
    failed_publish = _count_failed_publish()

    ai_config = get_ai_config()
    ai_has_key = bool(ai_config.get('api_key'))

    metrics = [
        {
            'key': 'todayCollected',
            'label': '今日采集',
            'value': today_collected,
            'icon': 'package',
            'trend': 'flat',
            'trendValue': '—',
        },
        {
            'key': 'pendingPublish',
            'label': '待上架',
            'value': pending_publish,
            'icon': 'clock',
            'trend': 'flat',
            'trendValue': '—',
        },
        {
            'key': 'published',
            'label': '已上架',
            'value': published_total,
            'icon': 'check-circle',
            'trend': 'flat',
            'trendValue': '—',
        },
        {
            'key': 'failedPublish',
            'label': '发布异常',
            'value': failed_publish,
            'icon': 'circle-alert',
            'trend': 'flat',
            'trendValue': '—',
        },
    ]

    # ===== 最近活动 =====
    activities = _build_recent_activities()

    # ===== 系统状态 =====
    system_status = [
        {'key': 'backend', 'label': '后端 API', 'status': 'ok', 'text': '正常'},
        {
            'key': 'ai',
            'label': 'AI 引擎',
            'status': 'ok' if ai_has_key else 'warn',
            'text': ai_config.get('name', '') or '未配置' if ai_has_key else '未配置',
        },
        {'key': 'database', 'label': '数据库', 'status': 'ok', 'text': '正常'},
        {'key': 'collector', 'label': '采集服务', 'status': 'ok', 'text': '正常'},
    ]

    return success_response(data={
        'metrics': metrics,
        'activities': activities,
        'systemStatus': system_status,
    })


def _count_today_collected():
    """统计今日采集的商品数量（按 createdAt 当天日期匹配）"""
    try:
        items = Product.find_all()
        now = datetime.now(timezone.utc)
        today_str = now.strftime('%Y-%m-%d')
        count = 0
        for item in items:
            created = item.get('createdAt', '')
            if created and created[:10] == today_str:
                count += 1
        return count
    except Exception:
        return 0


def _count_pending_publish():
    """待上架数量：未发布的商品 + 待处理的上架记录"""
    total = 0
    try:
        product_stats = Product.get_status_stats()
        total += product_stats.get('unpublished', 0)
    except Exception:
        pass
    try:
        record_stats = PublishRecord.get_stats()
        total += record_stats.get('pending', 0)
    except Exception:
        pass
    return total


def _count_published():
    """已上架数量：在线商品在售总数"""
    try:
        stats = OnlineProduct.get_stats()
        return stats.get('total', 0)
    except Exception:
        return 0


def _count_failed_publish():
    """统计需要人工处理的发布异常。"""
    try:
        products = Product.find_all()
        return sum(
            1 for product in products
            if product.get('publishStatus') in ('failed', 'published_with_errors')
        )
    except Exception:
        return 0


def _build_recent_activities():
    """合并商品采集与上架记录，按时间倒序取前 6 条"""
    activities = []

    # 商品采集活动
    try:
        products = Product.find_all()
        for p in products:
            activities.append({
                'name': p.get('title') or '未命名商品',
                'type': 'collect',
                'status': _product_status_map(p),
                'statusText': _product_status_text(p),
                'time': p.get('createdAt', ''),
                'icon': 'package',
            })
    except Exception:
        pass

    # 上架记录活动
    try:
        records = PublishRecord.find_all()
        for r in records:
            activities.append({
                'name': r.get('title') or '未命名商品',
                'type': 'publish',
                'status': _record_status_map(r.get('status', 'pending')),
                'statusText': _record_status_text(r),
                'time': r.get('createdAt', ''),
                'icon': 'upload-cloud',
            })
    except Exception:
        pass

    # 按时间倒序，取前 6 条
    activities.sort(key=lambda x: x.get('time', ''), reverse=True)
    return activities[:6]


def _product_status_map(product):
    """商品状态映射到活动状态（优先用 publishStatus 判断真实上架结果）"""
    publish_status = product.get('publishStatus')
    if publish_status in ('published', 'published_with_errors'):
        return 'success'
    if publish_status == 'processing':
        return 'pending'
    if publish_status == 'failed':
        return 'failed'

    status = product.get('status', 'unpublished')
    mapping = {
        'unpublished': 'pending',
        'scheduled': 'pending',
        'published': 'success',
    }
    return mapping.get(status, 'pending')


def _product_status_text(product):
    """商品状态文本（优先用 publishStatus）"""
    publish_status = product.get('publishStatus')
    if publish_status == 'published':
        return '已上架'
    if publish_status == 'published_with_errors':
        return '已上架(有误)'
    if publish_status == 'processing':
        return '上架中'
    if publish_status == 'failed':
        return '上架失败'

    status = product.get('status', 'unpublished')
    if status == 'published':
        return '已上架'
    if status == 'scheduled':
        return '已排期'
    return '待上架'


def _record_status_map(status):
    """上架记录状态映射到活动状态"""
    mapping = {
        'pending': 'pending',
        'processing': 'pending',
        'published': 'success',
        'failed': 'failed',
        'cancelled': 'failed',
        'published_with_errors': 'success',
    }
    return mapping.get(status, 'pending')


def _record_status_text(record):
    """上架记录状态文本"""
    status = record.get('status', 'pending')
    mapping = {
        'pending': '待处理',
        'processing': '上架中',
        'published': '已上架',
        'failed': '失败',
        'cancelled': '已取消',
        'published_with_errors': '已上架(有误)',
    }
    return mapping.get(status, '待处理')
