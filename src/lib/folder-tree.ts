/** Un dossier réduit à ce qu'il faut pour le ranger : son chemin complet et le délimiteur du serveur. */
export type FolderTreeSpec = {
  path: string;
  delimiter?: string | null;
};

export type FolderTreeNode<T extends FolderTreeSpec> = {
  path: string;
  name: string;
  /** `null` : palier intermédiaire absent de la liste du serveur, non sélectionnable. */
  item: T | null;
  children: FolderTreeNode<T>[];
};

const CANDIDATES = ["/", "."];

export function detectDelimiter(paths: string[]): string | null {
  let found: string | null = null;
  let score = 0;
  for (const candidate of CANDIDATES) {
    const count = paths.filter((path) => path.includes(candidate)).length;
    if (count > score) {
      found = candidate;
      score = count;
    }
  }
  return found;
}

export function buildFolderTree<T extends FolderTreeSpec>(items: T[]): FolderTreeNode<T>[] {
  const declared = items.find((item) => item.delimiter)?.delimiter ?? null;
  const delimiter = declared ?? detectDelimiter(items.map((item) => item.path));
  const known = new Map(items.map((item) => [item.path, item]));
  const nodes = new Map<string, FolderTreeNode<T>>();
  const roots: FolderTreeNode<T>[] = [];

  const split = (path: string): { parent: string; name: string } => {
    const index = delimiter ? path.lastIndexOf(delimiter) : -1;
    if (!delimiter || index < 0) return { parent: "", name: path };
    return { parent: path.slice(0, index), name: path.slice(index + delimiter.length) };
  };

  const ensure = (path: string): FolderTreeNode<T> => {
    const existing = nodes.get(path);
    if (existing) return existing;
    const node: FolderTreeNode<T> = {
      path,
      name: split(path).name,
      item: known.get(path) ?? null,
      children: [],
    };
    nodes.set(path, node);
    const parent = split(path).parent;
    if (parent) ensure(parent).children.push(node);
    else roots.push(node);
    return node;
  };

  for (const item of items) ensure(item.path);
  return roots;
}

export function descendantPaths<T extends FolderTreeSpec>(node: FolderTreeNode<T>): string[] {
  return node.children.flatMap((child) => [child.path, ...descendantPaths(child)]);
}

/**
 * Ordre d'affichage local : à chaque niveau, les chemins connus passent devant
 * dans l'ordre voulu, les nouveaux dossiers gardent l'ordre du serveur derrière.
 */
export function applyFolderOrder<T extends FolderTreeSpec>(
  nodes: FolderTreeNode<T>[],
  order: string[],
): FolderTreeNode<T>[] {
  if (order.length === 0) return nodes;
  const rank = new Map(order.map((path, index) => [path, index]));
  const placed = (path: string) => rank.get(path) ?? Number.MAX_SAFE_INTEGER;
  return nodes
    .map((node) => ({ ...node, children: applyFolderOrder(node.children, order) }))
    .sort((a, b) => placed(a.path) - placed(b.path));
}

/**
 * Déplace un chemin parmi ses frères : le niveau réordonné passe en tête de
 * l'ordre du compte, les autres niveaux gardent leur ordre relatif.
 */
export function moveFolderPath(
  order: string[],
  siblings: string[],
  path: string,
  target: string,
  after: boolean,
): string[] {
  const rest = siblings.filter((entry) => entry !== path);
  const index = rest.indexOf(target);
  if (index < 0) return order;
  const at = index + (after ? 1 : 0);
  const level = [...rest.slice(0, at), path, ...rest.slice(at)];
  return [...level, ...order.filter((entry) => !level.includes(entry))];
}
