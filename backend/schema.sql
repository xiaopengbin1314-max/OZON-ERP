-- GeekOzon ERP 数据库 Schema
-- 账户表 + 店铺管理表

-- ===== 账户表 =====
CREATE TABLE IF NOT EXISTS accounts (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    username        TEXT    NOT NULL UNIQUE,
    nickname        TEXT    NOT NULL DEFAULT '',
    password_hash   TEXT    NOT NULL,
    role            TEXT    NOT NULL DEFAULT 'operator' CHECK(role IN ('admin', 'operator')),
    status          TEXT    NOT NULL DEFAULT 'active' CHECK(status IN ('active', 'disabled')),
    last_login_at   TEXT,
    created_at      TEXT    NOT NULL DEFAULT (datetime('now')),
    updated_at      TEXT    NOT NULL DEFAULT (datetime('now'))
);

-- 账户表索引
CREATE UNIQUE INDEX IF NOT EXISTS idx_accounts_username ON accounts(username);

-- ===== 店铺管理表 =====
CREATE TABLE IF NOT EXISTS stores (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    store_id        TEXT    NOT NULL UNIQUE,           -- Ozon 平台店铺 ID
    alias           TEXT    NOT NULL DEFAULT '',        -- 店铺别名
    currency        TEXT    NOT NULL DEFAULT 'RUB',     -- 店铺币种
    store_group     TEXT    NOT NULL DEFAULT '默认',     -- 分组名称
    notify_on       INTEGER NOT NULL DEFAULT 0,         -- 通知推送开关 (0=关, 1=开)
    auth_type       TEXT    NOT NULL DEFAULT 'api' CHECK(auth_type IN ('api', 'cookie')),  -- 授权类型
    client_id       TEXT,                                -- Ozon API Client-Id
    api_key         TEXT,                                -- Ozon API Key (加密存储)
    auth_status     TEXT    NOT NULL DEFAULT 'pending' CHECK(auth_status IN ('active', 'expired', 'pending', 'disabled')),
    auth_time       TEXT,                                -- 授权时间
    today_limit     INTEGER NOT NULL DEFAULT 0,         -- 今日可刊登数
    account_id      INTEGER,                           -- 所属账户 ID（可为空，表示公共店铺）
    created_at      TEXT    NOT NULL DEFAULT (datetime('now')),
    updated_at      TEXT    NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE CASCADE
);

-- 店铺表索引
CREATE INDEX IF NOT EXISTS idx_stores_store_id ON stores(store_id);
CREATE INDEX IF NOT EXISTS idx_stores_account_id ON stores(account_id);
CREATE INDEX IF NOT EXISTS idx_stores_auth_status ON stores(auth_status);
CREATE INDEX IF NOT EXISTS idx_stores_store_group ON stores(store_group);

-- ===== Ozon 完整类目树表（每月同步一次） =====
CREATE TABLE IF NOT EXISTS ozon_categories (
    id                          INTEGER PRIMARY KEY AUTOINCREMENT,
    description_category_id     INTEGER,                    -- L1/L2 的 Ozon 类目 ID
    type_id                     INTEGER,                    -- L3 叶子节点的 Ozon 类型 ID
    parent_id                   INTEGER,                    -- 父节点本表 id（L1 为 NULL）
    level                       INTEGER NOT NULL,           -- 层级: 1/2/3
    category_name               TEXT NOT NULL DEFAULT '',    -- 合并名: "中文（俄语）"
    category_name_zh            TEXT NOT NULL DEFAULT '',    -- 中文名
    category_name_ru            TEXT NOT NULL DEFAULT '',    -- 俄语名
    disabled                    INTEGER NOT NULL DEFAULT 0,  -- 是否禁用 (0/1)
    created_at                  TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at                  TEXT NOT NULL DEFAULT (datetime('now'))
);

-- 类目树索引
CREATE INDEX IF NOT EXISTS idx_ozon_categories_level ON ozon_categories(level);
CREATE INDEX IF NOT EXISTS idx_ozon_categories_parent ON ozon_categories(parent_id);
CREATE INDEX IF NOT EXISTS idx_ozon_categories_desc_cat ON ozon_categories(description_category_id);
CREATE INDEX IF NOT EXISTS idx_ozon_categories_type_id ON ozon_categories(type_id);

