import { useState } from "react";
import {
  Bell,
  Blocks,
  CalendarDays,
  ChevronRight,
  KeyRound,
  ListChecks,
  Moon,
  Palette,
  PenLine,
  Plus,
  Sun,
  Trash2,
  Type,
  Users,
} from "lucide-react";
import { ACCENT_PRESETS, useTheme } from "@/lib/theme";
import { SWIPE_ACTIONS, mergeFlags, usePrefs } from "@/lib/prefs";
import { ALL_ACCOUNTS } from "@/lib/accounts";
import { useMailStore } from "@/lib/store";
import { MCP_SERVERS, mcpCounts } from "@/lib/mcp";
import type { Mail } from "@/lib/mail";
import { cn } from "@/lib/utils";
import { Avatar, Card, SectionTitle, ToggleRow } from "@/components/ui/primitives";
import { SyncSettings } from "@/components/sync-settings";
import { BlurFade } from "@/components/ui/blur-fade";
import { MeshGlow } from "@/components/ui/backdrops";
import { AnimatedGradientText } from "@/components/ui/animated-text";

const PREVIEW_OPTIONS = [
  { value: "always", label: "Toujours" },
  { value: "unlocked", label: "Si déverrouillé" },
  { value: "never", label: "Jamais" },
] as const;

