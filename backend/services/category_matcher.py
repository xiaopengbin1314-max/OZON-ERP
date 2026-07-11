"""
Ozon 类目匹配服务（重构版）

替代原 ozon_api.match_category 中的混乱逻辑，采用严格分层匹配策略：

  层 1: SQLite 缓存查询（category_mappings 表）
  层 2: 静态精确映射表（GENERAL_MAPPINGS，子串匹配）
  层 3: 语言感知的精确名称匹配（中文/俄文/混合，L3→L2→包含匹配）
  层 4: 同义词扩展 + 关键词打分匹配（仅对中文做同义词扩展）
  层 5: AI 语义匹配（兜底）

设计原则：
  - 严格分层、不短路：上一层的失败不影响下一层尝试
    （修复原代码中 ru_no_match 短路导致中文源永远跳过关键词匹配的 BUG）
  - 语言感知：根据源分类文本语言选择匹配字段
    · 俄文 → 优先俄文字段（type_name_ru / category_name_ru）
    · 中文 → 优先中文字段 + 同义词扩展
    · 混合/未知 → 双语字段都尝试
  - 统一返回格式，便于上游处理
  - 低置信度的候选会保留并传递给下一层作为参考

返回结果统一格式：
  {
    matched: bool,                      # 是否匹配成功
    description_category_id: int,       # Ozon 二级类目 ID（L2）
    type_id: int,                       # Ozon 三级类型 ID（L3）
    label: str,                         # "L1中文 / L2中文 / L3中文"
    confidence: 'high'|'medium'|'low',  # 置信度
    candidates: list,                   # 候选类目列表
    reason: str,                        # 未匹配原因（仅 matched=False 时）
    _source: str,                       # 匹配来源标记
  }
"""
import re
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(__file__)))
from data.category_mapping_general import SYNONYM_MAP, GENERAL_MAPPINGS


# ============================================================================
# 1. 语言检测与文本归一化
# ============================================================================

def _detect_language(text):
    """检测文本主要语言

    Returns:
        'ru'      - 俄文（含西里尔字母为主）
        'zh'      - 中文（含 CJK 字符为主）
        'mixed'   - 中俄混合
        'unknown' - 未知（如纯英文/数字/符号）
    """
    if not text:
        return 'unknown'

    cyrillic = sum(1 for c in text if '\u0400' <= c <= '\u04ff')
    cjk = sum(1 for c in text if '\u4e00' <= c <= '\u9fff')

    if cyrillic > 0 and cjk > 0:
        return 'mixed'
    if cyrillic > 0:
        return 'ru'
    if cjk > 0:
        return 'zh'
    return 'unknown'


def _normalize_ru_word(w):
    """俄文复数归一化（简单版）

    例：газонокосилки → газонокосилка
    """
    w = w.lower().strip()
    if w.endswith('ки'):
        return w[:-2] + 'ка'
    if w.endswith('и') and len(w) > 3:
        return w[:-1] + 'а'
    if w.endswith('ы') and len(w) > 3:
        return w[:-1]
    return w


def _split_keywords(text):
    """将分类路径拆分为关键词

    支持多种分隔符: > / > 、 | ，, 空格
    返回小写关键词列表（保留原序，去重）

    用于关键词打分匹配（层 4），需要拆分到单词级别。
    """
    if not text:
        return []
    parts = re.split(r'[>/、|，,\s]+', text)
    seen = set()
    out = []
    for p in parts:
        p = p.strip().lower()
        if p and p not in seen:
            seen.add(p)
            out.append(p)
    return out


def _split_path_segments(text):
    """将分类路径拆分为路径段（仅按路径分隔符拆分，不拆分空格）

    用于精确名称匹配（层 3），保留多词类目名的完整性。
    例: "Сад и огород > Газонокосилки" → ["сад и огород", "газонокосилки"]
        "Плюшевый медведь" → ["плюшевый медведь"]

    支持的路径分隔符: > / 、 |

    逗号不能作为路径分隔符，因为大量真实类目名称本身含逗号，
    例如 "Мебель антиквариат, винтаж"。
    """
    if not text:
        return []
    parts = re.split(r'[>/、|]+', text)
    seen = set()
    out = []
    for p in parts:
        p = p.strip().lower()
        if p and p not in seen:
            seen.add(p)
            out.append(p)
    return out


