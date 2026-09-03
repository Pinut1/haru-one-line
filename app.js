import { initializeApp, deleteApp } from "https://www.gstatic.com/firebasejs/12.17.1/firebase-app.js";
import {
  getAuth,
  GoogleAuthProvider,
  onAuthStateChanged,
  signInWithPopup,
  signOut,
} from "https://www.gstatic.com/firebasejs/12.17.1/firebase-auth.js";

const CONFIG_KEY = "haru_firebase_config";
const ENTRIES_KEY = "haru_entries";
const API_URL = (window.HARU_API_URL || "http://localhost:3000").replace(/\/$/, "");
const $ = (selector) => document.querySelector(selector);

let firebaseApp = null;
let auth = null;
let currentUser = null;
let unsubscribe = null;
let activeView = "personal";
let rooms = [];
let activeRoom = null;
let editingEntryId = null;
let currentInviteToken = null;
let currentInviteRoomId = null;
let pendingInvite = readInviteFromUrl();

function readConfig() {
  try {
    return JSON.parse(localStorage.getItem(CONFIG_KEY) || "null");
  } catch {
    return null;
  }
}

function validConfig(config) {
  return (
    config &&
    ["apiKey", "authDomain", "projectId", "appId"].every(
      (key) => typeof config[key] === "string" && config[key].trim(),
    )
  );
}

function parseFirebaseConfig(text) {
  const value = text.trim();
  try {
    return JSON.parse(value);
  } catch {
    // Firebase's copy button commonly returns a JavaScript object literal.
  }

  const config = {};
  const allowed = [
    "apiKey",
    "authDomain",
    "projectId",
    "storageBucket",
    "messagingSenderId",
    "appId",
    "measurementId",
  ];
  for (const key of allowed) {
    const match = value.match(new RegExp(`${key}\\s*:\\s*["']([^"']+)["']`));
    if (match) config[key] = match[1];
  }
  return config;
}

async function connectFirebase() {
  const config = readConfig();
  if (!validConfig(config)) {
    $("#loginStatus").textContent = "설정에서 Firebase를 먼저 연결해 주세요.";
    showGuest();
    return;
  }

  try {
    if (unsubscribe) unsubscribe();
    if (firebaseApp) await deleteApp(firebaseApp);
    firebaseApp = initializeApp(config);
    auth = getAuth(firebaseApp);
    unsubscribe = onAuthStateChanged(auth, (user) => {
      if (user) {
        void showMember(user);
      } else {
        showGuest();
      }
    });
    $("#loginStatus").textContent = "Firebase 연결 완료 · Google 계정으로 시작해 보세요.";
  } catch (error) {
    showError(error, "Firebase 설정을 확인해 주세요.");
  }
}

