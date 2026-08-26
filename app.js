import { initializeApp, deleteApp } from "https://www.gstatic.com/firebasejs/12.17.1/firebase-app.js";
import { getAuth, GoogleAuthProvider, signInWithPopup, signOut, onAuthStateChanged } from "https://www.gstatic.com/firebasejs/12.17.1/firebase-auth.js";

const CONFIG_KEY="haru_firebase_config", ENTRIES_KEY="haru_entries", API_URL=(window.HARU_API_URL||"http://localhost:3000").replace(/\/$/,"");
const $=s=>document.querySelector(s);
let firebaseApp=null, auth=null, currentUser=null, unsubscribe=null;

function readConfig(){try{return JSON.parse(localStorage.getItem(CONFIG_KEY)||"null")}catch{return null}}
function validConfig(c){return c&&["apiKey","authDomain","projectId","appId"].every(k=>typeof c[k]==="string"&&c[k].trim())}
function parseFirebaseConfig(text){
  const value=text.trim();
  try{return JSON.parse(value)}catch{}
  const config={};
  const allowed=["apiKey","authDomain","projectId","storageBucket","messagingSenderId","appId","measurementId"];
  for(const key of allowed){
    const match=value.match(new RegExp(`${key}\\s*:\\s*["']([^"']+)["']`));
    if(match)config[key]=match[1];
  }
  return config;
}

async function connectFirebase(){
  const config=readConfig();
  if(!validConfig(config)){$("#loginStatus").textContent="⚙ 설정에서 Firebase를 먼저 연결하세요";return}
  try{
    if(unsubscribe)unsubscribe();
    if(firebaseApp)await deleteApp(firebaseApp);
    firebaseApp=initializeApp(config);auth=getAuth(firebaseApp);
    unsubscribe=onAuthStateChanged(auth,user=>user?showMember(user):showGuest());
    $("#loginStatus").textContent="Firebase 연결 완료 · Google 계정으로 시작하세요";
  }catch(error){showError(error,"Firebase 설정을 확인해 주세요")}
}

async function googleLogin(){
  if(!auth){openSettings();return}
  const button=$("#googleLogin");button.disabled=true;
  try{const provider=new GoogleAuthProvider();provider.setCustomParameters({prompt:"select_account"});await signInWithPopup(auth,provider)}
  catch(error){
    const messages={"auth/popup-closed-by-user":"로그인 창이 닫혔어요. 다시 시도해 주세요.","auth/unauthorized-domain":"Firebase 승인된 도메인에 현재 주소를 추가하세요.","auth/operation-not-allowed":"Firebase Authentication에서 Google 로그인을 사용 설정하세요.","auth/popup-blocked":"브라우저가 팝업을 차단했어요."};
    showError(error,messages[error.code]||"Google 로그인에 실패했어요.");
  }finally{button.disabled=false}
}
function showError(error,message){console.error(error);$("#loginStatus").textContent=message}
function showMember(user){
  currentUser=user;$("#guestView").hidden=true;$("#memberView").hidden=false;
  const name=(user.displayName||"친구").replace(/\s/g,"").slice(0,6);
  $("#memberName").textContent=name;$("#profileName").textContent=user.displayName||"Google 사용자";$("#profileEmail").textContent=user.email||"";$("#memberPhoto").src=user.photoURL||avatar(name);renderEntries();
}
function showGuest(){currentUser=null;$("#memberView").hidden=true;$("#guestView").hidden=false}
function preview(){showMember({uid:"preview",displayName:"미리보기",email:"demo@haru.local",photoURL:null,isPreview:true})}
function avatar(t){const s=`<svg xmlns="http://www.w3.org/2000/svg" width="96" height="96"><rect width="96" height="96" rx="48" fill="#879d83"/><text x="48" y="58" text-anchor="middle" font-family="sans-serif" font-size="38" fill="white">${t[0]||"ㅎ"}</text></svg>`;return `data:image/svg+xml,${encodeURIComponent(s)}`}
function dataKey(){return `${ENTRIES_KEY}_${currentUser?.uid||"preview"}`}
function getEntries(){try{return JSON.parse(localStorage.getItem(dataKey())||"[]")}catch{return[]}}
function escapeHtml(text){const d=document.createElement("div");d.textContent=text;return d.innerHTML}
async function apiRequest(path,options={}){const token=await currentUser.getIdToken();const response=await fetch(`${API_URL}${path}`,{...options,headers:{Authorization:`Bearer ${token}`,...(options.body?{"Content-Type":"application/json"}:{}),...options.headers}});if(!response.ok){const body=await response.json().catch(()=>({}));throw new Error(body.error||`서버 오류 (${response.status})`)}return response.status===204?null:response.json()}
function drawEntries(entries){$("#entryCount").textContent=`${entries.length}개의 순간`;$("#entries").innerHTML=entries.length?entries.map(entry=>{const text=entry.content??entry.text;const date=entry.created_at?new Intl.DateTimeFormat("ko-KR",{year:"numeric",month:"long",day:"numeric"}).format(new Date(entry.created_at)):entry.date;return `<article class="entry"><button data-delete="${entry.id}" aria-label="기록 삭제">×</button><p>${escapeHtml(text)}</p><small>${date}</small></article>`}).join(""):'<p class="empty">아직 기록이 없어요.<br>오늘의 첫 문장을 남겨보세요.</p>'}
async function renderEntries(){if(currentUser?.isPreview){drawEntries(getEntries());return}$("#entries").innerHTML='<p class="empty">기록을 불러오는 중…</p>';try{drawEntries((await apiRequest("/api/entries")).entries)}catch(error){console.error(error);$("#entryCount").textContent="연결 확인 필요";$("#entries").innerHTML=`<p class="empty">${escapeHtml(error.message)}<br>잠시 후 다시 시도해 주세요.</p>`}}
function openSettings(){$("#firebaseConfig").value=localStorage.getItem(CONFIG_KEY)||"";$("#settingsDialog").showModal()}

