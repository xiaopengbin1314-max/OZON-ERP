import os
import sys
import unittest
from unittest.mock import patch


BACKEND_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if BACKEND_DIR not in sys.path:
    sys.path.insert(0, BACKEND_DIR)

from routes.product_routes import (
    _classify_ozon_content,
    _merge_scanner_skus,
    _normalize_collected_dimensions,
    _normalize_publish_fields_for_persistence,
    _should_accept_category_match,
    _sync_rich_content_attribute,
)
from services.publish_service import build_ozon_product_items
from services.publish_service import (
    clean_legacy_flattened_sku_aspects,
    normalize_collected_color_skus,
    promote_collected_sku_combos,
    promote_product_color_to_skus,
)


class CollectionPublishIntegrityTests(unittest.TestCase):
    def test_repeated_dimension_conversion_uses_sku_mm_value(self):
        product = {
            'length': 33000,
            'width': 8000,
            'height': 8000,
            'skus': [{'length': 330, 'width': 80, 'height': 80}],
        }

        _normalize_collected_dimensions(product)

        self.assertEqual(330, product['length'])
        self.assertEqual(80, product['width'])
        self.assertEqual(80, product['height'])

    def test_dimension_uses_explicit_centimeter_attribute_without_sku(self):
        product = {
            'length': 30000,
            'attributes': [{'name': '折叠长度，厘米', 'value': '30'}],
        }

        _normalize_collected_dimensions(product)

        self.assertEqual(300, product['length'])

    def test_ozon_description_heading_is_removed_before_persistence(self):
        product = {
            'platform': 'ozon',
            'description': 'Описание\nСумка для спортивной обуви.',
            'contentEvidence': {
                'mode': 'plain_description',
                'descriptionValidated': True,
            },
        }

        mode = _classify_ozon_content(product)

        self.assertEqual('plain_description', mode)
        self.assertEqual('Сумка для спортивной обуви.', product['description'])

    def test_scanner_sku_refresh_replaces_images_by_source_sku(self):
        existing = [{
            'sourceSku': '101', 'skuCode': 'ERP-101', 'price': 99,
            'images': ['https://old.example/wrong.jpg'],
        }]
        incoming = [{
            'sourceSku': '101', 'skuCode': 'NEW-TEMP', 'price': 10,
            'images': ['https://new.example/sku-101.jpg'],
        }]

        refreshed = _merge_scanner_skus(existing, incoming)

        self.assertEqual(['https://new.example/sku-101.jpg'], refreshed[0]['images'])
        self.assertEqual('ERP-101', refreshed[0]['skuCode'])
        self.assertEqual(99, refreshed[0]['price'])

    def test_scanner_sku_refresh_promotes_legacy_sku_to_source_identity(self):
        existing = [{'sourceSku': '101', 'skuCode': 'ERP-101', 'price': 99}]
        incoming = [{'sku': '101', 'price': 10, 'images': ['https://new.example/101.jpg']}]

        refreshed = _merge_scanner_skus(existing, incoming)

        self.assertEqual('101', refreshed[0]['sourceSku'])
        self.assertEqual('ERP-101', refreshed[0]['skuCode'])
        self.assertEqual(99, refreshed[0]['price'])

    def test_ozon_medium_keyword_category_guess_is_not_accepted(self):
        match = {'matched': True, 'confidence': 'medium', '_source': 'keyword'}

        self.assertFalse(_should_accept_category_match(match, 'ozon'))
        self.assertTrue(_should_accept_category_match(match, '1688'))

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

    def test_explicit_ozon_color_repairs_legacy_generic_variant(self):
        product = {
            'platform': 'ozon',
            'skuAttrs': [{
                'name': '\u53d8\u4f53', 'values': ['\u0422\u0435\u043c\u043d\u043e-\u0441\u0438\u043d\u0438\u0439', '\u0427\u0435\u0440\u043d\u044b\u0439'],
                'skuType': 'text', 'attrCategory': 'sales',
            }],
            'skus': [{
                'sourceSku': '1',
                'attributes': {'\u0426\u0432\u0435\u0442': '\u0422\u0435\u043c\u043d\u043e-\u0441\u0438\u043d\u0438\u0439'},
                'combo': {'\u53d8\u4f53': '\u0422\u0435\u043c\u043d\u043e-\u0441\u0438\u043d\u0438\u0439'},
            }, {
                'sourceSku': '2',
                'attributes': {'\u0426\u0432\u0435\u0442': '\u0427\u0435\u0440\u043d\u044b\u0439'},
                'combo': {'\u53d8\u4f53': '\u0427\u0435\u0440\u043d\u044b\u0439'},
            }],
        }

        promote_collected_sku_combos(product)

        by_id = {attr.get('attrId'): attr for attr in product['skuAttrs']}
        self.assertNotIn('\u53d8\u4f53', [attr.get('name') for attr in product['skuAttrs']])
        self.assertEqual(['\u0422\u0435\u043c\u043d\u043e-\u0441\u0438\u043d\u0438\u0439', '\u0427\u0435\u0440\u043d\u044b\u0439'], by_id[10096]['values'])
        self.assertEqual('\u0422\u0435\u043c\u043d\u043e-\u0441\u0438\u043d\u0438\u0439', product['skus'][0]['combo']['\u5546\u54c1\u989c\u8272\uff08\u0426\u0432\u0435\u0442 \u0442\u043e\u0432\u0430\u0440\u0430\uff09'])
        self.assertEqual('\u0422\u0435\u043c\u043d\u043e-\u0441\u0438\u043d\u0438\u0439', product['skus'][0]['combo']['\u989c\u8272\u540d\u79f0\uff08\u041d\u0430\u0437\u0432\u0430\u043d\u0438\u0435 \u0446\u0432\u0435\u0442\u0430\uff09'])

    @patch('services.publish_service._find_color_id')
    def test_collected_color_ids_are_resolved_and_dictionary_labels_deduplicated(self, find_color):
        find_color.side_effect = lambda value, **_kwargs: {
            '\u0422\u0435\u043c\u043d\u043e-\u0441\u0438\u043d\u0438\u0439': 101,
            '\u0427\u0435\u0440\u043d\u044b\u0439': 102,
        }.get(value)
        color_key = '\u5546\u54c1\u989c\u8272\uff08\u0426\u0432\u0435\u0442 \u0442\u043e\u0432\u0430\u0440\u0430\uff09'
        color_name_key = '\u989c\u8272\u540d\u79f0\uff08\u041d\u0430\u0437\u0432\u0430\u043d\u0438\u0435 \u0446\u0432\u0435\u0442\u0430\uff09'
        product = {
            'descriptionCategoryId': 61372948,
            'typeId': 94034,
            'skuAttrs': [
                {'name': color_key, 'attrId': 10096, 'dictionaryId': 1494,
                 'skuType': 'color', 'values': ['\u0422\u0435\u043c\u043d\u043e-\u0441\u0438\u043d\u0438\u0439.', '\u0422\u0435\u043c\u043d\u043e-\u0441\u0438\u043d\u0438\u0439', '\u0427\u0435\u0440\u043d\u044b\u0439.'],
                 'valueIds': [101, 101, 101]},
                {'name': color_name_key, 'attrId': 10097, 'skuType': 'text',
                 'values': ['\u0422\u0435\u043c\u043d\u043e-\u0441\u0438\u043d\u0438\u0439.', '\u0422\u0435\u043c\u043d\u043e-\u0441\u0438\u043d\u0438\u0439', '\u0427\u0435\u0440\u043d\u044b\u0439.']},
            ],
            'skus': [
                {'combo': {color_key: '\u0422\u0435\u043c\u043d\u043e-\u0441\u0438\u043d\u0438\u0439.', color_name_key: '\u0422\u0435\u043c\u043d\u043e-\u0441\u0438\u043d\u0438\u0439.'}},
                {'combo': {color_key: '\u0422\u0435\u043c\u043d\u043e-\u0441\u0438\u043d\u0438\u0439', color_name_key: '\u0422\u0435\u043c\u043d\u043e-\u0441\u0438\u043d\u0438\u0439'}},
                {'combo': {color_key: '\u0427\u0435\u0440\u043d\u044b\u0439.', color_name_key: '\u0427\u0435\u0440\u043d\u044b\u0439.'}},
            ],
        }

        normalize_collected_color_skus(product)

        self.assertEqual(['\u0422\u0435\u043c\u043d\u043e-\u0441\u0438\u043d\u0438\u0439', '\u0427\u0435\u0440\u043d\u044b\u0439'], product['skuAttrs'][0]['values'])
        self.assertEqual([101, 102], product['skuAttrs'][0]['valueIds'])
        self.assertEqual('\u0422\u0435\u043c\u043d\u043e-\u0441\u0438\u043d\u0438\u0439', product['skus'][0]['combo'][color_key])
        self.assertEqual('\u0422\u0435\u043c\u043d\u043e-\u0441\u0438\u043d\u0438\u0439.', product['skus'][0]['combo'][color_name_key])
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

    def test_plain_description_evidence_removes_stale_valid_rich_content(self):
        product = {
            'platform': 'ozon',
            'description': 'Ordinary product description',
            'richContent': {
                'version': 0.3,
                'content': [{
                    'widgetName': 'raTextBlock',
                    'text': {'items': [{'type': 'text', 'content': 'Stale rich text'}]},
                }],
            },
            'contentEvidence': {
                'mode': 'plain_description',
                'source': 'plain_description_dom',
                'descriptionValidated': True,
            },
            'attributes': [{'id': 11254, 'value': '{"version":0.3,"content":[]}'}],
        }

        _sync_rich_content_attribute(product)
        mode = _classify_ozon_content(product)

        self.assertEqual('plain_description', mode)
        self.assertEqual('Ordinary product description', product['description'])
        self.assertEqual('', product['richContent'])
        self.assertFalse(any(attr.get('id') == 11254 for attr in product['attributes']))

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

    def test_valid_rich_content_evidence_keeps_only_rich_mode(self):
        product = {
            'platform': 'ozon',
            'description': 'Rendered duplicate text',
            'richContent': {
                'version': 0.3,
                'content': [{
                    'widgetName': 'raTextBlock',
                    'text': {'items': [{'type': 'text', 'content': 'Rich text'}]},
                }],
            },
            'contentEvidence': {
                'mode': 'rich_content',
                'source': 'official_container_json',
                'richValidated': True,
            },
            'attributes': [],
        }

        _sync_rich_content_attribute(product)
        mode = _classify_ozon_content(product)

        self.assertEqual('rich_content', mode)
        self.assertEqual('', product['description'])
        self.assertTrue(product['richContent'])

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
        self.assertEqual('черный, белый', saved_sku['combo']['商品颜色（Цвет товара）'])
        self.assertEqual('черный', saved_sku['combo']['颜色名称（Название цвета）'])
        self.assertEqual(product['skus'], product['skuList'])
        self.assertEqual(product['skus'], product['variants'])

        item = build_ozon_product_items(product, publish_mode='split')[0]
        attrs = {attr['id']: attr['values'] for attr in item['attributes']}
        self.assertEqual(saved_sku['skuCode'], item['offer_id'])
        self.assertEqual([{'value': 'DOM-MODEL-CODE'}], attrs[9048])
        self.assertEqual([
            {'dictionary_value_id': 61574},
            {'dictionary_value_id': 61575},
        ], attrs[10096])
        self.assertEqual([{'value': 'черный'}], attrs[10097])

    def test_missing_color_is_not_copied_into_size_only_sku(self):
        product = {
            'skuAttrs': [{
                'name': '商品颜色（Цвет товара）', 'attrId': 10096,
                'values': ['разноцветный'],
                'valueIds': [369939085],
            }, {
                'name': '颜色名称（Название цвета）', 'attrId': 10097,
                'values': ['разноцветный'],
            }],
            'skus': [{
                'combo': {'商品颜色（Цвет товара）': 'разноцветный'},
            }, {
                'attributes': {'Размер': '48–51 RU / 182 см'},
                'combo': {'Размер': '48–51 RU / 182 см'},
            }],
        }

        normalize_collected_color_skus(product)

        self.assertNotIn('商品颜色（Цвет товара）', product['skus'][1]['combo'])
        self.assertNotIn('颜色名称（Название цвета）', product['skus'][1]['combo'])


if __name__ == '__main__':
    unittest.main()
