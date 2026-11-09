'use strict';
// Separate from manual author analysis: never changes a verdict or a mute list.
let ambienceEnabled = false;
let ambienceEpoch = 0;
let ambienceBusy = false;
let ambienceTimer = null;
let ambiencePauseUntil = 0;
let ambienceStates = {};
const ambienceSamples = new Map();
const ambienceSeen = new Map();
const ambienceControllers = new Set();
let ambienceBudget = { at: 0, count: 0 };

function configureAmbience(cfg) {
  const enabled = cfg.enabled !== false && cfg.ambiencePause !== false;
  if (ambienceEnabled === enabled) return;
  ambienceEnabled = enabled;
  ambienceEpoch++;
  ambiencePauseUntil = 0;
  clearTimeout(ambienceTimer);
  ambienceTimer = null;
  ambienceSamples.clear();
  for (const ctrl of ambienceControllers) ctrl.abort();
  if (!enabled) {
    ambienceStates = {};
    chrome.storage.local.set({ csg_ambience_state: ambienceStates, csg_ambience_error: '' });
  }
}

function scheduleAmbience() {
  if (!ambienceEnabled || ambienceBusy || ambienceTimer || ambiencePauseUntil > Date.now()) return;
  const now = Date.now();
  let delay = Infinity;
  for (const sample of ambienceSamples.values()) {
    sample.rows = sample.rows.filter((x) => now - x.at <= CSG_AMBIENCE.LIMITS.WINDOW_MS);
    const state = ambienceStates[sample.channel] || {};
    if (sample.rows.length < CSG_AMBIENCE.LIMITS.MIN || state.cooldownUntil > now) continue;
    delay = Math.min(delay, Math.max(1, sample.lastAt + CSG_AMBIENCE.LIMITS.INTERVAL_MS - now));
  }
  if (!Number.isFinite(delay)) return;
  ambienceTimer = setTimeout(() => {
    ambienceTimer = null;
    runAmbience().catch((e) => recordCrash('ambience', e));
  }, delay);
}

function captureAmbience(msg, sender) {
  if (!ambienceEnabled || !sender || !sender.tab || !sender.tab.active || msg.ambienceEligible !== true || !self.CSG_AMBIENCE) return;
  const now = Date.now();
  const at = Number(msg.capturedAt);
  const channel = String(msg.channel || '').toLowerCase();
  if (!/^(twitch|kick)\/[a-z0-9_-]+$/.test(channel) || !String(msg.id || '').startsWith('csg_') ||
      !Number.isFinite(at) || at > now + 2000 || now - at > 15000 || !msg.text || !msg.author) return;
  const seenKey = sender.tab.id + '\n' + channel + '\n' + msg.id;
  if (ambienceSeen.has(seenKey)) return;
  ambienceSeen.set(seenKey, now);
  while (ambienceSeen.size > 2000) ambienceSeen.delete(ambienceSeen.keys().next().value);
  const state = ambienceStates[channel] || {};
  if (state.cooldownUntil > now || ambiencePauseUntil > now) return;
  const key = sender.tab.id + '\n' + channel;
  const previous = ambienceSamples.get(key);
  const sample = previous && previous.tabUrl === sender.tab.url ? previous :
    { rows: [], lastAt: now, channel, tabId: sender.tab.id, tabUrl: sender.tab.url };
  sample.rows = sample.rows.filter((x) => now - x.at <= CSG_AMBIENCE.LIMITS.WINDOW_MS);
  sample.rows.push({ id: String(msg.id), author: String(msg.author).slice(0, 60), text: String(msg.text).slice(0, 2000), at,
    replyTo: String(msg.replyTo || '').slice(0, 60), replyQuote: String(msg.replyQuote || '').slice(0, 500) });
  if (sample.rows.length > CSG_AMBIENCE.LIMITS.MAX) sample.rows.shift();
  ambienceSamples.set(key, sample);
  while (ambienceSamples.size > 8) ambienceSamples.delete(ambienceSamples.keys().next().value);
  scheduleAmbience();
}

