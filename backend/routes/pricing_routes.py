"""
定价计算 API 路由
提供：
- POST /api/pricing/calculate              反推建议售价（含跟卖价对比）
- POST /api/pricing/profit                 计算给定售价的利润分解
- GET  /api/config/pricing                 读取持久化定价配置
- PUT  /api/config/pricing                 更新定价配置（持久化到 pricing_config 表）
- GET  /api/categories/<id>/commission     查询类目佣金率
- PUT  /api/categories/<id>/commission     更新类目佣金率
- GET  /api/pricing/history                定价历史记录
"""
from flask import Blueprint, request
from services.pricing_service import (
    calculate_price, calculate_profit, save_pricing_history, list_pricing_history,
    _get_pricing_config, update_pricing_config,
    get_category_commission, upsert_category_commission,
)
from services.publish_service import _get_store_currency
from utils.response import success_response, error_response, handle_errors

pricing_bp = Blueprint('pricing', __name__)


# ===== 定价计算 =====

@pricing_bp.route('/pricing/calculate', methods=['POST'])
@handle_errors
def calc_price():
    """根据成本反推建议售价

    请求体（字段名采用驼峰，便于前端直传）:
    {
        "costCny": 100,                     // 采购价(CNY)，必填
        "weightG": 500,                     // 实际重量(g)
        "lengthMm": 200, "widthMm": 100, "heightMm": 50,  // 包装尺寸(mm)
        "logisticsMode": "fbo",             // fbo / fbs / realfbs
        "descriptionCategoryId": 17028741,  // Ozon 二级类目 ID（用于按类目佣金）
        "typeId": 92851,                    // Ozon 三级类型 ID
        "targetMargin": 0.3,                // 目标利润率(0-1，基于售价)，null=用配置
        "storeCurrency": "RUB",             // 店铺币种 CNY/RUB
        "exchangeRate": null,               // 指定汇率，null=用配置
        "oldPriceRatio": null,              // 划线价系数，null=用配置
        "competitorPriceMin": 1500,         // 跟卖最低价(RUB)
        "competitorPriceMax": 2000,         // 跟卖最高价(RUB)
        "productId": "xxx",                 // 关联商品 ID（用于历史记录）
        "overrides": {...}                  // 临时覆盖配置项（不落库）
    }
    """
    data = request.get_json()
    if not data:
        return error_response("请求体不能为空")

    cost_cny = float(data.get('costCny') or 0)
    if cost_cny <= 0:
        return error_response("采购价必须大于0")

    store_currency = data.get('storeCurrency') or _get_store_currency() or 'CNY'

    result = calculate_price(
        cost_cny=cost_cny,
        weight_g=float(data.get('weightG') or 0),
        length_mm=float(data.get('lengthMm') or 0),
        width_mm=float(data.get('widthMm') or 0),
        height_mm=float(data.get('heightMm') or 0),
        logistics_mode=data.get('logisticsMode') or 'fbo',
        description_category_id=data.get('descriptionCategoryId'),
        type_id=data.get('typeId'),
        target_margin=float(data['targetMargin']) if data.get('targetMargin') is not None else None,
        store_currency=store_currency,
        exchange_rate=float(data['exchangeRate']) if data.get('exchangeRate') else None,
        old_price_ratio=float(data['oldPriceRatio']) if data.get('oldPriceRatio') else None,
        competitor_price_min=float(data['competitorPriceMin']) if data.get('competitorPriceMin') else None,
        competitor_price_max=float(data['competitorPriceMax']) if data.get('competitorPriceMax') else None,
        overrides=data.get('overrides'),
    )

    # 落历史
    save_pricing_history(
        product_id=data.get('productId'),
        source='calculator',
        params={
            'cost_cny': cost_cny,
            'weight_g': data.get('weightG'),
            'length_mm': data.get('lengthMm'),
            'width_mm': data.get('widthMm'),
            'height_mm': data.get('heightMm'),
            'description_category_id': data.get('descriptionCategoryId'),
            'type_id': data.get('typeId'),
            'logistics_mode': data.get('logisticsMode', 'fbo'),
            'target_margin': data.get('targetMargin'),
        },
        result=result,
    )

    return success_response(data=result, msg="定价计算完成")


