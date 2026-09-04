# 하루한칸 (haru-one-line)

Google 로그인으로 하루 한 줄을 남기는 **수업용** 웹 앱. 개인 기록은 본인만 보고,
공유 다이어리는 초대한 한 사람과 둘이서만 본다.

## 이 파일과 README 의 역할 분담

- **`README.md`** — API 명세, 엔드포인트 목록, 환경변수, 배포 주소의 **정본**.
  엔드포인트를 추가·변경하면 README 를 함께 고친다.
- **이 파일** — 작업할 때 지켜야 할 규칙과 함정. 명세를 여기 복사하지 않는다.

## 구조

```
Vercel 정적 프런트엔드 (루트: index.html · app.js · config.js · styles.css)
  ├─ Firebase Authentication — Google 로그인, ID 토큰 발급
  └─ Render Node API (server/)
       └─ Neon PostgreSQL — 개인/공유 기록
```

| 파일 | 줄 수 | 역할 |
|---|---|---|
| `app.js` | 788 | 프런트 전체. 빌드 도구 없는 순수 브라우저 JS |
| `config.js` | 11 | Firebase 웹 설정 + API 주소. **공개 값이라 커밋이 의도된 구성** |
| `server/src/app.js` | 814 | Express 라우트 전부. 인증·검증·트랜잭션 |
| `server/src/db.js` | 88 | 풀 + `migrate()` (`CREATE ... IF NOT EXISTS` 만) |
| `server/src/auth.js` | 36 | Firebase ID 토큰 검증 → `req.uid` |
| `server/test/app.test.js` | 399 | 실제 HTTP + 토큰 검증 대역 |

- 프런트에 **빌드 단계가 없다.** `index.html` 이 `app.js` 를 직접 로드한다.
  번들러·프레임워크를 새로 들이지 않는다.
- 서버는 **ESM**(`"type": "module"`), Node **>= 22**, 의존성은 express 5 · pg ·
  firebase-admin · helmet · cors · express-rate-limit.

## 보안 규칙 (건드리면 안 되는 것)

이 프로젝트는 수업용이지만 격리 규칙이 실제로 구현되어 있다. 리팩터링하다 깨뜨리기 쉽다.

1. **모든 개인 기록 조회·삭제에 `firebase_uid` 조건이 들어간다.** 조건 없는 쿼리를
   만들지 않는다.
2. **공유 기록 읽기/쓰기에는 room 멤버십 + 작성자 조건이 함께 들어간다.** 멤버라도
   상대의 기록을 수정·삭제할 수 없다.
3. **초대 토큰 원문은 생성/재생성 응답에만 담긴다.** DB 에는 SHA-256 해시만 저장한다.
   room 목록·상세·초대 상태 응답에 토큰이나 해시를 절대 넣지 않는다.
4. **room 은 최대 2명.** 동시 참여는 PostgreSQL slot 제약 + 트랜잭션으로 막는다.
   애플리케이션 레벨 체크로 대체하지 않는다.
5. **`(room_id, firebase_uid, entry_date)` unique 제약**이 하루 한 줄을 보장한다.
   동시 요청까지 여기서 막힌다.
6. `DATABASE_URL`·`FIREBASE_PROJECT_ID`·`CORS_ORIGINS` 실제 값은 **Git 에 넣지 않는다.**
   Render 환경변수로만 관리한다.

## 알아둘 함정

- **라우트에 `/api/diaries` 별칭이 병행한다.** `rooms` 와 `diaries` 두 경로가 같은
  핸들러를 가리킨다. 라우트를 고칠 때 **양쪽 다** 고치지 않으면 한쪽만 깨진다.
- **`entryId` 자리에 날짜(`YYYY-MM-DD`)도 들어온다.** `entryWhere()` 가 UUID 와 날짜를
  구분한다. 이 분기를 지우면 프런트의 수정·삭제가 죽는다.
- **프리뷰 모드**(`먼저 둘러보기`)는 Firebase·API 를 전혀 호출하지 않고 `localStorage`
  에만 쓴다. 로그인 경로를 고칠 때 이 모드가 여전히 동작하는지 확인한다.
- **`migrate()` 는 서버 기동 때마다 돈다.** 재시작 안전성을 위해 `IF NOT EXISTS` 만
  쓴다. `ALTER`·`DROP` 을 추가하지 않는다.
- 기록 내용은 **trim 후 1~60자**. 프런트와 서버 양쪽에서 검증한다.

## 검증

작업 후 반드시 돌린다.

```bash
cd server
npm test                    # node --test — 인증·격리·멤버십·수명주기·동시성
node --check src/app.js
node --check src/db.js
```

로컬 실행:

```bash
python -m http.server 4173     # 프런트, http://localhost:4173
cd server && npm ci && npm start   # API
```

`config.js` 의 API 주소를 바꾸지 않아도 배포 API 를 그대로 쓴다.

**테스트는 로직 검증이다.** Google 로그인 플로우, 초대 링크 실제 수락, 두 계정 간
공유 표시는 사람이 브라우저에서 확인해야 한다. 자동 테스트 통과를 "동작한다"로
보고하지 않는다.

## 작업 방식

- 코드 작성·수정·테스트는 **Codex CLI 에 위임**한다. Orca 별도 worktree 에서 작업한 뒤
  diff 와 테스트 결과를 검토해 보고한다.
- **사용자 확인 전에는 커밋·배포·공유 기억 갱신을 하지 않는다.**
- 배포는 프런트 Vercel, API Render. `render.yaml` 과 `vercel.json` 이 설정을 담는다.

## 배포 주소

- 프런트: https://my-ochre-gamma.vercel.app
- API: https://haru-one-line-api.onrender.com
- 헬스체크: https://haru-one-line-api.onrender.com/health
