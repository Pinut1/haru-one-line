import { initializeApp } from "https://www.gstatic.com/firebasejs/12.17.1/firebase-app.js";
import {
  getAuth,
  GoogleAuthProvider,
  onAuthStateChanged,
  signInWithPopup,
  signOut,
} from "https://www.gstatic.com/firebasejs/12.17.1/firebase-auth.js";

const ENTRIES_KEY = "haru_entries";
const PREVIEW_SHARED_KEY = "haru_preview_shared_entries";
const LOCKED_ENTRY_TEXT = "친구가 작성했어요. 나도 쓰면 내용이 열려요.";
const MOOD_COLORS = new Set(["sage", "blue", "yellow", "orange", "rose", "lavender"]);
const FIREBASE_CONFIG = window.HARU_FIREBASE_CONFIG;
const API_URL = (window.HARU_API_URL || "http://localhost:3000").replace(/\/$/, "");
const $ = (selector) => document.querySelector(selector);

let auth = null;
let currentUser = null;
let activeView = "personal";
let rooms = [];
let activeRoom = null;
let editingEntryId = null;
let currentInviteToken = null;
let currentInviteRoomId = null;
let personalEntries = [];
let personalCalendarEntries = [];
let personalDateFilter = "";
let feedEntries = [];
let currentProfile = null;
let promptPreferences = [];
let pendingInvite = readInviteFromUrl();

function validConfig(config) {
  return (
    config &&
    ["apiKey", "authDomain", "projectId", "appId"].every(
      (key) => typeof config[key] === "string" && config[key].trim(),
    )
  );
}

async function connectFirebase() {
  if (!validConfig(FIREBASE_CONFIG)) {
    $("#loginStatus").textContent = "로그인 서비스를 준비하지 못했습니다. 잠시 후 다시 시도해 주세요.";
    showGuest();
    return;
  }

  try {
    const firebaseApp = initializeApp(FIREBASE_CONFIG);
    auth = getAuth(firebaseApp);
    onAuthStateChanged(auth, (user) => {
      if (user) {
        void showMember(user);
      } else {
        showGuest();
      }
    });
    $("#loginStatus").textContent = "Google 계정으로 시작해 보세요.";
  } catch (error) {
    showError(error, "로그인 서비스를 준비하지 못했습니다. 잠시 후 다시 시도해 주세요.");
    showGuest();
  }
}

async function googleLogin() {
  if (!auth) {
    $("#loginStatus").textContent = "로그인 서비스를 준비하지 못했습니다. 잠시 후 다시 시도해 주세요.";
    return;
  }

  const button = $("#googleLogin");
  button.disabled = true;
  try {
    const provider = new GoogleAuthProvider();
    provider.setCustomParameters({ prompt: "select_account" });
    await signInWithPopup(auth, provider);
  } catch (error) {
    const messages = {
      "auth/popup-closed-by-user": "로그인 창이 닫혔어요. 다시 시도해 주세요.",
      "auth/unauthorized-domain": "Firebase 인증 도메인에 현재 주소를 추가해 주세요.",
      "auth/operation-not-allowed": "Firebase Authentication에서 Google 로그인을 사용 설정해 주세요.",
      "auth/popup-blocked": "브라우저가 팝업을 차단했어요. 팝업을 허용해 주세요.",
    };
    showError(error, messages[error.code] || "Google 로그인에 실패했어요.");
  } finally {
    button.disabled = false;
  }
}

function showError(error, message) {
  console.error(error);
  $("#loginStatus").textContent = message;
}

async function showMember(user) {
  currentUser = user;
  $("#guestView").hidden = true;
  $("#memberView").hidden = false;
  const name = (user.displayName || "친구").trim().slice(0, 12);
  $("#memberName").textContent = name;
  $("#profileName").textContent = user.displayName || "Google 사용자";
  $("#profileEmail").textContent = user.email || "";
  $("#memberPhoto").src = user.photoURL || avatar(name);
  setView(activeView);
  await renderPersonalEntries();

  if (!user.isPreview) {
    await syncProfile();
    await loadPromptPreferences();
    await renderPersonalPrompt();
    await renderRooms();
    if (pendingInvite) preparePendingInvite();
  } else {
    await renderPersonalPrompt();
  }
}

function showGuest() {
  currentUser = null;
  activeRoom = null;
  rooms = [];
  $("#roomDetail").hidden = true;
  $("#roomsList").hidden = false;
  $(".room-list-title").hidden = false;
  $("#joinForm").hidden = false;
  $("#createRoomButton").disabled = false;
  $("#personalPrompt").hidden = true;
  $("#memberView").hidden = true;
  $("#guestView").hidden = false;
}

function preview() {
  activeView = "personal";
  void showMember({
    uid: "preview",
    displayName: "미리보기",
    email: "demo@haru.local",
    photoURL: null,
    isPreview: true,
  });
}

