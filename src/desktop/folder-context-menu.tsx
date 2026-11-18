import { useEffect, useState } from "react";
import { FolderOpen, Inbox, MailOpen, RefreshCw, Trash2 } from "lucide-react";
import type { FolderOption } from "@/lib/mail-backend";
import { useMailStore } from "@/lib/store";
import { AnchoredMenu, MenuItem, type MenuAction } from "@/components/anchored-menu";

const ARM_WINDOW_MS = 5000;

export function FolderContextMenu({
  entry,
  ancre,
  onClose,
}: {
  entry: FolderOption;
  ancre: { x: number; y: number };
  onClose: () => void;
}) {
  const {
    setFolder,
    syncFolderAt,
    emptyTrash,
    bulkMailAction,
    mode,
    readOnly,
    folder,
    folderPath,
    mails,
    folderStats,
  } = useMailStore();
  const [armed, setArmed] = useState(false);

  useEffect(() => {
    if (!armed) return;
    const timer = window.setTimeout(() => setArmed(false), ARM_WINDOW_MS);
    return () => window.clearTimeout(timer);
  }, [armed]);

  const path = entry.id === "other" ? entry.path : null;
  const active = folder === entry.id && (entry.id !== "other" || folderPath === entry.path);
  const unread = folderStats(entry.id, entry.path).unread;
  const trashCount = folderStats("trash").total;

  const actions: MenuAction[] = [
    {
      label: "Ouvrir",
      icon: entry.id === "inbox" ? Inbox : FolderOpen,
      run: () => {
        setFolder(entry.id, path);
        onClose();
      },
    },
  ];

  if (mode === "api" && !readOnly) {
    actions.push({
      label: "Synchroniser ce dossier",
      icon: RefreshCw,
      run: () => {
        syncFolderAt(entry.id, path);
        onClose();
      },
    });
  }

  if (active && unread > 0) {
    actions.push({
      label: "Marquer tout lu",
      icon: MailOpen,
      run: () => {
        bulkMailAction("read", mails.filter((mail) => mail.unread));
        onClose();
      },
    });
  }

  if (entry.id === "trash" && trashCount > 0) {
    actions.push({
      label: armed
        ? `Confirmer · ${trashCount} message${trashCount > 1 ? "s" : ""}`
        : "Vider la corbeille",
      icon: Trash2,
      danger: true,
      run: () => {
        if (!armed) {
          setArmed(true);
          return;
        }
        setArmed(false);
        emptyTrash();
        onClose();
      },
    });
  }

  return (
    <AnchoredMenu ancre={ancre} onClose={onClose} label="Actions du dossier">
      {actions.map((action, index) => (
        <MenuItem key={index} action={action} compact />
      ))}
    </AnchoredMenu>
  );
}
