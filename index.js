/**
 * Flow AI – Mindbody Webhook (Mock + Live)
 * - POST /ghl/mindbody
 * - GET  /ghl/mindbody
 *
 * Actions:
 *   - ping
 *   - get_schedule | get_schedule_web | get_schedule_by_date
 *   - book_class
 *   - cancel_class
 *
 * ENV expected (Railway):
 *   MINDBODY_MODE=mock|live   (defaults to live)
 *   MINDBODY_API_KEY
 *   MINDBODY_SITE_ID
 *   MINDBODY_BASE_URL (default: https://api.mindbodyonline.com/public/v6)
 *   RAILWAY_STATIC_URL  (just the domain e.g. yourapp.up.railway.app — for keep-alive)
 *
 * Optional (booking/cancel often requires token):
 *   MINDBODY_TOKEN_USERNAME
 *   MINDBODY_TOKEN_PASSWORD
 */

const express = require("express");
const app = express();

app.use(express.json({ limit: "1mb" }));
app.use(express.urlencoded({ extended: true }));

const PORT = process.env.PORT || 8080;

const BUILD_ID =
  process.env.RAILWAY_GIT_COMMIT_SHA ||
  process.env.RAILWAY_STATIC_URL ||
  process.env.BUILD_ID ||
  "local";

// ---------------------------
// Keep-alive self-ping
// Prevents Railway cold starts that cause GHL voice timeouts
// ---------------------------
const SELF_URL = process.env.RAILWAY_STATIC_URL
  ? `https://${process.env.RAILWAY_STATIC_URL}`
  : null;

if (SELF_URL) {
  setInterval(async () => {
    try {
      await fetch(SELF_URL);
      console.log("keep-alive ping ok:", SELF_URL);
    } catch (e) {
      console.log("keep-alive ping failed:", e.message);
    }
  }, 4 * 60 * 1000); // every 4 minutes
} else {
  console.log("keep-alive disabled: set RAILWAY_STATIC_URL env var");
}

// ---------------------------
// Schedule Cache
// Pre-fetches Mindbody schedules so GHL gets sub-second responses
// ---------------------------
const scheduleCache = new Map();
const CACHE_TTL_MS = 15 * 60 * 1000;

function getCached(dateStr) {
  const entry = scheduleCache.get(dateStr);
  if (!entry) return null;
  if (Date.now() - entry.fetchedAt > CACHE_TTL_MS) {
    scheduleCache.delete(dateStr);
    return null;
  }
  return entry;
}

async function warmCacheForDate(cfg, dateStr) {
  try {
    const schedule = await fetchMindbodyScheduleForDate(cfg, dateStr);
    let classes = schedule.classes;
    classes = sortClassesByStartTime(classes);
    const tz = cfg.timezone || "America/Vancouver";
    const spokenDate = buildSpokenDateLabel(dateStr, tz);
    const speech = buildScheduleSay(spokenDate, classes);
    const slots = classes.slice(0, 12).map((c) => ({
      id: String(c.id), time: c.time, name: c.name, instructor: c.instructor || "", bookable: !!c.bookable,
    }));
    scheduleCache.set(dateStr, { speech, slots, spokenDate, fetchedAt: Date.now() });
    console.log(`cache warmed: ${dateStr} (${classes.length} classes)`);
  } catch (e) {
    console.log(`cache warm failed ${dateStr}:`, e.message);
  }
}

function startCacheWarmer(cfg) {
  if (cfg.mode === "mock") return;
  const warm = async () => {
    const now = new Date();
    for (let i = 0; i < 8; i++) {
      const d = new Date(now);
      d.setDate(d.getDate() + i);
      const dateStr = d.toISOString().split("T")[0];
      await warmCacheForDate(cfg, dateStr);
    }
  };
  warm();
  setInterval(warm, CACHE_TTL_MS);
}

// ---------------------------
// Helpers
// ---------------------------
function safeString(v) {
  if (v === undefined || v === null) return "";
  return String(v);
}

function decodeMaybe(v) {
  const s = safeString(v);
  try {
    return decodeURIComponent(s.replace(/\+/g, " "));
  } catch {
    return s.replace(/\+/g, " ");
  }
}

function normalizeTimeOfDay(v) {
  const s = decodeMaybe(v).trim().toLowerCase();
  if (!s) return null;
  if (s === "all") return null;
  if (["morning", "afternoon", "evening"].includes(s)) return s;
  return null;
}

/**
 * VOICE-FIRST RESPONDER
 * Returns a minimal, clean payload with ONE spoken field: speech
 * Avoids overwhelming GHL voice layer with duplicate/nested text fields
 */
