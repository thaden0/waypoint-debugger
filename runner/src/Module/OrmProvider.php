<?php

declare(strict_types=1);

namespace Waypoint\Runner\Module;

/**
 * The data-console surface a framework module supplies — work with the project's
 * data through its own ORM, evaluated in the booted host. A query is real code
 * (Eloquent / Doctrine / EF), transaction-guarded (peek rolls back, commit
 * persists). Swappable per project (Eloquent ↔ Doctrine) because the console only
 * ever talks to this interface.
 */
interface OrmProvider
{
    /** @return list<array{name:string,class:string,path:string,table:string,count:int|null}> */
    public function listModels(): array;

    /** @return array{ok:bool,type?:string,result?:mixed,sql?:array,count?:int|null,committed:bool,error?:string,durationMs:float} */
    public function query(string $expr, bool $commit = false): array;

    /** @param list<array{column:string,op:string,value:mixed}> $filters */
    public function table(string $model, int $page = 1, int $perPage = 50, array $filters = []): array;

    /** @return list<array{method:string,type:string,related:?string}> */
    public function relationships(string $model): array;

    /** @param array{table?:string,fillable?:list<string>,casts?:array<string,string>} $props */
    public function alter(string $model, array $props): array;

    public function migrate(bool $run = false): array;

    /** Snapshot a queried record into the ledger so it can drive the replay loop. */
    public function capture(string $expr): array;
}
