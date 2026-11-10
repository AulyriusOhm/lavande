<?php
require_once("config.inc");
require_once("util.inc");

$aliasname = 'RESEAUX_INTERNES';
$prefix = 'INTERNE ANY (temporaire, log)';

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
    write_config("INTERNE ANY : flux internes en " . $added . " regles + log (temporaire)");
}

echo "rules_added=" . $added . " interfaces=" . implode(",", $interfaces) . "\n";
?>
