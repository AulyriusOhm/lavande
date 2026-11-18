/**
 * Noms de dossiers IMAP : les serveurs les étiquettent en UTF-7 modifié
 * (RFC 3501 §5.1.3), où « & » ouvre une séquence base64 d'UTF-16BE (virgule à
 * la place du slash) fermée par « - », « &- » valant un « & » littéral. Une
 * séquence illisible reste telle quelle : un nom de dossier doit rester lisible.
 */
export function decodeModifiedUtf7(text: string): string {
  return text.replace(/&([^&-]*)-/g, (sequence: string, run: string) =>
    run === "" ? "&" : (decodeRun(run) ?? sequence),
  );
}

function decodeRun(run: string): string | null {
  const standard = run.replace(/,/g, "/").replace(/=+$/, "");
  if (standard.length % 4 === 1) return null;
  let binary: string;
  try {
    binary = atob(standard);
  } catch {
    return null;
  }
  if (binary.length % 2 !== 0) return null;

  let decoded = "";
  for (let index = 0; index < binary.length; index += 2) {
    const unit = (binary.charCodeAt(index) << 8) | binary.charCodeAt(index + 1);
    if (unit >= 0xdc00 && unit <= 0xdfff) return null;
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const low = (binary.charCodeAt(index + 2) << 8) | binary.charCodeAt(index + 3);
      if (!(low >= 0xdc00 && low <= 0xdfff)) return null;
      decoded += String.fromCharCode(unit, low);
      index += 2;
      continue;
    }
    decoded += String.fromCharCode(unit);
  }
  return decoded;
}
