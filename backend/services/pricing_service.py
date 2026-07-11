"""
定价计算引擎
支持：
- 成本项：采购价(CNY) + 汇率 + 运费(FBO/FBS/realFBS) + 包装 + 损耗 + 其他
- 体积重：长*宽*高(mm) / 系数
- 佣金：3档默认（按售价分段）+ 按类目精确佣金率
- 税费：VAT + 个税
- 退货率：影响实际利润（退货损失 ≈ 退货的运费+佣金）
- 利润公式：售价 - 采购成本 - 运费 - 佣金 - 税费 - 包装 - 其他 - 损耗 - 退货损失
- 定价策略：目标利润率反推建议售价 + 划线价 + 跟卖价区间对比
"""
import json
from db import query, execute
from config import Config


# ===== 配置读写 =====

def _get_pricing_config():
    """从 pricing_config 表读取配置，回退到 Config 类（向后兼容）"""
    try:
        row = query("SELECT * FROM pricing_config WHERE id = 1", one=True)
        if row:
            return row
    except Exception as e:
        print(f'[定价配置] 读取失败，回退到 Config: {e}')
    # 回退到 Config 类
    return {
        'exchange_rate_cny_to_rub': Config.EXCHANGE_RATE_CNY_TO_RUB,
        'profit_margin': Config.PROFIT_MARGIN,
        'old_price_ratio': Config.OLD_PRICE_RATIO,
        'commission_rate_1': 0.15,
        'commission_rate_2': 0.12,
        'commission_rate_3': 0.10,
        'commission_threshold_1': 1500,
        'commission_threshold_2': 5000,
        'shipping_rate_per_kg': 80,
        'shipping_first_weight_kg': 0,
        'shipping_first_weight_fee': 0,
        'fbs_shipping_rate_per_kg': 60,
        'realfbs_shipping_rate_per_kg': 50,
        'volumetric_divisor': 5000,
        'vat_rate': 0,
        'individual_tax_rate': 0,
        'return_rate': 0,
        'loss_rate': 0,
        'packaging_fee': 0,
        'other_cost': 0,
        'default_currency': 'CNY',
    }


def update_pricing_config(updates):
    """更新定价配置（持久化到 pricing_config 表，同时同步到 Config 类供向后兼容）"""
    allowed_fields = {
        'exchange_rate_cny_to_rub', 'profit_margin', 'old_price_ratio',
        'commission_rate_1', 'commission_rate_2', 'commission_rate_3',
        'commission_threshold_1', 'commission_threshold_2',
        'shipping_rate_per_kg', 'shipping_first_weight_kg', 'shipping_first_weight_fee',
        'fbs_shipping_rate_per_kg', 'realfbs_shipping_rate_per_kg',
        'volumetric_divisor', 'vat_rate', 'individual_tax_rate',
        'return_rate', 'loss_rate', 'packaging_fee', 'other_cost', 'default_currency',
    }
    set_clauses = []
    params = []
    for k, v in updates.items():
        if k in allowed_fields:
            set_clauses.append(f'{k} = ?')
            params.append(v)
            # 同步到 Config 类（向后兼容旧代码引用 Config.EXCHANGE_RATE_CNY_TO_RUB 等）
            if k == 'exchange_rate_cny_to_rub':
                Config.EXCHANGE_RATE_CNY_TO_RUB = float(v)
            elif k == 'profit_margin':
                Config.PROFIT_MARGIN = float(v)
            elif k == 'old_price_ratio':
                Config.OLD_PRICE_RATIO = float(v)
    if not set_clauses:
        return False
    set_clauses.append("updated_at = datetime('now')")
    params.append(1)  # WHERE id = 1
    sql = f"UPDATE pricing_config SET {', '.join(set_clauses)} WHERE id = ?"
    execute(sql, params)
    return True


# ===== 类目佣金 =====

