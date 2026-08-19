import L from "leaflet";
import "leaflet/dist/leaflet.css";
import iconUrl from "leaflet/dist/images/marker-icon.png";
import iconRetinaUrl from "leaflet/dist/images/marker-icon-2x.png";
import shadowUrl from "leaflet/dist/images/marker-shadow.png";
import "./style.css";

L.Icon.Default.mergeOptions({
  iconUrl,
  iconRetinaUrl,
  shadowUrl,
});

const WIKI_GEO =
  "https://en.wikipedia.org/w/api.php?action=query&list=geosearch&format=json&origin=*";
const GUIDE_API = "/api/guide";

const DEBOUNCE_MS = 550;
const MIN_RADIUS_M = 80;
const MAX_RADIUS_M = 50_000;
const GEO_LIMIT = 45;
const WALK_PROXIMITY_M = 45;
const MAX_HISTORY_TURNS = 16;

function degToRad(d) {
  return (d * Math.PI) / 180;
}

function distanceMeters(lat1, lon1, lat2, lon2) {
  const R = 6371000;
  const φ1 = degToRad(lat1);
  const φ2 = degToRad(lat2);
  const Δφ = degToRad(lat2 - lat1);
  const Δλ = degToRad(lon2 - lon1);
  const a =
    Math.sin(Δφ / 2) ** 2 +
    Math.cos(φ1) * Math.cos(φ2) * Math.sin(Δλ / 2) ** 2;
  return 2 * R * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

/** Search radius from map: ~distance from center to NE corner, clamped. */
function radiusFromMap(map) {
  const b = map.getBounds();
  const c = map.getCenter();
  if (!b || !c) return 2000;
  const ne = b.getNorthEast();
  const r = distanceMeters(c.lat, c.lng, ne.lat, ne.lng);
  return Math.round(
    Math.min(MAX_RADIUS_M, Math.max(MIN_RADIUS_M, r * 1.05)),
  );
}

function debounce(fn, ms) {
  let t;
  return (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), ms);
  };
}

async function fetchNearbyLandmarks(lat, lon, radiusM) {
  const url = `${WIKI_GEO}&gscoord=${lat}|${lon}&gsradius=${radiusM}&gslimit=${GEO_LIMIT}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Landmarks request failed (${res.status})`);
  const data = await res.json();
  const items = data?.query?.geosearch ?? [];
  return items.map((item) => ({
    pageId: item.pageid,
    title: item.title,
    lat: item.lat,
    lon: item.lon,
  }));
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function wikiArticleUrl(title) {
  const encoded = encodeURIComponent(title.replace(/ /g, "_"));
  return `https://en.wikipedia.org/wiki/${encoded}`;
}

function wikiLinkHtml(title) {
  return `<p class="feed-bubble__wiki"><a href="${wikiArticleUrl(title)}" target="_blank" rel="noopener noreferrer">Open full article on Wikipedia</a></p>`;
}

/**
 * Prefer voices that tend to sound more natural (neural / premium / common “assistant” names).
 */
function scoreVoiceForTourGuide(v) {
  const n = (v.name || "").toLowerCase();
  let s = 0;
  if (/neural|premium|enhanced|natural|wavenet/i.test(n)) s += 45;
  if (/google us english|google uk english|google english/i.test(n)) s += 38;
  if (
    /samantha|karen|aaron|nicky|fiona|daniel|tessa|moira|martha|alice|victoria|serena|joanna|kendra|kimberly|emma|ivy|susan|michelle|amelie|flo/i.test(
      n,
    )
  )
    s += 30;
  if (v.localService) s += 12;
  if (v.lang === "en-US") s += 18;
  else if (v.lang.startsWith("en-GB")) s += 14;
  else if (v.lang.startsWith("en-AU")) s += 10;
  else if (v.lang.startsWith("en")) s += 6;
  if (/zira|stephen|male robot/i.test(n)) s -= 20;
  return s;
}

function pickTourGuideVoice() {
  const all = window.speechSynthesis?.getVoices?.() ?? [];
  const english = all.filter((v) => v.lang.startsWith("en"));
  const pool = english.length ? english : all;
  if (pool.length === 0) return null;
  return [...pool].sort(
    (a, b) => scoreVoiceForTourGuide(b) - scoreVoiceForTourGuide(a),
  )[0];
}

