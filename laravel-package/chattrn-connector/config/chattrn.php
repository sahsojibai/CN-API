<?php

// Published by `php artisan chattrn:install`, filled in by `php artisan chattrn:map`.
// Full contract: ../../public/openapi.yaml in the chattrn-backend repo this package ships
// alongside; devspec.txt "Slice 3: Laravel package installer" is the narrative spec.
return [
    // Served under this prefix, e.g. https://your-store.com/chattrn/api/2026-10/store.json.
    'route_prefix' => '/chattrn/api/2026-10',
    'api_version' => '2026-10',

    // The access key Chattrn returns from POST /package/register (see ChattrnRegistrar).
    // Stored in .env, never committed.
    'access_token' => env('CHATTRN_ACCESS_TOKEN'),

    // Where the Chattrn backend lives, so this package can call POST /package/register.
    'backend_url' => env('CHATTRN_BACKEND_URL', 'https://api.chattrn.com'),

    // The one-time setup token pasted into .env from the Install package screen. Only read
    // once, by `php artisan chattrn:map` (or on boot if access_token is still empty), then
    // it should be removed from .env.
    'connection_token' => env('CHATTRN_TOKEN'),

    'store' => [
        'name' => env('APP_NAME', 'My Store'),
        'domain' => env('APP_URL'),
        'currency' => env('CHATTRN_CURRENCY', 'BDT'),
        'country_code' => env('CHATTRN_COUNTRY', 'BD'),
        'delivery_mode' => env('CHATTRN_DELIVERY_MODE', 'zone'), // zone | outlet
        'product_url_template' => null, // e.g. https://your-store.com/product/{handle}
        'cart_url_template' => null,
    ],

    // Which Eloquent model answers each canonical resource. Filled in by chattrn:map.
    'models' => [
        'product' => null,
        'variant' => null,
        'order' => null,
        'customer' => null,
        'location' => null,
    ],

    // Column overrides, only needed where a model's column name isn't already the canonical
    // name (id, title, price, ...). chattrn:map writes the ones it can't guess.
    'columns' => [
        'product' => [
            'title' => 'title',
            'handle' => 'slug',
            'vendor' => null,
            'status' => null,
            'image_url' => 'image_url',
        ],
        'variant' => [
            'title' => 'title',
            'price' => 'price',
            'compare_at_price' => null,
            'sku' => 'sku',
            'stock' => 'stock',
        ],
        'order' => [
            'number' => 'number',
            'phone' => 'phone',
            'total' => 'total',
            'currency' => null,
            'financial_status' => 'status',
            'fulfillment_status' => null,
        ],
        'customer' => [
            'phone' => 'phone',
            'email' => 'email',
        ],
    ],
];
