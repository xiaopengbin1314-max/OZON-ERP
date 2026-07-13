"""
路由注册模块
集中管理所有蓝图路由的注册
"""
from flask import Blueprint
from routes.product_routes import product_bp
from routes.publish_routes import publish_bp
from routes.publish_record_routes import publish_record_bp
from routes.notice_routes import notice_bp
from routes.auth_routes import auth_bp
from routes.store_routes import store_bp
from routes.category_routes import category_bp
from routes.model_routes import model_bp
from routes.pricing_routes import pricing_bp
from routes.ozon_data_routes import ozon_data_bp
from routes.watermark_routes import watermark_bp
from routes.exchange_rate_routes import exchange_rate_bp
from routes.selection_routes import selection_bp
from routes.favorite_routes import favorite_bp
from routes.online_product_routes import online_product_bp
from routes.dashboard_routes import dashboard_bp
from routes.gallery_routes import gallery_bp


def register_blueprints(app):
    """注册所有蓝图路由到 Flask 应用"""
    app.register_blueprint(product_bp, url_prefix='/api')
    app.register_blueprint(publish_bp, url_prefix='/api')
    app.register_blueprint(publish_record_bp, url_prefix='/api')
    app.register_blueprint(notice_bp, url_prefix='/api')
    app.register_blueprint(auth_bp, url_prefix='/api')
    app.register_blueprint(store_bp, url_prefix='/api')
    app.register_blueprint(category_bp, url_prefix='/api')
    app.register_blueprint(model_bp, url_prefix='/api')
    app.register_blueprint(pricing_bp, url_prefix='/api')
    app.register_blueprint(ozon_data_bp, url_prefix='/api')
    app.register_blueprint(watermark_bp, url_prefix='/api')
    app.register_blueprint(exchange_rate_bp, url_prefix='/api')
    app.register_blueprint(selection_bp, url_prefix='/api')
    app.register_blueprint(favorite_bp, url_prefix='/api')
    app.register_blueprint(online_product_bp, url_prefix='/api')
    app.register_blueprint(dashboard_bp, url_prefix='/api')
    app.register_blueprint(gallery_bp, url_prefix='/api')