function respondJSON(res, payload) {
  const speechRaw = safeString(
    payload?.speech ||
    payload?.say ||
    payload?.text ||
    payload?.error ||
    ""
  );

  const MAX = 650;
  let speech = speechRaw
    .replace(/\s+\n/g, "\n")
    .replace(/\n+/g, ". ")
    .replace(/\s+/g, " ")
    .trim();

  if (speech.length > MAX) speech = speech.slice(0, MAX - 3) + "...";

  const finalPayload = {
    success: !!payload?.success,
    speech,
  };

  console.log(
    "RESPONDING:",
    finalPayload.success,
    speech.slice(0, 140),
    "| buildId:",
    BUILD_ID
  );

  res.setHeader("Content-Type", "application/json; charset=utf-8");
  return res.status(200).json(finalPayload);
}

function requireEnv(name) {
  const v = process.env[name];
  if (!v) return null;
  return String(v).trim();
}

function getMindbodyConfig() {
  const mode = (requireEnv("MINDBODY_MODE") || "live").toLowerCase();
  const apiKey = requireEnv("MINDBODY_API_KEY");
  const siteId = requireEnv("MINDBODY_SITE_ID");
  const baseUrl =
    requireEnv("MINDBODY_BASE_URL") || "https://api.mindbodyonline.com/public/v6";
  const tokenUsername = requireEnv("MINDBODY_TOKEN_USERNAME");
  const tokenPassword = requireEnv("MINDBODY_TOKEN_PASSWORD");
  return { mode, apiKey, siteId, baseUrl, tokenUsername, tokenPassword };
}

