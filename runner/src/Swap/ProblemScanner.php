<?php

declare(strict_types=1);

namespace Waypoint\Runner\Swap;

use PhpParser\Node;
use PhpParser\Node\Expr;
use PhpParser\NodeTraverser;
use PhpParser\NodeVisitorAbstract;
use PhpParser\ParserFactory;

/**
 * Statically flags "problem code" — the calls that break isolation or
 * determinism and are therefore the swap candidates the editor auto-highlights.
 *
 * The flag set IS the answer to "what should I mock?": external reads
 * (Eloquent / query builder), non-deterministic reads (now(), random, uuid),
 * and I/O (Http, filesystem, env). Highlighting is a suggester, not a gate —
 * the user can swap anything, and a swap site is an *expression hole*.
 */
final class ProblemScanner
{
    /** Static-call class => category. */
    private const STATIC_CLASS_CATEGORIES = [
        'Http' => 'io.http',
        'Storage' => 'io.filesystem',
        'File' => 'io.filesystem',
        'Mail' => 'io.mail',
        'Cache' => 'io.cache',
        'Redis' => 'io.cache',
        'Queue' => 'io.queue',
        'Bus' => 'io.queue',
        'Event' => 'io.event',
        'Log' => 'io.log',
        'Carbon' => 'nondeterministic.time',
    ];

    /** Eloquent / query-builder methods that issue a DB read or write. */
    private const DB_METHODS = [
        'find', 'findOrFail', 'first', 'firstOrFail', 'get', 'all', 'paginate',
        'create', 'save', 'update', 'delete', 'destroy', 'firstOrCreate',
        'updateOrCreate', 'where', 'count', 'exists', 'pluck', 'value',
    ];

    /** Free functions that read non-deterministic or environment state. */
    private const FUNC_CATEGORIES = [
        'now' => 'nondeterministic.time',
        'today' => 'nondeterministic.time',
        'time' => 'nondeterministic.time',
        'microtime' => 'nondeterministic.time',
        'date' => 'nondeterministic.time',
        'rand' => 'nondeterministic.random',
        'mt_rand' => 'nondeterministic.random',
        'random_int' => 'nondeterministic.random',
        'random_bytes' => 'nondeterministic.random',
        'uniqid' => 'nondeterministic.random',
        'env' => 'io.env',
        'getenv' => 'io.env',
        'config' => 'io.config',
        'fopen' => 'io.filesystem',
        'file_get_contents' => 'io.filesystem',
        'file_put_contents' => 'io.filesystem',
        'curl_exec' => 'io.http',
    ];

    private \PhpParser\Parser $parser;

    public function __construct()
    {
        $this->parser = (new ParserFactory())->createForHostVersion();
    }

    /**
     * @return array<int,array{category:string,label:string,line:int,endLine:int,startCol:?int,endCol:?int,snippet:string}>
     */
    public function scan(string $source): array
    {
        try {
            $ast = $this->parser->parse($source) ?? [];
        } catch (\PhpParser\Error) {
            return [];
        }

        $lines = explode("\n", $source);
        $visitor = new class($lines) extends NodeVisitorAbstract {
            /** @var array<int,array<string,mixed>> */
            public array $hits = [];

            public function __construct(private array $lines)
            {
            }

            public function enterNode(Node $node)
            {
                $hit = null;

                if ($node instanceof Expr\StaticCall && $node->class instanceof Node\Name) {
                    $class = $node->class->getLast();
                    $cat = ProblemScanner::categoryForStatic($class, $this->methodName($node));
                    if ($cat !== null) {
                        $hit = [$cat, $class . '::' . $this->methodName($node)];
                    }
                } elseif ($node instanceof Expr\MethodCall || $node instanceof Expr\NullsafeMethodCall) {
                    $name = $this->methodName($node);
                    if ($name !== null && in_array($name, ProblemScanner::dbMethods(), true)) {
                        $hit = ['external.db', '->' . $name . '()'];
                    }
                } elseif ($node instanceof Expr\FuncCall && $node->name instanceof Node\Name) {
                    $fn = $node->name->getLast();
                    $cat = ProblemScanner::categoryForFunc($fn);
                    if ($cat !== null) {
                        $hit = [$cat, $fn . '()'];
                    }
                }

                if ($hit !== null) {
                    $this->hits[] = [
                        'category' => $hit[0],
                        'label' => $hit[1],
                        'line' => $node->getStartLine(),
                        'endLine' => $node->getEndLine(),
                        'startCol' => $this->col($node->getStartFilePos(), $node->getStartLine()),
                        'endCol' => $this->col($node->getEndFilePos() + 1, $node->getEndLine()),
                        'snippet' => $this->lines[$node->getStartLine() - 1] ?? '',
                    ];
                }
                return null;
            }

            private function methodName(Node $node): ?string
            {
                $name = $node->name ?? null;
                return $name instanceof Node\Identifier ? $name->toString() : null;
            }

            private function col(int $filePos, int $line): int
            {
                $offset = 0;
                for ($i = 0; $i < $line - 1; $i++) {
                    $offset += strlen($this->lines[$i] ?? '') + 1;
                }
                return max(0, $filePos - $offset);
            }
        };

        $traverser = new NodeTraverser();
        $traverser->addVisitor($visitor);
        $traverser->traverse($ast);

        return $visitor->hits;
    }

    /** Helper classes whose specific methods are non-deterministic. */
    private const NONDETERMINISTIC_STATIC_METHODS = [
        'Str' => ['random' => 'nondeterministic.random', 'uuid' => 'nondeterministic.random', 'orderedUuid' => 'nondeterministic.random', 'ulid' => 'nondeterministic.random'],
        'Uuid' => ['uuid4' => 'nondeterministic.random', 'uuid1' => 'nondeterministic.random'],
    ];

    public static function categoryForStatic(string $class, ?string $method): ?string
    {
        if (isset(self::NONDETERMINISTIC_STATIC_METHODS[$class][$method])) {
            return self::NONDETERMINISTIC_STATIC_METHODS[$class][$method];
        }
        if (isset(self::STATIC_CLASS_CATEGORIES[$class])) {
            return self::STATIC_CLASS_CATEGORIES[$class];
        }
        // Eloquent static entry points: User::find(...), User::where(...).
        if ($method !== null && in_array($method, self::DB_METHODS, true)) {
            return 'external.db';
        }
        return null;
    }

    public static function categoryForFunc(string $fn): ?string
    {
        return self::FUNC_CATEGORIES[$fn] ?? null;
    }

    /** @return array<int,string> */
    public static function dbMethods(): array
    {
        return self::DB_METHODS;
    }
}
