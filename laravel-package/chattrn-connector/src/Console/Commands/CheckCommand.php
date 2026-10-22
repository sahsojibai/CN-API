<?php

namespace Chattrn\Connector\Console\Commands;

use Illuminate\Console\Command;
use Illuminate\Support\Facades\Http;

// devspec.txt: "php artisan chattrn:check runs the contract tests locally." A lightweight
// local self-check - not a replacement for chattrn-backend's own test runner (which Chattrn
// runs against the live store from its side once registered), but catches a missing token,
// an unmapped model or a broken route before the merchant leaves the terminal.
class CheckCommand extends Command
{
    protected $signature = 'chattrn:check';
    protected $description = 'Run the Chattrn API contract checks against this app, locally';

    public function handle(): int
    {
        $prefix = config('chattrn.route_prefix');
        $token = config('chattrn.access_token');
        $base = rtrim(config('app.url'), '/') . $prefix;
        $rows = [];

        if (! $token) {
            $this->error('No CHATTRN_ACCESS_TOKEN set yet - run chattrn:map first.');
            return self::FAILURE;
        }

        $get = fn (string $path) => Http::withHeaders(['X-Chattrn-Access-Token' => $token])->timeout(5)->get($base . $path);

        $store = $get('/store.json');
        $rows[] = ['Store profile', $this->verdict($store->ok() && $store->json('store.api_version'))];

        $products = $get('/products.json?limit=1');
        $rows[] = ['Catalog', $this->verdict($products->ok() && is_array($products->json('products')))];

        $count = $get('/products/count.json');
        $rows[] = ['Product count', $this->verdict($count->ok() && is_int($count->json('count')))];

        $locations = $get('/locations.json');
        $rows[] = ['Locations', $this->verdict($locations->ok() && is_array($locations->json('locations')))];

        $orders = $get('/orders.json');
        $rows[] = ['Orders', $this->verdict($orders->ok() && is_array($orders->json('orders')))];

        $unauth = Http::timeout(5)->get($base . '/store.json');
        $rows[] = ['Wrong token refused', $this->verdict($unauth->status() === 401)];

        $this->table(['Check', 'Result'], $rows);

        $failed = collect($rows)->contains(fn ($r) => $r[1] === 'FAIL');
        return $failed ? self::FAILURE : self::SUCCESS;
    }

    private function verdict(bool $ok): string
    {
        return $ok ? 'PASS' : 'FAIL';
    }
}
