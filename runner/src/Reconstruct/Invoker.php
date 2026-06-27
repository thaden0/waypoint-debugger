<?php

declare(strict_types=1);

namespace Waypoint\Runner\Reconstruct;

/**
 * The reconstruct + invoke primitive — the core operation the whole tool reduces
 * to. Given a captured (or hand-authored) waypoint state, rebuild the receiver
 * and arguments, then re-enter the public method directly:
 *
 *     $receiver->method(...$args)
 *
 * No mid-function resume is ever needed: a public method is directly
 * re-invokable. The booted host application supplies ambient state (container,
 * config, DB); swaps neutralize flagged I/O; a transaction guard makes the run
 * safe by default (peek = rollback after; commit is an explicit opt-in).
 */
final class Invoker
{
    /** @var null|callable():void */
    private $begin;
    /** @var null|callable():void */
    private $commit;
    /** @var null|callable():void */
    private $rollback;

    /**
     * The three transaction hooks are injected by the host. With a real Laravel
     * host they map to DB::beginTransaction / commit / rollBack. Left null (e.g.
     * in tests with no DB), the guard is a no-op and the run is unguarded.
     *
     * @param null|callable():void $begin
     * @param null|callable():void $commit
     * @param null|callable():void $rollback
     */
    public function __construct(?callable $begin = null, ?callable $commit = null, ?callable $rollback = null)
    {
        $this->begin = $begin;
        $this->commit = $commit;
        $this->rollback = $rollback;
    }

    /**
     * @param array{receiver:array<string,mixed>,args:array<int,array<string,mixed>>} $entry
     *        A ledger entry (with blobs) from Recorder::entry(), or an equivalent
     *        hand-authored mock entry.
     * @param 'peek'|'destructive' $mode  peek rolls back after landing; destructive commits.
     * @param array<int,mixed>|null $argOverrides  authored replacements for captured
     *        args, keyed by position. The what-if dial: reconstruct the *captured*
     *        receiver, then poke it with different inputs. Overrides are tier-1
     *        authored values (scalars/arrays) used directly; positions absent from
     *        the map keep their captured value.
     *
     * @return array{ok:bool,result?:mixed,preview?:mixed,error?:string,mode:string,committed:bool,reproducible:bool}
     */
    public function invoke(array $entry, string $method, string $mode = 'peek', ?array $argOverrides = null): array
    {
        try {
            $receiver = $this->materialize($entry['receiver']);
            if (!is_object($receiver)) {
                return $this->fail('receiver did not reconstruct to an object', $mode);
            }
            $args = [];
            foreach ($entry['args'] as $i => $snapshot) {
                $args[$i] = ($argOverrides !== null && array_key_exists($i, $argOverrides))
                    ? $argOverrides[$i]
                    : $this->materialize($snapshot);
            }
        } catch (\Throwable $e) {
            return $this->fail('reconstruction failed: ' . $e->getMessage(), $mode, reproducible: false);
        }

        if (!method_exists($receiver, $method)) {
            return $this->fail("method {$method} does not exist on " . get_class($receiver), $mode);
        }

        $committed = false;
        $this->guardBegin();
        try {
            $result = $receiver->$method(...$args);

            if ($mode === 'destructive') {
                $this->guardCommit();
                $committed = true;
            } else {
                $this->guardRollback();
            }

            return [
                'ok' => true,
                'result' => $this->summarize($result),
                'preview' => $this->preview($result),
                'mode' => $mode,
                'committed' => $committed,
                'reproducible' => true,
            ];
        } catch (\Throwable $e) {
            $this->guardRollback();
            return $this->fail($e->getMessage(), $mode);
        }
    }

    /**
     * Reconstruct a single captured value. Tier 1/2 come back via unserialize;
     * tier 3 is refused with a clear reason (the reproducible-slice gate).
     */
    private function materialize(array $snapshot): mixed
    {
        $tier = $snapshot['tier'] ?? 1;
        if ($tier >= 3 || !isset($snapshot['blob'])) {
            $note = $snapshot['note'] ?? 'value is not reproducible as source';
            throw new \RuntimeException(($snapshot['type'] ?? 'value') . ': ' . $note);
        }
        return unserialize($snapshot['blob']);
    }

    private function guardBegin(): void
    {
        if ($this->begin) {
            ($this->begin)();
        }
    }

    private function guardCommit(): void
    {
        if ($this->commit) {
            ($this->commit)();
        }
    }

    private function guardRollback(): void
    {
        if ($this->rollback) {
            ($this->rollback)();
        }
    }

    private function summarize(mixed $result): mixed
    {
        if ($result === null || is_scalar($result)) {
            return $result;
        }
        if (is_array($result)) {
            return ['__type' => 'array', 'count' => count($result)];
        }
        if (is_object($result)) {
            return ['__type' => get_class($result)];
        }
        return ['__type' => get_debug_type($result)];
    }

    /**
     * A JSON-safe, depth- and size-capped rendering of the invocation result, so
     * the UI can diff a what-if outcome against the baseline. Unlike summarize()
     * (which collapses to a type tag), this keeps actual values — and leans on
     * toArray()/JsonSerializable so Eloquent models and Collections render as data.
     */
    private function preview(mixed $v, int $depth = 0): mixed
    {
        if ($v === null || is_scalar($v)) {
            return $v;
        }
        if ($depth >= 4) {
            return ['__truncated' => get_debug_type($v)];
        }
        if (is_array($v)) {
            $out = [];
            $i = 0;
            foreach ($v as $k => $vv) {
                if ($i++ >= 50) {
                    $out['__more'] = count($v) - 50;
                    break;
                }
                $out[$k] = $this->preview($vv, $depth + 1);
            }
            return $out;
        }
        if (is_object($v)) {
            if (method_exists($v, 'toArray')) {
                try {
                    return ['__type' => get_class($v), 'value' => $this->preview($v->toArray(), $depth + 1)];
                } catch (\Throwable) {
                    // fall through to the other strategies
                }
            }
            if ($v instanceof \JsonSerializable) {
                return ['__type' => get_class($v), 'value' => $this->preview($v->jsonSerialize(), $depth + 1)];
            }
            return ['__type' => get_class($v), 'value' => $this->preview(get_object_vars($v), $depth + 1)];
        }
        return ['__type' => get_debug_type($v)];
    }

    private function fail(string $error, string $mode, bool $reproducible = true): array
    {
        return ['ok' => false, 'error' => $error, 'mode' => $mode, 'committed' => false, 'reproducible' => $reproducible];
    }
}
