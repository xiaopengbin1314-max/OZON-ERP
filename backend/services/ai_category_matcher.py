"""
AI 类目匹配服务
使用大模型（DeepSeek/通义千问）进行语义级类目匹配
当关键词匹配失败时，调用 AI 进行精准匹配

缓存策略：复用 category_mapping_cache（SQLite category_mappings 表），
与关键词匹配共享同一缓存层，避免双缓存（JSON + SQLite）维护成本。
"""
import json
import os
import urllib.request
import urllib.error
from config import Config


def _get_ai_config():
    """获取当前 AI 提供商配置（从模型管理页面持久化的配置中读取）

    配置由 /api/ai/models 接口管理，整个系统共用一份
    """
    from services.ai_config_service import get_ai_config
    config = get_ai_config()
    return {
        'api_key': config.get('api_key', ''),
        'base_url': config.get('base_url', ''),
        'model': config.get('model', ''),
        'provider': config.get('provider', ''),
    }


def _load_cached_match(source_category, title):
    """从 SQLite 缓存读取 AI 匹配结果（复用 category_mapping_cache）

    Returns:
        dict 或 None：命中返回匹配结果，未命中返回 None
    """
    from services.category_mapping_cache import get_mapping
    cached = get_mapping(source_category or '', title or '')
    if cached:
        cached['_source'] = 'ai_cache'
    return cached


def _save_cached_match(source_category, title, result):
    """保存 AI 匹配结果到 SQLite 缓存（复用 category_mapping_cache）

    仅缓存匹配成功的结果（set_mapping 内部校验 matched=True）。
    """
    from services.category_mapping_cache import set_mapping
    set_mapping(source_category or '', title or '', result)


def _call_ai_api(messages, temperature=0.1):
    """调用 AI API（OpenAI 兼容接口）

    Args:
        messages: 消息列表
        temperature: 温度参数（越低越确定）

    Returns:
        AI 返回的文本内容
    """
    config = _get_ai_config()
    if not config['api_key']:
        raise ValueError('AI API Key 未配置，请在「店铺管理 > 模型管理」页面中设置')

    url = f"{config['base_url']}/chat/completions"
    payload = {
        'model': config['model'],
        'messages': messages,
        'temperature': temperature,
        'max_tokens': 1000,
        'response_format': {'type': 'json_object'},
    }

    req = urllib.request.Request(url, data=json.dumps(payload).encode('utf-8'))
    req.add_header('Content-Type', 'application/json')
    req.add_header('Authorization', f"Bearer {config['api_key']}")

    with urllib.request.urlopen(req, timeout=30) as resp:
        result = json.loads(resp.read().decode('utf-8'))
        return result['choices'][0]['message']['content']


def _build_category_list(tree):
    """从类目树构建精简的类目列表（含中俄文路径）

    每个类目包含中俄文路径（用于关键词预筛选）和中文路径（用于 AI prompt）。
    """
    categories = []
    for l1 in tree:
        l1_zh = l1.get('category_name_zh') or l1.get('category_name', '')
        l1_ru = l1.get('category_name_ru') or ''
        for l2 in (l1.get('children') or []):
            l2_zh = l2.get('category_name_zh') or l2.get('category_name', '')
            l2_ru = l2.get('category_name_ru') or ''
            desc_cat_id = l2.get('description_category_id')
            if not desc_cat_id:
                continue
            for l3 in (l2.get('children') or []):
                l3_zh = l3.get('type_name_zh') or l3.get('type_name', '')
                l3_ru = l3.get('type_name_ru') or ''
                type_id = l3.get('type_id')
                if not type_id:
                    continue
                categories.append({
                    'path': f'{l1_zh} > {l2_zh} > {l3_zh}',
                    'path_ru': f'{l1_ru} > {l2_ru} > {l3_ru}',
                    'search_text': f'{l1_zh} {l1_ru} {l2_zh} {l2_ru} {l3_zh} {l3_ru}'.lower(),
                    'description_category_id': desc_cat_id,
                    'type_id': type_id,
                })
    return categories