function avatar(text) {
  const first = (text?.[0] || "한").replace(/[&<>"']/g, (character) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  })[character]);
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="96" height="96"><rect width="96" height="96" rx="48" fill="#879d83"/><text x="48" y="58" text-anchor="middle" font-family="sans-serif" font-size="38" fill="white">${first}</text></svg>`;
  return `data:image/svg+xml,${encodeURIComponent(svg)}`;
}

function dataKey() {
  return `${ENTRIES_KEY}_${currentUser?.uid || "preview"}`;
}

function getLocalEntries() {
  try {
    return JSON.parse(localStorage.getItem(dataKey()) || "[]");
  } catch {
    return [];
  }
}

function getPreviewSharedEntries() {
  try {
    return JSON.parse(localStorage.getItem(PREVIEW_SHARED_KEY) || "[]");
  } catch {
    return [];
  }
}

function localDate(value) {
  const now = value ? new Date(value) : new Date();
  if (Number.isNaN(now.valueOf())) return "";
  const pad = (part) => String(part).padStart(2, "0");
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

// Entries are stored as TIMESTAMPTZ, so the calendar day has to be derived in
// the reader's own timezone. Grouping on the server's UTC date would push a
// KST evening record onto the following day.
function entryLocalDate(entry) {
  if (!entry) return "";
  if (typeof entry.entry_date === "string" && /^\d{4}-\d{2}-\d{2}/.test(entry.entry_date)) {
    return entry.entry_date.slice(0, 10);
  }
  if (entry.created_at) {
    const createdDate = localDate(entry.created_at);
    if (createdDate) return createdDate;
  }
  if (typeof entry.date === "string" && /^\d{4}-\d{2}-\d{2}/.test(entry.date)) {
    return entry.date.slice(0, 10);
  }
  if (typeof entry.date === "string") {
    const legacy = entry.date.match(/^(\d{4})년\s*(\d{1,2})월\s*(\d{1,2})일/);
    if (legacy) {
      const candidate = `${legacy[1]}-${String(legacy[2]).padStart(2, "0")}-${String(legacy[3]).padStart(2, "0")}`;
      const parsed = new Date(`${candidate}T00:00:00`);
      if (!Number.isNaN(parsed.valueOf()) && localDate(parsed) === candidate) return candidate;
    }
  }
  return "";
}

function dateText(value) {
  if (!value) return "";
  const source = String(value).slice(0, 10);
  const parts = source.split("-").map(Number);
  const date = parts.length === 3 ? new Date(parts[0], parts[1] - 1, parts[2]) : new Date(value);
  if (Number.isNaN(date.valueOf())) return String(value);
  return new Intl.DateTimeFormat("ko-KR", {
    year: "numeric",
    month: "long",
    day: "numeric",
  }).format(date);
}

function shortDateText(value) {
  if (!value) return "";
  return dateText(value).replace(/\s+/g, " ");
}

async function apiRequest(path, options = {}) {
  if (!currentUser || currentUser.isPreview) {
    throw new Error("프리뷰에서는 서버에 연결하지 않습니다.");
  }
  const token = await currentUser.getIdToken();
  const response = await fetch(`${API_URL}${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(options.body ? { "Content-Type": "application/json" } : {}),
      ...options.headers,
    },
  });
  if (response.status === 204) return null;
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(body.error || `서버 오류 (${response.status})`);
    error.status = response.status;
    error.code = body.code;
    throw error;
  }
  return body;
}

function setSharedStatus(message, isError = false) {
  const status = $("#sharedStatus");
  status.textContent = message || "";
  status.classList.toggle("error", isError);
}

function setView(view) {
  activeView = ["shared", "feed"].includes(view) ? view : "personal";
  document.querySelectorAll(".mode-button").forEach((button) => {
    const active = button.dataset.view === activeView;
    button.classList.toggle("active", active);
    if (active) button.setAttribute("aria-current", "page");
    else button.removeAttribute("aria-current");
  });
  $("#personalPanel").hidden = activeView !== "personal";
  $("#sharedPanel").hidden = activeView !== "shared";
  $("#feedPanel").hidden = activeView !== "feed";

  if (activeView === "shared") {
    if (currentUser?.isPreview) showPreviewShared();
    else if (currentUser) void renderRooms();
  } else if (activeView === "feed") {
    if (currentUser?.isPreview) showPreviewFeed();
    else if (currentUser) void renderFeed();
  }
}

function buildEntryCard(entry) {
  const article = document.createElement("article");
  article.className = "entry";
  if (entry.mood_color && MOOD_COLORS.has(entry.mood_color)) {
    article.classList.add(`mood-${entry.mood_color}`);
  }
  if (entry.mood_emoji || entry.mood_color || entry.is_public) {
    const mood = document.createElement("div");
    mood.className = "entry-mood";
    if (entry.mood_emoji) mood.append(entry.mood_emoji);
    if (entry.mood_color) {
      const color = document.createElement("i");
      color.className = `mood-${entry.mood_color}`;
      color.setAttribute("aria-label", `${entry.mood_color} 색상`);
      mood.append(color);
    }
    if (entry.is_public) {
      const publicLabel = document.createElement("span");
      publicLabel.className = "entry-public";
      publicLabel.textContent = "친구 공개";
      mood.append(publicLabel);
    }
    article.append(mood);
  }
  const paragraph = document.createElement("p");
  // textContent keeps the raw line breaks; `white-space: pre-wrap` in the
  // stylesheet is what makes them visible.
  paragraph.textContent = entry.content ?? entry.text ?? "";
  if ((entry.content ?? entry.text ?? "").includes("\n")) {
    paragraph.classList.add("multiline");
  }
  const footer = document.createElement("div");
  const date = document.createElement("small");
  date.textContent = shortDateText(entryLocalDate(entry)) || entry.date || "오늘";
  const actions = document.createElement("div");
  actions.className = "entry-actions";
  const remove = document.createElement("button");
  remove.type = "button";
  remove.dataset.deletePersonal = entry.id;
  remove.setAttribute("aria-label", "기록 삭제");
  remove.textContent = "삭제";
  const visibility = document.createElement("button");
  visibility.type = "button";
  visibility.dataset.togglePublic = entry.id;
  visibility.textContent = entry.is_public ? "공개 끄기" : "친구에게 공개";
  actions.append(visibility, remove);
  footer.append(date, actions);
  article.append(paragraph, footer);
  return article;
}

function groupEntriesByDate(entries) {
  const groups = new Map();
  for (const entry of entries) {
    const key = entryLocalDate(entry) || "unknown";
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(entry);
  }
  return [...groups.entries()].sort((a, b) => b[0].localeCompare(a[0]));
}

function drawPersonalEntries(entries) {
  const list = $("#entries");
  const filtered = personalDateFilter
    ? entries.filter((entry) => entryLocalDate(entry) === personalDateFilter)
    : entries;

  $("#entryCount").textContent = personalDateFilter
    ? `${shortDateText(personalDateFilter)} · ${filtered.length}개의 순간`
    : `${filtered.length}개의 순간`;
  $("#entryDateClear").hidden = !personalDateFilter;

  list.replaceChildren();
  if (!filtered.length) {
    const empty = document.createElement("p");
    empty.className = "empty";
    empty.innerHTML = personalDateFilter
      ? "이 날의 기록이 없어요.<br>다른 날짜를 골라 보세요."
      : "아직 기록이 없어요.<br>오늘의 첫 문장을 남겨 보세요.";
    list.append(empty);
    return;
  }

  for (const [date, group] of groupEntriesByDate(filtered)) {
    const heading = document.createElement("h4");
    heading.className = "entry-day";
    const label = document.createElement("span");
    label.textContent = date === "unknown" ? "날짜 미상" : shortDateText(date);
    const count = document.createElement("small");
    count.textContent = `${group.length}개`;
    heading.append(label, count);
    list.append(heading);
    for (const entry of group) list.append(buildEntryCard(entry));
  }
}

function dateOnly(value) {
  const date = new Date(`${value}T00:00:00`);
  return Number.isNaN(date.valueOf()) ? null : date;
}

