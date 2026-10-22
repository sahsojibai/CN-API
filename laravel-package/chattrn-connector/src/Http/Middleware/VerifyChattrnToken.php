<?php

namespace Chattrn\Connector\Http\Middleware;

use Closure;
use Illuminate\Http\Request;

// devspec.txt: "Auth | X-Chattrn-Access-Token: {token}, issued by the merchant (or by
// Chattrn through the Laravel token flow)". The request is refused the same way the Node
// mock store refuses it (401, {"errors": "Invalid access token"}), so the test runner's
// "wrong credential" assertions behave identically against a real package install.
class VerifyChattrnToken
{
    public function handle(Request $request, Closure $next)
    {
        $expected = config('chattrn.access_token');
        $given = $request->header('X-Chattrn-Access-Token');

        if (! $expected || ! $given || ! hash_equals((string) $expected, (string) $given)) {
            return response()->json(['errors' => 'Invalid access token'], 401)
                ->header('X-Chattrn-API-Version', config('chattrn.api_version'));
        }

        return $next($request);
    }
}
