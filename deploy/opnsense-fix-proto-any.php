<?php
require_once("config.inc");
require_once("util.inc");

$fixed = 0;
$touched = array();

foreach ($config['filter']['rule'] as $index => $rule) {
    if (isset($rule['protocol']) && $rule['protocol'] === 'any') {
        $touched[] = (isset($rule['descr']) ? $rule['descr'] : 'sans description') . ' [' . $rule['interface'] . ']';
        $config['filter']['rule'][$index]['protocol'] = 'tcp';
        $fixed++;
    }
}

foreach ($touched as $line) {
    echo "corrige: " . $line . "\n";
}

if ($fixed > 0) {
    write_config("fix: protocol any -> tcp (pf refuse 'proto any', le ruleset entier ne se charge pas)");
}

echo "rules_fixed=" . $fixed . "\n";
?>