function shiftLocalDate(value, days) {
  const date = dateOnly(value);
  if (!date) return "";
  date.setDate(date.getDate() + days);
  return localDate(date);
}

function drawPersonalCalendar(entries) {
  const grid = $("#calendarGrid");
  if (!grid) return;
  grid.replaceChildren();
  const end = localDate();
  const start = shiftLocalDate(end, -364);
  const byDate = new Map();
  for (const entry of entries) {
    const date = entryLocalDate(entry);
    if (!date) continue;
    const items = byDate.get(date) || [];
    items.push(entry);
    byDate.set(date, items);
  }

  const startDate = dateOnly(start);
  const leading = startDate?.getDay() || 0;
  for (let index = 0; index < leading; index += 1) {
    const blank = document.createElement("span");
    blank.className = "calendar-cell calendar-blank";
    blank.setAttribute("aria-hidden", "true");
    grid.append(blank);
  }

  for (let index = 0; index < 365; index += 1) {
    const date = shiftLocalDate(start, index);
    const items = byDate.get(date) || [];
    const cell = document.createElement("button");
    cell.type = "button";
    cell.className = "calendar-cell";
    const level = Math.min(items.length, 3);
    if (level) cell.classList.add(`level-${level}`);
    const moodColor = items.find((entry) => MOOD_COLORS.has(entry.mood_color))?.mood_color;
    if (moodColor) cell.classList.add(`mood-${moodColor}`);
    if (date === end) cell.classList.add("is-today");
    cell.dataset.calendarDate = date;
    cell.setAttribute("role", "gridcell");
    cell.setAttribute("aria-label", `${shortDateText(date)} · ${items.length}개의 기록`);
    cell.title = `${shortDateText(date)} · ${items.length}개`;
    grid.append(cell);
  }

  const recordedDays = [...byDate.entries()].filter(([, items]) => items.length);
  const totalEntries = entries.length;
  $("#calendarSummary").textContent = `${recordedDays.length}일 기록 · ${totalEntries}개 순간`;
  $("#calendarMonths").textContent = `${shortDateText(start)} ~ ${shortDateText(end)}`;
}

async function renderPersonalEntries() {
  if (!currentUser) return;
  if (currentUser.isPreview) {
    personalEntries = getLocalEntries();
    personalCalendarEntries = personalEntries;
    drawPersonalCalendar(personalCalendarEntries);
    drawPersonalEntries(personalEntries);
    return;
  }

  $("#entries").innerHTML = '<p class="empty">기록을 불러오는 중…</p>';
  try {
    // The archive groups by day, so pull a wide window rather than the
    // server's default page of 100.
    const [body, calendar] = await Promise.all([
      apiRequest("/api/entries?limit=1000"),
      apiRequest("/api/entries/calendar"),
    ]);
    personalEntries = body.entries || [];
    personalCalendarEntries = calendar.entries || personalEntries;
    drawPersonalCalendar(personalCalendarEntries);
    drawPersonalEntries(personalEntries);
  } catch (error) {
    console.error(error);
    $("#entryCount").textContent = "연결 확인 필요";
    $("#entries").innerHTML = `<p class="empty">${escapeHtml(error.message)}<br>잠시 후 다시 시도해 주세요.</p>`;
  }
}

function drawRooms() {
  const list = $("#roomsList");
  $("#roomCount").textContent = `${rooms.length}개`;
  list.replaceChildren();
  if (!rooms.length) {
    const empty = document.createElement("p");
    empty.className = "empty";
    empty.innerHTML = "아직 공유 다이어리가 없어요.<br>새 다이어리를 만들거나 초대를 받아 보세요.";
    list.append(empty);
    return;
  }

  for (const room of rooms) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "room-card";
    button.dataset.roomId = room.id;
    button.setAttribute("aria-label", `${room.name} 다이어리 열기`);
    const title = document.createElement("h4");
    title.textContent = room.name;
    const subtitle = document.createElement("div");
    subtitle.className = "room-subtitle";
    const role = document.createElement("span");
    role.textContent = room.role === "owner" ? "내가 만든 다이어리" : "초대받은 다이어리";
    const count = document.createElement("span");
    count.textContent = `${room.member_count || 1}/2명`;
    subtitle.append(role, count);
    const recent = document.createElement("div");
    recent.className = "recent-list";
    const recentEntries = room.recent_entries || [];
    if (!recentEntries.length) {
      const note = document.createElement("small");
      note.textContent = "아직 함께 쓴 기록이 없어요.";
      recent.append(note);
    } else {
      for (const entry of recentEntries.slice(0, 3)) {
        const line = document.createElement("p");
        const content = entry.is_locked || entry.content === null ? LOCKED_ENTRY_TEXT : entry.content;
        line.textContent = `${entry.firebase_uid === currentUser?.uid ? "나" : "친구"} · ${content}`;
        const when = document.createElement("small");
        when.textContent = shortDateText(entry.entry_date);
        line.append(" ", when);
        recent.append(line);
      }
    }
    button.append(title, subtitle, recent);
    list.append(button);
  }
}

async function renderRooms() {
  if (!currentUser || currentUser.isPreview || activeView !== "shared") {
    if (currentUser?.isPreview && activeView === "shared") showPreviewShared();
    return;
  }

  restoreSharedControls();
  if (!activeRoom) {
    $("#roomDetail").hidden = true;
    $("#roomsList").hidden = false;
    $(".room-list-title").hidden = false;
  }
  setSharedStatus("공유 다이어리를 불러오는 중…");
  try {
    const body = await apiRequest("/api/rooms");
    rooms = body.rooms || [];
    drawRooms();
    setSharedStatus(rooms.length ? "다이어리를 골라 기록을 확인해 보세요." : "둘만의 다이어리를 만들어 보세요.");
  } catch (error) {
    setSharedStatus(error.message, true);
    $("#roomsList").innerHTML = `<p class="empty">${escapeHtml(error.message)}<br>잠시 후 다시 시도해 주세요.</p>`;
  }
}

function setFeedStatus(message, isError = false) {
  const status = $("#feedStatus");
  status.textContent = message || "";
  status.classList.toggle("error", isError);
}

function profileImage(profile, fallback = "친구") {
  return profile?.photo_url || avatar(profile?.display_name || fallback);
}

function drawProfileForm(profile) {
  if (!profile) return;
  $("#profileDisplayName").value = profile.display_name || "";
  $("#profileDiscoverable").checked = profile.discoverable !== false;
}

