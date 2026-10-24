import os
import sys
import unittest

sys.path.insert(0, os.environ["BENCH_ROOT"])
from shipping import Order, shipping_cost  # noqa: E402


class ShippingTest(unittest.TestCase):
    def test_canada(self):
        self.assertEqual(shipping_cost(Order("CA", 0.5)), 7.0)
        self.assertEqual(shipping_cost(Order("CA", 1)), 7.0)
        self.assertEqual(shipping_cost(Order("CA", 3)), 12.0)
        self.assertEqual(shipping_cost(Order("CA", 5)), 12.0)
        self.assertEqual(shipping_cost(Order("CA", 7.5)), 15.75)

    def test_express_makes_no_difference_in_canada(self):
        self.assertEqual(shipping_cost(Order("CA", 3, express=True)), 12.0)

    def test_others_unchanged(self):
        self.assertEqual(shipping_cost(Order("US", 0.5)), 5.0)
        self.assertEqual(shipping_cost(Order("US", 7)), 11.9)
        self.assertEqual(shipping_cost(Order("FR", 2)), 18.0)
        self.assertEqual(shipping_cost(Order("FR", 2, express=True)), 30.0)


if __name__ == "__main__":
    unittest.main()
