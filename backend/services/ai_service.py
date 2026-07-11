"""
AI 服务模块
封装 AI 内容生成能力（标题优化、描述生成、关键词推荐、多语言翻译等）
使用真实 AI 提供商（通过 ai_config_service 配置）。未配置或调用失败时直接报错。
"""
import json
import urllib.request
import urllib.error


class AIService:
    """AI 内容生成服务

    调用通过 ai_config_service 配置的大模型 API（DeepSeek/通义千问/OpenAI 等）。
    """


    @classmethod
    def generate(cls, content_type, text, params=None):
        """生成 AI 内容

        :param content_type: 生成类型 title/description/keywords/translate
        :param text: 输入文本
        :param params: 额外参数（platform, language 等）
        :return: 生成的文本内容
        """
        params = params or {}
        result = cls._call_ai(content_type, text, params)
        if not result:
            raise RuntimeError('AI 未返回有效内容')
        return result

    @classmethod
    def _call_ai(cls, content_type, text, params):
        """调用真实 AI 提供商的 API

        使用 ai_config_service 获取配置，通过 OpenAI 兼容接口调用。
        未配置 API Key 或模型时直接报错。
        """
        from services.ai_config_service import get_ai_config

        config = get_ai_config()
        if not config.get('api_key'):
            raise RuntimeError('AI API Key 未配置')

        api_key = config['api_key']
        base_url = config.get('base_url', '').rstrip('/')
        model = config.get('model', '')

        if not base_url or not model:
            raise RuntimeError('AI base_url 或 model 未配置')

        # 构建 prompt
        system_prompt, user_prompt = cls._build_prompt(content_type, text, params)

        # 调用 OpenAI 兼容接口
        url = f'{base_url}/chat/completions'
        payload = {
            'model': model,
            'messages': [
                {'role': 'system', 'content': system_prompt},
                {'role': 'user', 'content': user_prompt},
            ],
            'max_tokens': 2000,
            'temperature': 0.7,
        }

        req = urllib.request.Request(url, data=json.dumps(payload).encode('utf-8'))
        req.add_header('Content-Type', 'application/json')
        req.add_header('Authorization', f'Bearer {api_key}')

        try:
            with urllib.request.urlopen(req, timeout=30) as resp:
                result = json.loads(resp.read().decode('utf-8'))
                content = result.get('choices', [{}])[0].get('message', {}).get('content', '')
                return content.strip() if content else None
        except urllib.error.HTTPError as e:
            error_body = ''
            try:
                error_body = e.read().decode('utf-8', errors='replace')[:300]
            except Exception:
                pass
            raise Exception(f'AI API HTTP {e.code}: {error_body or e.reason}')
        except urllib.error.URLError as e:
            raise Exception(f'AI API 连接失败: {str(e.reason)}')

    @classmethod
    def _build_prompt(cls, content_type, text, params):
        """根据生成类型构建 system prompt 和 user prompt"""
        platform = params.get('platform', 'ozon')
        language = params.get('language', 'ru')

        lang_names = {'ru': '俄语', 'en': '英语', 'de': '德语', 'zh': '中文'}
        lang_name = lang_names.get(language, language)

        if content_type == 'title':
            system_prompt = (
                f'你是专业的跨境电商文案专家，擅长为 {platform} 平台生成吸引买家的商品标题。'
                f'标题应简洁有力，包含核心卖点，不超过 200 字符。'
                f'请用{lang_name}输出，仅返回标题文本，不要加任何前缀说明。'
            )
            user_prompt = f'请为以下商品生成一个优化的商品标题：\n{text}'

        elif content_type == 'description':
            system_prompt = (
                f'你是专业的跨境电商文案专家，擅长为 {platform} 平台撰写商品描述。'
                f'描述应突出产品卖点、规格参数、使用场景和售后保障，结构清晰。'
                f'请用{lang_name}输出，仅返回描述文本。'
            )
            user_prompt = f'请为以下商品生成详细的商品描述：\n{text}'

        elif content_type == 'keywords':
            system_prompt = (
                f'你是跨境电商 SEO 专家，擅长为 {platform} 平台提取搜索关键词。'
                f'关键词应覆盖产品核心词、长尾词、关联词等，用逗号分隔。'
                f'请用{lang_name}输出，仅返回关键词列表。'
            )
            user_prompt = f'请为以下商品推荐 10-15 个搜索关键词：\n{text}'

        elif content_type == 'translate':
            system_prompt = (
                f'你是专业翻译，擅长电商文案翻译。请将用户提供的文本翻译为{lang_name}。'
                f'保持原文的营销语气和格式，仅返回翻译结果。'
            )
            user_prompt = f'请翻译以下文本：\n{text}'

        else:
            system_prompt = '你是专业的电商文案助手。'
            user_prompt = text

        return system_prompt, user_prompt