async function syncProfile() {
  if (!currentUser || currentUser.isPreview) return;
  try {
    const existing = await apiRequest("/api/me/profile");
    currentProfile = existing.profile;
    if (!existing.has_profile) {
      const created = await apiRequest("/api/me/profile", {
        method: "PUT",
        body: JSON.stringify({
          display_name: currentUser.displayName || "하루 기록자",
          photo_url: currentUser.photoURL || null,
          discoverable: true,
        }),
      });
      currentProfile = created.profile;
    }
    drawProfileForm(currentProfile);
  } catch (error) {
    console.error(error);
  }
}

async function loadPromptPreferences() {
  if (!currentUser || currentUser.isPreview) return;
  try {
    const body = await apiRequest("/api/me/prompt-preferences");
    promptPreferences = body.categories || [];
    document.querySelectorAll("#promptSettings input[type='checkbox']").forEach((input) => {
      input.checked = promptPreferences.includes(input.value);
    });
  } catch (error) {
    console.error(error);
  }
}

async function renderPersonalPrompt() {
  if (!currentUser || currentUser.isPreview) {
    $("#personalPrompt").hidden = true;
    return;
  }
  try {
    const body = await apiRequest("/api/prompts/today?date=" + encodeURIComponent(localDate()));
    $("#personalPrompt").hidden = false;
    $("#personalPromptCategory").textContent = body.prompt.category;
    $("#personalPromptText").textContent = body.prompt.text;
  } catch (error) {
    $("#personalPrompt").hidden = true;
    console.error(error);
  }
}

async function savePromptPreferences() {
  if (!currentUser || currentUser.isPreview) return;
  const button = $("#savePromptPreferences");
  const categories = [...document.querySelectorAll("#promptSettings input[type='checkbox']:checked")].map((input) => input.value);
  button.disabled = true;
  try {
    const body = await apiRequest("/api/me/prompt-preferences", {
      method: "PUT",
      body: JSON.stringify({ categories }),
    });
    promptPreferences = body.categories || [];
    await renderPersonalPrompt();
    setSharedStatus("주제 취향을 저장했어요.");
  } catch (error) {
    setSharedStatus(error.message, true);
  } finally {
    button.disabled = false;
  }
}

async function renderRoomPrompt() {
  if (!activeRoom?.room || !currentUser || currentUser.isPreview) return;
  const date = $("#sharedDate").value || localDate();
  try {
    const body = await apiRequest(
      "/api/rooms/" + encodeURIComponent(activeRoom.room.id) + "/prompt?date=" + encodeURIComponent(date),
    );
    $("#roomPrompt").hidden = false;
    $("#roomPromptCategory").textContent = body.prompt.category;
    $("#roomPromptText").textContent = body.prompt.text;
  } catch (error) {
    $("#roomPrompt").hidden = true;
    console.error(error);
  }
}

function showPreviewFeed() {
  setFeedStatus("친구 피드는 로그인 후 사용할 수 있어요. 프리뷰에서는 개인 기록만 이 브라우저에 저장됩니다.");
  $("#userSearchResults").replaceChildren();
  $("#incomingRequests").replaceChildren();
  $("#feedEntries").innerHTML = '<p class="empty">로그인하면 승인된 친구들의 공개 기록을 볼 수 있어요.</p>';
}

function drawSearchResults(users) {
  const list = $("#userSearchResults");
  list.replaceChildren();
  if (!users.length) {
    const empty = document.createElement("small");
    empty.className = "empty";
    empty.textContent = "검색 결과가 없어요.";
    list.append(empty);
    return;
  }
  for (const user of users) {
    const item = document.createElement("div");
    item.className = "social-item";
    const image = document.createElement("img");
    image.src = profileImage(user);
    image.alt = "";
    const info = document.createElement("div");
    const name = document.createElement("strong");
    name.textContent = user.display_name;
    const detail = document.createElement("small");
    detail.textContent = user.follow_status === "accepted"
      ? "친구"
      : user.follow_status === "pending"
        ? "요청을 보냈어요"
        : "공개 프로필";
    info.append(name, detail);
    const button = document.createElement("button");
    button.type = "button";
    button.dataset.followUid = user.uid;
    button.dataset.followStatus = user.follow_status || "none";
    if (user.follow_status === "accepted") {
      button.className = "danger";
      button.textContent = "팔로우 취소";
    } else if (user.follow_status === "pending") {
      button.disabled = true;
      button.textContent = "요청 중";
    } else {
      button.textContent = "친구 요청";
    }
    item.append(image, info, button);
    list.append(item);
  }
}

async function searchUsers() {
  const query = $("#userSearchInput").value.trim();
  if (!query) {
    $("#userSearchResults").replaceChildren();
    return;
  }
  try {
    const body = await apiRequest("/api/users/search?q=" + encodeURIComponent(query));
    drawSearchResults(body.users || []);
  } catch (error) {
    setFeedStatus(error.message, true);
  }
}

function drawIncomingRequests(requests) {
  const list = $("#incomingRequests");
  list.replaceChildren();
  if (!requests.length) {
    const empty = document.createElement("small");
    empty.textContent = "새로운 친구 요청이 없어요.";
    list.append(empty);
    return;
  }
  for (const request of requests) {
    const item = document.createElement("div");
    item.className = "social-item";
    const image = document.createElement("img");
    image.src = profileImage(request.user);
    image.alt = "";
    const info = document.createElement("div");
    const name = document.createElement("strong");
    name.textContent = request.user.display_name;
    const detail = document.createElement("small");
    detail.textContent = "친구가 되고 싶어 해요.";
    info.append(name, detail);
    const accept = document.createElement("button");
    accept.type = "button";
    accept.dataset.acceptRequest = request.id;
    accept.textContent = "수락";
    const reject = document.createElement("button");
    reject.type = "button";
    reject.className = "danger";
    reject.dataset.rejectRequest = request.id;
    reject.textContent = "거절";
    item.append(image, info, accept, reject);
    list.append(item);
  }
}

async function loadFollowRequests() {
  const body = await apiRequest("/api/me/follow-requests");
  drawIncomingRequests(body.incoming || []);
}