/** Speak a single, already-natural-sounding line of guide dialogue (LLM narration or chat replies). */
function speakText(text, onEnd) {
  if (!window.speechSynthesis) {
    onEnd?.();
    return;
  }
  speechSynthesis.getVoices();
  speechSynthesis.cancel();

  const u = new SpeechSynthesisUtterance(text);
  u.lang = "en-US";
  u.volume = 1;
  u.rate = 0.95;
  u.pitch = 1.02;
  const voice = pickTourGuideVoice();
  if (voice) u.voice = voice;

  const done = () => onEnd?.();
  u.onerror = done;
  u.onend = done;

  speechSynthesis.speak(u);
}

/** Fallback narration (raw Wikipedia extract) used when the AI guide API is unavailable. */
function buildTourGuideParts(title, wikiText) {
  const welcome = `Welcome! I'm really glad you're exploring with us today. Our next stop is ${title}. Let me tell you what makes this place worth your time.`;
  const story = wikiText.trim();
  return { welcome, story };
}

function speakTourGuide(title, wikiText, onEnd) {
  if (!window.speechSynthesis) {
    onEnd?.();
    return;
  }
  speechSynthesis.getVoices();
  speechSynthesis.cancel();

  const { welcome, story } = buildTourGuideParts(title, wikiText);
  const voice = pickTourGuideVoice();
  const applyVoice = (u) => {
    u.lang = "en-US";
    u.volume = 1;
    if (voice) u.voice = voice;
  };

  const partWelcome = new SpeechSynthesisUtterance(welcome);
  applyVoice(partWelcome);
  partWelcome.rate = 0.91;
  partWelcome.pitch = 1.06;

  const partStory = new SpeechSynthesisUtterance(story);
  applyVoice(partStory);
  partStory.rate = 0.88;
  partStory.pitch = 1.04;

  const done = () => onEnd?.();
  partWelcome.onerror = done;
  partStory.onerror = done;
  partStory.onend = done;
  partWelcome.onend = () => {
    speechSynthesis.speak(partStory);
  };

  speechSynthesis.speak(partWelcome);
}

function ensureVoicesLoaded() {
  if (!window.speechSynthesis) return;
  speechSynthesis.getVoices();
  speechSynthesis.onvoiceschanged = () => {
    speechSynthesis.getVoices();
  };
}

function getSpeechRecognitionCtor() {
  return window.SpeechRecognition || window.webkitSpeechRecognition || null;
}

async function fetchIntroText(title) {
  const url = `https://en.wikipedia.org/w/api.php?action=query&prop=extracts&exintro=1&explaintext=1&titles=${encodeURIComponent(title)}&format=json&origin=*`;
  const res = await fetch(url);
  if (!res.ok) throw new Error("Could not load article text.");
  const data = await res.json();
  const pages = data?.query?.pages;
  if (!pages) throw new Error("No article text.");
  const page = Object.values(pages)[0];
  if (page?.missing) throw new Error("Article not found.");
  let text = page?.extract || "";
  text = text.replace(/\[\d+\]/g, " ");
  text = text.replace(/\s+/g, " ").trim();
  if (text.length > 1200) text = `${text.slice(0, 1200).trim()}…`;
  if (!text) throw new Error("No introduction text for this place.");
  return text;
}

async function callGuideAPI(payload) {
  const res = await fetch(GUIDE_API, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(data?.error || `Guide request failed (${res.status})`);
  }
  if (!data?.text) throw new Error("The guide gave an empty response.");
  return data.text;
}