function getTodayISOInTZ(timeZone) {
  const tz = decodeMaybe(timeZone) || "America/Vancouver";
  const dtf = new Intl.DateTimeFormat("en-CA", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  const parts = dtf.formatToParts(new Date());
  const y = parts.find((p) => p.type === "year")?.value;
  const m = parts.find((p) => p.type === "month")?.value;
  const d = parts.find((p) => p.type === "day")?.value;
  return `${y}-${m}-${d}`;
}

function addDaysISO(iso, days) {
  const [y, m, d] = iso.split("-").map((x) => parseInt(x, 10));
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + days);
  const yy = dt.getUTCFullYear();
  const mm = String(dt.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(dt.getUTCDate()).padStart(2, "0");
  return `${yy}-${mm}-${dd}`;
}

function compareISO(a, b) {
  if (a === b) return 0;
  return a < b ? -1 : 1;
}

function resolveDatePhraseToISO(datePhraseRaw, timeZone) {
  const tz = decodeMaybe(timeZone) || "America/Vancouver";
  const todayISO = getTodayISOInTZ(tz);

  const phraseRaw = decodeMaybe(datePhraseRaw).trim().toLowerCase();
  if (!phraseRaw) return { ok: false, reason: "missing date phrase" };

  let extractedTimeOfDay = null;
  let phrase = phraseRaw;

  if (/\bmorning\b|\bearly\b/.test(phrase)) extractedTimeOfDay = "morning";
  if (/\bafternoon\b/.test(phrase)) extractedTimeOfDay = "afternoon";
  if (/\bevening\b|\btonight\b/.test(phrase)) extractedTimeOfDay = "evening";

  phrase = phrase
    .replace(/\b(morning|early|afternoon|evening|tonight)\b/g, "")
    .replace(/\s+/g, " ")
    .trim();

  if (phrase === "today") {
    return { ok: true, requestedDate: todayISO, todayISO, daysAhead: 0, extractedTimeOfDay };
  }
  if (phrase === "tomorrow") {
    return { ok: true, requestedDate: addDaysISO(todayISO, 1), todayISO, daysAhead: 1, extractedTimeOfDay };
  }

  if (/^\d{4}-\d{2}-\d{2}$/.test(phrase)) {
    const daysAhead = Math.round(
      (Date.parse(phrase + "T00:00:00Z") - Date.parse(todayISO + "T00:00:00Z")) / 86400000
    );
    return { ok: true, requestedDate: phrase, todayISO, daysAhead, extractedTimeOfDay };
  }

  const weekdays = ["sunday","monday","tuesday","wednesday","thursday","friday","saturday"];

  const mThisNext = phrase.match(
    /^(this|next)\s+(sunday|monday|tuesday|wednesday|thursday|friday|saturday)$/
  );
  if (mThisNext) {
    const which = mThisNext[1];
    const wdName = mThisNext[2];
    const wdIndex = weekdays.indexOf(wdName);
    const dtf = new Intl.DateTimeFormat("en-US", { timeZone: tz, weekday: "long" });
    const todayName = dtf.format(new Date()).toLowerCase();
    const todayIdx = weekdays.indexOf(todayName);
    let delta = (wdIndex - todayIdx + 7) % 7;
    if (delta === 0) delta = 7;
    if (which === "next") delta += 7;
    return { ok: true, requestedDate: addDaysISO(todayISO, delta), todayISO, daysAhead: delta, extractedTimeOfDay };
  }

  const wdIndex = weekdays.indexOf(phrase);
  if (wdIndex !== -1) {
    const dtf = new Intl.DateTimeFormat("en-US", { timeZone: tz, weekday: "long" });
    const todayName = dtf.format(new Date()).toLowerCase();
    const todayIdx = weekdays.indexOf(todayName);
    let delta = (wdIndex - todayIdx + 7) % 7;
    if (delta === 0) delta = 7;
    return { ok: true, requestedDate: addDaysISO(todayISO, delta), todayISO, daysAhead: delta, extractedTimeOfDay };
  }

  const dayOnly = phrase
    .replace(/^on\s+the\s+/, "")
    .replace(/(\d+)(st|nd|rd|th)$/g, "$1");
  if (/^\d{1,2}$/.test(dayOnly)) {
    const dayNum = parseInt(dayOnly, 10);
    const [y, m] = todayISO.split("-").map((x) => parseInt(x, 10));
    const candidateThisMonth = `${y}-${String(m).padStart(2, "0")}-${String(dayNum).padStart(2, "0")}`;
    let requestedDate = candidateThisMonth;
    if (compareISO(requestedDate, todayISO) < 0) {
      const nextMonthDate = addDaysISO(`${y}-${String(m).padStart(2, "0")}-01`, 32);
      const [ny, nm] = nextMonthDate.split("-").map((x) => parseInt(x, 10));
      requestedDate = `${ny}-${String(nm).padStart(2, "0")}-${String(dayNum).padStart(2, "0")}`;
    }
    const daysAhead = Math.round(
      (Date.parse(requestedDate + "T00:00:00Z") - Date.parse(todayISO + "T00:00:00Z")) / 86400000
    );
    return { ok: true, requestedDate, todayISO, daysAhead, extractedTimeOfDay };
  }

  const monthNames = ["january","february","march","april","may","june","july","august","september","october","november","december"];
  const monthShort = monthNames.map((x) => x.slice(0, 3));

  const cleaned = phrase.replace(/(\d+)(st|nd|rd|th)/g, "$1");
  const md = cleaned.match(/^([a-z]+)\s+(\d{1,2})$/);
  if (md) {
    const monRaw = md[1];
    const dayNum = parseInt(md[2], 10);
    let monIdx = monthNames.indexOf(monRaw);
    if (monIdx === -1) monIdx = monthShort.indexOf(monRaw.slice(0, 3));
    if (monIdx !== -1) {
      const [y] = todayISO.split("-").map((x) => parseInt(x, 10));
      let requestedDate = `${y}-${String(monIdx + 1).padStart(2, "0")}-${String(dayNum).padStart(2, "0")}`;
      if (compareISO(requestedDate, todayISO) < 0) {
        requestedDate = `${y + 1}-${String(monIdx + 1).padStart(2, "0")}-${String(dayNum).padStart(2, "0")}`;
      }
      const daysAhead = Math.round(
        (Date.parse(requestedDate + "T00:00:00Z") - Date.parse(todayISO + "T00:00:00Z")) / 86400000
      );
      return { ok: true, requestedDate, todayISO, daysAhead, extractedTimeOfDay };
    }
  }

  const cleaned2 = phrase.replace(/(\d+)(st|nd|rd|th)/g, "$1").replace(/,/g, "").trim();
  const mdy = cleaned2.match(/^([a-z]+)\s+(\d{1,2})\s+(\d{4})$/);
  if (mdy) {
    const monRaw = mdy[1];
    const dayNum = parseInt(mdy[2], 10);
    const yearNum = parseInt(mdy[3], 10);
    let monIdx = monthNames.indexOf(monRaw);
    if (monIdx === -1) monIdx = monthShort.indexOf(monRaw.slice(0, 3));
    if (monIdx !== -1) {
      const requestedDate = `${yearNum}-${String(monIdx + 1).padStart(2, "0")}-${String(dayNum).padStart(2, "0")}`;
      const daysAhead = Math.round(
        (Date.parse(requestedDate + "T00:00:00Z") - Date.parse(todayISO + "T00:00:00Z")) / 86400000
      );
      return { ok: true, requestedDate, todayISO, daysAhead, extractedTimeOfDay };
    }
  }

  return { ok: false, reason: `unrecognized date phrase: "${datePhraseRaw}"` };
}

function buildSpokenDateLabel(dateISO, timeZone) {
  const tz = decodeMaybe(timeZone) || "America/Vancouver";
  const dt = new Date(dateISO + "T12:00:00Z");
  return new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
  }).format(dt);
}

