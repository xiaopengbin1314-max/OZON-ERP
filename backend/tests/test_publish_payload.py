import os
import sys
import unittest
from unittest.mock import patch


BACKEND_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if BACKEND_DIR not in sys.path:
    sys.path.insert(0, BACKEND_DIR)

from services.publish_service import (
    _match_dict_value,
    build_ozon_attributes,
    build_ozon_product_items,
    normalize_collected_color_skus,
    prefill_required_attributes,
    validate_ozon_product_items,
)


def _product(skus):
    return {
        'id': 'test-product',
        'title': 'Test product',
        'price': 100,
        'weight': 100,
        'length': 330000,
        'width': 80,
        'height': 80,
        'images': ['https://example.com/image.jpg'],
        'attributes': [],
        'skuAttrs': [{
            'name': '颜色名称（Название цвета）',
            'attrId': 10097,
            'skuType': 'text',
            'attrCategory': 'info',
        }],
        'skus': skus,
    }


class PublishPayloadTests(unittest.TestCase):
    def test_collected_color_collection_is_flattened_for_one_sku(self):
        product = {
            'title': 'Компактный маленький мини зонт - 6 спиц',
            'skuAttrs': [
                {
                    'name': '商品颜色（Цвет товара）', 'attrId': 10096,
                    'values': ['哑光黑色（черный матовый）, 黑色（черный）'],
                    'valueIds': [[970671251, 61574]],
                },
                {
                    'name': '颜色名称（Название цвета）', 'attrId': 10097,
                    'values': ['4 - черный'],
                },
            ],
            'skus': [{
                'title': 'Компактный маленький мини зонт...',
                'combo': {
                    '商品颜色（Цвет товара）': '哑光黑色（черный матовый）, 黑色（черный）',
                    '颜色名称（Название цвета）': '4 - черный',
                },
            }],
        }

        normalize_collected_color_skus(product)

        self.assertEqual(['哑光黑色（черный матовый）'], product['skuAttrs'][0]['values'])
        self.assertEqual([970671251], product['skuAttrs'][0]['valueIds'])
        self.assertEqual(['черный'], product['skuAttrs'][1]['values'])
        self.assertEqual('черный', product['skus'][0]['combo']['颜色名称（Название цвета）'])
        self.assertEqual(product['title'], product['skus'][0]['title'])

    def test_variant_description_uses_actual_color_segment(self):
        product = {
            'skuAttrs': [{
                'name': '商品颜色（Цвет товара）', 'attrId': 10096,
                'values': ['16 спиц 5х4, прям ручка, белый'],
            }, {
                'name': '颜色名称（Название цвета）', 'attrId': 10097,
                'values': ['16 спиц 5х4, прям ручка, белый'],
            }],
            'skus': [{
                'combo': {
                    '商品颜色（Цвет товара）': '16 спиц 5х4, прям ручка, белый',
                    '颜色名称（Название цвета）': '16 спиц 5х4, прям ручка, белый',
                },
            }],
        }

        normalize_collected_color_skus(product)

        self.assertEqual(['белый'], product['skuAttrs'][0]['values'])
        self.assertEqual('белый', product['skus'][0]['combo']['商品颜色（Цвет товара）'])
        self.assertEqual(
            '16 спиц 5х4, прям ручка, белый',
            product['skus'][0]['combo']['颜色名称（Название цвета）'],
        )

    def test_dictionary_match_uses_ozon_id_field(self):
        matched = _match_dict_value('Женский', [{'id': 22881, 'value': 'Женский'}])
        self.assertEqual(22881, matched['value_id'])

    def test_attributes_are_deduplicated_by_category_attribute_id(self):
        attrs = build_ozon_attributes([
            {'id': 501, 'dictionary_value_id': 10},
            {'id': 501, 'dictionary_value_id': 10},
            {'id': 501, 'dictionary_value_id': 11},
        ])
        self.assertEqual([
            {
                'id': 501,
                'values': [
                    {'dictionary_value_id': 10},
                    {'dictionary_value_id': 11},
                ],
            }
        ], attrs)

    @patch('services.ozon_api.validate_category_pair', return_value={'valid': True})
    @patch('services.ozon_api.get_category_attributes')
    def test_schema_validation_is_category_driven(self, get_category_attributes, _validate_pair):
        get_category_attributes.return_value = {'result': [{
            'id': 501,
            'name': 'Generic required option',
            'is_required': True,
            'dictionary_id': 9001,
            'max_value_count': 1,
        }]}
        product = {'descriptionCategoryId': 123, 'typeId': 456}
        item = {
            'name': 'Any category product',
            'offer_id': 'ANY-1',
            'description_category_id': 123,
            'type_id': 456,
            'price': '10',
            'images': ['https://example.com/a.jpg'],
            'weight': 10,
            'width': 10,
            'height': 10,
            'depth': 10,
            'attributes': [{'id': 501, 'values': [{'dictionary_value_id': 77}]}],
        }
        self.assertTrue(validate_ozon_product_items(product, [item])['valid'])

        item['attributes'] = [{'id': 501, 'values': [{'value': 'invalid text'}]}]
        result = validate_ozon_product_items(product, [item])
        self.assertFalse(result['valid'])
        self.assertTrue(any('dictionary_value_id' in error for error in result['errors']))

    @patch('services.publish_service._get_bilingual_category_attributes')
    def test_prefill_does_not_invent_category_specific_values(self, get_schema):
        get_schema.return_value = [
            {'id': 9048, 'name': 'Название модели', 'is_required': True},
            {'id': 7001, 'name': 'Материал корпуса', 'is_required': True, 'dictionary_id': 99},
        ]
        product = {
            'descriptionCategoryId': 123,
            'typeId': 456,
            'mergeCode': 'MODEL-1',
            'attributes': [],
        }

        result = prefill_required_attributes(product)

        self.assertEqual(1, result['prefilled'])
        self.assertEqual([7001], [attr['id'] for attr in result['required_remaining']])
        self.assertEqual('MODEL-1', product['attributes'][0]['value'])

    def test_split_mode_builds_one_item_per_sku_with_color_name(self):
        product = _product([
            {
                'skuCode': 'SKU-GREEN',
                'price': 100,
                'length': 330000,
                'width': 80,
                'height': 80,
                'combo': {'颜色名称（Название цвета）': 'Зеленый'},
                'images': ['https://example.com/green.jpg'],
            },
            {
                'skuCode': 'SKU-BLACK',
                'price': 110,
                'length': 330000,
                'width': 80,
                'height': 80,
                'combo': {'颜色名称（Название цвета）': 'Черный'},
            },
        ])

        items = build_ozon_product_items(product, publish_mode='split')

        self.assertEqual(2, len(items))
        self.assertEqual(['SKU-GREEN', 'SKU-BLACK'], [item['offer_id'] for item in items])
        self.assertEqual(['Test product', 'Test product'], [item['name'] for item in items])
        self.assertNotIn('Зеленый', items[0]['name'])
        self.assertNotIn('Черный', items[1]['name'])
        self.assertEqual(
            ['https://example.com/green.jpg', 'https://example.com/image.jpg'],
            items[0]['images'],
        )
        for item in items:
            color_name = next(attr for attr in item['attributes'] if attr['id'] == 10097)
            self.assertTrue(color_name['values'][0]['value'])
            self.assertEqual((330, 80, 80), (item['depth'], item['width'], item['height']))
            source = item['sources'][0]
            self.assertEqual((330, 80, 80), (source['depth'], source['width'], source['height']))

    def test_single_sku_promotes_color_name_to_item_attributes(self):
        product = _product([{
            'skuCode': 'SKU-ONE',
            'price': 100,
            'combo': {'颜色名称（Название цвета）': 'Белый'},
        }])

        item = build_ozon_product_items(product)[0]

        color_name = next(attr for attr in item['attributes'] if attr['id'] == 10097)
        self.assertEqual('Белый', color_name['values'][0]['value'])

    @patch('services.publish_service._find_color_id', return_value=61574)
    def test_one_click_sku_assembles_platform_sku_and_both_color_attributes(self, _find_color):
        product = _product([{
            'offerId': 'PLATFORM-SKU-1',
            'skuCode': 'PLATFORM-SKU-1',
            'sourceSku': '3741770213',
            'price': 100,
            'combo': {
                '商品颜色（Цвет товара）': 'черный',
                '颜色名称（Название цвета）': 'Черный матовый',
            },
        }])
        product['skuAttrs'] = [
            {
                'name': '商品颜色（Цвет товара）',
                'attrId': 10096,
                'dictionaryId': 1494,
                'skuType': 'color',
            },
            {
                'name': '颜色名称（Название цвета）',
                'attrId': 10097,
                'skuType': 'text',
            },
        ]

        item = build_ozon_product_items(product, publish_mode='split')[0]
        attrs = {attr['id']: attr['values'] for attr in item['attributes']}

        self.assertEqual('PLATFORM-SKU-1', item['offer_id'])
        self.assertEqual([{'dictionary_value_id': 61574}], attrs[10096])
        self.assertEqual([{'value': 'Черный матовый'}], attrs[10097])

    def test_dom_article_maps_only_to_model_name_and_platform_sku_maps_to_offer_id(self):
        product = _product([
            {'skuCode': 'PLATFORM-SKU-1', 'offerId': 'PLATFORM-SKU-1', 'price': 100},
            {'skuCode': 'PLATFORM-SKU-2', 'offerId': 'PLATFORM-SKU-2', 'price': 110},
        ])
        product['mergeCode'] = 'DOM-GENERATED-ARTICLE'
        product['attributes'] = [{
            'id': 9048,
            'name': 'Название модели (для объединения в одну карточку)',
            'value': 'OLD-MODEL',
            'values': [{'value': 'OLD-MODEL'}],
        }, {
            'id': 9048,
            'name': '型号名称（针对合并为一张商品卡片）',
            'value': 'DUPLICATE-OLD-MODEL',
        }]

        merged = build_ozon_product_items(product, publish_mode='merge')[0]
        merged_model = next(attr for attr in merged['attributes'] if attr['id'] == 9048)
        self.assertEqual([{'value': 'DOM-GENERATED-ARTICLE'}], merged_model['values'])
        self.assertEqual(
            ['PLATFORM-SKU-1', 'PLATFORM-SKU-2'],
            [source['offer_id'] for source in merged['sources']],
        )
        self.assertNotIn('DOM-GENERATED-ARTICLE', [source['offer_id'] for source in merged['sources']])

        split = build_ozon_product_items(product, publish_mode='split')
        self.assertEqual(['PLATFORM-SKU-1', 'PLATFORM-SKU-2'], [item['offer_id'] for item in split])
        for item in split:
            split_model = next(attr for attr in item['attributes'] if attr['id'] == 9048)
            self.assertEqual([{'value': 'DOM-GENERATED-ARTICLE'}], split_model['values'])


if __name__ == '__main__':
    unittest.main()
