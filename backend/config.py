"""
GeekOzon ERP - 应用配置模块
管理环境变量、路径配置、应用常量
"""
import os

# 基础路径
BASE_DIR = os.path.dirname(os.path.abspath(__file__))
DATA_DIR = os.path.join(BASE_DIR, 'data')

# 确保 data 目录存在
os.makedirs(DATA_DIR, exist_ok=True)

# 加载 .env 文件（如果存在）
_env_file = os.path.join(BASE_DIR, '.env')
if os.path.exists(_env_file):
    with open(_env_file, 'r', encoding='utf-8') as f:
        for line in f:
            line = line.strip()
            if not line or line.startswith('#'):
                continue
            if '=' in line:
                key, val = line.split('=', 1)
                key = key.strip()
                val = val.strip().strip('"').strip("'")
                if key and key not in os.environ:
                    os.environ[key] = val

# Flask 配置
class Config:
    """开发环境配置"""
    # DEBUG 默认关闭，通过环境变量 FLASK_DEBUG=1 显式开启
    DEBUG = os.environ.get('FLASK_DEBUG', '0') == '1'

    # SECRET_KEY：优先读环境变量；未配置时生成随机值并打印警告（生产必须显式配置）
    SECRET_KEY = os.environ.get('SECRET_KEY', '')
    if not SECRET_KEY:
        import secrets as _secrets
        SECRET_KEY = _secrets.token_hex(32)
        print('[安全警告] SECRET_KEY 未配置，已生成临时随机密钥。'
              '会话将在重启后失效，请在 .env 中设置固定的 SECRET_KEY。')

    # CORS 允许的来源（逗号分隔）。
    # 本地 ERP 后端：浏览器扩展 content_script 运行在电商页面上下文（detail.1688.com / www.ozon.ru 等），
    # 从这些 origin 直连 http://localhost:5000 时需通过 CORS 预检。
    # 因此默认放开所有源（*）；若需收敛，可在 .env 中显式指定 CORS_ALLOWED_ORIGINS。
    CORS_ALLOWED_ORIGINS = [
        o.strip() for o in os.environ.get(
            'CORS_ALLOWED_ORIGINS', '*'
        ).split(',') if o.strip()
    ] or ['*']

    # 数据文件路径
    PRODUCTS_FILE = os.path.join(DATA_DIR, 'products.json')
    NOTICES_FILE = os.path.join(DATA_DIR, 'notices.json')
    USERS_FILE = os.path.join(DATA_DIR, 'users.json')
    PUBLISH_TASKS_FILE = os.path.join(DATA_DIR, 'publish_tasks.json')
    PUBLISH_RECORDS_FILE = os.path.join(DATA_DIR, 'publish_records.json')

    # 数据库配置
    DB_PATH = os.path.join(DATA_DIR, 'geekozon.db')

    # 分页默认值
    DEFAULT_PAGE = 1
    DEFAULT_PAGE_SIZE = 10
    MAX_PAGE_SIZE = 100

    # Token 有效期（小时）
    TOKEN_EXPIRE_HOURS = 24

    # ===== AI 类目匹配配置 =====
    # 支持的提供商: deepseek / qwen
    AI_PROVIDER = os.environ.get('AI_PROVIDER', 'deepseek')

    # DeepSeek 配置 (https://platform.deepseek.com)
    DEEPSEEK_API_KEY = os.environ.get('DEEPSEEK_API_KEY', '')
    DEEPSEEK_BASE_URL = 'https://api.deepseek.com/v1'
    DEEPSEEK_MODEL = 'deepseek-chat'

    # 通义千问配置 (https://dashscope.console.aliyun.com)
    QWEN_API_KEY = os.environ.get('QWEN_API_KEY', '')
    QWEN_BASE_URL = 'https://dashscope.aliyuncs.com/compatible-mode/v1'
    QWEN_MODEL = 'qwen-plus'

    # AI 匹配缓存文件（已弃用：AI 匹配结果现统一存入 SQLite category_mappings 表）
    AI_CATEGORY_CACHE_FILE = os.path.join(DATA_DIR, 'ai_category_cache.json')

    # ===== 图片托管配置 =====
    # 图片上传目录
    UPLOAD_DIR = os.path.join(DATA_DIR, 'uploads')
    # 图片访问基础 URL（用于生成公网可访问的图片 URL）
    # 本地开发时留空则自动用 http://localhost:5000
    # 公网部署时配置为实际域名，如 https://erp.example.com
    # 使用内网穿透时配置为穿透地址，如 https://xxx.ngrok.io
    IMAGE_BASE_URL = os.environ.get('IMAGE_BASE_URL', '')
    # 单张图片大小限制（字节），默认 10MB
    MAX_IMAGE_SIZE = 10 * 1024 * 1024

    # ===== 对象存储配置（可选，生产环境推荐）=====
    # 存储类型: local（默认本地存储）/ qiniu（七牛云对象存储）
    # 配置为 qiniu 后，图片转存时自动上传到七牛云，返回永久公网 URL
    # 七牛云注册: https://portal.qiniu.com （有免费 10GB 额度）
    OBJECT_STORAGE_TYPE = os.environ.get('OBJECT_STORAGE_TYPE', 'local')
    # 七牛云凭证
    QINIU_ACCESS_KEY = os.environ.get('QINIU_ACCESS_KEY', '')
    QINIU_SECRET_KEY = os.environ.get('QINIU_SECRET_KEY', '')
    QINIU_BUCKET = os.environ.get('QINIU_BUCKET', '')
    # 七牛云绑定域名（CDN 加速域名），如 https://cdn.example.com
    QINIU_DOMAIN = os.environ.get('QINIU_DOMAIN', '')

    # ===== 价格换算配置 =====
    # 采集 1688 商品时，货源价为人民币(CNY)
    # 根据店铺合同币种自动选择汇率：
    #   - CNY 店铺：汇率=1（无需换算，仅加利润率）
    #   - RUB 店铺：汇率≈12~13（CNY→RUB，按实际配置）
    # 汇率和利润率均可在 .env 中配置，或通过 /api/config/pricing 接口动态调整
    EXCHANGE_RATE_CNY_TO_RUB = float(os.environ.get('EXCHANGE_RATE_CNY_TO_RUB', '12.5'))
    PROFIT_MARGIN = float(os.environ.get('PROFIT_MARGIN', '1.3'))
    # 划线价系数（建议售价 × 此系数 = 划线价）
    OLD_PRICE_RATIO = float(os.environ.get('OLD_PRICE_RATIO', '1.2'))


class ProductionConfig(Config):
    """生产环境配置"""
    DEBUG = False
    # 生产环境 SECRET_KEY 必须显式配置，否则启动时已生成随机值并告警
    SECRET_KEY = os.environ.get('SECRET_KEY', Config.SECRET_KEY)