def get_category_commission(description_category_id, type_id=None):
    """获取类目佣金率

    查询优先级：
    1. (description_category_id, type_id) 精确匹配
    2. (description_category_id, type_id=0) 类目级通用
    3. 返回 None（调用方用 3 档默认佣金）

    Returns:
        dict 或 None。dict 含 sale_commission_rate/logistics_commission_rate/
        acquisition_commission_rate/fbo_handling_fee/fbs_handling_fee/source
    """
    if not description_category_id:
        return None
    try:
        if type_id:
            row = query(
                "SELECT * FROM category_commissions WHERE description_category_id = ? AND type_id = ?",
                (description_category_id, type_id), one=True
            )
            if row:
                return row
        row = query(
            "SELECT * FROM category_commissions WHERE description_category_id = ? AND type_id = 0",
            (description_category_id,), one=True
        )
        if row:
            return row
    except Exception as e:
        print(f'[类目佣金] 查询失败: {e}')
    return None


def upsert_category_commission(description_category_id, type_id=0, **kwargs):
    """新增或更新类目佣金率（UPSERT）"""
    fields = {
        'sale_commission_rate': 0.15,
        'logistics_commission_rate': 0,
        'acquisition_commission_rate': 0,
        'fbo_handling_fee': 0,
        'fbs_handling_fee': 0,
        'source': 'manual',
    }
    fields.update({k: v for k, v in kwargs.items() if k in fields})
    type_id = type_id or 0
    execute(
        """INSERT INTO category_commissions
           (description_category_id, type_id, sale_commission_rate, logistics_commission_rate,
            acquisition_commission_rate, fbo_handling_fee, fbs_handling_fee, source, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
           ON CONFLICT(description_category_id, type_id) DO UPDATE SET
             sale_commission_rate = excluded.sale_commission_rate,
             logistics_commission_rate = excluded.logistics_commission_rate,
             acquisition_commission_rate = excluded.acquisition_commission_rate,
             fbo_handling_fee = excluded.fbo_handling_fee,
             fbs_handling_fee = excluded.fbs_handling_fee,
             source = excluded.source,
             updated_at = datetime('now')
        """,
        (description_category_id, type_id, fields['sale_commission_rate'],
         fields['logistics_commission_rate'], fields['acquisition_commission_rate'],
         fields['fbo_handling_fee'], fields['fbs_handling_fee'], fields['source'])
    )
    return get_category_commission(description_category_id, type_id)


# ===== 运费计算 =====

def _get_shipping_rate_per_kg(logistics_mode, config):
    """根据物流模式获取运费单价(RUB/kg)"""
    mode = (logistics_mode or 'fbo').lower()
    if mode == 'fbs':
        return float(config.get('fbs_shipping_rate_per_kg') or 60)
    if mode == 'realfbs':
        return float(config.get('realfbs_shipping_rate_per_kg') or 50)
    return float(config.get('shipping_rate_per_kg') or 80)


def _calculate_volumetric_weight(length_mm, width_mm, height_mm, divisor):
    """计算体积重(kg) = 长*宽*高(mm) / 系数"""
    if not all([length_mm, width_mm, height_mm]) or not divisor:
        return 0
    return (float(length_mm) * float(width_mm) * float(height_mm)) / float(divisor)


def _calculate_shipping(weight_g, length_mm, width_mm, height_mm, logistics_mode, config):
    """计算运费(RUB)

    1. 体积重 = 长*宽*高 / 系数
    2. 计费重 = max(实际重, 体积重)
    3. 首重模式：首重内收首重费，超出按单价×超出重量；无首重则单价×计费重
    """
    weight_kg = (float(weight_g or 0)) / 1000
    divisor = float(config.get('volumetric_divisor') or 5000)
    vol_weight = _calculate_volumetric_weight(length_mm, width_mm, height_mm, divisor)
    chargeable_kg = max(weight_kg, vol_weight)

    if chargeable_kg <= 0:
        return 0, {
            'weight_kg': 0, 'volumetric_weight_kg': 0, 'chargeable_kg': 0,
            'rate': 0, 'first_weight_kg': 0, 'first_weight_fee': 0, 'fee': 0,
        }

    rate = _get_shipping_rate_per_kg(logistics_mode, config)
    first_kg = float(config.get('shipping_first_weight_kg') or 0)
    first_fee = float(config.get('shipping_first_weight_fee') or 0)

    if first_kg > 0 and chargeable_kg <= first_kg:
        fee = first_fee
    elif first_kg > 0:
        fee = first_fee + (chargeable_kg - first_kg) * rate
    else:
        fee = chargeable_kg * rate

    return round(fee, 2), {
        'weight_kg': round(weight_kg, 4),
        'volumetric_weight_kg': round(vol_weight, 4),
        'chargeable_kg': round(chargeable_kg, 4),
        'rate': rate,
        'first_weight_kg': first_kg,
        'first_weight_fee': first_fee,
        'fee': round(fee, 2),
    }


