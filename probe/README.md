# waypoint/probe

An in-project probe the [Waypoint](../) debugger pulls from. It buffers errors and
log events (bounded ring buffer, redacted) and exposes an **authenticated,
bidirectional endpoint** — the Waypoint tool *pulls* buffered records and *pushes*
config (trigger classes, ring-buffer toggle).

**Fail-closed:** does nothing unless `WAYPOINT_PROBE_ENABLED=true` **and**
`WAYPOINT_PROBE_SECRET` is set. The Waypoint tool manages the secret for you.

```bash
composer require waypoint/probe
# Waypoint writes these into your app's .env when you enable the probe:
#   WAYPOINT_PROBE_ENABLED=true
#   WAYPOINT_PROBE_SECRET=<generated>
#   WAYPOINT_PROBE_BUFFER=cache        # redis/db/file via your cache; 'file' fallback
```

- **Capture:** reported exceptions (handler decorator — the reliable point) + log
  events at/above `log_level` (deduped against exceptions). The failing request is
  recorded (redacted) so Waypoint can re-run it through the instrumented host.
- **Bounded buffer** (`max` records, `ttl`) — the prod-safety guarantee; no
  pre-emptive state saving in prod.
- **Endpoint:** `GET <path>` pulls (+ ack/clear); `POST <path>` pushes config. Auth
  = timing-safe shared-secret + optional IP allowlist.

Tests (framework-free core): `php run-tests.php`.
