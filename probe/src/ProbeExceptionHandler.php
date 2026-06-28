<?php

declare(strict_types=1);

namespace Waypoint\Probe;

use Illuminate\Contracts\Container\Container;
use Illuminate\Contracts\Debug\ExceptionHandler;
use Throwable;
use Waypoint\Probe\Buffer\Buffer;

/**
 * Decorates the app's exception handler so every *reported* exception is recorded
 * to the buffer (with the failing request, redacted) before normal handling
 * proceeds. The reliable capture point in Laravel — the routing pipeline converts
 * route exceptions to responses, so middleware can't see them, but `report()`
 * always runs.
 */
final class ProbeExceptionHandler implements ExceptionHandler
{
    public function __construct(
        private ExceptionHandler $inner,
        private Buffer $buffer,
        private Recorder $recorder,
        private Container $app,
    ) {
    }

    public function report(Throwable $e): void
    {
        try {
            if ($this->inner->shouldReport($e)) {
                $this->buffer->push($this->recorder->exceptionRecord($e, $this->requestData()));
            }
        } catch (Throwable) {
            // the probe must never break error handling
        }
        $this->inner->report($e);
    }

    public function shouldReport(Throwable $e): bool
    {
        return $this->inner->shouldReport($e);
    }

    public function render($request, Throwable $e)
    {
        return $this->inner->render($request, $e);
    }

    public function renderForConsole($output, Throwable $e): void
    {
        $this->inner->renderForConsole($output, $e);
    }

    /** @return array<string,mixed> */
    private function requestData(): array
    {
        if (!$this->app->bound('request')) {
            return [];
        }
        $request = $this->app->make('request');
        if (!is_object($request) || !method_exists($request, 'getMethod')) {
            return [];
        }
        $headers = [];
        foreach ($request->headers->all() as $name => $values) {
            $headers[$name] = is_array($values) ? implode(', ', $values) : $values;
        }
        return [
            'method' => $request->getMethod(),
            'uri' => $request->getRequestUri(),
            'ip' => $request->ip(),
            'input' => $request->all(),
            'headers' => $headers,
        ];
    }
}