@pricing_bp.route('/pricing/profit', methods=['POST'])
@handle_errors
def calc_profit():
    """计算给定售价的利润分解

    请求体:
    {
        "sellPriceRub": 1500,                // 售价(RUB)，必填
        "costCny": 100,
        "weightG": 500,
        "lengthMm": 200, "widthMm": 100, "heightMm": 50,
        "logisticsMode": "fbo",
        "descriptionCategoryId": 17028741,
        "typeId": 92851,
        "storeCurrency": "RUB",
        "exchangeRate": null,
        "overrides": {...}
    }
    """
    data = request.get_json()
    if not data:
        return error_response("请求体不能为空")

    sell_price = float(data.get('sellPriceRub') or 0)
    if sell_price <= 0:
        return error_response("售价必须大于0")

    cost_cny = float(data.get('costCny') or 0)
    store_currency = data.get('storeCurrency') or _get_store_currency() or 'CNY'

    result = calculate_profit(
        sell_price_rub=sell_price,
        cost_cny=cost_cny,
        weight_g=float(data.get('weightG') or 0),
        length_mm=float(data.get('lengthMm') or 0),
        width_mm=float(data.get('widthMm') or 0),
        height_mm=float(data.get('heightMm') or 0),
        logistics_mode=data.get('logisticsMode') or 'fbo',
        description_category_id=data.get('descriptionCategoryId'),
        type_id=data.get('typeId'),
        store_currency=store_currency,
        exchange_rate=float(data['exchangeRate']) if data.get('exchangeRate') else None,
        overrides=data.get('overrides'),
    )

    return success_response(data=result, msg="利润计算完成")


# ===== 定价配置（持久化版，替代 store_routes.py 中的旧实现）=====

@pricing_bp.route('/config/pricing', methods=['GET'])
@handle_errors
def get_pricing_config_route():
    """获取定价配置（从 pricing_config 表读取，回退到 Config 类）

    返回完整配置 + 当前店铺币种 + effectiveExchangeRate（CNY 店铺=1，RUB 店铺=汇率）
    """
    config = _get_pricing_config()
    store_currency = _get_store_currency() or config.get('default_currency', 'CNY')
    config['storeCurrency'] = store_currency
    config['effectiveExchangeRate'] = (
        1.0 if store_currency == 'CNY' else float(config.get('exchange_rate_cny_to_rub') or 12.5)
    )
    return success_response(data=config)


@pricing_bp.route('/config/pricing', methods=['PUT'])
@handle_errors
def update_pricing_config_route():
    """更新定价配置（持久化到 pricing_config 表，重启不丢失）

    请求体可包含任意配置字段（驼峰命名），未提供的字段保持不变。
    支持的字段：exchangeRateCnyToRub / profitMargin / oldPriceRatio /
    commissionRate1/2/3 / commissionThreshold1/2 /
    shippingRatePerKg / shippingFirstWeightKg / shippingFirstWeightFee /
    fbsShippingRatePerKg / realfbsShippingRatePerKg / volumetricDivisor /
    vatRate / individualTaxRate / returnRate / lossRate /
    packagingFee / otherCost / defaultCurrency
    """
    data = request.get_json()
    if not data:
        return error_response("请求体不能为空")

    # 字段名转换（前端驼峰 → 数据库下划线）
    field_map = {
        'exchangeRateCnyToRub': 'exchange_rate_cny_to_rub',
        'profitMargin': 'profit_margin',
        'oldPriceRatio': 'old_price_ratio',
        'commissionRate1': 'commission_rate_1',
        'commissionRate2': 'commission_rate_2',
        'commissionRate3': 'commission_rate_3',
        'commissionThreshold1': 'commission_threshold_1',
        'commissionThreshold2': 'commission_threshold_2',
        'shippingRatePerKg': 'shipping_rate_per_kg',
        'shippingFirstWeightKg': 'shipping_first_weight_kg',
        'shippingFirstWeightFee': 'shipping_first_weight_fee',
        'fbsShippingRatePerKg': 'fbs_shipping_rate_per_kg',
        'realfbsShippingRatePerKg': 'realfbs_shipping_rate_per_kg',
        'volumetricDivisor': 'volumetric_divisor',
        'vatRate': 'vat_rate',
        'individualTaxRate': 'individual_tax_rate',
        'returnRate': 'return_rate',
        'lossRate': 'loss_rate',
        'packagingFee': 'packaging_fee',
        'otherCost': 'other_cost',
        'defaultCurrency': 'default_currency',
    }
    updates = {}
    for camel, snake in field_map.items():
        if camel in data:
            try:
                updates[snake] = float(data[camel])
            except (TypeError, ValueError):
                updates[snake] = data[camel]

    # 关键字段校验
    if 'exchange_rate_cny_to_rub' in updates and updates['exchange_rate_cny_to_rub'] <= 0:
        return error_response("汇率必须大于0")
    if 'profit_margin' in updates and updates['profit_margin'] <= 1:
        return error_response("利润系数必须大于1")
    if 'old_price_ratio' in updates and updates['old_price_ratio'] <= 1:
        return error_response("划线价系数必须大于1")
    # 佣金率/税率/退货率/损耗率 范围校验
    for k in ('commission_rate_1', 'commission_rate_2', 'commission_rate_3',
              'vat_rate', 'individual_tax_rate', 'return_rate', 'loss_rate'):
        if k in updates and not (0 <= updates[k] <= 1):
            return error_response(f"{k} 必须在 0-1 之间")

    if not updates:
        return error_response("无有效更新字段")

    update_pricing_config(updates)
    return success_response(
        data=_get_pricing_config(),
        msg=f"已持久化更新 {len(updates)} 项配置"
    )


