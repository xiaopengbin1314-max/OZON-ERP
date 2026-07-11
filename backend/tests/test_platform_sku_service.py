import os
import sys
import unittest
from datetime import datetime


BACKEND_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if BACKEND_DIR not in sys.path:
    sys.path.insert(0, BACKEND_DIR)

from services.platform_sku_service import ensure_platform_sku_codes


class PlatformSkuServiceTests(unittest.TestCase):
    def test_generates_unique_platform_skus_from_platform_time_and_color(self):
        product = {
            'sourceName': '1688批发',
            'skus': [
                {'combo': {'颜色名称（Название цвета）': '黑色'}},
                {'combo': {'颜色名称（Название цвета）': '白色'}},
            ],
        }

        skus = ensure_platform_sku_codes(product, now=datetime(2026, 7, 12, 9, 30))

        self.assertEqual(['1688-07120930-黑色', '1688-07120930-白色'], [sku['skuCode'] for sku in skus])
        self.assertEqual([sku['skuCode'] for sku in skus], [sku['offerId'] for sku in skus])

    def test_preserves_existing_unique_erp_platform_sku_and_repairs_duplicate(self):
        product = {
            'platform': 'ozon',
            'skus': [
                {'skuCode': 'ERP-SKU-1'},
                {'skuCode': 'ERP-SKU-1'},
            ],
        }

        skus = ensure_platform_sku_codes(product, now=datetime(2026, 7, 12, 9, 30))

        self.assertEqual('ERP-SKU-1', skus[0]['skuCode'])
        self.assertNotEqual('ERP-SKU-1', skus[1]['skuCode'])
        self.assertEqual(2, len({sku['skuCode'] for sku in skus}))


if __name__ == '__main__':
    unittest.main()
