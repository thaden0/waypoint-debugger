<?php

declare(strict_types=1);

/**
 * Standalone smoke test of the runner core against the fixture controller.
 * Run: php bin/smoke.php
 */

require __DIR__ . '/../vendor/autoload.php';

use Waypoint\Runner\Capture\Recorder;
use Waypoint\Runner\Reconstruct\Invoker;
use Waypoint\Runner\Structure\StructureExtractor;
use Waypoint\Runner\Swap\ProblemScanner;
use Waypoint\Runner\Swap\Swapper;
use Waypoint\Runner\Waypoint\WaypointInstrumenter;

$fixture = __DIR__ . '/../tests/fixtures/UserController.php';
$source = file_get_contents($fixture);
$pass = 0;
$fail = 0;

function check(string $label, bool $cond): void
{
    global $pass, $fail;
    echo ($cond ? "  ok   " : "  FAIL ") . $label . "\n";
    $cond ? $pass++ : $fail++;
}

echo "== structure ==\n";
$structure = (new StructureExtractor())->extractFile('UserController.php', $source);
$class = $structure['nodes'][0] ?? null;
check('one class extracted', ($class['name'] ?? null) === 'UserController');
check('namespace captured', $structure['namespace'] === 'App\\Http\\Controllers');
$methods = array_values(array_filter($class['members'] ?? [], fn ($m) => $m['kind'] === 'method'));
$show = current(array_filter($methods, fn ($m) => $m['name'] === 'show'));
$audit = current(array_filter($methods, fn ($m) => $m['name'] === 'audit'));
check('public method show is waypoint-eligible', $show['waypointEligible'] === true);
check('protected method audit is NOT waypoint-eligible', $audit['waypointEligible'] === false);

echo "== problem scan ==\n";
$problems = (new ProblemScanner())->scan($source);
$cats = array_column($problems, 'category');
check('flags Eloquent findOrFail (external.db)', in_array('external.db', $cats, true));
check('flags Str::random (nondeterministic.random)', in_array('nondeterministic.random', $cats, true));
check('flags now() (nondeterministic.time)', in_array('nondeterministic.time', $cats, true));

echo "== swap ==\n";
// Swap the User::findOrFail($id) assignment (line of `$user = User::findOrFail($id);`).
$findLine = null;
foreach (explode("\n", $source) as $i => $line) {
    if (str_contains($line, 'User::findOrFail')) {
        $findLine = $i + 1;
        break;
    }
}
$swapResult = (new Swapper())->apply($source, [
    ['line' => $findLine, 'mode' => 'indirect', 'key' => 'user_1'],
]);
check('swap applied once', $swapResult['applied'] === 1);
check('swap injects indirection map', str_contains($swapResult['source'], "__waypointSwaps['user_1']"));
check('untouched code preserved (store method intact)', str_contains($swapResult['source'], 'public function store(Request $request)'));

$swapReplace = (new Swapper())->apply($source, [
    ['line' => $findLine, 'mode' => 'replace', 'expression' => '$mockUser'],
]);
check('replace-mode swaps RHS to arbitrary code', str_contains($swapReplace['source'], '$user = $mockUser;'));

echo "== waypoint instrument ==\n";
$showLine = null;
foreach (explode("\n", $source) as $i => $line) {
    if (str_contains($line, 'public function show(')) {
        $showLine = $i + 1;
        break;
    }
}
$inst = (new WaypointInstrumenter())->instrument($source, [
    ['line' => $showLine, 'id' => 'UserController::show'],
]);
check('waypoint hook injected', str_contains($inst['source'], 'Waypoint\\Runner\\Capture\\Recorder::capture'));
check('hook records func_get_args', str_contains($inst['source'], 'func_get_args()'));
check('one method instrumented', count($inst['instrumented']) === 1);

echo "== capture + reconstruct + invoke ==\n";
// Build a hand-authored entry: a tier-1/2 receiver with a scalar arg, and invoke.
class SmokeAdder
{
    public int $base = 10;
    public function add(int $n): int
    {
        return $this->base + $n;
    }
}
Recorder::reset();
Recorder::capture('SmokeAdder::add', new SmokeAdder(), [5]);
$entry = Recorder::entry(0);
check('captured entry is reproducible (tier < 3)', $entry['reproducible'] === true);

$rolledBack = false;
$invoker = new Invoker(
    begin: function () {},
    commit: function () {},
    rollback: function () use (&$rolledBack) { $rolledBack = true; },
);
$out = $invoker->invoke($entry, 'add', 'peek');
check('invoke succeeded', $out['ok'] === true);
check('result correct (10 + 5 = 15)', $out['result'] === 15);
check('peek mode rolled back', $rolledBack === true && $out['committed'] === false);

// Tier-3 refusal: a closure receiver field must be refused gracefully.
Recorder::reset();
$withClosure = new SmokeAdder();
$snapshot = Recorder::snapshotValue(fn () => 1);
check('closure classified tier 3', $snapshot['tier'] === 3);

echo "\n== $pass passed, $fail failed ==\n";
exit($fail === 0 ? 0 : 1);
