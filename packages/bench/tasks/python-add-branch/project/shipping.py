"""What shipping an order costs, in dollars."""
from dataclasses import dataclass


@dataclass
class Order:
    country: str
    weight_kg: float
    express: bool = False


def shipping_cost(order):
    if order.country == "US":
        if order.weight_kg <= 1:
            return 5.0
        elif order.weight_kg <= 5:
            return 9.5
        else:
            return round(9.5 + (order.weight_kg - 5) * 1.2, 2)
    else:
        if order.express:
            return 30.0
        return 18.0