function createApp() {
  const app = document.querySelector("#app");
  if (!app) return;

  app.innerHTML = `
    <div class="map-shell">
      <div id="map" class="map" role="application" aria-label="Map"></div>
      <div class="map-overlay map-overlay--top">
        <div class="map-overlay__row">
          <div>
            <p class="map-title">Tour Guide</p>
            <p class="map-hint" id="map-hint">Street map (not satellite). Zoom in to see blocks and building shapes. Use the layers control (top-right) to switch styles.</p>
          </div>
          <button type="button" class="btn-walk-tour" id="btn-walk-tour" aria-pressed="false">
            🔈 Start Walking Tour
          </button>
        </div>
      </div>
      <button type="button" class="btn-recenter" id="btn-recenter" title="Center on my location" aria-label="Center on my location">
        ⊕
      </button>
      <div class="landmark-sheet" id="landmark-sheet" hidden aria-hidden="true">
        <button type="button" class="landmark-sheet__backdrop" id="landmark-backdrop" tabindex="-1" aria-label="Close"></button>
        <div
          class="landmark-sheet__panel"
          role="dialog"
          aria-modal="true"
          aria-labelledby="landmark-sheet-title"
        >
          <header class="landmark-sheet__header">
            <h2 class="landmark-sheet__title" id="landmark-sheet-title"></h2>
            <button type="button" class="landmark-sheet__close" id="landmark-sheet-close" aria-label="Close">×</button>
          </header>
          <div class="landmark-sheet__feed" id="landmark-feed" aria-live="polite"></div>
          <footer class="landmark-sheet__footer">
            <form class="ask-row" id="ask-form">
              <button type="button" class="btn-mic" id="btn-mic" hidden title="Ask by voice" aria-label="Ask by voice">🎤</button>
              <input type="text" class="ask-input" id="ask-input" placeholder="Ask the guide a question…" autocomplete="off" />
              <button type="submit" class="btn-ask-send" id="btn-ask-send">Ask</button>
            </form>
            <button type="button" class="btn-stop-audio" id="btn-stop-speech" hidden>
              Stop voice
            </button>
          </footer>
        </div>
      </div>
    </div>
  `;

  ensureVoicesLoaded();

  const mapEl = app.querySelector("#map");
  const hintEl = app.querySelector("#map-hint");
  const btnRecenter = app.querySelector("#btn-recenter");
  const btnWalkTour = app.querySelector("#btn-walk-tour");
  const landmarkSheet = app.querySelector("#landmark-sheet");
  const landmarkBackdrop = app.querySelector("#landmark-backdrop");
  const landmarkTitle = app.querySelector("#landmark-sheet-title");
  const landmarkFeed = app.querySelector("#landmark-feed");
  const btnLandmarkClose = app.querySelector("#landmark-sheet-close");
  const askForm = app.querySelector("#ask-form");
  const askInput = app.querySelector("#ask-input");
  const btnMic = app.querySelector("#btn-mic");
  const btnStopSpeech = app.querySelector("#btn-stop-speech");

  let map;
  let userMarker;
  const landmarkMarkers = [];
  let userPos = null;
  let loadToken = 0;
  /** @type {string | null} */
  let currentLandmarkTitle = null;
  /** Raw landmarks currently shown on the map, used for walking-tour proximity checks. */
  let currentLandmarks = [];
  /** Landmarks already introduced this session (tapped or auto-narrated). */
  const narratedIds = new Set();
  /** Landmarks waiting to be auto-narrated as the user walks. */
  let narrationQueue = [];
  let walkingTourActive = false;
  /** Shared conversation memory across the whole walk, so the guide "remembers" prior stops. */
  let conversationHistory = [];

  function trimHistory() {
    if (conversationHistory.length > MAX_HISTORY_TURNS) {
      conversationHistory.splice(0, conversationHistory.length - MAX_HISTORY_TURNS);
    }
  }

  function clearLandmarkMarkers() {
    while (landmarkMarkers.length) {
      const m = landmarkMarkers.pop();
      map?.removeLayer(m);
    }
  }

  function checkProximity(lat, lng) {
    if (!walkingTourActive) return;
    for (const place of currentLandmarks) {
      if (narratedIds.has(place.pageId)) continue;
      if (narrationQueue.some((p) => p.pageId === place.pageId)) continue;
      const d = distanceMeters(lat, lng, place.lat, place.lon);
      if (d <= WALK_PROXIMITY_M) {
        narrationQueue.push(place);
      }
    }
    processNarrationQueue();
  }

  function processNarrationQueue() {
    if (!walkingTourActive) {
      narrationQueue = [];
      return;
    }
    if (!landmarkSheet.hidden) return;
    const next = narrationQueue.shift();
    if (!next) return;
    openLandmarkSheet(next, { auto: true });
  }

  async function refreshLandmarks() {
    if (!map) return;
    const c = map.getCenter();
    const lat = c.lat;
    const lon = c.lng;
    const radiusM = radiusFromMap(map);
    const myToken = ++loadToken;

    hintEl.textContent = "Loading landmarks…";

    try {
      const raw = await fetchNearbyLandmarks(lat, lon, radiusM);
      if (myToken !== loadToken) return;

      clearLandmarkMarkers();
      currentLandmarks = raw;

      for (const place of raw) {
        const marker = L.marker([place.lat, place.lon], {
          title: place.title,
        }).addTo(map);
        marker.on("click", () => onLandmarkClick(place));
        landmarkMarkers.push(marker);
      }

      hintEl.textContent = `${raw.length} place${raw.length === 1 ? "" : "s"} in view (~${formatRadius(radiusM)} search). Tap a pin for details.`;

      if (userPos) checkProximity(userPos.lat, userPos.lng);
    } catch (e) {
      if (myToken !== loadToken) return;
      hintEl.textContent =
        e instanceof Error ? e.message : "Could not load landmarks.";
    }
  }

  const debouncedRefresh = debounce(refreshLandmarks, DEBOUNCE_MS);

  function formatRadius(m) {
    if (m < 1000) return `${m} m`;
    return `${(m / 1000).toFixed(1)} km`;
  }

  function addFeedBubble(role, html) {
    const div = document.createElement("div");
    div.className = `feed-bubble feed-bubble--${role}`;
    div.innerHTML = html;
    landmarkFeed.appendChild(div);
    landmarkFeed.scrollTop = landmarkFeed.scrollHeight;
    return div;
  }

  function stopListening() {
    if (listening) recognizer?.abort?.();
    listening = false;
    btnMic?.classList.remove("btn-mic--active");
  }

  function closeLandmarkSheet() {
    window.speechSynthesis?.cancel();
    stopListening();
    btnStopSpeech.hidden = true;
    landmarkSheet.hidden = true;
    landmarkSheet.setAttribute("aria-hidden", "true");
    currentLandmarkTitle = null;
    processNarrationQueue();
  }

  function openLandmarkSheet(place, opts = {}) {
    const auto = !!opts.auto;
    window.speechSynthesis?.cancel();
    stopListening();
    btnStopSpeech.hidden = true;
    narratedIds.add(place.pageId);
    currentLandmarkTitle = place.title;
    landmarkTitle.textContent = place.title;
    landmarkFeed.innerHTML = "";
    askInput.disabled = false;
    if (btnMic) btnMic.disabled = false;
    landmarkSheet.hidden = false;
    landmarkSheet.setAttribute("aria-hidden", "false");
    if (!auto) askInput.focus({ preventScroll: true });

    const loadingBubble = addFeedBubble(
      "guide loading",
      '<span class="feed-bubble__loading">Getting to know this place…</span>',
    );

    void (async () => {
      let extract = "";
      try {
        extract = await fetchIntroText(place.title);
      } catch {
        extract = "";
      }

      try {
        const narration = await callGuideAPI({
          mode: "narrate",
          landmark: { title: place.title, extract },
        });
        loadingBubble.remove();
        addFeedBubble(
          "guide",
          `<p>${escapeHtml(narration)}</p>${wikiLinkHtml(place.title)}`,
        );
        conversationHistory.push({ role: "assistant", content: narration });
        trimHistory();
        btnStopSpeech.hidden = false;
        speakText(narration, () => {
          btnStopSpeech.hidden = true;
        });
      } catch (e) {
        loadingBubble.remove();
        if (extract) {
          addFeedBubble(
            "guide",
            `<p>${escapeHtml(extract)}</p>${wikiLinkHtml(place.title)}`,
          );
          btnStopSpeech.hidden = false;
          speakTourGuide(place.title, extract, () => {
            btnStopSpeech.hidden = true;
          });
        } else {
          const msg =
            e instanceof Error
              ? e.message
              : "Could not load information about this place.";
          addFeedBubble("error", escapeHtml(msg));
        }
      }
    })();
  }

  function onLandmarkClick(place) {
    openLandmarkSheet(place);
  }

  async function handleAsk(question) {
    addFeedBubble("user", escapeHtml(question));
    const priorHistory = conversationHistory.slice();
    conversationHistory.push({ role: "user", content: question });
    btnStopSpeech.hidden = true;

    const thinkingBubble = addFeedBubble(
      "guide loading",
      '<span class="feed-bubble__loading">…</span>',
    );

    try {
      const answer = await callGuideAPI({
        mode: "chat",
        landmark: currentLandmarkTitle ? { title: currentLandmarkTitle } : null,
        history: priorHistory,
        question,
      });
      thinkingBubble.remove();
      addFeedBubble("guide", `<p>${escapeHtml(answer)}</p>`);
      conversationHistory.push({ role: "assistant", content: answer });
      trimHistory();
      btnStopSpeech.hidden = false;
      speakText(answer, () => {
        btnStopSpeech.hidden = true;
      });
    } catch (e) {
      thinkingBubble.remove();
      const msg =
        e instanceof Error ? e.message : "Could not get a response.";
      addFeedBubble("error", escapeHtml(msg));
    }
  }

  btnLandmarkClose.addEventListener("click", closeLandmarkSheet);
  landmarkBackdrop.addEventListener("click", closeLandmarkSheet);

  askForm.addEventListener("submit", (e) => {
    e.preventDefault();
    const q = askInput.value.trim();
    if (!q) return;
    askInput.value = "";
    void handleAsk(q);
  });

  let recognizer = null;
  let listening = false;
  const SpeechRecognitionCtor = getSpeechRecognitionCtor();
  if (SpeechRecognitionCtor) {
    btnMic.hidden = false;
    recognizer = new SpeechRecognitionCtor();
    recognizer.lang = "en-US";
    recognizer.interimResults = false;
    recognizer.maxAlternatives = 1;
    recognizer.onresult = (ev) => {
      const text = ev.results?.[0]?.[0]?.transcript?.trim();
      if (text) void handleAsk(text);
    };
    recognizer.onend = () => {
      listening = false;
      btnMic.classList.remove("btn-mic--active");
    };
    recognizer.onerror = () => {
      listening = false;
      btnMic.classList.remove("btn-mic--active");
    };
  }

  btnMic?.addEventListener("click", () => {
    if (!recognizer) return;
    if (listening) {
      recognizer.stop();
      return;
    }
    window.speechSynthesis?.cancel();
    listening = true;
    btnMic.classList.add("btn-mic--active");
    try {
      recognizer.start();
    } catch {
      listening = false;
      btnMic.classList.remove("btn-mic--active");
    }
  });

  btnStopSpeech.addEventListener("click", () => {
    window.speechSynthesis?.cancel();
    btnStopSpeech.hidden = true;
  });

  btnWalkTour.addEventListener("click", () => {
    walkingTourActive = !walkingTourActive;
    btnWalkTour.textContent = walkingTourActive
      ? "🔊 Walking Tour: On"
      : "🔈 Start Walking Tour";
    btnWalkTour.classList.toggle("btn-walk-tour--active", walkingTourActive);
    btnWalkTour.setAttribute("aria-pressed", String(walkingTourActive));
    if (walkingTourActive) {
      speakText(
        "Walking tour is on. I'll speak up as we pass interesting places nearby.",
      );
      if (userPos) checkProximity(userPos.lat, userPos.lng);
    } else {
      narrationQueue = [];
      if (landmarkSheet.hidden) window.speechSynthesis?.cancel();
    }
  });

  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !landmarkSheet.hidden) {
      closeLandmarkSheet();
    }
  });

  function setUserMarkerPosition(lat, lng) {
    userPos = { lat, lng };
    if (userMarker) userMarker.setLatLng([lat, lng]);
    checkProximity(lat, lng);
  }

  function recenterMap() {
    if (!map || !userPos) return;
    map.setView([userPos.lat, userPos.lng], Math.max(map.getZoom(), 15));
  }

  btnRecenter.addEventListener("click", recenterMap);

  function initMap(lat, lng, zoom) {
    map = L.map(mapEl, {
      zoomControl: true,
      maxZoom: 19,
    }).setView([lat, lng], zoom);

    const attrOsm =
      '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>';
    const attrCarto = `${attrOsm} &copy; <a href="https://carto.com/attributions">CARTO</a>`;

    // Carto "Voyager": street-focused; building footprints show in many areas when zoomed in (not 3D, not satellite).
    const streetsLayer = L.tileLayer(
      "https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}.png",
      {
        maxZoom: 19,
        attribution: attrCarto,
      },
    );

    const standardLayer = L.tileLayer(
      "https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png",
      {
        maxZoom: 19,
        attribution: attrOsm,
      },
    );

    streetsLayer.addTo(map);

    L.control.layers(
      {
        "Streets (buildings)": streetsLayer,
        "Standard": standardLayer,
      },
      null,
      { position: "topright", collapsed: true },
    ).addTo(map);

    userMarker = L.circleMarker([lat, lng], {
      radius: 10,
      fillColor: "#4285F4",
      color: "#ffffff",
      weight: 2,
      opacity: 1,
      fillOpacity: 1,
    }).addTo(map);
    userMarker.bindTooltip("Your location", { permanent: false });

    map.on("moveend", () => debouncedRefresh());
    // Leaflet doesn't fire "moveend" for the initial setView() above, so
    // without this the map would sit empty until the user pans or zooms.
    refreshLandmarks();

    if (navigator.geolocation) {
      navigator.geolocation.watchPosition(
        (pos) => {
          setUserMarkerPosition(
            pos.coords.latitude,
            pos.coords.longitude,
          );
        },
        () => {},
        {
          enableHighAccuracy: true,
          maximumAge: 5000,
          timeout: 15000,
        },
      );
    }
  }

  if (!navigator.geolocation) {
    initMap(20, 0, 2);
    hintEl.textContent =
      "Geolocation not available — drag and zoom to explore.";
    return;
  }

  navigator.geolocation.getCurrentPosition(
    (pos) => {
      initMap(pos.coords.latitude, pos.coords.longitude, 16);
    },
    () => {
      initMap(20, 0, 2);
      hintEl.textContent =
        "Location unavailable — allow access or browse the map manually.";
    },
    { enableHighAccuracy: true, timeout: 20000, maximumAge: 0 },
  );
}

createApp();
