<?php

declare(strict_types=1);

namespace Waypoint\Runner\Structure;

use PhpParser\Node;
use PhpParser\Node\Stmt;
use PhpParser\NodeFinder;
use PhpParser\ParserFactory;

/**
 * Parses PHP source into the language-neutral structure model the UI canvas
 * renders. The schema deliberately uses "node-kind" tags (module / class /
 * function / method / property) so a future JS/TS adapter emits into the same
 * shape — even though PHP only exercises class/method/property at launch.
 *
 * The model is intentionally shallow and serializable: the coordinator stores
 * and ships it, it never re-parses on the UI side.
 */
final class StructureExtractor
{
    private \PhpParser\Parser $parser;
    private NodeFinder $finder;

    public function __construct()
    {
        $this->parser = (new ParserFactory())->createForHostVersion();
        $this->finder = new NodeFinder();
    }

    /**
     * @return array{path:string,kind:string,namespace:?string,nodes:array<int,array<string,mixed>>,error?:string}
     */
    public function extractFile(string $path, ?string $source = null): array
    {
        $source ??= @file_get_contents($path);
        if ($source === false || $source === null) {
            return ['path' => $path, 'kind' => 'module', 'namespace' => null, 'nodes' => [], 'error' => 'unreadable'];
        }

        try {
            $ast = $this->parser->parse($source) ?? [];
        } catch (\PhpParser\Error $e) {
            return ['path' => $path, 'kind' => 'module', 'namespace' => null, 'nodes' => [], 'error' => $e->getMessage()];
        }

        $namespace = $this->firstNamespace($ast);
        $nodes = [];

        // Classes, interfaces, traits, enums.
        foreach ($this->finder->findInstanceOf($ast, Stmt\ClassLike::class) as $classLike) {
            /** @var Stmt\ClassLike $classLike */
            $nodes[] = $this->classLikeToNode($classLike, $namespace);
        }

        // Top-level (non-method) functions — the "function" node-kind, useful
        // for non-class-dense code and forward-compatible with the JS phase.
        foreach ($this->finder->findInstanceOf($ast, Stmt\Function_::class) as $fn) {
            /** @var Stmt\Function_ $fn */
            $nodes[] = [
                'kind' => 'function',
                'name' => $fn->name->toString(),
                'line' => $this->span($fn),
                'params' => $this->params($fn->params),
                'returnType' => $this->typeToString($fn->returnType),
            ];
        }

        return [
            'path' => $path,
            'kind' => 'module',
            'namespace' => $namespace,
            'nodes' => $nodes,
        ];
    }

    /**
     * Walk a directory tree, returning one module entry per .php file plus a
     * lightweight folder tree the canvas uses for the file-structure boxes.
     *
     * @return array{root:string,files:array<int,array<string,mixed>>}
     */
    public function extractTree(string $root, int $maxFiles = 2000): array
    {
        $root = rtrim($root, '/');
        $files = [];
        $iter = new \RecursiveIteratorIterator(
            new \RecursiveCallbackFilterIterator(
                new \RecursiveDirectoryIterator($root, \FilesystemIterator::SKIP_DOTS),
                static function (\SplFileInfo $f): bool {
                    $name = $f->getFilename();
                    if ($f->isDir()) {
                        return !in_array($name, ['vendor', 'node_modules', '.git', 'storage', 'bootstrap'], true);
                    }
                    return str_ends_with($name, '.php');
                }
            )
        );

        foreach ($iter as $f) {
            /** @var \SplFileInfo $f */
            if (!$f->isFile()) {
                continue;
            }
            if (count($files) >= $maxFiles) {
                break;
            }
            $rel = ltrim(str_replace($root, '', $f->getPathname()), '/');
            $files[] = $this->extractFile($rel, (string) @file_get_contents($f->getPathname()));
        }

        return ['root' => $root, 'files' => $files];
    }

    private function classLikeToNode(Stmt\ClassLike $node, ?string $namespace): array
    {
        $kind = match (true) {
            $node instanceof Stmt\Interface_ => 'interface',
            $node instanceof Stmt\Trait_ => 'trait',
            $node instanceof Stmt\Enum_ => 'enum',
            default => 'class',
        };

        $extends = null;
        $implements = [];
        if ($node instanceof Stmt\Class_) {
            $extends = $node->extends?->toString();
            $implements = array_map(static fn (Node\Name $n) => $n->toString(), $node->implements);
        } elseif ($node instanceof Stmt\Interface_) {
            $implements = array_map(static fn (Node\Name $n) => $n->toString(), $node->extends);
        }

        $members = [];
        foreach ($node->getProperties() as $prop) {
            foreach ($prop->props as $p) {
                $members[] = [
                    'kind' => 'property',
                    'name' => $p->name->toString(),
                    'visibility' => $this->visibility($prop),
                    'static' => $prop->isStatic(),
                    'type' => $this->typeToString($prop->type),
                    'line' => $this->span($prop),
                ];
            }
        }
        foreach ($node->getMethods() as $method) {
            $isPublic = $method->isPublic();
            $members[] = [
                'kind' => 'method',
                'name' => $method->name->toString(),
                'visibility' => $this->visibility($method),
                'static' => $method->isStatic(),
                'abstract' => $method->isAbstract(),
                'params' => $this->params($method->params),
                'returnType' => $this->typeToString($method->returnType),
                'line' => $this->span($method),
                // A waypoint anchors on a public method: every entry captures
                // receiver + args, which is exactly the reconstruct+invoke unit.
                'waypointEligible' => $isPublic && !$method->isAbstract() && !$method->isStatic(),
            ];
        }

        return [
            'kind' => $kind,
            'name' => $node->name?->toString() ?? '(anonymous)',
            'namespace' => $namespace,
            'fqn' => $namespace ? $namespace . '\\' . ($node->name?->toString() ?? '') : ($node->name?->toString() ?? ''),
            'extends' => $extends,
            'implements' => $implements,
            'line' => $this->span($node),
            'members' => $members,
        ];
    }

    private function firstNamespace(array $ast): ?string
    {
        foreach ($ast as $stmt) {
            if ($stmt instanceof Stmt\Namespace_) {
                return $stmt->name?->toString();
            }
        }
        return null;
    }

    private function params(array $params): array
    {
        return array_map(function (Node\Param $p): array {
            return [
                'name' => $p->var instanceof Node\Expr\Variable && is_string($p->var->name) ? $p->var->name : '?',
                'type' => $this->typeToString($p->type),
                'hasDefault' => $p->default !== null,
                'variadic' => $p->variadic,
            ];
        }, $params);
    }

    private function visibility(Stmt\Property|Stmt\ClassMethod $node): string
    {
        if ($node->isPrivate()) {
            return 'private';
        }
        if ($node->isProtected()) {
            return 'protected';
        }
        return 'public';
    }

    private function typeToString(null|Node\Identifier|Node\Name|Node\ComplexType $type): ?string
    {
        if ($type === null) {
            return null;
        }
        if ($type instanceof Node\Identifier || $type instanceof Node\Name) {
            return $type->toString();
        }
        if ($type instanceof Node\NullableType) {
            return '?' . $this->typeToString($type->type);
        }
        if ($type instanceof Node\UnionType) {
            return implode('|', array_map(fn ($t) => $this->typeToString($t), $type->types));
        }
        if ($type instanceof Node\IntersectionType) {
            return implode('&', array_map(fn ($t) => $this->typeToString($t), $type->types));
        }
        return null;
    }

    private function span(Node $node): array
    {
        return ['start' => $node->getStartLine(), 'end' => $node->getEndLine()];
    }
}
