<?php

namespace Chattrn\Connector\Support;

use Illuminate\Support\Facades\Http;

// Calls the Chattrn-side register endpoint (devspec.txt: "Register endpoint: on first boot
// the package sends the token, site URL, route prefix, package version and Laravel version.
// Chattrn returns the access key it will send as X-Chattrn-Access-Token..."). Chattrn's side
// of this contract is chattrn-backend/src/server.js's POST /package/register.
class ChattrnRegistrar
{
    public const PACKAGE_VERSION = '1.0.0';

    // Returns ['ok' => true, 'access_token' => ...] or ['ok' => false, 'message' => ...].
    public static function register(string $connectionToken): array
    {
        $backend = rtrim(config('chattrn.backend_url'), '/');
        $siteUrl = rtrim((string) (config('chattrn.store.domain') ?? config('app.url')), '/');

        $response = Http::timeout(10)->post("{$backend}/package/register", [
            'token' => $connectionToken,
            'site_url' => $siteUrl,
            'route_prefix' => config('chattrn.route_prefix'),
            'package_version' => self::PACKAGE_VERSION,
            'framework_version' => app()->version(),
            'models_matched' => [
                'product' => (bool) config('chattrn.models.product'),
                'variant' => (bool) config('chattrn.models.variant'),
                'order' => (bool) config('chattrn.models.order'),
                'customer' => (bool) config('chattrn.models.customer'),
            ],
        ]);

        if (! $response->successful()) {
            $message = $response->json('error.message') ?? $response->json('errors') ?? $response->body();
            return ['ok' => false, 'message' => is_string($message) ? $message : 'Register call failed.'];
        }

        return ['ok' => true, 'access_token' => $response->json('access_token')];
    }
}
