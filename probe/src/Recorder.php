<?php

declare(strict_types=1);

namespace Waypoint\Probe;

/**
 * Builds probe records from exceptions / log events, with sensitive fields
 * redacted. Pure (no framework deps) so the capture shape and redaction are
 * testable in isolation. The request is passed in as a plain array.
 */
final class Recorder
{
    /** @param list<string> $redact lowercase field-name substrings to scrub */
    public function __construct(private array $redact = [])
    {
    }

    /**
     * @param array{method?:string,uri?:string,input?:array,headers?:array,ip?:string} $request
     * @return array<string,mixed>
     */
    public function exceptionRecord(\Throwable $e, array $request = []): array
    {
        return [
            'id' => $this->id(),
            'kind' => 'exception',
            'at' => time(),
            'class' => $e::class,
            'message' => $e->getMessage(),
            'file' => $e->getFile(),
            'line' => $e->getLine(),
            'trace' => $this->trace($e),
            'request' => $this->request($request),
        ];
    }

    /**
     * @param array<string,mixed> $context
     * @return array<string,mixed>
     */
    public function logRecord(string $level, string $message, array $context = []): array
    {
        return [
            'id' => $this->id(),
            'kind' => 'log',
            'at' => time(),
            'level' => $level,
            'message' => $message,
            'context' => $this->redact($context),
        ];
    }

    /** @param array<string,mixed> $request */
    private function request(array $request): array
    {
        return [
            'method' => $request['method'] ?? null,
            'uri' => $request['uri'] ?? null,
            'ip' => $request['ip'] ?? null,
            'input' => $this->redact($request['input'] ?? []),
            'headers' => $this->redact($request['headers'] ?? []),
        ];
    }

    /** @return list<string> top frames as "file:line func" */
    private function trace(\Throwable $e, int $limit = 20): array
    {
        $out = [];
        foreach (array_slice($e->getTrace(), 0, $limit) as $f) {
            $fn = ($f['class'] ?? '') . ($f['type'] ?? '') . ($f['function'] ?? '');
            $out[] = trim(($f['file'] ?? '[internal]') . ':' . ($f['line'] ?? '?') . ' ' . $fn);
        }
        return $out;
    }

    /**
     * Recursively scrub values whose key matches a redact term (case-insensitive).
     *
     * @param array<mixed,mixed> $data
     * @return array<mixed,mixed>
     */
    public function redact(array $data): array
    {
        $out = [];
        foreach ($data as $key => $value) {
            if (is_string($key) && $this->isSensitive($key)) {
                $out[$key] = '[redacted]';
            } elseif (is_array($value)) {
                $out[$key] = $this->redact($value);
            } else {
                $out[$key] = $value;
            }
        }
        return $out;
    }

    private function isSensitive(string $key): bool
    {
        $k = strtolower($key);
        foreach ($this->redact as $term) {
            if ($term !== '' && str_contains($k, $term)) {
                return true;
            }
        }
        return false;
    }

    private function id(): string
    {
        return dechex(time()) . '-' . bin2hex(random_bytes(4));
    }
}