function drawFeedEntries(entries) {
  const list = $("#feedEntries");
  list.replaceChildren();
  if (!entries.length) {
    const empty = document.createElement("p");
    empty.className = "empty";
    empty.innerHTML = "아직 친구의 공개 기록이 없어요.<br>친구를 찾아 요청을 보내 보세요.";
    list.append(empty);
    return;
  }
  for (const entry of entries) {
    const article = document.createElement("article");
    article.className = "entry feed-entry";
    const author = document.createElement("div");
    author.className = "feed-author";
    const image = document.createElement("img");
    image.src = profileImage(entry.author);
    image.alt = "";
    const name = document.createElement("strong");
    name.textContent = entry.author?.display_name || "친구";
    author.append(image, name);
    const paragraph = document.createElement("p");
    paragraph.textContent = entry.content;
    if ((entry.content || "").includes("\n")) paragraph.classList.add("multiline");
    const meta = document.createElement("div");
    meta.className = "entry-meta";
    const date = document.createElement("span");
    date.textContent = shortDateText(entry.entry_date);
    const mood = document.createElement("span");
    mood.className = "mood";
    mood.textContent = entry.mood_emoji || "";
    meta.append(date, mood);
    article.append(author, paragraph, meta);
    list.append(article);
  }
}

async function loadFeedEntries() {
  const body = await apiRequest("/api/feed?limit=100");
  feedEntries = body.entries || [];
  drawFeedEntries(feedEntries);
}

async function renderFeed() {
  if (!currentUser || currentUser.isPreview) {
    showPreviewFeed();
    return;
  }
  setFeedStatus("친구 피드를 불러오는 중…");
  try {
    await Promise.all([loadFollowRequests(), loadFeedEntries()]);
    setFeedStatus("공개한 기록만 친구 피드에 보여요.");
  } catch (error) {
    setFeedStatus(error.message, true);
    const empty = document.createElement("p");
    empty.className = "empty";
    empty.textContent = error.message;
    $("#feedEntries").replaceChildren(empty);
  }
}

async function sendFollow(uid) {
  try {
    await apiRequest("/api/users/" + encodeURIComponent(uid) + "/follow", { method: "POST" });
    await searchUsers();
    setFeedStatus("친구 요청을 보냈어요.");
  } catch (error) {
    setFeedStatus(error.message, true);
  }
}

async function removeFollow(uid) {
  try {
    await apiRequest("/api/follows/" + encodeURIComponent(uid), { method: "DELETE" });
    await searchUsers();
    await loadFeedEntries();
    setFeedStatus("친구 관계를 정리했어요.");
  } catch (error) {
    setFeedStatus(error.message, true);
  }
}

async function respondToFollowRequest(id, status) {
  try {
    await apiRequest("/api/follow-requests/" + encodeURIComponent(id) + "/" + status, { method: "POST" });
    await loadFollowRequests();
    await loadFeedEntries();
    setFeedStatus(status === "accept" ? "친구 요청을 수락했어요." : "친구 요청을 거절했어요.");
  } catch (error) {
    setFeedStatus(error.message, true);
  }
}

async function saveProfile() {
  if (!currentUser || currentUser.isPreview) return;
  const button = $("#profileForm button[type='submit']");
  const displayName = $("#profileDisplayName").value.trim();
  if (!displayName) return;
  button.disabled = true;
  try {
    const body = await apiRequest("/api/me/profile", {
      method: "PUT",
      body: JSON.stringify({
        display_name: displayName,
        photo_url: currentUser.photoURL || currentProfile?.photo_url || null,
        discoverable: $("#profileDiscoverable").checked,
      }),
    });
    currentProfile = body.profile;
    drawProfileForm(currentProfile);
    setFeedStatus("공개 프로필을 저장했어요.");
  } catch (error) {
    setFeedStatus(error.message, true);
  } finally {
    button.disabled = false;
  }
}

function showPreviewShared() {
  $("#createRoomButton").disabled = true;
  $("#joinForm").hidden = true;
  const date = localDate();
  const ownEntries = getPreviewSharedEntries();
  const friendContent = "오늘 산책길의 바람이 좋았어.";
  const callerWroteToday = ownEntries.some((entry) => entry.entry_date === date);
  const friendEntry = {
    id: "preview-friend-entry",
    room_id: "preview-room",
    firebase_uid: "preview-friend",
    entry_date: date,
    content: callerWroteToday ? friendContent : null,
    is_locked: !callerWroteToday,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };
  activeRoom = {
    room: {
      id: "preview-room",
      name: "프리뷰 교환 일기",
      owner_uid: "preview-friend",
      role: "member",
      member_count: 2,
      recent_entries: [friendEntry, ...ownEntries],
    },
    members: [
      { firebase_uid: "preview-friend", role: "owner" },
      { firebase_uid: "preview", role: "member" },
    ],
    entries: [friendEntry, ...ownEntries],
  };
  drawRoomDetail();
  $("#leaveRoomButton").hidden = true;
  $("#roomCount").textContent = "프리뷰";
  setSharedStatus(callerWroteToday
    ? "같은 날짜에 나도 써서 친구의 내용이 열렸어요. 프리뷰 기록은 이 브라우저에만 저장됩니다."
    : "친구가 오늘 먼저 썼어요. 같은 날짜에 한 줄을 남겨 내용을 열어 보세요. 프리뷰는 로컬 전용입니다.");
}

function restoreSharedControls() {
  $("#createRoomButton").disabled = false;
  $("#joinForm").hidden = false;
}

async function openRoom(roomId) {
  if (!currentUser || currentUser.isPreview) return;
  try {
    if (activeRoom?.room?.id !== roomId) resetInvitePanel();
    setSharedStatus("다이어리를 여는 중…");
    const body = await apiRequest(`/api/rooms/${encodeURIComponent(roomId)}`);
    activeRoom = body;
    editingEntryId = null;
    drawRoomDetail();
    setSharedStatus("");
  } catch (error) {
    setSharedStatus(error.message, true);
  }
}

function resetInvitePanel() {
  currentInviteToken = null;
  currentInviteRoomId = null;
  $("#inviteLink").value = "";
  $("#copyInviteButton").disabled = true;
  $("#inviteLink").placeholder = "새 초대 링크를 만들어 주세요";
}

function buildInviteLink(roomId, token) {
  const code = `${roomId}.${token}`;
  return `${window.location.origin}${window.location.pathname}?invite=${encodeURIComponent(code)}`;
}

function showInviteToken(token) {
  if (!activeRoom?.room || !token) return;
  currentInviteToken = token;
  currentInviteRoomId = activeRoom.room.id;
  const link = buildInviteLink(activeRoom.room.id, token);
  $("#inviteLink").value = link;
  $("#inviteLink").placeholder = "";
  $("#copyInviteButton").disabled = false;
  setSharedStatus("초대 링크를 만들었어요. 친구에게 안전하게 보내 주세요.");
}

