# 하루한칸

Google 계정으로 로그인하고 하루 한 줄을 남기는 수업용 웹 앱입니다. 개인 기록은 나만 볼 수 있고, 공유 다이어리는 초대한 한 사람과만 함께 볼 수 있습니다.

```text
Vercel 정적 프런트엔드
  ├─ Firebase Authentication: Google 로그인 · ID 토큰
  └─ Render Node API
       └─ Neon PostgreSQL: 개인/공유 기록 저장
```

프런트엔드는 Firebase ID 토큰을 API로 보냅니다. Render API는 토큰을 검증하고 Firebase `uid`를 기준으로 모든 개인 기록과 멤버십을 분리합니다. PostgreSQL 접속 정보와 공유 초대 토큰 원문은 브라우저에 노출되지 않으며, 초대 토큰은 데이터베이스에 SHA-256 해시로만 보관됩니다.

## 배포 주소

- 프런트엔드: https://my-ochre-gamma.vercel.app
- API: https://haru-one-line-api.onrender.com
- 상태 확인: https://haru-one-line-api.onrender.com/health

## Firebase 웹 클라이언트 설정

Firebase 웹 클라이언트 설정은 루트 `config.js`의 `HARU_FIREBASE_CONFIG`에서 읽습니다. 이 값은 브라우저에서 사용되는 공개 웹 클라이언트 설정이므로 저장소에 커밋하는 것이 의도된 구성입니다. API 주소는 같은 파일의 `HARU_API_URL`에서 설정합니다. 실제 설정 값은 이 문서에 반복하지 않습니다.

Firebase Authentication에서 Google 로그인을 활성화하고 배포 도메인을 승인된 도메인에 추가해야 합니다.

## 로컬 실행

프런트엔드:

```powershell
python -m http.server 4173
```

브라우저에서 `http://localhost:4173`으로 접속합니다. `config.js`의 API 주소를 로컬 서버로 바꾸지 않아도 배포 API를 사용할 수 있습니다. 서버 없이 화면만 확인하려면 `먼저 둘러보기`를 선택하세요. 프리뷰 모드는 개인 기록을 브라우저 `localStorage`에만 저장하며, Firebase나 API를 호출하지 않습니다.

API:

```powershell
cd server
npm ci
npm start
```

서버는 시작할 때 `migrate()`를 실행합니다. 마이그레이션은 `CREATE TABLE/INDEX IF NOT EXISTS`만 사용하므로 재시작해도 안전합니다.

## Render 환경변수

- `DATABASE_URL`: Neon PostgreSQL 연결 문자열
- `FIREBASE_PROJECT_ID`: Firebase 프로젝트 ID
- `CORS_ORIGINS`: 허용할 프런트엔드 주소(쉼표로 구분)

환경변수의 실제 값은 Git에 저장하지 않습니다.

## API 공통 규칙

인증이 필요한 모든 요청에 다음 헤더를 보냅니다.

```http
Authorization: Bearer <Firebase ID token>
```

공유 room/entry 응답에는 인증된 사용자가 해당 room의 멤버인지 확인하는 쿼리가 먼저 실행됩니다. 멤버가 아닌 사용자는 room 목록에서도 제외되고, room 상세·기록 읽기/쓰기에서 `403`을 받습니다.

기록 내용은 앞뒤 공백을 제거한 뒤 1~60자로 검증합니다. 공유 기록 날짜는 `YYYY-MM-DD` 형식의 실제 달력 날짜이며, 한 room에서 한 멤버가 같은 날짜에 가질 수 있는 기록은 하나입니다. 데이터베이스의 `(room_id, firebase_uid, entry_date)` unique 제약이 동시 요청까지 막습니다.

## 개인 기록 API

- `GET /api/entries`: 로그인한 사용자의 개인 기록 최대 100개
- `POST /api/entries`: `{ "content": "오늘의 한 줄" }`로 개인 기록 생성
- `DELETE /api/entries/:id`: 본인이 만든 개인 기록 삭제

