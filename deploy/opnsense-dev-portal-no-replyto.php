<?php
require_once("config.inc");
require_once("util.inc");

$needle = 'dev-portal (plasma.int.lanro.eu)';
$updated = 0;

foreach ($config['filter']['rule'] as $index => $rule) {
    if (!isset($rule['descr']) || strpos($rule['descr'], $needle) !== 0) {
        continue;
    }
    if (!isset($rule['disablereplyto'])) {
        $config['filter']['rule'][$index]['disablereplyto'] = '1';
        $updated++;
    }
}

if ($updated > 0) {
    write_config("dev-portal : reply-to desactive (retour via route statique 192.168.1.200)");
}

echo "rules_updated=" . $updated . "\n";
?>
