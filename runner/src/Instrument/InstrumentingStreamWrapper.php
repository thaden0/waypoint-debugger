<?php

declare(strict_types=1);

namespace Waypoint\Runner\Instrument;

use Waypoint\Runner\Swap\Swapper;
use Waypoint\Runner\Waypoint\WaypointInstrumenter;

/**
 * A file:// stream wrapper that rewrites *targeted* project files as they are
 * include()d, so waypoint capture hooks and swaps land in the real classes a
 * Laravel request flows through — not just one re-namespaced unit.
 *
 * Only files explicitly registered as targets are instrumented; every other path
 * (vendor, framework, non-PHP) passes straight through to the real filesystem, so
 * the wrapper adds an isset() check per open and nothing more. The classic
 * restore/register dance around each operation keeps the wrapper out of its own
 * way while it touches the real disk.
 *
 * PHP cannot redefine a loaded class, so this must run in a FRESH process per
 * request (see bin/request-run.php) and be registered BEFORE the autoloader
 * loads the targeted classes.
 */
final class InstrumentingStreamWrapper
{
    /** @var resource|null the userland stream context (required property) */
    public $context;

    /** @var array<string,array{waypoints:array<int,array<string,mixed>>,swaps:array<int,array<string,mixed>>}> realpath => config */
    private static array $targets = [];
    private static bool $registered = false;

    // Per-handle state.
    private string $buffer = '';
    private int $pos = 0;
    /** @var resource|null */
    private $real = null;
    private bool $isMemory = false;
    /** @var resource|null */
    private $dir = null;

    /**
     * Register the wrapper and the set of files to instrument.
     *
     * @param array<string,array{waypoints?:array,swaps?:array}> $targets relative-or-absolute path => config
     */
    public static function activate(string $projectRoot, array $targets): void
    {
        self::$targets = [];
        foreach ($targets as $path => $cfg) {
            $abs = str_starts_with($path, '/') ? $path : rtrim($projectRoot, '/') . '/' . ltrim($path, '/');
            $real = realpath($abs) ?: $abs;
            self::$targets[$real] = [
                'waypoints' => $cfg['waypoints'] ?? [],
                'swaps' => $cfg['swaps'] ?? [],
            ];
        }
        self::register();
    }

    public static function deactivate(): void
    {
        self::restore();
        self::$targets = [];
    }

    private static function register(): void
    {
        if (!self::$registered) {
            stream_wrapper_unregister('file');
            stream_wrapper_register('file', self::class);
            self::$registered = true;
        }
    }

    private static function restore(): void
    {
        if (self::$registered) {
            stream_wrapper_restore('file');
            self::$registered = false;
        }
    }

    private function targetFor(string $path): ?array
    {
        $real = realpath($path);
        if ($real !== false && isset(self::$targets[$real])) {
            return self::$targets[$real];
        }
        return null;
    }

    // ---- stream ops -------------------------------------------------------

    public function stream_open(string $path, string $mode, int $options, ?string &$opened_path): bool
    {
        self::restore();
        try {
            $cfg = $this->targetFor($path);
            if ($cfg !== null && str_contains($mode, 'r')) {
                $source = (string) file_get_contents($path);
                $this->buffer = self::instrument($source, $cfg);
                $this->isMemory = true;
                $this->pos = 0;
                if ($options & STREAM_USE_PATH) {
                    $opened_path = $path;
                }
                return true;
            }
            $this->real = @fopen($path, $mode, (bool) ($options & STREAM_USE_PATH), $this->context);
            return $this->real !== false;
        } finally {
            self::register();
        }
    }

    public function stream_read(int $count): string
    {
        if ($this->isMemory) {
            $chunk = substr($this->buffer, $this->pos, $count);
            $this->pos += strlen($chunk);
            return $chunk;
        }
        return $this->real ? (string) fread($this->real, $count) : '';
    }

    public function stream_write(string $data): int
    {
        if ($this->isMemory) {
            return 0; // instrumented source is read-only
        }
        return $this->real ? (int) fwrite($this->real, $data) : 0;
    }

    public function stream_eof(): bool
    {
        return $this->isMemory ? $this->pos >= strlen($this->buffer) : ($this->real ? feof($this->real) : true);
    }