/**
 * TTS-tight schedule builder
 * Uses ". " joins (no newlines) so voice reads smoothly
 * Caps at 7 classes for voice reliability
 */
function buildScheduleSay(spokenDateLabel, classes) {
  const safeClasses = Array.isArray(classes) ? classes : [];
  const top = safeClasses.slice(0, 3);

  if (!top.length) {
    return `I couldn't find any classes for ${spokenDateLabel}. Would you like a different date?`;
  }

  const lines = [];

  for (const c of top) {
    const time = c?.time || "Time TBD";
    const instructor = c?.instructor || "staff";
    const name = (c?.name || "Class")
      .replace(/EXPRESS\s*/gi, "")
      .replace(/NEW\s*/gi, "")
      .replace(/\(Pilates Inspired\)/gi, "Pilates")
      .replace(/&/g, "and")
      .replace(/\|/g, "")
      .replace(/\*/g, "")
      .replace(/\s+/g, " ")
      .trim();
    lines.push(`${time} ${name} with ${instructor}`);
  }

  return `The classes for ${spokenDateLabel} are: ` + lines.join(", ") + ". Would you like to book one?";
}

// ---------------------------
// MOCK schedule
// ---------------------------
function buildMockSchedule(requestedDate) {
  return [
    { id: `mock_${requestedDate.replaceAll("-","")}_1`, name: "Hot Yoga (Mock)", time: "6:00 AM", instructor: "Mock Instructor", bookable: true },
    { id: `mock_${requestedDate.replaceAll("-","")}_2`, name: "Hot Pilates (Mock)", time: "9:00 AM", instructor: "Mock Instructor", bookable: true },
    { id: `mock_${requestedDate.replaceAll("-","")}_3`, name: "Warm Yin (Mock)", time: "12:00 PM", instructor: "Mock Instructor", bookable: true },
    { id: `mock_${requestedDate.replaceAll("-","")}_4`, name: "Hot Yoga (Mock)", time: "5:30 PM", instructor: "Mock Instructor", bookable: true },
    { id: `mock_${requestedDate.replaceAll("-","")}_5`, name: "Hot Sculpt (Mock)", time: "7:00 PM", instructor: "Mock Instructor", bookable: true },
  ];
}

// ---------------------------
// Mindbody LIVE helpers
// ---------------------------
function toMindbodyTimeWindow(dateISO) {
  return { start: `${dateISO}T00:00:00`, end: `${dateISO}T23:59:59` };
}

function normalizeMindbodyClasses(rawClasses) {
  const out = [];
  for (const c of rawClasses || []) {
    const name =
      c?.ClassDescription?.Name ||
      c?.ClassDescription?.Description ||
      c?.Name ||
      c?.Description ||
      "Class";

    const startDateTime =
      c?.StartDateTime || c?.startDateTime || c?.StartTime || c?.startTime || null;

    let time = "";
    if (startDateTime) {
      const dt = new Date(startDateTime);
      if (!Number.isNaN(dt.getTime())) {
        time = new Intl.DateTimeFormat("en-US", {
          hour: "numeric",
          minute: "2-digit",
          timeZone: "America/Vancouver",
        }).format(dt);
      } else {
        time = String(startDateTime);
      }
    }

    const instructor = c?.Staff?.Name || c?.Staff?.FirstName || c?.InstructorName || "";
    const id =
      c?.Id || c?.ClassId || c?.ClassScheduleId || c?.ClassInstanceId ||
      `class_${Math.random().toString(16).slice(2)}`;

    const bookable =
      typeof c?.IsAvailable === "boolean" ? c.IsAvailable :
      typeof c?.Bookable === "boolean" ? c.Bookable : true;

    out.push({ id: String(id), name, time: time || "Time TBD", instructor: instructor || "", bookable });
  }
  return out;
}

async function fetchMindbodyScheduleForDate(cfg, dateISO) {
  const { start, end } = toMindbodyTimeWindow(dateISO);
  const url = new URL(`${cfg.baseUrl.replace(/\/$/, "")}/class/classes`);
  url.searchParams.set("StartDateTime", start);
  url.searchParams.set("EndDateTime", end);

  const resp = await fetch(url.toString(), {
    method: "GET",
    signal: AbortSignal.timeout(2500), // fail fast so GHL doesn't time out waiting
    headers: {
      "Api-Key": cfg.apiKey,
      "SiteId": cfg.siteId,
      "Content-Type": "application/json",
    },
  });

  const text = await resp.text();
  let json = null;
  try { json = JSON.parse(text); } catch {}

  if (!resp.ok) {
    const msg = json?.Error?.Message || json?.Message || text || `HTTP ${resp.status}`;
    throw new Error(`Mindbody schedule error (${resp.status}): ${msg}`);
  }

  const rawClasses = json?.Classes || json?.classes || json?.Items || json?.items || json || [];
  return { raw: json, classes: normalizeMindbodyClasses(rawClasses) };
}

