import { describe, expect, it } from "vitest";
import { createSyncEngine, type SyncEngine } from "./engine";
import { createDevice, createMemoryStorage, emptyState, type SyncStorage } from "./storage";
import { docKey } from "./merge";

const SERVER = process.env.SYNC_LIVE_URL;

function makeStorage(name: string): SyncStorage {
  return createMemoryStorage(emptyState(createDevice(name, "web")));
}

function uniqueEmail(): string {
  return `live-${Date.now()}-${Math.floor(Math.random() * 1000)}@test.lan`;
}

describe.skipIf(!SERVER)("intégration live moteur ↔ serveur", () => {
  it("compte, push, pull, édition et appairage de bout en bout", async () => {
    const serverUrl = SERVER as string;
    const email = uniqueEmail();
    const password = "mot-de-passe-de-test";

    const engineA: SyncEngine = createSyncEngine(makeStorage("Portable"));
    await engineA.createAccount({ serverUrl, email, password });
    expect(engineA.getStatus().phase).not.toBe("error");

    engineA.emitLocal("task", "tk:live", { title: "Acheter du pain", state: "todo" });
    await engineA.syncNow();
    expect(engineA.getStatus().pending).toBe(0);

    const engineB: SyncEngine = createSyncEngine(makeStorage("Bureau"));
    await engineB.loginAccount({ serverUrl, email, password });
    await engineB.syncNow();
    const pulled = engineB.getState().docs[docKey("task", "tk:live")];
    expect(pulled?.raw).toMatchObject({ title: "Acheter du pain", state: "todo" });

    engineB.emitLocal("task", "tk:live", { state: "done" });
    await engineB.syncNow();
    await engineA.syncNow();
    expect(engineA.getState().docs[docKey("task", "tk:live")].raw).toMatchObject({
      title: "Acheter du pain",
      state: "done",
    });

    const engineC: SyncEngine = createSyncEngine(makeStorage("Tablette"));
    const start = await engineC.pairStart(serverUrl);
    expect(start.code).toHaveLength(6);
    const claim = await engineA.pairClaim(start.code);
    expect(claim.fingerprint).toHaveLength(8);
    await engineA.pairComplete(start.code);
    expect(await engineC.pairPoll(start.code, start.pollSecret)).toBe("completed");
    await engineC.syncNow();
    expect(engineC.getState().docs[docKey("task", "tk:live")].raw).toMatchObject({ state: "done" });
    expect(engineC.getStatus().phase).toBe("synced");

    await engineA.logoutAccount();
    expect(engineA.getStatus().phase).toBe("unconfigured");
  }, 60_000);
});