def _filter_candidates_by_keywords(categories, source_category, title, description, top_n=100):
    """关键词预筛选候选类目（retrieval 阶段）

    7400+ 个类目全部发给 AI 会超 token 限制且截断导致关键类目丢失。
    本函数用关键词匹配从全量类目中筛选 Top-N 候选，再交给 AI 精排（reranking）。

    匹配策略：
      - 从 source_category + title + description 提取关键词
      - 对每个类目的中俄文搜索文本做关键词匹配打分
      - L3 名称匹配权重最高，L2 次之，L1 最低
      - 返回得分最高的 Top-N 候选

    Args:
        categories: 全量类目列表（来自 _build_category_list）
        source_category: 采集分类名
        title: 商品标题
        description: 商品描述
        top_n: 返回的候选数量上限

    Returns:
        筛选后的类目列表（按得分降序）
    """
    import re

    # 合并所有信号文本用于提取关键词
    all_text = ' '.join(filter(None, [source_category or '', title or '', description or '']))
    if not all_text.strip():
        # 无任何信号，返回前 top_n 个（保持原序）
        return categories[:top_n]

    # 提取关键词（按非字母数字汉字分隔，小写）
    # 保留长度 >= 2 的词（俄文/中文/英文）
    raw_words = re.split(r'[>/、|，,\s\-_;:.!?\(\)（）【】\[\]]+', all_text.lower())
    keywords = []
    seen = set()
    for w in raw_words:
        w = w.strip()
        if len(w) >= 2 and w not in seen:
            # 排除常见停用词
            if w in ('the', 'and', 'for', 'with', 'это', 'или', 'для', 'как', 'но', 'при', 'что',
                     '商品', '描述', '采集', '分类', '标题', '规格', '型号'):
                continue
            seen.add(w)
            keywords.append(w)

    if not keywords:
        return categories[:top_n]

    # 对每个类目打分
    scored = []
    for cat in categories:
        search_text = cat.get('search_text', '')
        path = cat.get('path', '').lower()
        path_ru = cat.get('path_ru', '').lower()
        score = 0
        for kw in keywords:
            if kw in search_text:
                # L3 名称（路径最后一段）匹配权重最高
                l3_zh = path.rsplit('>', 1)[-1].strip()
                l3_ru = path_ru.rsplit('>', 1)[-1].strip()
                if kw == l3_zh or kw == l3_ru:
                    score += 20
                elif kw in l3_zh or kw in l3_ru:
                    score += 10
                else:
                    score += 3
        if score > 0:
            scored.append((score, cat))

    if not scored:
        # 关键词没匹配到任何类目，返回前 top_n 个兜底
        return categories[:top_n]

    # 按得分降序，取 top_n
    scored.sort(key=lambda x: x[0], reverse=True)
    return [cat for _, cat in scored[:top_n]]


