import { beforeEach, describe, expect, it } from "vitest";
import { fireEvent, render as renderRaw, screen } from "@testing-library/react";
import { ImagesAllowedSection } from "@/components/images-allowed";
import { PrefsProvider } from "@/lib/prefs";

const stored = () => JSON.parse(window.localStorage.getItem("lavande.prefs") ?? "{}") as Record<string, unknown>;

const seed = (senders: string[]) =>
  window.localStorage.setItem("lavande.prefs", JSON.stringify({ imagesAllowedSenders: senders }));

const render = (readOnly = false) =>
  renderRaw(
    <PrefsProvider>
      <ImagesAllowedSection readOnly={readOnly} />
    </PrefsProvider>,
  );

beforeEach(() => {
  window.localStorage.clear();
});

describe("réglages · images autorisées par expéditeur", () => {
  it("annonce une liste vide et locale à l'appareil", () => {
    render();

    expect(screen.getByText("Images autorisées par expéditeur")).toBeTruthy();
    expect(screen.getByText(/Liste locale à cet appareil/)).toBeTruthy();
    expect(screen.getByText(/Aucun expéditeur autorisé/)).toBeTruthy();
  });

  it("liste les expéditeurs autorisés", () => {
    seed(["camille@exemple.fr", "banque@exemple.fr"]);
    render();

    expect(screen.getByText("camille@exemple.fr")).toBeTruthy();
    expect(screen.getByText("banque@exemple.fr")).toBeTruthy();
    expect(screen.queryByText(/Aucun expéditeur autorisé/)).toBeNull();
  });

  it("retire un expéditeur et le persiste", async () => {
    seed(["camille@exemple.fr", "banque@exemple.fr"]);
    render();

    fireEvent.click(screen.getByLabelText("Retirer camille@exemple.fr"));

    expect(screen.queryByText("camille@exemple.fr")).toBeNull();
    expect(screen.getByText("banque@exemple.fr")).toBeTruthy();
    expect(stored().imagesAllowedSenders).toEqual(["banque@exemple.fr"]);
  });

  it("cache la suppression quand la démo est en lecture seule", () => {
    seed(["camille@exemple.fr"]);
    render(true);

    expect(screen.getByText("camille@exemple.fr")).toBeTruthy();
    expect(screen.queryByLabelText("Retirer camille@exemple.fr")).toBeNull();
  });
});
