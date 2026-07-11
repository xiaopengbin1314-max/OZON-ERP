# GeekOzon ERP 系统

面向 Ozon 电商平台的全链路 ERP 管理系统，集成商品采集、AI 智能撰写、自动刊登、选品分析等核心功能。

## 系统架构

```
geekozon-erp/
├── frontend/          # 前端页面 (HTML5/CSS3/原生JS)
├── backend/           # Python Flask 后端服务
├── extension/         # Chrome 浏览器扩展 (Manifest V3)
└── README.md          # 项目说明文档
```

## 技术栈

| 层级 | 技术 |
|------|------|
| 前端 | HTML5 + CSS3 + 原生 JavaScript (ES2020+) |
| 后端 | Python Flask + SQLite (WAL 模式) |
| 扩展 | Chrome Extension Manifest V3 |
| AI | DeepSeek / 通义千问 (OpenAI 兼容接口) |
| 存储 | 本地文件 / 七牛云对象存储（可选） |

## 快速启动

### 1. 启动后端服务

```bash
cd backend
pip install flask flask-cors requests
python app.py
```

> **安全提示**：首次部署请编辑 `backend/.env`，配置 `SECRET_KEY`（生成命令：`python -c "import secrets; print(secrets.token_hex(32))"`）。生产环境保持 `FLASK_DEBUG=0` 并按需收敛 `CORS_ALLOWED_ORIGINS`。

服务地址：`http://localhost:5000`

### 2. 打开前端页面

直接在浏览器打开 `frontend/index.html`，或使用 VS Code Live Server 插件。

### 3. 加载浏览器扩展

1. 打开 Chrome，访问 `chrome://extensions/`
2. 开启右上角「开发者模式」
3. 点击「加载已解压的扩展程序」
4. 选择本项目 `extension/` 目录

## 功能模块

- **首页仪表盘**：欢迎页、功能卡片快捷入口、系统公告
- **商品采集**：通过浏览器扩展或 URL 批量采集 Ozon 商品
- **AI 撰写**：智能生成标题、描述优化、关键词推荐
- **上架管理**：批量发布到 Ozon、状态同步追踪
- **选品分析**：数据分析与市场洞察
- **浏览器扩展**：页面数据抓取、一键采集、快速刊登

## 接口说明

后端 RESTful API 基础地址：`http://localhost:5000/api`（共 8 个 Blueprint 路由模块）

| 方法 | 路径 | 用途 |
|------|------|------|
| GET | `/api/notices` | 获取公告列表 |
| GET | `/api/products` | 获取商品列表（分页/筛选/搜索） |
| POST | `/api/products` | 新增商品采集 |
| POST | `/api/publish` | 提交发布任务（异步） |
| GET | `/api/publish/tasks` | 查询发布任务状态 |
| POST | `/api/categories/ai-match` | AI 类目匹配 |
| GET | `/api/stores` | 店铺管理 |
| POST | `/api/auth/login` | 账户登录 |
| GET | `/api/ai/models` | AI 模型配置管理 |
| GET | `/api/health` | 健康检查 |

详细接口文档请参考 `.trae/documents/tech-architecture.md`
