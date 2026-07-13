"""图库与 AI 图片生成 API。"""
import base64
import json
import os
import re
import urllib.error
import urllib.request
import uuid
from datetime import datetime

from flask import Blueprint, request, send_from_directory

from config import DATA_DIR, Config
from db import execute, query
from services.ai_config_service import get_ai_config
from utils.response import success_response, error_response, handle_errors


gallery_bp = Blueprint('gallery', __name__)
GALLERY_DIR = os.path.join(DATA_DIR, 'gallery')
os.makedirs(GALLERY_DIR, exist_ok=True)
ALLOWED_EXTENSIONS = {'png', 'jpg', 'jpeg', 'webp'}


def _now():
    return datetime.now().strftime('%Y-%m-%d %H:%M:%S')


def _safe_name(name):
    name = re.sub(r'[^\w\-. ]+', '_', str(name or ''), flags=re.UNICODE).strip(' ._')
    return name[:120] or 'image'


def _row_to_dict(row):
    item = dict(row)
    item['id'] = str(item['id'])
    item['favorite'] = bool(item.get('favorite'))
    try:
        item['tags'] = json.loads(item.get('tags') or '[]')
    except (TypeError, ValueError):
        item['tags'] = []
    item['url'] = f"/api/gallery/files/{item['filename']}"
    return item


