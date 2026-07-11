"""
用户认证相关 API 路由
提供登录、用户信息查询等接口
"""
import hashlib
import time
from flask import Blueprint, request
from models.product import User
from config import Config
from utils.response import success_response, error_response, handle_errors

auth_bp = Blueprint('auth', __name__)

# 简易 Token 存储（生产环境应使用 Redis 或 JWT）
_token_store = {}


@auth_bp.route('/auth/login', methods=['POST'])
@handle_errors
def login():
    """用户登录"""
    data = request.get_json()
    username = (data or {}).get('username', '')
    password = (data or {}).get('password', '')

    if not username or not password:
        return error_response("用户名和密码不能为空")

    # 查找用户
    users = User.find_all()
    user = None
    for u in users:
        if u.get('username') == username:
            user = u
            break

    # 开发模式：自动创建/匹配用户
    if not user:
        user = User.create({
            "username": username,
            "nickname": username,
            "role": "admin",
        })

    # 生成简易 token
    token = hashlib.sha256(f"{username}{time.time()}".encode()).hexdigest()[:32]
    _token_store[token] = {
        "userId": user['id'],
        "username": user['username'],
        "expiresAt": time.time() + Config.TOKEN_EXPIRE_HOURS * 3600,
    }

    return success_response(data={
        "token": token,
        "user": {
            "id": user['id'],
            "username": user['username'],
            "nickname": user.get('nickname', ''),
            "role": user.get('role', 'user'),
        }
    }, msg="登录成功")


@auth_bp.route('/user/info', methods=['GET'])
@handle_errors
def get_user_info():
    """获取当前用户信息"""
    auth_header = request.headers.get('Authorization', '')
    token = auth_header.replace('Bearer ', '') if auth_header.startswith('Bearer ') else ''

    if not token or token not in _token_store:
        # 未登录时返回默认游客信息
        return success_response(data={
            "user": {"id": "guest", "username": "游客", "nickname": "游客用户", "role": "guest"},
            "isLoggedIn": False
        })

    token_info = _token_store[token]
    # 检查过期
    if time.time() > token_info['expiresAt']:
        del _token_store[token]
        return error_response("Token 已过期，请重新登录", 401)

    users = User.find_all()
    user = None
    for u in users:
        if u.get('id') == token_info['userId']:
            user = u
            break

    return success_response(data={
        "user": user or {"id": token_info['userId'], "username": token_info['username']},
        "isLoggedIn": True
    })
