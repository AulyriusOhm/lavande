import { PenLine, Sparkles, Trash2 } from "lucide-react";
import { RichEditor } from "@/components/ui/rich-editor";
import { Avatar, Switch } from "@/components/ui/primitives";
import { Badge, DButton, SectionLabel, Surface } from "@/desktop/ui";
import { activeSignature, usePrefs } from "@/lib/prefs";
import { isHtmlEmpty } from "@/lib/rich-text";
import { cn } from "@/lib/utils";

export type SignatureAccount = {
  id: string;
  label: string;
  email: string;
  tone?: number;
};

const ESCAPES: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};

const escapeHtml = (value: string) => value.replace(/[&<>"']/g, (char) => ESCAPES[char]);

/** Signature de départ : un trait, le nom du compte et son adresse cliquable. */
export function signatureSeed(account: SignatureAccount): string {
  const email = escapeHtml(account.email);
  return [
    "<p>—</p>",
    `<p><strong>${escapeHtml(account.label)}</strong><br>`,
    `<a href="mailto:${email}">${email}</a></p>`,
  ].join("");
}

export function SignatureEditor({
  account,
  className,
}: {
  account: SignatureAccount;
  className?: string;
}) {
  const { signatures, setSignature } = usePrefs();

  const entry = signatures[account.id];
  const html = entry?.html ?? "";
  const enabled = entry?.enabled ?? true;
  const filled = !isHtmlEmpty(html);
  const active = activeSignature(signatures, account.id) !== null;

  const patch = (next: { html?: string; enabled?: boolean }) => setSignature(account.id, next);

  return (
    <Surface className={cn("overflow-hidden", className)}>
      <div className="flex items-center gap-2.5 border-b border-line px-3.5 py-3">
        <Avatar name={account.label} size={30} tone={account.tone ?? 0} rounded="rounded-[10px]" />
        <div className="min-w-0 flex-1 leading-tight">
          <div className="flex items-center gap-1.5">
            <p className="truncate text-[12.5px] font-bold text-ink">{account.label}</p>
            {filled ? <Badge tone={active ? "accent" : "neutral"}>{active ? "à l'envoi" : "en pause"}</Badge> : null}
          </div>
          <p className="truncate text-[10.5px] font-medium text-ink-muted">{account.email}</p>
        </div>
        {filled ? (
          <Switch
            checked={enabled}
            onChange={(value) => patch({ enabled: value })}
            label={`Signature de ${account.label} à l'envoi`}
          />
        ) : null}
      </div>

      <div className="space-y-3 p-3.5">
        {filled ? (
          <>
            <RichEditor
              value={html}
              onChange={(next) => patch({ html: next })}
              placeholder="— À bientôt"
              minHeight="7rem"
            />
            <div className="flex items-center gap-2">
              <p className="min-w-0 flex-1 truncate text-[10.5px] font-medium text-ink-muted">
                Enregistrée automatiquement · ajoutée à chaque nouvel envoi
              </p>
              <DButton variant="ghost" size="sm" onClick={() => patch({ html: "" })}>
                <Trash2 className="size-3.5" />
                Effacer
              </DButton>
            </div>
          </>
        ) : (
          <div className="flex flex-col items-start gap-2.5 rounded-[18px] border border-dashed border-line bg-surface-2/40 p-4">
            <span className="grid size-9 place-items-center rounded-xl bg-surface text-accent-ink">
              <PenLine className="size-4" strokeWidth={2.4} />
            </span>
            <div className="min-w-0">
              <p className="text-[12.5px] font-bold text-ink">Crée ta signature…</p>
              <p className="mt-0.5 text-[11px] font-medium text-ink-muted">
                Nom, coordonnées, lien ou phrase de fin : elle suit ce compte et signe chacun de ses
                messages.
              </p>
            </div>
            <DButton variant="soft" size="sm" onClick={() => patch({ html: signatureSeed(account), enabled: true })}>
              <Sparkles className="size-3.5" />
              Créer ma signature
            </DButton>
          </div>
        )}

        {filled ? (
          <div>
            <SectionLabel>Aperçu</SectionLabel>
            <div
              className={cn(
                "mt-1.5 rounded-[16px] border border-line bg-surface-2/40 px-3 py-2.5",
                !enabled && "opacity-50",
              )}
            >
              <div
                className="mail-html text-[12.5px] leading-[1.7] font-medium text-ink-soft"
                dangerouslySetInnerHTML={{ __html: html }}
              />
            </div>
            {!enabled ? (
              <p className="mt-1.5 text-[10.5px] font-semibold text-ink-muted">
                Signature désactivée : elle n'est pas ajoutée aux nouveaux messages.
              </p>
            ) : null}
          </div>
        ) : null}
      </div>
    </Surface>
  );
}
