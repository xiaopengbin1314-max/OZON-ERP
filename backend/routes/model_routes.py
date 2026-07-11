"""
AI 模型管理 API 路由
提供 AI 提供商配置的 CRUD、激活切换、连接测试等接口
整个系统共用一份配置，由 ai_config_service 统一管理持久化
"""
from flask import Blueprint, request
from utils.response import success_response, error_response, handle_errors
from services import ai_config_service

model_bp = Blueprint('model', __name__)


@model_bp.route('/ai/models', methods=['GET'])
@handle_errors
def get_models():
    """获取所有 AI 模型配置

    返回当前激活的提供商、所有提供商列表（API Key 脱敏）和最后更新时间
    """
    config = ai_config_service.get_all_config()
    return success_response(data=config, msg='获取配置成功')


@model_bp.route('/ai/models/<provider_key>', methods=['PUT'])
@handle_errors
def update_model(provider_key):
    """更新单个 AI 提供商配置

    请求体: {
        "api_key": "sk-xxx",       // 空 or ******** 表示不修改
        "base_url": "https://...",  // 可选
        "model": "deepseek-chat",   // 可选
        "enabled": true,            // 可选
        "name": "DeepSeek",         // 可选，仅自定义生效
        "description": "..."        // 可选
    }
    """
    body = request.get_json(silent=True) or {}
    ai_config_service.update_provider(provider_key, body)
    return success_response(msg='配置已保存')


@model_bp.route('/ai/models/active', methods=['PUT'])
@handle_errors
def set_active_model():
    """设置当前激活的 AI 提供商

    请求体: { "provider": "deepseek" }
    """
    body = request.get_json(silent=True) or {}
    provider_key = body.get('provider', '').strip()
    if not provider_key:
        return error_response(msg='缺少 provider 参数', code=400)
    try:
        ai_config_service.set_active_provider(provider_key)
        return success_response(msg=f'已切换至 {provider_key}')
    except ValueError as e:
        return error_response(msg=str(e), code=400)


@model_bp.route('/ai/models/<provider_key>', methods=['DELETE'])
@handle_errors
def delete_model(provider_key):
    """删除自定义 AI 提供商（内置提供商不可删除）"""
    try:
        ai_config_service.delete_provider(provider_key)
        return success_response(msg=f'已删除提供商 {provider_key}')
    except ValueError as e:
        return error_response(msg=str(e), code=400)


@model_bp.route('/ai/models/test', methods=['POST'])
@handle_errors
def test_model_connection():
    """测试 AI 提供商连接

    请求体: {
        "provider": "deepseek",
        // 可选：传入则测试临时配置，否则用已保存的配置
        "api_key": "sk-xxx",
        "base_url": "https://...",
        "model": "..."
    }
    """
    body = request.get_json(silent=True) or {}
    provider_key = body.get('provider', '').strip()
    api_key = body.get('api_key', '').strip()
    base_url = body.get('base_url', '').strip()
    model = body.get('model', '').strip()

    # 如果传入了完整的临时配置，直接测试
    if api_key and base_url and model:
        result = ai_config_service.test_provider_connection(
            provider_key, api_key=api_key, base_url=base_url, model=model
        )
    else:
        if not provider_key:
            return error_response(msg='缺少 provider 参数', code=400)
        result = ai_config_service.test_provider_connection(provider_key)

    if result.get('success'):
        return success_response(data=result, msg=result.get('message', '连接成功'))
    return error_response(msg=result.get('message', '连接失败'), code=400, data=result)


@model_bp.route('/ai/models/status', methods=['GET'])
@handle_errors
def get_models_status():
    """获取当前激活的 AI 提供商配置状态（轻量接口，供其他模块检查）

    返回: { "provider": "deepseek", "name": "DeepSeek", "has_key": true, "model": "deepseek-chat" }
    不返回完整 API Key，只返回是否已配置
    """
    config = ai_config_service.get_ai_config()
    return success_response(data={
        'provider': config.get('provider', ''),
        'name': config.get('name', ''),
        'model': config.get('model', ''),
        'has_key': bool(config.get('api_key', '')),
        'base_url': config.get('base_url', ''),
    })


@model_bp.route('/ai/generate-description', methods=['POST'])
@handle_errors
def generate_description():
    """AI 生成商品描述（C5）

    复用 AIService.generate('description', ...)，自动使用当前激活的 AI 提供商。
    未配置 API Key 或调用失败时返回错误。

    请求体:
      {
        "title": "商品标题",            # 必填，作为生成主输入
        "sourceDescription": "源描述",  # 可选，作为参考文本
        "platform": "ozon",            # 可选，默认 ozon
        "language": "ru"               # 可选，默认 ru（俄语）；可选 en/de/zh
      }

    返回:
      {
        "content": "生成的描述文本",
        "provider": "qwen",            # 实际使用的提供商 key
        "model": "qwen-plus",
        "language": "ru"
      }
    """
    body = request.get_json(silent=True) or {}
    title = (body.get('title') or '').strip()
    if not title:
        return error_response(msg='商品标题不能为空', code=400)

    source_desc = (body.get('sourceDescription') or '').strip()
    platform = body.get('platform') or 'ozon'
    language = body.get('language') or 'ru'

    # 拼接输入文本：标题 + 源描述（如有，截断防止 token 超限）
    text = title
    if source_desc:
        text = f'{title}\n\n[源商品描述参考]\n{source_desc[:1500]}'

    from services.ai_service import AIService

    config = ai_config_service.get_ai_config()

    content = AIService.generate('description', text, {
        'platform': platform,
        'language': language,
    })

    return success_response(data={
        'content': content,
        'provider': config.get('provider', ''),
        'model': config.get('model', ''),
        'language': language,
    }, msg='描述生成成功')
