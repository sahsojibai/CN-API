<?php

namespace Chattrn\Connector\Http\Controllers;

use Illuminate\Http\Request;
use Illuminate\Http\JsonResponse;
use Illuminate\Routing\Controller;
use Chattrn\Connector\Support\ModelMap;

// Serves the same contract as chattrn-backend/src/mock-chattrn-store.js, so the Node test
// runner (and a real Chattrn workspace) can't tell this apart from the mock or a native
// Chattrn API store. See public/openapi.yaml in that repo for the full schema.
class ChattrnApiController extends Controller
{
    private function version(JsonResponse $res): JsonResponse
    {
        return $res->header('X-Chattrn-API-Version', config('chattrn.api_version'));
    }

    public function store(Request $request): JsonResponse
    {
        $store = config('chattrn.store');
        $hasVariant = (bool) config('chattrn.models.variant');
        $hasOrder = (bool) config('chattrn.models.order');
        $hasCustomer = (bool) config('chattrn.models.customer');

        return $this->version(response()->json(['store' => [
            'name' => $store['name'],
            'domain' => $store['domain'] ? parse_url($store['domain'], PHP_URL_HOST) : null,
            'currency' => $store['currency'],
            'country_code' => $store['country_code'],
            'iana_timezone' => config('app.timezone'),
            'api_version' => config('chattrn.api_version'),
            'delivery_mode' => $store['delivery_mode'],
            'capabilities' => [
                'products' => (bool) ModelMap::productModelClass(),
                'product_search' => (bool) ModelMap::productModelClass(),
                'inventory_levels' => $hasVariant,
                'locations_resolve' => (bool) config('chattrn.models.location'),
                'customers_search' => $hasCustomer,
                'orders_read' => $hasOrder,
                'orders_cancel' => $hasOrder,
                'draft_orders' => $hasOrder,
                'draft_orders_complete' => $hasOrder,
                'delivery_rates' => false,
            ],
            'product_url_template' => $store['product_url_template'],
            'cart_url_template' => $store['cart_url_template'],
        ]]));
    }

    public function products(Request $request): JsonResponse
    {
        $class = ModelMap::requireModel(ModelMap::productModelClass(), 'Product');
        $limit = min(250, max(1, (int) $request->query('limit', 50)));
        $page = max(1, (int) $request->query('page_info', 1));

        $query = $class::query()->orderBy((new $class)->getKeyName());
        $total = $query->count();
        $rows = $query->forPage($page, $limit)->get();

        $response = response()->json(['products' => $rows->map(fn ($p) => ModelMap::toProduct($p, $request->getHost()))->values()->all()]);
        if ($page * $limit < $total) {
            $next = $request->fullUrlWithQuery(['page_info' => $page + 1, 'limit' => $limit]);
            $response->header('Link', "<{$next}>; rel=\"next\"");
        }
        return $this->version($response);
    }

    public function productsCount(Request $request): JsonResponse
    {
        $class = ModelMap::requireModel(ModelMap::productModelClass(), 'Product');
        return $this->version(response()->json(['count' => $class::query()->count()]));
    }

    public function product(Request $request, string $id): JsonResponse
    {
        $class = ModelMap::requireModel(ModelMap::productModelClass(), 'Product');
        $product = $class::query()->find($id);
        if (! $product) {
            return $this->version(response()->json(['errors' => 'Not Found'], 404));
        }
        return $this->version(response()->json(['product' => ModelMap::toProduct($product, $request->getHost())]));
    }

    public function productsSearch(Request $request): JsonResponse
    {
        $class = ModelMap::requireModel(ModelMap::productModelClass(), 'Product');
        $titleCol = config('chattrn.columns.product.title', 'title');
        $limit = min(50, max(1, (int) $request->query('limit', 10)));
        $q = (string) $request->query('q', '');

        $rows = $class::query()->where($titleCol, 'like', "%{$q}%")->limit($limit)->get();
        return $this->version(response()->json(['products' => $rows->map(fn ($p) => ModelMap::toProduct($p, $request->getHost()))->values()->all()]));
    }

    public function locations(Request $request): JsonResponse
    {
        $locationClass = config('chattrn.models.location');
        if (! $locationClass || ! class_exists($locationClass)) {
            // No location model: a single default "outlet" location, so outlet-mode stores
            // still answer /locations.json (devspec.txt's delivery_mode: outlet).
            return $this->version(response()->json(['locations' => [[
                'id' => 1, 'name' => config('chattrn.store.name'), 'country_code' => config('chattrn.store.country_code'), 'active' => true,
            ]]]));
        }
        $rows = $locationClass::query()->get();
        return $this->version(response()->json(['locations' => $rows->map(fn ($l) => [
            'id' => $l->getKey(), 'name' => $l->name ?? (string) $l->getKey(), 'active' => true,
        ])->values()->all()]));
    }

    public function inventoryLevels(Request $request): JsonResponse
    {
        $variantClass = ModelMap::variantModelClass();
        if (! $variantClass || ! class_exists($variantClass)) {
            return $this->version(response()->json(['inventory_levels' => []]));
        }
        $itemIds = array_filter(explode(',', (string) $request->query('inventory_item_ids', '')));
        if (! $itemIds) {
            return $this->version(response()->json(['errors' => ['inventory_item_ids' => ['or location_ids is required']]], 422));
        }
        $stockCol = config('chattrn.columns.variant.stock', 'stock');
        $rows = $variantClass::query()->whereKey($itemIds)->get();
        return $this->version(response()->json(['inventory_levels' => $rows->map(fn ($v) => [
            'inventory_item_id' => $v->getKey(), 'location_id' => 1, 'available' => $v->{$stockCol} ?? null,
            'updated_at' => optional($v->updated_at)->toIso8601String(),
        ])->values()->all()]));
    }

