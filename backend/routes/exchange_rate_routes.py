"""
汇率 API 路由
替代毛子 ERP 云端 /api.exchange_rate/index，提供专用的 CNY→RUB 汇率查询/更新接口

汇率数据复用 pricing_config 表中的 exchange_rate_cny_to_rub 字段，
本接口仅作为专用入口，便于前端汇率卡片单独调用。

接口:
- GET  /api/exchange_rate     获取当前汇率信息
- POST /api/exchange_rate      更新汇率
"""
from flask import Blueprint, request
from db import get_connection
from services.pricing_service import _get_pricing_config, update_pricing_config
from utils.response import success_response, error_response, handle_errors

exchange_rate_bp = Blueprint('exchange_rate', __name__)


@exchange_rate_bp.route('/exchange_rate', methods=['GET'])
@handle_errors
def get_exchange_rate():
    """获取当前汇率信息

    返回:
    {
        "currencyFrom": "CNY",
        "currencyTo": "RUB",
        "rate": 12.5,
        "updatedAt": "2026-06-29 12:00:00"
    }
    """
    config = _get_pricing_config()
    return success_response(data={
        'currencyFrom': 'CNY',
        'currencyTo': 'RUB',
        'rate': float(config.get('exchange_rate_cny_to_rub') or 12.5),
        'updatedAt': config.get('updated_at', ''),
    })


@exchange_rate_bp.route('/exchange_rate', methods=['POST'])
@handle_errors
def update_exchange_rate():
    """更新汇率（复用 update_pricing_config 持久化到 pricing_config 表）

    请求体:
    {
        "rate": 12.8        // 必填，新的 CNY→RUB 汇率（必须大于0）
    }
    """
    data = request.get_json()
    if not data:
        return error_response("请求体不能为空")

    rate = data.get('rate')
    try:
        rate = float(rate)
    except (TypeError, ValueError):
        return error_response("rate 必须为数字")

    if rate <= 0:
        return error_response("汇率必须大于0")

    update_pricing_config({'exchange_rate_cny_to_rub': rate})

    config = _get_pricing_config()
    return success_response(
        data={
            'currencyFrom': 'CNY',
            'currencyTo': 'RUB',
            'rate': float(config.get('exchange_rate_cny_to_rub') or rate),
            'updatedAt': config.get('updated_at', ''),
        },
        msg="汇率已更新",
    )
