<?php

namespace Chattrn\Connector\Tests;

use Orchestra\Testbench\TestCase;
use Illuminate\Support\Facades\Schema;
use Illuminate\Database\Schema\Blueprint;
use Chattrn\Connector\ChattrnServiceProvider;
use Chattrn\Connector\Tests\Fixtures\Product;
use Chattrn\Connector\Tests\Fixtures\Order;

// A starting Testbench suite for this package. Not run in the sandbox this package was
// written in (see README.md "Testing this package" - no Packagist/GitHub access there);
// run `composer require --dev orchestra/testbench phpunit/phpunit && vendor/bin/phpunit`
// somewhere with normal network access first.
class ChattrnApiTest extends TestCase
{
    protected function getPackageProviders($app)
    {
        return [ChattrnServiceProvider::class];
    }

    protected function defineEnvironment($app)
    {
        $app['config']->set('chattrn.access_token', 'test-token');
        $app['config']->set('chattrn.models.product', Product::class);
        $app['config']->set('chattrn.models.order', Order::class);
        $app['config']->set('chattrn.store.currency', 'BDT');
        $app['config']->set('chattrn.store.country_code', 'BD');
    }

    protected function setUp(): void
    {
        parent::setUp();

        Schema::create('products', function (Blueprint $t) {
            $t->id();
            $t->string('title');
            $t->string('slug')->nullable();
            $t->decimal('price', 10, 2);
            $t->integer('stock')->nullable();
            $t->timestamps();
        });
        Schema::create('orders', function (Blueprint $t) {
            $t->id();
            $t->string('number')->nullable();
            $t->string('phone')->nullable();
            $t->decimal('total', 10, 2)->default(0);
            $t->string('status')->nullable();
            $t->timestamp('cancelled_at')->nullable();
            $t->timestamps();
        });

        Product::create(['title' => 'Phone A', 'slug' => 'phone-a', 'price' => '19990.00', 'stock' => 10]);
        Product::create(['title' => 'Phone B', 'slug' => 'phone-b', 'price' => '9990.00', 'stock' => 0]);
        Order::create(['number' => '1001', 'phone' => '+8801700000000', 'total' => '19990.00', 'status' => 'paid']);
    }

    private function headers(): array
    {
        return ['X-Chattrn-Access-Token' => 'test-token'];
    }

    public function test_store_profile_responds(): void
    {
        $this->withHeaders($this->headers())->get('/chattrn/api/2026-10/store.json')
            ->assertOk()
            ->assertJsonPath('store.api_version', '2026-10')
            ->assertJsonPath('store.currency', 'BDT')
            ->assertJsonPath('store.capabilities.products', true);
    }

    public function test_wrong_token_is_refused(): void
    {
        $this->get('/chattrn/api/2026-10/store.json')->assertStatus(401)
            ->assertJsonPath('errors', 'Invalid access token');

        $this->withHeaders(['X-Chattrn-Access-Token' => 'wrong'])
            ->get('/chattrn/api/2026-10/store.json')->assertStatus(401);
    }

    public function test_products_list_and_detail(): void
    {
        $this->withHeaders($this->headers())->get('/chattrn/api/2026-10/products.json')
            ->assertOk()
            ->assertJsonCount(2, 'products')
            ->assertJsonPath('products.0.title', 'Phone A')
            ->assertJsonPath('products.0.variants.0.price', '19990.00');

        $id = Product::where('title', 'Phone A')->first()->id;
        $this->withHeaders($this->headers())->get("/chattrn/api/2026-10/products/{$id}.json")
            ->assertOk()
            ->assertJsonPath('product.handle', 'phone-a');
    }

    public function test_products_count(): void
    {
        $this->withHeaders($this->headers())->get('/chattrn/api/2026-10/products/count.json')
            ->assertOk()->assertJsonPath('count', 2);
    }

    public function test_product_search(): void
    {
        $this->withHeaders($this->headers())->get('/chattrn/api/2026-10/products/search.json?q=Phone A')
            ->assertOk()->assertJsonCount(1, 'products');
    }

    public function test_missing_product_is_404(): void
    {
        $this->withHeaders($this->headers())->get('/chattrn/api/2026-10/products/999999.json')
            ->assertStatus(404)->assertJsonPath('errors', 'Not Found');
    }

    public function test_orders_list_and_lookup_by_name(): void
    {
        $this->withHeaders($this->headers())->get('/chattrn/api/2026-10/orders.json?name=%231001')
            ->assertOk()->assertJsonCount(1, 'orders')
            ->assertJsonPath('orders.0.financial_status', 'paid');
    }

    public function test_cancel_order(): void
    {
        $id = Order::first()->id;
        $this->withHeaders($this->headers())->post("/chattrn/api/2026-10/orders/{$id}/cancel.json")
            ->assertOk()->assertJsonPath('order.cancel_reason', 'customer');
    }

    public function test_cart_quote_computes_totals(): void
    {
        $this->withHeaders($this->headers())->postJson('/chattrn/api/2026-10/draft_orders.json', [
            'draft_order' => ['line_items' => [['price' => '100.00', 'quantity' => 2]]],
        ])->assertStatus(201)->assertJsonPath('draft_order.subtotal_price', '200.00');
    }
}
