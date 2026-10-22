<?php

namespace Chattrn\Connector;

use Illuminate\Support\ServiceProvider;
use Chattrn\Connector\Console\Commands\InstallCommand;
use Chattrn\Connector\Console\Commands\MapCommand;
use Chattrn\Connector\Console\Commands\CheckCommand;

class ChattrnServiceProvider extends ServiceProvider
{
    public function register(): void
    {
        $this->mergeConfigFrom(__DIR__ . '/../config/chattrn.php', 'chattrn');
    }

    public function boot(): void
    {
        $this->loadRoutesFrom(__DIR__ . '/../routes/chattrn.php');

        if ($this->app->runningInConsole()) {
            $this->publishes([
                __DIR__ . '/../config/chattrn.php' => config_path('chattrn.php'),
            ], 'chattrn-config');

            $this->commands([
                InstallCommand::class,
                MapCommand::class,
                CheckCommand::class,
            ]);
        }
    }
}
