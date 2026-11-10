<?php
require_once("config.inc");
require_once("util.inc");

$aliasname = 'RESEAUX_INTERNES';
$prefix = 'INTERNE ANY (temporaire, log)';

if (!is_array($config['aliases']['alias'])) {
    $config['aliases']['alias'] = array();
}

$alias_exists = false;
foreach ($config['aliases']['alias'] as $alias) {
    if (isset($alias['name']) && $alias['name'] === $aliasname) {
        $alias_exists = true;
        break;
    }
}

if (!$alias_exists) {
    $config['aliases']['alias'][] = array(
        'name' => $aliasname,
        'type' => 'networkgroup',
        'address' => '10.0.0.0/8 172.16.0.0/12 192.168.0.0/16',
        'descr' => 'Tous les reseaux internes (zones 10.x, LAN des deux sites, docker)',
    );
}

$interfaces = array();
foreach ($config['interfaces'] as $key => $iface) {
    if (!is_array($iface) || !isset($iface['if'])) {
        continue;
    }
    if ($iface['if'] === 'lo0') {
        continue;
    }
    $interfaces[] = $key;
}
if (!in_array('wireguard', $interfaces, true)) {
    $interfaces[] = 'wireguard';
}

$protos = array('tcp', 'udp', 'icmp');
$added = 0;

foreach ($interfaces as $iface) {
    foreach ($protos as $proto) {
        $descr = $prefix . ' : ' . $iface . ' ' . $proto;
        $exists = false;
        foreach ($config['filter']['rule'] as $rule) {
            if (isset($rule['descr']) && $rule['descr'] === $descr) {
                $exists = true;
                break;
            }
        }
        if ($exists) {
            continue;
        }
        array_unshift($config['filter']['rule'], array(
            'type' => 'pass',
            'interface' => $iface,
            'ipprotocol' => 'inet',
            'protocol' => $proto,
            'source' => array('network' => $aliasname),
            'destination' => array('network' => $aliasname),
            'descr' => $descr,
            'log' => '1',
            'disablereplyto' => '1',
        ));
        $added++;
    }
}

if ($added > 0) {
    write_config("INTERNE ANY : flux internes en any + log (temporaire)");
}

echo "rules_added=" . $added . " interfaces=" . implode(",", $interfaces) . "\n";
?>
