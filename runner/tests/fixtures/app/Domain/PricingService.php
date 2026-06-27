<?php

declare(strict_types=1);

namespace App\Domain;

/** A service in its own file — loaded (and instrumented) via the autoloader. */
class PricingService
{
    private float $taxRate = 0.2;

    public function priceFor(array $items): array
    {
        $subtotal = array_sum(array_column($items, 'price'));

        return ['subtotal' => $subtotal, 'tax' => $this->tax($subtotal)];
    }

    public function tax(float $subtotal): float
    {
        return round($subtotal * $this->taxRate, 2);
    }
}
