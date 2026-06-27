<?php

declare(strict_types=1);

namespace App\Http\Controllers;

use App\Models\User;
use App\Services\InvoiceService;
use Illuminate\Http\Request;
use Illuminate\Support\Str;

/**
 * A representative Laravel CRUD controller used as a parsing / swap / waypoint
 * fixture. Nothing here runs in tests — it is source the runner analyses.
 */
class UserController extends Controller
{
    private InvoiceService $invoices;

    public function __construct(InvoiceService $invoices)
    {
        $this->invoices = $invoices;
    }

    public function show(int $id): array
    {
        $user = User::findOrFail($id);
        $token = Str::random(40);
        $invoice = $this->invoices->latestFor($user);

        return [
            'user' => $user->email,
            'token' => $token,
            'invoice' => $invoice->total,
            'at' => now()->toIso8601String(),
        ];
    }

    public function store(Request $request): User
    {
        $user = new User();
        $user->email = $request->input('email');
        $user->name = $request->input('name');
        $user->save();

        return $user;
    }

    protected function audit(string $action): void
    {
        // protected — not a valid waypoint anchor.
    }
}