function timeStringToMinutes(t) {
  const s = String(t || "");
  const m = s.match(/(\d{1,2}):(\d{2})\s*(AM|PM)/i);
  if (!m) return null;
  let hh = parseInt(m[1], 10);
  const mm = parseInt(m[2], 10);
  const ap = m[3].toUpperCase();
  if (ap === "PM" && hh !== 12) hh += 12;
  if (ap === "AM" && hh === 12) hh = 0;
  return hh * 60 + mm;
}

function filterClassesByTimeOfDay(classes, timeOfDay) {
  if (!timeOfDay) return classes;
  return (classes || []).filter((c) => {
    const mins = timeStringToMinutes(c?.time);
    if (mins === null) return false;
    if (timeOfDay === "morning") return mins < 12 * 60;
    if (timeOfDay === "afternoon") return mins >= 12 * 60 && mins < 17 * 60;
    if (timeOfDay === "evening") return mins >= 17 * 60;
    return true;
  });
}

function sortClassesByStartTime(classes) {
  const arr = Array.isArray(classes) ? classes : [];
  arr.sort((a, b) => {
    const am = timeStringToMinutes(a?.time);
    const bm = timeStringToMinutes(b?.time);
    return (am === null ? 99999 : am) - (bm === null ? 99999 : bm);
  });
  return arr;
}

// ---------------------------
// Token + booking/cancel
// ---------------------------
let tokenCache = { value: null, expiresAt: 0 };

async function getMindbodyUserToken(cfg) {
  const now = Date.now();
  if (tokenCache.value && tokenCache.expiresAt > now + 5 * 60 * 1000) return tokenCache.value;
  if (!cfg.tokenUsername || !cfg.tokenPassword) return null;

  const url = `${cfg.baseUrl.replace(/\/$/, "")}/usertoken/issue`;
  const resp = await fetch(url, {
    method: "POST",
    headers: { "Api-Key": cfg.apiKey, "SiteId": cfg.siteId, "Content-Type": "application/json" },
    body: JSON.stringify({ Username: cfg.tokenUsername, Password: cfg.tokenPassword }),
  });

  const text = await resp.text();
  let json = null;
  try { json = JSON.parse(text); } catch {}

  if (!resp.ok) {
    const msg = json?.Error?.Message || json?.Message || text || `HTTP ${resp.status}`;
    throw new Error(`Mindbody token error (${resp.status}): ${msg}`);
  }

  const accessToken = json?.AccessToken || json?.access_token || json?.Token || json?.token;
  const expiresIn = Number(json?.ExpiresIn || json?.expires_in || 3600);
  if (!accessToken) throw new Error("Mindbody token error: missing AccessToken in response");

  tokenCache.value = accessToken;
  tokenCache.expiresAt = Date.now() + expiresIn * 1000;
  return accessToken;
}

async function mbGet(cfg, path, token, paramsObj = {}) {
  const url = new URL(`${cfg.baseUrl.replace(/\/$/, "")}${path}`);
  for (const [k, v] of Object.entries(paramsObj)) {
    if (v !== undefined && v !== null && String(v).trim() !== "") url.searchParams.set(k, String(v));
  }
  const headers = { "Api-Key": cfg.apiKey, "SiteId": cfg.siteId, "Content-Type": "application/json" };
  if (token) headers["Authorization"] = `Bearer ${token}`;

  const resp = await fetch(url.toString(), { method: "GET", headers });
  const text = await resp.text();
  let json = null;
  try { json = JSON.parse(text); } catch {}

  if (!resp.ok) {
    const msg = json?.Error?.Message || json?.Message || text || `HTTP ${resp.status}`;
    throw new Error(`Mindbody GET ${path} error (${resp.status}): ${msg}`);
  }
  return json;
}

async function mbPost(cfg, path, token, bodyObj = {}) {
  const url = `${cfg.baseUrl.replace(/\/$/, "")}${path}`;
  const headers = { "Api-Key": cfg.apiKey, "SiteId": cfg.siteId, "Content-Type": "application/json" };
  if (token) headers["Authorization"] = `Bearer ${token}`;

  const resp = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify(bodyObj),
  });

  const text = await resp.text();
  let json = null;
  try { json = JSON.parse(text); } catch {}

  if (!resp.ok) {
    const msg = json?.Error?.Message || json?.Message || text || `HTTP ${resp.status}`;
    throw new Error(`Mindbody POST ${path} error (${resp.status}): ${msg}`);
  }
  return json;
}

