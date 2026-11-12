import { describe, expect, it } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useState } from "react";
import { RichEditor } from "@/components/ui/rich-editor";

function Harness({ onChange }: { onChange: (html: string) => void }) {
  const [value, setValue] = useState("");
  return (
    <RichEditor
      value={value}
      onChange={(html) => {
        setValue(html);
        onChange(html);
      }}
    />
  );
}

const surfaceOf = (container: HTMLElement) => {
  const element = container.querySelector(".rich-editor-content");
  if (!element) throw new Error("éditeur absent");
  return element as HTMLElement;
};

function paste(element: HTMLElement, files: File[]) {
  fireEvent.paste(element, {
    clipboardData: {
      files,
      items: files.map((file) => ({ kind: "file", type: file.type, getAsFile: () => file })),
      getData: () => "",
    },
  });
}

const png = (bytes = 0) => {
  const head = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
  const padding = new Uint8Array(Math.max(0, bytes - head.length));
  return new File([head, padding], "capture.png", { type: "image/png" });
};

describe("collage d'images dans l'éditeur", () => {
  it("insère l'image du presse-papier en data URL", async () => {
    const changes: string[] = [];
    const { container } = render(<Harness onChange={(html) => changes.push(html)} />);
    await waitFor(() => expect(surfaceOf(container)).toBeTruthy());

    paste(surfaceOf(container), [png()]);

    await waitFor(() => expect(changes.at(-1) ?? "").toContain('<img src="data:image/png;base64,'));
    expect(changes.at(-1)).toContain("iVBORw==");
  });

  it("refuse une image au-delà de 8 Mo et le dit", async () => {
    const changes: string[] = [];
    const { container } = render(<Harness onChange={(html) => changes.push(html)} />);
    await waitFor(() => expect(surfaceOf(container)).toBeTruthy());

    paste(surfaceOf(container), [png(8 * 1024 * 1024 + 1)]);

    await waitFor(() => expect(screen.getByRole("status").textContent).toContain("8 Mo maximum"));
    expect(changes.join("")).not.toContain("<img");
  });

  it("refuse un format que le démon ne sait pas inliner", async () => {
    const changes: string[] = [];
    const { container } = render(<Harness onChange={(html) => changes.push(html)} />);
    await waitFor(() => expect(surfaceOf(container)).toBeTruthy());

    const svg = new File(["<svg></svg>"], "logo.svg", { type: "image/svg+xml" });
    paste(surfaceOf(container), [svg]);

    await waitFor(() => expect(screen.getByRole("status").textContent).toContain("PNG, JPEG, GIF"));
    expect(changes.join("")).not.toContain("<img");
  });
});
