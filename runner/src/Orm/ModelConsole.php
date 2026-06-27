<?php

declare(strict_types=1);

namespace Waypoint\Runner\Orm;

use PhpParser\Node;
use PhpParser\NodeFinder;
use PhpParser\NodeTraverser;
use PhpParser\NodeVisitor\CloningVisitor;
use PhpParser\ParserFactory;
use PhpParser\PrettyPrinter\Standard;
use Waypoint\Runner\Host\HostInterface;
use Waypoint\Runner\Support\Preview;

/**
 * The ORM data console: work with the project's data through its own Eloquent
 * models, evaluated in the booted host. We build no query layer of our own — a
 * query is just real PHP (`User::where('email', $x)->first()`) handed to the
 * booted app to eval, rendered back via Preview. Writes are transaction-guarded:
 * peek rolls back (safe by default), commit persists — the same dial as the
 * reconstruct+invoke replay loop.
 *
 * It is essentially a visual, safe-by-default `artisan tinker` scoped to models,
 * reusing the resident host's container + DB connection.
 */
final class ModelConsole
{
    private const RELATION_METHODS = [
        'hasOne', 'hasMany', 'belongsTo', 'belongsToMany', 'hasOneThrough', 'hasManyThrough',
        'morphTo', 'morphOne', 'morphMany', 'morphToMany', 'morphedByMany',
    ];

    /** @var array<string,array{name:string,class:string,path:string,table:string}>|null keyed by short name */
    private ?array $models = null;

    public function __construct(private string $projectRoot, private HostInterface $host)
    {
    }

    /** @return list<array{name:string,class:string,path:string,table:string,count:int|null}> */
    public function listModels(): array
    {
        $out = [];
        foreach ($this->discover() as $m) {
            $count = null;
            try {
                $count = $m['class']::query()->count();
            } catch (\Throwable) {
                // table may not exist yet (pre-migration) — leave null
            }
            $out[] = $m + ['count' => $count];
        }
        usort($out, static fn ($a, $b) => strcmp($a['name'], $b['name']));
        return $out;
    }

    /**
     * Evaluate an Eloquent/PHP expression in the booted app. Model short names are
     * aliased (so `User::...` works like tinker). Transaction-guarded: peek rolls
     * back, commit persists. Returns the rendered result + the SQL it ran.
     *
     * @return array{ok:bool,type?:string,result?:mixed,sql?:array,count?:int|null,committed:bool,error?:string,durationMs:float}
     */
    public function query(string $expr, bool $commit = false): array
    {
        $this->aliasModels();
        $db = $this->db();
        if ($db !== null) {
            $db->flushQueryLog();
            $db->enableQueryLog();
        }

        [$begin, $commitTx, $rollback] = $this->host->transactionHooks();
        $begin();
        $start = microtime(true);
        try {
            $expr = trim($expr);
            $expr = rtrim($expr, ';');
            /** @psalm-suppress ForbiddenCode */
            $result = eval("return {$expr};");
            $durationMs = round((microtime(true) - $start) * 1000, 2);

            $sql = $db !== null ? array_map(static fn ($q) => [
                'query' => $q['query'] ?? '',
                'bindings' => array_map(static fn ($b) => is_scalar($b) ? $b : Preview::describe($b), $q['bindings'] ?? []),
                'time' => $q['time'] ?? null,
            ], $db->getQueryLog()) : [];

            if ($commit) {
                $commitTx();
            } else {
                $rollback();
            }

            return [
                'ok' => true,
                'type' => Preview::describe($result),
                'result' => Preview::render($result),
                'count' => $result instanceof \Countable ? count($result) : null,
                'sql' => $sql,
                'committed' => $commit,
                'durationMs' => $durationMs,
            ];
        } catch (\Throwable $e) {
            $rollback();
            return [
                'ok' => false,
                'error' => $e->getMessage(),
                'committed' => false,
                'durationMs' => round((microtime(true) - $start) * 1000, 2),
            ];
        }
    }

    /**
     * Paginated rows for a model's table (the spreadsheet view), with the schema
     * columns. Optional filters: [{column, op, value}] → ->where(...).
     *
     * @param list<array{column:string,op:string,value:mixed}> $filters
     */
    public function table(string $model, int $page = 1, int $perPage = 50, array $filters = []): array
    {
        $class = $this->resolve($model);
        if ($class === null) {
            return ['ok' => false, 'error' => "unknown model: {$model}"];
        }
        $this->aliasModels();
        try {
            $q = $class::query();
            foreach ($filters as $f) {
                $op = $f['op'] ?? '=';
                if (strtolower((string) $op) === 'like') {
                    $q->where($f['column'], 'like', '%' . $f['value'] . '%');
                } else {
                    $q->where($f['column'], $op, $f['value']);
                }
            }
            $total = (clone $q)->count();
            $rows = $q->forPage(max(1, $page), $perPage)->get();
            return [
                'ok' => true,
                'columns' => $this->columns($class),
                'rows' => Preview::render($rows),
                'total' => $total,
                'page' => $page,
                'perPage' => $perPage,
            ];
        } catch (\Throwable $e) {
            return ['ok' => false, 'error' => $e->getMessage()];
        }
    }

