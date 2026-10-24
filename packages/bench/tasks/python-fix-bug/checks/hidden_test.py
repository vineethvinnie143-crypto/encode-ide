import os
import sys
import unittest

sys.path.insert(0, os.environ["BENCH_ROOT"])
from inventory import Inventory  # noqa: E402


class RemoveTest(unittest.TestCase):
    def setUp(self):
        self.stock = Inventory()
        self.stock.add("tea", 3)

    def test_not_enough(self):
        with self.assertRaises(ValueError):
            self.stock.remove("tea", 4)
        self.assertEqual(self.stock.count("tea"), 3)

    def test_unknown_sku(self):
        with self.assertRaises(ValueError):
            self.stock.remove("coffee", 1)
        self.assertEqual(self.stock.count("coffee"), 0)

    def test_zero_or_less(self):
        for quantity in (0, -1):
            with self.assertRaises(ValueError):
                self.stock.remove("tea", quantity)
        self.assertEqual(self.stock.count("tea"), 3)

    def test_all_of_it(self):
        self.assertEqual(self.stock.remove("tea", 3), 0)


if __name__ == "__main__":
    unittest.main()