# ===== 类目佣金 =====

@pricing_bp.route('/categories/<int:description_category_id>/commission', methods=['GET'])
@handle_errors
def get_commission_route(description_category_id):
    """查询类目佣金率

    查询参数: ?typeId=92851
    若数据库无精确匹配，返回 3 档默认佣金率供前端展示
    """
    type_id = request.args.get('typeId', type=int)
    comm = get_category_commission(description_category_id, type_id)
    if comm:
        return success_response(data={
            **comm,
            'source': 'category',
            'matched': True,
        })
    config = _get_pricing_config()
    return success_response(data={
        'description_category_id': description_category_id,
        'type_id': type_id or 0,
        'sale_commission_rate': None,  # 未配置类目佣金，前端用 3 档默认
        'logistics_commission_rate': 0,
        'acquisition_commission_rate': 0,
        'fbo_handling_fee': 0,
        'fbs_handling_fee': 0,
        'source': 'default',
        'matched': False,
        'default_3tier': {
            'rate_1': config.get('commission_rate_1', 0.15),
            'rate_2': config.get('commission_rate_2', 0.12),
            'rate_3': config.get('commission_rate_3', 0.10),
            'threshold_1': config.get('commission_threshold_1', 1500),
            'threshold_2': config.get('commission_threshold_2', 5000),
        },
    })


@pricing_bp.route('/categories/<int:description_category_id>/commission', methods=['PUT'])
@handle_errors
def update_commission_route(description_category_id):
    """更新类目佣金率

    请求体:
    {
        "typeId": 92851,                       // 可空，0=类目级通用
        "saleCommissionRate": 0.18,
        "logisticsCommissionRate": 0,
        "acquisitionCommissionRate": 0,
        "fboHandlingFee": 0,
        "fbsHandlingFee": 0,
        "source": "manual"
    }
    """
    data = request.get_json()
    if not data:
        return error_response("请求体不能为空")

    result = upsert_category_commission(
        description_category_id=description_category_id,
        type_id=data.get('typeId') or 0,
        sale_commission_rate=float(data.get('saleCommissionRate', 0.15)),
        logistics_commission_rate=float(data.get('logisticsCommissionRate', 0)),
        acquisition_commission_rate=float(data.get('acquisitionCommissionRate', 0)),
        fbo_handling_fee=float(data.get('fboHandlingFee', 0)),
        fbs_handling_fee=float(data.get('fbsHandlingFee', 0)),
        source=data.get('source', 'manual'),
    )
    return success_response(data=result, msg="类目佣金已更新")


# ===== 定价历史 =====

@pricing_bp.route('/pricing/history', methods=['GET'])
@handle_errors
def get_history_route():
    """查询定价历史

    查询参数: ?productId=xxx&limit=20&offset=0
    """
    product_id = request.args.get('productId')
    limit = request.args.get('limit', default=20, type=int)
    offset = request.args.get('offset', default=0, type=int)
    history = list_pricing_history(product_id=product_id, limit=limit, offset=offset)
    return success_response(data=history)
