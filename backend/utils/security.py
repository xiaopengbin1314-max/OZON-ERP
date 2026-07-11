"""
GeekOzon ERP - 安全工具模块
提供密码哈希与敏感字段可逆加密，仅依赖 Python 标准库。

设计目标：
- 密码哈希：PBKDF2-HMAC-SHA256 + 随机盐，抗彩虹表
- 敏感字段（如 Ozon API Key）可逆加密：基于 PBKDF2 派生密钥的流加密
- 向后兼容：自动识别旧格式（裸 SHA-256 / 明文），平滑迁移

格式约定：
- 密码: "pbkdf2$<iterations>$<salt_hex>$<hash_hex>"
- 加密: "enc$v1$<nonce_hex>$<ciphertext_hex>"
"""
import os
import hmac
import hashlib
import secrets

# PBKDF2 迭代次数（NIST 建议 ≥ 100000）
_PBKDF2_ITERATIONS = 200_000
# 派生密钥长度
_KEY_LEN = 32


def _get_encryption_key():
    """从应用 SECRET_KEY 派生加密主密钥"""
    from config import Config
    secret = Config.SECRET_KEY
    if not secret:
        raise RuntimeError('SECRET_KEY 未配置，无法派生加密密钥')
    # 用固定盐派生稳定密钥（同 SECRET_KEY 产生同密钥，便于解密历史数据）
    return hashlib.pbkdf2_hmac(
        'sha256', secret.encode('utf-8'), b'geekozon-enc-salt', _PBKDF2_ITERATIONS, dklen=_KEY_LEN
    )


# ============ 密码哈希 ============

def hash_password(password):
    """对密码进行 PBKDF2 哈希

    Returns:
        str: "pbkdf2$<iterations>$<salt_hex>$<hash_hex>"
    """
    if not password:
        password = ''
    salt = secrets.token_hex(16)
    dk = hashlib.pbkdf2_hmac('sha256', password.encode('utf-8'), bytes.fromhex(salt),
                             _PBKDF2_ITERATIONS, dklen=_KEY_LEN)
    return f"pbkdf2${_PBKDF2_ITERATIONS}${salt}${dk.hex()}"


def verify_password(password, stored):
    """验证密码，兼容旧版裸 SHA-256 哈希

    Args:
        password: 用户输入的明文密码
        stored: 数据库中存储的哈希字符串

    Returns:
        bool: 是否匹配
    """
    if not stored:
        return False
    stored = str(stored)

    # 新格式: pbkdf2$iterations$salt$hash
    if stored.startswith('pbkdf2$'):
        try:
            _, iter_str, salt, hash_hex = stored.split('$', 3)
            iterations = int(iter_str)
            dk = hashlib.pbkdf2_hmac('sha256', (password or '').encode('utf-8'),
                                     bytes.fromhex(salt), iterations, dklen=_KEY_LEN)
            return hmac.compare_digest(dk.hex(), hash_hex)
        except (ValueError, TypeError):
            return False

    # 旧格式: 裸 SHA-256（64 位十六进制），向后兼容
    if len(stored) == 64 and all(c in '0123456789abcdef' for c in stored.lower()):
        legacy_hash = hashlib.sha256((password or '').encode('utf-8')).hexdigest()
        return hmac.compare_digest(legacy_hash, stored)

    return False


def needs_rehash(stored):
    """判断存储的哈希是否需要升级（旧格式 → 新格式）"""
    return not str(stored or '').startswith('pbkdf2$')


# ============ 敏感字段可逆加密 ============

def _xor_crypt(data_bytes, key, nonce):
    """基于 HMAC-SHA256 生成密钥流的 XOR 加密"""
    out = bytearray()
    counter = 0
    while len(out) < len(data_bytes):
        # 每块用 (key, nonce||counter) 生成 32 字节密钥流
        block = hmac.new(key, nonce + counter.to_bytes(8, 'big'), hashlib.sha256).digest()
        chunk = data_bytes[len(out):len(out) + 32]
        out.extend(b ^ k for b, k in zip(chunk, block))
        counter += 1
    return bytes(out)


def encrypt_secret(plaintext):
    """加密敏感字符串

    Args:
        plaintext: 明文（str 或 None）

    Returns:
        str: "enc$v1$<nonce_hex>$<ciphertext_hex>"；输入为空则返回原值
    """
    if plaintext is None or plaintext == '':
        return plaintext
    # 已加密则不重复加密
    if isinstance(plaintext, str) and plaintext.startswith('enc$v1$'):
        return plaintext

    key = _get_encryption_key()
    nonce = os.urandom(16)
    data = plaintext.encode('utf-8') if isinstance(plaintext, str) else bytes(plaintext)
    cipher = _xor_crypt(data, key, nonce)
    return f"enc$v1${nonce.hex()}${cipher.hex()}"


def decrypt_secret(stored):
    """解密敏感字符串，兼容明文（未加密）数据

    Args:
        stored: 加密串或明文

    Returns:
        str: 明文；输入为 None/空则原样返回
    """
    if stored is None or stored == '':
        return stored
    stored = str(stored)

    if not stored.startswith('enc$v1$'):
        # 明文（旧数据），直接返回，调用方后续写入时会自动加密
        return stored

    try:
        _, ver, nonce_hex, cipher_hex = stored.split('$', 3)
        if ver != 'v1':
            return stored  # 未知版本，原样返回避免数据损坏
        key = _get_encryption_key()
        nonce = bytes.fromhex(nonce_hex)
        cipher = bytes.fromhex(cipher_hex)
        plain = _xor_crypt(cipher, key, nonce)
        return plain.decode('utf-8')
    except (ValueError, TypeError):
        return stored  # 解析失败，原样返回


def is_encrypted(value):
    """判断值是否已加密"""
    return isinstance(value, str) and value.startswith('enc$v1$')