    /** @return list<array{method:string,type:string,related:?string}> */
    public function relationships(string $model): array
    {
        $class = $this->resolve($model);
        if ($class === null) {
            return [];
        }
        $path = $this->models[$this->short($class)]['path'] ?? null;
        if ($path === null) {
            return [];
        }
        $source = @file_get_contents($this->projectRoot . '/' . $path);
        if ($source === false) {
            return [];
        }

        $parser = (new ParserFactory())->createForHostVersion();
        try {
            $ast = $parser->parse($source) ?? [];
        } catch (\Throwable) {
            return [];
        }
        $finder = new NodeFinder();
        $out = [];
        /** @var Node\Stmt\ClassMethod[] $methods */
        $methods = $finder->findInstanceOf($ast, Node\Stmt\ClassMethod::class);
        foreach ($methods as $method) {
            $calls = $finder->findInstanceOf($method->stmts ?? [], Node\Expr\MethodCall::class);
            foreach ($calls as $call) {
                if (!$call->name instanceof Node\Identifier) {
                    continue;
                }
                $rel = $call->name->toString();
                if (!in_array($rel, self::RELATION_METHODS, true)) {
                    continue;
                }
                if (!($call->var instanceof Node\Expr\Variable && $call->var->name === 'this')) {
                    continue;
                }
                $out[] = [
                    'method' => $method->name->toString(),
                    'type' => $rel,
                    'related' => $this->relatedClass($call),
                ];
                break; // first relation call per method
            }
        }
        return $out;
    }

    /**
     * Edit model properties from the GUI: $table (string), $fillable (string[]),
     * $casts (map). Format-preserving AST rewrite of just those properties.
     *
     * @param array{table?:string,fillable?:list<string>,casts?:array<string,string>} $props
     */
    public function alter(string $model, array $props): array
    {
        $class = $this->resolve($model);
        $path = $class !== null ? ($this->models[$this->short($class)]['path'] ?? null) : null;
        if ($path === null) {
            return ['ok' => false, 'error' => "unknown model: {$model}"];
        }
        $full = $this->projectRoot . '/' . $path;
        $source = @file_get_contents($full);
        if ($source === false) {
            return ['ok' => false, 'error' => "cannot read {$path}"];
        }

        $parser = (new ParserFactory())->createForHostVersion();
        try {
            $oldStmts = $parser->parse($source);
            $oldTokens = $parser->getTokens();
        } catch (\Throwable $e) {
            return ['ok' => false, 'error' => 'parse failed: ' . $e->getMessage()];
        }
        $newStmts = (new NodeTraverser(new CloningVisitor()))->traverse($oldStmts ?? []);

        $finder = new NodeFinder();
        /** @var Node\Stmt\Property[] $properties */
        $properties = $finder->findInstanceOf($newStmts, Node\Stmt\Property::class);

        $values = [];
        if (array_key_exists('table', $props)) {
            $values['table'] = new Node\Scalar\String_((string) $props['table']);
        }
        if (array_key_exists('fillable', $props)) {
            $values['fillable'] = $this->arrayNode(array_values($props['fillable']));
        }
        if (array_key_exists('casts', $props)) {
            $values['casts'] = $this->mapNode($props['casts']);
        }

        $applied = [];
        foreach ($properties as $property) {
            foreach ($property->props as $prop) {
                $name = $prop->name->toString();
                if (isset($values[$name])) {
                    $prop->default = $values[$name];
                    $applied[] = $name;
                }
            }
        }

        $printer = new Standard();
        $newSource = $printer->printFormatPreserving($newStmts, $oldStmts ?? [], $oldTokens);
        if (@file_put_contents($full, $newSource) === false) {
            return ['ok' => false, 'error' => "cannot write {$path}"];
        }
        return ['ok' => true, 'applied' => $applied, 'path' => $path];
    }

    /** Run `php artisan migrate` (or migrate:status) in the project. */
    public function migrate(bool $run = false): array
    {
        $cmd = $run ? ['migrate', '--force'] : ['migrate:status'];
        $artisan = $this->projectRoot . '/artisan';
        if (!is_file($artisan)) {
            return ['ok' => false, 'error' => 'no artisan in project root'];
        }
        $descriptors = [1 => ['pipe', 'w'], 2 => ['pipe', 'w']];
        $proc = proc_open(array_merge([PHP_BINARY, $artisan], $cmd), $descriptors, $pipes, $this->projectRoot);
        if (!is_resource($proc)) {
            return ['ok' => false, 'error' => 'failed to spawn artisan'];
        }
        $out = stream_get_contents($pipes[1]);
        $errOut = stream_get_contents($pipes[2]);
        fclose($pipes[1]);
        fclose($pipes[2]);
        $code = proc_close($proc);
        return ['ok' => $code === 0, 'ran' => $run, 'output' => trim($out . $errOut)];
    }