$("#googleLogin").addEventListener("click",googleLogin);$("#previewButton").addEventListener("click",preview);$("#settingsButton").addEventListener("click",openSettings);
$("#logoutButton").addEventListener("click",async()=>{if(currentUser?.isPreview)showGuest();else if(auth)await signOut(auth)});
$("#journalInput").addEventListener("input",e=>$("#charCount").textContent=e.target.value.length);
$("#journalForm").addEventListener("submit",async e=>{e.preventDefault();const input=$("#journalInput"),text=input.value.trim(),button=e.submitter;if(!text)return;button.disabled=true;try{if(currentUser?.isPreview){const a=getEntries();a.unshift({id:crypto.randomUUID(),text,date:new Intl.DateTimeFormat("ko-KR",{year:"numeric",month:"long",day:"numeric"}).format(new Date())});localStorage.setItem(dataKey(),JSON.stringify(a))}else await apiRequest("/api/entries",{method:"POST",body:JSON.stringify({content:text})});input.value="";$("#charCount").textContent="0";await renderEntries()}catch(error){alert(error.message)}finally{button.disabled=false}});
$("#entries").addEventListener("click",async e=>{const id=e.target.dataset.delete;if(!id)return;e.target.disabled=true;try{if(currentUser?.isPreview)localStorage.setItem(dataKey(),JSON.stringify(getEntries().filter(x=>x.id!==id)));else await apiRequest(`/api/entries/${id}`,{method:"DELETE"});await renderEntries()}catch(error){alert(error.message);e.target.disabled=false}});
$("#settingsForm").addEventListener("submit",async e=>{if(e.submitter?.value!=="save")return;e.preventDefault();const field=$("#firebaseConfig");const c=parseFirebaseConfig(field.value);if(!validConfig(c)){field.setCustomValidity("Firebase 코드에 apiKey, authDomain, projectId, appId가 모두 있는지 확인해 주세요.");field.reportValidity();return}localStorage.setItem(CONFIG_KEY,JSON.stringify(c));$("#settingsDialog").close();await connectFirebase()});
$("#firebaseConfig").addEventListener("input",e=>e.target.setCustomValidity(""));$("#clearConfig").addEventListener("click",async()=>{localStorage.removeItem(CONFIG_KEY);if(unsubscribe)unsubscribe();if(firebaseApp)await deleteApp(firebaseApp);firebaseApp=null;auth=null;$("#settingsDialog").close();showGuest();$("#loginStatus").textContent="⚙ 설정에서 Firebase를 먼저 연결하세요"});
$("#todayLabel").textContent=new Intl.DateTimeFormat("ko-KR",{weekday:"long",month:"long",day:"numeric"}).format(new Date());connectFirebase();
