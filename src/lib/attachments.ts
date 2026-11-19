import { errorText, mailApi } from "@/lib/api";
import { saveBlob } from "@/lib/download";
import type { Mail, MailAttachment } from "@/lib/mail";
import { isNativeShell } from "@/lib/native";

/**
 * Récupère les octets d'une pièce jointe puis les enregistre sur l'appareil.
 *
 * Rend le message d'état à afficher et le chemin réel du fichier écrit, quand
 * il y en a un : les deux écrans de lecture (mobile et bureau) téléchargent de
 * la même façon et n'ont que la mise en page à gérer. Sur Android le fichier
 * n'est pas « téléchargé » mais aussitôt ouvert ; sur le poste, le chemin
 * permet d'ouvrir le dossier qui le contient.
 */
export async function downloadAttachment(
  mail: Mail,
  file: MailAttachment,
): Promise<{ message: string; path: string | null }> {
  const source = mail.source;
  if (!source || file.index === undefined) {
    return {
      message: `« ${file.name} » vient de la maquette : aucun fichier n'est stocké côté serveur.`,
      path: null,
    };
  }
  try {
    const blob = await mailApi.attachment(source.accountId, source.folderPath, source.uid, file.index);
    const path = await saveBlob(blob, file.name);
    if (!path) return { message: `« ${file.name} » téléchargé`, path: null };
    if (isNativeShell()) return { message: `Ouverture de « ${file.name} »`, path };
    return { message: `« ${file.name} » enregistré dans ${path}`, path };
  } catch (error) {
    return { message: `Téléchargement impossible · ${errorText(error)}`, path: null };
  }
}
