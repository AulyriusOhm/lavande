import { cn } from "@/lib/utils";

/**
 * Corps du message : le HTML est **déjà assaini côté service** (liste blanche
 * stricte, images de tracking retirées, liens `noopener`), on ne fait donc que
 * le rendre. Sans HTML, on retombe sur les paragraphes texte.
 */
export function MailBody({
  html,
  paragraphs,
  className,
}: {
  html?: string;
  paragraphs: string[];
  className?: string;
}) {
  if (html) {
    return (
      <div
        className={cn("mail-html text-[13.5px] leading-[1.7] font-medium text-ink-soft", className)}
        // HTML assaini par le service (aucun script, aucune image, liens sûrs).
        dangerouslySetInnerHTML={{ __html: html }}
      />
    );
  }

  return (
    <div className={cn("space-y-3.5", className)}>
      {paragraphs.map((paragraph, index) => (
        <p key={index} className="whitespace-pre-line">
          {paragraph}
        </p>
      ))}
    </div>
  );
}
