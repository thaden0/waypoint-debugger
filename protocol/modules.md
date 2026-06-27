# Modules

A **module** is the unit you add to support a new language or framework. The
abstract-factory pattern lives *inside* a language runner (same-runtime code); a
manifest + the wire protocol unify modules across runtimes.

Two kinds:

- **Language module** — a runner (a process speaking the [protocol](./README.md)) plus
  language metadata (file extensions, editor styling). Role: `backend`, `frontend`, or
  `both` (drives the split-screen). e.g. `php`, `ts`, `csharp`, `dart`.
- **Framework module** — providers that plug into a language runner: a `HostProvider`
  (runtime: boot / request / transactions / container), a `RouteProvider` (api console),
  an `OrmProvider` (data console). It `targets` a language. e.g. `laravel`, `aspnet`,
  `express`.

A framework module's code is written in its target language and runs **inside** that
language's runner (Laravel's `OrmProvider` is PHP). The module **directory** is the unit
of organization and distribution: manifest + adapter source + assets/metadata.

## Layout

```
runner/
  src/Module/            core interfaces: FrameworkModule, Host?…, RouteProvider, OrmProvider,
                         NullRouteProvider, ModuleRegistry
  modules/
    Bare/    module.json  BareModule.php
    Laravel/ module.json  LaravelModule.php  LaravelRouteProvider.php  EloquentOrmProvider.php  assets/
```

The registry scans `modules/*/module.json`, picks a module by `detect`, and resolves the
provider classes named in `provides` (PSR-4 autoloaded).

## `module.json`

```jsonc
// framework module
{
  "id": "laravel",
  "kind": "framework",
  "extends": "php",                 // language module it targets
  "role": "backend",
  "detect": ["bootstrap/app.php", "artisan"],   // all must exist under the project root
  "provides": {
    "module": "Waypoint\\Modules\\Laravel\\LaravelModule"
  },
  "capabilities": ["host", "run", "invoke", "api", "orm"]
}
```

```jsonc
// language module (consumed by the host/launcher, not the in-process registry)
{
  "id": "php",
  "kind": "language",
  "role": "backend",
  "runner": { "cmd": ["php", "runner/bin/host.php"], "wsPortEnv": "WP_WS_PORT" },
  "extensions": [".php"],
  "monaco": "php"
}
```

## Swapping a provider per project

A framework module ships defaults (`laravel` → Eloquent ORM), but a project's
`.waypoint` config may override a single provider — e.g. select a Doctrine `OrmProvider`
independent of the framework. Providers are interchangeable within a runner because the
console only ever talks to the interface (`OrmProvider`, `RouteProvider`), never the
concrete class.

## Adding support

- **New framework (same language):** add `modules/<Name>/` with a `module.json` and the
  provider classes. No core edits — the registry discovers it.
- **New language:** ship a runner that speaks the protocol; register a language
  `module.json` with its launch command. Framework modules then target it.