function normalizePhone(phoneRaw) {
  const p = decodeMaybe(phoneRaw).trim();
  if (!p) return "";
  return p.replace(/[^\d+]/g, "");
}

async function findClientId(cfg, token, email, phone) {
  const searchText = email || phone || "";
  if (!searchText) return null;
  const json = await mbGet(cfg, "/client/clients", token, { SearchText: searchText, Limit: 10, Offset: 0 });
  const clients = json?.Clients || json?.clients || [];
  if (!Array.isArray(clients) || clients.length === 0) return null;
  if (email) {
    const exact = clients.find((c) => (c?.Email || c?.email || "").toLowerCase() === email.toLowerCase());
    if (exact?.Id) return String(exact.Id);
  }
  const first = clients[0];
  if (first?.Id) return String(first.Id);
  return null;
}

async function createClient(cfg, token, firstName, lastName, email, phone) {
  const payload = { FirstName: firstName, LastName: lastName };
  if (email) payload.Email = email;
  if (phone) payload.MobilePhone = phone;
  const json = await mbPost(cfg, "/client/addclient", token, payload);
  const client = json?.Client || json?.client || json;
  const id = client?.Id || client?.ClientId || client?.id;
  if (!id) throw new Error("Client created but no client ID returned.");
  return String(id);
}

async function bookClientIntoClass(cfg, token, clientId, classId) {
  return await mbPost(cfg, "/class/addclienttoclass", token, { ClientId: clientId, ClassId: Number(classId) });
}

async function cancelClientFromClass(cfg, token, clientId, classId) {
  return await mbPost(cfg, "/class/removeclientfromclass", token, { ClientId: clientId, ClassId: Number(classId) });
}