type PreviewMode = (typeof PREVIEW_OPTIONS)[number]["value"];

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
  const { accounts, mode, openConnect, askRemoveAccount } = useMailStore();
  const {
    swipeLeft,
    swipeRight,
    setSwipe,
    mcpEnabled,
    calendarEnabled,
    planningEnabled,
    setCalendarEnabled,
    setPlanningEnabled,
  } = usePrefs();
  const [notifications, setNotifications] = useState(true);
  const [preview, setPreview] = useState<PreviewMode>("unlocked");
  const enabled = mergeFlags(
    Object.fromEntries(MCP_SERVERS.map((server) => [server.id, server.status === "connected"])),
    mcpEnabled,
  );
  const mcp = mcpCounts((server) => enabled[server.id]);

  const unreadFor = (id: string) =>
    mails.filter(
      (mail) =>
        mail.unread &&
        mail.folder !== "spam" &&
        mail.folder !== "trash" &&
        (id === ALL_ACCOUNTS || mail.account === id),
    ).length;

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
          <Avatar
            name={accounts.find((entry) => entry.id === account)?.label ?? "Compte"}
            size={48}
            rounded="rounded-2xl"
            tone={0}
          />
          <div className="min-w-0 flex-1 leading-tight">
            <p className="truncate text-[14px] font-bold text-ink">
              {accounts.find((entry) => entry.id === account)?.label ?? "Tous les comptes"}
            </p>
            <p className="truncate text-[11.5px] font-medium text-ink-muted">
              {accounts.find((entry) => entry.id === account)?.email ??
                `${accounts.length} compte${accounts.length > 1 ? "s" : ""}`}
            </p>
          </div>
          <span className="inline-flex shrink-0 items-center gap-1 rounded-full bg-accent-soft px-2.5 py-1 text-[10.5px] font-bold text-accent-ink">
            <PenLine className="size-3" />
            Signature e-mail
          </span>
        </Card>
      </BlurFade>

      <SectionTitle hint={`${accounts.length} compte${accounts.length > 1 ? "s" : ""}`}>Comptes</SectionTitle>
      <BlurFade delay={0.08}>
        <Card className="mx-5 divide-y divide-line/80 overflow-hidden">
          {accounts.map((item) => (
            <div
              key={item.id}
              className={cn(
                "flex items-center gap-1 pr-1.5 transition-colors",
                item.id === account && "bg-accent-soft/40",
              )}
            >
              <button
                type="button"
                onClick={onOpenAccounts}
                className="focus-row flex min-w-0 flex-1 items-center gap-3 py-3 pr-1 pl-3.5 text-left transition-colors hover:bg-surface-2/70"
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
              {mode === "api" && (
                <button
                  type="button"
                  aria-label={`Retirer le compte ${item.label}`}
                  onClick={() => askRemoveAccount(item)}
                  className="focus-ring grid size-9 shrink-0 place-items-center rounded-full text-ink-muted transition-colors hover:bg-rose-500/10 hover:text-rose-600"
                >
                  <Trash2 className="size-3.5" />
                </button>
              )}
            </div>
          ))}
          <Row
            icon={<Plus className="size-4" />}
            label="Ajouter un compte"
            hint="IMAP + SMTP · connexion testée par le service local"
            onClick={openConnect}
          >
            <ChevronRight className="size-4 text-ink-muted" />
          </Row>
          <Row
            icon={<Users className="size-4" />}
            label="Boîte unifiée"
            hint="Choisir les comptes · tous les comptes dans une liste"
            onClick={onOpenAccounts}
          >
            <ChevronRight className="size-4 text-ink-muted" />
          </Row>
        </Card>
      </BlurFade>

      <SectionTitle hint="personnalisable">Couleur d'accent</SectionTitle>
      <BlurFade delay={0.12}>
        <Card className="mx-5 p-4">
          <div className="flex items-center justify-between gap-3">
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

          <div className="mt-2.5 flex flex-wrap gap-0.5">
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
                  className="focus-ring grid size-11 place-items-center rounded-full"
                >
                  <span
                    className="size-8 rounded-full transition-transform duration-200 hover:scale-110"
                    style={{
                      backgroundColor: preset.value,
                      boxShadow: selected
                        ? `0 0 0 2px var(--surface), 0 0 0 4px ${preset.value}`
                        : "inset 0 0 0 1px rgba(0,0,0,0.06)",
                    }}
                  />
                </button>
              );
            })}

            <label
              className={cn(
                "relative grid size-11 cursor-pointer place-items-center rounded-full",
                "focus-within:outline-2 focus-within:outline-offset-2 focus-within:outline-accent",
              )}
              title="Couleur personnalisée"
            >
              <span className="grid size-8 place-items-center rounded-full border border-line bg-surface text-[13px] font-black text-ink-soft">
                +
              </span>
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
              <p className="text-[12px] font-bold text-ink">Aperçu de l'accent</p>
              <p className="text-[10.5px] leading-relaxed font-medium text-ink-muted">
                Boutons, badges et surlignages suivent cette teinte
              </p>
            </div>
            <span className="shrink-0 rounded-full bg-accent px-2.5 py-1 text-[10px] font-bold text-accent-contrast">
              {accent}
            </span>
          </div>
        </Card>
      </BlurFade>

      <SectionTitle>Modules</SectionTitle>
      <BlurFade delay={0.15}>
        <Card className="mx-5 divide-y divide-line/80 overflow-hidden">
          <ToggleRow
            icon={<CalendarDays className="size-4" />}
            label="Calendrier"
            hint="Onglet Agenda, rendez-vous et disponibilités"
            checked={calendarEnabled}
            onChange={setCalendarEnabled}
          />
          <ToggleRow
            icon={<ListChecks className="size-4" />}
            label="Planification"
            hint="Onglet Planif., tâches et suggestions issues des mails"
            checked={planningEnabled}
            onChange={setPlanningEnabled}
          />
        </Card>
        <p className="mt-2 px-5 text-[10.5px] leading-relaxed font-medium text-ink-muted">
          Un module désactivé disparaît du dock et du balayage horizontal. Tes données restent en place.
        </p>
      </BlurFade>

      <SectionTitle>Sécurité</SectionTitle>
      <BlurFade delay={0.16}>
        <Card className="mx-5 divide-y divide-line/80 overflow-hidden">
          <Row
            icon={<KeyRound className="size-4" />}
            label="Gérer mes clés PGP"
            hint="Générer, importer, exporter et supprimer"
            onClick={onOpenPgp}
          >
            <ChevronRight className="size-4 text-ink-muted" />
          </Row>
          <ToggleRow
            icon={<Bell className="size-4" />}
            label="Notifications"
            hint="Push instantanée"
            checked={notifications}
            onChange={setNotifications}
          />
          <div className="px-3.5 py-3">
            <div className="flex items-center gap-3">
              <span className="grid size-8 shrink-0 place-items-center rounded-xl bg-surface-2 text-ink-soft">
                <Type className="size-4" />
              </span>
              <div className="min-w-0 flex-1 leading-tight">
                <p className="text-[12.5px] font-bold text-ink">Aperçu du texte</p>
                <p className="text-[10.5px] font-medium text-ink-muted">Dans les notifications push</p>
              </div>
            </div>
            <div
              role="radiogroup"
              aria-label="Aperçu du texte des notifications"
              className={cn("mt-2.5 flex gap-1.5", !notifications && "opacity-55")}
            >
              {PREVIEW_OPTIONS.map((option) => {
                const selected = preview === option.value;
                return (
                  <button
                    key={option.value}
                    type="button"
                    role="radio"
                    disabled={!notifications}
                    aria-checked={selected}
                    onClick={() => setPreview(option.value)}
                    className={cn(
                      "focus-ring min-h-11 flex-1 rounded-xl px-1 text-[11.5px] font-bold transition-colors disabled:cursor-not-allowed",
                      selected
                        ? "bg-accent text-accent-contrast"
                        : "border border-line bg-surface text-ink-soft hover:border-accent-ring",
                    )}
                  >
                    {option.label}
                  </button>
                );
              })}
            </div>
            <p className="mt-2 text-[10px] leading-relaxed font-medium text-ink-muted">
              Les messages chiffrés ne sont jamais inclus en clair dans la notification push.
            </p>
          </div>
        </Card>
      </BlurFade>

      <SectionTitle hint="chiffré de bout en bout">Synchronisation</SectionTitle>
      <BlurFade delay={0.165}>
        <div className="mx-5">
          <SyncSettings variant="mobile" />
        </div>
      </BlurFade>

      <SectionTitle>Gestes des mails</SectionTitle>
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
                      aria-pressed={active}
                      onClick={() => setSwipe(row.side, action.id)}
                      className={cn(
                        "focus-ring min-h-11 rounded-full px-3 text-[11px] font-bold transition-all",
                        active
                          ? "bg-accent text-accent-contrast shadow-[0_4px_12px_-6px_var(--accent)]"
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
            Ces gestes s'appliquent aux mails de la boîte. Les gestes des suggestions de la
            planification sont gérés séparément.
          </p>
        </Card>
      </BlurFade>

      <SectionTitle>Assistant</SectionTitle>
      <BlurFade delay={0.18}>
        <Card className="mx-5 divide-y divide-line/80 overflow-hidden">
          <Row
            icon={<Blocks className="size-4" />}
            label="Serveurs MCP"
            hint={`${mcp.activeServers} serveurs actifs · ${mcp.activeTools} outils actifs`}
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
                  aria-pressed={selected}
                  onClick={() => setDark(option.value)}
                  className={cn(
                    "focus-ring flex min-h-11 flex-1 items-center justify-center gap-2 rounded-[18px] py-2.5 text-[12.5px] font-bold transition-all",
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
            className="focus-ring mt-3 min-h-11 rounded-full border border-line px-4 text-[11.5px] font-bold text-ink-soft transition-colors hover:border-accent-ring hover:text-accent-ink"
          >
            Réinitialiser le thème
          </button>
          <a
            href="?desktop"
            className="focus-ring mt-2 flex min-h-11 items-center justify-center rounded-full text-[11.5px] font-bold text-accent-ink transition-colors hover:bg-accent-soft"
          >
            Voir la maquette PC →
          </a>
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
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="focus-row flex w-full items-center gap-3 px-3.5 py-3 transition-colors hover:bg-surface-2/70"
    >
      <span className="grid size-8 shrink-0 place-items-center rounded-xl bg-surface-2 text-ink-soft">{icon}</span>
      <span className="min-w-0 flex-1 text-left leading-tight">
        <span className="block text-[12.5px] font-bold text-ink">{label}</span>
        <span className="block text-[10.5px] font-medium text-ink-muted">{hint}</span>
      </span>
      {children}
    </button>
  );
}
