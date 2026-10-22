<?php

namespace Chattrn\Connector\Console\Commands;

use Illuminate\Console\Command;
use Chattrn\Connector\Support\ChattrnRegistrar;
use Chattrn\Connector\Support\ConfigWriter;

// devspec.txt: "php artisan chattrn:map asks in the terminal which models are Product,
// Variant, Order and Customer, and which columns hold price and stock, then writes
// config/chattrn.php." Also registers with Chattrn on first run, since the register call
// needs to know which models matched (devspec.txt: "package_installs (..., models_matched
// JSON, ...)").
class MapCommand extends Command
{
    protected $signature = 'chattrn:map';
    protected $description = 'Map your Eloquent models to the Chattrn API, then register with Chattrn';

    public function handle(): int
    {
        $config = require config_path('chattrn.php');

        $config['models']['product'] = $this->askModel('Product', $config['models']['product']);
        $config['models']['variant'] = $this->askModel('Variant (blank if products have no variants)', $config['models']['variant'], true);
        $config['models']['order'] = $this->askModel('Order', $config['models']['order']);
        $config['models']['customer'] = $this->askModel('Customer (blank if orders carry phone/email directly)', $config['models']['customer'], true);

        $config['columns']['variant']['price'] = $this->ask('Column that holds price on the ' . ($config['models']['variant'] ?: 'Product') . ' model', $config['columns']['variant']['price'] ?? 'price');
        $config['columns']['variant']['stock'] = $this->ask('Column that holds stock on the ' . ($config['models']['variant'] ?: 'Product') . ' model', $config['columns']['variant']['stock'] ?? 'stock');
        $config['columns']['order']['total'] = $this->ask('Column that holds the order total', $config['columns']['order']['total'] ?? 'total');

        if (! ConfigWriter::write(config_path('chattrn.php'), $config)) {
            $this->error('Could not write config/chattrn.php - check it is writable.');
            return self::FAILURE;
        }
        $this->info('config/chattrn.php updated.');

        // Pick up the freshly written config for this process before registering.
        config(['chattrn' => $config]);

        $token = $config['connection_token'] ?? env('CHATTRN_TOKEN');
        if (! $token) {
            $this->warn('No CHATTRN_TOKEN found in .env, so I could not register with Chattrn yet. Paste it in and re-run chattrn:map.');
            return self::SUCCESS;
        }
        if (config('chattrn.access_token')) {
            $this->info('Already registered (CHATTRN_ACCESS_TOKEN is set). Delete it from .env and re-run to re-register.');
            return self::SUCCESS;
        }

        $this->line('Registering with Chattrn...');
        $result = ChattrnRegistrar::register($token);
        if (! $result['ok']) {
            $this->error('Register failed: ' . $result['message']);
            return self::FAILURE;
        }

        $this->info('Registered. Add this to .env, then remove the CHATTRN_TOKEN line:');
        $this->line('  CHATTRN_ACCESS_TOKEN=' . $result['access_token']);

        return self::SUCCESS;
    }

    private function askModel(string $label, ?string $current, bool $optional = false): ?string
    {
        $answer = $this->ask("Fully-qualified class for {$label}" . ($optional ? '' : ''), $current);
        $answer = $answer ? trim($answer) : null;
        if ($answer && ! class_exists($answer)) {
            $this->warn("{$answer} doesn't exist yet - saving it anyway; fix it in config/chattrn.php if that was a typo.");
        }
        return $answer ?: null;
    }
}
