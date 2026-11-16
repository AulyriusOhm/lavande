import { useMemo, useState } from "react";
import { applyFolderOrder, buildFolderTree, type FolderTreeNode, type FolderTreeSpec } from "@/lib/folder-tree";

export type FolderTreeRow<T extends FolderTreeSpec> = {
  node: FolderTreeNode<T>;
  depth: number;
  parentPath: string | null;
  expanded: boolean;
  hasChildren: boolean;
  toggle: () => void;
};

const NO_ORDER: string[] = [];

/** L'arbre aplati dans l'ordre d'affichage : les paliers repliés gardent leurs enfants cachés. */
export function useFolderTree<T extends FolderTreeSpec>(
  items: T[],
  order: string[] = NO_ORDER,
): FolderTreeRow<T>[] {
  const [collapsed, setCollapsed] = useState<string[]>([]);

  return useMemo(() => {
    const rows: FolderTreeRow<T>[] = [];
    const walk = (nodes: FolderTreeNode<T>[], depth: number, parentPath: string | null) => {
      for (const node of nodes) {
        const expanded = !collapsed.includes(node.path);
        const hasChildren = node.children.length > 0;
        rows.push({
          node,
          depth,
          parentPath,
          expanded,
          hasChildren,
          toggle: () =>
            setCollapsed((current) =>
              current.includes(node.path)
                ? current.filter((path) => path !== node.path)
                : [...current, node.path],
            ),
        });
        if (hasChildren && expanded) walk(node.children, depth + 1, node.path);
      }
    };
    walk(applyFolderOrder(buildFolderTree(items), order), 0, null);
    return rows;
  }, [items, order, collapsed]);
}