# ============================================================================
# 2. 类目树扁平化
# ============================================================================

def _build_flat_categories(tree):
    """构建扁平化类目列表

    将三级嵌套树展开为列表，每个元素包含 L1/L2/L3 的中俄文名，
    便于后续匹配打分使用。

    返回: [
        {
            description_category_id, type_id,
            l1_name_zh, l1_name_ru,
            l2_name_zh, l2_name_ru,
            l3_name_zh, l3_name_ru,
            label,  # "L1中文 / L2中文 / L3中文"
        }
    ]
    """
    flat = []
    for l1 in tree:
        l1_zh = (l1.get('category_name_zh') or '').strip()
        l1_ru = (l1.get('category_name_ru') or '').strip().lower()
        for l2 in (l1.get('children') or []):
            l2_id = l2.get('description_category_id')
            if not l2_id:
                continue
            l2_zh = (l2.get('category_name_zh') or '').strip()
            l2_ru = (l2.get('category_name_ru') or '').strip().lower()
            for l3 in (l2.get('children') or []):
                type_id = l3.get('type_id')
                if not type_id:
                    continue
                l3_zh = (l3.get('type_name_zh') or '').strip()
                l3_ru = (l3.get('type_name_ru') or '').strip().lower()
                flat.append({
                    'description_category_id': l2_id,
                    'type_id': type_id,
                    'l1_name_zh': l1_zh,
                    'l1_name_ru': l1_ru,
                    'l2_name_zh': l2_zh,
                    'l2_name_ru': l2_ru,
                    'l3_name_zh': l3_zh,
                    'l3_name_ru': l3_ru,
                    'label': f"{l1_zh} / {l2_zh} / {l3_zh}",
                })
    return flat


# ============================================================================
# 3. 配件类排除（俄文）
# ============================================================================

_ACCESSORY_KEYWORDS_RU = {
    'для', 'запчасть', 'ограничитель', 'механическая', 'принадлежность',
    'аксессуар', 'ремонт', 'комплект',
}


def _is_accessory_name_ru(name):
    """判断俄文 L3 名是否为配件类（避免主商品词误匹配到配件）"""
    n = name.lower()
    for kw in _ACCESSORY_KEYWORDS_RU:
        if kw in n:
            return True
    return False


# ============================================================================
# 层 1: SQLite 缓存查询
# ============================================================================

def _try_cache(source_category, source_platform=''):
    """从 SQLite 缓存查询已匹配结果"""
    try:
        from services.category_mapping_cache import get_mapping
        if not str(source_category or '').strip():
            return None
        cached = get_mapping(source_category or '', source_platform or '')
        if cached:
            cached['_source'] = 'cache'
            return cached
    except Exception as e:
        print(f'[类目匹配] 缓存查询异常: {e}')
    return None


def _save_to_cache(source_category, result, source_platform=''):
    """保存匹配结果到缓存（仅成功匹配的结果）"""
    if (not str(source_category or '').strip() or not result or not result.get('matched')
            or str(result.get('confidence') or 'low').lower() not in ('high', 'medium')):
        return
    try:
        from services.category_mapping_cache import set_mapping
        set_mapping(source_category or '', source_platform or '', result)
    except Exception as e:
        print(f'[类目匹配] 缓存写入异常: {e}')


# ============================================================================
# 层 2: 静态精确映射表
# ============================================================================

def _try_general_mappings(source_category):
    """从静态映射表查询（GENERAL_MAPPINGS）

    source_patterns 为子串匹配，命中即返回高置信度结果。
    适用于任何语言的源分类（中文/俄文均可）。
    """
    if not source_category:
        return None
    match_text = source_category.lower()
    for mapping in GENERAL_MAPPINGS:
        if not mapping.get('description_category_id') or not mapping.get('type_id'):
            continue
        for pattern in mapping.get('source_patterns', []):
            if pattern.lower() in match_text:
                return {
                    'matched': True,
                    'description_category_id': mapping['description_category_id'],
                    'type_id': mapping['type_id'],
                    'label': mapping.get('label', ''),
                    'confidence': 'high',
                    'candidates': [],
                    '_source': 'general',
                }
    return None


