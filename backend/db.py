"""
GeekOzon ERP - 数据库初始化与管理模块
基于 SQLite，提供连接管理、表初始化、迁移支持
"""
import os
import sqlite3
from config import Config, DATA_DIR

# 数据库文件路径
DB_PATH = os.path.join(DATA_DIR, 'geekozon.db')

# Schema 文件路径
SCHEMA_PATH = os.path.join(os.path.dirname(__file__), 'schema.sql')


def get_connection():
    """获取数据库连接（每次请求新建，用完需关闭）"""
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row  # 返回字典式行
    conn.execute("PRAGMA journal_mode=WAL")       # WAL 模式提升并发
    conn.execute("PRAGMA foreign_keys=ON")         # 启用外键约束
    return conn


def init_db():
    """初始化数据库：读取 schema.sql 创建表结构，并执行增量迁移"""
    conn = get_connection()
    try:
        with open(SCHEMA_PATH, 'r', encoding='utf-8') as f:
            conn.executescript(f.read())
        conn.commit()

        # ===== 增量迁移：为旧表添加新列 =====
        _run_migrations(conn)
    finally:
        conn.close()


def _run_migrations(conn):
    """执行增量数据库迁移（幂等：列已存在时跳过）"""
    # 迁移1：ozon_attribute_dictionary_values 添加 description_category_id 和 type_id 列
    # 原因：dictionary_id 在 Ozon 中可能被多个类目共享（如"类型"属性），
    #       不同类目下同一 dictionary_id 返回不同的可选值，
    #       旧表仅按 dictionary_id 存储，导致后同步的类目覆盖先前类目的字典值。
    existing_cols = {
        row['name']
        for row in conn.execute("PRAGMA table_info(ozon_attribute_dictionary_values)")
    }
    if 'description_category_id' not in existing_cols:
        conn.execute(
            "ALTER TABLE ozon_attribute_dictionary_values "
            "ADD COLUMN description_category_id INTEGER NOT NULL DEFAULT 0"
        )
    if 'type_id' not in existing_cols:
        conn.execute(
            "ALTER TABLE ozon_attribute_dictionary_values "
            "ADD COLUMN type_id INTEGER NOT NULL DEFAULT 0"
        )

    # 迁移2：stores 表添加 seller_cookies 列
    # 用途：保存从 seller.ozon.ru 上传的 Cookie（含 sc_company_id 等），
    #       供后端直接调用 seller API 或刷新 Cookie 时使用
    stores_cols = {
        row['name']
        for row in conn.execute("PRAGMA table_info(stores)")
    }
    if 'seller_cookies' not in stores_cols:
        conn.execute(
            "ALTER TABLE stores ADD COLUMN seller_cookies TEXT"
        )
    conn.commit()


def query(sql, params=(), one=False):
    """执行查询，返回字典列表或单条字典"""
    conn = get_connection()
    try:
        cursor = conn.execute(sql, params)
        rows = cursor.fetchall()
        if one:
            return dict(rows[0]) if rows else None
        return [dict(row) for row in rows]
    finally:
        conn.close()


def execute(sql, params=()):
    """执行写操作（INSERT/UPDATE/DELETE），返回 lastrowid"""
    conn = get_connection()
    try:
        cursor = conn.execute(sql, params)
        conn.commit()
        return cursor.lastrowid
    finally:
        conn.close()


def execute_many(sql, params_list):
    """批量执行写操作"""
    conn = get_connection()
    try:
        conn.executemany(sql, params_list)
        conn.commit()
    finally:
        conn.close()
