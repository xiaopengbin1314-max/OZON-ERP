"""
上架记录相关 API 路由
提供上架记录的增删改查、状态筛选、统计等接口
"""
from flask import Blueprint, request
from models.product import PublishRecord, Product
from services.publish_service import PublishService
from utils.response import success_response, error_response, paginate_response, handle_errors
from utils.validators import extract_pagination

publish_record_bp = Blueprint('publish_records', __name__)


@publish_record_bp.route('/publish-records', methods=['GET'])
@handle_errors
def get_publish_records():
    """获取上架记录列表（支持分页、状态筛选、关键词搜索）"""
    pagination = extract_pagination(request.args)
    status = request.args.get('status', '')
    keyword = request.args.get('keyword', '')
    store_id = request.args.get('storeId', '')

    all_records = PublishRecord.find_all()

    # 筛选
    filtered = all_records
    if status:
        filtered = [r for r in filtered if r.get('status') == status]
    if store_id:
        filtered = [r for r in filtered if r.get('storeId') == store_id]
    if keyword:
        kw = keyword.lower()
        filtered = [r for r in filtered if kw in (r.get('title', '') or '').lower()
                     or kw in (r.get('sourceName', '') or '').lower()
                     or kw in (r.get('sourceId', '') or '').lower()
                     or kw in (r.get('publisher', '') or '').lower()
                     or kw in str(r.get('ozonProductId', '') or '').lower()]

    # 按创建时间倒序
    filtered.sort(key=lambda x: x.get('createdAt', ''), reverse=True)

    total = len(filtered)
    start = (pagination['page'] - 1) * pagination['pageSize']
    end = start + pagination['pageSize']
    page_items = filtered[start:end]

    return paginate_response(page_items, total, **pagination)


@publish_record_bp.route('/publish-records/stats', methods=['GET'])
@handle_errors
def get_publish_stats():
    """获取上架记录各状态统计"""
    stats = PublishRecord.get_stats()
    total = sum(stats.values())
    return success_response(data={
        "stats": stats,
        "total": total,
    })


@publish_record_bp.route('/publish-records', methods=['POST'])
@handle_errors
def create_publish_record():
    """创建上架记录（手动添加或从商品发布）"""
    data = request.get_json()
    if not data:
        return error_response("请求体不能为空")

    product_id = data.get('productId')

    # 如果关联了商品，从商品中获取信息
    if product_id:
        product = Product.find_by_id(product_id)
        if product:
            data.setdefault('title', product.get('title', ''))
            data.setdefault('price', product.get('price', 0))
            data.setdefault('images', product.get('images', []))

    record = PublishRecord.create(data)
    return success_response(data=record, msg="上架记录已创建")


@publish_record_bp.route('/publish-records/batch', methods=['POST'])
@handle_errors
def batch_create_publish_records():
    """批量创建上架记录（从商品列表发布）"""
    data = request.get_json()
    if not data:
        return error_response("请求体不能为空")

    product_ids = data.get('productIds', [])
    store_id = data.get('storeId')
    store_name = data.get('storeName', '')
    publisher = data.get('publisher', '')

    if not product_ids:
        return error_response("请选择要发布的商品")

    records = []
    for pid in product_ids:
        product = Product.find_by_id(pid)
        if not product:
            continue

        record = PublishRecord.create({
            "productId": pid,
            "title": product.get('title', ''),
            "price": product.get('price', 0),
            "images": product.get('images', []),
            "status": "pending",
            "platform": "ozon",
            "storeId": store_id,
            "storeName": store_name,
            "sourceUrl": product.get('originalUrl', ''),
            "sourceName": product.get('sourceName', ''),
            "sourceId": product.get('sourceId', ''),
            "publisher": publisher,
        })
        records.append(record)

    if not records:
        return error_response("未找到有效的商品")

    return success_response(
        data={"records": records, "count": len(records)},
        msg=f"已创建 {len(records)} 条上架记录"
    )


@publish_record_bp.route('/publish-records/<record_id>', methods=['GET'])
@handle_errors
def get_publish_record(record_id):
    """获取单条上架记录详情"""
    record = PublishRecord.find_by_id(record_id)
    if not record:
        return error_response("记录不存在", 404)
    return success_response(data=record)