function drawRoomDetail() {
  if (!activeRoom?.room) return;
  const room = activeRoom.room;
  const owner = room.role === "owner";
  $("#roomDetail").hidden = false;
  $("#roomsList").hidden = true;
  $(".room-list-title").hidden = true;
  $("#joinForm").hidden = true;
  $("#roomTitle").textContent = room.name;
  const todayEntries = (activeRoom.entries || []).filter((entry) => entry.entry_date === localDate()).length;
  $("#roomMeta").textContent = `${room.member_count || activeRoom.members?.length || 1}/2명 · ${owner ? "내가 만든 다이어리" : "초대받은 다이어리"} · 오늘 ${todayEntries}/2명 작성`;
  $("#leaveRoomButton").hidden = owner;
  $("#invitePanel").hidden = !owner;
  if (owner && currentInviteToken && currentInviteRoomId === room.id) {
    showInviteToken(currentInviteToken);
  }
  $("#sharedDate").value = $("#sharedDate").value || localDate();
  drawRoomEntries(activeRoom.entries || []);
  resetEditor();
  void renderRoomPrompt();
}

function drawRoomEntries(entries) {
  const list = $("#sharedEntries");
  $("#sharedEntryCount").textContent = `${entries.length}줄`;
  list.replaceChildren();
  if (!entries.length) {
    const empty = document.createElement("p");
    empty.className = "empty";
    empty.innerHTML = "아직 함께 쓴 기록이 없어요.<br>오늘의 한 줄을 먼저 남겨 보세요.";
    list.append(empty);
    return;
  }

  for (const entry of entries) {
    const article = document.createElement("article");
    article.className = "entry";
    const top = document.createElement("div");
    const author = document.createElement("span");
    author.className = "shared-entry-author";
    author.textContent = entry.firebase_uid === currentUser?.uid ? "나" : "친구";
    const paragraph = document.createElement("p");
    paragraph.textContent = entry.is_locked || entry.content === null ? LOCKED_ENTRY_TEXT : entry.content;
    paragraph.classList.toggle("locked-entry", Boolean(entry.is_locked));
    if ((entry.content || "").includes("\n")) {
      paragraph.classList.add("multiline");
    }
    const bottom = document.createElement("div");
    const date = document.createElement("small");
    date.className = "shared-entry-date";
    date.textContent = dateText(entry.entry_date);
    bottom.append(date);
    if (entry.firebase_uid === currentUser?.uid) {
      const actions = document.createElement("div");
      actions.className = "entry-actions";
      const edit = document.createElement("button");
      edit.type = "button";
      edit.dataset.editShared = entry.id;
      edit.textContent = "수정";
      const remove = document.createElement("button");
      remove.type = "button";
      remove.className = "danger";
      remove.dataset.deleteShared = entry.id;
      remove.textContent = "삭제";
      actions.append(edit, remove);
      bottom.append(actions);
    }
    top.append(author);
    article.append(top, paragraph, bottom);
    list.append(article);
  }
}

async function refreshActiveRoom() {
  if (activeRoom?.room?.id) await openRoom(activeRoom.room.id);
}

function resetEditor() {
  editingEntryId = null;
  $("#sharedInput").value = "";
  $("#sharedInput").style.height = "auto";
  $("#sharedCharCount").textContent = "0";
  $("#sharedEntryHint").textContent = "한 날짜에 멤버별 한 줄씩 기록할 수 있어요.";
  $("#cancelEditButton").hidden = true;
}

function prepareEdit(entry) {
  editingEntryId = entry.id;
  $("#sharedDate").value = String(entry.entry_date).slice(0, 10);
  $("#sharedInput").value = entry.content;
  $("#sharedEntryHint").textContent = "내 기록을 수정하고 있어요.";
  $("#cancelEditButton").hidden = false;
  $("#sharedInput").focus();
  $("#sharedInput").dispatchEvent(new Event("input"));
}

async function createRoom() {
  if (!currentUser || currentUser.isPreview) return;
  $("#roomName").value = "";
  $("#roomDialog").showModal();
  $("#roomName").focus();
}

async function submitRoom(event) {
  if (event.submitter?.value !== "create") return;
  event.preventDefault();
  const button = event.submitter;
  button.disabled = true;
  try {
    const name = $("#roomName").value.trim();
    const body = await apiRequest("/api/rooms", {
      method: "POST",
      body: JSON.stringify({ name }),
    });
    $("#roomDialog").close();
    activeView = "shared";
    setView("shared");
    await renderRooms();
    await openRoom(body.room.id);
    showInviteToken(body.invite?.token || body.invite?.inviteToken);
  } catch (error) {
    setSharedStatus(error.message, true);
    if (!$("#roomDialog").open) $("#roomDialog").showModal();
  } finally {
    button.disabled = false;
  }
}

async function submitJoin(event) {
  event.preventDefault();
  if (!currentUser || currentUser.isPreview) return;
  const button =
    event.submitter || event.currentTarget.querySelector("button[type='submit']");
  const invite = $("#inviteInput").value.trim();
  if (!invite) {
    setSharedStatus("초대 링크 또는 토큰을 입력해 주세요.", true);
    $("#inviteInput").focus();
    return;
  }
  button.disabled = true;
  setSharedStatus("초대 확인 중…");
  try {
    const body = await apiRequest("/api/rooms/join", {
      method: "POST",
      body: JSON.stringify({ invite }),
    });
    pendingInvite = null;
    removeInviteFromUrl();
    await renderRooms();
    await openRoom(body.room.id);
    setSharedStatus("다이어리에 참여했어요. 이제 둘만의 기록을 시작해 보세요.");
  } catch (error) {
    setSharedStatus(error.message, true);
  } finally {
    button.disabled = false;
  }
}

async function regenerateInvite() {
  if (!activeRoom?.room || activeRoom.room.role !== "owner") return;
  const button = $("#regenerateInviteButton");
  button.disabled = true;
  try {
    const body = await apiRequest(`/api/rooms/${activeRoom.room.id}/invite/regenerate`, { method: "POST" });
    showInviteToken(body.invite?.token || body.invite?.inviteToken);
  } catch (error) {
    setSharedStatus(error.message, true);
  } finally {
    button.disabled = false;
  }
}