-- ===== 动态类目映射缓存表（替代 JSON 文件） =====
CREATE TABLE IF NOT EXISTS category_mappings (
    id                          INTEGER PRIMARY KEY AUTOINCREMENT,
    cache_key                   TEXT NOT NULL UNIQUE,        -- md5(source_category + '||' + title) 前16位
    source_category             TEXT NOT NULL DEFAULT '',
    title                       TEXT NOT NULL DEFAULT '',
    description_category_id     INTEGER,
    type_id                     INTEGER,
    label                       TEXT NOT NULL DEFAULT '',
    confidence                  TEXT NOT NULL DEFAULT 'medium',
    matched                     INTEGER NOT NULL DEFAULT 0,  -- 0=未匹配, 1=已匹配
    manual                      INTEGER NOT NULL DEFAULT 0,  -- 0=自动, 1=手动添加
    hit_count                   INTEGER NOT NULL DEFAULT 0,
    created_at                  TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at                  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_category_mappings_source ON category_mappings(source_category);
CREATE INDEX IF NOT EXISTS idx_category_mappings_matched ON category_mappings(matched);

-- ===== 类目同步日志表 =====
CREATE TABLE IF NOT EXISTS ozon_category_sync_log (
    id                          INTEGER PRIMARY KEY AUTOINCREMENT,
    sync_type                   TEXT NOT NULL DEFAULT 'category_tree',  -- category_tree / attributes
    status                      TEXT NOT NULL DEFAULT 'running',         -- running / success / failed
    total_count                 INTEGER NOT NULL DEFAULT 0,
    duration_seconds            REAL NOT NULL DEFAULT 0,
    error_message               TEXT,
    created_at                  TEXT NOT NULL DEFAULT (datetime('now')),
    finished_at                 TEXT
);

CREATE INDEX IF NOT EXISTS idx_sync_log_status ON ozon_category_sync_log(status);
CREATE INDEX IF NOT EXISTS idx_sync_log_created ON ozon_category_sync_log(created_at);

-- ===== 类目属性表（每个 L3 类目的特征/属性） =====
CREATE TABLE IF NOT EXISTS ozon_category_attributes (
    id                          INTEGER PRIMARY KEY AUTOINCREMENT,
    description_category_id     INTEGER NOT NULL,            -- 所属类目 ID（L1/L2 的 description_category_id）
    type_id                     INTEGER NOT NULL,             -- L3 类型 ID
    attribute_id                INTEGER NOT NULL,             -- Ozon 属性 ID
    name                        TEXT NOT NULL DEFAULT '',      -- 合并名 "中文（俄语）"
    name_zh                     TEXT NOT NULL DEFAULT '',      -- 中文名
    name_ru                     TEXT NOT NULL DEFAULT '',      -- 俄语名
    description                 TEXT NOT NULL DEFAULT '',
    attr_type                   TEXT NOT NULL DEFAULT 'String', -- Ozon 原始类型: String/Text/Integer/Decimal/Boolean/Color
    is_required                 INTEGER NOT NULL DEFAULT 0,
    is_collection               INTEGER NOT NULL DEFAULT 0,
    is_aspect                   INTEGER NOT NULL DEFAULT 0,
    group_name                  TEXT NOT NULL DEFAULT '',
    group_id                    INTEGER NOT NULL DEFAULT 0,
    dictionary_id               INTEGER NOT NULL DEFAULT 0,
    max_value_count             INTEGER NOT NULL DEFAULT 0,
    created_at                  TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(description_category_id, type_id, attribute_id)
);

CREATE INDEX IF NOT EXISTS idx_attrs_type_id ON ozon_category_attributes(type_id);
CREATE INDEX IF NOT EXISTS idx_attrs_desc_cat ON ozon_category_attributes(description_category_id);
CREATE INDEX IF NOT EXISTS idx_attrs_attr_id ON ozon_category_attributes(attribute_id);
CREATE INDEX IF NOT EXISTS idx_attrs_dict_id ON ozon_category_attributes(dictionary_id);

-- ===== 属性字典值表（有 dictionary_id 的属性的可选值） =====
-- 注意：dictionary_id 在 Ozon 中可能被多个类目共享（如"类型"属性），
-- 不同类目下同一 dictionary_id 返回的可选值不同，
-- 因此必须用 (dictionary_id, description_category_id, type_id) 三元组定位。
CREATE TABLE IF NOT EXISTS ozon_attribute_dictionary_values (
    id                          INTEGER PRIMARY KEY AUTOINCREMENT,
    dictionary_id               INTEGER NOT NULL,            -- 所属字典 ID
    attribute_id                INTEGER NOT NULL,             -- 所属属性 ID
    description_category_id     INTEGER NOT NULL DEFAULT 0,   -- Ozon 二级类目 ID（区分共享字典）
    type_id                     INTEGER NOT NULL DEFAULT 0,   -- Ozon 三级类型 ID（区分共享字典）
    value_id                    INTEGER,                      -- Ozon 字典值 ID
    value                       TEXT NOT NULL DEFAULT '',      -- 合并值 "中文（俄语）"
    value_zh                    TEXT NOT NULL DEFAULT '',
    value_ru                    TEXT NOT NULL DEFAULT '',
    info                        TEXT NOT NULL DEFAULT '',
    picture_url                 TEXT NOT NULL DEFAULT '',
    created_at                  TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(dictionary_id, description_category_id, type_id, value_id)
);

CREATE INDEX IF NOT EXISTS idx_dict_values_dict_id ON ozon_attribute_dictionary_values(dictionary_id, description_category_id, type_id);
CREATE INDEX IF NOT EXISTS idx_dict_values_attr_id ON ozon_attribute_dictionary_values(attribute_id);

-- ===== 类目属性同步进度表（记录批量同步进度） =====
CREATE TABLE IF NOT EXISTS ozon_attr_sync_progress (
    id                          INTEGER PRIMARY KEY AUTOINCREMENT,
    total_type_ids              INTEGER NOT NULL DEFAULT 0,   -- 需要同步的 L3 类目总数
    synced_count                INTEGER NOT NULL DEFAULT 0,   -- 已同步数
    failed_count                INTEGER NOT NULL DEFAULT 0,   -- 失败数
    current_type_id             INTEGER,                      -- 当前正在同步的 type_id
    status                      TEXT NOT NULL DEFAULT 'idle',  -- idle / running / paused / completed
    started_at                  TEXT,
    updated_at                  TEXT NOT NULL DEFAULT (datetime('now')),
    finished_at                 TEXT
);

-- ===== 定价配置表（持久化汇率/利润率/佣金/运费/税费/损耗等参数）=====
-- 替代 .env 中的硬编码，支持通过 /api/config/pricing 在 UI 上持久化修改。
CREATE TABLE IF NOT EXISTS pricing_config (
    id                          INTEGER PRIMARY KEY,            -- 固定为 1（单行配置表）
    exchange_rate_cny_to_rub    REAL NOT NULL DEFAULT 12.5,    -- CNY→RUB 汇率
    profit_margin               REAL NOT NULL DEFAULT 1.3,     -- 利润系数
    old_price_ratio             REAL NOT NULL DEFAULT 1.2,     -- 划线价系数
    -- 3档销售佣金率（按售价分段，<=1500 / <=5000 / >5000 RUB）
    commission_rate_1           REAL NOT NULL DEFAULT 0.15,    -- 售价 ≤1500 佣金率
    commission_rate_2           REAL NOT NULL DEFAULT 0.12,    -- 售价 ≤5000 佣金率
    commission_rate_3           REAL NOT NULL DEFAULT 0.10,    -- 售价 >5000 佣金率
    commission_threshold_1      REAL NOT NULL DEFAULT 1500,    -- 第1档售价上限
    commission_threshold_2      REAL NOT NULL DEFAULT 5000,    -- 第2档售价上限
    -- 物流费用（默认 FBO 模式）
    shipping_rate_per_kg        REAL NOT NULL DEFAULT 80,      -- FBO 运费单价(RUB/kg)
    shipping_first_weight_kg    REAL NOT NULL DEFAULT 0,       -- 首重(kg)，0=无首重
    shipping_first_weight_fee   REAL NOT NULL DEFAULT 0,       -- 首重费用(RUB)
    -- FBS / realFBS 模式运费（可分别配置）
    fbs_shipping_rate_per_kg    REAL NOT NULL DEFAULT 60,      -- FBS 运费单价(RUB/kg)
    realfbs_shipping_rate_per_kg REAL NOT NULL DEFAULT 50,     -- realFBS 运费单价(RUB/kg)
    -- 体积重系数（空运 5000，陆运 6000）
    volumetric_divisor          REAL NOT NULL DEFAULT 5000,    -- 体积重 = 长*宽*高(mm) / 此值
    -- 税费
    vat_rate                    REAL NOT NULL DEFAULT 0,       -- 增值税率（0 / 0.1 / 0.2）
    individual_tax_rate         REAL NOT NULL DEFAULT 0,       -- 个税率（俄罗斯个税通常 4-6%）
    -- 损耗与退货
    return_rate                 REAL NOT NULL DEFAULT 0,       -- 退货率（0-1）
    loss_rate                   REAL NOT NULL DEFAULT 0,       -- 损耗率（0-1）
    packaging_fee               REAL NOT NULL DEFAULT 0,       -- 包装费(RUB/件)
    other_cost                  REAL NOT NULL DEFAULT 0,       -- 其他成本(RUB/件)
    -- 货币
    default_currency            TEXT NOT NULL DEFAULT 'CNY',   -- 默认币种
    updated_at                  TEXT NOT NULL DEFAULT (datetime('now'))
);

-- 初始化默认配置行（若不存在则插入）
INSERT OR IGNORE INTO pricing_config (id) VALUES (1);

-- ===== 类目佣金率表（Ozon 实际佣金因类目而异，5%-25%）=====
-- 优先级：本表 > pricing_config 的 3 档默认佣金
CREATE TABLE IF NOT EXISTS category_commissions (
    id                          INTEGER PRIMARY KEY AUTOINCREMENT,
    description_category_id     INTEGER NOT NULL,              -- Ozon 二级类目 ID
    type_id                     INTEGER NOT NULL DEFAULT 0,    -- Ozon 三级类型 ID（0=类目级通用）
    sale_commission_rate        REAL NOT NULL DEFAULT 0.15,    -- 销售佣金率
    logistics_commission_rate   REAL NOT NULL DEFAULT 0,       -- 物流佣金率（若适用）
    acquisition_commission_rate REAL NOT NULL DEFAULT 0,       -- 流量佣金率
    fbo_handling_fee            REAL NOT NULL DEFAULT 0,       -- FBO 配送费(RUB/件)
    fbs_handling_fee            REAL NOT NULL DEFAULT 0,       -- FBS 配送费(RUB/件)
    source                      TEXT NOT NULL DEFAULT 'manual', -- manual / ozon_api
    updated_at                  TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(description_category_id, type_id)
);

CREATE INDEX IF NOT EXISTS idx_category_commissions_cat ON category_commissions(description_category_id, type_id);

-- ===== 运费模板表（按物流模式 + 重量阶梯）=====
CREATE TABLE IF NOT EXISTS shipping_templates (
    id                          INTEGER PRIMARY KEY AUTOINCREMENT,
    name                        TEXT NOT NULL UNIQUE,          -- 模板名称
    logistics_mode              TEXT NOT NULL DEFAULT 'fbo',   -- fbo / fbs / realfbs
    weight_kg_from              REAL NOT NULL DEFAULT 0,       -- 阶梯起始重量(kg)
    weight_kg_to                REAL NOT NULL DEFAULT 999,     -- 阶梯结束重量(kg)
    fee                         REAL NOT NULL DEFAULT 0,       -- 该阶梯基础运费(RUB)
    fee_per_kg_over             REAL NOT NULL DEFAULT 0,       -- 超过 weight_kg_from 后每公斤加价(RUB)
    is_default                  INTEGER NOT NULL DEFAULT 0,    -- 是否默认模板
    notes                       TEXT NOT NULL DEFAULT '',
    created_at                  TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at                  TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ===== 定价历史记录表（每次定价测算落库审计）=====
CREATE TABLE IF NOT EXISTS pricing_history (
    id                          INTEGER PRIMARY KEY AUTOINCREMENT,
    product_id                  TEXT,                          -- 关联商品 ID（可空）
    source                      TEXT NOT NULL DEFAULT 'manual', -- manual / calculator / batch / publish
    -- 输入参数
    cost_cny                    REAL NOT NULL DEFAULT 0,
    weight_g                    REAL NOT NULL DEFAULT 0,
    length_mm                   REAL NOT NULL DEFAULT 0,
    width_mm                    REAL NOT NULL DEFAULT 0,
    height_mm                   REAL NOT NULL DEFAULT 0,
    description_category_id     INTEGER,
    type_id                     INTEGER,
    logistics_mode              TEXT NOT NULL DEFAULT 'fbo',
    target_margin               REAL,                          -- 目标利润率
    -- 输出结果
    suggested_price             REAL,                          -- 建议售价(RUB)
    old_price                   REAL,                          -- 划线价(RUB)
    profit                      REAL,                          -- 单件利润(RUB)
    profit_rate                 REAL,                          -- 利润率(0-1)
    cost_breakdown              TEXT,                          -- 成本明细 JSON 字符串
    created_at                  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_pricing_history_product ON pricing_history(product_id);
CREATE INDEX IF NOT EXISTS idx_pricing_history_created ON pricing_history(created_at);

-- ===== Ozon SKU 数据缓存表 =====
-- 前端通过 seller-bridge 借权从 seller.ozon.ru 获取 sales/variant 数据聚合后缓存
-- 供 popup / ERP 管理面板 / 数据卡片复用，避免重复请求 seller.ozon.ru
CREATE TABLE IF NOT EXISTS ozon_sku_data (
    sku             TEXT PRIMARY KEY,                  -- Ozon SKU
    title           TEXT NOT NULL DEFAULT '',           -- 商品标题（便于搜索）
    data            TEXT NOT NULL,                      -- 聚合数据 JSON 字符串
    source          TEXT NOT NULL DEFAULT 'seller_bridge',
    created_at      TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_ozon_sku_data_updated ON ozon_sku_data(updated_at);
CREATE INDEX IF NOT EXISTS idx_ozon_sku_data_title ON ozon_sku_data(title);

-- ===== 水印模板表 =====
-- 替代毛子 ERP 云端 /api.watermark/templates，本地管理商品图片水印模板
CREATE TABLE IF NOT EXISTS watermark_templates (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    name            TEXT NOT NULL UNIQUE,                  -- 模板名称
    config          TEXT NOT NULL DEFAULT '{}',           -- 水印配置 JSON（位置/透明度/文字/字号/图片等）
    is_default      INTEGER NOT NULL DEFAULT 0,            -- 是否默认模板 (0/1)
    created_at      TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_watermark_templates_default ON watermark_templates(is_default);

-- ===== 选品规则表 =====
-- 替代毛子 ERP 云端 /api.selection.plugin/*，本地管理选品规则
CREATE TABLE IF NOT EXISTS selection_rules (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    name            TEXT NOT NULL UNIQUE,                  -- 规则名称（唯一标识）
    label           TEXT NOT NULL DEFAULT '',              -- 规则显示名（前端展示）
    priority        INTEGER NOT NULL DEFAULT 0,           -- 优先级（数字越大越优先）
    card_color      TEXT NOT NULL DEFAULT '',              -- 卡片颜色（前端样式）
    is_auto_favorite INTEGER NOT NULL DEFAULT 0,           -- 命中后是否自动收藏 (0/1)
    is_open         INTEGER NOT NULL DEFAULT 0,           -- 是否启用 (0/1)
    conditions      TEXT NOT NULL DEFAULT '[]',           -- 规则条件 JSON 数组
    created_at      TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_selection_rules_is_open ON selection_rules(is_open);
CREATE INDEX IF NOT EXISTS idx_selection_rules_priority ON selection_rules(priority);

-- ===== 商品收藏表 =====
-- 替代毛子 ERP 云端 /api.product.favorite/*，本地收藏商品
CREATE TABLE IF NOT EXISTS product_favorites (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    sku             TEXT NOT NULL UNIQUE,                  -- 商品 SKU（唯一）
    title           TEXT NOT NULL DEFAULT '',              -- 商品标题
    cover_image     TEXT NOT NULL DEFAULT '',              -- 封面图 URL
    price_info      TEXT NOT NULL DEFAULT '{}',            -- 价格信息 JSON
    rule_ids        TEXT NOT NULL DEFAULT '[]',            -- 命中的选品规则 ID JSON 数组
    auto_favorite    INTEGER NOT NULL DEFAULT 0,           -- 是否自动收藏 (0/1)
    created_at      TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_product_favorites_created ON product_favorites(created_at);
CREATE INDEX IF NOT EXISTS idx_product_favorites_auto ON product_favorites(auto_favorite);

-- ===== 在线商品表（同步自 Ozon 店铺的真实在售商品）=====
-- 字段对齐前端 online-products.js 的 22 个展示字段，不改变前端数据结构
-- 通过 /v2/product/list + /v3/product/info/list 从 Ozon Seller API 拉取并 upsert
CREATE TABLE IF NOT EXISTS online_products (
    id                  INTEGER PRIMARY KEY AUTOINCREMENT,
    -- 前端展示字段（与 mock 数据结构完全一致）
    sku                 TEXT NOT NULL DEFAULT '',        -- 本地 SKU 编码（沿用 offer_id 或本地命名）
    title               TEXT NOT NULL DEFAULT '',        -- 商品标题（俄文）
    image               TEXT NOT NULL DEFAULT '',        -- 主图 URL
    grp                 TEXT NOT NULL DEFAULT '未分组',   -- 分组（避开 SQL 保留字 group）
    rating              TEXT NOT NULL DEFAULT '',        -- 历史兼容字段，不再用于展示
    content_score       REAL,                            -- Ozon 内容评分（原始数值）
    status              TEXT NOT NULL DEFAULT 'reviewing',-- onsale/ready/reviewing/rejected/offline/archived
    price               REAL NOT NULL DEFAULT 0,         -- 售价（₽）
    original_price      REAL NOT NULL DEFAULT 0,         -- 原价/划线价（₽）
    sales               INTEGER NOT NULL DEFAULT 0,      -- 销量
    stock               INTEGER NOT NULL DEFAULT 0,      -- 库存
    category            TEXT NOT NULL DEFAULT '',        -- 类目（如 "宠物用品|美容护理"）
    store               TEXT NOT NULL DEFAULT '',        -- 所属店铺名
    publisher           TEXT NOT NULL DEFAULT '',        -- 发布人员
    time                TEXT NOT NULL DEFAULT '',        -- 展示时间字符串
    note                TEXT NOT NULL DEFAULT '',        -- 备注
    source_id           TEXT NOT NULL DEFAULT '',        -- 1688 货源 ID
    product_id          TEXT NOT NULL DEFAULT '',        -- Ozon 产品 ID（字符串形式）
    merge_no            TEXT NOT NULL DEFAULT '',        -- 合并编号
    sku_id              TEXT NOT NULL DEFAULT '',        -- Ozon SKU ID
    platform_sku        TEXT NOT NULL DEFAULT '',        -- 平台 SKU
    source_link         TEXT NOT NULL DEFAULT '',        -- 货源链接
    source_name         TEXT NOT NULL DEFAULT '',        -- 货源名称
    -- 同步元数据（不直接展示，用于 API 调用和数据回溯）
    ozon_product_id     TEXT NOT NULL DEFAULT '',        -- Ozon 平台商品 ID（用于 /v3/product/info 查询）
    ozon_offer_id       TEXT NOT NULL DEFAULT '',        -- Ozon 卖家 SKU（用于价格/库存更新）
    store_id            INTEGER,                         -- 关联本地 stores.id
    ozon_status         TEXT NOT NULL DEFAULT '',        -- Ozon 原始状态（pending/active/...）
    last_synced_at      TEXT,                            -- 最后同步时间
    created_at          TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at          TEXT NOT NULL DEFAULT (datetime('now'))
);

-- 在线商品表索引
CREATE INDEX IF NOT EXISTS idx_online_products_status ON online_products(status);
CREATE INDEX IF NOT EXISTS idx_online_products_store ON online_products(store_id);
CREATE INDEX IF NOT EXISTS idx_online_products_ozon_pid ON online_products(ozon_product_id);
CREATE INDEX IF NOT EXISTS idx_online_products_ozon_offer ON online_products(ozon_offer_id);
CREATE INDEX IF NOT EXISTS idx_online_products_grp ON online_products(grp);
CREATE INDEX IF NOT EXISTS idx_online_products_updated ON online_products(updated_at);

-- ===== 我的图库 =====
CREATE TABLE IF NOT EXISTS gallery_assets (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    filename        TEXT NOT NULL UNIQUE,
    original_name   TEXT NOT NULL DEFAULT '',
    title           TEXT NOT NULL DEFAULT '',
    mime_type       TEXT NOT NULL DEFAULT 'image/png',
    file_size       INTEGER NOT NULL DEFAULT 0,
    source          TEXT NOT NULL DEFAULT 'upload',
    prompt          TEXT NOT NULL DEFAULT '',
    tags            TEXT NOT NULL DEFAULT '[]',
    favorite        INTEGER NOT NULL DEFAULT 0,
    created_at      TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at      TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_gallery_assets_created ON gallery_assets(created_at);
CREATE INDEX IF NOT EXISTS idx_gallery_assets_source ON gallery_assets(source);
CREATE INDEX IF NOT EXISTS idx_gallery_assets_favorite ON gallery_assets(favorite);