async function googleLogin() {
  if (!auth) {
    openSettings();
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
    await renderRooms();
    if (pendingInvite) preparePendingInvite();
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

function localDate() {
  const now = new Date();
  const pad = (value) => String(value).padStart(2, "0");
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
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
  activeView = view === "shared" ? "shared" : "personal";
  document.querySelectorAll(".mode-button").forEach((button) => {
    const active = button.dataset.view === activeView;
    button.classList.toggle("active", active);
    if (active) button.setAttribute("aria-current", "page");
    else button.removeAttribute("aria-current");
  });
  $("#personalPanel").hidden = activeView !== "personal";
  $("#sharedPanel").hidden = activeView !== "shared";

  if (activeView === "shared") {
    if (currentUser?.isPreview) showPreviewShared();
    else if (currentUser) void renderRooms();
  }
}

function drawPersonalEntries(entries) {
  const list = $("#entries");
  $("#entryCount").textContent = `${entries.length}개의 순간`;
  list.replaceChildren();
  if (!entries.length) {
    const empty = document.createElement("p");
    empty.className = "empty";
    empty.innerHTML = "아직 기록이 없어요.<br>오늘의 첫 문장을 남겨 보세요.";
    list.append(empty);
    return;
  }

  for (const entry of entries) {
    const article = document.createElement("article");
    article.className = "entry";
    const paragraph = document.createElement("p");
    paragraph.textContent = entry.content ?? entry.text ?? "";
    const footer = document.createElement("div");
    const date = document.createElement("small");
    date.textContent = dateText(entry.created_at) || entry.date || "오늘";
    const actions = document.createElement("div");
    actions.className = "entry-actions";
    const remove = document.createElement("button");
    remove.type = "button";
    remove.dataset.deletePersonal = entry.id;
    remove.setAttribute("aria-label", "기록 삭제");
    remove.textContent = "삭제";
    actions.append(remove);
    footer.append(date, actions);
    article.append(paragraph, footer);
    list.append(article);
  }
}

async function renderPersonalEntries() {
  if (!currentUser) return;
  if (currentUser.isPreview) {
    drawPersonalEntries(getLocalEntries());
    return;
  }

  $("#entries").innerHTML = '<p class="empty">기록을 불러오는 중…</p>';
  try {
    const body = await apiRequest("/api/entries");
    drawPersonalEntries(body.entries || []);
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
        line.textContent = `${entry.firebase_uid === currentUser?.uid ? "나" : "친구"} · ${entry.content}`;
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

function showPreviewShared() {
  $("#createRoomButton").disabled = true;
  $("#joinForm").hidden = true;
  $("#roomDetail").hidden = true;
  $("#roomsList").hidden = false;
  $(".room-list-title").hidden = false;
  $("#roomsList").innerHTML = '<p class="empty">공유 다이어리는 로그인 후 사용할 수 있어요.<br>프리뷰에서는 개인 기록만 이 브라우저에 저장됩니다.</p>';
  $("#roomCount").textContent = "프리뷰";
  setSharedStatus("프리뷰는 로컬 전용입니다. 서버로 전송되는 내용이 없어요.");
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
  $("#roomMeta").textContent = `${room.member_count || activeRoom.members?.length || 1}/2명 · ${owner ? "내가 만든 다이어리" : "초대받은 다이어리"}`;
  $("#leaveRoomButton").hidden = owner;
  $("#invitePanel").hidden = !owner;
  if (owner && currentInviteToken && currentInviteRoomId === room.id) {
    showInviteToken(currentInviteToken);
  }
  $("#sharedDate").value = $("#sharedDate").value || localDate();
  drawRoomEntries(activeRoom.entries || []);
  resetEditor();
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
    paragraph.textContent = entry.content;
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
  const button = event.submitter;
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
  if (!activeRoom?.room || !currentUser || currentUser.isPreview) return;
  const content = $("#sharedInput").value.trim();
  const date = $("#sharedDate").value;
  if (!content || !date) return;
  const button = event.submitter;
  button.disabled = true;
  const wasEditing = Boolean(editingEntryId);
  try {
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
  if (!activeRoom?.room || !currentUser || currentUser.isPreview) return;
  if (!window.confirm("이 기록을 삭제할까요?")) return;
  try {
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

$("#googleLogin").addEventListener("click", googleLogin);
$("#previewButton").addEventListener("click", preview);
$("#settingsButton").addEventListener("click", openSettings);
$("#logoutButton").addEventListener("click", async () => {
  if (currentUser?.isPreview) showGuest();
  else if (auth) await signOut(auth);
});
$("#journalInput").addEventListener("input", (event) => {
  $("#charCount").textContent = event.target.value.length;
});
$("#sharedInput").addEventListener("input", (event) => {
  $("#sharedCharCount").textContent = event.target.value.length;
});
$("#sharedDate").value = localDate();
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
  const button = event.submitter;
  button.disabled = true;
  try {
    if (currentUser?.isPreview) {
      const entries = getLocalEntries();
      entries.unshift({ id: crypto.randomUUID(), text: content, date: dateText(localDate()) });
      localStorage.setItem(dataKey(), JSON.stringify(entries));
    } else {
      await apiRequest("/api/entries", {
        method: "POST",
        body: JSON.stringify({ content }),
      });
    }
    input.value = "";
    $("#charCount").textContent = "0";
    await renderPersonalEntries();
  } catch (error) {
    alert(error.message);
  } finally {
    button.disabled = false;
  }
});

$("#entries").addEventListener("click", async (event) => {
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

function openSettings() {
  $("#firebaseConfig").value = localStorage.getItem(CONFIG_KEY) || "";
  $("#settingsDialog").showModal();
}

$("#settingsForm").addEventListener("submit", async (event) => {
  if (event.submitter?.value !== "save") return;
  event.preventDefault();
  const field = $("#firebaseConfig");
  const config = parseFirebaseConfig(field.value);
  if (!validConfig(config)) {
    field.setCustomValidity("apiKey, authDomain, projectId, appId가 모두 있는지 확인해 주세요.");
    field.reportValidity();
    return;
  }
  localStorage.setItem(CONFIG_KEY, JSON.stringify(config));
  $("#settingsDialog").close();
  await connectFirebase();
});
$("#firebaseConfig").addEventListener("input", (event) => event.target.setCustomValidity(""));
$("#clearConfig").addEventListener("click", async () => {
  localStorage.removeItem(CONFIG_KEY);
  if (unsubscribe) unsubscribe();
  if (firebaseApp) await deleteApp(firebaseApp);
  firebaseApp = null;
  auth = null;
  showGuest();
  $("#settingsDialog").close();
  $("#loginStatus").textContent = "설정에서 Firebase를 먼저 연결해 주세요.";
});

connectFirebase();