    public function stream_stat(): array|false
    {
        if ($this->isMemory) {
            return $this->fakeStat(strlen($this->buffer));
        }
        return $this->real ? fstat($this->real) : false;
    }

    public function stream_seek(int $offset, int $whence = SEEK_SET): bool
    {
        if ($this->isMemory) {
            $target = match ($whence) {
                SEEK_CUR => $this->pos + $offset,
                SEEK_END => strlen($this->buffer) + $offset,
                default => $offset,
            };
            if ($target < 0) {
                return false;
            }
            $this->pos = $target;
            return true;
        }
        return $this->real ? fseek($this->real, $offset, $whence) === 0 : false;
    }

    public function stream_tell(): int
    {
        return $this->isMemory ? $this->pos : ($this->real ? (int) ftell($this->real) : 0);
    }

    public function stream_flush(): bool
    {
        return $this->real ? fflush($this->real) : true;
    }

    public function stream_close(): void
    {
        if ($this->real) {
            fclose($this->real);
            $this->real = null;
        }
    }

    public function stream_set_option(int $option, int $arg1, int $arg2): bool
    {
        return false;
    }

    public function stream_cast(int $castAs)
    {
        return $this->real ?? false;
    }

    public function stream_lock(int $operation): bool
    {
        if ($this->isMemory || !$this->real) {
            return true;
        }
        return flock($this->real, $operation);
    }

    // ---- url / filesystem ops (pass-through) ------------------------------

    public function url_stat(string $path, int $flags): array|false
    {
        self::restore();
        try {
            $result = ($flags & STREAM_URL_STAT_LINK) ? @lstat($path) : @stat($path);
            if ($result === false && ($flags & STREAM_URL_STAT_QUIET) === 0) {
                return false;
            }
            return $result;
        } finally {
            self::register();
        }
    }

    public function unlink(string $path): bool
    {
        return $this->passthrough(fn () => @unlink($path));
    }

    public function rename(string $from, string $to): bool
    {
        return $this->passthrough(fn () => @rename($from, $to));
    }

    public function mkdir(string $path, int $mode, int $options): bool
    {
        return $this->passthrough(fn () => @mkdir($path, $mode, (bool) ($options & STREAM_MKDIR_RECURSIVE)));
    }

    public function rmdir(string $path, int $options): bool
    {
        return $this->passthrough(fn () => @rmdir($path));
    }

    public function dir_opendir(string $path, int $options): bool
    {
        self::restore();
        try {
            $this->dir = @opendir($path, $this->context);
            return $this->dir !== false;
        } finally {
            self::register();
        }
    }

    public function dir_readdir(): string|false
    {
        return $this->dir ? readdir($this->dir) : false;
    }

    public function dir_rewinddir(): bool
    {
        if ($this->dir) {
            rewinddir($this->dir);
            return true;
        }
        return false;
    }

    public function dir_closedir(): bool
    {
        if ($this->dir) {
            closedir($this->dir);
            $this->dir = null;
            return true;
        }
        return false;
    }

    // ---- helpers ----------------------------------------------------------

    private function passthrough(callable $op): bool
    {
        self::restore();
        try {
            return (bool) $op();
        } finally {
            self::register();
        }
    }

    private static function instrument(string $source, array $cfg): string
    {
        if (($cfg['swaps'] ?? []) !== []) {
            $source = (new Swapper())->apply($source, $cfg['swaps'])['source'];
        }
        if (($cfg['waypoints'] ?? []) !== []) {
            $source = (new WaypointInstrumenter())->instrument($source, $cfg['waypoints'])['source'];
        }
        return $source;
    }

    private function fakeStat(int $size): array
    {
        $now = 0; // deterministic; mtime isn't meaningful for an in-memory rewrite
        $stat = [
            'dev' => 0, 'ino' => 0, 'mode' => 0100644, 'nlink' => 1, 'uid' => 0, 'gid' => 0,
            'rdev' => 0, 'size' => $size, 'atime' => $now, 'mtime' => $now, 'ctime' => $now,
            'blksize' => -1, 'blocks' => -1,
        ];
        return array_merge(array_values($stat), $stat);
    }
}