# ============================================================================
# 层 3: 语言感知的精确名称匹配
# ============================================================================

def _try_exact_name_match(source_category, flat_cats, lang):
    """语言感知的精确名称匹配

    根据源语言选择匹配字段（中文字段或俄文字段），按以下优先级尝试：
      优先级 1: L3 精确等于（含俄文复数归一化） → high
      优先级 2: L2 精确等于 → medium（返回该 L2 下所有 L3 候选）
      优先级 3: L3 包含匹配（排除配件类 + 比例阈值） → high/medium/low

    Args:
        source_category: 源分类文本
        flat_cats: 扁平化类目列表
        lang: 源语言 ('ru'/'zh'/'mixed'/'unknown')

    Returns:
        匹配结果 dict 或 None
    """
    if not source_category or not flat_cats:
        return None

    # 使用路径段拆分（不拆分空格），保留多词类目名的完整性
    segments = _split_path_segments(source_category)
    if not segments:
        return None
    main_kw = segments[-1]  # 路径最后一段通常是叶子类目
    main_kw_norm = _normalize_ru_word(main_kw)

    # 根据语言选择字段后缀
    if lang == 'ru':
        suffixes = ['_ru']
    elif lang == 'zh':
        suffixes = ['_zh']
    else:
        # mixed/unknown: 两个字段都尝试
        suffixes = ['_ru', '_zh']

    # === 优先级 1: L3 精确匹配（含俄文复数归一化）===
    # 同一个 L3 名称可能存在于多个父路径，必须先收集全部命中再消歧。
    exact_l3_matches = []
    exact_seen = set()
    for suffix in suffixes:
        l3_field = f'l3_name{suffix}'
        for cat in flat_cats:
            l3_name = (cat.get(l3_field) or '').lower().strip()
            if not l3_name:
                continue
            is_exact = l3_name == main_kw
            is_normalized = suffix == '_ru' and _normalize_ru_word(l3_name) == main_kw_norm
            if is_exact or is_normalized:
                key = (cat['description_category_id'], cat['type_id'])
                if key not in exact_seen:
                    exact_seen.add(key)
                    exact_l3_matches.append((cat, suffix, is_normalized and not is_exact))

    if exact_l3_matches:
        selected = None
        if len(exact_l3_matches) == 1:
            selected = exact_l3_matches[0]
        elif len(segments) > 1:
            parent_segments = set(segments[:-1])
            scored = []
            for candidate in exact_l3_matches:
                cat, suffix, _ = candidate
                parent_names = {
                    str(cat.get(f'l1_name{suffix}') or '').lower().strip(),
                    str(cat.get(f'l2_name{suffix}') or '').lower().strip(),
                }
                score = len(parent_segments & parent_names)
                scored.append((score, candidate))
            scored.sort(key=lambda item: -item[0])
            if scored and scored[0][0] > 0 and (len(scored) == 1 or scored[0][0] > scored[1][0]):
                selected = scored[0][1]

        if selected:
            cat, suffix, normalized_only = selected
            return {
                'matched': True,
                'description_category_id': cat['description_category_id'],
                'type_id': cat['type_id'],
                'label': cat['label'],
                'confidence': 'high',
                'candidates': [],
                '_source': 'exact_l3_ru_norm' if normalized_only else f'exact_l3{suffix}',
            }

        return {
            'matched': False,
            'confidence': 'medium',
            'candidates': [
                {
                    'description_category_id': cat['description_category_id'],
                    'type_id': cat['type_id'],
                    'label': cat['label'],
                }
                for cat, _, _ in exact_l3_matches[:10]
            ],
            'reason': '存在多个同名 L3 类目，请根据完整父级路径选择',
            '_source': 'ambiguous_exact_l3',
        }

    # === 优先级 2: L2 精确匹配（返回该 L2 下所有 L3 候选）===
    for suffix in suffixes:
        l2_field = f'l2_name{suffix}'
        for cat in flat_cats:
            l2_name = (cat.get(l2_field) or '').lower().strip()
            if not l2_name:
                continue
            matched_l2 = (l2_name == main_kw)
            if not matched_l2 and suffix == '_ru':
                matched_l2 = (_normalize_ru_word(l2_name) == main_kw_norm)
            if matched_l2:
                l2_id = cat['description_category_id']
                # 收集该 L2 下所有 L3 候选
                l3_candidates = []
                seen_ids = set()
                for c in flat_cats:
                    if c['description_category_id'] == l2_id and c['type_id'] not in seen_ids:
                        seen_ids.add(c['type_id'])
                        l3_candidates.append({
                            'description_category_id': c['description_category_id'],
                            'type_id': c['type_id'],
                            'label': c['label'],
                        })
                        if len(l3_candidates) >= 10:
                            break
                # label 去掉最后的 L3 段
                parent_label = cat['label'].rsplit(' / ', 1)[0] if ' / ' in cat['label'] else cat['label']
                return {
                    'matched': False,  # L2 匹配但 L3 未确定
                    'description_category_id': l2_id,
                    'label': parent_label,
                    'confidence': 'medium',
                    'candidates': l3_candidates[:10],
                    'reason': 'L2 类目精确匹配，请选择具体的 L3 类型',
                    '_source': f'exact_l2{suffix}',
                }

    # === 优先级 3: L3 包含匹配（排除配件类 + 比例阈值）===
    candidates_partial = []
    seen_keys = set()
    for suffix in suffixes:
        l3_field = f'l3_name{suffix}'
        for cat in flat_cats:
            l3_name = (cat.get(l3_field) or '').lower().strip()
            if not l3_name:
                continue
            # 排除配件类（仅对俄文字段）
            if suffix == '_ru' and _is_accessory_name_ru(l3_name):
                continue
            # 双向子串匹配
            if not (main_kw in l3_name or l3_name in main_kw):
                continue

            ratio = len(main_kw) / max(len(l3_name), 1)
            # 源词是 L3 子串但占比 < 50%，跳过（避免短词误匹配长 L3 名）
            if main_kw in l3_name and ratio < 0.5:
                continue

            cat_key = f"{cat['description_category_id']}_{cat['type_id']}"
            if cat_key in seen_keys:
                continue
            seen_keys.add(cat_key)

            if main_kw == l3_name:
                score = 100
            elif suffix == '_ru' and _normalize_ru_word(l3_name) == main_kw_norm:
                score = 95
            elif main_kw in l3_name:
                score = int(60 + ratio * 30)
            else:
                # L3 名是源词的子串
                score = int(50 + ratio * 20)

            candidates_partial.append({
                'description_category_id': cat['description_category_id'],
                'type_id': cat['type_id'],
                'label': cat['label'],
                'score': score,
            })

    if candidates_partial:
        candidates_partial.sort(key=lambda x: -x['score'])
        best = candidates_partial[0]
        confidence = 'high' if best['score'] >= 80 else ('medium' if best['score'] >= 60 else 'low')
        if confidence == 'low':
            return {
                'matched': False,
                'confidence': 'low',
                'candidates': candidates_partial[:10],
                'reason': 'L3 包含匹配置信度低，请选择具体类目',
                '_source': 'partial_l3',
            }
        return {
            'matched': True,
            'description_category_id': best['description_category_id'],
            'type_id': best['type_id'],
            'label': best['label'],
            'confidence': confidence,
            'candidates': candidates_partial[:5],
            '_source': 'partial_l3',
        }

    return None


