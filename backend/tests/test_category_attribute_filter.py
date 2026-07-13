import os
import sys
import unittest
from unittest.mock import patch


BACKEND_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if BACKEND_DIR not in sys.path:
    sys.path.insert(0, BACKEND_DIR)

from routes.category_routes import _filter_common_attrs
from routes.product_routes import (
    _clean_marketplace_product,
    _extract_ozon_product_type_signal,
    _normalize_product_video_fields,
    _normalize_source_category,
)
from services.ozon_api import validate_category_pair
from services.category_matcher import (
    _build_flat_categories,
    _save_to_cache,
    _split_path_segments,
    _try_cache,
    _try_exact_name_match,
)


class CategoryAttributeFilterTests(unittest.TestCase):
    def test_ozon_video_attributes_are_classified_into_product_video_fields(self):
        product = {
            'attributes': [
                {'id': 21845, 'value': 'https://cdn.test/cover.mp4'},
                {'id': 21841, 'values': [
                    {'value': 'https://cdn.test/a.mp4'},
                    {'value': 'https://cdn.test/b.mp4'},
                ]},
                {'id': 21837, 'value': 'Demo title'},
                {'id': 22273, 'value': 'SKU-1, SKU-2'},
            ],
            'videos': ['https://cdn.test/a.mp4'],
        }

        _normalize_product_video_fields(product)

        self.assertEqual('https://cdn.test/cover.mp4', product['coverVideoUrl'])
        self.assertEqual(['https://cdn.test/a.mp4', 'https://cdn.test/b.mp4'], product['videoList'])
        self.assertEqual([
            'https://cdn.test/cover.mp4', 'https://cdn.test/a.mp4', 'https://cdn.test/b.mp4',
        ], product['videos'])
        self.assertEqual([21845, 21841], [attr['id'] for attr in product['attributes']])

    def test_erp_video_fields_replace_stale_video_attributes(self):
        product = {
            'coverVideoUrl': 'https://cdn.test/new-cover.mp4',
            'videoList': ['https://cdn.test/new-description.mp4'],
            'videos': ['https://cdn.test/new-cover.mp4', 'https://cdn.test/new-description.mp4'],
            'attributes': [
                {'id': 21845, 'value': 'https://cdn.test/old-cover.mp4'},
                {'id': 21841, 'value': 'https://cdn.test/old-description.mp4'},
            ],
        }

        _normalize_product_video_fields(product)

        self.assertEqual('https://cdn.test/new-cover.mp4', product['coverVideoUrl'])
        self.assertEqual(['https://cdn.test/new-description.mp4'], product['videoList'])
        self.assertEqual(
            [{'value': 'https://cdn.test/new-cover.mp4'}],
            product['attributes'][0]['values'],
        )
        self.assertEqual(
            [{'value': 'https://cdn.test/new-description.mp4'}],
            product['attributes'][1]['values'],
        )

    def test_ozon_type_characteristic_is_strong_category_signal(self):
        product = {
            'platform': 'ozon',
            'attributes': [{'name': 'Тип', 'value': 'Сумка для сменной обуви'}],
        }

        self.assertEqual(
            'Сумка для сменной обуви',
            _extract_ozon_product_type_signal(product),
        )

    def test_non_ozon_type_characteristic_is_not_promoted(self):
        product = {
            'platform': '1688',
            'attributes': [{'name': '类型', 'value': '收纳袋'}],
        }

        self.assertEqual('', _extract_ozon_product_type_signal(product))

    def test_1688_payload_is_cleaned_before_erp_backfill(self):
        product = {
            'platform': '1688',
            'title': '  12骨全自动\n晴雨伞  ',
            'price': '￥ 19.80 起',
            'images': 'https://img.example/a.jpg\nhttps://img.example/a.jpg',
            'attributes': {'品牌': ' 无品牌 ', '材质': '碰击布'},
            'skus': [{
                'name': '黑色',
                'price': '￥19.80',
                'stock': '25件',
                'offer_id': 'SKU-1',
                'images': 'https://img.example/black.jpg',
                'combo': {'规格选项': '黑色'},
            }],
        }

        cleaned = _clean_marketplace_product(product)

        self.assertEqual('12骨全自动 晴雨伞', cleaned['title'])
        self.assertEqual(19.8, cleaned['sourcePrice'])
        self.assertEqual(['https://img.example/a.jpg'], cleaned['images'])
        self.assertEqual('SKU-1', cleaned['skus'][0]['skuCode'])
        self.assertEqual(25, cleaned['skus'][0]['stock'])
        self.assertEqual(cleaned['skus'], cleaned['skuList'])
        self.assertEqual(cleaned['skus'], cleaned['variants'])
        self.assertFalse(cleaned['_cleaned'])

    def test_1688_category_path_is_canonicalized_and_preserved(self):
        product = {
            'platform': 'alibaba1688',
            'category': 'leaf fallback',
            'categoryPath': ['家居用品', '收纳用品', '收纳盒'],
            'categoryId': 12345,
        }

        source = _normalize_source_category(product)

        self.assertEqual('1688', product['platform'])
        self.assertEqual('家居用品 / 收纳用品 / 收纳盒', source)
        self.assertEqual('收纳盒', product['category'])
        self.assertEqual('12345', product['sourceCategoryId'])

    def test_legacy_leaf_category_remains_supported(self):
        product = {'platform': '1688', 'category': '收纳盒'}

        source = _normalize_source_category(product)

        self.assertEqual('收纳盒', source)
        self.assertEqual('收纳盒', product['categoryPath'])

    def test_comma_inside_category_name_is_not_a_path_separator(self):
        segments = _split_path_segments('Antiques / Vintage furniture, decor')

        self.assertEqual(
            ['antiques', 'vintage furniture, decor'],
            segments,
        )

    def test_duplicate_l3_name_requires_parent_path(self):
        tree = [
            {
                'category_name_zh': '家居', 'category_name_ru': 'дом',
                'children': [{
                    'description_category_id': 100,
                    'category_name_zh': '家具', 'category_name_ru': 'мебель',
                    'children': [{'type_id': 200, 'type_name_zh': '复古', 'type_name_ru': 'винтаж'}],
                }],
            },
            {
                'category_name_zh': '收藏', 'category_name_ru': 'коллекции',
                'children': [{
                    'description_category_id': 101,
                    'category_name_zh': '古董', 'category_name_ru': 'антиквариат',
                    'children': [{'type_id': 201, 'type_name_zh': '复古', 'type_name_ru': 'винтаж'}],
                }],
            },
        ]
        flat = _build_flat_categories(tree)

        ambiguous = _try_exact_name_match('винтаж', flat, 'ru')
        resolved = _try_exact_name_match('коллекции / антиквариат / винтаж', flat, 'ru')

        self.assertFalse(ambiguous['matched'])
        self.assertEqual('ambiguous_exact_l3', ambiguous['_source'])
        self.assertTrue(resolved['matched'])
        self.assertEqual((101, 201), (resolved['description_category_id'], resolved['type_id']))

    @patch('services.category_mapping_cache.get_mapping', return_value=None)
    def test_category_cache_is_platform_scoped(self, get_mapping):
        _try_cache('Зонты', 'ozon')
        get_mapping.assert_called_once_with('Зонты', 'ozon')

    @patch('services.category_mapping_cache.set_mapping')
    def test_empty_or_low_confidence_match_is_not_cached(self, set_mapping):
        _save_to_cache('', {'matched': True, 'confidence': 'high'}, 'ozon')
        _save_to_cache('other', {'matched': True, 'confidence': 'low'}, '1688')
        set_mapping.assert_not_called()

    def test_category_pair_requires_real_parent_child_relationship(self):
        tree = [{
            'category_name_zh': '一级',
            'children': [{
                'description_category_id': 100,
                'category_name_zh': '二级',
                'children': [
                    {'type_id': 200, 'type_name_zh': '类型A'},
                    {'type_id': 201, 'type_name_zh': '类型B'},
                ],
            }],
        }]

        self.assertTrue(validate_category_pair(100, 200, tree=tree)['valid'])
        self.assertFalse(validate_category_pair(100, 999, tree=tree)['valid'])
        self.assertFalse(validate_category_pair(999, 200, tree=tree)['valid'])

    def test_only_exact_top_level_fields_are_filtered(self):
        attrs = [
            {'id': 4180, 'name': 'Название'},
            {'id': 9001, 'name': 'Модель процессора'},
            {'id': 9002, 'name': 'Вес товара, г'},
            {'id': 9003, 'name': 'Длина упаковки'},
            {'id': 9048, 'name': 'Название модели (для объединения в одну карточку)'},
            {'id': 10097, 'name': 'Название цвета'},
        ]

        result = _filter_common_attrs(attrs)

        self.assertEqual(
            [9001, 9002, 9003, 9048, 10097],
            [attr['id'] for attr in result],
        )


if __name__ == '__main__':
    unittest.main()