개인 기록은 `firebase_uid` 조건 없이는 조회·삭제할 수 없습니다.

## 공유 다이어리 API

### room과 멤버

- `GET /api/rooms`: 로그인한 사용자가 멤버인 room과 room별 최근 기록 최대 6개
- `POST /api/rooms`: `{ "name": "우리의 하루" }`로 room 생성. 생성자에게 `room`과 함께 생성 시 한 번만 확인할 수 있는 원문 `invite.token`을 반환합니다. 실제 링크는 `roomId.token`을 `?invite=` 쿼리로 넣어 만들 수 있습니다.
- `GET /api/rooms/:roomId`: 멤버 전용 room 상세, 멤버 목록, 최근 365개 기록
- `POST /api/rooms/join`: `{ "invite": "<roomId>.<token>" }`로 인증된 사용자가 초대 참여. 전체 URL도 받을 수 있습니다.
- `POST /api/rooms/:roomId/join`: `{ "token": "<token>" }` 형식의 대체 참여 경로
- `DELETE /api/rooms/:roomId/members/me`: 멤버 탈퇴. 소유자는 탈퇴할 수 없고, 탈퇴한 멤버의 기록은 함께 삭제됩니다.

room은 소유자 한 명과 초대 멤버 한 명, 최대 두 명입니다. 같은 초대를 여러 사용자가 동시에 사용해도 PostgreSQL의 slot 제약과 트랜잭션으로 두 번째 멤버를 넘길 수 없습니다.

### 초대 관리(소유자 전용)

- `POST /api/rooms/:roomId/invite/regenerate`: 기존 초대를 즉시 무효화하고 새 원문 토큰 반환
- `POST /api/rooms/:roomId/invite` 또는 `PUT /api/rooms/:roomId/invite`: 위와 같은 재생성 대체 경로
- `GET /api/rooms/:roomId/invite`: 활성 여부와 시각만 반환하며 토큰은 반환하지 않음
- `DELETE /api/rooms/:roomId/invite`: 초대 취소. 취소된 토큰으로는 참여할 수 없음

초대 원문은 생성/재생성 응답에만 포함됩니다. room 목록·상세·초대 상태 응답에는 토큰이나 토큰 해시를 포함하지 않습니다.

### 공유 기록

- `GET /api/rooms/:roomId/entries?limit=365`: 멤버 전용 room 기록 조회
- `GET /api/rooms/:roomId/history`: 위 조회의 별칭
- `POST /api/rooms/:roomId/entries`: `{ "content": "한 줄", "date": "2026-09-03" }`로 오늘 또는 지정 날짜 기록 생성. 같은 멤버·room·날짜가 이미 있으면 `409`
- `PUT /api/rooms/:roomId/entries`: 같은 날짜 기록을 생성하거나 수정하는 멱등 upsert
- `PATCH /api/rooms/:roomId/entries/:entryId`: 본인의 기록 내용 수정. `entryId` 대신 `YYYY-MM-DD`도 사용 가능
- `DELETE /api/rooms/:roomId/entries/:entryId`: 본인의 기록 삭제. 날짜를 `entryId` 자리에 사용할 수도 있음

모든 shared entry 읽기/쓰기에는 room 멤버십 조건과 작성자 조건이 함께 들어갑니다. 따라서 멤버라도 상대방의 기록을 수정·삭제할 수 없고, 개인 기록 API로 공유 기록이 노출되지 않습니다.

## 테스트

```powershell
cd server
npm test
node --check src/app.js
node --check src/db.js
```

테스트는 실제 HTTP 서버와 Firebase 토큰 검증 대역을 사용해 인증, 사용자 격리, 비멤버 거부, room/초대 수명주기, 두 명 제한, 날짜별 uniqueness/update/delete, 입력 검증을 확인합니다.
