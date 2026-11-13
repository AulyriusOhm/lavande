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
