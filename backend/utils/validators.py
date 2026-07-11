"""
请求参数校验工具模块
提供常用字段验证函数，用于接口层参数校验
"""


def validate_required(value, field_name):
    """校验必填字段"""
    if value is None or (isinstance(value, str) and not value.strip()):
        raise ValueError(f"{field_name} 不能为空")
    return value.strip() if isinstance(value, str) else value


def validate_url(url, field_name="url"):
    """校验 URL 格式"""
    if url and not url.startswith(("http://", "https://")):
        raise ValueError(f"{field_name} 必须以 http:// 或 https:// 开头")
    return url


def validate_page(page):
    """校验分页页码"""
    try:
        p = int(page)
        if p < 1:
            raise ValueError
        return p
    except (ValueError, TypeError):
        return 1


def validate_page_size(size):
    """校验分页大小"""
    from config import Config
    try:
        s = int(size)
        if s < 1:
            s = Config.DEFAULT_PAGE_SIZE
        elif s > Config.MAX_PAGE_SIZE:
            s = Config.MAX_PAGE_SIZE
        return s
    except (ValueError, TypeError):
        return Config.DEFAULT_PAGE_SIZE


def extract_pagination(request_args):
    """从请求参数中提取分页信息"""
    return {
        "page": validate_page(request_args.get('page')),
        "pageSize": validate_page_size(request_args.get('pageSize')),
    }