# ===== 佣金率 =====

def _get_commission_rate(sell_price_rub, config, description_category_id=None, type_id=None):
    """获取佣金率：优先类目精确佣金，回退到 3 档默认"""
    cat_comm = get_category_commission(description_category_id, type_id)
    if cat_comm and cat_comm.get('sale_commission_rate') is not None:
        return float(cat_comm['sale_commission_rate']), cat_comm

    p = float(sell_price_rub or 0)
    t1 = float(config.get('commission_threshold_1') or 1500)
    t2 = float(config.get('commission_threshold_2') or 5000)
    if p <= t1:
        rate = float(config.get('commission_rate_1') or 0.15)
    elif p <= t2:
        rate = float(config.get('commission_rate_2') or 0.12)
    else:
        rate = float(config.get('commission_rate_3') or 0.10)
    return rate, None


# ===== 利润计算 =====

def calculate_profit(sell_price_rub, cost_cny, weight_g=0,
                     length_mm=0, width_mm=0, height_mm=0,
                     logistics_mode='fbo',
                     description_category_id=None, type_id=None,
                     store_currency='RUB', exchange_rate=None,
                     overrides=None):
    """计算给定售价下的利润分解

    Args:
        sell_price_rub: 售价(RUB)
        cost_cny: 采购价(CNY)
        weight_g: 实际重量(g)
        length_mm, width_mm, height_mm: 包装长/宽/高(mm)
        logistics_mode: fbo / fbs / realfbs
        description_category_id, type_id: Ozon 类目（用于按类目佣金）
        store_currency: 店铺币种（CNY/RUB）
        exchange_rate: 指定汇率（None=用配置中的 CNY→RUB 汇率；CNY 店铺自动=1）
        overrides: 覆盖配置项的 dict（用于前端临时调整参数，不落库）

    Returns:
        dict：完整的利润分解（含成本明细、各项费率、利润率等）
    """
    config = _get_pricing_config()
    if overrides:
        config = {**config, **overrides}

    if exchange_rate is None:
        if store_currency == 'CNY':
            exchange_rate = 1.0
        else:
            exchange_rate = float(config.get('exchange_rate_cny_to_rub') or 12.5)

    # 1. 采购成本(RUB)
    cost_rub = (float(cost_cny or 0)) * exchange_rate

    # 2. 运费(RUB)
    shipping_fee, shipping_detail = _calculate_shipping(
        weight_g, length_mm, width_mm, height_mm, logistics_mode, config
    )

    # 3. 佣金(RUB)：销售佣金 + 物流佣金 + 流量佣金 + handling fee
    commission_rate, cat_comm = _get_commission_rate(
        sell_price_rub, config, description_category_id, type_id
    )
    # 允许 overrides 覆盖佣金率（前端计算器手动输入类目佣金时生效）
    if overrides and 'commission_rate' in overrides:
        try:
            commission_rate = float(overrides['commission_rate'])
            commission_source = 'manual_override'
        except (TypeError, ValueError):
            commission_source = 'category' if cat_comm else 'default_3tier'
    else:
        commission_source = 'category' if cat_comm else 'default_3tier'
    commission_fee = (float(sell_price_rub or 0)) * commission_rate

    logistics_commission_rate = float(cat_comm.get('logistics_commission_rate') or 0) if cat_comm else 0
    acquisition_rate = float(cat_comm.get('acquisition_commission_rate') or 0) if cat_comm else 0
    # 允许 overrides 覆盖广告费率/物流佣金率（前端计算器手动输入时生效）
    if overrides:
        if 'logistics_commission_rate' in overrides:
            try:
                logistics_commission_rate = float(overrides['logistics_commission_rate'])
            except (TypeError, ValueError):
                pass
        if 'acquisition_rate' in overrides:
            try:
                acquisition_rate = float(overrides['acquisition_rate'])
            except (TypeError, ValueError):
                pass
    logistics_commission_fee = (float(sell_price_rub or 0)) * logistics_commission_rate
    acquisition_fee = (float(sell_price_rub or 0)) * acquisition_rate

    fbo_handling_fee = 0
    fbs_handling_fee = 0
    if cat_comm:
        if logistics_mode == 'fbo':
            fbo_handling_fee = float(cat_comm.get('fbo_handling_fee') or 0)
        elif logistics_mode == 'fbs':
            fbs_handling_fee = float(cat_comm.get('fbs_handling_fee') or 0)

    # 4. 税费
    vat_rate = float(config.get('vat_rate') or 0)
    individual_tax_rate = float(config.get('individual_tax_rate') or 0)
    # VAT：从含税销售额中拆出税部分（简化）
    vat_fee = (float(sell_price_rub or 0)) * vat_rate / (1 + vat_rate) if vat_rate > 0 else 0
    # 个税：按毛利计算（简化模型）
    gross_profit = (float(sell_price_rub or 0)) - cost_rub - shipping_fee - commission_fee - logistics_commission_fee - acquisition_fee
    individual_tax_fee = gross_profit * individual_tax_rate if individual_tax_rate > 0 else 0

    # 5. 其他成本
    packaging_fee = float(config.get('packaging_fee') or 0)
    other_cost = float(config.get('other_cost') or 0)

    # 6. 损耗成本（按采购成本计算）
    loss_rate = float(config.get('loss_rate') or 0)
    loss_cost = cost_rub * loss_rate

    # 7. 退货损失（退货产生的运费+佣金损失，商品可二次销售故不计采购成本）
    return_rate = float(config.get('return_rate') or 0)
    return_cost = (shipping_fee + commission_fee + logistics_commission_fee) * return_rate

    # 8. 总成本
    total_cost = (
        cost_rub + shipping_fee + commission_fee + logistics_commission_fee + acquisition_fee
        + vat_fee + individual_tax_fee + packaging_fee + other_cost
        + loss_cost + return_cost + fbo_handling_fee + fbs_handling_fee
    )

    # 9. 利润
    profit = (float(sell_price_rub or 0)) - total_cost
    profit_rate = profit / sell_price_rub if sell_price_rub else 0
    profit_margin = profit / total_cost if total_cost > 0 else 0

    return {
        'sell_price': round(float(sell_price_rub or 0), 2),
        'cost_cny': round(float(cost_cny or 0), 2),
        'exchange_rate': exchange_rate,
        'store_currency': store_currency,
        'cost_rub': round(cost_rub, 2),
        'shipping_fee': round(shipping_fee, 2),
        'commission_fee': round(commission_fee, 2),
        'commission_rate': commission_rate,
        'commission_source': commission_source,
        'logistics_commission_fee': round(logistics_commission_fee, 2),
        'logistics_commission_rate': logistics_commission_rate,
        'acquisition_fee': round(acquisition_fee, 2),
        'acquisition_rate': acquisition_rate,
        'fbo_handling_fee': round(fbo_handling_fee, 2),
        'fbs_handling_fee': round(fbs_handling_fee, 2),
        'vat_fee': round(vat_fee, 2),
        'vat_rate': vat_rate,
        'individual_tax_fee': round(individual_tax_fee, 2),
        'individual_tax_rate': individual_tax_rate,
        'packaging_fee': round(packaging_fee, 2),
        'other_cost': round(other_cost, 2),
        'loss_cost': round(loss_cost, 2),
        'loss_rate': loss_rate,
        'return_cost': round(return_cost, 2),
        'return_rate': return_rate,
        'total_cost': round(total_cost, 2),
        'profit': round(profit, 2),
        'profit_rate': round(profit_rate, 4),
        'profit_margin': round(profit_margin, 4),
        'logistics_mode': logistics_mode,
        'shipping_detail': shipping_detail,
    }


