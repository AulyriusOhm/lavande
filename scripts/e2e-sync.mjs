#!/usr/bin/env node
import { randomBytes, randomUUID } from "node:crypto";

const BASE = (process.env.SYNC_URL ?? "http://127.0.0.1:8787").replace(/\/+$/, "");
const API = `${BASE}/api/v1`;
const HLC_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
const ENTITY_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

let failures = 0;
let checks = 0;

function ok(label, detail) {
  checks += 1;
  console.log(`ok   ${label}${detail === undefined ? "" : ` — ${detail}`}`);
}

function fail(label, detail) {
  checks += 1;
  failures += 1;
  console.log(`FAIL ${label} — ${detail}`);
}

async function check(label, fn) {
  try {
    ok(label, await fn());
  } catch (error) {
    fail(label, error instanceof Error ? error.message : String(error));
  }
}

function b64url(bytes) {
  return Buffer.from(bytes).toString("base64url");
}

function rand(bytes) {
  return b64url(randomBytes(bytes));
}

function randomEntityRef() {
  return Array.from(randomBytes(22), (byte) => ENTITY_ALPHABET[byte % ENTITY_ALPHABET.length]).join("");
}

function randomNode() {
  return Array.from(randomBytes(6), (byte) => HLC_ALPHABET[byte % HLC_ALPHABET.length]).join("");
}

function hlc(wallMs, counter) {
  return `${String(wallMs).padStart(15, "0")}-${String(counter).padStart(5, "0")}-${randomNode()}`;
}

async function request(method, path, options = {}) {
  const headers = { accept: "application/json" };
  if (options.body !== undefined) headers["content-type"] = "application/json";
  if (options.token !== undefined) headers.authorization = `Bearer ${options.token}`;

  let response;
  try {
    response = await fetch(path.startsWith("http") ? path : `${API}${path}`, {
      method,
      headers,
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
    });
  } catch (error) {
    const cause = error instanceof Error ? error.cause?.code ?? error.message : String(error);
    throw new Error(`${BASE} injoignable (${cause})`);
  }

  const raw = await response.text();
  let json = null;
  if (raw !== "") {
    try {
      json = JSON.parse(raw);
    } catch {
      json = null;
    }
  }
  return { status: response.status, json, raw };
}

function expectStatus(result, expected, label) {
  if (result.status !== expected) {
    throw new Error(`${label} : HTTP ${result.status} au lieu de ${expected} (${result.raw.slice(0, 200)})`);
  }
}

function expectEqual(actual, expected, label) {
  if (actual !== expected) {
    throw new Error(`${label} : ${JSON.stringify(actual)} au lieu de ${JSON.stringify(expected)}`);
  }
}

function expectTrue(condition, label) {
  if (!condition) throw new Error(label);
}

function uniqueEmail(tag) {
  return `e2e-${tag}-${randomUUID()}@lavande.test`;
}

function op(deviceId, counter, kind) {
  return {
    opId: `${deviceId}:${counter}`,
    kind,
    entityRef: randomEntityRef(),
    hlc: hlc(Date.now(), counter),
    schemaVersion: 1,
    nonce: rand(24),
    ciphertext: rand(48),
  };
}