# ============================================================================
# 层 4: 同义词扩展 + 关键词打分匹配
# ============================================================================

def _try_keyword_scoring(source_category, flat_cats, lang):
    """同义词扩展 + 关键词打分匹配

    对中文源分类做同义词扩展（SYNONYM_MAP），然后对每个类目的中俄文
    名称做关键词匹配，按匹配层级（L3 > L2 > L1）加权打分。

    置信度阈值：
      score >= 20 → high
      score >= 10 → medium
      score <  10 → low
    仅 high/medium 视为匹配成功。

    Args:
        source_category: 源分类文本
        flat_cats: 扁平化类目列表
        lang: 源语言（仅对 zh/mixed/unknown 做同义词扩展）

    Returns:
        匹配结果 dict 或 None
    """
    if not source_category or not flat_cats:
        return None

    keywords = _split_keywords(source_category)
    if not keywords:
        return None

    # 同义词扩展（仅对中文关键词）
    expanded_keywords = list(keywords)
    if lang in ('zh', 'mixed', 'unknown'):
        for kw in keywords:
            if kw in SYNONYM_MAP:
                for syn in SYNONYM_MAP[kw].split():
                    syn_l = syn.lower()
                    if syn_l not in expanded_keywords:
                        expanded_keywords.append(syn_l)

    scored = []
    for cat in flat_cats:
        l3_zh = (cat.get('l3_name_zh') or '').lower()
        l3_ru = (cat.get('l3_name_ru') or '').lower()
        l2_zh = (cat.get('l2_name_zh') or '').lower()
        l2_ru = (cat.get('l2_name_ru') or '').lower()
        l1_zh = (cat.get('l1_name_zh') or '').lower()
        l1_ru = (cat.get('l1_name_ru') or '').lower()

        # 搜索文本包含所有层级的中俄文名
        search_text = ' '.join(t for t in [l1_zh, l1_ru, l2_zh, l2_ru, l3_zh, l3_ru] if t)

        score = 0
        matched_original = 0
        matched_expanded = 0
        has_exact_l3 = False

        for i, kw in enumerate(expanded_keywords):
            if len(kw) < 2:
                continue
            if kw not in search_text:
                continue

            is_original = i < len(keywords)
            weight = 1.0 if is_original else 0.6

            # 精确匹配 L3 中文名或俄文名
            if kw == l3_zh or kw == l3_ru:
                score += 25 * weight
                has_exact_l3 = True
            # 包含匹配 L3
            elif kw in l3_zh or kw in l3_ru:
                l3_len = max(len(l3_zh), len(l3_ru))
                if l3_len > 0 and len(kw) / l3_len >= 0.5:
                    score += 12 * weight
                else:
                    score += 6 * weight
            # 精确匹配 L2
            elif kw == l2_zh or kw == l2_ru:
                score += 10 * weight
            # 包含匹配 L2
            elif kw in l2_zh or kw in l2_ru:
                score += 5 * weight
            # 匹配 L1
            elif kw in l1_zh or kw in l1_ru:
                score += 3 * weight
            else:
                score += 2 * weight

            if is_original:
                matched_original += 1
            else:
                matched_expanded += 1

        # 精确匹配 L3 名称的额外加分
        if has_exact_l3:
            score += 15
        # 所有原始关键词都匹配的加分
        if matched_original == len(keywords) and matched_original > 1:
            score += 10
        elif matched_original > 0 and matched_expanded > 0:
            score += 5

        if score > 0:
            cat_copy = dict(cat)
            cat_copy['score'] = score
            scored.append(cat_copy)

    if not scored:
        return None

    scored.sort(key=lambda x: x['score'], reverse=True)
    best = scored[0]
    max_score = best['score']

    if max_score >= 20:
        confidence = 'high'
    elif max_score >= 10:
        confidence = 'medium'
    else:
        confidence = 'low'

    matched = confidence in ('high', 'medium')

    result = {
        'matched': matched,
        'confidence': confidence,
        'candidates': [],
        '_source': 'keyword',
    }

    if matched:
        result['description_category_id'] = best['description_category_id']
        result['type_id'] = best['type_id']
        result['label'] = best['label']

    # 候选列表（去重，最多 5 个）
    seen = set()
    for item in scored[:10]:
        key = f"{item['description_category_id']}_{item['type_id']}"
        if key not in seen:
            seen.add(key)
            result['candidates'].append({
                'description_category_id': item['description_category_id'],
                'type_id': item['type_id'],
                'label': item['label'],
                'score': item['score'],
            })
            if len(result['candidates']) >= 5:
                break

    return result


