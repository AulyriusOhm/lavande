import { useEffect, useRef, useState } from "react";
import { EditorContent, useEditor, useEditorState, type Editor } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import Image from "@tiptap/extension-image";
import Placeholder from "@tiptap/extension-placeholder";
import {
  Bold,
  Italic,
  Underline,
  Strikethrough,
  Heading1,
  Heading2,
  Heading3,
  List,
  ListOrdered,
  Quote,
  SquareCode,
  Link2,
  Minus,
  Undo2,
  Redo2,
  RemoveFormatting,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { looksLikeMarkdown, markdownToHtml } from "@/lib/rich-text";

function ToolButton({
  label,
  active = false,
  disabled = false,
  onClick,
  children,
}: {
  label: string;
  active?: boolean;
  disabled?: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      aria-pressed={active}
      disabled={disabled}
      onMouseDown={(event) => event.preventDefault()}
      onClick={onClick}
      className={cn(
        "grid size-8 shrink-0 place-items-center rounded-lg transition-colors duration-150",
        active
          ? "bg-accent-soft text-accent-ink ring-1 ring-accent-ring/50"
          : "text-ink-muted hover:bg-surface-2 hover:text-ink",
        disabled && "pointer-events-none opacity-35",
      )}
    >
      {children}
    </button>
  );
}

const Divider = () => <span aria-hidden className="mx-1 h-5 w-px shrink-0 bg-line" />;

/** Plafond d'une image collée : au-delà, l'envoi SMTP devient un calvaire. */
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;

/** Types que le démon sait transporter en image inline (`cid:`). */
const INLINE_IMAGE_TYPES = ["image/png", "image/jpeg", "image/gif", "image/webp"];

const megabyte = (bytes: number) => (bytes / (1024 * 1024)).toFixed(1).replace(".", ",");

/** Les fichiers image d'un presse-papier ou d'un dépôt, jamais le texte. */
function imageFiles(data: DataTransfer | null): File[] {
  if (!data) return [];
  const files = Array.from(data.files ?? []).filter((file) => file.type.startsWith("image/"));
  if (files.length > 0) return files;
  return Array.from(data.items ?? [])
    .filter((item) => item.kind === "file" && item.type.startsWith("image/"))
    .map((item) => item.getAsFile())
    .filter((file): file is File => file !== null);
}

function readAsDataUrl(file: File): Promise<string | null> {
  return new Promise((resolve) => {
    const reader = new FileReader();
    reader.onload = () => resolve(typeof reader.result === "string" ? reader.result : null);
    reader.onerror = () => resolve(null);
    reader.readAsDataURL(file);
  });
}

/** Insère les images collées une à une, dans l'ordre reçu, et rapporte les refus. */
async function insertImages(
  editor: Editor,
  files: File[],
  at: number | undefined,
  refuse: (message: string) => void,
) {
  for (const file of files) {
    if (!INLINE_IMAGE_TYPES.includes(file.type)) {
      refuse(`Format non pris en charge (${file.type}) : PNG, JPEG, GIF ou WebP.`);
      continue;
    }
    if (file.size > MAX_IMAGE_BYTES) {
      refuse(`Image trop lourde (${megabyte(file.size)} Mo) : 8 Mo maximum.`);
      continue;
    }
    const src = await readAsDataUrl(file);
    if (!src) {
      refuse("Image illisible : elle n'a pas pu être lue depuis le presse-papier.");
      continue;
    }
    if (at === undefined) {
      editor.chain().focus().setImage({ src }).run();
    } else {
      editor.chain().focus().insertContentAt(at, { type: "image", attrs: { src } }).run();
    }
    at = undefined;
  }
}

export function RichEditor({
  value,
  onChange,
  placeholder = "Écris ton message…",
  minHeight = "10rem",
  autoFocus = false,
  className,
}: {
  value: string;
  onChange: (html: string) => void;
  placeholder?: string;
  minHeight?: string;
  autoFocus?: boolean;
  className?: string;
}) {
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  const editorRef = useRef<Editor | null>(null);
  const refuseRef = useRef<(message: string) => void>(() => {});
  const [linkOpen, setLinkOpen] = useState(false);
  const [linkUrl, setLinkUrl] = useState("");
  const [notice, setNotice] = useState<string | null>(null);
  refuseRef.current = (message) => setNotice(message);

  const editor = useEditor({
    extensions: [
      StarterKit.configure({
        heading: { levels: [1, 2, 3] },
        link: { openOnClick: false, autolink: true, defaultProtocol: "https" },
      }),
      Placeholder.configure({ placeholder }),
      Image.configure({ allowBase64: true }),
    ],
    content: value,
    autofocus: autoFocus,
    editorProps: {
      attributes: { class: "mail-html rich-editor-content", style: `min-height: ${minHeight}` },
      handlePaste: (_view, event) => {
        const instance = editorRef.current;
        if (!instance) return false;
        const images = imageFiles(event.clipboardData);
        if (images.length > 0) {
          event.preventDefault();
          setNotice(null);
          void insertImages(instance, images, undefined, refuseRef.current);
          return true;
        }
        const html = event.clipboardData?.getData("text/html");
        const text = event.clipboardData?.getData("text/plain");
        if (!html && text && looksLikeMarkdown(text)) {
          instance.commands.insertContent(markdownToHtml(text));
          return true;
        }
        return false;
      },
      handleDrop: (view, event, _slice, moved) => {
        const instance = editorRef.current;
        if (!instance || moved) return false;
        const images = imageFiles(event.dataTransfer);
        if (images.length === 0) return false;
        event.preventDefault();
        setNotice(null);
        const at = view.posAtCoords({ left: event.clientX, top: event.clientY })?.pos;
        void insertImages(instance, images, at, refuseRef.current);
        return true;
      },
    },
    onUpdate: ({ editor: instance }) => onChangeRef.current(instance.getHTML()),
  });
  editorRef.current = editor;

  useEffect(() => {
    if (!editor) return;
    if (value !== editor.getHTML()) {
      editor.commands.setContent(value || "", { emitUpdate: false });
    }
  }, [value, editor]);

  const state = useEditorState({
    editor,
    selector: ({ editor: instance }) =>
      instance
        ? {
            bold: instance.isActive("bold"),
            italic: instance.isActive("italic"),
            underline: instance.isActive("underline"),
            strike: instance.isActive("strike"),
            h1: instance.isActive("heading", { level: 1 }),
            h2: instance.isActive("heading", { level: 2 }),
            h3: instance.isActive("heading", { level: 3 }),
            bulletList: instance.isActive("bulletList"),
            orderedList: instance.isActive("orderedList"),
            blockquote: instance.isActive("blockquote"),
            codeBlock: instance.isActive("codeBlock"),
            link: instance.isActive("link"),
            canUndo: instance.can().undo(),
            canRedo: instance.can().redo(),
          }
        : null,
  });

  const run = (fn: (chain: ReturnType<Editor["chain"]>) => ReturnType<Editor["chain"]>) => {
    if (!editor) return;
    fn(editor.chain().focus()).run();
  };

  const openLink = () => {
    if (!editor) return;
    if (editor.isActive("link")) {
      run((chain) => chain.extendMarkRange("link").unsetLink());
      return;
    }
    setLinkUrl((editor.getAttributes("link").href as string) ?? "");
    setLinkOpen(true);
  };

  const applyLink = () => {
    const href = linkUrl.trim();
    setLinkOpen(false);
    if (!href) return;
    const withProtocol = /^[a-z][a-z0-9+.-]*:/i.test(href) ? href : `https://${href}`;
    run((chain) => chain.extendMarkRange("link").setLink({ href: withProtocol }));
  };

  if (!editor) {
    return <div className={cn("animate-pulse rounded-xl bg-surface-2", className)} style={{ minHeight }} />;
  }

  return (
    <div className={cn("flex flex-col", className)}>
      <div className="relative">
        <div
          role="toolbar"
          aria-label="Mise en forme du message"
          className="flex items-center gap-0.5 overflow-x-auto no-scrollbar rounded-xl border border-line bg-surface px-1.5 py-1"
        >
          <ToolButton label="Gras (Markdown : **texte**)" active={state?.bold} onClick={() => run((c) => c.toggleBold())}>
            <Bold className="size-4" strokeWidth={2.4} />
          </ToolButton>
          <ToolButton label="Italique (Markdown : *texte*)" active={state?.italic} onClick={() => run((c) => c.toggleItalic())}>
            <Italic className="size-4" strokeWidth={2.4} />
          </ToolButton>
          <ToolButton label="Souligné" active={state?.underline} onClick={() => run((c) => c.toggleUnderline())}>
            <Underline className="size-4" strokeWidth={2.4} />
          </ToolButton>
          <ToolButton label="Barré" active={state?.strike} onClick={() => run((c) => c.toggleStrike())}>
            <Strikethrough className="size-4" strokeWidth={2.4} />
          </ToolButton>
          <Divider />
          <ToolButton label="Titre 1 (Markdown : #)" active={state?.h1} onClick={() => run((c) => c.toggleHeading({ level: 1 }))}>
            <Heading1 className="size-4" strokeWidth={2.4} />
          </ToolButton>
          <ToolButton label="Titre 2 (Markdown : ##)" active={state?.h2} onClick={() => run((c) => c.toggleHeading({ level: 2 }))}>
            <Heading2 className="size-4" strokeWidth={2.4} />
          </ToolButton>
          <ToolButton label="Titre 3 (Markdown : ###)" active={state?.h3} onClick={() => run((c) => c.toggleHeading({ level: 3 }))}>
            <Heading3 className="size-4" strokeWidth={2.4} />
          </ToolButton>
          <Divider />
          <ToolButton label="Liste à puces (Markdown : -)" active={state?.bulletList} onClick={() => run((c) => c.toggleBulletList())}>
            <List className="size-4" strokeWidth={2.4} />
          </ToolButton>
          <ToolButton label="Liste numérotée (Markdown : 1.)" active={state?.orderedList} onClick={() => run((c) => c.toggleOrderedList())}>
            <ListOrdered className="size-4" strokeWidth={2.4} />
          </ToolButton>
          <ToolButton label="Citation (Markdown : >)" active={state?.blockquote} onClick={() => run((c) => c.toggleBlockquote())}>
            <Quote className="size-4" strokeWidth={2.4} />
          </ToolButton>
          <ToolButton label="Bloc de code (Markdown : ```)" active={state?.codeBlock} onClick={() => run((c) => c.toggleCodeBlock())}>
            <SquareCode className="size-4" strokeWidth={2.4} />
          </ToolButton>
          <Divider />
          <ToolButton label="Lien (Markdown : [texte](url))" active={state?.link} onClick={openLink}>
            <Link2 className="size-4" strokeWidth={2.4} />
          </ToolButton>
          <ToolButton label="Séparateur" onClick={() => run((c) => c.setHorizontalRule())}>
            <Minus className="size-4" strokeWidth={2.4} />
          </ToolButton>
          <Divider />
          <ToolButton label="Annuler" disabled={!state?.canUndo} onClick={() => run((c) => c.undo())}>
            <Undo2 className="size-4" strokeWidth={2.4} />
          </ToolButton>
          <ToolButton label="Rétablir" disabled={!state?.canRedo} onClick={() => run((c) => c.redo())}>
            <Redo2 className="size-4" strokeWidth={2.4} />
          </ToolButton>
          <ToolButton label="Effacer la mise en forme" onClick={() => run((c) => c.clearNodes().unsetAllMarks())}>
            <RemoveFormatting className="size-4" strokeWidth={2.4} />
          </ToolButton>
        </div>

        {linkOpen && (
          <div className="absolute left-0 top-full z-30 mt-1.5 flex w-full max-w-sm items-center gap-1.5 rounded-xl border border-line bg-surface p-1.5 shadow-lg">
            <input
              autoFocus
              value={linkUrl}
              onChange={(event) => setLinkUrl(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  applyLink();
                }
                if (event.key === "Escape") setLinkOpen(false);
              }}
              placeholder="https://exemple.fr"
              aria-label="Adresse du lien"
              className="min-w-0 flex-1 bg-transparent px-2 text-[12.5px] font-medium text-ink outline-none placeholder:text-ink-muted/70"
            />
            <button
              type="button"
              onClick={applyLink}
              className="rounded-lg bg-accent px-2.5 py-1 text-[11px] font-bold text-accent-contrast"
            >
              OK
            </button>
            <button
              type="button"
              onClick={() => setLinkOpen(false)}
              className="rounded-lg px-2 py-1 text-[11px] font-bold text-ink-muted hover:text-ink"
            >
              Fermer
            </button>
          </div>
        )}
      </div>

      {notice && (
        <p role="status" className="mt-1.5 text-[11.5px] font-semibold text-ink-muted">
          {notice}
        </p>
      )}

      <EditorContent
        editor={editor}
        className="rich-editor mt-2.5 flex-1 cursor-text"
        onClick={() => editor.commands.focus()}
      />
    </div>
  );
}