async function runAmbience() {
  if (!ambienceEnabled || ambienceBusy || ambiencePauseUntil > Date.now()) return;
  ambienceBusy = true;
  const epoch = ambienceEpoch;
  try {
    for (const sample of ambienceSamples.values()) {
      const now = Date.now();
      const state = ambienceStates[sample.channel] || {};
      sample.rows = sample.rows.filter((x) => now - x.at <= CSG_AMBIENCE.LIMITS.WINDOW_MS);
      if (sample.rows.length < CSG_AMBIENCE.LIMITS.MIN || now - sample.lastAt < CSG_AMBIENCE.LIMITS.INTERVAL_MS || state.cooldownUntil > now) continue;
      const focused = await liveTabFocused(sample);
      if (!focused || !ambienceEnabled || epoch !== ambienceEpoch) {
        sample.lastAt = now;
        continue;
      }
      if (!ambienceBudget.at || now - ambienceBudget.at >= 3600000) ambienceBudget = { at: now, count: 0 };
      if (ambienceBudget.count >= 240) { ambiencePauseUntil = ambienceBudget.at + 3600000; break; }
      const engine = await getEngine();
      const lane = openLanes(engine)[0] || CHAIN.find((l) => laneKey(engine, l)) || CHAIN[0];
      if (!ambienceEnabled || epoch !== ambienceEpoch ||
          ambienceSamples.get(sample.tabId + '\n' + sample.channel) !== sample) continue;
      const key = lane && laneKey(engine, lane);
      if (!key) throw new Error('SuperGrok deconnecte');
      const items = sample.rows.slice();
      // Only messages captured after this evaluation enter the next sample.
      sample.rows = [];
      sample.lastAt = now;
      ambienceBudget.count++;
      chrome.storage.local.set({ csg_ambience_budget: ambienceBudget });
      const p = CSG_AMBIENCE.prompt(sample.channel, items);
      const body = chatBody(lane, p.system, p.user, 4000);
      body.response_format = CSG_AMBIENCE.FORMAT;
      const waitMs = Math.max(laneMs(lane, 30000), 30000);
      const data = await llmFetch(laneUrl(lane, engine), key, body, waitMs, lane.path, ambienceControllers);
      if (!data || !data.choices || !data.choices[0] || data.choices[0].finish_reason !== 'stop') throw new Error('analyse ambiance tronquee');
      const result = CSG_AMBIENCE.parse(messageText(data), items);
      const stillFocused = await liveTabFocused(sample);
      if (!stillFocused || !ambienceEnabled || epoch !== ambienceEpoch || Date.now() - now > (waitMs + 15000) ||
          ambienceSamples.get(sample.tabId + '\n' + sample.channel) !== sample) continue;
      ambienceStates[sample.channel] = Object.assign(result, { at: Date.now(), err: '',
        until: result.hide ? Date.now() + CSG_AMBIENCE.LIMITS.PAUSE_MS : 0,
        cooldownUntil: result.hide ? Date.now() + CSG_AMBIENCE.LIMITS.COOLDOWN_MS : 0 });
      chrome.storage.local.set({ csg_ambience_state: ambienceStates });
      chrome.storage.local.set({ csg_ambience_error: '' });
    }
  } catch (e) {
    // Fail open. Errors never cause a chat to disappear.
    if (epoch === ambienceEpoch && ambienceEnabled) ambiencePauseUntil = Date.now() + 60000;
    const raw = String((e && e.message) || e);
    const msg = /llm_timeout|aborted|AbortError/i.test(raw) ? 'délai dépassé (timeout)' : raw.slice(0, 140);
    if (epoch === ambienceEpoch && ambienceEnabled) chrome.storage.local.set({ csg_ambience_error: msg });
  } finally {
    ambienceBusy = false;
    scheduleAmbience();
  }
}

function revealAmbience(channel) {
  const ch = String(channel || '').toLowerCase();
  ambienceEpoch++;
  for (const ctrl of ambienceControllers) ctrl.abort();
  ambienceStates[ch] = { until: 0, cooldownUntil: Date.now() + CSG_AMBIENCE.LIMITS.COOLDOWN_MS, at: Date.now() };
  for (const sample of ambienceSamples.values()) if (sample.channel === ch) sample.rows = [];
  chrome.storage.local.set({ csg_ambience_state: ambienceStates });
  return { ok: true };
}

chrome.storage.local.get({ csg_ambience_budget: null }, (v) => {
  if (v.csg_ambience_budget && Number.isFinite(v.csg_ambience_budget.at) && Number.isFinite(v.csg_ambience_budget.count)) {
    ambienceBudget = v.csg_ambience_budget;
  }
});
// Pause state intentionally ends on worker restart; local UI always expires it.
chrome.storage.local.set({ csg_ambience_state: {} });
