<?php
require_once("config.inc");
require_once("util.inc");

if (!is_array($config['filter']['rule'])) {
    $config['filter']['rule'] = array();
}

$rules = array(
    array(
        'type' => 'pass',
        'interface' => 'lan',
        'ipprotocol' => 'inet',
        'protocol' => 'tcp',
        'source' => array('network' => '192.168.5.0/24'),
        'destination' => array('network' => '10.1.50.10', 'port' => '8443'),
        'descr' => 'dev-portal (plasma.int.lanro.eu) : LAN GN -> plasmaSRV:8443',
        'log' => '1',
    ),
    array(
        'type' => 'pass',
        'interface' => 'wireguard',
        'ipprotocol' => 'inet',
        'protocol' => 'tcp',
        'source' => array('network' => '192.168.5.0/24'),
        'destination' => array('network' => '10.1.50.10', 'port' => '8443'),
        'descr' => 'dev-portal (plasma.int.lanro.eu) : WG -> plasmaSRV:8443',
        'log' => '1',
    ),
);

$added = 0;
foreach ($rules as $rule) {
    $exists = false;
    foreach ($config['filter']['rule'] as $existing) {
        if (isset($existing['descr']) && $existing['descr'] === $rule['descr']) {
            $exists = true;
            break;
        }
    }
    if (!$exists) {
        $config['filter']['rule'][] = $rule;
        $added++;
    }
}

if ($added > 0) {
    write_config("dev-portal Lavande : TCP 8443 depuis 192.168.5.0/24 vers plasmaSRV");
}

echo "rules_added=" . $added . "\n";
?>
