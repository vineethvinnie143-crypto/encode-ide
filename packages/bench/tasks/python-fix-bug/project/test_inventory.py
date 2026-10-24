import unittest

from inventory import Inventory


class InventoryTest(unittest.TestCase):
    def test_add_and_count(self):
        stock = Inventory()
        stock.add("tea", 3)
        stock.add("tea", 2)
        self.assertEqual(stock.count("tea"), 5)

    def test_remove(self):
        stock = Inventory()
        stock.add("tea", 3)
        self.assertEqual(stock.remove("tea", 2), 1)


if __name__ == "__main__":
    unittest.main()
