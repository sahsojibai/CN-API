<?php

use Illuminate\Support\Facades\Route;
use Chattrn\Connector\Http\Controllers\ChattrnApiController;
use Chattrn\Connector\Http\Middleware\VerifyChattrnToken;

// See public/openapi.yaml in chattrn-backend for the full contract these paths implement.
Route::prefix(ltrim(config('chattrn.route_prefix', '/chattrn/api/2026-10'), '/'))
    ->middleware([VerifyChattrnToken::class])
    ->group(function () {
        Route::get('store.json', [ChattrnApiController::class, 'store']);

        Route::get('products.json', [ChattrnApiController::class, 'products']);
        Route::get('products/count.json', [ChattrnApiController::class, 'productsCount']);
        Route::get('products/search.json', [ChattrnApiController::class, 'productsSearch']);
        Route::get('products/{id}.json', [ChattrnApiController::class, 'product']);

        Route::get('locations.json', [ChattrnApiController::class, 'locations']);
        Route::get('locations/resolve.json', [ChattrnApiController::class, 'locationsResolve']);
        Route::get('inventory_levels.json', [ChattrnApiController::class, 'inventoryLevels']);

        Route::get('customers/search.json', [ChattrnApiController::class, 'customersSearch']);
        Route::get('customers/{id}/orders.json', [ChattrnApiController::class, 'customerOrders']);

        Route::get('orders.json', [ChattrnApiController::class, 'orders']);
        Route::get('orders/{id}.json', [ChattrnApiController::class, 'order']);
        Route::get('orders/{id}/fulfillments.json', [ChattrnApiController::class, 'orderFulfillments']);
        Route::post('orders/{id}/cancel.json', [ChattrnApiController::class, 'cancelOrder']);

        Route::post('draft_orders.json', [ChattrnApiController::class, 'createDraftOrder']);
        Route::put('draft_orders/{id}.json', [ChattrnApiController::class, 'updateDraftOrder']);
        Route::put('draft_orders/{id}/complete.json', [ChattrnApiController::class, 'completeDraftOrder']);
    });