// ---------------------------
// Shared handler for GET + POST
// ---------------------------
async function mindbodyHandler(req, res) {
  const q = req.query || {};
  const b = req.body || {};

  const action = decodeMaybe(q.action ?? b.action).trim() || "ping";
  const studioKey = decodeMaybe(q.studioKey ?? b.studioKey).trim() || "oxygen_roundhouse";
  const timezone = decodeMaybe(q.timezone ?? b.timezone).trim() || "America/Vancouver";
  const source = decodeMaybe(q.source ?? b.source).trim() || "agencyvault";

  const dateParamRaw =
    q.date ?? b.date ??
    q.datePhrase ?? b.datePhrase ??
    q.dateParam ?? b.dateParam;

  const datePhraseRaw = decodeMaybe(dateParamRaw).trim();
  const classId = decodeMaybe(q.classId ?? b.classId).trim();

  const firstName = decodeMaybe(
    q.firstName ?? b.firstName ?? q.client_first_name ?? b.client_first_name
  ).trim();
  const lastName = decodeMaybe(
    q.lastName ?? b.lastName ?? q.client_last_name ?? b.client_last_name
  ).trim();
  const email = decodeMaybe(q.email ?? b.email).trim();
  const phone = normalizePhone(q.phone ?? b.phone ?? q.mobilephone ?? b.mobilephone);
  const isNewClientRaw = decodeMaybe(
    q.isNewClient ?? b.isNewClient ?? q.is_new_client ?? b.is_new_client
  ).trim().toLowerCase();

  console.log("--------------------------------------------------");
  console.log(`${req.method} /ghl/mindbody | action:`, action);
  console.log("query:", q);
  console.log("body:", b);

  // ---------------------------
  // PING
  // ---------------------------
  if (action === "ping") {
    return respondJSON(res, {
      success: true,
      speech: "pong",
    });
  }

  const cfg = getMindbodyConfig();
  const liveConfigured = cfg.apiKey && cfg.siteId && cfg.baseUrl;

  // ---------------------------
  // GET SCHEDULE
  // ---------------------------
  if (
    action === "get_schedule" ||
    action === "get_schedule_web" ||
    action === "get_schedule_by_date"
  ) {
    const resolved = resolveDatePhraseToISO(datePhraseRaw || "today", timezone);

    if (!resolved.ok) {
      return respondJSON(res, {
        success: false,
        speech: `I couldn't understand that date. What day did you mean?`,
        error: `Could not parse date: ${resolved.reason}`,
      });
    }

    const requestedDate = resolved.requestedDate;
    const spokenDate = buildSpokenDateLabel(requestedDate, timezone);

    // ---- MOCK ----
    if (cfg.mode !== "live") {
      let classes = buildMockSchedule(requestedDate);
      classes = sortClassesByStartTime(classes);

      if (!classes.length) {
        return respondJSON(res, {
          success: false,
          speech: `I couldn't find any classes for ${spokenDate}. Would you like a different date?`,
          slots: [],
        });
      }

      const speech = buildScheduleSay(spokenDate, classes);
      const slots = classes.slice(0, 12).map((c) => ({
        id: String(c.id), time: c.time, name: c.name, instructor: c.instructor || "", bookable: !!c.bookable,
      }));

      return respondJSON(res, {
        success: true,
        speech,
        slots,
      });
    }

    // ---- LIVE not configured ----
    if (!liveConfigured) {
      return respondJSON(res, {
        success: false,
        speech: "I'm not connected to Mindbody yet on my end.",
        error: "Set MINDBODY_API_KEY, MINDBODY_SITE_ID, MINDBODY_BASE_URL.",
      });
    }

    // ---- LIVE ----
    try {
      // Check cache first for instant response
      const cached = getCached(requestedDate);
      if (cached) {
        console.log(`cache hit: ${requestedDate}`);
        return respondJSON(res, {
          success: true,
          speech: cached.speech,
          slots: cached.slots,
        });
      }

      const schedule = await fetchMindbodyScheduleForDate(cfg, requestedDate);
      let classes = schedule.classes;
      classes = sortClassesByStartTime(classes);

      if (!classes.length) {
        return respondJSON(res, {
          success: false,
          speech: `I couldn't find any classes for ${spokenDate}. Would you like a different date?`,
          slots: [],
        });
      }

      const speech = buildScheduleSay(spokenDate, classes);
      const slots = classes.slice(0, 12).map((c) => ({
        id: String(c.id), time: c.time, name: c.name, instructor: c.instructor || "", bookable: !!c.bookable,
      }));

      return respondJSON(res, {
        success: true,
        speech,
        slots,
      });
    } catch (err) {
      console.log("Mindbody live schedule error:", err?.message || err);
      return respondJSON(res, {
        success: false,
        speech: "I'm not able to pull the schedule up on my end right now. Would you like me to try again?",
        slots: [],
        error: err?.message || "Mindbody live schedule error",
      });
    }
  }

  // ---------------------------
  // BOOK CLASS
  // ---------------------------
  if (action === "book_class") {
    if (cfg.mode !== "live") {
      return respondJSON(res, {
        success: false,
        speech: "Booking is only available in live mode.",
      });
    }
    if (!liveConfigured) {
      return respondJSON(res, {
        success: false,
        speech: "Mindbody live is not configured yet.",
        error: "Set MINDBODY_API_KEY, MINDBODY_SITE_ID, MINDBODY_BASE_URL.",
      });
    }
    if (!classId) {
      return respondJSON(res, {
        success: false,
        speech: "I'm missing the class selection.",
        error: "Missing classId",
      });
    }

    try {
      const token = await getMindbodyUserToken(cfg);
      if (!token) {
        return respondJSON(res, {
          success: false,
          speech: "Booking isn't enabled yet on our side.",
          error: "Set MINDBODY_TOKEN_USERNAME and MINDBODY_TOKEN_PASSWORD.",
        });
      }

      const isNewClient = (isNewClientRaw === "true" || isNewClientRaw === "yes" || isNewClientRaw === "1");
      let clientId = await findClientId(cfg, token, email, phone);
      let created = false;

      if (!clientId) {
        if (!firstName || !lastName) {
          return respondJSON(res, {
            success: false,
            speech: "I just need your first and last name to complete the booking.",
            error: "Missing firstName/lastName to create new client.",
          });
        }
        clientId = await createClient(cfg, token, firstName, lastName, email, phone);
        created = true;
      }

      await bookClientIntoClass(cfg, token, clientId, classId);

      const speech = (created || isNewClient)
        ? "You're booked! I'll send you a waiver link right after this call to complete before class."
        : "You're booked! Is there anything else I can help you with?";

      return respondJSON(res, {
        success: true,
        speech,
      });
    } catch (err) {
      console.log("Mindbody book_class error:", err?.message || err);
      return respondJSON(res, {
        success: false,
        speech: "I couldn't complete that booking right now.",
        error: err?.message || "Mindbody booking error",
      });
    }
  }

  // ---------------------------
  // CANCEL CLASS
  // ---------------------------
  if (action === "cancel_class") {
    if (cfg.mode !== "live") {
      return respondJSON(res, {
        success: false,
        speech: "Canceling is only available in live mode.",
      });
    }
    if (!liveConfigured) {
      return respondJSON(res, {
        success: false,
        speech: "Mindbody live is not configured yet.",
        error: "Set MINDBODY_API_KEY, MINDBODY_SITE_ID, MINDBODY_BASE_URL.",
      });
    }
    if (!classId) {
      return respondJSON(res, {
        success: false,
        speech: "I'm missing the class to cancel.",
        error: "Missing classId",
      });
    }

    try {
      const token = await getMindbodyUserToken(cfg);
      if (!token) {
        return respondJSON(res, {
          success: false,
          speech: "Canceling isn't enabled yet on our side.",
          error: "Set MINDBODY_TOKEN_USERNAME and MINDBODY_TOKEN_PASSWORD.",
        });
      }

      const clientId = await findClientId(cfg, token, email, phone);
      if (!clientId) {
        return respondJSON(res, {
          success: false,
          speech: "I couldn't find your account to cancel that booking.",
          error: "No client found for provided email/phone.",
        });
      }

      await cancelClientFromClass(cfg, token, clientId, classId);

      return respondJSON(res, {
        success: true,
        speech: "Done — you're canceled. Would you like to book a different class instead?",
      });
    } catch (err) {
      console.log("Mindbody cancel_class error:", err?.message || err);
      return respondJSON(res, {
        success: false,
        speech: "I couldn't cancel that right now.",
        error: err?.message || "Mindbody cancel error",
      });
    }
  }

  // ---------------------------
  // Unknown action
  // ---------------------------
  return respondJSON(res, {
    success: false,
    speech: `I didn't recognize that request.`,
    error: `Unknown action: ${action}`,
  });
}

