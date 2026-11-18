import { useRef } from "react";
import { motion } from "motion/react";
import {
  Archive,
  CornerUpLeft,
  CornerUpRight,
  Forward,
  Inbox,
  Mail as MailIcon,
  MailOpen,
  PenLine,
  RotateCcw,
  ShieldCheck,
  Star,
  Trash2,
} from "lucide-react";
import { useMailStore } from "@/lib/store";
import { splitAddresses } from "@/lib/mail-backend";
import type { Mail } from "@/lib/mail";
import { useEscapeLayer } from "@/desktop/escape";
import { AnchoredMenu, MenuItem, type MenuAction } from "@/components/anchored-menu";

export function MailContextMenu({
  mail,
  ancre,
  onClose,
}: {
  mail: Mail;
  /** Position du clic droit : sans ancre, le panneau s'affiche en feuille mobile. */
  ancre?: { x: number; y: number };
  onClose: () => void;
}) {
  const {
    openMessage,
    replyTo,
    forwardMail,
    mailAction,
    toggleStar,
    moveToInbox,
    restoreMail,
    resumeDraft,
    accountById,
    readOnly,
  } = useMailStore();
  const sheetRef = useRef<HTMLDivElement>(null);

  const self = accountById(mail.account)?.email.toLowerCase();
  const otherRecipient = splitAddresses(`${mail.to ?? ""} ${mail.cc ?? ""}`).some(
    (address) => address.toLowerCase() !== self,
  );
  const canReplyAll = mail.folder !== "sent" && mail.folder !== "drafts" && otherRecipient;

  const actions: MenuAction[] = [
    { label: "Ouvrir", icon: MailIcon, run: () => openMessage(mail) },
  ];
  if (!readOnly) {
    if (mail.folder === "drafts") {
      actions.push({ label: "Reprendre le brouillon", icon: PenLine, run: () => resumeDraft(mail) });
    } else {
      actions.push({ label: "Répondre", icon: CornerUpLeft, run: () => replyTo(mail) });
      if (canReplyAll) {
        actions.push({
          label: "Répondre à tous",
          icon: CornerUpRight,
          run: () => replyTo(mail, true),
        });
      }
    }
    actions.push({ label: "Transférer", icon: Forward, run: () => forwardMail(mail) });
    actions.push({
      label: mail.unread ? "Marquer lu" : "Marquer non lu",
      icon: mail.unread ? MailOpen : MailIcon,
      run: () => mailAction("read", mail),
    });
    actions.push({
      label: mail.starred ? "Retirer l'étoile" : "Étoiler",
      icon: Star,
      run: () => toggleStar(mail.id),
    });
    if (mail.folder !== "archive" && mail.folder !== "trash") {
      actions.push({ label: "Archiver", icon: Archive, run: () => mailAction("archive", mail) });
    }
    if (mail.folder === "spam") {
      actions.push({ label: "Non spam", icon: ShieldCheck, run: () => moveToInbox(mail) });
    }
    if (mail.folder === "trash") {
      actions.push({ label: "Restaurer", icon: RotateCcw, run: () => restoreMail(mail) });
    }
    if (mail.folder === "archive" || mail.folder === "other") {
      actions.push({
        label: "Déplacer vers la réception",
        icon: Inbox,
        run: () => moveToInbox(mail),
      });
    }
    actions.push(
      mail.folder === "trash"
        ? {
            label: "Supprimer définitivement",
            icon: Trash2,
            danger: true,
            run: () => mailAction("delete", mail),
          }
        : {
            label: "Mettre à la corbeille",
            icon: Trash2,
            danger: true,
            run: () => mailAction("delete", mail),
          },
    );
  }

  useEscapeLayer(!ancre, onClose);

  const onKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    const items = Array.from(
      sheetRef.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]') ?? [],
    );
    if (items.length === 0) return;
    event.preventDefault();
    const index = items.indexOf(document.activeElement as HTMLButtonElement);
    const step = event.key === "ArrowDown" ? 1 : -1;
    items[(index + step + items.length) % items.length]?.focus();
  };

  if (!ancre) {
    return (
      <div className="absolute inset-0 z-40">
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          className="absolute inset-0 bg-ink/25 backdrop-blur-[2px]"
          onClick={onClose}
        />
        <motion.div
          role="dialog"
          aria-modal="true"
          aria-label="Actions du message"
          initial={{ y: "100%" }}
          animate={{ y: 0 }}
          transition={{ type: "spring", stiffness: 320, damping: 32 }}
          className="absolute inset-x-0 bottom-0 max-h-[80%] overflow-hidden rounded-t-[32px] border-t border-line bg-canvas shadow-[0_-20px_60px_-20px_rgba(40,20,80,0.35)]"
        >
          <div className="mx-auto mt-2.5 h-1 w-10 rounded-full bg-line" />
          <div className="flex items-baseline justify-between px-5 pt-3 pb-2">
            <h2 className="truncate text-[15px] font-bold tracking-tight text-ink">{mail.subject}</h2>
            <button
              type="button"
              onClick={onClose}
              className="ml-3 shrink-0 text-[11.5px] font-bold text-accent-ink"
            >
              Fermer
            </button>
          </div>
          <div
            ref={sheetRef}
            role="menu"
            aria-label="Actions du message"
            onKeyDown={onKeyDown}
            className="max-h-[52vh] space-y-0.5 overflow-y-auto no-scrollbar px-3 pb-1"
          >
            {actions.map((action) => (
              <MenuItem key={action.label} action={action} compact={false} onSelect={onClose} />
            ))}
          </div>
          <div className="px-3 pt-2 pb-[calc(env(safe-area-inset-bottom,0px)+0.75rem)]">
            <button
              type="button"
              onClick={onClose}
              className="focus-ring min-h-11 w-full rounded-2xl border border-line text-[12.5px] font-bold text-ink-soft transition-colors hover:text-ink"
            >
              Annuler
            </button>
          </div>
        </motion.div>
      </div>
    );
  }

  return (
    <AnchoredMenu ancre={ancre} onClose={onClose} label="Actions du message">
      {actions.map((action) => (
        <MenuItem key={action.label} action={action} compact onSelect={onClose} />
      ))}
    </AnchoredMenu>
  );
}
