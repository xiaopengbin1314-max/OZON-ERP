import os
import sys
import unittest
from unittest.mock import MagicMock, patch


BACKEND_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if BACKEND_DIR not in sys.path:
    sys.path.insert(0, BACKEND_DIR)

from models.category import AttributeDictionaryValue, CategoryAttribute
from services.category_sync_service import sync_single_category_attributes


class CategoryAttributeScopeTests(unittest.TestCase):
    @patch('models.category.query')
    def test_attribute_reads_use_description_category_and_type(self, query):
        query.return_value = {'cnt': 0}
        CategoryAttribute.find_by_category(101, 202)
        CategoryAttribute.find_by_category_and_attr_id(101, 202, 303)
        CategoryAttribute.has_attributes(101, 202)

        first_sql, first_params = query.call_args_list[0].args[:2]
        second_sql, second_params = query.call_args_list[1].args[:2]
        third_sql, third_params = query.call_args_list[2].args[:2]

        self.assertIn('description_category_id = ?', first_sql)
        self.assertEqual((101, 202), first_params)
        self.assertIn('description_category_id = ?', second_sql)
        self.assertEqual((101, 202, 303), second_params)
        self.assertIn('description_category_id = ?', third_sql)
        self.assertEqual((101, 202), third_params)

    @patch('db.get_connection')
    def test_attribute_replace_only_deletes_current_category(self, get_connection):
        connection = MagicMock()
        get_connection.return_value = connection

        CategoryAttribute.replace_for_category(101, 202, [])

        delete_sql, delete_params = connection.execute.call_args.args
        self.assertIn('description_category_id = ?', delete_sql)
        self.assertEqual((101, 202), delete_params)
        connection.commit.assert_called_once()
        connection.close.assert_called_once()

    @patch('models.category.query')
    def test_bulk_attribute_reads_stay_in_category_scope(self, query):
        CategoryAttribute.find_by_category_and_attr_ids(101, 202, [3, 4, 3])
        AttributeDictionaryValue.find_by_dictionary_ids([8, 9, 8], 202, 101)

        attr_sql, attr_params = query.call_args_list[0].args[:2]
        value_sql, value_params = query.call_args_list[1].args[:2]
        self.assertIn('attribute_id IN (?,?)', attr_sql)
        self.assertEqual((101, 202, 3, 4), attr_params)
        self.assertIn('dictionary_id IN (?,?)', value_sql)
        self.assertEqual((101, 202, 8, 9), value_params)

    @patch('models.category.CategoryAttribute.replace_for_category')
    @patch('services.ozon_api.get_category_attributes')
    def test_sync_merges_attribute_ids_from_both_languages(self, get_attributes, replace):
        get_attributes.side_effect = [
            {'result': [{'id': 1, 'name': '颜色', 'type': 'String'}]},
            {'result': [
                {'id': 1, 'name': 'Цвет', 'type': 'String'},
                {'id': 2, 'name': 'Материал', 'type': 'String'},
            ]},
        ]

        result = sync_single_category_attributes(101, 202, force=True)

        self.assertTrue(result['success'])
        attrs = replace.call_args.args[2]
        self.assertEqual([1, 2], [attr['attribute_id'] for attr in attrs])
        self.assertEqual('颜色（Цвет）', attrs[0]['name'])
        self.assertEqual('Материал', attrs[1]['name'])
        self.assertTrue(all(call.kwargs['refresh'] for call in get_attributes.call_args_list))

    @patch('models.category.CategoryAttribute.replace_for_category')
    @patch('services.ozon_api.get_category_attributes', return_value={'result': []})
    def test_empty_api_response_does_not_erase_attribute_library(self, _get_attributes, replace):
        result = sync_single_category_attributes(101, 202, force=True)

        self.assertFalse(result['success'])
        replace.assert_not_called()


if __name__ == '__main__':
    unittest.main()