def _create_asset(filename, original_name, size, source='upload', prompt='', tags=None):
    asset_id = execute(
        """INSERT INTO gallery_assets
           (filename, original_name, title, mime_type, file_size, source, prompt, tags, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
        (filename, original_name, os.path.splitext(original_name)[0],
         f"image/{os.path.splitext(filename)[1].lower().lstrip('.').replace('jpg', 'jpeg')}",
         size, source, prompt, json.dumps(tags or [], ensure_ascii=False), _now(), _now()),
    )
    return _row_to_dict(query('SELECT * FROM gallery_assets WHERE id = ?', (asset_id,), one=True))


def _save_bytes(data, original_name, source='upload', prompt='', tags=None):
    if len(data) > Config.MAX_IMAGE_SIZE:
        raise ValueError('图片超过 10MB 限制')
    ext = os.path.splitext(original_name)[1].lower().lstrip('.')
    if ext not in ALLOWED_EXTENSIONS:
        ext = 'png'
    filename = f"{uuid.uuid4().hex}.{ext}"
    with open(os.path.join(GALLERY_DIR, filename), 'wb') as file:
        file.write(data)
    return _create_asset(filename, _safe_name(original_name), len(data), source, prompt, tags)


@gallery_bp.route('/gallery', methods=['GET'])
@handle_errors
def list_gallery():
    keyword = request.args.get('keyword', '').strip()
    source = request.args.get('source', '').strip()
    favorite = request.args.get('favorite', '').strip()
    conditions, params = [], []
    if keyword:
        conditions.append('(title LIKE ? OR original_name LIKE ? OR tags LIKE ? OR prompt LIKE ?)')
        params.extend([f'%{keyword}%'] * 4)
    if source:
        conditions.append('source = ?')
        params.append(source)
    if favorite in ('1', 'true'):
        conditions.append('favorite = 1')
    where = (' WHERE ' + ' AND '.join(conditions)) if conditions else ''
    rows = query(f'SELECT * FROM gallery_assets{where} ORDER BY created_at DESC', params)
    return success_response(data={'list': [_row_to_dict(row) for row in rows], 'total': len(rows)})


@gallery_bp.route('/gallery/upload', methods=['POST'])
@handle_errors
def upload_gallery():
    files = request.files.getlist('files') or ([request.files['file']] if 'file' in request.files else [])
    if not files:
        return error_response('请选择图片文件', 400)
    tags = [tag.strip() for tag in request.form.get('tags', '').split(',') if tag.strip()]
    assets = []
    for uploaded in files[:30]:
        ext = os.path.splitext(uploaded.filename or '')[1].lower().lstrip('.')
        if ext not in ALLOWED_EXTENSIONS:
            return error_response(f'不支持的图片格式: {uploaded.filename}', 400)
        assets.append(_save_bytes(uploaded.read(), uploaded.filename, tags=tags))
    return success_response(data=assets, msg=f'已上传 {len(assets)} 张图片')


@gallery_bp.route('/gallery/<int:asset_id>', methods=['PUT'])
@handle_errors
def update_gallery(asset_id):
    body = request.get_json(silent=True) or {}
    allowed = {}
    if 'title' in body:
        allowed['title'] = _safe_name(body['title'])
    if 'favorite' in body:
        allowed['favorite'] = 1 if body['favorite'] else 0
    if 'tags' in body:
        allowed['tags'] = json.dumps([str(x).strip() for x in body['tags'] if str(x).strip()], ensure_ascii=False)
    if not allowed:
        return error_response('没有可更新字段', 400)
    sets = [f'{key} = ?' for key in allowed] + ['updated_at = ?']
    execute(f"UPDATE gallery_assets SET {', '.join(sets)} WHERE id = ?", list(allowed.values()) + [_now(), asset_id])
    row = query('SELECT * FROM gallery_assets WHERE id = ?', (asset_id,), one=True)
    return success_response(data=_row_to_dict(row), msg='素材已更新') if row else error_response('素材不存在', 404)


@gallery_bp.route('/gallery/<int:asset_id>', methods=['DELETE'])
@handle_errors
def delete_gallery(asset_id):
    row = query('SELECT * FROM gallery_assets WHERE id = ?', (asset_id,), one=True)
    if not row:
        return error_response('素材不存在', 404)
    path = os.path.join(GALLERY_DIR, row['filename'])
    if os.path.isfile(path):
        try:
            os.remove(path)
        except OSError as exc:
            # Windows may briefly lock a file that was just previewed/downloaded.
            # Metadata deletion should still succeed; orphan cleanup can remove it later.
            print(f'[图库] 文件暂时无法删除 {path}: {exc}')
    execute('DELETE FROM gallery_assets WHERE id = ?', (asset_id,))
    return success_response(msg='素材已删除')


@gallery_bp.route('/gallery/files/<path:filename>', methods=['GET'])
def gallery_file(filename):
    return send_from_directory(GALLERY_DIR, os.path.basename(filename))


@gallery_bp.route('/ai/images/generate', methods=['POST'])
@handle_errors
def generate_ai_images():
    body = request.get_json(silent=True) or {}
    prompt = str(body.get('prompt') or '').strip()
    if not prompt:
        return error_response('请输入图片描述', 400)
    count = min(max(int(body.get('count') or 1), 1), 4)
    size = body.get('size') if body.get('size') in ('1024x1024', '1536x1024', '1024x1536') else '1024x1024'
    config = get_ai_config()
    if not config.get('api_key') or not config.get('base_url'):
        return error_response('请先在模型管理配置支持图片生成的 API', 400)
    model = str(body.get('model') or 'gpt-image-1').strip()
    payload = {'model': model, 'prompt': prompt, 'n': count, 'size': size}
    req = urllib.request.Request(
        config['base_url'].rstrip('/') + '/images/generations',
        data=json.dumps(payload).encode('utf-8'),
        headers={'Content-Type': 'application/json', 'Authorization': f"Bearer {config['api_key']}"},
    )
    try:
        with urllib.request.urlopen(req, timeout=180) as response:
            result = json.loads(response.read().decode('utf-8'))
    except urllib.error.HTTPError as exc:
        detail = exc.read().decode('utf-8', errors='replace')[:500]
        return error_response(f'图片模型调用失败 HTTP {exc.code}: {detail}', 502)
    except urllib.error.URLError as exc:
        return error_response(f'图片模型连接失败: {exc.reason}', 502)

    assets = []
    for index, item in enumerate(result.get('data') or []):
        try:
            if item.get('b64_json'):
                image_data = base64.b64decode(item['b64_json'])
            elif item.get('url'):
                with urllib.request.urlopen(item['url'], timeout=60) as response:
                    image_data = response.read(Config.MAX_IMAGE_SIZE + 1)
            else:
                continue
            assets.append(_save_bytes(image_data, f'ai-{index + 1}.png', 'ai', prompt, ['AI生成']))
        except Exception as exc:
            print(f'[AI图片] 保存第 {index + 1} 张失败: {exc}')
    if not assets:
        return error_response('模型未返回可保存的图片', 502)
    return success_response(data={'assets': assets, 'model': model}, msg=f'已生成并保存 {len(assets)} 张图片')
