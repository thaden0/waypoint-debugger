<?php

declare(strict_types=1);

namespace App\Services;

/**
 * A self-contained service used as a live-run fixture: all-public methods, no
 * constructor dependencies, no external class references — so the SliceRunner can
 * instrument it, load it under a unique namespace, and drive it end to end. Each
 * public method is a valid waypoint anchor (capture receiver + args on entry).
 */
class OrderService
{
    private float $taxRate = 0.1;

    public function process(array $items): array
    {
        $subtotal = $this->subtotal($items);
        $tax = $this->tax($subtotal);

        return [
            'subtotal' => $subtotal,
            'tax' => $tax,
            'total' => round($subtotal + $tax, 2),
        ];
    }

    public function subtotal(array $items): float
    {
        return array_sum(array_column($items, 'price'));
    }

    public function tax(float $subtotal): float
    {
        return round($subtotal * $this->taxRate, 2);
    }
}