    public function locationsResolve(Request $request): JsonResponse
    {
        // No general address-to-location resolver without knowing the merchant's area data
        // shape; a zone/outlet store with one location is always "serviceable".
        $area = (string) $request->query('area', '');
        return $this->version(response()->json(['resolution' => [
            'query' => $area, 'matches' => [['location_id' => 1, 'name' => config('chattrn.store.name'), 'confidence' => 0.5]], 'serviceable' => true,
        ]]));
    }

    public function customersSearch(Request $request): JsonResponse
    {
        $class = ModelMap::requireModel(ModelMap::customerModelClass(), 'Customer');
        $query = (string) $request->query('query', '');
        [$field, $value] = str_starts_with($query, 'phone:') ? ['phone', substr($query, 6)] : ['email', substr($query, 6)];
        $col = config("chattrn.columns.customer.{$field}", $field);

        $rows = $class::query()->where($col, $value)->get();
        return $this->version(response()->json(['customers' => $rows->map(fn ($c) => ModelMap::toCustomer($c))->values()->all()]));
    }

    public function customerOrders(Request $request, string $id): JsonResponse
    {
        $class = ModelMap::requireModel(ModelMap::orderModelClass(), 'Order');
        $rows = $class::query()->where('customer_id', $id)->get();
        return $this->version(response()->json(['orders' => $rows->map(fn ($o) => ModelMap::toOrder($o))->values()->all()]));
    }

    public function orders(Request $request): JsonResponse
    {
        $class = ModelMap::requireModel(ModelMap::orderModelClass(), 'Order');
        $name = $request->query('name');
        $numberCol = config('chattrn.columns.order.number', 'number');
        $query = $class::query();
        if ($name) {
            $query->where($numberCol, ltrim((string) $name, '#'));
        }
        return $this->version(response()->json(['orders' => $query->get()->map(fn ($o) => ModelMap::toOrder($o))->values()->all()]));
    }

    public function order(Request $request, string $id): JsonResponse
    {
        $class = ModelMap::requireModel(ModelMap::orderModelClass(), 'Order');
        $order = $class::query()->find($id);
        if (! $order) {
            return $this->version(response()->json(['errors' => 'Not Found'], 404));
        }
        return $this->version(response()->json(['order' => ModelMap::toOrder($order)]));
    }

    public function orderFulfillments(Request $request, string $id): JsonResponse
    {
        $class = ModelMap::requireModel(ModelMap::orderModelClass(), 'Order');
        $order = $class::query()->find($id);
        if (! $order) {
            return $this->version(response()->json(['errors' => 'Not Found'], 404));
        }
        return $this->version(response()->json(['fulfillments' => []]));
    }

    public function cancelOrder(Request $request, string $id): JsonResponse
    {
        $class = ModelMap::requireModel(ModelMap::orderModelClass(), 'Order');
        $order = $class::query()->find($id);
        if (! $order) {
            return $this->version(response()->json(['errors' => 'Not Found'], 404));
        }
        if (in_array('cancelled_at', $order->getFillable()) || array_key_exists('cancelled_at', $order->getAttributes())) {
            $order->cancelled_at = now();
            $order->save();
        }
        $out = ModelMap::toOrder($order);
        $out['cancelled_at'] = now()->toIso8601String();
        $out['cancel_reason'] = 'customer';
        return $this->version(response()->json(['order' => $out]));
    }

    // Cart quote (devspec.txt's Test connection check of the same name): a draft order isn't
    // persisted anywhere in the merchant's schema, so this quotes totals in memory and hands
    // back an id only this process recognises. Good enough for Chattrn's pre-checkout price
    // and stock quote; createOrder/complete still needs the merchant's real checkout flow.
    public function createDraftOrder(Request $request): JsonResponse
    {
        $items = (array) $request->input('draft_order.line_items', []);
        $subtotal = array_reduce($items, fn ($sum, $li) => $sum + ((float) ($li['price'] ?? 0) * (int) ($li['quantity'] ?? 1)), 0.0);

        return $this->version(response()->json(['draft_order' => [
            'id' => random_int(100000, 999999), 'line_items' => $items,
            'subtotal_price' => number_format($subtotal, 2, '.', ''), 'total_tax' => '0.00',
            'total_price' => number_format($subtotal, 2, '.', ''), 'currency' => config('chattrn.store.currency'),
            'status' => 'open',
        ]], 201));
    }

    public function updateDraftOrder(Request $request, string $id): JsonResponse
    {
        $items = (array) $request->input('draft_order.line_items', []);
        $subtotal = array_reduce($items, fn ($sum, $li) => $sum + ((float) ($li['price'] ?? 0) * (int) ($li['quantity'] ?? 1)), 0.0);

        return $this->version(response()->json(['draft_order' => [
            'id' => (int) $id, 'line_items' => $items,
            'subtotal_price' => number_format($subtotal, 2, '.', ''), 'total_tax' => '0.00',
            'total_price' => number_format($subtotal, 2, '.', ''), 'currency' => config('chattrn.store.currency'),
            'status' => 'open',
        ]]));
    }

    public function completeDraftOrder(Request $request, string $id): JsonResponse
    {
        // Without a real checkout integration there is no order to point at; callers should
        // treat Draft order complete as "not supported" until the merchant wires up create.
        return $this->version(response()->json(['errors' => 'Not Found'], 404));
    }
}