async function revokeInvite() {
  if (!activeRoom?.room || activeRoom.room.role !== "owner") return;
  if (!window.confirm("현재 초대 링크를 취소할까요? 이미 참여한 멤버는 그대로 남습니다.")) return;
  const button = $("#revokeInviteButton");
  button.disabled = true;
  try {
    await apiRequest(`/api/rooms/${activeRoom.room.id}/invite`, { method: "DELETE" });
    resetInvitePanel();
    setSharedStatus("초대 링크를 취소했어요.");
  } catch (error) {
    setSharedStatus(error.message, true);
  } finally {
    button.disabled = false;
  }
}

async function copyInvite() {
  const value = $("#inviteLink").value;
  if (!value) return;
  try {
    await navigator.clipboard.writeText(value);
  } catch {
    $("#inviteLink").focus();
    $("#inviteLink").select();
    document.execCommand("copy");
  }
  setSharedStatus("초대 링크를 복사했어요.");
}

async function submitSharedEntry(event) {
  event.preventDefault();
  if (!activeRoom?.room || !currentUser) return;
  const content = $("#sharedInput").value.trim();
  const date = $("#sharedDate").value;
  if (!content || !date) return;
  const button =
    event.submitter || event.currentTarget.querySelector("button[type='submit']");
  button.disabled = true;
  const wasEditing = Boolean(editingEntryId);
  try {
    if (currentUser.isPreview) {
      const entries = getPreviewSharedEntries();
      const existingIndex = entries.findIndex((entry) =>
        editingEntryId ? entry.id === editingEntryId : entry.entry_date === date);
      const entry = {
        id: existingIndex >= 0 ? entries[existingIndex].id : crypto.randomUUID(),
        room_id: "preview-room",
        firebase_uid: currentUser.uid,
        entry_date: date,
        content,
        is_locked: false,
        created_at: existingIndex >= 0 ? entries[existingIndex].created_at : new Date().toISOString(),
        updated_at: new Date().toISOString(),
      };
      if (existingIndex >= 0) entries[existingIndex] = entry;
      else entries.unshift(entry);
      localStorage.setItem(PREVIEW_SHARED_KEY, JSON.stringify(entries));
      showPreviewShared();
      resetEditor();
      return;
    }
    const path = `/api/rooms/${activeRoom.room.id}/entries`;
    if (editingEntryId) {
      await apiRequest(`${path}/${editingEntryId}`, {
        method: "PATCH",
        body: JSON.stringify({ content }),
      });
    } else {
      await apiRequest(path, {
        method: "POST",
        body: JSON.stringify({ content, date }),
      });
    }
    await refreshActiveRoom();
    setSharedStatus(wasEditing ? "기록을 수정했어요." : "오늘의 한 줄을 남겼어요.");
  } catch (error) {
    setSharedStatus(error.message, true);
  } finally {
    button.disabled = false;
  }
}

async function deleteSharedEntry(entryId) {
  if (!activeRoom?.room || !currentUser) return;
  if (!window.confirm("이 기록을 삭제할까요?")) return;
  try {
    if (currentUser.isPreview) {
      localStorage.setItem(PREVIEW_SHARED_KEY, JSON.stringify(
        getPreviewSharedEntries().filter((entry) => entry.id !== entryId),
      ));
      showPreviewShared();
      setSharedStatus("프리뷰 기록을 삭제했어요. 친구의 내용이 다시 잠겼습니다.");
      return;
    }
    await apiRequest(`/api/rooms/${activeRoom.room.id}/entries/${entryId}`, { method: "DELETE" });
    await refreshActiveRoom();
    setSharedStatus("기록을 삭제했어요.");
  } catch (error) {
    setSharedStatus(error.message, true);
  }
}

async function leaveRoom() {
  if (!activeRoom?.room || !currentUser || currentUser.isPreview) return;
  if (!window.confirm("이 다이어리에서 나갈까요? 내 기록도 함께 삭제됩니다.")) return;
  try {
    await apiRequest(`/api/rooms/${activeRoom.room.id}/members/me`, { method: "DELETE" });
    activeRoom = null;
    restoreSharedControls();
    await renderRooms();
    setSharedStatus("다이어리에서 나왔어요.");
  } catch (error) {
    setSharedStatus(error.message, true);
  }
}

async function togglePersonalVisibility(entryId) {
  const entry = personalEntries.find((item) => item.id === entryId);
  if (!entry || !currentUser) return;
  const isPublic = !entry.is_public;
  try {
    if (currentUser.isPreview) {
      const entries = getLocalEntries().map((item) => item.id === entryId ? { ...item, is_public: isPublic } : item);
      localStorage.setItem(dataKey(), JSON.stringify(entries));
    } else {
      await apiRequest("/api/entries/" + encodeURIComponent(entryId) + "/visibility", {
        method: "PATCH",
        body: JSON.stringify({ is_public: isPublic }),
      });
    }
    await renderPersonalEntries();
  } catch (error) {
    alert(error.message);
  }
}

function preparePendingInvite() {
  if (!pendingInvite || !currentUser || currentUser.isPreview) return;
  activeView = "shared";
  setView("shared");
  $("#inviteInput").value = pendingInvite;
  setSharedStatus("초대 링크를 확인했어요. 참여하기를 눌러 주세요.");
  $("#inviteInput").focus();
}

function readInviteFromUrl() {
  try {
    return new URL(window.location.href).searchParams.get("invite") || "";
  } catch {
    return "";
  }
}

function removeInviteFromUrl() {
  try {
    const url = new URL(window.location.href);
    url.searchParams.delete("invite");
    window.history.replaceState({}, "", url);
  } catch {
    // Ignore browsers that do not expose history for local files.
  }
}

function escapeHtml(text) {
  const element = document.createElement("div");
  element.textContent = text;
  return element.innerHTML;
}

// A textarea grows with its content so the line breaks being typed stay
// visible while writing.
function autoGrow(element) {
  element.style.height = "auto";
  element.style.height = `${element.scrollHeight}px`;
}

// Enter submits, Shift+Enter inserts a line break. `isComposing` guards the
// Enter that only confirms a Hangul composition — submitting there would eat
// the last syllable.
function submitOnEnter(form) {
  return (event) => {
    if (event.key !== "Enter" || event.shiftKey) return;
    if (event.isComposing || event.keyCode === 229) return;
    event.preventDefault();
    form.requestSubmit();
  };
}