# ===== 定价反推 =====

def calculate_price(cost_cny, weight_g=0,
                    length_mm=0, width_mm=0, height_mm=0,
                    logistics_mode='fbo',
                    description_category_id=None, type_id=None,
                    target_margin=None,
                    store_currency='RUB', exchange_rate=None,
                    old_price_ratio=None,
                    competitor_price_min=None, competitor_price_max=None,
                    overrides=None):
    """根据成本和目标利润率反推建议售价

    反推公式：
        售价 × (1 - 各费率之和 - 目标利润率) = 固定成本 + handling_fee
        售价 = (固定成本 + handling_fee) / (1 - 各费率之和 - 目标利润率)

    其中"各费率"包括：销售佣金率 + 物流佣金率 + 流量佣金率 + VAT率 + 个税率 +
    退货率×(销售佣金率+物流佣金率)

    Args:
        target_margin: 目标利润率（0-1，基于售价）。None=用 Config.PROFIT_MARGIN 推算
        competitor_price_min/max: 跟卖价区间(RUB)，用于给出竞品对比建议

    Returns:
        dict：含 suggested_price / old_price / profit / profit_rate /
        competitor_status / cost_breakdown 等
    """
    config = _get_pricing_config()
    if overrides:
        config = {**config, **overrides}

    # 目标利润率：未指定时从 Config.PROFIT_MARGIN（如 1.3）推算
    if target_margin is None:
        pm = float(config.get('profit_margin') or 1.3)
        target_margin = (pm - 1) / pm if pm > 1 else 0.3
    if old_price_ratio is None:
        old_price_ratio = float(config.get('old_price_ratio') or 1.2)
    if exchange_rate is None:
        if store_currency == 'CNY':
            exchange_rate = 1.0
        else:
            exchange_rate = float(config.get('exchange_rate_cny_to_rub') or 12.5)

    # 1. 固定成本（不随售价变化）
    cost_rub = (float(cost_cny or 0)) * exchange_rate
    _, shipping_detail = _calculate_shipping(
        weight_g, length_mm, width_mm, height_mm, logistics_mode, config
    )
    shipping_fee = shipping_detail['fee']
    packaging_fee = float(config.get('packaging_fee') or 0)
    other_cost = float(config.get('other_cost') or 0)
    loss_rate = float(config.get('loss_rate') or 0)
    loss_cost = cost_rub * loss_rate

    fixed_cost = cost_rub + shipping_fee + packaging_fee + other_cost + loss_cost

    # 2. 类目佣金率（精确）或 3 档默认（用中档估算）
    cat_comm = get_category_commission(description_category_id, type_id)
    if cat_comm:
        est_commission_rate = float(cat_comm.get('sale_commission_rate') or 0.12)
        logistics_comm_rate = float(cat_comm.get('logistics_commission_rate') or 0)
        acquisition_rate = float(cat_comm.get('acquisition_commission_rate') or 0)
        if logistics_mode == 'fbo':
            handling_fee = float(cat_comm.get('fbo_handling_fee') or 0)
        elif logistics_mode == 'fbs':
            handling_fee = float(cat_comm.get('fbs_handling_fee') or 0)
        else:
            handling_fee = 0
        commission_source = 'category'
    else:
        est_commission_rate = float(config.get('commission_rate_2') or 0.12)
        logistics_comm_rate = 0
        acquisition_rate = 0
        handling_fee = 0
        commission_source = 'default'

    # 3. 税率与退货率
    vat_rate = float(config.get('vat_rate') or 0)
    individual_tax_rate = float(config.get('individual_tax_rate') or 0)
    return_rate = float(config.get('return_rate') or 0)

    # 4. 反推售价
    variable_rate = (
        est_commission_rate + logistics_comm_rate + acquisition_rate
        + vat_rate + individual_tax_rate
        + return_rate * (est_commission_rate + logistics_comm_rate)
    )
    denominator = 1 - variable_rate - target_margin
    if denominator <= 0:
        # 目标利润率或费率过高，无法反推（兜底）
        suggested_price = fixed_cost * (1 + target_margin)
    else:
        suggested_price = (fixed_cost + handling_fee) / denominator

    # 5. 跟卖价对比
    competitor_status = None
    if competitor_price_min and competitor_price_max:
        if suggested_price < competitor_price_min:
            competitor_status = 'below_market'  # 低于市场价，可适当提价
        elif suggested_price > competitor_price_max:
            competitor_status = 'above_market'  # 高于市场价，需谨慎
        else:
            competitor_status = 'in_range'

    # 6. 用精确 3 档佣金重算利润（避免估算误差）
    profit_detail = calculate_profit(
        suggested_price, cost_cny, weight_g,
        length_mm, width_mm, height_mm,
        logistics_mode, description_category_id, type_id,
        store_currency, exchange_rate, overrides
    )

    old_price = suggested_price * old_price_ratio

    return {
        'suggested_price': round(suggested_price, 2),
        'old_price': round(old_price, 2),
        'profit': profit_detail['profit'],
        'profit_rate': profit_detail['profit_rate'],
        'profit_margin': profit_detail['profit_margin'],
        'target_margin': round(target_margin, 4),
        'old_price_ratio': old_price_ratio,
        'competitor_price_min': competitor_price_min,
        'competitor_price_max': competitor_price_max,
        'competitor_status': competitor_status,
        'cost_breakdown': {
            'cost_rub': round(cost_rub, 2),
            'shipping_fee': round(shipping_fee, 2),
            'shipping_detail': shipping_detail,
            'packaging_fee': round(packaging_fee, 2),
            'other_cost': round(other_cost, 2),
            'loss_cost': round(loss_cost, 2),
            'handling_fee': round(handling_fee, 2),
            'est_commission_rate': est_commission_rate,
            'logistics_comm_rate': logistics_comm_rate,
            'acquisition_rate': acquisition_rate,
            'vat_rate': vat_rate,
            'individual_tax_rate': individual_tax_rate,
            'return_rate': return_rate,
            'variable_rate': round(variable_rate, 4),
            'fixed_cost': round(fixed_cost, 2),
        },
        'logistics_mode': logistics_mode,
        'store_currency': store_currency,
        'exchange_rate': exchange_rate,
        'commission_source': commission_source,
    }


