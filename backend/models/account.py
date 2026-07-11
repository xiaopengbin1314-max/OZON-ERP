"""
GeekOzon ERP - 账户与店铺数据模型
基于 SQLite 数据库的 ORM 封装
"""
import hashlib
from datetime import datetime
from db import query, execute
from utils.security import hash_password, verify_password, needs_rehash, encrypt_secret, decrypt_secret


class Account:
    """账户模型 - 管理系统用户"""

    @staticmethod
    def _hash_password(password):
        """密码哈希（PBKDF2，向后兼容旧 SHA-256 验证）"""
        return hash_password(password)

    @staticmethod
    def create(username, password, nickname='', role='operator'):
        """创建账户"""
        password_hash = Account._hash_password(password)
        now = datetime.now().strftime('%Y-%m-%d %H:%M:%S')
        account_id = execute(
            """INSERT INTO accounts (username, nickname, password_hash, role, status, created_at, updated_at)
               VALUES (?, ?, ?, ?, 'active', ?, ?)""",
            (username, nickname or username, password_hash, role, now, now)
        )
        return Account.find_by_id(account_id)

    @staticmethod
    def find_by_id(account_id):
        """按 ID 查找账户"""
        return query("SELECT * FROM accounts WHERE id = ?", (account_id,), one=True)

    @staticmethod
    def find_by_username(username):
        """按用户名查找账户"""
        return query("SELECT * FROM accounts WHERE username = ?", (username,), one=True)

    @staticmethod
    def find_all(status=None, role=None):
        """查询全部账户，支持筛选"""
        conditions = []
        params = []
        if status:
            conditions.append("status = ?")
            params.append(status)
        if role:
            conditions.append("role = ?")
            params.append(role)
        where = " WHERE " + " AND ".join(conditions) if conditions else ""
        return query(f"SELECT * FROM accounts{where} ORDER BY created_at DESC", params)

    @staticmethod
    def verify_password(username, password):
        """验证用户名密码，返回账户信息或 None

        兼容旧版裸 SHA-256 哈希：验证通过后自动升级为 PBKDF2。
        """
        account = Account.find_by_username(username)
        if not account:
            return None
        if account['status'] == 'disabled':
            return None
        stored_hash = account.get('password_hash', '')
        if not verify_password(password, stored_hash):
            return None
        # 旧哈希自动升级为 PBKDF2
        if needs_rehash(stored_hash):
            execute(
                "UPDATE accounts SET password_hash = ?, updated_at = ? WHERE id = ?",
                (hash_password(password), datetime.now().strftime('%Y-%m-%d %H:%M:%S'), account['id'])
            )
        # 更新最后登录时间
        now = datetime.now().strftime('%Y-%m-%d %H:%M:%S')
        execute("UPDATE accounts SET last_login_at = ? WHERE id = ?", (now, account['id']))
        account['last_login_at'] = now
        return account

    @staticmethod
    def update(account_id, **kwargs):
        """更新账户信息"""
        allowed = {'nickname', 'role', 'status'}
        fields = []
        params = []
        for k, v in kwargs.items():
            if k in allowed:
                fields.append(f"{k} = ?")
                params.append(v)
        if not fields:
            return None
        now = datetime.now().strftime('%Y-%m-%d %H:%M:%S')
        fields.append("updated_at = ?")
        params.append(now)
        params.append(account_id)
        execute(f"UPDATE accounts SET {', '.join(fields)} WHERE id = ?", params)
        return Account.find_by_id(account_id)

    @staticmethod
    def update_password(account_id, new_password):
        """更新密码"""
        password_hash = Account._hash_password(new_password)
        now = datetime.now().strftime('%Y-%m-%d %H:%M:%S')
        execute(
            "UPDATE accounts SET password_hash = ?, updated_at = ? WHERE id = ?",
            (password_hash, now, account_id)
        )

    @staticmethod
    def delete(account_id):
        """删除账户（级联删除关联店铺）"""
        execute("DELETE FROM accounts WHERE id = ?", (account_id,))

    @staticmethod
    def count(status=None):
        """统计账户数量"""
        if status:
            result = query("SELECT COUNT(*) as cnt FROM accounts WHERE status = ?", (status,), one=True)
        else:
            result = query("SELECT COUNT(*) as cnt FROM accounts", one=True)
        return result['cnt'] if result else 0


