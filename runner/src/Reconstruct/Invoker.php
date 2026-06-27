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
     *
     * @return array{ok:bool,result?:mixed,error?:string,mode:string,committed:bool,reproducible:bool}
     */
    public function invoke(array $entry, string $method, string $mode = 'peek'): array
    {
        try {
            $receiver = $this->materialize($entry['receiver']);
            if (!is_object($receiver)) {
                return $this->fail('receiver did not reconstruct to an object', $mode);
            }
            $args = array_map([$this, 'materialize'], $entry['args']);
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

    private function fail(string $error, string $mode, bool $reproducible = true): array
    {
        return ['ok' => false, 'error' => $error, 'mode' => $mode, 'committed' => false, 'reproducible' => $reproducible];
    }
}