async function main() {
  console.log(`lavande-sync e2e — cible ${BASE}`);

  let health;
  try {
    health = await request("GET", `${BASE}/healthz`);
  } catch (error) {
    console.error(`serveur injoignable sur ${BASE} : ${error.message}`);
    console.error("démarrer le serveur (docker compose -f server/docker-compose.yml up -d db puis bash .plasma/cargo.sh run)");
    console.error("ou pointer une autre instance avec SYNC_URL=http://host:port");
    process.exit(2);
  }

  await check("GET /healthz", () => {
    expectStatus(health, 200, "healthz");
    expectEqual(health.json?.status, "ok", "healthz.status");
    return `schemaVersion=${health.json.schemaVersion} minClientSchema=${health.json.minClientSchema}`;
  });

  const alicePassword = rand(32);
  const bobPassword = rand(32);
  const aliceEmail = uniqueEmail("alice");
  const bobEmail = uniqueEmail("bob");
  const aliceSalt = rand(16);
  const bobSalt = rand(16);
  const aliceDeviceA = randomUUID();
  const aliceDeviceB = randomUUID();
  const pairedDevice = randomUUID();
  const bobDevice = randomUUID();

  const alice = { email: aliceEmail, authKey: alicePassword, salt: aliceSalt, token: null, userId: null };
  const bob = { email: bobEmail, authKey: bobPassword, salt: bobSalt, token: null, userId: null };

  for (const [label, account] of [
    ["compte A (inscription)", alice],
    ["compte B (inscription)", bob],
  ]) {
    await check(label, async () => {
      const result = await request("POST", "/auth/register", {
        body: { email: account.email, authKey: account.authKey, accountSalt: account.salt },
      });
      expectStatus(result, 201, "register");
      expectTrue(typeof result.json?.token === "string", "register.token absent");
      expectEqual(result.json?.accountSalt, account.salt, "register.accountSalt");
      account.token = result.json.token;
      account.userId = result.json.userId;
      return `userId=${account.userId} email=${account.email}`;
    });
  }

  await check("GET /auth/salt", async () => {
    expectTrue(alice.token !== null, "compte A indisponible");
    const result = await request("GET", `/auth/salt?email=${encodeURIComponent(alice.email)}`);
    expectStatus(result, 200, "salt");
    expectEqual(result.json?.accountSalt, aliceSalt, "salt.accountSalt");
    return "accountSalt identique à l'inscription";
  });

  await check("POST /auth/login (session de 2e appareil)", async () => {
    expectTrue(alice.token !== null, "compte A indisponible");
    const result = await request("POST", "/auth/login", {
      body: { email: alice.email, authKey: alice.authKey },
    });
    expectStatus(result, 200, "login");
    expectEqual(result.json?.userId, alice.userId, "login.userId");
    expectEqual(result.json?.accountSalt, aliceSalt, "login.accountSalt");
    expectEqual(result.json?.keyEnvelope, null, "login.keyEnvelope");
    alice.secondToken = result.json.token;
    return "accountSalt + keyEnvelope null (aucune enveloppe serveur)";
  });

  const devices = [
    ["appareil A1 (compte A)", aliceDeviceA, () => alice.token, "MacBook", "desktop"],
    ["appareil A2 (compte A)", aliceDeviceB, () => alice.secondToken, "Pixel", "mobile"],
    ["appareil B1 (compte B)", bobDevice, () => bob.token, "ThinkPad", "desktop"],
  ];

  for (const [label, deviceId, tokenOf, name, platform] of devices) {
    await check(`POST /devices ${label}`, async () => {
      const token = tokenOf();
      expectTrue(typeof token === "string", "jeton indisponible");
      const result = await request("POST", "/devices", {
        token,
        body: { id: deviceId, name, platform, pubKey: rand(32), schemaVersion: 1 },
      });
      expectStatus(result, 201, "devices");
      expectEqual(result.json?.deviceId, deviceId, "devices.deviceId");
      return `deviceId=${deviceId} (uuid imposé par le client)`;
    });
  }

  const aliceOps = [
    op(aliceDeviceA, 1, "task"),
    op(aliceDeviceA, 2, "task"),
    op(aliceDeviceA, 3, "suggestion"),
  ];
  let aliceNextSeq = null;

  await check("POST /ops (compte A, 3 ops chiffrées)", async () => {
    const result = await request("POST", "/ops", { token: alice.token, body: { ops: aliceOps } });
    expectStatus(result, 200, "push");
    expectEqual(result.json?.acked?.length, 3, "push.acked.length");
    for (let index = 0; index < aliceOps.length; index += 1) {
      expectEqual(result.json.acked[index], aliceOps[index].opId, `push.acked[${index}]`);
    }
    expectTrue(Number.isInteger(result.json?.nextSeq) && result.json.nextSeq > 0, "push.nextSeq invalide");
    aliceNextSeq = result.json.nextSeq;
    return `acked=${result.json.acked.length} nextSeq=${aliceNextSeq}`;
  });

  await check("idempotence : re-push de la même batch", async () => {
    expectTrue(aliceNextSeq !== null, "push initial échoué");
    const before = await request("GET", "/ops?since=0", { token: alice.token });
    expectStatus(before, 200, "pull avant re-push");
    const result = await request("POST", "/ops", { token: alice.token, body: { ops: aliceOps } });
    expectStatus(result, 200, "re-push");
    expectEqual(result.json?.acked?.length, 3, "re-push.acked.length");
    expectEqual(result.json?.nextSeq, aliceNextSeq, "re-push.nextSeq");
    const after = await request("GET", "/ops?since=0", { token: alice.token });
    expectStatus(after, 200, "pull après re-push");
    expectEqual(after.json?.ops?.length, before.json?.ops?.length, "nombre d'ops après re-push");
    expectEqual(after.json?.ops?.length, 3, "ops stockées");
    return `acked=3 nextSeq inchangé (${aliceNextSeq}), ${after.json.ops.length} op(s) en base`;
  });

  await check("curseur : GET /ops?since=nextSeq", async () => {
    const result = await request("GET", `/ops?since=${aliceNextSeq}`, { token: alice.token });
    expectStatus(result, 200, "pull");
    expectEqual(result.json?.ops?.length, 0, "pull.ops.length");
    expectEqual(result.json?.nextSeq, aliceNextSeq, "pull.nextSeq");
    expectEqual(result.json?.hasMore, false, "pull.hasMore");
    return `since=${aliceNextSeq} → 0 op, hasMore=false`;
  });

  await check("pagination : GET /ops?limit=1", async () => {
    const result = await request("GET", "/ops?since=0&limit=1", { token: alice.token });
    expectStatus(result, 200, "pull limité");
    expectEqual(result.json?.ops?.length, 1, "pull.ops.length");
    expectEqual(result.json?.hasMore, true, "pull.hasMore");
    return "1 op, hasMore=true";
  });

  await check("push du 2e appareil puis pull partagé (même compte)", async () => {
    const second = [op(aliceDeviceB, 1, "task")];
    const pushed = await request("POST", "/ops", { token: alice.secondToken, body: { ops: second } });
    expectStatus(pushed, 200, "push A2");
    expectEqual(pushed.json?.acked?.length, 1, "push A2 acked");
    const pulled = await request("GET", "/ops?since=0", { token: alice.secondToken });
    expectStatus(pulled, 200, "pull A2");
    expectEqual(pulled.json?.ops?.length, 4, "pull A2 ops.length");
    const devices_seen = new Set(pulled.json.ops.map((entry) => entry.deviceId));
    expectEqual(devices_seen.size, 2, "nombre d'appareils émetteurs");
    return "4 ops, 2 appareils émetteurs";
  });

  let bobSeq = null;

  await check("isolation : ops de B invisibles pour A", async () => {
    const pushed = await request("POST", "/ops", {
      token: bob.token,
      body: { ops: [op(bobDevice, 1, "task")] },
    });
    expectStatus(pushed, 200, "push B");
    expectEqual(pushed.json?.acked?.length, 1, "push B acked");
    bobSeq = pushed.json.nextSeq;
    const alicePull = await request("GET", "/ops?since=0", { token: alice.token });
    expectStatus(alicePull, 200, "pull A");
    const bobPull = await request("GET", "/ops?since=0", { token: bob.token });
    expectStatus(bobPull, 200, "pull B");
    expectEqual(bobPull.json?.ops?.length, 1, "pull B ops.length");
    expectEqual(alicePull.json?.ops?.length, 4, "pull A ops.length");
    const bobIds = new Set(bobPull.json.ops.map((entry) => entry.opId));
    expectTrue(
      alicePull.json.ops.every((entry) => !bobIds.has(entry.opId)),
      "une op de B apparaît chez A",
    );
    return "A=4 ops, B=1 op, aucun recouvrement";
  });

  const pollSecret = rand(24);
  const pairingPublicKey = rand(32);
  let pairingCode = null;
  let pairingToken = null;
  const pairingEnvelope = JSON.stringify({ v: 1, ephPub: rand(32), nonce: rand(24), ct: rand(48) });

  await check("POST /pairing/start (non authentifié)", async () => {
    const result = await request("POST", "/pairing/start", {
      body: {
        deviceId: pairedDevice,
        name: "Tablette",
        platform: "mobile",
        publicKey: pairingPublicKey,
        schemaVersion: 1,
        pollSecret,
      },
    });
    expectStatus(result, 201, "pairing/start");
    expectTrue(/^[A-HJ-NP-Z2-9]{6}$/.test(result.json?.code ?? ""), "code d'appairage invalide");
    pairingCode = result.json.code;
    return `code=${pairingCode} expiresAt=${result.json.expiresAt}`;
  });

  await check("POST /pairing/:code/poll avant claim → pending", async () => {
    expectTrue(pairingCode !== null, "code d'appairage indisponible");
    const result = await request("POST", `/pairing/${pairingCode}/poll`, { body: { pollSecret } });
    expectStatus(result, 200, "poll pending");
    expectEqual(result.json?.status, "pending", "poll.status");
    return "status=pending";
  });

  await check("POST /pairing/claim (appareil configuré A2)", async () => {
    expectTrue(pairingCode !== null, "code d'appairage indisponible");
    const result = await request("POST", "/pairing/claim", {
      token: alice.secondToken,
      body: { code: pairingCode },
    });
    expectStatus(result, 200, "pairing/claim");
    expectEqual(result.json?.deviceId, pairedDevice, "claim.deviceId");
    expectEqual(result.json?.deviceName, "Tablette", "claim.deviceName");
    expectEqual(result.json?.platform, "mobile", "claim.platform");
    expectEqual(result.json?.publicKey, pairingPublicKey, "claim.publicKey");
    expectEqual(result.json?.schemaVersion, 1, "claim.schemaVersion");
    expectTrue(typeof result.json?.fingerprint === "string" && result.json.fingerprint.length === 8, "claim.fingerprint");
    return `deviceId=${pairedDevice} fingerprint=${result.json.fingerprint}`;
  });

  await check("POST /pairing/complete (enveloppe de DEK)", async () => {
    const result = await request("POST", "/pairing/complete", {
      token: alice.secondToken,
      body: { code: pairingCode, envelope: pairingEnvelope },
    });
    expectStatus(result, 204, "pairing/complete");
    return "204";
  });

  await check("POST /pairing/:code/poll → jeton + enveloppe", async () => {
    const result = await request("POST", `/pairing/${pairingCode}/poll`, { body: { pollSecret } });
    expectStatus(result, 200, "poll completed");
    expectEqual(result.json?.status, "completed", "poll.status");
    expectTrue(typeof result.json?.token === "string" && result.json.token.length > 0, "poll.token absent");
    expectEqual(result.json?.userId, alice.userId, "poll.userId");
    expectEqual(result.json?.accountSalt, aliceSalt, "poll.accountSalt");
    expectEqual(result.json?.envelope, pairingEnvelope, "poll.envelope");
    pairingToken = result.json.token;
    return "token, userId, accountSalt et enveloppe restitués";
  });

  await check("jeton appairé utilisable (GET /devices)", async () => {
    expectTrue(typeof pairingToken === "string", "jeton appairé indisponible");
    const result = await request("GET", "/devices", { token: pairingToken });
    expectStatus(result, 200, "devices");
    expectTrue(Array.isArray(result.json), "devices : tableau attendu");
    const ids = result.json.map((entry) => entry.id);
    expectTrue(ids.includes(pairedDevice), "appareil appairé absent de la liste");
    expectTrue(ids.includes(aliceDeviceA), "appareil A1 absent de la liste");
    const current = result.json.find((entry) => entry.current === true);
    expectEqual(current?.id, pairedDevice, "devices.current");
    return `${ids.length} appareils, current=${pairedDevice}`;
  });

  await check("POST /pairing/:code/poll une 2e fois → 409 pairing_consumed", async () => {
    const result = await request("POST", `/pairing/${pairingCode}/poll`, { body: { pollSecret } });
    expectStatus(result, 409, "poll rejoué");
    expectEqual(result.json?.code, "pairing_consumed", "poll.code");
    return "pairing_consumed";
  });

  await check("GET /status", async () => {
    const result = await request("GET", "/status", { token: alice.token });
    expectStatus(result, 200, "status");
    expectEqual(result.json?.serverSchemaVersion, 1, "status.serverSchemaVersion");
    expectEqual(result.json?.minClientSchema, 1, "status.minClientSchema");
    expectTrue(Number.isInteger(result.json?.headSeq), "status.headSeq invalide");
    expectTrue(result.json.headSeq >= aliceNextSeq, "status.headSeq inférieur au dernier nextSeq poussé");
    return `serverSchemaVersion=1 minClientSchema=1 headSeq=${result.json.headSeq}`;
  });

  await check("GET /me", async () => {
    const result = await request("GET", "/me", { token: alice.token });
    expectStatus(result, 200, "me");
    expectEqual(result.json?.userId, alice.userId, "me.userId");
    expectEqual(result.json?.accountSalt, aliceSalt, "me.accountSalt");
    expectTrue(Number.isInteger(result.json?.devices) && result.json.devices >= 3, "me.devices");
    return `devices=${result.json.devices}`;
  });

  await check("session de compte sans appareil refusée sur /ops → 401 device_required", async () => {
    const result = await request("POST", "/auth/login", { body: { email: alice.email, authKey: alice.authKey } });
    expectStatus(result, 200, "login compte");
    const push = await request("POST", "/ops", {
      token: result.json.token,
      body: { ops: [op(aliceDeviceA, 99, "task")] },
    });
    expectStatus(push, 401, "push sans appareil");
    expectEqual(push.json?.code, "device_required", "push.code");
    return "device_required";
  });

  const cleanupToken = { alice: null, bob: null };

  await check("nettoyage : révocation des appareils", async () => {
    const aliceLogin = await request("POST", "/auth/login", {
      body: { email: alice.email, authKey: alice.authKey },
    });
    expectStatus(aliceLogin, 200, "login A");
    cleanupToken.alice = aliceLogin.json.token;
    const bobLogin = await request("POST", "/auth/login", {
      body: { email: bob.email, authKey: bob.authKey },
    });
    expectStatus(bobLogin, 200, "login B");
    cleanupToken.bob = bobLogin.json.token;

    for (const [token, deviceId] of [
      [cleanupToken.alice, aliceDeviceA],
      [cleanupToken.alice, aliceDeviceB],
      [cleanupToken.alice, pairedDevice],
      [cleanupToken.bob, bobDevice],
    ]) {
      const result = await request("DELETE", `/devices/${deviceId}`, { token });
      expectStatus(result, 204, `DELETE /devices/${deviceId}`);
    }
    return "4 appareils révoqués (204)";
  });

  await check("nettoyage : sessions révoquées → 401", async () => {
    const result = await request("GET", "/ops?since=0", { token: alice.token });
    expectStatus(result, 401, "pull après révocation");
    const paired = await request("GET", "/ops?since=0", { token: pairingToken });
    expectStatus(paired, 401, "pull du jeton appairé après révocation");
    return "jetons d'appareil invalides";
  });

  await check("nettoyage : logout", async () => {
    expectTrue(typeof cleanupToken.alice === "string", "session de nettoyage indisponible");
    const aliceResult = await request("POST", "/auth/logout", { token: cleanupToken.alice });
    expectStatus(aliceResult, 204, "logout A");
    const bobResult = await request("POST", "/auth/logout", { token: cleanupToken.bob });
    expectStatus(bobResult, 204, "logout B");
    const replay = await request("GET", "/me", { token: cleanupToken.bob });
    expectStatus(replay, 401, "me après logout");
    return "204 / 204, jeton rejoué refusé";
  });

  const summary = failures === 0 ? "succès" : "échec";
  console.log("");
  console.log(`${checks} vérifications, ${failures} échec(s) — ${summary}`);
  if (failures > 0) process.exitCode = 1;
}

await main();