// ---------------------------
// Routes — POST and GET both use the same handler
// ---------------------------
app.post("/ghl/mindbody", mindbodyHandler);
app.get("/ghl/mindbody", mindbodyHandler);

// Plain text + JSON endpoint — supports both GET and POST
// Returns plain text body AND JSON with multiple field names GHL might read
async function speakHandler(req, res) {
  const b = req.body || {};
  const q = req.query || {};
  const datePhraseRaw = decodeMaybe(q.date ?? b.date ?? "today");
  const timezone = "America/Vancouver";

  const resolved = resolveDatePhraseToISO(datePhraseRaw || "today", timezone);

  let speech = "";

  if (!resolved.ok) {
    speech = "I couldn't understand that date. What day did you mean?";
  } else {
    const requestedDate = resolved.requestedDate;
    const spokenDate = buildSpokenDateLabel(requestedDate, timezone);

    const cached = getCached(requestedDate);
    if (cached) {
      console.log(`speak cache hit: ${requestedDate}`);
      speech = cached.speech;
    } else {
      try {
        const cfg = {
          mode: process.env.MINDBODY_MODE || "live",
          apiKey: process.env.MINDBODY_API_KEY || "",
          siteId: process.env.MINDBODY_SITE_ID || "",
          baseUrl: process.env.MINDBODY_BASE_URL || "https://api.mindbodyonline.com/public/v6",
          timezone,
        };
        const schedule = await fetchMindbodyScheduleForDate(cfg, requestedDate);
        const classes = sortClassesByStartTime(schedule.classes);
        speech = buildScheduleSay(spokenDate, classes);
      } catch (e) {
        speech = "I wasn't able to pull the schedule right now. Would you like me to connect you with the front desk?";
      }
    }
  }

  console.log("SPEAK RESPONDING:", speech.slice(0, 140));

  /* ==========================================================
     OLD JSON MULTI-FIELD RESPONSE (COMMENTED OUT)
     This caused GPT-4o Voice runtime parsing issues.
  ========================================================== */

  /*
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  return res.status(200).json({
    success: true,
    speech: speech,
    message: speech,
    text: speech,
    response: speech,
    result: speech,
    output: speech,
    say: speech,
    answer: speech,
    content: speech,
  });
  */

  /* ==========================================================
     NEW VOICE-SAFE RESPONSE
     Returns RAW TEXT ONLY
  ========================================================== */

  res.setHeader("Content-Type", "text/plain; charset=utf-8");
  return res.status(200).send(speech);
}

app.post("/ghl/mindbody/speak", speakHandler);
app.get("/ghl/mindbody/speak", speakHandler);

app.get("/", (_req, res) => res.status(200).send("ok"));

app.listen(PORT, () => {
  console.log(`Server listening on ${PORT} | buildId: ${BUILD_ID}`);
  const warmCfg = {
    mode: process.env.MINDBODY_MODE || "live",
    apiKey: process.env.MINDBODY_API_KEY || "",
    siteId: process.env.MINDBODY_SITE_ID || "",
    baseUrl: process.env.MINDBODY_BASE_URL || "https://api.mindbodyonline.com/public/v6",
    timezone: "America/Vancouver",
  };
  startCacheWarmer(warmCfg);
});