def ai_match_category(source_category, title='', description='', tree=None):
    """使用 AI 进行类目语义匹配

    Args:
        source_category: 采集的原始分类名
        title: 商品标题
        description: 商品描述
        tree: Ozon 类目树（双语），如不提供则从缓存加载

    Returns:
        匹配结果 dict，与 match_category 格式一致
    """
    # 1. 检查 SQLite 缓存（与关键词匹配共享 category_mappings 表）
    cached = _load_cached_match(source_category, title)
    if cached:
        print('[AI匹配] 命中缓存')
        return cached

    # 2. 检查 API Key
    config = _get_ai_config()
    if not config['api_key']:
        print('[AI匹配] API Key 未配置，跳过 AI 匹配')
        return {'matched': False, 'candidates': [], 'reason': 'AI API Key 未配置，请在「店铺管理 > 模型管理」页面中设置'}

    # 3. 获取类目树
    if tree is None:
        try:
            from services.ozon_api import get_category_tree_bilingual
            tree = get_category_tree_bilingual(use_cache=True)
        except Exception as e:
            print(f'[AI匹配] 获取类目树失败: {e}')
            return {'matched': False, 'candidates': [], 'reason': f'获取类目树失败: {e}'}

    if not tree:
        return {'matched': False, 'candidates': [], 'reason': '类目树为空'}

    # 4. 构建类目列表
    all_categories = _build_category_list(tree)
    if not all_categories:
        return {'matched': False, 'candidates': [], 'reason': '类目列表为空'}

    # 4.1 关键词预筛选：从 7400+ 类目中筛选 Top-100 候选（retrieval 阶段）
    # 避免全量类目列表超 token 限制导致截断丢失关键类目
    categories = _filter_candidates_by_keywords(
        all_categories, source_category, title, description, top_n=100
    )
    if len(all_categories) > 100 and len(categories) <= 100:
        print(f'[AI匹配] 关键词预筛选: {len(all_categories)} → {len(categories)} 个候选')

    # 5. 构建 prompt
    # 为控制 token，将类目列表精简为 "ID|路径" 格式
    # 同时展示中俄文路径，帮助 AI 跨语言匹配（如俄文标题 "Зонт" 匹配中文 "伞"）
    cat_list_text = '\n'.join([
        f"{i+1}. [{c['description_category_id']}_{c['type_id']}] {c['path']}"
        + (f" ({c['path_ru']})" if c.get('path_ru') else "")
        for i, c in enumerate(categories)
    ])

    # 截断过长的类目列表（控制在约 8000 token 以内）
    if len(cat_list_text) > 30000:
        cat_list_text = cat_list_text[:30000] + '\n... (类目列表已截断)'
        print(f'[AI匹配] 类目列表过长，已截断（共 {len(categories)} 个类目）')

    # 构建 AI prompt 的商品信息部分
    # 多信号匹配：source_category 为主信号，title + description 为辅助信号
    # 当 source_category 为空（采集器未抓到类目）时，title 是关键信号
    product_info_parts = []
    product_info_parts.append(f"采集分类: {source_category or '无'}")
    if title:
        product_info_parts.append(f"商品标题: {title[:200]}")
    if description:
        product_info_parts.append(f"商品描述: {description[:300]}")
    product_info = '\n'.join(product_info_parts)

    # 根据是否有 source_category 调整系统提示
    has_category = bool(source_category and source_category.strip())
    if has_category:
        system_prompt = """你是一个跨境电商类目匹配专家。你的任务是根据商品的采集分类信息（辅以标题和描述），从Ozon平台的类目列表中选择最匹配的类目。

规则：
1. 以采集分类为主信号，标题和描述为辅助信号，理解商品的真正品类
2. 从提供的Ozon类目列表中选择最匹配的类目
3. 如果有多个候选，选择最精准（最深层级）的匹配
4. 返回JSON格式，包含以下字段：
   - matched: 是否匹配成功 (true/false)
   - description_category_id: Ozon二级类目ID (数字)
   - type_id: Ozon三级类型ID (数字)
   - label: 匹配的类目路径 (如 "服装和鞋类 > 男士服装 > T恤")
   - confidence: 置信度 ("high"/"medium"/"low")
   - reason: 匹配理由 (简短说明)
   - candidates: 候选类目列表 (最多3个，每个含description_category_id, type_id, label)

只返回JSON，不要其他文字。"""
    else:
        # 多信号模式：source_category 为空，主要依赖标题+描述
        system_prompt = """你是一个跨境电商类目匹配专家。采集器未抓到商品的原始分类，你需要根据商品标题和描述，从Ozon平台的类目列表中选择最匹配的类目。

规则：
1. 仔细分析商品标题和描述，理解商品的真正品类（注意标题可能是俄文）
2. 从提供的Ozon类目列表中选择最匹配的类目
3. 如果有多个候选，选择最精准（最深层级）的匹配
4. 即使不确定也要给出最可能的候选，返回JSON格式，包含以下字段：
   - matched: 是否匹配成功 (true/false)
   - description_category_id: Ozon二级类目ID (数字)
   - type_id: Ozon三级类型ID (数字)
   - label: 匹配的类目路径 (如 "服装和鞋类 > 男士服装 > T恤")
   - confidence: 置信度 ("high"/"medium"/"low")
   - reason: 匹配理由 (简短说明)
   - candidates: 候选类目列表 (最多3个，每个含description_category_id, type_id, label)

只返回JSON，不要其他文字。"""

    user_prompt = f"""{product_info}

Ozon类目列表（格式: [二级类目ID_三级类型ID] 类目路径）:
{cat_list_text}

请为该商品选择最匹配的Ozon类目。"""

    messages = [
        {'role': 'system', 'content': system_prompt},
        {'role': 'user', 'content': user_prompt},
    ]

    # 6. 调用 AI API
    try:
        print(f'[AI匹配] 调用 {config["model"]} 匹配类目: source={source_category[:30]}...')
        ai_response = _call_ai_api(messages, temperature=0.1)
        print(f'[AI匹配] AI返回: {ai_response}')

        # 解析 AI 返回的 JSON
        result = json.loads(ai_response)

        # 标准化返回格式
        matched = result.get('matched', False)
        confidence = result.get('confidence', 'low')

        final_result = {
            'matched': matched and confidence in ('high', 'medium'),
            'confidence': confidence,
            'label': result.get('label', ''),
            'description_category_id': result.get('description_category_id'),
            'type_id': result.get('type_id'),
            'reason': result.get('reason', ''),
            'candidates': result.get('candidates', []),
            '_source': 'ai',
        }

        # 如果匹配成功，确保 ID 是整数
        if final_result['matched']:
            if final_result.get('description_category_id'):
                final_result['description_category_id'] = int(final_result['description_category_id'])
            if final_result.get('type_id'):
                final_result['type_id'] = int(final_result['type_id'])

        # 7. 缓存结果到 SQLite（与关键词匹配共享缓存层）
        _save_cached_match(source_category, title, final_result)

        return final_result

    except urllib.error.HTTPError as e:
        error_body = e.read().decode('utf-8', errors='replace')
        print(f'[AI匹配] API请求失败: HTTP {e.code} - {error_body[:200]}')
        return {'matched': False, 'candidates': [], 'reason': f'API请求失败: HTTP {e.code}'}
    except json.JSONDecodeError as e:
        print(f'[AI匹配] AI返回解析失败: {e}')
        return {'matched': False, 'candidates': [], 'reason': f'AI返回解析失败: {e}'}
    except Exception as e:
        print(f'[AI匹配] 匹配失败: {e}')
        return {'matched': False, 'candidates': [], 'reason': str(e)}