# ===== 定价历史 =====

def save_pricing_history(product_id, source, params, result):
    """保存定价历史记录到 pricing_history 表"""
    try:
        execute(
            """INSERT INTO pricing_history
               (product_id, source, cost_cny, weight_g, length_mm, width_mm, height_mm,
                description_category_id, type_id, logistics_mode, target_margin,
                suggested_price, old_price, profit, profit_rate, cost_breakdown)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
            (
                product_id, source,
                params.get('cost_cny', 0), params.get('weight_g', 0),
                params.get('length_mm', 0), params.get('width_mm', 0), params.get('height_mm', 0),
                params.get('description_category_id'), params.get('type_id'),
                params.get('logistics_mode', 'fbo'), params.get('target_margin'),
                result.get('suggested_price'), result.get('old_price'),
                result.get('profit'), result.get('profit_rate'),
                json.dumps(result.get('cost_breakdown') or {}, ensure_ascii=False),
            )
        )
    except Exception as e:
        print(f'[定价历史] 保存失败: {e}')


def list_pricing_history(product_id=None, limit=20, offset=0):
    """查询定价历史记录"""
    if product_id:
        return query(
            "SELECT * FROM pricing_history WHERE product_id = ? ORDER BY created_at DESC LIMIT ? OFFSET ?",
            (product_id, limit, offset)
        )
    return query(
        "SELECT * FROM pricing_history ORDER BY created_at DESC LIMIT ? OFFSET ?",
        (limit, offset)
    )
