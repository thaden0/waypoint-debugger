<?php

declare(strict_types=1);

// Waypoint probe configuration. The probe is OFF unless both `enabled` is true
// AND a `secret` is set — fail-closed so it never exposes data unconfigured. The
// Waypoint tool writes these (it manages the secret for you).
return [
    // Master switch. Combined with a non-empty secret to arm the endpoint.
    'enabled' => env('WAYPOINT_PROBE_ENABLED', false),

    // Shared secret the Waypoint tool sends to pull/configure. No secret → off.
    'secret' => env('WAYPOINT_PROBE_SECRET'),

    // Route the tool reaches (GET = pull, POST = push config). Keep it unguessable-ish.
    'path' => env('WAYPOINT_PROBE_PATH', '_waypoint/probe'),

    // Optional IP allowlist (comma-separated) for the endpoint. Empty = any.
    'allow_ips' => array_filter(explode(',', (string) env('WAYPOINT_PROBE_ALLOW_IPS', ''))),

    // Bounded ring buffer — this is the prod-safety guarantee (never unbounded).
    'buffer' => [
        // 'cache' uses the app's cache store (redis/db/file per the app); 'file'
        // is the always-available fallback. Default: cache if available, else file.
        'driver' => env('WAYPOINT_PROBE_BUFFER', 'cache'),
        'max' => (int) env('WAYPOINT_PROBE_MAX', 200), // most-recent N records
        'ttl' => (int) env('WAYPOINT_PROBE_TTL', 3600), // seconds
        'file' => env('WAYPOINT_PROBE_FILE', storage_path('app/waypoint-probe.json')),
    ],

    // What the probe records on its own (always light in prod):
    'capture' => [
        'exceptions' => true, // request exceptions (via middleware)
        'logs' => env('WAYPOINT_PROBE_LOGS', true), // log events at/above `log_level`
        'log_level' => env('WAYPOINT_PROBE_LOG_LEVEL', 'error'),
        'queries' => env('WAYPOINT_PROBE_QUERIES', false), // recent DB queries (heavier)
    ],

    // Fields scrubbed from captured request input / headers. Extend as needed.
    'redact' => [
        'password', 'password_confirmation', 'token', '_token', 'secret', 'api_key',
        'authorization', 'cookie', 'set-cookie', 'credit_card', 'card_number', 'cvv',
    ],

    // Heavy, dev-oriented, OFF by default — toggled remotely by the tool. Saves
    // richer state on the trigger events below. Never pre-emptive in prod.
    'ring_buffer' => env('WAYPOINT_PROBE_RING', false),

    // Exception classes (substring match) that trigger a state save report.
    'triggers' => array_filter(explode(',', (string) env('WAYPOINT_PROBE_TRIGGERS', ''))),
];