    // ---- internals ------------------------------------------------------------

    /** @return array<string,array{name:string,class:string,path:string,table:string}> */
    private function discover(): array
    {
        if ($this->models !== null) {
            return $this->models;
        }
        $this->models = [];
        $appDir = $this->projectRoot . '/app';
        if (!is_dir($appDir)) {
            return $this->models;
        }
        $modelBase = 'Illuminate\\Database\\Eloquent\\Model';
        $iter = new \RecursiveIteratorIterator(new \RecursiveDirectoryIterator($appDir, \FilesystemIterator::SKIP_DOTS));
        foreach ($iter as $file) {
            if (!$file->isFile() || $file->getExtension() !== 'php') {
                continue;
            }
            $rel = ltrim(str_replace($this->projectRoot, '', $file->getPathname()), '/');
            // app/Models/User.php -> App\Models\User  (PSR-4 App\ => app/)
            $class = 'App\\' . str_replace('/', '\\', substr($rel, strlen('app/'), -4));
            try {
                if (!class_exists($class) || !is_subclass_of($class, $modelBase)) {
                    continue;
                }
                $ref = new \ReflectionClass($class);
                if ($ref->isAbstract()) {
                    continue;
                }
                $instance = $ref->newInstanceWithoutConstructor();
                $table = method_exists($instance, 'getTable') ? $instance->getTable() : '';
            } catch (\Throwable) {
                continue;
            }
            $name = $this->short($class);
            $this->models[$name] = ['name' => $name, 'class' => $class, 'path' => $rel, 'table' => $table];
        }
        return $this->models;
    }

    private function aliasModels(): void
    {
        foreach ($this->discover() as $name => $m) {
            if (!class_exists($name, false)) {
                class_alias($m['class'], $name);
            }
        }
    }

    private function resolve(string $model): ?string
    {
        $this->discover();
        if (isset($this->models[$model])) {
            return $this->models[$model]['class'];
        }
        // allow passing a FQCN directly
        foreach ($this->models as $m) {
            if ($m['class'] === $model || $m['class'] === ltrim($model, '\\')) {
                return $m['class'];
            }
        }
        return null;
    }

    /** @return list<array{name:string,type:string}> */
    private function columns(string $class): array
    {
        try {
            $instance = (new \ReflectionClass($class))->newInstanceWithoutConstructor();
            $table = $instance->getTable();
            $schema = $instance->getConnection()->getSchemaBuilder();
            $names = $schema->getColumnListing($table);
            $out = [];
            foreach ($names as $col) {
                $type = 'string';
                try {
                    $type = $schema->getColumnType($table, $col);
                } catch (\Throwable) {
                    // some drivers/types can't report — default to string
                }
                $out[] = ['name' => $col, 'type' => $type];
            }
            return $out;
        } catch (\Throwable) {
            return [];
        }
    }

    private function db(): ?object
    {
        try {
            return $this->host->make('db')?->connection();
        } catch (\Throwable) {
            return null;
        }
    }

    private function relatedClass(Node\Expr\MethodCall $call): ?string
    {
        $arg = $call->args[0] ?? null;
        if (!$arg instanceof Node\Arg) {
            return null;
        }
        $value = $arg->value;
        if ($value instanceof Node\Expr\ClassConstFetch && $value->class instanceof Node\Name) {
            return $this->short($value->class->toString());
        }
        if ($value instanceof Node\Scalar\String_) {
            return $this->short($value->value);
        }
        return null;
    }

    /** @param list<string> $items */
    private function arrayNode(array $items): Node\Expr\Array_
    {
        $arrItems = [];
        foreach ($items as $item) {
            $arrItems[] = new Node\Expr\ArrayItem(new Node\Scalar\String_($item));
        }
        return new Node\Expr\Array_($arrItems, ['kind' => Node\Expr\Array_::KIND_SHORT]);
    }

    /** @param array<string,string> $map */
    private function mapNode(array $map): Node\Expr\Array_
    {
        $arrItems = [];
        foreach ($map as $k => $v) {
            $arrItems[] = new Node\Expr\ArrayItem(new Node\Scalar\String_($v), new Node\Scalar\String_($k));
        }
        return new Node\Expr\Array_($arrItems, ['kind' => Node\Expr\Array_::KIND_SHORT]);
    }

    private function short(string $class): string
    {
        $pos = strrpos($class, '\\');
        return $pos === false ? $class : substr($class, $pos + 1);
    }
}
