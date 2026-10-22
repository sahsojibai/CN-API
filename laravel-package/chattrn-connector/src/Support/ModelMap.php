<?php

namespace Chattrn\Connector\Support;

use Illuminate\Database\Eloquent\Model;
use RuntimeException;

// Turns the merchant's own Eloquent models into the canonical Chattrn shapes (the same
// Shopify-shaped resources the Node mock in chattrn-backend/src/mock-chattrn-store.js
// returns), using the model classes and column overrides `php artisan chattrn:map` wrote
// into config/chattrn.php. Deliberately plain array building, not API Resources per model,
// so one place holds the "what does a Product look like" contract.
class ModelMap
{
    public static function productModelClass(): ?string
    {
        return config('chattrn.models.product');
    }

    public static function orderModelClass(): ?string
    {
        return config('chattrn.models.order');
    }

    public static function customerModelClass(): ?string
    {
        return config('chattrn.models.customer');
    }

    public static function variantModelClass(): ?string
    {
        return config('chattrn.models.variant');
    }

    public static function requireModel(?string $class, string $label): string
    {
        if (! $class || ! class_exists($class)) {
            throw new RuntimeException("No {$label} model is configured. Run `php artisan chattrn:map`.");
        }

        return $class;
    }

    private static function col(string $resource, string $field, string $default): string
    {
        return config("chattrn.columns.{$resource}.{$field}") ?: $default;
    }

    private static function get(Model $model, string $column, $default = null)
    {
        return $column && isset($model->{$column}) ? $model->{$column} : $default;
    }

    // ---- Product / Variant ----

    public static function toProduct(Model $product, string $host): array
    {
        $variants = self::variantsOf($product);

        return [
            'id' => $product->getKey(),
            'title' => self::get($product, self::col('product', 'title', 'title')),
            'handle' => self::get($product, self::col('product', 'handle', 'slug')),
            'body_html' => self::get($product, self::col('product', 'description', 'description')),
            'vendor' => self::get($product, self::col('product', 'vendor', 'vendor')),
            'product_type' => self::get($product, self::col('product', 'product_type', 'category')),
            'status' => self::get($product, self::col('product', 'status', 'status'), 'active'),
            'tags' => self::get($product, self::col('product', 'tags', 'tags'), ''),
            'created_at' => optional($product->created_at)->toIso8601String(),
            'updated_at' => optional($product->updated_at)->toIso8601String(),
            'options' => [],
            'variants' => $variants->map(fn ($v) => self::toVariant($v, $product))->values()->all(),
            'images' => self::imagesOf($product, $host),
        ];
    }

    public static function toVariant(Model $variant, ?Model $product = null): array
    {
        $priceCol = self::col('variant', 'price', 'price');
        $stockCol = self::col('variant', 'stock', 'stock');

        return [
            'id' => $variant->getKey(),
            'product_id' => $product?->getKey() ?? self::get($variant, 'product_id'),
            'title' => self::get($variant, self::col('variant', 'title', 'title'), 'Default'),
            'option1' => self::get($variant, 'option1'),
            'option2' => self::get($variant, 'option2'),
            'option3' => self::get($variant, 'option3'),
            'price' => self::money(self::get($variant, $priceCol)),
            'compare_at_price' => self::moneyOrNull(self::get($variant, self::col('variant', 'compare_at_price', 'compare_at_price'))),
            'sku' => self::get($variant, self::col('variant', 'sku', 'sku')),
            'barcode' => self::get($variant, 'barcode'),
            'inventory_item_id' => $variant->getKey(),
            'inventory_quantity' => self::get($variant, $stockCol),
            'inventory_management' => self::get($variant, $stockCol) === null ? null : 'chattrn',
            'inventory_policy' => 'deny',
        ];
    }

    // Products without a configured variant model are treated as their own single default
    // variant, reading price/stock straight off the product row.
    private static function variantsOf(Model $product)
    {
        $variantClass = self::variantModelClass();
        if ($variantClass && method_exists($product, 'variants')) {
            $rel = $product->variants();
            return $rel->get();
        }

        return collect([$product]);
    }

    private static function imagesOf(Model $product, string $host): array
    {
        $url = self::get($product, self::col('product', 'image_url', 'image_url'));
        if (! $url) {
            return [];
        }

        return [[
            'id' => $product->getKey(),
            'src' => $url,
            'position' => 1,
            'variant_ids' => [],
        ]];
    }

    private static function money($value): string
    {
        return $value === null ? '0.00' : number_format((float) $value, 2, '.', '');
    }

    private static function moneyOrNull($value): ?string
    {
        return $value === null || $value === '' ? null : self::money($value);
    }

    // ---- Order / Customer ----

    public static function toOrder(Model $order): array
    {
        $lineItems = method_exists($order, 'items') ? $order->items()->get() : collect();

        return [
            'id' => $order->getKey(),
            'name' => '#' . (self::get($order, self::col('order', 'number', 'number')) ?? $order->getKey()),
            'order_number' => self::get($order, self::col('order', 'number', 'number'), $order->getKey()),
            'phone' => self::get($order, self::col('order', 'phone', 'phone')),
            'email' => self::get($order, 'email'),
            'created_at' => optional($order->created_at)->toIso8601String(),
            'currency' => self::get($order, self::col('order', 'currency', 'currency')) ?? config('chattrn.store.currency'),
            'subtotal_price' => self::money(self::get($order, self::col('order', 'total', 'total'))),
            'total_discounts' => '0.00',
            'total_tax' => '0.00',
            'total_price' => self::money(self::get($order, self::col('order', 'total', 'total'))),
            'financial_status' => self::get($order, self::col('order', 'financial_status', 'status')),
            'fulfillment_status' => self::get($order, self::col('order', 'fulfillment_status', 'fulfillment_status')),
            'cancelled_at' => optional($order->cancelled_at ?? null)?->toIso8601String(),
            'cancel_reason' => self::get($order, 'cancel_reason'),
            'payment_gateway_names' => [self::get($order, 'payment_method', 'cod')],
            'line_items' => $lineItems->map(fn ($li) => [
                'id' => $li->getKey(),
                'title' => self::get($li, 'title', 'Item'),
                'quantity' => self::get($li, 'quantity', 1),
                'price' => self::money(self::get($li, 'price', 0)),
                'sku' => self::get($li, 'sku'),
            ])->values()->all(),
            'shipping_lines' => [],
            'fulfillments' => [],
        ];
    }

    public static function toCustomer(Model $customer): array
    {
        return [
            'id' => $customer->getKey(),
            'phone' => self::get($customer, self::col('customer', 'phone', 'phone')),
            'email' => self::get($customer, self::col('customer', 'email', 'email')),
            'first_name' => self::get($customer, 'first_name'),
            'last_name' => self::get($customer, 'last_name'),
        ];
    }
}
