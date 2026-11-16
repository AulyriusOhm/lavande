import type { Mail } from "@/lib/mail";
import { cn } from "@/lib/utils";

export function MailRecipients({ mail, className }: { mail: Mail; className?: string }) {
  if (!mail.to && !mail.cc) return null;
  return (
    <dl
      data-testid="mail-recipients"
      className={cn("space-y-0.5 text-[11.5px] leading-snug font-medium text-ink-muted", className)}
    >
      {mail.to ? (
        <div className="flex gap-1.5">
          <dt className="shrink-0 font-bold">À</dt>
          <dd className="min-w-0 flex-1 break-words">{mail.to}</dd>
        </div>
      ) : null}
      {mail.cc ? (
        <div className="flex gap-1.5">
          <dt className="shrink-0 font-bold">Cc</dt>
          <dd className="min-w-0 flex-1 break-words">{mail.cc}</dd>
        </div>
      ) : null}
    </dl>
  );
}
