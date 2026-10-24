"""Stock of a small warehouse, by SKU."""


class Inventory:
    def __init__(self):
        self._stock = {}

    def add(self, sku, quantity):
        if quantity <= 0:
            raise ValueError("quantity must be positive")
        self._stock[sku] = self._stock.get(sku, 0) + quantity
        return self._stock[sku]

    def remove(self, sku, quantity):
        current = self._stock.get(sku, 0)
        self._stock[sku] = current - quantity
        return self._stock[sku]

    def count(self, sku):
        return self._stock.get(sku, 0)
