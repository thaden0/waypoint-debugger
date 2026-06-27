<?php

declare(strict_types=1);

namespace App\Http;

use App\Domain\PricingService;

/**
 * A controller in its own file that calls into a service in another file. A
 * whole-request run instruments BOTH on include, so capture flows across the
 * file boundary — the thing single-unit slice runs can't do.
 */
class CheckoutController
{
    public function checkout(array $items): array
    {
        $pricing = new PricingService();
        $priced = $pricing->priceFor($items);

        return [
            'ok' => true,
            'total' => round($priced['subtotal'] + $priced['tax'], 2),
        ] + $priced;
    }
}
