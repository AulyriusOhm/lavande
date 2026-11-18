import {
  Archive,
  CheckCheck,
  Mail as MailIcon,
  MailOpen,
  RotateCcw,
  Star,
  Trash2,
  X,
  type LucideIcon,
} from "lucide-react";
import type { FolderId, Mail } from "@/lib/mail";
import type { BulkKind } from "@/lib/store";
import { cn } from "@/lib/utils";
import { BlurFade } from "@/components/ui/blur-fade";
import { NumberTicker } from "@/components/ui/number-ticker";

const BUTTON =
  "focus-ring inline-flex h-8 shrink-0 items-center gap-1.5 rounded-full px-2.5 text-[11.5px] font-bold transition-colors duration-200";
const SOFT = cn(BUTTON, "text-canvas/75 hover:bg-canvas/15 hover:text-canvas");
const DANGER = cn(BUTTON, "bg-rose-500 text-white hover:bg-rose-600");

type SelectionAction = { label: string; icon: LucideIcon; kind: BulkKind };

export function SelectionBar({
  count,
  mails,
  folder,
  allSelected,
  onAction,
  onSelectAll,
  onClear,
}: {
  count: number;
  mails: Mail[];
  folder: FolderId;
  allSelected: boolean;
  onAction: (kind: BulkKind) => void;
  onSelectAll: () => void;
  onClear: () => void;
}) {
  const restoring = folder === "trash" || folder === "archive";
  const actions: SelectionAction[] = [
    mails.some((mail) => mail.unread)
      ? { label: "Marquer lu", icon: MailOpen, kind: "read" }
      : { label: "Marquer non lu", icon: MailIcon, kind: "unread" },
    mails.every((mail) => mail.starred)
      ? { label: "Retirer les étoiles", icon: Star, kind: "unstar" }
      : { label: "Étoiler", icon: Star, kind: "star" },
    restoring
      ? { label: "Restaurer", icon: RotateCcw, kind: "restore" }
      : { label: "Archiver", icon: Archive, kind: "archive" },
    {
      label: folder === "trash" ? "Supprimer définitivement" : "Corbeille",
      icon: Trash2,
      kind: "delete",
    },
  ];

  return (
    <div className="pointer-events-none absolute inset-x-0 bottom-4 z-20 flex justify-center px-4">
      <BlurFade yOffset={16} className="pointer-events-auto max-w-full">
        <div
          role="toolbar"
          aria-label="Sélection multiple"
          className="flex max-w-full items-center gap-1 rounded-full bg-ink py-1.5 pr-1.5 pl-4 text-canvas shadow-[0_20px_45px_-18px_rgba(0,0,0,0.55)]"
        >
          <span className="flex shrink-0 items-baseline gap-1 text-[11.5px] font-bold whitespace-nowrap">
            <NumberTicker value={count} className="text-[13px]" />
            <span>{count > 1 ? "sélectionnés" : "sélectionné"}</span>
          </span>
          <span aria-hidden className="mx-1 h-5 w-px shrink-0 bg-canvas/20" />

          {actions.map((action) => (
            <button
              key={action.label}
              type="button"
              onClick={() => onAction(action.kind)}
              aria-label={action.label}
              title={action.label}
              className={action.kind === "delete" ? DANGER : SOFT}
            >
              <action.icon className="size-3.5" />
              <span className="hidden xl:inline">{action.label}</span>
            </button>
          ))}

          {allSelected ? null : (
            <button
              type="button"
              onClick={onSelectAll}
              aria-label="Tout sélectionner"
              title="Tout sélectionner"
              className={SOFT}
            >
              <CheckCheck className="size-3.5" />
              <span className="hidden xl:inline">Tout</span>
            </button>
          )}

          <button
            type="button"
            onClick={onClear}
            aria-label="Annuler la sélection"
            title="Annuler la sélection"
            className={SOFT}
          >
            <X className="size-4" />
          </button>
        </div>
      </BlurFade>
    </div>
  );
}
