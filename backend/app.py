"""
Flask 应用主入口
GeekOzon ERP 后端服务的启动文件
同时提供前端静态文件服务，实现前后端一体化部署
"""
import os
import json
import threading
import time
import urllib.request
import urllib.error
from flask import Flask, send_from_directory, send_file, Response, request as flask_request_obj
from flask_cors import CORS
from config import Config
from db import init_db
from routes import register_blueprints
from utils.response import error_response

# 前端目录（相对于 backend/ 的上级目录）
FRONTEND_DIR = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', 'frontend'))
EXTENSION_DIR = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', 'extension'))


def create_app(config_class=Config):
    """应用工厂函数"""

    app = Flask(
        __name__,
        static_folder=None,  # 禁用默认静态文件路由，手动控制
    )
    app.config.from_object(config_class)

    # 初始化数据库
    init_db()

    # 启用跨域支持（来源通过 CORS_ALLOWED_ORIGINS 收敛，默认仅允许本地与扩展）
    _cors_origins = config_class.CORS_ALLOWED_ORIGINS
    CORS(app, resources={
        r"/api/*": {
            "origins": _cors_origins,
            "methods": ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
            "allow_headers": ["Content-Type", "Authorization"],
        },
        r"/frontend/*": {
            "origins": _cors_origins,
        },
    })

    # 注册蓝图路由
    register_blueprints(app)

    # 启动时检查并触发 Ozon 类目映射库后台同步（30 天 TTL，超时自动同步）
    try:
        from services.category_sync_service import init_sync_on_startup
        init_sync_on_startup()
    except Exception as e:
        print(f'[启动] 类目映射库同步初始化异常: {e}')

    # 启动后台发布状态轮询线程（每 60 秒刷新一次 processing 状态的发布任务）
    _start_publish_status_poller()

    # 恢复服务重启前卡住的 pending 发布任务（线程池丢失的任务重新入队）
    try:
        from services.publish_service import PublishService
        PublishService.recover_stuck_tasks()
    except Exception as e:
        print(f'[启动] 恢复卡住任务异常: {e}')

    # ===== 前端静态文件服务 =====

    # MIME 类型映射表
    _MIME_MAP = {
        '.html': 'text/html; charset=utf-8',
        '.css': 'text/css; charset=utf-8',
        '.js': 'application/javascript; charset=utf-8',
        '.json': 'application/json; charset=utf-8',
        '.png': 'image/png',
        '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
        '.svg': 'image/svg+xml',
        '.ico': 'image/x-icon',
        '.woff': 'font/woff', '.woff2': 'font/woff2',
        '.webp': 'image/webp',
    }

    def _serve_static_file(file_path, filename):
        """统一的静态文件服务函数"""
        if not os.path.isfile(file_path):
            return error_response(f"文件不存在: {filename}", 404)
        ext = os.path.splitext(filename)[1].lower()
        mimetype = _MIME_MAP.get(ext)
        response = send_file(file_path, mimetype=mimetype)
        response.headers['Cache-Control'] = 'no-cache, no-store, must-revalidate'
        return response

    @app.route('/frontend/<path:filename>')
    def serve_frontend(filename):
        """提供前端文件服务（HTML/CSS/JS/图片等）"""
        return _serve_static_file(os.path.join(FRONTEND_DIR, filename), filename)

    # 前端子目录的相对路径映射（匹配 HTML 中的 css/ js/ assets/ 引用）
    @app.route('/css/<path:filename>')
    def serve_css(filename):
        return _serve_static_file(os.path.join(FRONTEND_DIR, 'css', filename), filename)

    @app.route('/js/<path:filename>')
    def serve_js(filename):
        return _serve_static_file(os.path.join(FRONTEND_DIR, 'js', filename), filename)

    @app.route('/assets/<path:filename>')
    def serve_assets(filename):
        return _serve_static_file(os.path.join(FRONTEND_DIR, 'assets', filename), filename)

    @app.route('/extension/<path:filename>')
    def serve_extension(filename):
        """提供浏览器扩展文件服务"""
        file_path = os.path.join(EXTENSION_DIR, filename)
        if not os.path.isfile(file_path):
            return error_response(f"扩展文件不存在: {filename}", 404)
        return send_file(file_path)

    # ===== 首页路由：重定向到前端页面 =====

    @app.route('/')
    def index():
        """根路径直接返回前端首页"""
        index_path = os.path.join(FRONTEND_DIR, 'index.html')
        if os.path.isfile(index_path):
            return send_file(index_path, mimetype='text/html; charset=utf-8')
        # 前端不存在时显示 API 文档
        return _api_docs_page()

    @app.route('/favicon.ico')
    def favicon():
        """网站图标"""
        icon_path = os.path.join(FRONTEND_DIR, 'assets', 'icons', 'favicon.ico')
        if os.path.isfile(icon_path):
            return send_file(icon_path, mimetype='image/x-icon')
        return '', 204

    # ===== 错误处理 =====

    @app.errorhandler(404)
    def not_found(e):
        # 对于非 /api/ 开头的请求，回退到前端 index.html（SPA 兼容）
        from flask import request as flask_request
        if not flask_request.path.startswith('/api/') and not flask_request.path.startswith('/extension/'):
            index_path = os.path.join(FRONTEND_DIR, 'index.html')
            if os.path.isfile(index_path):
                return send_file(index_path, mimetype='text/html; charset=utf-8')
        return error_response("接口不存在", 404)

    @app.errorhandler(405)
    def method_not_allowed(e):
        return error_response("请求方法不允许", 405)

    @app.errorhandler(500)
    def server_error(e):
        if app.config.get('DEBUG'):
            raise e
        return error_response("服务器内部错误", 500)

    @app.errorhandler(400)
    def bad_request(e):
        return error_response("请求参数错误", 400)

    # ===== 健康检查接口 =====

    @app.route('/api/health', methods=['GET'])
    def health_check():
        from flask import jsonify
        return jsonify({
            "code": 200,
            "msg": "GeekOzon ERP 运行正常",
            "data": {"service": "geekozon-erp-api", "version": "1.0.0"}
        })

    # ===== 图片代理接口（解决1688/淘宝等防盗链问题） =====

    @app.route('/api/image_proxy', methods=['GET'])
    def image_proxy():
        """图片代理：通过后端转发请求，绕过浏览器Referer限制"""
        target_url = flask_request_obj.args.get('url', '')
        if not target_url:
            return error_response("缺少 url 参数", 400)

        # 仅允许 http/https 协议
        if not target_url.startswith(('http://', 'https://')):
            return error_response("仅支持 http/https URL", 400)

        try:
            req = urllib.request.Request(target_url)
            # 模拟浏览器请求头，绕过防盗链
            req.add_header('User-Agent', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36')
            req.add_header('Referer', 'https://detail.1688.com/')
            req.add_header('Accept', 'image/webp,image/apng,image/*,*/*;q=0.8')

            with urllib.request.urlopen(req, timeout=10) as resp:
                content_type = resp.headers.get('Content-Type', 'image/jpeg')
                data = resp.read()

            response = Response(data, content_type=content_type)
            response.headers['Cache-Control'] = 'public, max-age=86400'
            response.headers['Access-Control-Allow-Origin'] = '*'
            return response
        except urllib.error.HTTPError as e:
            return error_response(f"图片请求失败: HTTP {e.code}", e.code)
        except Exception as e:
            return error_response(f"图片代理失败: {str(e)}", 500)

    # ===== 图片上传/托管接口（发布到 Ozon 必需） =====
    # Ozon API 只接受公网可访问的图片 URL，不接受 base64 或本地文件。
    # 这些接口将图片保存到后端 data/uploads/ 目录，并提供 URL 供 Ozon 访问。

    import uuid as _uuid
    import base64 as _base64
    UPLOAD_DIR = Config.UPLOAD_DIR
    os.makedirs(UPLOAD_DIR, exist_ok=True)

    # 公网 CDN 域名白名单：这些域名的图片本身就是公网可访问的，无需转存
    PUBLIC_CDN_DOMAINS = ('alicdn.com', 'taobaocdn.com', 'tbcdn.cn', 'ozoncdn.ru')

    def _has_public_hosting():
        """是否已配置公网图片托管（IMAGE_BASE_URL 或对象存储）"""
        if Config.IMAGE_BASE_URL:
            return True
        if (Config.OBJECT_STORAGE_TYPE or 'local').lower() == 'qiniu' and Config.QINIU_ACCESS_KEY:
            return True
        return False

    def _is_public_cdn_url(url):
        """判断 URL 是否为公网 CDN 图片（无需转存，Ozon 可直接访问）"""
        if not url.startswith(('http://', 'https://')):
            return False
        if '://localhost' in url or '://127.0.0.1' in url:
            return False
        return any(domain in url for domain in PUBLIC_CDN_DOMAINS)

    def _get_image_base_url():
        """获取图片访问的基础 URL"""
        if Config.IMAGE_BASE_URL:
            return Config.IMAGE_BASE_URL.rstrip('/')
        # 默认使用请求头中的 Host
        return f'http://{flask_request_obj.host}' if flask_request_obj.host else 'http://localhost:5000'

    def _save_image_data(image_data, ext='jpg'):
        """保存图片二进制数据，返回完整 URL

        自动选择存储方式：本地 uploads 目录 或 七牛云对象存储（按配置）
        """
        from services.storage_service import save_image
        return save_image(image_data, ext)

    @app.route('/api/images/upload', methods=['POST'])
    def upload_image():
        """上传图片到后端托管

        支持两种方式：
        1. multipart/form-data 上传文件（field name: file）
        2. JSON body 传 base64（{image: "data:image/jpeg;base64,..."}）

        返回：{code: 200, data: {url: "http://.../uploads/xxx.jpg", filename: "xxx.jpg"}}
        """
        from flask import jsonify

        try:
            # 方式1：multipart 文件上传
            if 'file' in flask_request_obj.files:
                file = flask_request_obj.files['file']
                if not file or not file.filename:
                    return error_response("未选择文件", 400)

                # 检查文件大小
                file.seek(0, 2)
                size = file.tell()
                file.seek(0)
                if size > Config.MAX_IMAGE_SIZE:
                    return error_response(f"图片大小超过限制（{Config.MAX_IMAGE_SIZE // 1024 // 1024}MB）", 400)

                # 获取扩展名
                ext = os.path.splitext(file.filename)[1].lower().lstrip('.')
                if ext not in ('jpg', 'jpeg', 'png', 'webp', 'gif'):
                    ext = 'jpg'

                image_data = file.read()
                image_url = _save_image_data(image_data, ext)

            # 方式2：base64 JSON 上传
            else:
                data = flask_request_obj.get_json()
                if not data or 'image' not in data:
                    return error_response("缺少 file 或 image 参数", 400)

                base64_str = data['image']
                # 解析 data URI 格式：data:image/jpeg;base64,/9j/4AAQ...
                if base64_str.startswith('data:'):
                    # 提取 MIME 类型和 base64 数据
                    header, _, base64_data = base64_str.partition(',')
                    ext = 'jpg'
                    if 'image/png' in header:
                        ext = 'png'
                    elif 'image/webp' in header:
                        ext = 'webp'
                    elif 'image/gif' in header:
                        ext = 'gif'
                    base64_str = base64_data
                else:
                    ext = 'jpg'

                try:
                    image_data = _base64.b64decode(base64_str)
                except Exception:
                    return error_response("base64 解码失败", 400)

                if len(image_data) > Config.MAX_IMAGE_SIZE:
                    return error_response(f"图片大小超过限制（{Config.MAX_IMAGE_SIZE // 1024 // 1024}MB）", 400)

                image_url = _save_image_data(image_data, ext)

            # 从 URL 中提取文件名用于响应
            filename = image_url.rsplit('/', 1)[-1] if '/' in image_url else ''

            return jsonify({
                "code": 200,
                "msg": "上传成功",
                "data": {"url": image_url, "filename": filename}
            })

        except Exception as e:
            return error_response(f"图片上传失败: {str(e)}", 500)

    @app.route('/api/images/transfer', methods=['POST'])
    def transfer_images():
        """批量转存外部图片到后端托管

        智能转存策略（零配置即可发布）：
        - 公网 CDN 图片（alicdn 等）：直接返回原 URL，Ozon 可直接访问，无需转存
        - base64 / 代理URL：下载转存到本地或对象存储
        - 已托管的 /uploads/ 图片：补全 URL 后返回

        当配置了 IMAGE_BASE_URL 或对象存储时，所有图片都会转存到自有托管
        （更可靠，避免源站图片下架导致失效）。

        请求：{images: ["https://cbu01.alicdn.com/...", ...]}
        返回：{code: 200, data: {results: [{original: "...", url: "...", success: true}, ...]}}
        """
        from flask import jsonify
        import urllib.parse

        data = flask_request_obj.get_json()
        if not data or 'images' not in data:
            return error_response("缺少 images 参数", 400)

        images = data['images']
        if not isinstance(images, list) or len(images) == 0:
            return error_response("images 必须是非空数组", 400)

        base_url = _get_image_base_url()
        has_public_hosting = _has_public_hosting()
        results = []

        for img_url in images:
            result = {'original': img_url, 'url': '', 'success': False}

            # base64 图片直接保存
            if img_url.startswith('data:'):
                try:
                    header, _, base64_data = img_url.partition(',')
                    ext = 'jpg'
                    if 'image/png' in header:
                        ext = 'png'
                    elif 'image/webp' in header:
                        ext = 'webp'
                    elif 'image/gif' in header:
                        ext = 'gif'
                    image_data = _base64.b64decode(base64_data)
                    result['url'] = _save_image_data(image_data, ext)
                    result['success'] = True
                except Exception as e:
                    result['error'] = f'base64 解码失败: {str(e)}'

            # 代理 URL：提取实际 URL 后按下面的逻辑处理
            elif '/api/image_proxy?url=' in img_url:
                parsed = urllib.parse.parse_qs(urllib.parse.urlparse(img_url).query)
                actual_url = parsed.get('url', [''])[0]
                if actual_url:
                    img_url = actual_url

            # 公网 CDN 图片（alicdn 等）：未配置公网托管时直接用原 URL
            # Ozon 服务器可直接访问这些公网 CDN，无需转存
            if not result['success'] and _is_public_cdn_url(img_url) and not has_public_hosting:
                result['url'] = img_url
                result['success'] = True

            # HTTP/HTTPS URL：下载图片转存（配置了公网托管时，CDN 图也转存）
            if not result['success'] and img_url.startswith(('http://', 'https://')):
                try:
                    req = urllib.request.Request(img_url)
                    req.add_header('User-Agent', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36')
                    req.add_header('Referer', 'https://detail.1688.com/')
                    req.add_header('Accept', 'image/webp,image/apng,image/*,*/*;q=0.8')

                    with urllib.request.urlopen(req, timeout=15) as resp:
                        content_type = resp.headers.get('Content-Type', 'image/jpeg')
                        image_data = resp.read()

                    if len(image_data) > Config.MAX_IMAGE_SIZE:
                        result['error'] = '图片大小超过限制'
                    else:
                        # 根据Content-Type确定扩展名
                        ext = 'jpg'
                        if 'png' in content_type:
                            ext = 'png'
                        elif 'webp' in content_type:
                            ext = 'webp'
                        elif 'gif' in content_type:
                            ext = 'gif'

                        result['url'] = _save_image_data(image_data, ext)
                        result['success'] = True
                except Exception as e:
                    # 下载失败时，若是公网 CDN URL，回退使用原 URL
                    if _is_public_cdn_url(img_url):
                        result['url'] = img_url
                        result['success'] = True
                    else:
                        result['error'] = f'下载失败: {str(e)}'

            # 本地 /uploads/ URL 已经是托管图片，无需转存
            elif not result['success'] and (img_url.startswith('/uploads/') or '/uploads/' in img_url):
                result['url'] = img_url if img_url.startswith('http') else f'{base_url}{img_url}'
                result['success'] = True

            results.append(result)

        success_count = sum(1 for r in results if r['success'])
        return jsonify({
            "code": 200,
            "msg": f"转存完成（成功 {success_count}/{len(results)}）",
            "data": {"results": results}
        })

    @app.route('/uploads/<path:filename>')
    def serve_uploaded_image(filename):
        """提供已上传图片的静态访问（Ozon 服务器通过此 URL 下载图片）"""
        # 防止目录遍历攻击
        safe_name = os.path.basename(filename)
        filepath = os.path.join(UPLOAD_DIR, safe_name)
        if not os.path.isfile(filepath):
            return error_response("图片不存在", 404)

        ext = os.path.splitext(safe_name)[1].lower()
        mime_map = {
            '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
            '.png': 'image/png', '.webp': 'image/webp',
            '.gif': 'image/gif',
        }
        mimetype = mime_map.get(ext, 'image/jpeg')
        response = send_file(filepath, mimetype=mimetype)
        response.headers['Cache-Control'] = 'public, max-age=86400'
        response.headers['Access-Control-Allow-Origin'] = '*'
        return response

    # ===== Rich-контент 模板 / Schema 接口 =====
    # 提供 Ozon 富内容 JSON 模板（Desktop）与 schema 定义供前端视觉编辑器使用
    # 资源目录：utils/RichContent（含 Desktop.json、schema.json、RichContent_files/）
    RICH_CONTENT_DIR = os.path.abspath(os.path.join(os.path.dirname(__file__), 'utils', 'RichContent'))
    RICH_TEMPLATES = {
        'desktop': 'Desktop.json',
        'schema':  'schema.json',
    }
    # RichContent_files 子目录：Ozon 官方 CSS 与 widget 预览图
    RICH_FILES_DIR = os.path.join(RICH_CONTENT_DIR, 'RichContent_files')
    # 允许提供的静态资源白名单（CSS + JS + PNG 预览图）
    RICH_SAFE_FILES = {
        'main.css', 'm=el_main_css', 'main.js',
        'roll.png', 'billboard.png', 'chess.png', 'chess-reverse.png',
        'tile-xl.png', 'tile-l.png', 'video.png', 'chess-tile-secondary.png',
        'images_widget-previews_text-block2.png', 'list.png', 'table.png',
        '640x640.png',
    }

    @app.route('/api/rich_content/template/<template_type>', methods=['GET'])
    def get_rich_content_template(template_type):
        """返回指定的 Rich-контент 模板或 schema JSON

        :param template_type: desktop | schema
        """
        from flask import jsonify
        key = str(template_type).lower().strip()
        filename = RICH_TEMPLATES.get(key)
        if not filename:
            return error_response(f"未知模板类型: {template_type}", 400)
        filepath = os.path.join(RICH_CONTENT_DIR, filename)
        if not os.path.isfile(filepath):
            return error_response(f"模板文件不存在: {filename}", 404)
        try:
            with open(filepath, 'r', encoding='utf-8') as f:
                payload = json.load(f)
            return jsonify({"code": 200, "msg": "ok", "data": payload})
        except Exception as e:
            return error_response(f"模板读取失败: {str(e)}", 500)

    @app.route('/api/rich_content/static/<path:filename>', methods=['GET'])
    def get_rich_content_static(filename):
        """返回 Rich-контент 编辑器静态资源（CSS 与 widget 预览图）

        用于前端弹窗完全模仿 Ozon 官方编辑器视觉风格。
        """
        from flask import send_from_directory
        if filename not in RICH_SAFE_FILES:
            return error_response(f"非法静态资源: {filename}", 403)
        if not os.path.isdir(RICH_FILES_DIR):
            return error_response("静态资源目录不存在", 404)
        return send_from_directory(RICH_FILES_DIR, filename)

    @app.route('/api/rich_content/editor', methods=['GET'])
    def get_rich_content_editor():
        """返回本地化 Rich-контент 编辑器 HTML 页面

        本地化编辑器（不依赖 Ozon main.js）：
        - 左侧 JSON 代码编辑器（带行号 + 实时解析）
        - 右侧实时预览（支持 raShowcase 全系列 + raTextBlock/raVideo/raTable/list）
        - 打开即编辑，无需任何点击
        - 通过 postMessage 与父页面通信（EDITOR_READY/LOAD_JSON/GET_JSON）
        """
        from flask import Response
        import os
        html_path = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'templates', 'rich_editor.html')
        try:
            with open(html_path, 'r', encoding='utf-8') as f:
                resp = Response(f.read(), mimetype='text/html; charset=utf-8')
                resp.headers['Cache-Control'] = 'no-cache, no-store, must-revalidate'
                return resp
        except FileNotFoundError:
            return Response('rich_editor.html not found at ' + html_path, status=500)
        # ===== 以下为旧的 Ozon main.js 逆向代码（已废弃，保留以备回退）=====
        _deprecated_html = '''<!DOCTYPE html>
<html lang="ru">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Rich Content Visual Editor</title>
<link rel="stylesheet" href="/api/rich_content/static/main.css">
<link rel="stylesheet" charset="UTF-8" href="/api/rich_content/static/m%3Del_main_css">
<style>
  html, body { margin: 0; padding: 0; height: 100%; background: #fff; overflow: hidden; }
  body { font-family: Inter, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; }
  #app { width: 100%; height: 100vh; }
  #loading {
    position: fixed; inset: 0; display: flex; align-items: center; justify-content: center;
    background: #fff; color: #64748b; font-size: 16px; z-index: 9999;
  }
  #loading .spinner {
    width: 32px; height: 32px; border: 3px solid #e2e8f0;
    border-top-color: #00a046; border-radius: 50%; animation: spin 0.8s linear infinite;
    margin-right: 12px;
  }
  @keyframes spin { to { transform: rotate(360deg); } }
  /* ===== 只保留 RA-d8 编辑器核心，隐藏其他所有部分 ===== */
  /* 隐藏顶部导航（Documentation/Sandbox/Visual Editor 标签页 + Take training 按钮） */
  .RA-b { display: none !important; }
  /* 确保内容区填满整个 iframe */
  .RA-a8, .RA-a9 { width: 100% !important; height: 100vh !important; }
  .RA-d8 { width: 100% !important; height: 100vh !important; }
</style>
</head>
<body>
<div id="app">
  <div id="loading"><div class="spinner"></div>Загрузка редактора...</div>
</div>
<script>
// ===== 逆向 main.js 的关键配置 =====
// main.js 期望 window.__INITIAL_STATE__ 存在（用于 i18n 语言设置）
window.__INITIAL_STATE__ = { lang: "ru", isTesting: false, env: "development", origin: location.origin };
// main.js 的 Vue Router 期望路径匹配（用 replaceState 修改路径让路由匹配 /visual-editor）
history.replaceState(null, "", "/visual-editor");
</script>
<script src="/api/rich_content/static/main.js"></script>
<script>
// ===== JSON 桥接：通过 Vue 实例直连实现可靠读写 =====
(function() {
  const log = (...args) => console.log("[RichEditor iframe]", ...args);
  log("页面已加载，等待 Vue 应用挂载...");
  log("初始 location.pathname:", location.pathname);

  // 全局错误捕获：捕捉 main.js 执行时的异常
  window.addEventListener("error", function(e) {
    log("[window.error]", e.message, "@", e.filename + ":" + e.lineno + ":" + e.colno);
  });
  window.addEventListener("unhandledrejection", function(e) {
    log("[unhandledrejection]", e.reason && e.reason.message ? e.reason.message : e.reason);
  });

  // ===== 1. 等待 Vue 应用挂载到 #app =====
  function waitForVue(callback, maxWaitMs) {
    const start = Date.now();
    const check = setInterval(() => {
      const appEl = document.querySelector("#app");
      if (appEl && appEl.__vue__) {
        clearInterval(check);
        const rootVm = appEl.__vue__;
        log("Vue 应用已挂载，根组件名:", rootVm.$options && rootVm.$options.name);
        try {
          const route = rootVm.$route;
          log("挂载时路由 path:", route && route.path);
          log("挂载时路由 matched:", route && route.matched ? route.matched.map(m => m.path).join(" > ") : "无");
        } catch (e) { log("读取 $route 失败:", e.message); }
        callback(rootVm);
      } else if (Date.now() - start > maxWaitMs) {
        clearInterval(check);
        log("Vue 应用等待超时（" + maxWaitMs + "ms）");
        // 超时后仍然通知父页面（可能编辑器在 WELCOME 页）
        window.parent.postMessage({ type: "EDITOR_READY", warning: "vue_mount_timeout" }, "*");
      }
    }, 100);
  }

  // ===== 2. 查找 OzRichVisualEditor 组件 =====
  // 先精确匹配 OzRichVisualEditor；找不到再按属性特征匹配（有 page/content/pageComponentMap）
  function findEditor(vm) {
    if (!vm) return null;
    const name = vm.$options && vm.$options.name;
    if (name === "OzRichVisualEditor") return vm;
    // 兜底：匹配有 page、content、pageComponentMap 属性的组件（即编辑器主组件）
    if (vm.page !== undefined && vm.content !== undefined && vm.pageComponentMap) {
      log("findEditor 命中属性兜底，组件名:", name || "(anonymous)");
      return vm;
    }
    const children = vm.$children || [];
    for (let i = 0; i < children.length; i++) {
      const found = findEditor(children[i]);
      if (found) return found;
    }
    return null;
  }

  // ===== 2.5 查找 PageEditor 子组件（编辑器页面组件，selectedIndex 在这里） =====
  // OzRichVisualEditor 的 selectedIndex 无效，真正控制 widget 选中状态的是 PageEditor
  function findPageEditor(vm) {
    if (!vm) return null;
    const name = vm.$options && vm.$options.name;
    if (name === "PageEditor") return vm;
    const children = vm.$children || [];
    for (let i = 0; i < children.length; i++) {
      const found = findPageEditor(children[i]);
      if (found) return found;
    }
    return null;
  }

  // 模糊查找：返回树中第一个名字包含 keyword 的组件
  function findByKeyword(vm, keyword) {
    if (!vm) return null;
    const name = vm.$options && vm.$options.name;
    if (name && name.toLowerCase().indexOf(keyword.toLowerCase()) >= 0) return vm;
    const children = vm.$children || [];
    for (let i = 0; i < children.length; i++) {
      const found = findByKeyword(children[i], keyword);
      if (found) return found;
    }
    return null;
  }

  // 打印整棵组件树（用于诊断 editor_not_found）
  function dumpComponentTree(vm, depth, acc) {
    if (!vm) return;
    depth = depth || 0;
    acc = acc || [];
    const name = (vm.$options && vm.$options.name) || "(anonymous)";
    const indent = "  ".repeat(depth);
    acc.push(indent + name + " [children=" + (vm.$children ? vm.$children.length : 0) + "]");
    const children = vm.$children || [];
    for (let i = 0; i < children.length; i++) {
      dumpComponentTree(children[i], depth + 1, acc);
    }
    return acc;
  }

  // ===== 3. 序列化函数（复刻 main.js 中的 sf 函数） =====
  // sf(widgetsList) => {content: widgetsList.map(w => w.widgetData), version: 0.3}
  function serializeContent(editor) {
    const content = editor.content || [];
    return {
      content: content.map(function(w) { return w.widgetData; }),
      version: 0.3
    };
  }

  // ===== 4. 反序列化函数（将 JSON content 转换为 widget 列表） =====
  function deserializeContent(jsonStr) {
    const parsed = JSON.parse(jsonStr);
    const items = (parsed.content || parsed || []).map(function(widgetData, idx) {
      return {
        component: "WidgetWrap",
        uid: Date.now() + idx + Math.random() * 1000,
        widgetData: widgetData
      };
    });
    return items;
  }

  // ===== 5. 等待 OzRichVisualEditor 组件就绪 =====
  function waitForEditor(rootVm, callback, maxWaitMs) {
    const start = Date.now();
    let logged = false;
    const check = setInterval(() => {
      const editor = findEditor(rootVm);
      if (editor) {
        clearInterval(check);
        log("OzRichVisualEditor 组件已就绪");
        callback(editor);
        return;
      }
      // 第一次找不到时打印诊断信息（只打印一次，避免刷屏）
      if (!logged) {
        logged = true;
        try {
          const route = rootVm.$route;
          log("== 组件树诊断 ==");
          log("当前路由 path:", route && route.path);
          log("当前路由 matched:", route && route.matched ? route.matched.map(m => m.path).join(" > ") : "无");
          log("location.pathname:", location.pathname);
          const tree = dumpComponentTree(rootVm);
          log("组件树:\n" + tree.join("\n"));
          // 尝试模糊匹配
          ["Editor", "Visual", "Rich", "Widget"].forEach(function(kw) {
            const hit = findByKeyword(rootVm, kw);
            if (hit) log("模糊匹配命中 [" + kw + "]:", hit.$options.name);
          });
        } catch (e) {
          log("诊断异常:", e.message);
        }
      }
      if (Date.now() - start > maxWaitMs) {
        clearInterval(check);
        log("OzRichVisualEditor 等待超时（" + maxWaitMs + "ms）");
        callback(null);
      }
    }, 200);
  }

  // ===== 6. 监听父页面消息 =====
  window.addEventListener("message", function(event) {
    const msg = event.data || {};
    if (typeof msg !== "object" || !msg.type) return;
    log("收到消息:", msg.type);

    if (msg.type === "GET_JSON") {
      // 从 Vue 实例直接读取 JSON（不依赖剪贴板）
      const appEl = document.querySelector("#app");
      if (appEl && appEl.__vue__) {
        const editor = findEditor(appEl.__vue__);
        if (editor) {
          try {
            const json = JSON.stringify(serializeContent(editor), null, 2);
            log("GET_JSON 成功，长度:", json.length, "widget 数:", (editor.content || []).length);
            event.source.postMessage({ type: "JSON_RESULT", json: json, requestId: msg.requestId }, "*");
            return;
          } catch (e) {
            log("GET_JSON 序列化失败:", e.message);
          }
        } else {
          log("GET_JSON: 未找到 OzRichVisualEditor 组件");
        }
      } else {
        log("GET_JSON: Vue 应用未挂载");
      }
      event.source.postMessage({ type: "JSON_RESULT", json: null, requestId: msg.requestId, error: "editor_not_found" }, "*");

    } else if (msg.type === "LOAD_JSON") {
      // 将 JSON 加载到 Vue 实例（直接设置 data.content）
      const appEl = document.querySelector("#app");
      if (appEl && appEl.__vue__) {
        const editor = findEditor(appEl.__vue__);
        if (editor) {
          try {
            const widgets = deserializeContent(msg.json || "{}");
            // 直接设置 content 数组
            editor.content = widgets;
            // 进入编辑器页面 + 选中第一个 widget
            enterEditorPage(editor);
            log("LOAD_JSON 成功，widget 数:", widgets.length);
            event.source.postMessage({ type: "LOAD_RESULT", success: true, count: widgets.length }, "*");
            return;
          } catch (e) {
            log("LOAD_JSON 反序列化/设置失败:", e.message);
          }
        } else {
          log("LOAD_JSON: 未找到 OzRichVisualEditor 组件");
        }
      } else {
        log("LOAD_JSON: Vue 应用未挂载");
      }
      event.source.postMessage({ type: "LOAD_RESULT", success: false, error: "editor_not_found" }, "*");

    } else if (msg.type === "PING") {
      event.source.postMessage({ type: "PONG" }, "*");
    }
  });

  // ===== 7. 创建默认 widget（raShowcase:chess，与 Ozon 官方模板一致） =====
  function createDefaultWidget() {
    return {
      component: "WidgetWrap",
      uid: Date.now() + Math.random() * 1000,
      widgetData: {
        widgetName: "raShowcase",
        type: "chess",
        blocks: [{
          img: {
            src: "https://cdn1.ozone.ru/s3/rich-content/placeholder/708x708_4.png",
            srcMobile: "https://cdn1.ozone.ru/s3/rich-content/placeholder/640x640.png",
            alt: "",
            position: "to_the_edge",
            positionMobile: "to_the_edge"
          },
          imgLink: "",
          title: {
            items: [{ type: "text", content: "Заголовок" }],
            size: "size5",
            align: "left",
            color: "color1"
          },
          text: {
            items: [{ type: "text", content: "Пожалуйста, замените этот текст Вашим собственным. Просто кликните по тексту, чтобы добавить свой текст." }],
            size: "size2",
            align: "left",
            color: "color1"
          },
          reverse: false
        }]
      }
    };
  }

  // ===== 8. 进入编辑器页面 + 创建默认 widget + 自动选中第一个 =====
  function enterEditorPage(editor) {
    // 如果 content 为空，创建默认 widget（避免编辑器页面空白）
    if (!editor.content || editor.content.length === 0) {
      log("content 为空，创建默认 widget（raShowcase:chess）");
      editor.content = [createDefaultWidget()];
    }
    // 切换到编辑器页面（优先用 $set 确保响应式触发）
    if (editor.page !== "editor") {
      try { editor.$set(editor, "page", "editor"); } catch (e) { editor.page = "editor"; }
      log("已切换到 EDITOR 页面");
    }
    editor.$forceUpdate();

    // 自动选中第一个 widget（内部有 4s 持续重试 + DOM 兜底，无需二次调用）
    selectFirstWidget(editor);

    // 二次确认：300ms 后再次检查 page（防止被 watcher 或其他逻辑改回 WELCOME）
    setTimeout(function() {
      if (editor.page !== "editor") {
        try { editor.$set(editor, "page", "editor"); } catch (e) { editor.page = "editor"; }
        editor.$forceUpdate();
        log("二次确认：已强制切换到 EDITOR 页面");
      }
    }, 300);
  }

  // 自动选中第一个 widget：查找 PageEditor 子组件并设置 selectedIndex = 0
  // 持续重试直到成功（PageEditor 渲染 + widgetsList 同步需要时间）
  function selectFirstWidget(editor) {
    let retries = 0;
    const maxRetries = 40; // 4s 内重试（每 100ms 一次）
    let done = false;

    const trySelect = function() {
      if (done) return;
      retries++;

      // 策略1：通过 Vue 直连设置 PageEditor.selectedIndex = 0
      const pageEditor = findPageEditor(editor);
      if (pageEditor && (pageEditor.widgetsList || []).length > 0) {
        if (pageEditor.selectedIndex !== 0) {
          try {
            if (typeof pageEditor.onSelect === "function") {
              pageEditor.onSelect(0);
            } else {
              pageEditor.selectedIndex = 0;
            }
            pageEditor.$forceUpdate();
            log("已自动选中第一个 widget（PageEditor.selectedIndex = 0，重试 " + retries + " 次）");
          } catch (e) {
            log("选中 widget 异常:", e.message);
          }
        }
        done = true;
        return;
      }

      // 策略2：500ms 后尝试 DOM 兜底（点击 widget 列表中的第一个 widget）
      if (retries >= 5) {
        if (clickFirstWidgetInDom()) {
          log("DOM 兜底：已点击第一个 widget（重试 " + retries + " 次）");
          done = true;
          return;
        }
      }

      if (retries < maxRetries) {
        setTimeout(trySelect, 100);
      } else {
        log("selectFirstWidget 重试 " + maxRetries + " 次后仍未成功");
      }
    };

    trySelect();
  }

  // DOM 兜底：通过点击 widget 列表中的第一个 widget 来选中它
  function clickFirstWidgetInDom() {
    // 查找 widget 列表容器（v-qa:id="widget-list" 会渲染成各种属性）
    const list = document.querySelector(
      '[qa\\:id="widget-list"], [data-qa-id="widget-list"], [qa-id="widget-list"], ' +
      '[class*="widget-list"], [class*="WidgetList"]'
    );
    if (!list) return false;

    // 查找 widget 列表中的可点击项（widget 预览卡片）
    // 排除"添加 widget"按钮和标题
    const items = list.querySelectorAll(
      '[role="button"], [class*="widget-preview"], [class*="WidgetPreview"], ' +
      '[class*="item"], [class*="card"], [draggable="true"]'
    );
    for (const item of items) {
      const text = (item.textContent || '').trim();
      // 跳过"添加"按钮和标题
      if (text === '+' || text === 'Добавить' || text === 'Add' || text === 'Блоки') continue;
      // 跳过没有内容的元素
      if (text.length < 2) continue;
      try {
        item.click();
        return true;
      } catch (e) {}
    }

    // 兜底：点击列表中第一个非按钮元素
    const all = list.querySelectorAll('div[class], section[class], article[class]');
    for (const el of all) {
      const text = (el.textContent || '').trim();
      if (text.length > 5 && text !== 'Блоки') {
        try {
          el.click();
          return true;
        } catch (e) {}
      }
    }
    return false;
  }

  // ===== 8.5 DOM 兜底：通过点击 WELCOME 页"Создать"按钮进入编辑器 =====
  // 当 Vue 直连失败时（组件未渲染或 page 设置不生效），通过 DOM 模拟用户点击
  function tryEnterEditorViaDom() {
    // 策略1：查找包含 empty.png 图片的可点击元素（WELCOME 页"创建"选项）
    const img = document.querySelector('img[src*="empty.png"], img[src*="rich-content/images/empty"]');
    if (img) {
      const clickable = img.closest('button, [role="button"], [class*="PageOption"], [class*="_4-a"], a, div[class]');
      if (clickable) {
        log("DOM 兜底：通过 empty.png 找到创建按钮，点击");
        clickable.click();
        return true;
      }
    }
    // 策略2：按文本查找"Создать"/"Create"/"创建"/"Выбрать"按钮
    const candidates = document.querySelectorAll('button, [role="button"], [class*="PageOption"], [class*="_4-a"]');
    for (const btn of candidates) {
      const text = (btn.textContent || '').trim();
      if (text === 'Создать' || text === 'Create' || text === '创建' || text === 'Выбрать') {
        log("DOM 兜底：通过文本找到创建按钮:", text);
        btn.click();
        return true;
      }
    }
    log("DOM 兜底：未找到创建按钮");
    return false;
  }

  // ===== 9. Vue 挂载后查找编辑器组件，通知父页面就绪 =====
  waitForVue(function(rootVm) {
    waitForEditor(rootVm, function(editor) {
      if (editor) {
        // 找到编辑器组件：直接进入编辑器页面（enterEditorPage 内部会处理默认 widget + 选中第一个）
        enterEditorPage(editor);
        const widgetCount = (editor.content || []).length;
        log("编辑器就绪，当前 widget 数:", widgetCount);
        window.parent.postMessage({ type: "EDITOR_READY", widgetCount: widgetCount }, "*");
      } else {
        // Vue 直连失败：尝试 DOM 兜底（点击 WELCOME 页"Создать"按钮）
        log("未找到编辑器组件，尝试 DOM 兜底（点击创建按钮）");
        const domOk = tryEnterEditorViaDom();
        if (domOk) {
          // 点击后等待组件渲染，再次查找编辑器组件
          let retries = 0;
          const retryFind = setInterval(function() {
            retries++;
            const editor2 = findEditor(rootVm);
            if (editor2) {
              clearInterval(retryFind);
              enterEditorPage(editor2);
              const widgetCount = (editor2.content || []).length;
              log("DOM 兜底成功，编辑器就绪，widget 数:", widgetCount);
              window.parent.postMessage({ type: "EDITOR_READY", widgetCount: widgetCount }, "*");
            } else if (retries > 25) { // 5s 内重试
              clearInterval(retryFind);
              log("DOM 兜底后仍未找到编辑器组件");
              window.parent.postMessage({ type: "EDITOR_READY", widgetCount: 0, warning: "editor_not_found_maybe_welcome_page" }, "*");
            }
          }, 200);
        } else {
          log("DOM 兜底未找到创建按钮，通知父页面就绪");
          window.parent.postMessage({ type: "EDITOR_READY", widgetCount: 0, warning: "editor_not_found_maybe_welcome_page" }, "*");
        }
      }
    }, 8000);
  }, 15000);

  log("postMessage 监听器已注册");
})();
</script>
</body>
</html>'''
        # 旧代码结束（已废弃，不再执行）

    return app


def _api_docs_page():
    """API 文档页面（仅在前端不可用时展示）"""
    return '''
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <title>GeekOzon ERP</title>
  <style>
    body { font-family: -apple-system, sans-serif; max-width: 680px; margin: 60px auto; padding: 20px; color: #333; }
    h1 { color: #FF6B35; }
    .card { background:#f8f9fa; border-radius:12px; padding:20px; margin:16px 0; border:1px solid #e5e7eb; }
    .endpoint { background: #fff; padding:10px 14px; border-radius:8px; margin:6px 0; font-family:monospace; font-size:13px; border:1px solid #eee; display:flex;align-items:center;gap:10px;}
    .method { display:inline-block; padding:3px 10px; border-radius:6px; font-size:11px; font-weight:bold; min-width:48px;text-align:center;}
    .get { background:#dbeafe;color:#1d4ed8; } .post { background:#dcfce7;color:#16a34a; }
    .put { background:#fef3c7;color:#d97706; } .delete { background:#fee2e2;color:#dc2626; }
    a.btn { display:inline-block; padding:10px 24px; background:#FF6B35;color:white;border-radius:20px;font-weight:600;text-decoration:none;margin-top:8px; }
    a.btn:hover { opacity:.9; }
  </style>
</head>
<body>
  <h1>GeekOzon ERP</h1>
  <div class="card">
    <p style="font-size:15px;color:#555;">后端服务运行正常。点击下方按钮打开前端管理面板：</p>
    <a class="btn" href="/frontend/index.html">打开 ERP 管理面板 →</a>
  </div>
  <h3>API 接口列表</h3>
  <div class="endpoint"><span class="method get">GET</span> /api/health &nbsp; 健康检查</div>
  <div class="endpoint"><span class="method get">GET</span> /api/products &nbsp; 商品列表</div>
  <div class="endpoint"><span class="method post">POST</span> /api/products/collect &nbsp; 商品采集</div>
  <div class="endpoint"><span class="method put">PUT</span> /api/products/&lt;id&gt; &nbsp; 更新商品</div>
  <div class="endpoint"><span class="method delete">DELETE</span> /api/products/&lt;id&gt; &nbsp; 删除商品</div>
  <div class="endpoint"><span class="method post">POST</span> /api/publish &nbsp; 提交发布任务</div>
  <div class="endpoint"><span class="method get">GET</span> /api/publish/&lt;task_id&gt;/status &nbsp; 发布状态</div>
  <div class="endpoint"><span class="method post">POST</span> /api/ai/generate &nbsp; AI 内容生成</div>
  <div class="endpoint"><span class="method get">GET</span> /api/notices &nbsp; 公告列表</div>
  <div class="endpoint"><span class="method post">POST</span> /api/auth/login &nbsp; 用户登录</div>
  <div class="endpoint"><span class="method get">GET</span> /api/user/info &nbsp; 用户信息</div>
</body>
</html>
'''


def _start_publish_status_poller():
    """启动后台线程，定时轮询 processing 状态的发布任务

    每 60 秒执行一次，调用 PublishService.refresh_all_processing() 刷新任务状态。
    线程设为 daemon，随主进程退出自动终止。
    在 Flask debug 模式下，reloader 会启动两个进程，仅在子进程（WERKZEUG_RUN_MAIN=true）中启动轮询。
    """
    # debug 模式下 reloader 父进程不启动（避免重复轮询）
    if os.environ.get('WERKZEUG_RUN_MAIN') != 'true' and os.environ.get('FLASK_DEBUG') == '1':
        return

    def _poll_loop():
        while True:
            try:
                time.sleep(60)
                from services.publish_service import PublishService
                PublishService.refresh_all_processing()
            except Exception as e:
                print(f'[后台轮询] 异常: {e}')

    thread = threading.Thread(target=_poll_loop, daemon=True, name='publish-poller')
    thread.start()
    print('[启动] 发布状态后台轮询线程已启动（每 60 秒刷新一次）')


if __name__ == '__main__':
    app = create_app()
    app.run(host='0.0.0.0', port=5000, debug=True)
