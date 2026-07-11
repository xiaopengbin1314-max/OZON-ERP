import os
import sys
import unittest
from unittest.mock import patch


BACKEND_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if BACKEND_DIR not in sys.path:
    sys.path.insert(0, BACKEND_DIR)

from routes.product_routes import (
    _classify_ozon_content,
    _normalize_publish_fields_for_persistence,
    _sync_rich_content_attribute,
)
from services.publish_service import build_ozon_product_items
from services.publish_service import (
    clean_legacy_flattened_sku_aspects,
    promote_collected_sku_combos,
    promote_product_color_to_skus,
)


class CollectionPublishIntegrityTests(unittest.TestCase):
    def test_mixed_variant_labels_are_not_promoted_as_product_colors(self):
        product = {
            'platform': 'ozon',
            'skuAttrs': [],
            'skus': [
                {'attributes': {'color': 'CosmoColour'}},
                {'attributes': {'color': '41-43 RU / 41-43'}},
                {'attributes': {'color': 'Белый серая подошва'}},
                {'attributes': {'color': 'CSM911'}},
            ],
        }

        promote_collected_sku_combos(product)

        self.assertEqual(['变体'], [attr['name'] for attr in product['skuAttrs']])
        self.assertTrue(all('变体' in sku['combo'] for sku in product['skus']))
        self.assertTrue(all('color' not in sku['combo'] for sku in product['skus']))

    def test_ozon_aspect_names_map_to_sales_and_sku_info_attributes(self):
        product = {
            'platform': 'ozon',
            'skuAttrs': [],
            'skus': [{
                'combo': {
                    'Российский размер': '41-43',
                    'Цвет товара': 'Черный',
                    'Количество пар в упаковке': '10 пар',
                    'Размер производителя': '38-40',
                    'Название цвета': 'Cosmo Black',
                },
            }],
        }

        promote_collected_sku_combos(product)

        by_id = {attr['attrId']: attr for attr in product['skuAttrs']}
        self.assertEqual('sales', by_id[4295]['attrCategory'])
        self.assertEqual('sales', by_id[10096]['attrCategory'])
        self.assertEqual('sales', by_id[9662]['attrCategory'])
        self.assertEqual('info', by_id[9533]['attrCategory'])
        self.assertEqual('info', by_id[10097]['attrCategory'])
        combo = product['skus'][0]['combo']
        self.assertIn('俄罗斯尺码（Российский размер）', combo)
        self.assertIn('颜色名称（Название цвета）', combo)

    def test_legacy_flattened_variant_removes_guessed_aspects(self):
        product = {'skuAttrs': [
            {'name': '变体', 'values': ['CSM911']},
            {'name': '商品颜色（Цвет товара）', 'attrId': 10096, 'values': ['Черный']},
        ], 'skus': [{
            'title': 'Носки мужские, 10 пар',
            'variantLabel': 'CSM911',
            'attributes': {'color': 'CSM911'},
            'combo': {'变体': 'CSM911', '商品颜色（Цвет товара）': 'Черный'},
        }]}

        clean_legacy_flattened_sku_aspects(product)

        self.assertEqual(['变体'], [attr['name'] for attr in product['skuAttrs']])
        self.assertEqual({'变体': 'CSM911'}, product['skus'][0]['combo'])

    @patch('services.ozon_api.get_attribute_values_full')
    def test_item_color_dictionary_id_is_promoted_to_erp_sku_fields(self, get_values):
        get_values.return_value = {'result': [{'id': 970671251, 'value': 'черный матовый'}]}
        product = {
            'platform': 'ozon',
            'descriptionCategoryId': 17027904,
            'typeId': 93352,
            'attributes': [{
                'id': 10096,
                'name': '商品颜色',
                'dictionary_value_ids': [970671251],
            }],
            'skuAttrs': [],
            'skus': [{'combo': {}}],
        }

        promote_product_color_to_skus(product)

        self.assertEqual([10096, 10097], [attr['attrId'] for attr in product['skuAttrs']])
        self.assertEqual(['черный матовый'], product['skuAttrs'][0]['values'])
        self.assertEqual([970671251], product['skuAttrs'][0]['valueIds'])
        self.assertEqual('черный матовый', product['skus'][0]['combo']['商品颜色（Цвет товара）'])
        self.assertEqual('черный матовый', product['skus'][0]['combo']['颜色名称（Название цвета）'])

    def test_plain_description_is_not_misclassified_as_rich_content(self):
        product = {
            'platform': 'ozon',
            'description': 'Ordinary product description',
            'richContent': 'Ordinary product description',
            'attributes': [],
        }

        _sync_rich_content_attribute(product)
        mode = _classify_ozon_content(product)

        self.assertEqual('plain_description', mode)
        self.assertEqual('Ordinary product description', product['description'])
        self.assertEqual('', product['richContent'])
        self.assertEqual([], product['attributes'])

    def test_valid_rich_content_clears_description_and_creates_11254(self):
        product = {
            'platform': 'ozon',
            'description': 'Duplicated rendered text',
            'richContent': {
                'version': 0.3,
                'content': [{
                    'widgetName': 'raTextBlock',
                    'text': {'items': [{'type': 'text', 'content': 'Rich text'}]},
                }],
            },
            'attributes': [],
        }

        _sync_rich_content_attribute(product)
        mode = _classify_ozon_content(product)

        self.assertEqual('rich_content', mode)
        self.assertEqual('', product['description'])
        self.assertTrue(product['richContent'])
        self.assertEqual(11254, product['attributes'][0]['id'])

    @patch('services.publish_service._find_color_id', return_value=61574)
    def test_one_click_fields_survive_persistence_and_assemble_separately(self, _find_color):
        product = {
            'id': 'one-click-product',
            'platform': 'ozon',
            'title': 'Umbrella',
            'mergeCode': 'DOM-MODEL-CODE',
            'price': 100,
            'weight': 100,
            'length': 330,
            'width': 80,
            'height': 80,
            'images': ['https://example.com/a.jpg'],
            'attributes': [{
                'id': 9048,
                'name': 'Название модели (для объединения в одну карточку)',
                'value': '',
            }],
            'skuAttrs': [{
                'name': '商品颜色（Цвет товара）',
                'attrId': 10096,
                'dictionaryId': 1494,
                'skuType': 'color',
                'values': ['черный, белый'],
                'valueIds': [[61574, 61575]],
            }, {
                'name': '颜色名称（Название цвета）',
                'attrId': 10097,
                'skuType': 'text',
                'values': ['4 - черный'],
            }],
            'skus': [{
                'sourceSku': 'OZON-SOURCE-1',
                'price': 100,
                'combo': {
                    '商品颜色（Цвет товара）': 'черный, белый',
                    '颜色名称（Название цвета）': '4 - черный',
                },
            }],
        }

        _normalize_publish_fields_for_persistence(product)

        saved_sku = product['skus'][0]
        self.assertTrue(saved_sku['skuCode'])
        self.assertEqual(saved_sku['skuCode'], saved_sku['offerId'])
        self.assertNotEqual('DOM-MODEL-CODE', saved_sku['skuCode'])
        self.assertEqual('черный', saved_sku['combo']['商品颜色（Цвет товара）'])
        self.assertEqual('черный', saved_sku['combo']['颜色名称（Название цвета）'])
        self.assertEqual(product['skus'], product['skuList'])
        self.assertEqual(product['skus'], product['variants'])

        item = build_ozon_product_items(product, publish_mode='split')[0]
        attrs = {attr['id']: attr['values'] for attr in item['attributes']}
        self.assertEqual(saved_sku['skuCode'], item['offer_id'])
        self.assertEqual([{'value': 'DOM-MODEL-CODE'}], attrs[9048])
        self.assertEqual([{'dictionary_value_id': 61574}], attrs[10096])
        self.assertEqual([{'value': 'черный'}], attrs[10097])


if __name__ == '__main__':
    unittest.main()