class Store:
    """店铺模型 - 管理 Ozon 店铺授权信息"""

    @staticmethod
    def create(store_id, alias, currency='RUB', store_group='默认',
               notify_on=True, auth_type='api', client_id=None, api_key=None,
               auth_status='pending', account_id=None):
        """创建店铺"""
        now = datetime.now().strftime('%Y-%m-%d %H:%M:%S')
        auth_time = now if auth_status == 'active' else None
        # api_key 加密后存储（明文不入库）
        encrypted_key = encrypt_secret(api_key) if api_key else None
        row_id = execute(
            """INSERT INTO stores
               (store_id, alias, currency, store_group, notify_on, auth_type,
                client_id, api_key, auth_status, auth_time, today_limit, account_id,
                created_at, updated_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?)""",
            (store_id, alias, currency, store_group, 1 if notify_on else 0,
             auth_type, client_id, encrypted_key, auth_status, auth_time,
             account_id, now, now)
        )
        return Store.find_by_id(row_id)

    @staticmethod
    def find_by_id(pk):
        """按主键 ID 查找店铺"""
        return query("SELECT * FROM stores WHERE id = ?", (pk,), one=True)

    @staticmethod
    def find_by_store_id(store_id):
        """按 Ozon 店铺 ID 查找"""
        return query("SELECT * FROM stores WHERE store_id = ?", (store_id,), one=True)

    @staticmethod
    def find_all(account_id=None, auth_status=None, store_group=None, keyword=None):
        """查询店铺列表，支持多条件筛选"""
        conditions = []
        params = []
        if account_id:
            conditions.append("account_id = ?")
            params.append(account_id)
        if auth_status:
            conditions.append("auth_status = ?")
            params.append(auth_status)
        if store_group:
            conditions.append("store_group = ?")
            params.append(store_group)
        if keyword:
            conditions.append("(store_id LIKE ? OR alias LIKE ? OR store_group LIKE ?)")
            kw = f"%{keyword}%"
            params.extend([kw, kw, kw])
        where = " WHERE " + " AND ".join(conditions) if conditions else ""
        return query(f"SELECT * FROM stores{where} ORDER BY created_at DESC", params)

    @staticmethod
    def update(store_pk, **kwargs):
        """更新店铺信息"""
        allowed = {'alias', 'currency', 'store_group', 'notify_on',
                   'auth_type', 'client_id', 'api_key', 'auth_status',
                   'auth_time', 'today_limit', 'account_id'}
        fields = []
        params = []
        for k, v in kwargs.items():
            if k in allowed:
                # api_key 加密后存储（若已是加密格式则保持，否则加密明文）
                if k == 'api_key' and v:
                    v = encrypt_secret(v)
                fields.append(f"{k} = ?")
                params.append(v)
        if not fields:
            return None
        now = datetime.now().strftime('%Y-%m-%d %H:%M:%S')
        fields.append("updated_at = ?")
        params.append(now)
        params.append(store_pk)
        execute(f"UPDATE stores SET {', '.join(fields)} WHERE id = ?", params)
        return Store.find_by_id(store_pk)

    @staticmethod
    def delete(store_pk):
        """删除店铺"""
        execute("DELETE FROM stores WHERE id = ?", (store_pk,))

    @staticmethod
    def batch_update_group(store_pks, store_group):
        """批量设置分组"""
        now = datetime.now().strftime('%Y-%m-%d %H:%M:%S')
        from db import execute_many
        execute_many(
            "UPDATE stores SET store_group = ?, updated_at = ? WHERE id = ?",
            [(store_group, now, pk) for pk in store_pks]
        )

    @staticmethod
    def batch_update_currency(store_pks, currency):
        """批量设置币种"""
        now = datetime.now().strftime('%Y-%m-%d %H:%M:%S')
        from db import execute_many
        execute_many(
            "UPDATE stores SET currency = ?, updated_at = ? WHERE id = ?",
            [(currency, now, pk) for pk in store_pks]
        )

    @staticmethod
    def batch_delete(store_pks):
        """批量删除店铺"""
        from db import execute_many
        execute_many(
            "DELETE FROM stores WHERE id = ?",
            [(pk,) for pk in store_pks]
        )

    @staticmethod
    def count(account_id=None, auth_status=None):
        """统计店铺数量"""
        conditions = []
        params = []
        if account_id:
            conditions.append("account_id = ?")
            params.append(account_id)
        if auth_status:
            conditions.append("auth_status = ?")
            params.append(auth_status)
        where = " WHERE " + " AND ".join(conditions) if conditions else ""
        result = query(f"SELECT COUNT(*) as cnt FROM stores{where}", params, one=True)
        return result['cnt'] if result else 0

    @staticmethod
    def get_groups(account_id=None):
        """获取所有分组列表"""
        if account_id:
            result = query(
                "SELECT DISTINCT store_group FROM stores WHERE account_id = ? ORDER BY store_group",
                (account_id,)
            )
        else:
            result = query("SELECT DISTINCT store_group FROM stores ORDER BY store_group")
        return [row['store_group'] for row in result]
