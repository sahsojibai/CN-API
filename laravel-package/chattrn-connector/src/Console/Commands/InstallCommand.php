<?php

namespace Chattrn\Connector\Console\Commands;

use Illuminate\Console\Command;

// devspec.txt: "php artisan chattrn:install creates config/chattrn.php and the routes."
// The routes are already registered by ChattrnServiceProvider once the package is required;
// this command's job is publishing the editable config and pointing the merchant at
// `chattrn:map` next.
class InstallCommand extends Command
{
    protected $signature = 'chattrn:install';
    protected $description = 'Publish config/chattrn.php and register the Chattrn API routes';

    public function handle(): int
    {
        $this->call('vendor:publish', ['--tag' => 'chattrn-config']);

        $prefix = config('chattrn.route_prefix');
        $this->info("Routes registered under {$prefix} (e.g. {$prefix}/store.json).");
        $this->line('');
        $this->line('Next:');
        $this->line('  1. Paste the CHATTRN_TOKEN line from the Install package screen into .env.');
        $this->line('  2. Run: php artisan chattrn:map');

        return self::SUCCESS;
    }
}