# ============================================================================
# 层 5: AI 语义匹配（兜底）
# ============================================================================

def _try_ai_match(source_category, tree, title='', description=''):
    """AI 语义匹配（兜底）

    当所有规则匹配层都未成功时，调用 AI 大模型进行语义匹配。
    多信号输入：source_category 为主信号，title/description 为辅助信号，
    对齐妙手 ERP 的做法（仅传类目时置信度低 10-20 分，传入标题+描述可显著提升命中率）。

    注意：当 source_category 为空（采集器未抓到类目）时，title+description
    仍可作为唯一信号走 AI 匹配，这是"多信号匹配"的核心场景。
    """
    try:
        from services.ai_category_matcher import ai_match_category
    except Exception as e:
        print(f'[类目匹配] AI 模块导入失败: {e}')
        return None
    try:
        return ai_match_category(
            source_category=source_category,
            title=title or '',
            description=description or '',
            tree=tree,
        )
    except Exception as e:
        print(f'[类目匹配] AI 匹配异常: {e}')
        return None


# ============================================================================
# 候选合并工具
# ============================================================================

def _merge_candidates(*results, max_count=5):
    """合并多个匹配结果的候选列表（去重）

    Args:
        *results: 多个匹配结果 dict（取其 candidates 字段）
        max_count: 最大返回数量

    Returns:
        合并去重后的候选列表
    """
    merged = []
    seen = set()
    for res in results:
        if not res:
            continue
        for c in res.get('candidates', []) or []:
            key = f"{c.get('description_category_id')}_{c.get('type_id')}"
            if key in seen:
                continue
            seen.add(key)
            merged.append({
                'description_category_id': c.get('description_category_id'),
                'type_id': c.get('type_id'),
                'label': c.get('label', ''),
                'score': c.get('score', 0),
            })
            if len(merged) >= max_count:
                break
        if len(merged) >= max_count:
            break
    return merged


