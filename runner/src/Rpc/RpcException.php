<?php

declare(strict_types=1);

namespace Waypoint\Runner\Rpc;

/** A JSON-RPC error with a code carried back to the client. */
final class RpcException extends \RuntimeException
{
    public function __construct(public readonly int $rpcCode, string $message)
    {
        parent::__construct($message);
    }
}
