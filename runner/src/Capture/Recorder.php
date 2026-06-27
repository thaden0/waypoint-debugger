<?php

declare(strict_types=1);

namespace Waypoint\Runner\Capture;

/**
 * The ledger primitive. Injected waypoint hooks call Recorder::capture() on
 * every entry of an instrumented public method, recording { receiver, args }.
 *
 * The captured blob is OPAQUE to the coordinator — it is stored and handed back,
 * never introspected by the language-neutral core. Here, inside the PHP adapter,
 * we apply the "reproducible slice" predicate: state that cannot be expressed as
 * constructable source (tier 3 — closures, resources, live handles) is detected
 * now and flagged, rather than exploding at reconstruction time.
 */
final class Recorder
{
    /** @var array<int,array<string,mixed>> */
    private static array $ledger = [];
    private static int $seq = 0;
    private static bool $enabled = true;

    public static function capture(string $id, ?object $receiver, array $args): void
    {
        if (!self::$enabled) {
            return;
        }

        $entry = [
            'id' => $id,
            'seq' => self::$seq++,
            'receiver' => self::snapshotValue($receiver),
            'args' => array_map([self::class, 'snapshotValue'], $args),
        ];
        $entry['reproducible'] = self::isReproducible($entry);
        self::$ledger[] = $entry;

        // Stream the capture to any connected UI so the ledger fills live.
        \Waypoint\Runner\Rpc\Notifier::notify('ledger.captured', self::publicEntry($entry));
    }

    /** A single ledger entry with raw blobs stripped — the wire shape. */
    private static function publicEntry(array $entry): array
    {
        $entry['receiver'] = self::publicView($entry['receiver']);
        $entry['args'] = array_map([self::class, 'publicView'], $entry['args']);
        return $entry;
    }

    /**
     * Classify a value into a reproduction tier and snapshot it.
     *
     * @return array{tier:int,type:string,blob?:string,note?:string,preview:mixed}
     */
    public static function snapshotValue(mixed $value): array
    {
        // Tier 1 — trivial scalars/arrays.
        if ($value === null || is_scalar($value)) {
            return ['tier' => 1, 'type' => get_debug_type($value), 'preview' => $value, 'blob' => serialize($value)];
        }
        if (is_array($value)) {
            $blob = @serialize($value);
            return $blob === false
                ? ['tier' => 3, 'type' => 'array', 'note' => 'array holds a non-serializable element', 'preview' => '[…]']
                : ['tier' => 1, 'type' => 'array', 'preview' => self::previewArray($value), 'blob' => $blob];
        }

        // Tier 3 — irreproducible by definition.
        if ($value instanceof \Closure) {
            return ['tier' => 3, 'type' => 'Closure', 'note' => 'closures capture runtime scope; cannot be reconstructed as source', 'preview' => 'Closure'];
        }
        if (is_resource($value)) {
            return ['tier' => 3, 'type' => 'resource', 'note' => 'live resource (handle/socket) cannot be reconstructed', 'preview' => 'resource'];
        }

        // Tier 2 — hydratable objects (Eloquent models, DTOs, Collections).
        $type = get_class($value);
        $blob = @self::trySerialize($value);
        if ($blob === null) {
            return ['tier' => 3, 'type' => $type, 'note' => 'object graph holds non-serializable state (live connection / closure / resource)', 'preview' => $type];
        }
        return ['tier' => 2, 'type' => $type, 'preview' => self::previewObject($value), 'blob' => $blob];
    }

    private static function trySerialize(object $value): ?string
    {
        try {
            $s = serialize($value);
            // Round-trip to be sure it actually reconstitutes.
            unserialize($s);
            return $s;
        } catch (\Throwable) {
            return null;
        }
    }

    private static function isReproducible(array $entry): bool
    {
        $worst = $entry['receiver']['tier'] ?? 1;
        foreach ($entry['args'] as $a) {
            $worst = max($worst, $a['tier']);
        }
        return $worst < 3;
    }

    private static function previewArray(array $value): array
    {
        return array_slice(array_map(
            static fn ($v) => is_scalar($v) || $v === null ? $v : get_debug_type($v),
            $value
        ), 0, 20, true);
    }

    private static function previewObject(object $value): array
    {
        // For Eloquent-shaped objects, getAttributes() is the meaningful preview.
        if (method_exists($value, 'getAttributes')) {
            try {
                return (array) $value->getAttributes();
            } catch (\Throwable) {
                // fall through
            }
        }
        // Collections / Countables hold their items privately; show the count.
        if ($value instanceof \Countable) {
            return ['count' => count($value)];
        }
        return array_map(
            static fn ($v) => is_scalar($v) || $v === null ? $v : get_debug_type($v),
            get_object_vars($value)
        );
    }

    /** @return array<int,array<string,mixed>> */
    public static function ledger(): array
    {
        // Strip raw blobs from the wire view; the coordinator keys by seq.
        return array_map([self::class, 'publicEntry'], self::$ledger);
    }

    /** @return array<string,mixed> */
    private static function publicView(array $snapshot): array
    {
        unset($snapshot['blob']);
        return $snapshot;
    }

    /** Full entry incl. blobs — used by the reconstructor, not shipped raw to UI. */
    public static function entry(int $seq): ?array
    {
        foreach (self::$ledger as $e) {
            if ($e['seq'] === $seq) {
                return $e;
            }
        }
        return null;
    }

    public static function reset(): void
    {
        self::$ledger = [];
        self::$seq = 0;
    }

    public static function setEnabled(bool $on): void
    {
        self::$enabled = $on;
    }
}