$("#googleLogin").addEventListener("click", googleLogin);
$("#previewButton").addEventListener("click", preview);
$("#logoutButton").addEventListener("click", async () => {
  if (currentUser?.isPreview) showGuest();
  else if (auth) await signOut(auth);
});
$("#journalInput").addEventListener("input", (event) => {
  $("#charCount").textContent = event.target.value.length;
  autoGrow(event.target);
});
$("#journalInput").addEventListener("keydown", submitOnEnter($("#journalForm")));
$("#sharedInput").addEventListener("input", (event) => {
  $("#sharedCharCount").textContent = event.target.value.length;
  autoGrow(event.target);
});
$("#sharedInput").addEventListener(
  "keydown",
  submitOnEnter($("#sharedEntryForm")),
);
$("#entryDateFilter").addEventListener("change", (event) => {
  personalDateFilter = event.target.value || "";
  drawPersonalEntries(personalEntries);
});
$("#entryDateClear").addEventListener("click", () => {
  personalDateFilter = "";
  $("#entryDateFilter").value = "";
  drawPersonalEntries(personalEntries);
});
$("#calendarGrid").addEventListener("click", (event) => {
  const date = event.target.closest("[data-calendar-date]")?.dataset.calendarDate;
  if (!date) return;
  personalDateFilter = date;
  $("#entryDateFilter").value = date;
  drawPersonalEntries(personalEntries);
  $("#entries").scrollIntoView({ behavior: "smooth", block: "start" });
});
$("#sharedDate").value = localDate();
$("#sharedDate").addEventListener("change", () => {
  void renderRoomPrompt();
});
$("#todayLabel").textContent = new Intl.DateTimeFormat("ko-KR", {
  weekday: "long",
  month: "long",
  day: "numeric",
}).format(new Date());

$("#journalForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  const input = $("#journalInput");
  const content = input.value.trim();
  if (!content) return;
  const button =
    event.submitter || event.currentTarget.querySelector("button[type='submit']");
  button.disabled = true;
  try {
    if (currentUser?.isPreview) {
      const entries = getLocalEntries();
      // Store a machine-readable timestamp so the archive can group by day.
      entries.unshift({
        id: crypto.randomUUID(),
        text: content,
        created_at: new Date().toISOString(),
        date: localDate(),
        entry_date: localDate(),
        mood_emoji: $("#moodEmoji").value || null,
        mood_color: $("#moodColor").value || null,
        is_public: $("#personalPublic").checked,
      });
      localStorage.setItem(dataKey(), JSON.stringify(entries));
    } else {
      await apiRequest("/api/entries", {
        method: "POST",
        body: JSON.stringify({
          content,
          entry_date: localDate(),
          mood_emoji: $("#moodEmoji").value || null,
          mood_color: $("#moodColor").value || null,
          is_public: $("#personalPublic").checked,
        }),
      });
    }
    input.value = "";
    input.style.height = "auto";
    $("#charCount").textContent = "0";
    $("#moodEmoji").value = "";
    $("#moodColor").value = "";
    $("#personalPublic").checked = false;
    await renderPersonalEntries();
  } catch (error) {
    alert(error.message);
  } finally {
    button.disabled = false;
  }
});

$("#entries").addEventListener("click", async (event) => {
  const visibilityId = event.target.dataset.togglePublic;
  if (visibilityId) {
    event.target.disabled = true;
    await togglePersonalVisibility(visibilityId);
    event.target.disabled = false;
    return;
  }
  const id = event.target.dataset.deletePersonal;
  if (!id) return;
  event.target.disabled = true;
  try {
    if (currentUser?.isPreview) {
      localStorage.setItem(dataKey(), JSON.stringify(getLocalEntries().filter((entry) => entry.id !== id)));
    } else {
      await apiRequest(`/api/entries/${id}`, { method: "DELETE" });
    }
    await renderPersonalEntries();
  } catch (error) {
    alert(error.message);
    event.target.disabled = false;
  }
});

document.querySelectorAll(".mode-button").forEach((button) => {
  button.addEventListener("click", () => setView(button.dataset.view));
});
$("#savePromptPreferences").addEventListener("click", savePromptPreferences);
$("#profileForm").addEventListener("submit", (event) => {
  event.preventDefault();
  void saveProfile();
});
$("#userSearchForm").addEventListener("submit", (event) => {
  event.preventDefault();
  void searchUsers();
});
$("#userSearchResults").addEventListener("click", (event) => {
  const button = event.target.closest("[data-follow-uid]");
  if (!button || button.disabled) return;
  if (button.dataset.followStatus === "accepted") void removeFollow(button.dataset.followUid);
  else void sendFollow(button.dataset.followUid);
});
$("#incomingRequests").addEventListener("click", (event) => {
  const acceptId = event.target.dataset.acceptRequest;
  const rejectId = event.target.dataset.rejectRequest;
  if (acceptId) void respondToFollowRequest(acceptId, "accept");
  else if (rejectId) void respondToFollowRequest(rejectId, "reject");
});
$("#refreshFeedButton").addEventListener("click", () => {
  void renderFeed();
});
$("#createRoomButton").addEventListener("click", createRoom);
$("#roomForm").addEventListener("submit", submitRoom);
$("#joinForm").addEventListener("submit", submitJoin);
$("#roomsList").addEventListener("click", (event) => {
  const button = event.target.closest("[data-room-id]");
  if (button) void openRoom(button.dataset.roomId);
});
$("#backToRooms").addEventListener("click", () => {
  activeRoom = null;
  editingEntryId = null;
  restoreSharedControls();
  $("#roomDetail").hidden = true;
  $("#roomsList").hidden = false;
  $(".room-list-title").hidden = false;
  void renderRooms();
});
$("#copyInviteButton").addEventListener("click", copyInvite);
$("#regenerateInviteButton").addEventListener("click", regenerateInvite);
$("#revokeInviteButton").addEventListener("click", revokeInvite);
$("#leaveRoomButton").addEventListener("click", leaveRoom);
$("#sharedEntryForm").addEventListener("submit", submitSharedEntry);
$("#cancelEditButton").addEventListener("click", resetEditor);
$("#sharedEntries").addEventListener("click", (event) => {
  const editId = event.target.dataset.editShared;
  const deleteId = event.target.dataset.deleteShared;
  if (editId) {
    const entry = activeRoom?.entries?.find((item) => item.id === editId);
    if (entry) prepareEdit(entry);
  } else if (deleteId) {
    void deleteSharedEntry(deleteId);
  }
});

connectFirebase();
