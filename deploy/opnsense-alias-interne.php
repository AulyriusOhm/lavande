<?php
require_once("config.inc");
require_once("util.inc");

$name = 'RESEAUX_INTERNES';

$mdl = new \OPNsense\Firewall\Alias();
$node = $mdl->getNodeByReference('aliases.alias');
if ($node === null) {
    echo "ERREUR: noeud aliases.alias introuvable\n";
    exit(1);
}

$exists = false;
foreach ($node->iterateItems() as $item) {
    if ((string)$item->name === $name) {
        $exists = true;
        break;
    }
}

if (!$exists) {
    $item = $node->add();
    $item->enabled = '1';
    $item->name = $name;
    $item->type = 'network';
    $item->content = "10.0.0.0/8\n172.16.0.0/12\n192.168.0.0/16";
    $mdl->serializeToConfig();
    \OPNsense\Core\Config::getInstance()->save();
    echo "alias_cree\n";
} else {
    echo "alias_deja_present\n";
}

$check = new \OPNsense\Firewall\Alias();
$names = array();
foreach ($check->aliasIterator() as $alias) {
    $names[] = $alias['name'] . '(' . $alias['type'] . ')';
}
echo "aliasIterator=" . implode(",", $names) . "\n";
?>
