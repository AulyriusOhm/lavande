import { errorText, mailApi } from "@/lib/api";
import { saveBlob } from "@/lib/download";
import type { Mail, MailAttachment } from "@/lib/mail";

/**
 * Récupère les octets d'une pièce jointe puis les enregistre sur le poste.
 *
 * Rend le message d'état à afficher : les deux écrans de lecture (mobile et
 * bureau) téléchargent de la même façon et n'ont que la mise en page à gérer.
 */
export async function downloadAttachment(mail: Mail, file: MailAttachment): Promise<string> {
  const source = mail.source;
  if (!source || file.index === undefined) {
    return `« ${file.name} » vient de la maquette : aucun fichier n'est stocké côté serveur.`;
  }
  try {
    const blob = await mailApi.attachment(source.accountId, source.folderPath, source.uid, file.index);
    saveBlob(blob, file.name);
    return `« ${file.name} » téléchargé`;
  } catch (error) {
    return `Téléchargement impossible · ${errorText(error)}`;
  }
}
