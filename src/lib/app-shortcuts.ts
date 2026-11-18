import type { Mail } from "@/lib/mail";
import { defineShortcuts, type Shortcut } from "@/lib/shortcuts";

export type MailNavigation = {
  canMove: () => boolean;
  canOpen: () => boolean;
  canAct: () => boolean;
  current: () => Mail | null;
  next: () => void;
  previous: () => void;
  open: () => void;
  selectAll: () => void;
  deleteSelected: () => void;
  archiveSelected: () => void;
  toggleStarSelected: () => void;
  toggleReadSelected: () => void;
  replySelected: () => void;
  forwardSelected: () => void;
};

export type AppShortcutActions = {
  navigate: (view: "inbox" | "calendar" | "planning" | "settings") => void;
  calendarEnabled: boolean;
  planningEnabled: boolean;
  calendarActive: boolean;
  compose: () => void;
  newTask: () => void;
  newEvent: () => void;
  search: () => void;
  toggleHelp: () => void;
  mail: MailNavigation;
};

export function appShortcuts(actions: AppShortcutActions): Shortcut[] {
  const { mail } = actions;
  return defineShortcuts([
    {
      id: "view-inbox",
      keys: "mod+1",
      group: "Navigation",
      label: "Boîte de réception",
      description: "Revenir aux messages",
      allowInInput: true,
      run: () => actions.navigate("inbox"),
    },
    {
      id: "view-calendar",
      keys: "mod+2",
      group: "Navigation",
      label: "Agenda",
      description: "Ouvrir le calendrier",
      allowInInput: true,
      when: () => actions.calendarEnabled,
      run: () => actions.navigate("calendar"),
    },
    {
      id: "view-planning",
      keys: "mod+3",
      group: "Navigation",
      label: "Planification",
      description: "Ouvrir les tâches",
      allowInInput: true,
      when: () => actions.planningEnabled,
      run: () => actions.navigate("planning"),
    },
    {
      id: "view-settings",
      keys: "mod+4",
      group: "Navigation",
      label: "Réglages",
      description: "Ouvrir les réglages",
      allowInInput: true,
      run: () => actions.navigate("settings"),
    },
    {
      id: "compose",
      keys: "mod+n",
      group: "Actions",
      label: "Nouveau message",
      description: "Ouvrir la rédaction",
      allowInInput: true,
      run: actions.compose,
    },
    {
      id: "create",
      keys: "mod+shift+n",
      group: "Actions",
      label: actions.calendarActive ? "Nouveau rendez-vous" : "Nouvelle tâche",
      description: actions.calendarActive ? "Ajouter un rendez-vous à l’agenda" : "Ajouter une tâche",
      allowInInput: true,
      run: () => (actions.calendarActive ? actions.newEvent() : actions.newTask()),
    },
    {
      id: "search",
      keys: "mod+k",
      group: "Actions",
      label: "Rechercher",
      description: "Chercher dans tous les comptes",
      allowInInput: true,
      run: actions.search,
    },
    {
      id: "settings-shortcut",
      keys: "mod+,",
      group: "Actions",
      label: "Réglages",
      description: "Préférences et comptes",
      allowInInput: true,
      run: () => actions.navigate("settings"),
    },
    {
      id: "help",
      keys: "mod+/",
      group: "Aide",
      label: "Raccourcis clavier",
      description: "Afficher ou masquer cette liste",
      allowInInput: true,
      run: actions.toggleHelp,
    },
    {
      id: "help-question",
      keys: "?",
      group: "Aide",
      label: "Raccourcis clavier",
      description: "Afficher ou masquer cette liste",
      run: actions.toggleHelp,
    },
    {
      id: "mail-next",
      keys: "arrowdown",
      group: "Navigation",
      label: "Message suivant",
      description: "Descendre dans la liste des messages",
      allowRepeat: true,
      when: mail.canMove,
      run: mail.next,
    },
    {
      id: "mail-previous",
      keys: "arrowup",
      group: "Navigation",
      label: "Message précédent",
      description: "Remonter dans la liste des messages",
      allowRepeat: true,
      when: mail.canMove,
      run: mail.previous,
    },
    {
      id: "mail-next-vim",
      keys: "j",
      group: "Navigation",
      label: "Message suivant",
      description: "Alias vim de la flèche bas",
      allowRepeat: true,
      when: mail.canMove,
      run: mail.next,
    },
    {
      id: "mail-previous-vim",
      keys: "k",
      group: "Navigation",
      label: "Message précédent",
      description: "Alias vim de la flèche haut",
      allowRepeat: true,
      when: mail.canMove,
      run: mail.previous,
    },
    {
      id: "mail-open",
      keys: "enter",
      group: "Actions",
      label: "Ouvrir le message",
      description: "Ouvrir le message sélectionné",
      when: mail.canOpen,
      run: mail.open,
    },
    {
      id: "mail-select-all",
      keys: "mod+a",
      group: "Actions sur le message",
      label: "Tout sélectionner",
      description: "Sélectionner les messages de la liste",
      when: () => actions.mail.canMove(),
      run: () => actions.mail.selectAll(),
    },
    {
      id: "mail-delete",
      keys: "delete",
      group: "Actions sur le message",
      label: "Supprimer",
      description: "Mettre le message sélectionné à la corbeille",
      when: mail.canAct,
      run: mail.deleteSelected,
    },
    {
      id: "mail-archive",
      keys: "mod+e",
      group: "Actions sur le message",
      label: "Archiver",
      description: "Archiver le message sélectionné",
      when: mail.canAct,
      run: mail.archiveSelected,
    },
    {
      id: "mail-star",
      keys: "mod+shift+s",
      group: "Actions sur le message",
      label: "Suivre le message",
      description: "Ajouter ou retirer l’étoile",
      when: mail.canAct,
      run: mail.toggleStarSelected,
    },
    {
      id: "mail-read",
      keys: "mod+shift+u",
      group: "Actions sur le message",
      label: "Lu / non lu",
      description: "Basculer l’état de lecture",
      when: mail.canAct,
      run: mail.toggleReadSelected,
    },
    {
      id: "mail-reply",
      keys: "mod+shift+r",
      group: "Actions sur le message",
      label: "Répondre",
      description: "Répondre au message sélectionné",
      when: mail.canAct,
      run: mail.replySelected,
    },
    {
      id: "mail-forward",
      keys: "mod+shift+f",
      group: "Actions sur le message",
      label: "Transférer",
      description: "Transférer le message sélectionné",
      when: mail.canAct,
      run: mail.forwardSelected,
    },
  ]);
}

const noop = () => {};

const CATALOG_NAVIGATION: MailNavigation = {
  canMove: () => true,
  canOpen: () => true,
  canAct: () => true,
  current: () => null,
  next: noop,
  previous: noop,
  open: noop,
  selectAll: noop,
  deleteSelected: noop,
  archiveSelected: noop,
  toggleStarSelected: noop,
  toggleReadSelected: noop,
  replySelected: noop,
  forwardSelected: noop,
};

export function shortcutCatalog(): Shortcut[] {
  return appShortcuts({
    navigate: noop,
    calendarEnabled: true,
    planningEnabled: true,
    calendarActive: false,
    compose: noop,
    newTask: noop,
    newEvent: noop,
    search: noop,
    toggleHelp: noop,
    mail: CATALOG_NAVIGATION,
  });
}
