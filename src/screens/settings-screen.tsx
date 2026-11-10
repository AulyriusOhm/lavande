import { useState } from "react";
import {
  Bell,
  Blocks,
  ChevronRight,
  KeyRound,
  Moon,
  Palette,
  PenLine,
  RotateCcw,
  Sun,
  Type,
  Users,
} from "lucide-react";
import { ACCENT_PRESETS, useTheme } from "@/lib/theme";
import { SWIPE_ACTIONS, usePrefs } from "@/lib/prefs";
import { ACCOUNTS, ALL_ACCOUNTS } from "@/lib/accounts";
import type { Mail } from "@/lib/mail";
import { cn } from "@/lib/utils";
import { Avatar, Card, SectionTitle, Switch } from "@/components/ui/primitives";
import { BlurFade } from "@/components/ui/blur-fade";
import { MeshGlow } from "@/components/ui/backdrops";
import { AnimatedGradientText } from "@/components/ui/animated-text";

export function SettingsScreen({
  mails,
  account,
  onOpenAccounts,
  onOpenPgp,
  onOpenMcp,
}: {
  mails: Mail[];
  account: string;
  onOpenAccounts: () => void;
  onOpenPgp: () => void;
  onOpenMcp: () => void;
}) {
  const { accent, dark, brand, setAccent, setDark, reset } = useTheme();
  const { swipeLeft, swipeRight, setSwipe } = usePrefs();
  const [notifications, setNotifications] = useState(true);
  const [preview, setPreview] = useState(true);
  const [autoSync, setAutoSync] = useState(true);

  const unreadFor = (id: string) =>
    mails.filter((mail) => mail.unread && (id === ALL_ACCOUNTS || mail.account === id)).length;

  return (
    <div className="relative h-full overflow-y-auto no-scrollbar pb-32">
      <MeshGlow className="h-48" />

      <header className="relative px-5 pt-4">
        <p className="text-[10.5px] font-bold tracking-[0.18em] text-ink-muted uppercase">{brand}</p>
        <h1 className="mt-1.5 text-[27px] leading-none font-extrabold tracking-[-0.035em] text-ink">
          Réglages
        </h1>
      </header>

      <BlurFade delay={0.05}>
        <Card className="mx-5 mt-5 flex items-center gap-3 p-3.5">
          <Avatar name="Roman" size={48} rounded="rounded-2xl" tone={0} />
          <div className="min-w-0 flex-1 leading-tight">
            <p className="truncate text-[14px] font-bold text-ink">Roman</p>
            <p className="truncate text-[11.5px] font-medium text-ink-muted">roman@lavande.mail</p>
          </div>
          <span className="inline-flex items-center gap-1 rounded-full bg-accent-soft px-2.5 py-1 text-[10.5px] font-bold text-accent-ink">
            <PenLine className="size-3" />
            Signature
          </span>
        </Card>
      </BlurFade>

      <SectionTitle hint={`${ACCOUNTS.length} comptes`}>Comptes</SectionTitle>
      <BlurFade delay={0.08}>
        <Card className="mx-5 divide-y divide-line/80 overflow-hidden">
          {ACCOUNTS.map((item) => (
            <button
              key={item.id}
              type="button"
              onClick={onOpenAccounts}
              className={cn(
                "flex w-full items-center gap-3 px-3.5 py-3 text-left transition-colors hover:bg-surface-2/70",
                item.id === account && "bg-accent-soft/40",
              )}
            >
              <span
                className="grid size-8 shrink-0 place-items-center rounded-xl text-[11px] font-black text-white"
                style={{ backgroundColor: item.color }}
              >
                {item.label[0]}
              </span>
              <span className="min-w-0 flex-1 leading-tight">
                <span className="block truncate text-[12.5px] font-bold text-ink">{item.label}</span>
                <span className="block truncate text-[10.5px] font-medium text-ink-muted">{item.email}</span>
              </span>
              {unreadFor(item.id) > 0 && (
                <span className="rounded-full bg-accent-soft px-1.5 py-0.5 text-[10px] font-bold text-accent-ink">
                  {unreadFor(item.id)}
                </span>
              )}
              <ChevronRight className="size-4 shrink-0 text-ink-muted" />
            </button>
          ))}
          <div className="flex items-center gap-3 px-3.5 py-2.5">
            <span className="grid size-8 place-items-center rounded-xl bg-surface-2 text-ink-soft">
              <Users className="size-4" />
            </span>
            <div className="min-w-0 flex-1 leading-tight">
              <p className="text-[12.5px] font-bold text-ink">Boîte unifiée</p>
              <p className="text-[10.5px] font-medium text-ink-muted">Tous les comptes dans une liste</p>
            </div>
            <Switch
              checked={account === ALL_ACCOUNTS}
              onChange={() => onOpenAccounts()}
              label="Boîte unifiée"
            />
          </div>
        </Card>
      </BlurFade>

      <SectionTitle hint="personnalisable">Couleur secondaire</SectionTitle>
      <BlurFade delay={0.12}>
        <Card className="mx-5 p-4">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <span className="grid size-7 place-items-center rounded-xl bg-accent-soft text-accent-ink">
                <Palette className="size-3.5" />
              </span>
              <p className="text-[12.5px] font-bold text-ink">Couleur d'accent</p>
            </div>
            <span className="font-mono text-[10.5px] font-semibold tracking-wide text-ink-muted uppercase">
              {accent}
            </span>
          </div>

          <div className="mt-3.5 flex flex-wrap gap-2.5">
            {ACCENT_PRESETS.map((preset) => {
              const selected = preset.value.toLowerCase() === accent.toLowerCase();
              return (
                <button
                  key={preset.value}
                  type="button"
                  title={preset.name}
                  aria-label={preset.name}
                  aria-pressed={selected}
                  onClick={() => setAccent(preset.value)}
                  className="size-8 rounded-full transition-transform duration-200 hover:scale-110 active:scale-95"
                  style={{
                    backgroundColor: preset.value,
                    boxShadow: selected
                      ? `0 0 0 2px var(--surface), 0 0 0 4px ${preset.value}`
                      : "inset 0 0 0 1px rgba(0,0,0,0.06)",
                  }}
                />
              );
            })}

            <label
              className={cn(
                "relative grid size-8 cursor-pointer place-items-center overflow-hidden rounded-full",
                "border border-line bg-surface",
              )}
              title="Couleur personnalisée"
            >
              <span className="text-[13px] font-black text-ink-soft">+</span>
              <input
                type="color"
                value={accent}
                onChange={(event) => setAccent(event.target.value)}
                className="absolute inset-0 cursor-pointer opacity-0"
                aria-label="Choisir une couleur personnalisée"
              />
            </label>
          </div>

          <div className="mt-4 flex items-center gap-2 rounded-2xl bg-surface-2 p-3">
            <Avatar name="C" tone={0} size={32} />
            <div className="min-w-0 flex-1 leading-tight">
              <p className="truncate text-[12px] font-bold text-ink">Aperçu de l'accent</p>
              <p className="truncate text-[10.5px] font-medium text-ink-muted">
                Boutons, badges et surlignages suivent cette teinte
              </p>
            </div>
            <span className="rounded-full bg-accent px-2.5 py-1 text-[10px] font-bold text-white">{accent}</span>
          </div>
        </Card>
      </BlurFade>

      <SectionTitle>Sécurité</SectionTitle>
      <BlurFade delay={0.16}>
        <Card className="mx-5 divide-y divide-line/80 overflow-hidden">
          <Row
            icon={<KeyRound className="size-4" />}
            label="Chiffrement PGP"
            hint="1 clé secrète · 3 destinataires"
            onClick={onOpenPgp}
          >
            <ChevronRight className="size-4 text-ink-muted" />
          </Row>
          <Row icon={<Bell className="size-4" />} label="Notifications" hint="Push instantanée">
            <Switch checked={notifications} onChange={setNotifications} label="Notifications" />
          </Row>
          <Row icon={<Type className="size-4" />} label="Aperçu du texte" hint="Dans les notifications">
            <Switch checked={preview} onChange={setPreview} label="Aperçu du texte" />
          </Row>
          <Row icon={<RotateCcw className="size-4" />} label="Synchro automatique" hint="Toutes les 5 min">
            <Switch checked={autoSync} onChange={setAutoSync} label="Synchro automatique" />
          </Row>
        </Card>
      </BlurFade>

      <SectionTitle>Gestes</SectionTitle>
      <BlurFade delay={0.17}>
        <Card className="mx-5 space-y-3 p-3.5">
          {(
            [
              { side: "left" as const, title: "Glisser vers la gauche", current: swipeLeft },
              { side: "right" as const, title: "Glisser vers la droite", current: swipeRight },
            ]
          ).map((row) => (
            <div key={row.side}>
              <p className="mb-1.5 text-[11px] font-bold text-ink">{row.title}</p>
              <div className="flex flex-wrap gap-1.5">
                {SWIPE_ACTIONS.map((action) => {
                  const active = action.id === row.current;
                  return (
                    <button
                      key={action.id}
                      type="button"
                      onClick={() => setSwipe(row.side, action.id)}
                      className={cn(
                        "rounded-full px-2.5 py-1 text-[10.5px] font-bold transition-all",
                        active
                          ? "bg-accent text-white shadow-[0_4px_12px_-6px_var(--accent)]"
                          : "border border-line bg-surface text-ink-soft hover:border-accent-ring",
                      )}
                    >
                      {action.label}
                    </button>
                  );
                })}
              </div>
            </div>
          ))}
          <p className="text-[10px] leading-relaxed font-medium text-ink-muted">
            S'applique aux mails de la boîte et aux suggestions de la planification.
          </p>
        </Card>
      </BlurFade>

      <SectionTitle>Assistant</SectionTitle>
      <BlurFade delay={0.18}>
        <Card className="mx-5 divide-y divide-line/80 overflow-hidden">
          <Row
            icon={<Blocks className="size-4" />}
            label="Serveurs MCP"
            hint="3 actifs · 11 outils exposés"
            onClick={onOpenMcp}
          >
            <ChevronRight className="size-4 text-ink-muted" />
          </Row>
        </Card>
      </BlurFade>

      <SectionTitle>Apparence</SectionTitle>
      <BlurFade delay={0.2}>
        <Card className="mx-5 p-1.5">
          <div className="flex gap-1.5">
            {[
              { label: "Clair", icon: Sun, value: false },
              { label: "Sombre", icon: Moon, value: true },
            ].map((option) => {
              const selected = dark === option.value;
              const Icon = option.icon;
              return (
                <button
                  key={option.label}
                  type="button"
                  onClick={() => setDark(option.value)}
                  className={cn(
                    "flex flex-1 items-center justify-center gap-2 rounded-[18px] py-2.5 text-[12.5px] font-bold transition-all",
                    selected
                      ? "bg-accent-soft text-accent-ink ring-1 ring-accent-ring/60"
                      : "text-ink-muted hover:bg-surface-2",
                  )}
                >
                  <Icon className="size-4" />
                  {option.label}
                </button>
              );
            })}
          </div>
        </Card>
      </BlurFade>

      <BlurFade delay={0.25}>
        <div className="mt-6 px-5 text-center">
          <p className="text-[11px] font-semibold text-ink-muted">
            <AnimatedGradientText>{brand}</AnimatedGradientText> · v0.2.0 · design preview
          </p>
          <button
            type="button"
            onClick={reset}
            className="mt-3 rounded-full border border-line px-4 py-2 text-[11.5px] font-bold text-ink-soft transition-colors hover:border-accent-ring hover:text-accent-ink"
          >
            Réinitialiser le thème
          </button>
        </div>
      </BlurFade>
    </div>
  );
}

function Row({
  icon,
  label,
  hint,
  children,
  onClick,
}: {
  icon: React.ReactNode;
  label: string;
  hint: string;
  children: React.ReactNode;
  onClick?: () => void;
}) {
  const content = (
    <>
      <span className="grid size-8 shrink-0 place-items-center rounded-xl bg-surface-2 text-ink-soft">{icon}</span>
      <span className="min-w-0 flex-1 text-left leading-tight">
        <span className="block truncate text-[12.5px] font-bold text-ink">{label}</span>
        <span className="block truncate text-[10.5px] font-medium text-ink-muted">{hint}</span>
      </span>
      {children}
    </>
  );

  if (onClick) {
    return (
      <button
        type="button"
        onClick={onClick}
        className="flex w-full items-center gap-3 px-3.5 py-3 transition-colors hover:bg-surface-2/70"
      >
        {content}
      </button>
    );
  }

  return <div className="flex items-center gap-3 px-3.5 py-3">{content}</div>;
}