@publish_record_bp.route('/publish-records/<record_id>', methods=['PUT'])
@handle_errors
def update_publish_record(record_id):
    """更新上架记录"""
    data = request.get_json()
    if not data:
        return error_response("请求体不能为空")

    # 移除不允许更新的字段
    for field in ['id', 'createdAt']:
        data.pop(field, None)

    updated = PublishRecord.update(record_id, data)
    if not updated:
        return error_response("记录不存在", 404)

    return success_response(data=updated, msg="更新成功")


@publish_record_bp.route('/publish-records/<record_id>', methods=['DELETE'])
@handle_errors
def delete_publish_record(record_id):
    """删除上架记录"""
    success = PublishRecord.delete(record_id)
    if not success:
        return error_response("记录不存在", 404)

    return success_response(msg="删除成功")


@publish_record_bp.route('/publish-records/<record_id>/submit', methods=['POST'])
@handle_errors
def submit_publish_record(record_id):
    """提交上架记录到 Ozon 平台"""
    record = PublishRecord.find_by_id(record_id)
    if not record:
        return error_response("记录不存在", 404)

    product_id = record.get('productId')
    if not product_id:
        return error_response("该记录未关联商品，无法提交发布")

    # 调用发布服务
    try:
        task = PublishService.create_task(product_id, record.get('platform', 'ozon'))

        # 更新上架记录状态
        PublishRecord.update(record_id, {
            "status": task.get('status', 'processing'),
            "ozonTaskId": task.get('ozonTaskId'),
            "ozonProductId": task.get('ozonProductId'),
        })

        return success_response(data=task, msg="已提交发布")
    except Exception as e:
        PublishRecord.update(record_id, {
            "status": "failed",
            "error": str(e),
        })
        return error_response(f"发布失败: {str(e)}")


@publish_record_bp.route('/publish-records/<record_id>/refresh', methods=['POST'])
@handle_errors
def refresh_publish_record(record_id):
    """刷新上架记录状态（从 Ozon 查询最新状态）"""
    record = PublishRecord.find_by_id(record_id)
    if not record:
        return error_response("记录不存在", 404)

    ozon_task_id = record.get('ozonTaskId')
    if not ozon_task_id:
        return success_response(data=record, msg="无 Ozon 任务 ID，无法刷新")

    # 构造任务对象用于查询
    task_obj = {
        'id': record_id,
        'productId': record.get('productId'),
        'ozonTaskId': ozon_task_id,
    }

    try:
        status_info = PublishService.check_status(task_obj)

        # 更新记录状态
        update_data = {'status': status_info.get('status', record.get('status'))}
        if status_info.get('ozonProductId'):
            update_data['ozonProductId'] = status_info['ozonProductId']
        if status_info.get('errors'):
            update_data['errors'] = status_info['errors']
        if status_info.get('error'):
            update_data['error'] = status_info['error']

        updated = PublishRecord.update(record_id, update_data)
        return success_response(data=updated or record, msg=status_info.get('message', '状态已更新'))
    except Exception as e:
        return error_response(f"刷新失败: {str(e)}")


@publish_record_bp.route('/publish-records/batch/delete', methods=['POST'])
@handle_errors
def batch_delete_publish_records():
    """批量删除上架记录"""
    data = request.get_json()
    if not data:
        return error_response("请求体不能为空")

    ids = data.get('ids', [])
    if not ids:
        return error_response("请选择要删除的记录")

    deleted = 0
    for rid in ids:
        if PublishRecord.delete(rid):
            deleted += 1

    return success_response(data={"deleted": deleted}, msg=f"已删除 {deleted} 条记录")


@publish_record_bp.route('/publish-records/batch/submit', methods=['POST'])
@handle_errors
def batch_submit_publish_records():
    """批量提交上架记录"""
    data = request.get_json()
    if not data:
        return error_response("请求体不能为空")

    ids = data.get('ids', [])
    if not ids:
        return error_response("请选择要提交的记录")

    results = []
    for rid in ids:
        record = PublishRecord.find_by_id(rid)
        if not record or not record.get('productId'):
            continue

        try:
            task = PublishService.create_task(record['productId'], record.get('platform', 'ozon'))
            PublishRecord.update(rid, {
                "status": task.get('status', 'processing'),
                "ozonTaskId": task.get('ozonTaskId'),
                "ozonProductId": task.get('ozonProductId'),
            })
            results.append({"id": rid, "status": "submitted"})
        except Exception as e:
            PublishRecord.update(rid, {"status": "failed", "error": str(e)})
            results.append({"id": rid, "status": "failed", "error": str(e)})

    return success_response(data={"results": results, "count": len(results)},
                           msg=f"已提交 {len(results)} 条记录")