# ============================================================================
# 主入口：match_category
# ============================================================================

def match_category(source_category, source_platform='ozon', title='', tree=None, description=''):
    """根据采集的原始分类名称，自动匹配 Ozon 类目树中的类目

    分层匹配策略（严格分层，不短路）：
      层 1: SQLite 缓存查询
      层 2: 静态精确映射表（GENERAL_MAPPINGS）
      层 3: 语言感知的精确名称匹配（L3→L2→包含匹配）
      层 4: 同义词扩展 + 关键词打分匹配
      层 5: AI 语义匹配（兜底，多信号）

    多信号匹配（对齐妙手 ERP 做法）：
      - 主信号：source_category（采集的原始类目）
      - 辅助信号：title + description
      - 当 source_category 非空：层 1-4 用类目匹配，层 5 AI 用类目+标题+描述
      - 当 source_category 为空但 title/description 非空：跳过层 1-4，直接走层 5
        AI 多信号匹配（采集器未抓到类目时的兜底路径）
      - 当三者都为空：返回未匹配

    Args:
        source_category: 采集的原始分类名（中文/俄文/混合）
        source_platform: 来源平台（ozon/1688/taobao）
        title: 商品标题（多信号辅助）
        tree: 已加载的类目树（可选，避免重复加载）
        description: 商品描述（多信号辅助）

    Returns:
        匹配结果 dict，结构见模块顶部文档说明
    """
    # 多信号：source_category 为空但 title/description 有值时走 AI 兜底
    if not source_category:
        if not (title or '').strip() and not (description or '').strip():
            return {'matched': False, 'candidates': [], 'reason': '缺少产品类目信息'}
        # 采集器未抓到类目，但有标题/描述 → 走 AI 多信号匹配
        print(f'[类目匹配] source_category 为空，启用多信号 AI 匹配 '
              f'(title={title[:40]!r}, platform={source_platform})')
        try:
            from services.ozon_api import get_category_tree_bilingual
            if tree is None:
                tree = get_category_tree_bilingual(use_cache=True)
        except Exception as e:
            print(f'[类目匹配] 加载类目树失败: {e}')
            return {'matched': False, 'candidates': [], 'reason': f'加载类目树失败: {e}'}
        if not tree:
            return {'matched': False, 'candidates': [], 'reason': '类目树为空'}
        ai_result = _try_ai_match('', tree, title=title, description=description)
        if ai_result and ai_result.get('matched'):
            ai_result.setdefault('_source', 'ai_multi_signal')
            print(f'[类目匹配] 多信号 AI 匹配成功: {ai_result.get("label", "")}')
            _save_to_cache(source_category or '', ai_result, source_platform)
            return ai_result
        if ai_result and ai_result.get('candidates'):
            return ai_result
        return {
            'matched': False,
            'candidates': [],
            'reason': '多信号 AI 匹配未找到候选',
            '_source': 'no_match_multi_signal',
        }

    # === 层 1: 缓存查询 ===
    cached = _try_cache(source_category, source_platform)
    if cached:
        print(f'[类目匹配] 命中缓存: {cached.get("label", "")}')
        return cached

    # === 层 2: 静态精确映射表 ===
    general_result = _try_general_mappings(source_category)
    if general_result and general_result.get('matched'):
        print(f'[类目匹配] 命中通用映射表: {general_result.get("label", "")}')
        _save_to_cache(source_category, general_result, source_platform)
        return general_result

    # 加载类目树（层 3+ 需要）
    if tree is None:
        try:
            from services.ozon_api import get_category_tree_bilingual, OzonAPIError
            tree = get_category_tree_bilingual(use_cache=True)
        except Exception as e:
            print(f'[类目匹配] 加载类目树失败: {e}')
            return {'matched': False, 'candidates': [], 'reason': f'加载类目树失败: {e}'}

    if not tree:
        return {'matched': False, 'candidates': [], 'reason': '类目树为空'}

    flat_cats = _build_flat_categories(tree)
    if not flat_cats:
        return {'matched': False, 'candidates': [], 'reason': '类目列表为空'}

    # 检测源语言
    lang = _detect_language(source_category)
    print(f'[类目匹配] 源语言={lang}, platform={source_platform}, source={source_category[:60]!r}')

    # === 层 3: 语言感知的精确名称匹配 ===
    exact_result = _try_exact_name_match(source_category, flat_cats, lang)
    if exact_result and exact_result.get('matched') and exact_result.get('confidence') in ('high', 'medium'):
        print(f'[类目匹配] 精确名称匹配成功: {exact_result.get("label", "")} '
              f'(置信度 {exact_result.get("confidence", "")}, 来源 {exact_result.get("_source", "")})')
        _save_to_cache(source_category, exact_result, source_platform)
        return exact_result
    # 低置信度或有候选但未匹配 → 保留候选，继续尝试关键词匹配

    # === 层 4: 同义词扩展 + 关键词打分匹配 ===
    keyword_result = _try_keyword_scoring(source_category, flat_cats, lang)
    if keyword_result and keyword_result.get('matched'):
        print(f'[类目匹配] 关键词匹配成功: {keyword_result.get("label", "")} '
              f'(置信度 {keyword_result.get("confidence", "")})')
        _save_to_cache(source_category, keyword_result, source_platform)
        return keyword_result

    # === 层 5: AI 语义匹配（兜底，多信号）===
    print(f'[类目匹配] 前 4 层未成功，尝试 AI 匹配... '
          f'(附带 title={bool(title)}, description={bool(description)})')
    ai_result = _try_ai_match(source_category, tree, title=title, description=description)
    if ai_result and ai_result.get('matched'):
        # 合并层 3、层 4 的候选给 AI 结果作参考
        merged = _merge_candidates(exact_result, keyword_result, max_count=3)
        ai_result.setdefault('candidates', [])
        for c in merged:
            key = f"{c.get('description_category_id')}_{c.get('type_id')}"
            if not any(f"{x.get('description_category_id')}_{x.get('type_id')}" == key
                       for x in ai_result['candidates']):
                ai_result['candidates'].append(c)
        print(f'[类目匹配] AI 匹配成功: {ai_result.get("label", "")}')
        _save_to_cache(source_category, ai_result, source_platform)
        return ai_result

    # === 所有层都未成功：返回最佳候选 ===
    all_candidates = _merge_candidates(exact_result, keyword_result, ai_result, max_count=10)

    # 优先返回 AI 的 reason（通常更有说明性）
    reason = '所有匹配层均未找到候选'
    if ai_result and ai_result.get('reason'):
        reason = ai_result['reason']
    elif keyword_result and keyword_result.get('reason'):
        reason = keyword_result['reason']
    elif exact_result and exact_result.get('reason'):
        reason = exact_result['reason']

    print(f'[类目匹配] 全部未成功，返回 {len(all_candidates)} 个候选')

    return {
        'matched': False,
        'confidence': 'low',
        'candidates': all_candidates,
        'reason': reason,
        '_source': 'no_match',
    }
