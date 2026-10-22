<?php

namespace Chattrn\Connector\Support;

// Rewrites config/chattrn.php's models/columns after `php artisan chattrn:map`. Regenerates
// the whole file from the merged array rather than patching text, so it stays valid PHP
// however the merchant has it indented - the trade-off (devspec.txt doesn't prescribe a
// format) is that hand-written comments in that file are lost on a re-run.
class ConfigWriter
{
    public static function write(string $path, array $config): bool
    {
        $export = var_export($config, true);
        $contents = "<?php\n\n// Rewritten by `php artisan chattrn:map`. See vendor/chattrn/connector/config/chattrn.php\n// for what each key means.\nreturn {$export};\n";

        return @file_put_contents($path, $contents) !== false;
    }
}
